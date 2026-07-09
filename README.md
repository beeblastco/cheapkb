# cheapkb

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![SST v4](https://img.shields.io/badge/SST-v4-purple.svg)](https://sst.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.x-green.svg)](https://nodejs.org/)

Cost-effective serverless knowledge base on AWS. Ingest documents, chunk, embed, and search vectors within the AWS Free Tier.

**Tags:** `aws` `serverless` `rag` `vector-search` `knowledge-base` `s3-vectors` `lambda` `sst` `typescript` `free-tier`

## Stack

Node.js 22.x, TypeScript 7, [SST v4](https://sst.dev), API Gateway, Lambda, S3, S3 Vectors, DynamoDB, SQS.

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

| Method | Path                     | Description                |
| ------ | ------------------------ | -------------------------- |
| POST   | `/upload`                | Presigned URL + doc record |
| POST   | `/ingest`                | Manually trigger pipeline  |
| POST   | `/query`                 | Vector search with filters |
| GET    | `/documents`             | List all documents         |
| GET    | `/documents/:id`         | Document + chunk details   |
| POST   | `/documents/:id/reindex` | Restart from failed step   |
| DELETE | `/documents/:id`         | Full cleanup               |
| GET    | `/jobs/:id`              | Job status                 |

Full API reference: [docs/API.md](docs/API.md)

## Configuration

```bash
EMBEDDING_PROVIDER_URL=...
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=text-embedding-3-small
CHUNK_MAX_TOKENS=700
CHUNK_OVERLAP_TOKENS=100
VECTOR_BATCH=100
EMBED_BATCH=25
```

Vector dimension is **1024** with cosine distance.

## Deploy

```bash
npm install && cp .env.example .env
npx sst deploy --stage dev
AWS_PROFILE=954475336309 npx sst deploy --stage production
npx sst remove --stage dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[MIT](LICENSE)
