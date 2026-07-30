# cheapkb

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![SST v4](https://img.shields.io/badge/SST-v4-purple.svg)](https://sst.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.x-green.svg)](https://nodejs.org/)

Cost-effective serverless knowledge base on AWS. Ingest documents, chunk, embed, and search vectors within the AWS Free Tier.
The authenticated workspace pairs document management and document-grounded questions with a compact plan and usage summary.

## Stack

Node.js 22.x, TypeScript, [SST v4](https://sst.dev), API Gateway, Lambda, S3, S3 Vectors, DynamoDB, and SQS. A React + Vite + shadcn/ui frontend is served from S3 through CloudFront. Auth uses [shoo.dev](https://shoo.dev) PKCE with server-side JWT verification via [jose](https://github.com/panva/jose); documents are scoped per user in a DynamoDB single-table design.

## Architecture

```mermaid
flowchart LR
    Client([Client]) -->|POST /upload| API["API Gateway"]
    API --> S3raw[("S3 raw/")]
    S3raw -->|ObjectCreated| IngestAdapter["IngestAdapter"] --> PipelineQ
    Client -->|POST /ingest| API --> PipelineQ[["Pipeline queue"]]
    PipelineQ --> Dispatch["Pipeline"]
    Dispatch -->|stage: parse| Parse["Parse"] --> PipelineQ
    Dispatch -->|stage: chunk| Chunk["Chunk"] --> PipelineQ
    Dispatch -->|stage: embed| Embed["Embed"] --> Vectors[("S3 Vectors")]
```

Documents flow through an SQS-backed pipeline (parse → chunk → embed → S3 Vectors), with each stage retried independently and failures routed to a dead-letter queue. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full data flow, DynamoDB schema, cleanup, and replacement-upload behavior.

All three stages share one queue and one Lambda event source. Each message carries a `stage` field that the `Pipeline` function uses to route it, and each stage re-enqueues the next one. This is a cost constraint, not a style choice: a Lambda SQS event source keeps a minimum of two pollers long-polling at 20s whether or not messages exist, which costs about 260k SQS requests per month per queue while completely idle. Three queues put the project at roughly 780k of the 1M monthly free tier before serving a single request. Do not split the stages back onto separate queues.

## Quickstart

Prerequisites: Node.js 22.x, AWS credentials, and an OpenAI-compatible embeddings endpoint.

```bash
npm ci --legacy-peer-deps
npm --prefix web ci --legacy-peer-deps
cp .env.example .env          # set your embedding endpoint and key
npx sst dev                   # run the backend locally
```

Serve the frontend against a deployed or local API:

```bash
cd web
API_URL=https://<your-api-url>/v1 npm run dev   # http://localhost:5173
```

## Configuration

All environment variables are documented in [.env.example](.env.example). `sst.config.ts` loads them from `.env`. Set `AWS_ACCOUNT_ID` to pin deploys to a single account; leave it unset to deploy to whatever your credentials resolve to. See [docs/DEPLOY.md](docs/DEPLOY.md).

## API

Base URL: `https://<api-id>.execute-api.<region>.amazonaws.com/v1`. All endpoints require an `Authorization: Bearer <shoo_id_token>` header.

| Method | Path                     | Description                | Rate Limit |
| ------ | ------------------------ | -------------------------- | ---------- |
| POST   | `/upload`                | Presigned URL + doc record | 50/hr      |
| POST   | `/ingest`                | Manually trigger pipeline  | -          |
| POST   | `/query`                 | Vector search with filters | 100/hr     |
| GET    | `/documents`             | List your documents        | -          |
| GET    | `/documents/:id`         | Document + chunk details   | -          |
| PATCH  | `/documents/:id`         | Update tags                | -          |
| POST   | `/documents/:id/reindex` | Restart from failed step   | -          |
| DELETE | `/documents/:id`         | Full cleanup               | -          |
| GET    | `/tags`                  | List your tags             | -          |
| POST   | `/tags`                  | Create a tag               | -          |
| PATCH  | `/tags/:name`            | Recolor a tag              | -          |
| DELETE | `/tags/:name`            | Delete a tag               | -          |
| GET    | `/plans`                 | List billing plans         | -          |
| POST   | `/plans`                 | Create a billing plan      | -          |
| GET    | `/plans/:id`             | Get a billing plan         | -          |
| PATCH  | `/plans/:id`             | Update a billing plan      | -          |
| DELETE | `/plans/:id`             | Delete a billing plan      | -          |
| GET    | `/account`               | Account profile and plan   | -          |
| GET    | `/account/usage`         | Current cycle usage        | -          |
| GET    | `/account/plans`         | Plans available to account | -          |
| PATCH  | `/account/plan`          | Assign a plan              | -          |

Full request/response schemas: [docs/openapi.yaml](docs/openapi.yaml).

## Test

```bash
npm ci --legacy-peer-deps
npm --prefix web ci --legacy-peer-deps
npm run format:check && npm run build && npm test
API_URL=https://example.execute-api.us-east-1.amazonaws.com/v1 npm --prefix web run build
```

## Deploy

```bash
npx sst deploy --stage production
```

CI deploys automatically on merge to `main` via `.github/workflows/deploy.yml`. See [docs/DEPLOY.md](docs/DEPLOY.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — data flow, DynamoDB schema, cleanup, replacement uploads
- [Frontend](docs/FRONTEND.md) — web workspace, auth flow, uploads
- [Billing and usage](docs/BILLING.md) — plans, usage cycles, storage accounting
- [API reference](docs/openapi.yaml) — OpenAPI 3 spec

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
