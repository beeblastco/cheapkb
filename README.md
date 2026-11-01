# cheapkb

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Cost-effective multimodal knowledge base on AWS. Upload documents and images, then search them with text, an image, or both.

Live web app: https://cheapkb.beeblast.co

API: https://api.cheapkb.beeblast.co/v1

## Features

- Upload PDF, Markdown, text, JPEG, PNG, WebP, and GIF files
- Search with natural language, an image, or combined text and image
- Filter results by document metadata
- Track processing status, usage, and plan allowance
- Search from Claude Code, Broods, or any MCP 2026-07-28 client
- Replace, retry, edit, and delete uploaded content
- Keep each user's content and search results isolated

## Quickstart

Prerequisites: Node.js 22.18 or later (the `scripts/*.ts` checks run TypeScript directly), AWS credentials, and Cohere Embed v4 access through Amazon Bedrock. The Lean proofs need [elan](https://github.com/leanprover/elan).

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

Claude Code, Broods and other MCP clients can do what you do in the web app: search, add, retag, reindex and delete documents, manage tags, and read usage. The server speaks MCP 2026-07-28 only, so clients that still need the 2025 `initialize` handshake, such as Codex 0.166, can't connect yet. Create an MCP key in the web app under Settings, then:

```bash
claude mcp add --transport http cheapkb <API_URL>/mcp --header "Authorization: Bearer <MCP_KEY>"
```

For Broods, run `broods env set CHEAPKB_MCP_KEY` and add:

```ts
defineMcp({
  name: "cheapkb",
  url: "<API_URL>/mcp",
  headers: { Authorization: "Bearer ${CHEAPKB_MCP_KEY}" },
});
```

Tools: `search`, `list_documents`, `get_document`, `add_document`, `update_document_tags`, `reindex_document`, `delete_document`, `list_tags`, `create_tag`, `update_tag`, `delete_tag` and `get_usage`. Deleting all data and managing the MCP key stay in the web app, so an agent, or text inside a document, can't wipe the account or lock you out. `add_document` takes files up to about 4 MB, since a Lambda request is capped at 6 MB and PDFs and images travel as base64; add larger files in the web app.

## Verify changes

```bash
npm run check   # oxlint, knip, prettier, tsc, vitest
npm run web:build      # the CI build: placeholder API URL and PostHog key
npm run bundle:check   # initial and total JS against scripts/bundle-budgets.json
npm run perf:check     # boots the build in headless Chromium, renders against scripts/render-budgets.json
cd proofs && lake build && lake exe vectors   # Lean proofs and the vectors the tests use
```

`perf:check` needs Chromium: run `npx playwright-core install --only-shell chromium` once, or set `CHROME_PATH`. When a size or render change is intended, re-record with `npm run bundle:record` or `npm run perf:record` and say why in the PR.

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
