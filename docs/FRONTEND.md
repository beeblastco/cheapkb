# Frontend

A compact React + shadcn/ui knowledge workspace lives in `web/`. It is deployed to an S3 bucket and served through a CloudFront distribution via `sst.aws.StaticSite`.

## Stack

Vite, React, TypeScript, Tailwind CSS v4, shadcn/ui with Base UI primitives, and TanStack Table. `App.tsx` coordinates the feature UI, `lib/client.ts` contains browser and API logic, and `components/ui` contains the installed shadcn primitives. Tailwind is integrated through the official Vite plugin, `@` resolves to `web/src`, and Base UI-backed shadcn components provide dialogs, menus, avatars, tables, pagination, selects, tooltips, scrolling, loading states, and confirmations.

## Layout

The workspace follows a two-column layout: one searchable, sortable TanStack document table with exact pipeline status values on the left and a message-scroller chat with related sources on the right. The Documents card contains its own vertical list scroll on desktop with the column header pinned at the top, and the table scrolls horizontally on narrow viewports so every column stays available without widening the page. Long document names truncate within the fixed table layout.

Clicking or keyboard-activating a synced row opens its details, while activating a staged row opens its metadata editor; row action buttons remain independent. Staged files and synced documents can be selected individually or by filtered page. One confirmed bulk action removes staged files from the upload queue and deletes synced documents sequentially. TanStack Table owns filtering, sorting, selection, and the 50-row pagination model. `Sync all` starts the staged upload batch. The user menu reads the signed Google profile and provides account, policy, contact, and logout actions.

## Caching and CSP

Production JavaScript and CSS filenames include a content hash so CloudFront's immutable caching cannot keep browsers on an older frontend after deployment. The production build injects the exact API and storage bucket origins into the page's Content Security Policy and permits Shoo plus Google profile images. This keeps authentication, avatars, API requests, and presigned S3 uploads working without broad network access.

```bash
cd web
API_URL=https://<your-api-url>/v1 npm run dev   # builds and serves on http://localhost:5173
```

## Auth flow

1. User clicks "Sign in with Google" on the frontend.
2. [shoo.dev](https://shoo.dev) handles the PKCE OAuth flow with Google.
3. Frontend receives a signed `id_token` JWT stored by `shoo.js`.
4. All API calls include the token in the `Authorization` header.
5. Each Lambda verifies the token server-side before processing.

The frontend requests Shoo's Google profile scope so the account menu can show the signed-in email and avatar. Existing sessions created before this setting was enabled need one logout and sign-in to receive those profile claims.

The deployed site URL is injected into Lambda functions as `APP_ORIGIN`, so the JWT audience always matches the frontend origin. The locally served Shoo SDK sets `data-shoo-base-url="https://shoo.dev"` so authorization requests use Shoo instead of the CloudFront origin. Frontend assets use root-relative paths so the `/shoo/callback` route loads the same scripts and styles as the site root. The frontend keeps a short-lived PKCE backup so callbacks opened in a new browser context can restore the verifier, and failed callbacks return to the sign-in screen.

## Uploads

Browser uploads use presigned S3 POST requests. The storage bucket CORS policy allows POST requests from the deployed frontend. Users can drag multiple files anywhere over the signed-in workspace or choose them manually, review each staged row's extracted metadata, and start the batch with one `Sync all` action next to the Documents heading. Staged rows never create temporary server document identities, and polling reconciles each real document ID once. Metadata extraction and upload run sequentially to keep browser and AWS concurrency low. Failed files remain in the table with their error and can be retried.

Uploads are unique per user, sanitized filename, and MIME type. DynamoDB stores a strongly consistent mapping for that identity, so concurrent requests cannot create duplicate document IDs. Uploading a completed or failed document again reserves its existing ID and S3 key. Old vectors, chunks, and parsed data remain available until S3 confirms the replacement with its upload token, then the ingest adapter removes the derived data and re-indexes the new object. Active documents reject replacement with HTTP 409.

After S3 accepts an upload, the browser explicitly starts ingestion through the API. The API and S3 event adapter use the same conditional `UPLOADED` to `QUEUED` transition so retries are safe and only one parser job is queued.

The frontend keeps recent pending and failed documents visible while DynamoDB's list index catches up. Pending uploads survive a refresh for up to 30 minutes, while local-only failed rows expire after 5 minutes. Server-side failures remain visible until they are retried or deleted.
