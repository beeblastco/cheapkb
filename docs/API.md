# API Reference

Base URL: `https://<api-id>.execute-api.us-east-1.amazonaws.com/v1`

All requests and responses are JSON. Errors return `{ "error": "message" }` with status 400/404/500.

## POST /upload

Get a size-constrained presigned POST form to upload a PDF, Markdown, or plain-text file. The default maximum is 10 MB.

```json
{
  "filename": "paper.pdf",
  "mimeType": "application/pdf",
  "title": "Optional",
  "tags": ["research"],
  "authors": ["Author Name"],
  "year": 2024
}
```

Response:

```json
{
  "documentId": "doc_...",
  "uploadUrl": "https://...",
  "uploadFields": { "key": "...", "policy": "..." },
  "maxUploadBytes": 10485760,
  "sourceKey": "raw/doc_.../paper.pdf",
  "reused": false
}
```

Create a `FormData`, append every `uploadFields` entry, append the file as `file`, and `POST` it to `uploadUrl`. The S3 event triggers ingest automatically.

The combination of user, sanitized filename, and MIME type is unique. A completed or failed match returns its existing `documentId`, `sourceKey`, and `reused: true`. Active matches return HTTP 409. Replacement cleanup starts only after S3 confirms the new object.

## POST /ingest

Manually re-trigger the pipeline for an existing document.

```json
{ "documentId": "doc_..." }
```

Response: `{ "documentId", "status": "QUEUED" }`. Returns 404 if the document does not exist or is owned by another user.

## POST /query

```json
{
  "query": "What is RAG?",
  "topK": 10,
  "filters": { "year": { "$gte": 2023 }, "tags": "research" }
}
```

Filter operators: `$eq`, `$gte`, `$lte`, `$in`.

`query` is limited to 4000 characters and `topK` must be an integer from 1 to 50. A server-controlled user filter is always applied; callers cannot query another user's vectors.

Response:

```json
{
  "query": "...",
  "topK": 10,
  "resultCount": 3,
  "results": [
    {
      "documentId": "doc_...",
      "chunkId": "chunk_...",
      "score": 0.89,
      "title": "...",
      "pageStart": 1,
      "pageEnd": 3,
      "text": "...",
      "source": { "bucket": "...", "key": "raw/doc_.../" }
    }
  ]
}
```

## GET /documents

Returns `{ count, documents: [...] }`. Each document has `documentId`, `title`, `status`, `lastError`, `retryCount`, `failedStep`, `mimeType`, `tags`, `authors`, `year`, `createdAt`, `updatedAt`.

## GET /documents/:id

Returns `{ document, chunks: [...], chunkCount }`. 404 if missing.

## POST /documents/:id/reindex

Restart from the failed step. Returns `{ documentId, status: "QUEUED", restartFrom, message }`.

| Current status                 | Restart from |
| ------------------------------ | ------------ |
| UPLOADED, QUEUED, FAILED/PARSE | Parse        |
| PARSED, FAILED/CHUNK           | Chunk        |
| CHUNKED, FAILED/EMBED          | Embed        |
| EMBEDDED                       | Embed        |

## DELETE /documents/:id

Deletes the document record, all vectors, every S3 object version for chunks, parsed text, and the source file. Returns `{ documentId, deleted: true }`. Partial cleanup returns HTTP 500 with `{ documentId, deleted: false, warnings: [...] }` and preserves DynamoDB cleanup keys so the request can be retried.

## GET /tags

Returns `{ count, tags: [...] }` for the caller, sorted by name. Each tag has `name`, `color`, and `createdAt`. Tags stored before colors existed, or with a color outside the palette, read back as `gray`.

`color` is one of `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `red`. Colors are stored as palette names, not CSS values, so the web app owns how each renders in light and dark mode.

## POST /tags

Body `{ name, color? }`. `color` defaults to `gray`. Returns `{ tag }`.

Names are limited to 50 characters and 200 tags per user; the key is the lowercased name, so tags are case-insensitively unique but keep the casing they were created with. Creating a tag that already exists returns the stored record rather than overwriting it, so the request is idempotent and the existing casing and color win. Returns 400 for an empty name, an over-long name, or a color outside the palette, and 409 at the tag cap or when a concurrent write means the create could not be confirmed.

## PATCH /tags/:name

Body `{ color }`. Returns the updated `{ tag }`. Only the color can change; renaming is not supported.

Returns 400 for a missing color or one outside the palette, and 404 if the tag no longer exists, so a recolor cannot recreate a tag deleted by another client.

## DELETE /tags/:name

Removes the tag from the caller's vocabulary. Returns `{ name, deleted: true }`. Documents already tagged with it keep the tag until they are edited.
