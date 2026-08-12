# cheapkb

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Cost-effective multimodal knowledge base on AWS. Upload documents and images, then search them with text, an image, or both.

## Features

- Upload PDF, Markdown, text, JPEG, PNG, WebP, and GIF files
- Search with natural language, an image, or combined text and image
- Filter results by document metadata
- Track processing status, usage, and plan allowance
- Replace, retry, edit, and delete uploaded content
- Keep each user's content and search results isolated

## Quickstart

Prerequisites: Node.js 22, AWS credentials, and Cohere Embed v4 access through Amazon Bedrock.

```bash
npm ci --legacy-peer-deps
npm --prefix web ci --legacy-peer-deps
cp .env.example .env
npx sst dev
```

Start the web app against a deployed or local API:

```bash
cd web
API_URL=https://<your-api-url>/v1 npm run dev   # http://localhost:5173
```

## Configuration

Copy [.env.example](.env.example) to `.env` and provide the required values. See [Deploy](docs/DEPLOY.md) for the deployment steps.

## API

The `/v1` API supports uploads, search, documents, tags, account usage, and read-only account details. All routes require a Shoo bearer token. See [OpenAPI](docs/openapi.yaml) for request and response examples.

## Verify changes

```bash
npm run format:check && npm run build && npm test
API_URL=https://example.execute-api.us-east-1.amazonaws.com/v1 npm --prefix web run build
```

## Deploy

```bash
npx sst deploy --stage production
```

See [Deploy](docs/DEPLOY.md) for configuration and CI deployment.

## Documentation

- [How CheapKB works](docs/ARCHITECTURE.md)
- [Using the web app](docs/FRONTEND.md)
- [Billing and usage](docs/BILLING.md)
- [Deploy](docs/DEPLOY.md)
- [OpenAPI](docs/openapi.yaml)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
