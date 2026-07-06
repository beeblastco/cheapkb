# API Reference

Base URL is printed by SST after deploy.

All requests and responses are JSON. Errors return `{ "error": "message" }` with status 400/404/500.

## POST /upload

Get a presigned URL to upload a file.

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
{ "documentId": "doc_...", "uploadUrl": "https://...", "sourceKey": "raw/doc_.../paper.pdf" }
```

`PUT` the file body to `uploadUrl`. The S3 event triggers ingest automatically.

## POST /ingest

Manually re-trigger the pipeline for an existing document.

```json
{ "documentId": "doc_..." }
```

Response: `{ "documentId", "status": "QUEUED" }`. Returns 404 if the document does not exist.

## POST /query

```json
{
  "query": "What is RAG?",
  "topK": 10,
  "filters": { "year": { "$gte": 2023 }, "tags": "research" }
}
```

Filter operators: `$eq`, `$gte`, `$lte`, `$in`.

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

| Current status                | Restart from |
| ----------------------------- | ------------ |
| UPLOADED, QUEUED, FAILED/PARSE | Parse        |
| PARSED, FAILED/CHUNK          | Chunk        |
| CHUNKED, FAILED/EMBED         | Embed        |
| EMBEDDED                      | No-op        |

## DELETE /documents/:id

Deletes the document record, all vectors, all chunks, parsed text, and the source file. Returns `{ documentId, deleted: true }` or `{ documentId, deleted: true, warnings: [...] }`.

## GET /jobs/:id

Returns `{ job }` for a job record, or 404.
