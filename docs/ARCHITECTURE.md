# Architecture

## Data Flow

```mermaid
flowchart LR
    Client([Client])
    API["API Gateway"]
    S3raw[("S3 raw/")]
    IngestAdapter["IngestAdapter<br/>S3 event"]
    Parse["Parse"]
    Chunk["Chunk"]
    Embed["Embed"]
    ChunkQ[["Chunk queue"]]
    EmbedQ[["Embed queue"]]
    IngestQ[["Ingest queue"]]
    DDB[("DynamoDB")]
    Vectors[("S3 Vectors")]

    Client -->|POST /upload| API --> S3raw
    S3raw -->|ObjectCreated| IngestAdapter --> IngestQ
    Client -->|POST /ingest| API --> IngestQ
    IngestQ --> Parse --> S3
    Parse --> DDB
    Parse --> ChunkQ --> Chunk --> S3
    Chunk --> DDB
    Chunk --> EmbedQ --> Embed
    Embed --> DDB
    Embed --> Vectors
    Client -->|POST /query| API --> Vectors
    Client -->|DELETE| API --> Vectors
    S3raw -->|ObjectRemoved| CleanupAdapter
    CleanupAdapter --> Vectors
    CleanupAdapter --> S3
    CleanupAdapter --> DDB
```

## Pipeline Stages

| Stage | Lambda (memory) | Timeout | Output                      |
| ----- | --------------- | ------- | --------------------------- |
| Parse | 1024 MB         | 300 s   | `parsed/{id}/v1/pages.json` |
| Chunk | 1024 MB         | 300 s   | `chunks/{id}/*.json`        |
| Embed | 128 MB          | 300 s   | S3 Vectors                  |

Each stage writes to DynamoDB before queueing the next stage. Consumers return failed message identifiers to SQS, which retries only those records and sends them to the stage DLQ after 3 receives. After the third failure the document is marked `FAILED` with `failedStep` set to the failing stage.

## DynamoDB Schema

Single table `Meta`. Primary key: `pk` (string) / `sk` (string). GSI1 on `gsi1pk` / `gsi1sk` for status-based queries.

| Key      | Type   | Purpose            |
| -------- | ------ | ------------------ |
| `pk`     | string | `DOC#{documentId}` |
| `sk`     | string | `META`             |
| `gsi1pk` | string | `STATUS#{status}`  |
| `gsi1sk` | string | ISO timestamp      |

Document attributes: `documentId`, `userId`, `title`, `status`, `sourceKey`, `mimeType`, `lastError`, `retryCount`, `failedStep`, `chunkCount`, `embeddedCount`, `tags`, `authors`, `year`, `createdAt`, `updatedAt`.

Chunk records store ownership, page range, token count, S3 key, and processing status. Vector metadata includes the owner, and every vector query adds a server-controlled `userId` equality filter.

## S3 Layout

```
raw/{documentId}/{filename}        # Original upload
parsed/{documentId}/v1/pages.json  # Extracted text
chunks/{documentId}/chunk_*.json   # One JSON per chunk
```

## Batch + Parallelism

- `Chunk` writes chunk JSON and DynamoDB records, then sends chunks to the embed queue in groups of 10.
- Documents are capped at `MAX_CHUNKS_PER_DOCUMENT` (default 200) to bound embedding and vector-storage cost.
- `Embed` reads chunks in batches of `EMBED_BATCH` (default 25), embeds them in one request, and writes vectors in batches of `VECTOR_BATCH` (default 500).
- `Query` fetches all matched chunk JSONs in parallel.

## Error Handling

- Auto-retry: partial batch responses return failed records to SQS without replaying successful records.
- After 3 failures: `status = FAILED`, `failedStep` set, `lastError` populated.
- `POST /documents/:id/reindex` resumes from the appropriate stage and resets `lastError`/`retryCount`/`failedStep`.

## Auto Cleanup

Triggered by `DELETE /documents/:id` (API) or by S3 `ObjectRemoved:Delete` / `ObjectRemoved:DeleteMarkerCreated` events for keys under `raw/`. The cleanup function:

1. Lists and deletes all S3 Vectors for the document.
2. Deletes all versions and delete markers under `chunks/{id}/`, `parsed/{id}/`, and `raw/{id}/`.
3. Deletes chunk and document DynamoDB records only after external cleanup succeeds.

The bucket lifecycle expires any remaining noncurrent versions after 7 days and aborts incomplete multipart uploads after 1 day.

## Resource Naming

`<project>-<stage>-<service>-<account-id>-<region>`. Production omits the stage prefix.
