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
| GET    | `/jobs/:id`              | Job status                 | -          |

Full API reference: [docs/API.md](docs/API.md)

## Auth Flow

1. User clicks "Sign in with Google" on the frontend
2. [shoo.dev](https://shoo.dev) handles the PKCE OAuth flow with Google
3. Frontend receives a signed `id_token` JWT stored in `localStorage`
4. All API calls include the token in the `Authorization` header
5. Each Lambda verifies the token server-side before processing

## Configuration

```bash
EMBEDDING_PROVIDER_URL=...
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=text-embedding-3-small
CHUNK_MAX_TOKENS=700
CHUNK_OVERLAP_TOKENS=100
VECTOR_BATCH=500
EMBED_BATCH=25
APP_ORIGIN=http://localhost:5173  # Your app origin for shoo JWT audience
```

Vector dimension is **1024** with cosine distance.

## Deploy

```bash
npm install && cp .env.example .env
npx sst deploy --stage dev
AWS_PROFILE=<your-prod-profile> npx sst deploy --stage production
npx sst remove --stage dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[MIT](LICENSE)
