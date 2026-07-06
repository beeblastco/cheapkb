# cheapkb

Cost-effective serverless knowledge base on AWS. Ingest documents, chunk, embed, and search vectors within the AWS Free Tier.

## Stack

- Node.js 22.x, TypeScript
- API Gateway HTTP API, Lambda
- S3 (raw / parsed / chunks), S3 Vectors
- DynamoDB (document metadata)
- SQS (parse / chunk / embed queues with DLQ)
- [SST v3](https://sst.dev) for IaC

## Pipeline

```
Upload ──► S3 (raw/)
   │            │
   │            └─ S3 event ──► IngestAdapter ──► Ingest queue
   │                                                  │
   ▼                                                  ▼
POST /upload                              Parse ──► Chunk ──► Embed ──► S3 Vectors
```

| Status     | Meaning                              |
| ---------- | ------------------------------------ |
| UPLOADED   | File in S3, awaiting ingest          |
| QUEUED     | Queued for parsing                   |
| PARSING    | Extracting text                      |
| PARSED     | Text extracted                       |
| CHUNKING   | Splitting text                       |
| CHUNKED    | Chunks written to S3                 |
| EMBEDDING  | Generating vectors                   |
| EMBEDDED   | Vectors stored in S3 Vectors         |
| FAILED     | Pipeline failed; `failedStep` set    |

## API

| Method | Path                              | Description                  |
| ------ | --------------------------------- | ---------------------------- |
| POST   | `/upload`                         | Presigned URL + doc record   |
| POST   | `/ingest`                         | Manually trigger pipeline    |
| POST   | `/query`                          | Vector search with filters   |
| GET    | `/documents`                      | List all documents           |
| GET    | `/documents/:id`                  | Document + chunk details     |
| POST   | `/documents/:id/reindex`          | Restart from failed step     |
| DELETE | `/documents/:id`                  | Full cleanup                 |
| GET    | `/jobs/:id`                       | Job status                   |

Full reference: [docs/API.md](docs/API.md). Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Auto Cleanup

Two paths delete a document and all of its derived data (vectors, parsed text, chunks, source file, DynamoDB record):

- **API** — `DELETE /documents/:id`
- **S3** — Deleting the original file in `raw/<documentId>/` fires an S3 `ObjectRemoved` event that invokes the cleanup Lambda.

## Environment

```
EMBEDDING_PROVIDER_URL=...
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=text-embedding-3-small
CHUNK_MAX_TOKENS=700
CHUNK_OVERLAP_TOKENS=100
VECTOR_BATCH=100
EMBED_BATCH=25
```

Vector dimension is **1024** with cosine distance. The provider must return 1024-dim embeddings.

## Deploy

```bash
npm install
cp .env.example .env
npx sst deploy --stage dev
npx sst deploy --stage production
npx sst remove --stage dev
```

## Resource Naming

`<project>-<stage>-<service>-<account-id>-<region>`. Production omits the stage prefix.

## License

MIT
