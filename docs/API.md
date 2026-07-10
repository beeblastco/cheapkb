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
  "sourceKey": "raw/doc_.../paper.pdf"
}
```

Create a `FormData`, append every `uploadFields` entry, append the file as `file`, and `POST` it to `uploadUrl`. The S3 event triggers ingest automatically.

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
