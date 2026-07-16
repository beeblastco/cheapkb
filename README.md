# cheapkb

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![SST v4](https://img.shields.io/badge/SST-v4-purple.svg)](https://sst.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.x-green.svg)](https://nodejs.org/)

Cost-effective serverless knowledge base on AWS. Ingest documents, chunk, embed, and search vectors within the AWS Free Tier.

## Stack

Node.js 22.x, TypeScript 7, [SST v4](https://sst.dev), API Gateway, Lambda, S3, S3 Vectors, DynamoDB, SQS.

**Auth:** [shoo.dev](https://shoo.dev) PKCE flow with server-side JWT verification via [jose](https://github.com/panva/jose). Identity is derived per-request from the verified `pairwise_sub` claim; documents are scoped to that user in the DynamoDB single-table design.

## Pipeline

```mermaid
flowchart LR
    Client([Client]) -->|POST /upload| API["API Gateway"]
    API --> S3raw[("S3 raw/")]
    S3raw -->|ObjectCreated| IngestAdapter["IngestAdapter"] --> IngestQ[["Ingest queue"]]
    Client -->|POST /ingest| API --> IngestQ
    IngestQ --> Parse["Parse"] --> ChunkQ[["Chunk queue"]]
    ChunkQ --> Chunk["Chunk"] --> EmbedQ[["Embed queue"]]
    EmbedQ --> Embed["Embed"] --> Vectors[("S3 Vectors")]
```

Full pipeline details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## API

Base URL: `https://<api-id>.execute-api.us-east-1.amazonaws.com/v1`

All endpoints require a `Authorization: Bearer <shoo_id_token>` header.

| Method | Path                     | Description                | Rate Limit |
| ------ | ------------------------ | -------------------------- | ---------- |
| POST   | `/upload`                | Presigned URL + doc record | 50/hr      |
| POST   | `/ingest`                | Manually trigger pipeline  | -          |
| POST   | `/query`                 | Vector search with filters | 100/hr     |
| GET    | `/documents`             | List your documents        | -          |
| GET    | `/documents/:id`         | Document + chunk details   | -          |
| POST   | `/documents/:id/reindex` | Restart from failed step   | -          |
| DELETE | `/documents/:id`         | Full cleanup               | -          |

Full API reference: [docs/API.md](docs/API.md)

## Frontend

A compact React + shadcn/ui knowledge workspace lives in `web/`. It is deployed to an **S3 bucket** and served through a **CloudFront distribution** via `sst.aws.StaticSite`.

The frontend uses Vite, React, TypeScript, Tailwind CSS v4, shadcn/ui with Base UI primitives, and TanStack Table. `App.tsx` coordinates the feature UI, `lib/client.ts` contains browser and API logic, and `components/ui` contains the installed shadcn primitives. Tailwind is integrated through the official Vite plugin, `@` resolves to `web/src`, and Base UI-backed shadcn components provide dialogs, menus, avatars, tables, pagination, selects, tooltips, scrolling, loading states, and confirmations.

The workspace follows a two-column layout: one searchable, sortable TanStack document table with exact pipeline status values on the left and a shadcn message-scroller chat with related sources on the right. The Documents card contains its own vertical list scroll on desktop with the column header pinned at the top, and the table scrolls horizontally on narrow viewports so every column stays available without widening the page. Long document names truncate within the fixed table layout. Clicking or keyboard-activating a synced row opens its details, while activating a staged row opens its metadata editor; row action buttons remain independent. Staged files and synced documents can be selected individually or by filtered page. One confirmed bulk action removes staged files from the upload queue and deletes synced documents sequentially. TanStack Table owns filtering, sorting, selection, and the 50-row pagination model. `Sync all` starts the staged upload batch. The user menu reads the signed Google profile and provides account, policy, contact, and logout actions.

Production JavaScript and CSS filenames include a content hash so CloudFront's immutable caching cannot keep browsers on an older frontend after deployment.
The production build injects the exact API and storage bucket origins into the page's Content Security Policy and permits Shoo plus Google profile images. This keeps authentication, avatars, API requests, and presigned S3 uploads working without broad network access.

```bash
cd web
API_URL=https://<your-api-url>/v1 npm run dev   # builds and serves on http://localhost:5173
```

### Auth Flow

1. User clicks "Sign in with Google" on the frontend
2. [shoo.dev](https://shoo.dev) handles the PKCE OAuth flow with Google
3. Frontend receives a signed `id_token` JWT stored by `shoo.js`
4. All API calls include the token in the `Authorization` header
5. Each Lambda verifies the token server-side before processing

The frontend requests Shoo's Google profile scope so the account menu can show the signed-in email and avatar. Existing sessions created before this setting was enabled need one logout and sign-in to receive those profile claims.

The deployed site URL is injected into Lambda functions as `APP_ORIGIN`, so the JWT audience always matches the frontend origin.
The locally served Shoo SDK sets `data-shoo-base-url="https://shoo.dev"` so authorization requests use Shoo instead of the CloudFront origin.
Frontend assets use root-relative paths so the `/shoo/callback` route loads the same scripts and styles as the site root.
The frontend keeps a short-lived PKCE backup so callbacks opened in a new browser context can restore the verifier, and failed callbacks return to the sign-in screen.

Browser uploads use presigned S3 POST requests. The storage bucket CORS policy allows POST requests from the deployed frontend. Users can drag multiple files anywhere over the signed-in workspace or choose them manually, review each staged row's extracted metadata, and start the batch with one `Sync all` action next to the Documents heading. Staged rows never create temporary server document identities, and polling reconciles each real document ID once. Metadata extraction and upload run sequentially to keep browser and AWS concurrency low. Failed files remain in the table with their error and can be retried.

Uploads are unique per user, sanitized filename, and MIME type. DynamoDB stores a strongly consistent mapping for that identity, so concurrent requests cannot create duplicate document IDs. Uploading a completed or failed document again reserves its existing ID and S3 key. Old vectors, chunks, and parsed data remain available until S3 confirms the replacement with its upload token, then the ingest adapter removes the derived data and re-indexes the new object. Active documents reject replacement with HTTP 409.

After S3 accepts an upload, the browser explicitly starts ingestion through the API. The API and S3 event adapter use the same conditional `UPLOADED` to `QUEUED` transition so retries are safe and only one parser job is queued.

Every production deployment uploads a temporary text document through the real pipeline, waits for `EMBEDDED`, verifies chunk counts, and removes the source to trigger cleanup.

The dark frontend keeps recent pending and failed documents visible while DynamoDB's list index catches up. Pending uploads survive a refresh for up to 30 minutes, while local-only failed rows expire after 5 minutes. Server-side failures remain visible until they are retried or deleted.

## Test

Tests use shared typed API Gateway, S3, and SQS event fixtures. Backend tests cover tenant boundaries, pipeline retries, cleanup ordering, rate limits, and infrastructure safeguards; frontend tests cover browser behavior and the production build.

```bash
npm ci --legacy-peer-deps
npm --prefix web ci --legacy-peer-deps
npm run format:check && npm run build && npm test
API_URL=https://example.execute-api.us-east-1.amazonaws.com/v1 npm --prefix web run build
```

## Deploy

Production deploys only through `.github/workflows/deploy.yml` after changes merge to `main`. The check job formats, typechecks, tests, builds the frontend, and audits production dependencies before the deploy job runs `sst deploy --stage production`. GitHub Actions configures AWS profile `954475336309` from repository secrets and verifies account `954475336309` immediately before deployment and every production E2E AWS operation.

After deployment, SST prints both the API endpoint (`apiEndpoint`) and the web endpoint (`webEndpoint`). The API URL is baked into the frontend build, and the frontend URL is used as `APP_ORIGIN` for JWT verification.

After the first deployment of tenant-scoped vector metadata, reindex existing embedded documents once from the UI. Old vectors without `userId` metadata are intentionally excluded from search until they are overwritten.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[MIT](LICENSE)
