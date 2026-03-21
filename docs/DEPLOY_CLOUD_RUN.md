# Google Cloud Run deployment plan

This document is the **implementation plan** for running Signature Packet IDE as **one Cloud Run service** (Vite static build + Node API), with **Identity-Aware Proxy (IAP)** so only allowed Google Workspace users can access it.

**Target architecture:** Option A — single container, same origin for UI and `/api/*`, no load balancer required for IAP ([IAP for Cloud Run](https://cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run)).

---

## Phase 0 — Prerequisites

- [ ] Google Cloud project with billing enabled.
- [ ] `gcloud` CLI installed and authenticated (`gcloud auth login`, `gcloud config set project PROJECT_ID`).
- [ ] Enable APIs: **Cloud Run**, **Artifact Registry**, **Secret Manager**, **Identity-Aware Proxy** (and **Cloud Build** if you build images in GCP).
- [ ] Decide **region** (e.g. `us-central1`).
- [ ] Workspace admin buy-in for IAP access (who gets **IAP-secured Web App User**).

---

## Phase 1 — Single entrypoint in code (production server)

**Goal:** One Node process listens on `PORT`, serves `dist/`, and exposes existing API routes.

| Step | Task |
|------|------|
| 1.1 | Add `express.static` for the Vite output directory (`dist/`). |
| 1.2 | Keep existing routes: `GET /api/health`, `POST /api/docx-to-pdf`. |
| 1.3 | Add SPA fallback: `GET *` → `index.html` for non-API paths (after API routes). |
| 1.4 | Bind `const port = Number(process.env.PORT \|\| 8080)` and `app.listen(port, '0.0.0.0')`. |
| 1.5 | **TypeScript:** Do **not** use `node backend/server.ts` in production. Either compile `backend/server.ts` to JS in the image build, or bundle with esbuild; ensure **`import.meta.url`** / `fileURLToPath` for static paths if staying ESM. |
| 1.6 | Remove reliance on Vite dev proxy in production: frontend should call **`/api/...`** same-origin (default `VITE_DOCX_CONVERTER_URL=/api/docx-to-pdf` is already correct). |
| 1.7 | **Optional hardening:** Move Gemini calls server-side so the API key is not embedded in the client bundle (today Vite `define` injects `GEMINI_API_KEY` at build time). |

**Acceptance:** `docker run -p 8080:8080 -e ...` shows UI at `/` and `GET /api/health` returns JSON.

---

## Phase 2 — Dockerfile (multi-stage)

| Step | Task |
|------|------|
| 2.1 | **Stage `build`:** `npm ci`, copy source, `npm run build` → `dist/`. |
| 2.2 | Compile or bundle `backend/server` to runnable JS in build stage (recommended). |
| 2.3 | **Stage `runtime`:** `node:20-slim` (or distroless Node), `NODE_ENV=production`. |
| 2.4 | `npm ci --omit=dev` **or** copy only production `node_modules` + compiled server (avoid shipping full dev tree). |
| 2.5 | Copy `dist/` and compiled server artifacts into predictable paths (e.g. `/app/dist`, `/app/server`). |
| 2.6 | `EXPOSE 8080` (informational); Cloud Run sets `PORT`. |
| 2.7 | Add `.dockerignore`: `node_modules`, `dist`, `.git`, `.env`, `*.md` (keep README if you want). |

**Acceptance:** Image builds locally; container serves UI + API on one port.

---

## Phase 3 — Artifact Registry + Cloud Run deploy

| Step | Task |
|------|------|
| 3.1 | Create Artifact Registry Docker repository (e.g. `signature-packet-ide`). |
| 3.2 | `gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG` (or build/push from CI). |
| 3.3 | Deploy Cloud Run service: image, region, **CPU/memory** as needed, **max instances**, **timeout** (DOCX + Graph may need 60–300s). |
| 3.4 | Initially allow unauthenticated **only for smoke test** in a dev project; lock down before production (see Phase 5). |

**Acceptance:** Service URL loads the app and health check passes.

---

## Phase 4 — Secrets (Secret Manager)

| Step | Task |
|------|------|
| 4.1 | Create secrets: e.g. `m365-tenant-id`, `m365-client-id`, `m365-client-secret`, `m365-user-id` (and `gemini-api-key` if still build- or runtime-injected). |
| 4.2 | Grant the **Cloud Run service account** `secretmanager.secretAccessor` on those secrets. |
| 4.3 | Map secrets to env vars in Cloud Run (Console or `--set-secrets`). |
| 4.4 | Set non-secret env: `NODE_ENV=production`, `M365_UPLOAD_FOLDER`, etc. |

**Acceptance:** DOCX conversion works end-to-end against M365 from Cloud Run.

---

## Phase 5 — IAP + Workspace-only access

| Step | Task |
|------|------|
| 5.1 | Cloud Run: **Require authentication** and enable **IAP** for the service ([docs](https://cloud.google.com/iap/docs/enabling-cloud-run)). |
| 5.2 | Remove public access: ensure only IAP-authenticated users (and invoker IAM as required by your setup) can reach the service. |
| 5.3 | In IAP (or Cloud Console IAM for the IAP resource), grant **IAP-secured Web App User** to Workspace **groups** (recommended) or users. |
| 5.4 | OAuth consent: use **Internal** app type if restricted to your Google Workspace org. |
| 5.5 | Test with a non-allowed account (should be blocked) and an allowed account (should reach the app). |

**Acceptance:** Only intended Workspace identities can open the app; direct anonymous access is denied.

---

## Phase 6 — Operations

| Step | Task |
|------|------|
| 6.1 | **Logging:** Use Cloud Logging; consider structured logs for conversion failures. |
| 6.2 | **Cold starts:** If UX requires it, set **min instances** to 1 (extra monthly cost). |
| 6.3 | **CI/CD:** Cloud Build trigger on `main` → build → push → deploy (optional). |
| 6.4 | **Custom domain** (optional): Map domain to Cloud Run per Google’s custom domain docs. |

---

## Cost notes (indicative)

- Cloud Run scales to zero; light internal use often stays low.
- **No external load balancer** needed for IAP-on-Cloud-Run (avoids fixed LB cost).
- Secret Manager and Artifact Registry have small usage charges.
- **Min instances** avoids cold starts but adds baseline compute cost.

---

## Implementation order (recommended)

1. Phase 1 (Express static + SPA + PORT + compiled backend) — **blocks everything else**  
2. Phase 2 (Dockerfile) + local `docker run` validation  
3. Phase 3 (push image + deploy dev Cloud Run)  
4. Phase 4 (secrets + M365 smoke test)  
5. Phase 5 (IAP + lock down)  
6. Phase 6 (polish)

---

## References

- [Configure IAP for Cloud Run](https://cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run)  
- [Enable IAP for Cloud Run](https://cloud.google.com/iap/docs/enabling-cloud-run)  
- [Cloud Run container runtime contract](https://cloud.google.com/run/docs/container-contract)  
- [Secret Manager with Cloud Run](https://cloud.google.com/run/docs/configuring/secrets)
