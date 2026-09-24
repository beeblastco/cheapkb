# Using the web app

## Sign in

Sign in with Google through [shoo.dev](https://shoo.dev). The app bundles the pinned `@shoojs/auth` client instead of loading a script from shoo.dev, and signs you out when your token expires or the session is revoked. Each account can only access its own documents, images, and search results.

## Documents

The document list supports filtering, sorting, pagination, selection, tag editing, deletion, replacement, and retry.

Errors drop down as a notification at the top center of the screen and close after 6 seconds or with ×. A failed document list or usage load has a Retry button and stays until you retry or close it. A failed detail load closes the detail panel. A document's own processing error also stays on its row.

Upload PDF, Markdown, text, JPEG, PNG, WebP, and GIF files. Images over 5 MB and other files over 50 MB are rejected before upload. Newly uploaded files remain visible while processing continues in the background.

Completed or failed documents can be replaced. Existing content remains searchable until the replacement upload is accepted.

## Search

Search with text, one supported image up to 5 MB, or both. Add filters when you want results from specific metadata.

## Development

```bash
cd web
API_URL=https://<api-url>/v1 npm run dev
```
