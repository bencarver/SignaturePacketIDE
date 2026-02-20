import { PDFDocument } from 'pdf-lib';
import { ExtractedSignaturePage, ProcessedDocument, GroupingMode, AssemblyMatch, ExecutedUpload } from '../types';

/**
 * Reads a file and returns its ArrayBuffer
 */
export const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
};

/**
 * Renders a specific page of a PDF to a base64 image string.
 * Uses pdf.js (loaded via CDN in index.html).
 */
export const renderPageToImage = async (
  file: File,
  pageIndex: number,
  scale = 1.5
): Promise<{ dataUrl: string; width: number; height: number }> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjsLib.getDocument(arrayBuffer);
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageIndex + 1); // PDF.js uses 1-based indexing for getPage

  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) throw new Error('Could not get canvas context');

  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({
    canvasContext: context,
    viewport: viewport,
  }).promise;

  // Cleanup
  page.cleanup();

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.8),
    width: viewport.width,
    height: viewport.height,
  };
};

/**
 * Gets the total page count of a PDF
 */
export const getPageCount = async (file: File): Promise<number> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjsLib.getDocument(arrayBuffer);
  const pdf = await loadingTask.promise;
  return pdf.numPages;
};

/**
 * Scans the entire document for pages containing signature-related keywords using Regex.
 * Optimized to process pages in parallel batches to speed up large documents.
 */
export const findSignaturePageCandidates = async (
  file: File,
  onProgress?: (processed: number, total: number) => void
): Promise<number[]> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjsLib.getDocument(arrayBuffer);
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const candidatePages: number[] = [];
  const BATCH_SIZE = 10; // Process 10 pages at a time

  // Regex provided for signature detection
  const regex = /(?<!\w)(Signature|Execution|Excution|Signatory|Executed|Signed|Witness|Agreed\s+and\s+Accepted|Accepted\s+by|Acknowledged\s+by|Duly\s+Authorized|Duly\s+Authorised|By:|Name:|Title:|Position:|Date:)(?!\w)/i;

  let processedCount = 0;

  // Process in batches
  for (let i = 1; i <= numPages; i += BATCH_SIZE) {
    const batchPromises = [];
    const end = Math.min(i + BATCH_SIZE - 1, numPages);

    for (let pageNum = i; pageNum <= end; pageNum++) {
      batchPromises.push(
        (async () => {
          try {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const text = textContent.items.map((item: any) => item.str).join(' ');
            
            // Explicitly release memory
            page.cleanup();

            if (regex.test(text)) {
              return pageNum - 1; // Return 0-based index
            }
            return null;
          } catch (e) {
            console.error(`Error scanning page ${pageNum}`, e);
            return null;
          }
        })()
      );
    }

    const results = await Promise.all(batchPromises);
    
    // Collect valid candidates
    results.forEach(res => {
      if (res !== null) candidatePages.push(res);
    });

    processedCount += (end - i + 1);
    if (onProgress) {
      onProgress(processedCount, numPages);
    }
  }

  return candidatePages.sort((a, b) => a - b);
};

/**
 * Extracts a single page from a PDF file and returns it as a new PDF Uint8Array.
 * Useful for previewing a specific extracted page.
 */
export const extractSinglePagePdf = async (
  file: File,
  pageIndex: number
): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const srcDoc = await PDFDocument.load(arrayBuffer);
  const newPdf = await PDFDocument.create();
  
  const [copiedPage] = await newPdf.copyPages(srcDoc, [pageIndex]);
  newPdf.addPage(copiedPage);
  
  return await newPdf.save();
};

/**
 * Generates separated PDFs based on grouping mode.
 * Returns a map of Filename -> PDF Uint8Array
 */
export const generateGroupedPdfs = async (
  documents: ProcessedDocument[],
  pagesToInclude: ExtractedSignaturePage[],
  groupingMode: GroupingMode
): Promise<Record<string, Uint8Array>> => {
  
  const results: Record<string, Uint8Array> = {};
  const sourceDocsCache: Record<string, PDFDocument> = {};

  // Group pages based on the mode
  const groups: Record<string, ExtractedSignaturePage[]> = {};

  for (const page of pagesToInclude) {
    if (page.copies <= 0) continue;

    let key = '';
    if (groupingMode === 'agreement') {
        key = page.documentName;
    } else if (groupingMode === 'counterparty') {
        key = page.partyName;
    } else {
        key = page.signatoryName || 'Unknown_Signatory';
    }

    if (!groups[key]) groups[key] = [];
    groups[key].push(page);
  }

  // Process each group into a separate PDF
  for (const [groupName, pages] of Object.entries(groups)) {
    const newPdf = await PDFDocument.create();

    // Sort pages to maintain order (by doc then page number usually looks best)
    pages.sort((a, b) => {
      if (a.documentName !== b.documentName) return a.documentName.localeCompare(b.documentName);
      return a.pageIndex - b.pageIndex;
    });

    for (const pageReq of pages) {
      let srcDoc = sourceDocsCache[pageReq.documentId];
      
      if (!srcDoc) {
        const docData = documents.find((d) => d.id === pageReq.documentId);
        if (!docData) continue;
        
        const buffer = await readFileAsArrayBuffer(docData.file);
        srcDoc = await PDFDocument.load(buffer);
        sourceDocsCache[pageReq.documentId] = srcDoc;
      }

      const [copiedPage] = await newPdf.copyPages(srcDoc, [pageReq.pageIndex]);

      for (let i = 0; i < pageReq.copies; i++) {
        newPdf.addPage(copiedPage);
      }
    }

    const pdfBytes = await newPdf.save();
    
    // Improved Sanitize filename: Allow spaces, dots, parens. Remove strict illegal chars.
    let safeName = groupName.replace(/[/\\?%*:|"<>]/g, '').trim();
    if (!safeName) safeName = "Signature_Pack";
    
    // Ensure .pdf extension
    if (!safeName.toLowerCase().endsWith('.pdf')) {
      safeName += '.pdf';
    }

    results[safeName] = pdfBytes;
  }

  return results;
};

// --- Document Assembly Functions ---

/**
 * Assembles a single document by replacing blank signature pages with executed pages.
 * Every page from the original document is copied; pages that have a replacement
 * in the `replacements` map get swapped with the executed version.
 *
 * @param originalFile - The original agreement PDF file
 * @param replacements - Map of 0-based page index → { executedFile, pageIndexInExecuted }
 * @returns The assembled PDF as Uint8Array
 */
export const assembleDocument = async (
  originalFile: File,
  replacements: Map<number, { executedFile: File; pageIndexInExecuted: number }>
): Promise<Uint8Array> => {
  const originalBuffer = await readFileAsArrayBuffer(originalFile);
  const originalDoc = await PDFDocument.load(originalBuffer);
  const assembledPdf = await PDFDocument.create();

  // Cache loaded executed PDFDocuments to avoid reloading the same file
  const executedDocCache = new Map<File, PDFDocument>();

  const totalPages = originalDoc.getPageCount();

  for (let i = 0; i < totalPages; i++) {
    const replacement = replacements.get(i);

    if (replacement) {
      // Swap in the executed page
      let executedDoc = executedDocCache.get(replacement.executedFile);
      if (!executedDoc) {
        const execBuffer = await readFileAsArrayBuffer(replacement.executedFile);
        executedDoc = await PDFDocument.load(execBuffer);
        executedDocCache.set(replacement.executedFile, executedDoc);
      }

      const [copiedPage] = await assembledPdf.copyPages(executedDoc, [replacement.pageIndexInExecuted]);
      assembledPdf.addPage(copiedPage);
    } else {
      // Keep the original page
      const [copiedPage] = await assembledPdf.copyPages(originalDoc, [i]);
      assembledPdf.addPage(copiedPage);
    }
  }

  return await assembledPdf.save();
};

/**
 * Assembles all documents that have at least one matched executed page.
 * Groups matches by documentId, builds replacement maps, calls assembleDocument for each.
 *
 * @param documents - All processed documents (must have non-null file)
 * @param matches - All assembly matches (auto + manual)
 * @param executedUploads - All uploaded executed files
 * @returns Map of sanitized filename → assembled PDF bytes
 */
export const assembleAllDocuments = async (
  documents: ProcessedDocument[],
  matches: AssemblyMatch[],
  executedUploads: ExecutedUpload[]
): Promise<Record<string, Uint8Array>> => {
  const results: Record<string, Uint8Array> = {};

  // Build a lookup: executedPageId → { file, pageIndexInSource }
  const executedPageLookup = new Map<string, { file: File; pageIndexInSource: number }>();
  for (const upload of executedUploads) {
    for (const execPage of upload.executedPages) {
      executedPageLookup.set(execPage.id, {
        file: upload.file,
        pageIndexInSource: execPage.pageIndexInSource,
      });
    }
  }

  // Group matches by documentId
  const matchesByDoc: Record<string, AssemblyMatch[]> = {};
  for (const match of matches) {
    if (!matchesByDoc[match.documentId]) matchesByDoc[match.documentId] = [];
    matchesByDoc[match.documentId].push(match);
  }

  // Assemble each document
  for (const [docId, docMatches] of Object.entries(matchesByDoc)) {
    const doc = documents.find(d => d.id === docId);
    if (!doc || !doc.file) continue;

    // Build the replacement map: pageIndex → executed source
    const replacements = new Map<number, { executedFile: File; pageIndexInExecuted: number }>();

    for (const match of docMatches) {
      const execInfo = executedPageLookup.get(match.executedPageId);
      if (execInfo) {
        replacements.set(match.pageIndex, {
          executedFile: execInfo.file,
          pageIndexInExecuted: execInfo.pageIndexInSource,
        });
      }
    }

    if (replacements.size === 0) continue;

    const assembledBytes = await assembleDocument(doc.file, replacements);

    // Sanitize filename
    let safeName = doc.name.replace(/[/\\?%*:|"<>]/g, '').trim();
    if (!safeName) safeName = 'Assembled_Document';

    // Add "_assembled" suffix before .pdf
    if (safeName.toLowerCase().endsWith('.pdf')) {
      safeName = safeName.slice(0, -4) + '_assembled.pdf';
    } else {
      safeName += '_assembled.pdf';
    }

    results[safeName] = assembledBytes;
  }

  return results;
};