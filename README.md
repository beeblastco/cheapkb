# cheapkb

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Cost-effective multimodal knowledge base on AWS. Upload documents and images, then search them with text, an image, or both.

Live web app: https://ds8aejb7efd81.cloudfront.net

## Features

- Upload PDF, Markdown, text, JPEG, PNG, WebP, and GIF files
- Search with natural language, an image, or combined text and image
- Filter results by document metadata
- Track processing status, usage, and plan allowance
- Search from Claude Code, Codex, Broods, or any MCP client
- Replace, retry, edit, and delete uploaded content
- Keep each user's content and search results isolated

## Quickstart

Prerequisites: Node.js 22.18 or later (`npm run bundle:check` runs TypeScript directly), AWS credentials, and Cohere Embed v4 access through Amazon Bedrock. The Lean proofs need [elan](https://github.com/leanprover/elan).

```bash
npm ci --legacy-peer-deps
npm --prefix web ci --legacy-peer-deps
cp .env.example .env
npx sst dev
```

Start the web app against a non-production stage, such as the one `npx sst dev` deploys. Production rejects tokens issued to localhost.

```bash
cd web
API_URL=https://<your-stage-api-url>/v1 npm run dev   # http://localhost:5173
```

Uploads from localhost also need `VITE_STORAGE_ORIGIN` and an S3 CORS rule for localhost, so test uploads on the deployed web app.

## Configuration

Copy [.env.example](.env.example) to `.env` and provide the required values. See [Deploy](docs/DEPLOY.md) for the deployment steps.

## API

The `/v1` API supports uploads, search, documents, tags, account usage, account details, and the MCP key. All routes except `/mcp` require a Shoo bearer token. See [OpenAPI](docs/openapi.yaml) for request and response examples.

## MCP

Claude Code, Codex, Broods and other MCP clients can search your knowledge base. The server speaks MCP 2026-07-28 and answers 2025-era clients statelessly. Create an MCP key in the web app under Settings, then:

```bash
claude mcp add --transport http cheapkb <API_URL>/mcp --header "Authorization: Bearer <MCP_KEY>"
```

For Codex, add this to `~/.codex/config.toml` and export `CHEAPKB_MCP_KEY`:

```toml
[mcp_servers.cheapkb]
url = "<API_URL>/mcp"
bearer_token_env_var = "CHEAPKB_MCP_KEY"
```

For Broods, run `broods env set CHEAPKB_MCP_KEY` and add:

```ts
defineMcp({
  name: "cheapkb",
  url: "<API_URL>/mcp",
  headers: { Authorization: "Bearer ${CHEAPKB_MCP_KEY}" },
});
```

Tools: `search`, `list_documents`, `get_document`. All are read-only.

## Verify changes

```bash
npm run check   # oxlint, prettier, tsc, vitest
API_URL=https://example.execute-api.us-east-1.amazonaws.com/v1 npm --prefix web run build
npm run bundle:check
cd proofs && lake build && lake exe vectors   # Lean proofs and the vectors the tests use
```

The safety of the upload and tag caps, embedding counter, storage accounting, billing, rate limits and document lifecycle is proved in Lean 4. See [Proofs](proofs/README.md).

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
- [Proofs](proofs/README.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
