# Proofs

Lean 4 proofs of the invariants CheapKB relies on: upload caps, the embedding counter, storage accounting, billing, rate limits, the document lifecycle and the pure functions behind chunking, metadata and search isolation. They use core Lean only, so CI builds them in about 20 seconds.

```bash
cd proofs
lake build          # checks every proof
lake exe vectors    # writes vectors/*.json from the models
cd .. && npx vitest run tests/proofs.test.ts
```

## How the proofs stay tied to the code

Each file models one piece of TypeScript with the same constants and branches. Two checks keep the model and the code from drifting apart:

- **Test vectors.** `lake exe vectors` runs the models on fixed inputs and writes `vectors/*.json`. `tests/proofs.test.ts` runs the real TypeScript on the same inputs and expects the same outputs.
- **Anchors.** Each model lists the exact source lines it stands for, such as a DynamoDB condition or a limit. The test fails when any of them changes, which flags the model for review.

CI runs `lake build` and fails on any `sorry`, `admit`, `axiom` or warning. It then regenerates the vectors and fails if they differ from the committed ones. Production deploys wait for this job.

## What is proved

| File                     | TypeScript                                             | Theorems                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UploadCaps.lean`        | `commitWithinCaps` in `admin/upload.ts`                | Over every interleaving of concurrent uploads, deletes, expiries and reindexes: `docs_le_cap` (at most 1,000 documents), `inFlight_le_cap` (at most 10 in flight, plus documents reindex adds), `storage_overshoot` (storage stays under 1 GB plus 10 × 50 MB). `without_seq_cap_breaks` shows the `uploadSeq` condition is needed. |
| `EmbedProtocol.lean`     | chunk and embed stages, reindex                        | Over any duplication, delay or reordering of messages: `count_exact` (embeddedCount equals the EMBEDDED chunks of the current generation) and `done_means_all_embedded`. `drifts_without_freshOnly` and `drifts_without_keepEmbedded` show both guards added here are needed.                                                       |
| `StorageAccounting.lean` | `updateStorageBytes`, ingest, recount, delete, cleanup | `storage_exact`: storageBytes always equals the bytes the documents count. `drifts_without_atomicCharge` and `drifts_without_snapAtMark` show both fixes are needed.                                                                                                                                                                |
| `RateLimit.lean`         | `checkRateLimit`                                       | `allowed_le_budget`: concurrent requests never get more than the bucket size plus its refill. `old_check_double_spends` shows the old condition allowed a double spend.                                                                                                                                                             |
| `Lifecycle.lean`         | every META writer                                      | `deleting_absorbing`, `no_resurrection`, `old_failure_write_resurrects`, `no_finalize_during_edit`.                                                                                                                                                                                                                                 |
| `Billing.lean`           | `currentCycle`, `storageCostNanoUsd`, `recordUsage`    | `cycle_contains_now` and `anchor_mono` (cycles tile time), `accrued_close` (storage cost accrued piece by piece is within one nano USD per piece of the exact charge), `billed_once`, `recordOnce_idem`, `paused_monotone`.                                                                                                         |
| `Chunker.lean`           | `splitIntoChunks`, the parse guard                     | `window_size_le`, `windows_cover`, `pushed_content`, `window_pages_sorted`, `window_count_bounds`, `chunks_le_cap`, `parseGuard_sound`.                                                                                                                                                                                             |
| `Batching.lean`          | `packEmbeddingBatches`, slice loops                    | `packAll_spec` (nothing lost or reordered, one owner, at most 96 inputs, fits the request), `packAll_error`, `slices_concat`, `slices_size`.                                                                                                                                                                                        |
| `Metadata.lean`          | `fitFilterableMetadata`                                | `fit_of_fits`, `fit_fits`, `fit_keeps_sourceKey`, `fit_tags_sublist`, `fit_authors_sublist`, `fit_title_from_input`.                                                                                                                                                                                                                |
| `Truncate.lean`          | `truncateUtf8`                                         | `truncate_length_le`, `truncate_prefix`, `truncate_of_fits`, `truncate_at_boundary`, `truncate_loses_at_most_three`.                                                                                                                                                                                                                |
| `QueryFilter.lean`       | `buildFilter`                                          | `caller_isolated`: every query carries exactly one userId condition, the caller's own.                                                                                                                                                                                                                                              |
| `Tags.lean`              | `normalizeTags`                                        | `normalize_clean`, `first_spelling_wins`.                                                                                                                                                                                                                                                                                           |

## Assumptions

The models take these as given rather than proving them:

- DynamoDB conditional writes and transactions are atomic and linearizable.
- SQS delivers each message at least once, possibly more than once, late and in any order. The models never consume a message.
- Lambda clocks order events the way they happened: a reindex is later than every chunk row written before it, and a timestamp never runs backwards.
- GSI2 trails a commit by less than `RECENT_UPLOAD_WINDOW_MS` (30 seconds).
- A committed upload stays in flight until S3 reports its bytes or its form expires.
- Chunking after a reset is deterministic, so every run since then produces the same chunk count.
- The parse guard is sound only if the tokenizer averages at most 16 characters per token.
- AWS and Cohere limits: BatchWriteItem 25 items, TransactWriteItems 100, SendMessageBatch 10, GetVectors 100, PutVectors and DeleteVectors 500, 2 KB of filterable vector metadata, 96 inputs and 20 MB per Cohere request.

## Accepted gaps

These hold only in a weaker form, by design:

- **Reindex is not counted against the in-flight cap.** `inFlight_le_cap` is stated as at most 10 plus the reindexes.
- **The storage cap can be exceeded.** Bytes count when S3 accepts a file, so `storage_overshoot` bounds the excess by the in-flight uploads rather than ruling it out.
- **A deleted document can count for 30 seconds.** `recentUploads` may still list it, so the count can over-count. That only causes an early refusal, never a cap breach.
- **A late PutVectors from an older chunking can leave stale text in search.** The embedding counter is exact, but the vector store is outside the model. A later reindex corrects it.
- **Pipeline writes can preempt an edit lease.** Only late or duplicated messages for a settled document do this. The edit then fails and asks for a retry.
- **Orphan chunk rows.** A delete that races a running chunk stage can leave chunk rows without a META row. The embed stage drops them, so they never reach search.

## Out of scope

- **I/O glue**: building SDK requests, parsing events, HTTP responses. Existing unit tests cover these.
- **Third-party behavior**: PDF parsing, the GPT tokenizer, Cohere embeddings, Shoo token verification.
- **The web app.**
