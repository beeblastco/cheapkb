# cheapkb Security and Engineering Audit

## Remediation status

All findings in this report were addressed on `agent/security-reliability-hardening`. Automated regression coverage now verifies tenant filtering, ownership checks, constrained uploads, SQS partial failures, retry-safe deletion, version deletion, chunk metadata, operation-specific rate limits, least-privilege infrastructure configuration, and frontend CSP/local assets. The Pulumi OpenTelemetry advisory is pinned to patched `@opentelemetry/core` through the root package override.

## Executive summary

The current `main` branch is identical to `origin/main` at commit `a8dd10b`, so this report audits the whole repository rather than a pending diff. The TypeScript build and frontend build pass, no tracked secrets were found by the targeted scan, and authenticated document listing/get/delete/reindex generally enforce ownership.

The original audit found that the application was not safe for multi-user production use. The hardening branch now tenant-scopes vector search, enforces manual-ingest ownership, returns failed SQS records for retry, and preserves cleanup state until deletion completes. The findings below retain the original evidence and explain the controls added in response.

## Scope and checks

- Reviewed all Lambda handlers, SST infrastructure, frontend code, workflow files, and documentation.
- Ran `npm run build` and `npm --prefix web run build`; both passed.
- Ran root and frontend `npm audit`; the frontend was clean, while the root tree reported one transitive OpenTelemetry advisory represented as 15 moderate dependency paths through Pulumi.
- Searched tracked source for common AWS credentials, private keys, and hard-coded API keys; no matches were found.
- Did not inspect live AWS resources or secrets and did not make AWS API calls.

## Critical

### SEC-001: Vector queries expose other users' document content

- Location: `functions/query/index.ts:55-104`, `functions/embed/index.ts:74-99`
- Evidence: embedded vector metadata contains `documentId`, title, tags, authors, year, page numbers, and the S3 chunk key, but no `userId`. The query handler authenticates the caller but never uses `userId` after rate limiting. It queries the shared stage index with only caller-supplied filters, then fetches and returns each matching S3 chunk.
- Impact: any authenticated user can search the shared vector index and receive text and metadata belonging to every other user. This breaks the repository's documented per-user isolation guarantee.
- Fix: copy the owning `userId` into every chunk/vector metadata record and always compose a server-controlled equality filter for that value. Do not let a request filter override or remove it. Reindex existing vectors after the schema change.
- Mitigation: until reindexing is complete, disable `/query` in multi-user environments or use one vector index per tenant.
- False positive notes: this is not mitigated by DynamoDB ownership checks because the query path does not read the document record before returning chunk text.

## High

### SEC-002: Manual ingest has an insecure direct object reference

- Location: `functions/admin/ingest.ts:46-88`
- Evidence: the handler loads a document by caller-supplied `documentId`, but unlike get, reindex, and delete, it never compares `doc.userId` with the authenticated `userId` before updating status and sending the owner's S3 key to the ingest queue.
- Impact: an authenticated user who obtains or guesses a document ID can trigger processing and embedding-provider spend for another user's document and alter its visible status.
- Fix: return 404 or 403 unless `result.Item.userId === userId`, and use a conditional update that includes the expected owner to avoid a check/use race.
- Mitigation: remove the `/ingest` route if S3 upload notifications are the only supported trigger.
- False positive notes: UUID-based IDs reduce discovery but are not authorization and IDs may appear in logs, query results, or shared screenshots.

### REL-001: Embedding failures are acknowledged and permanently lose queue work

- Location: `functions/embed/index.ts:40-51`
- Evidence: `processBatch` errors are caught, `handleError` only updates DynamoDB, and the handler then returns successfully. It neither throws for SQS redelivery nor re-enqueues the failed chunk messages. A failure reading one chunk or calling the provider also marks every document in that batch as failed once.
- Impact: a transient S3/provider failure consumes the SQS messages permanently. Documents can remain stuck in `EMBEDDING` with `embeddedCount < chunkCount`; the configured DLQ never receives these failures.
- Fix: use SQS partial batch responses (`batchItemFailures`) or throw so failed records are retried by SQS. Process or attribute failures per record/document, make embedding writes idempotent, and let the queue/DLQ own retry counts instead of swallowing failures.
- Mitigation: alarm on documents stuck in active states and reconcile `embeddedCount` against `chunkCount`.
- False positive notes: the parse and chunk handlers manually re-enqueue failures, but the embed handler does not.

### REL-002: Partial delete failures destroy the only cleanup index and still report success

- Location: `functions/admin/delete.ts:62-123`, `functions/admin/delete.ts:126-169`
- Evidence: vector and S3 cleanup failures are accumulated, but the document metadata is deleted anyway. The endpoint returns HTTP 200 with `deleted: true`. If vector deletion fails after chunk records are removed, later cleanup cannot recover vector keys from DynamoDB.
- Impact: user data and billable storage can be orphaned permanently while the UI tells the user deletion succeeded. This also undermines privacy/deletion guarantees.
- Fix: make deletion an idempotent state machine or cleanup job. Preserve the document and chunk key index until every derived resource is deleted, record a `DELETING`/`DELETE_FAILED` state, and only remove metadata after successful cleanup. Return a non-success status for incomplete synchronous deletion.
- Mitigation: add a scheduled orphan reconciler and alarms for cleanup failures.
- False positive notes: the S3 removal adapter cannot reliably recover vector keys after this handler has deleted the chunk records.

### SEC-003: Presigned uploads have no server-enforced size or type limits

- Location: `functions/admin/upload.ts:44-84`, `functions/parse/index.ts:52-70`
- Evidence: caller-controlled filename and MIME type are accepted without validation, and the presigned PUT has no content-length constraint. The parser then loads the entire S3 object into Lambda memory before inspecting it.
- Impact: an authenticated user can upload very large or malformed objects, causing S3 cost, repeated Lambda out-of-memory/timeouts, queue churn, and embedding expense. The request token bucket limits URL creation, not bytes uploaded.
- Fix: use a presigned POST with a `content-length-range` policy, allowlist supported MIME types/extensions, validate object size with `HeadObject` in the ingest adapter, and delete/reject oversized objects before parsing. Set explicit per-user storage/document quotas.
- Mitigation: add S3 lifecycle expiration for abandoned raw uploads and CloudWatch budget/usage alarms.
- False positive notes: the browser's `accept` attribute is only a UI hint and can be bypassed by direct API calls.

## Medium

### PRIV-001: Versioned S3 objects survive the advertised full deletion

- Location: `sst.config.ts:79-86`, `functions/admin/delete.ts:70-94`, `functions/admin/delete.ts:172-198`
- Evidence: the storage bucket enables versioning, while deletion calls omit `VersionId`. These calls create/remove current delete markers but do not erase noncurrent raw, parsed, or chunk object versions.
- Impact: deleted document content remains stored and billable, potentially indefinitely, contrary to “Delete a document and all derived data.”
- Fix: either enumerate and delete all versions and delete markers for document prefixes or configure lifecycle rules that expire noncurrent versions within a documented retention window. Account for the resulting privacy semantics in the API/docs.
- Mitigation: apply a short noncurrent-version lifecycle immediately to bound retention and cost.
- False positive notes: this finding concerns physical/version deletion, not visibility through ordinary unversioned `GetObject` calls.

### SEC-004: Production executes unpinned third-party scripts without CSP or integrity controls

- Location: `web/index.html:7-10`, `web/main.js:737-750`
- Evidence: Tailwind, the authentication SDK, and PDF.js are loaded directly from third-party origins. No Subresource Integrity attributes or Content Security Policy are present in repository configuration. These scripts execute with the application's origin privileges and can read the Shoo token used for API calls.
- Impact: compromise or unexpected mutation of any script distribution path can compromise user tokens and document data.
- Fix: bundle Tailwind and PDF.js at build time, pin exact package/asset hashes, use SRI plus `crossorigin` for immutable external assets, and deploy a restrictive CSP through CloudFront response headers. Establish how the Shoo SDK is versioned and integrity-protected before enforcing CSP.
- Mitigation: start with CSP report-only at the edge and remove unnecessary script origins.
- False positive notes: security headers could be configured outside this repository; verify the deployed CloudFront response before closing the finding.

### SEC-005: Lambda vector permissions exceed each function's responsibilities

- Location: `sst.config.ts:297-307`, `sst.config.ts:324-334`, `sst.config.ts:397-406`
- Evidence: the query function receives put, get, delete, query, and list vector actions on `*`; the embed function receives delete/query/list; the delete function receives query/list/get. Each only needs a subset of those actions.
- Impact: code execution or dependency compromise in a public query Lambda can modify or delete every accessible vector index in the account, increasing blast radius.
- Fix: grant only `s3vectors:QueryVectors` to query, only `s3vectors:PutVectors` to embed, and only `s3vectors:DeleteVectors` to delete. Scope resources to the stage bucket/index ARN where S3 Vectors IAM supports it.
- Mitigation: if resource-level scoping is not supported for an action, retain `*` only for that action and document the AWS limitation.
- False positive notes: SST resource links may add permissions, but they do not justify the explicit unrelated vector actions shown here.

### REL-003: SQS/DLQ retry configuration is bypassed by all consumers

- Location: `functions/parse/index.ts:21-41`, `functions/chunk/index.ts:22-42`, `functions/embed/index.ts:18-51`, `sst.config.ts:130-156`
- Evidence: malformed records are logged and acknowledged. Processing errors are caught; parse/chunk manually enqueue replacements, and embed acknowledges without replacement. Because handlers return success, SQS receive counts and the configured DLQs do not represent actual processing failures.
- Impact: poison messages disappear, operational visibility is misleading, and custom retries can duplicate work if a failure occurs after a replacement message is sent but before invocation completion.
- Fix: rely on SQS redelivery with partial batch failure responses, make each stage idempotent, and remove application-managed retry messages/counters where possible.
- Mitigation: emit structured metrics for discarded records and every state transition.
- False positive notes: manual retry is intentional in parse/chunk, but it defeats the infrastructure-level retry/DLQ semantics documented by the queue configuration.

### COR-001: Chunk details returned by the API are never stored in DynamoDB

- Location: `functions/chunk/index.ts:99-110`, `functions/admin/get.ts:63-69`
- Evidence: chunk records store only `chunkId`, `s3ChunkKey`, and `createdAt`, while the get endpoint returns `pageStart`, `pageEnd`, `tokenCount`, and `status` from those records.
- Impact: document detail responses contain undefined/missing fields and cannot accurately expose chunk progress or page ranges.
- Fix: persist the returned fields when creating each chunk record, including `tokenCount` and a defined chunk status, or remove unsupported fields from the API contract.
- Mitigation: none needed beyond correcting the record/API contract.
- False positive notes: page data exists in S3 chunk JSON, but the get handler reads only DynamoDB.

### COR-002: Upload and query consume the same rate-limit bucket

- Location: `functions/utils.ts:75-125`, `functions/admin/upload.ts:17`, `functions/query/index.ts:19`
- Evidence: both operations use `{ pk: RATE#<user>, sk: LIMIT }` but pass different capacities and refill rates. Query traffic therefore depletes upload capacity and upload traffic starts query capacity below its configured maximum.
- Impact: documented endpoint limits are inaccurate and one workload can unexpectedly throttle another. This also weakens cost controls because the stored bucket has no operation identity.
- Fix: include the operation in the key, such as `sk: LIMIT#UPLOAD` and `LIMIT#QUERY`, or accept a limiter name argument. Align refill parameters with the documented “per hour” limits.
- Mitigation: expose separate rate-limit metrics so unexpected coupling is visible.
- False positive notes: sharing could be intentional as a global user budget, but the differing capacities and endpoint-specific documentation contradict that interpretation.

### QUA-001: No automated tests protect authorization and pipeline invariants

- Location: `package.json:6-10`, `.github/workflows/deploy.yml:23-51`
- Evidence: the only root verification script is TypeScript compilation, and CI deploys after typechecking. There are no test files or test command.
- Impact: cross-tenant checks, conditional state transitions, SQS retry behavior, and deletion idempotency can regress while CI remains green.
- Fix: add handler-level tests for authenticated owner/non-owner access, forced tenant vector filters, malformed and oversized inputs, partial SQS failures, duplicate delivery, and partial deletion. Run them before deployment.
- Mitigation: prioritize tests for SEC-001, SEC-002, REL-001, and REL-002 before broader coverage.
- False positive notes: external tests may exist, but none are visible or required by this repository's deployment workflow.

## Low

### DEP-001: Pulumi dependency tree contained a moderate OpenTelemetry advisory

- Location: `package-lock.json` through `@pulumi/pulumi` and `@opentelemetry/core`
- Evidence: the original `npm audit --omit=dev` reported GHSA-8988-4f7v-96qf through 15 transitive paths. The root package now overrides `@opentelemetry/core` to patched version 2.8 or newer, and both dependency audits pass.
- Impact: the reported issue is unbounded baggage parsing memory use. In this repository the affected Pulumi path is primarily deployment-time, which lowers exposure compared with request-serving Lambda code.
- Fix: keep the patched override until Pulumi/SST directly select the fixed OpenTelemetry release, then remove the override after an audited upgrade.
- Mitigation: keep deployment inputs and telemetry endpoints trusted and avoid `npm audit fix --force` without reviewing the IaC changes.
- False positive notes: reachability was not proven; treat this as dependency hygiene rather than an exposed application vulnerability.

## Positive controls observed

- JWT signatures, issuer, and audience are verified server-side, and `pairwise_sub` is required.
- Document list/get/reindex/delete derive identity from the verified token; get/reindex/delete check ownership.
- Document IDs use random UUIDs.
- `.env` is ignored, `.env.example` contains placeholders, and the targeted tracked-secret scan found no credential material.
- Frontend dynamic document text is generally escaped before `innerHTML`, and toast text uses `textContent`.
- Production SST removal protection and retained resources reduce accidental infrastructure deletion.

## Completed remediation order

1. Enforce tenant scoping in vector metadata/query and reindex all existing vectors.
2. Add ownership enforcement to `/ingest` and authorization regression tests.
3. Replace swallowed SQS failures with partial batch failure handling and idempotent processing.
4. Redesign deletion to be retryable, then define noncurrent S3 version retention.
5. Enforce upload byte/type quotas and separate per-operation rate limits.
6. Reduce IAM permissions and harden the frontend dependency/CSP model.
