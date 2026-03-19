import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';

const app = express();
const port = Number(process.env.DOCX_CONVERTER_PORT || 8787);
const graphBaseUrl = process.env.M365_GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

const requiredEnv = ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET', 'M365_USER_ID'] as const;

const requireConfig = () => {
  const missing = requiredEnv.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing M365 converter config: ${missing.join(', ')}`);
  }
  return {
    tenantId: process.env.M365_TENANT_ID!,
    clientId: process.env.M365_CLIENT_ID!,
    clientSecret: process.env.M365_CLIENT_SECRET!,
    userId: process.env.M365_USER_ID!,
    folder: process.env.M365_UPLOAD_FOLDER || 'SignaturePacketIDE-Temp',
  };
};

const getGraphToken = async (): Promise<string> => {
  const { tenantId, clientId, clientSecret } = requireConfig();
  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Token request failed (${response.status}): ${detail}`);
  }

  const json = await response.json() as { access_token?: string };
  if (!json.access_token) {
    throw new Error('Token response missing access_token');
  }

  return json.access_token;
};

const buildUserDrivePathUrl = (userId: string, folder: string, fileName: string): string => {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fullPath = `${folder}/${randomUUID()}-${safeName}`;
  return `${graphBaseUrl}/users/${encodeURIComponent(userId)}/drive/root:/${fullPath}:/content`;
};

app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post('/api/docx-to-pdf', upload.single('file'), async (req, res) => {
  try {
    const uploaded = req.file;
    if (!uploaded) {
      res.status(400).json({ error: 'No file uploaded. Use multipart/form-data with field "file".' });
      return;
    }

    const looksLikeDocx =
      uploaded.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      uploaded.originalname.toLowerCase().endsWith('.docx');

    if (!looksLikeDocx) {
      res.status(400).json({ error: 'Only .docx files are supported for this endpoint.' });
      return;
    }

    const token = await getGraphToken();
    const { userId, folder } = requireConfig();
    const uploadUrl = buildUserDrivePathUrl(userId, folder, uploaded.originalname);

    // 1) Upload DOCX to service account OneDrive
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': uploaded.mimetype || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      body: uploaded.buffer,
    });

    if (!uploadResponse.ok) {
      const detail = await uploadResponse.text();
      throw new Error(`Graph upload failed (${uploadResponse.status}): ${detail}`);
    }

    const uploadedItem = await uploadResponse.json() as { id?: string };
    if (!uploadedItem.id) {
      throw new Error('Graph upload response missing item id');
    }

    // 2) Request converted content as PDF
    const convertUrl =
      `${graphBaseUrl}/users/${encodeURIComponent(userId)}/drive/items/${encodeURIComponent(uploadedItem.id)}/content?format=pdf`;
    const pdfResponse = await fetch(convertUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!pdfResponse.ok) {
      const detail = await pdfResponse.text();
      throw new Error(`Graph conversion failed (${pdfResponse.status}): ${detail}`);
    }

    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());

    // 3) Best-effort cleanup of temp file
    const deleteUrl = `${graphBaseUrl}/users/${encodeURIComponent(userId)}/drive/items/${encodeURIComponent(uploadedItem.id)}`;
    void fetch(deleteUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch((cleanupErr) => {
      console.warn('Cleanup warning:', cleanupErr);
    });

    const safeName = uploaded.originalname.replace(/\.docx$/i, '.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.status(200).send(pdfBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown conversion error';
    console.error('DOCX conversion failed:', message);
    res.status(500).json({ error: 'DOCX conversion failed', detail: message });
  }
});

app.listen(port, () => {
  console.log(`DOCX converter API listening on http://localhost:${port}`);
});
