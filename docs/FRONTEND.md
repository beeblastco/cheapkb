# Using the web app

## Sign in

Sign in with Google through [shoo.dev](https://shoo.dev). The app bundles the pinned `@shoojs/auth` client instead of loading a script from shoo.dev, and signs you out when your token expires or the session is revoked. Each account can only access its own documents, images, and search results.

Settings has **Delete all my data**, which deletes every document, image and tag in the account and resets storage to 0. Usage already spent in the current cycle stays.

## Documents

The document list supports filtering, sorting, pagination, selection, tag editing, deletion, replacement, and retry.

Errors drop down as a notification at the top center of the screen and close after 6 seconds or with ×. A failed document list or usage load has a Retry button and stays until you retry or close it. A failed detail load closes the detail panel. A document's own processing error also stays on its row.

Upload PDF, Markdown, text, JPEG, PNG, WebP, and GIF files. Images over 5 MiB and other files over 50 MiB are rejected before upload. Newly uploaded files remain visible while processing continues in the background.

Completed or failed documents can be replaced. Existing content remains searchable until the replacement upload is accepted.

## Search

Search with text, one supported image up to 5 MiB, or both. Add filters when you want results from specific metadata.

## Development

Point the dev server at a non-production stage. Production rejects tokens issued to localhost.

```bash
cd web
API_URL=https://<stage-api-url>/v1 npm run dev
```

Uploads from localhost also need `VITE_STORAGE_ORIGIN` and an S3 CORS rule for localhost, so test uploads on the deployed web app.
