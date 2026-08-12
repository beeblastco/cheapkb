# Using the web app

## Sign in

Sign in with Google through [shoo.dev](https://shoo.dev). Each account can only access its own documents, images, and search results.

## Documents

The document list supports filtering, sorting, pagination, selection, tag editing, deletion, replacement, and retry.

Upload PDF, Markdown, text, JPEG, PNG, WebP, and GIF files. Images over 5 MB are rejected before upload. Newly uploaded files remain visible while processing continues in the background.

Completed or failed documents can be replaced. Existing content remains searchable until the replacement upload is accepted.

## Search

Search with text, one supported image up to 5 MB, or both. Add filters when you want results from specific metadata.

## Development

```bash
cd web
API_URL=https://<api-url>/v1 npm run dev
```
