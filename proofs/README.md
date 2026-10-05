# Proofs

Lean 4 proofs of the safety invariants CheapKB relies on: the upload and tag caps, the embedding counter, storage accounting, billing, rate limits, the document lifecycle and the pure functions behind chunking, metadata, packing and search isolation. They use core Lean only, so CI builds them in about 30 seconds.

```bash
cd proofs
lake build          # checks every proof and audits their axioms
lake exe vectors    # writes vectors/*.json from the models
cd .. && npx vitest run tests/proofs.test.ts
```

## How the proofs stay tied to the code

Each file models one piece of TypeScript with the same constants and branches. Two checks keep the model and the code from drifting apart:

- **Test vectors.** `lake exe vectors` runs the proved models on fixed inputs, including exact boundary cases, and writes `vectors/*.json`. `tests/proofs.test.ts` runs the real TypeScript on the same inputs and expects the same outputs.
- **Anchors.** Each model lists the exact source lines it stands for, such as a DynamoDB condition, a comparison or a limit. The test fails when any of them changes, which flags the model for review. For `MAX_STORAGE_BYTES` and `MAX_UPLOAD_BYTES` the anchors pin the defaults in code; a deploy that sets them differently is outside the proved constants.

`Audit.lean` runs during `lake build` and fails when any declaration under `Proofs` depends on an axiom other than `propext`, `Classical.choice` and `Quot.sound`. That catches `sorry`, `native_decide` and any added `axiom`. CI also rejects the words `sorry`, `admit`, `axiom`, `native_decide`, `implemented_by`, `extern` and `unsafe` in the proofs, fails on any warning, and fails when the regenerated vectors differ from the committed ones. Production deploys wait for this job.

## What is proved

Every concurrency theorem holds over every interleaving of the steps its model allows.

| File                     | TypeScript                                                     | Theorems                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UploadCaps.lean`        | `commitWithinCaps` in `admin/upload.ts`, the ingest recount    | Steps: concurrent uploads, first files landing, form expiry, overwrites through still-valid forms, deletes and reindex. `docs_le_cap` (at most 1,000 documents), `inFlight_le_cap` (at most 10 in flight plus documents reindex added), `storage_overshoot` (storage at most 1 GiB + 10 × 50 MiB). `without_seq_cap_breaks` and `uncapped_overwrite_breaks` show the `uploadSeq` condition and the recount's cap check are both needed. |
| `TagCap.lean`            | `createWithinCap` in `tags/create.ts`                          | `tags_le_cap`: concurrent creates and deletes never leave a user with more than 200 tags.                                                                                                                                                                                                                                                                                                                                               |
| `EmbedProtocol.lean`     | chunk and embed stages, reindex, `finalizeReplacement`         | Messages can be duplicated, delayed or reordered, and older chunk runs keep writing while a replacement deletes rows. `count_exact`: outside a replacement's own cleanup, embeddedCount equals the chunks EMBEDDED since the last reindex or replacement. `done_means_all_embedded` follows. `drifts_without_freshOnly` and `drifts_without_keepEmbedded` show both guards are needed.                                                  |
| `StorageAccounting.lean` | `updateStorageBytes`, ingest, recount, delete, cleanup         | `storage_exact`: storageBytes equals the bytes the documents count. `drifts_without_atomicCharge` and `drifts_without_snapAtMark` show both fixes are needed.                                                                                                                                                                                                                                                                           |
| `RateLimit.lean`         | `checkRateLimit`                                               | `allowed_le_budget`: concurrent requests never get more than the bucket size plus its refill. Tokens count in 1/3,600,000ths and time in milliseconds, so the fractional refill is exact. `old_check_double_spends` shows the old condition allowed a double spend.                                                                                                                                                                     |
| `Lifecycle.lean`         | every META writer                                              | Reindex is modelled from settled and processing statuses, which allows more than the code's one-hour rule. `deleting_absorbing`, `no_resurrection`, `old_failure_write_resurrects`, `no_finalize_during_edit`.                                                                                                                                                                                                                          |
| `Billing.lean`           | `currentCycle`, `storageCostNanoUsd`, `recordUsage`            | `cycle_contains_now` and `anchor_mono`: cycles tile time. `accrued_close`: storage cost accrued piece by piece is within one nano USD per piece of the exact charge. `billed_once` and `recordOnce_idem`: a usage record with an operation id is billed once however often it is delivered. Only ingest passes one.                                                                                                                     |
| `Chunker.lean`           | `splitIntoChunks`, the parse guard                             | `window_size_le`, `windows_cover`, `pushed_content`, `window_pages_sorted`, `window_count_bounds`, `chunks_le_cap`, `parseGuard_sound`.                                                                                                                                                                                                                                                                                                 |
| `Batching.lean`          | `packEmbeddingBatches`, slice loops                            | `packAll_spec`: nothing lost or reordered, one owner per request, at most 96 inputs, and the request fits. Also `packAll_error`, `slices_concat`, `slices_size`.                                                                                                                                                                                                                                                                        |
| `Metadata.lean`          | `fitFilterableMetadata`                                        | `fit_of_fits`, `fit_fits`, `fit_keeps_sourceKey`, `fit_tags_sublist`, `fit_authors_sublist`, `fit_title_from_input`.                                                                                                                                                                                                                                                                                                                    |
| `Truncate.lean`          | `truncateUtf8`                                                 | `truncate_length_le`, `truncate_prefix`, `truncate_of_fits`, `truncate_at_boundary`, `truncate_loses_at_most_three`.                                                                                                                                                                                                                                                                                                                    |
| `QueryFilter.lean`       | `buildFilter`                                                  | `caller_isolated`: every query carries exactly one userId condition, the caller's own.                                                                                                                                                                                                                                                                                                                                                  |
| `Tags.lean`              | `normalizeTags`, which upload and edit both store tags through | `normalize_clean`, `first_spelling_wins`.                                                                                                                                                                                                                                                                                                                                                                                               |

## Assumptions

The models take these as given rather than proving them:

- DynamoDB conditional writes and transactions are atomic and linearizable.
- SQS delivers each message at least once, possibly more than once, late and in any order. The models never consume a message.
- A reindex or replacement is stamped later than every chunk row written before it. This holds when Lambda clocks agree to within the time between a chunk run and the next reindex. Rows written after one need no clock assumption: the chunk stage stamps them at least 1 ms after `reindexedAt`.
- Clocks never run backwards for a row. The code enforces this where it matters: the rate limiter and storage accrual move a clock that trails the last write up to it.
- GSI2 trails a commit by less than `RECENT_UPLOAD_WINDOW_MS` (30 seconds).
- A committed upload stays in flight until S3 reports its first file or its form expires. The form is signed to expire within the window `isDocumentInFlight` counts it in.
- Chunking after a reset is deterministic, so every run since then produces the same chunk count.
- The parse guard is sound only if the whole text, blank pages and whitespace included, averages at most 16 characters per token. Long whitespace runs can exceed that, and then the guard may refuse a document the chunker would accept.
- AWS and Cohere limits: BatchWriteItem 25 items, TransactWriteItems 100, SendMessageBatch 10, GetVectors 100, PutVectors and DeleteVectors 500, 2 KB of filterable and 40 KB of total vector metadata, 96 inputs and 20 MB per Cohere request.

## Accepted gaps

These hold only in a weaker form, by design:

- **Reindex is not counted against the in-flight cap.** `inFlight_le_cap` is stated as at most 10 plus the reindexes.
- **The storage cap can be exceeded.** A first file is charged when S3 accepts it, so `storage_overshoot` bounds the excess by the in-flight uploads rather than ruling it out. Overwrites never add to the excess: the recount removes one that would pass the cap.
- **A deleted document can count for 30 seconds.** `recentUploads` may still list it, so the count can over-count. That only causes an early refusal, never a cap breach.
- **A late PutVectors from an older chunking can leave stale text in search.** The embedding counter is exact, but the vector store is outside the model. A later reindex corrects it.
- **Pipeline writes can preempt an edit lease.** Only late or duplicated messages for a settled document do this. The edit then fails and asks for a retry.
- **Orphan chunk rows.** A delete that races a running chunk stage can leave chunk rows without a META row. The embed stage drops them, so they never reach search.
- **Legacy documents.** `storage_exact` covers documents with `countedBytes`. A document uploaded before it existed has its size read by the delete, which records it after the DELETING mark so a retry refunds the same bytes. A direct S3 removal of such a document refunds nothing, because the object is already gone.
- **Usage without an operation id.** Queries, upload forms and embedding calls record usage without one. A Lambda retry can bill them again. A split embedding batch calls Bedrock again, and each call is billed for the tokens Bedrock reports.

## Out of scope

- **Liveness.** Every theorem is a safety property: nothing bad happens. None says that a document finishes. A document can stay EMBEDDING until the hourly sweeper redrives its messages or marks it FAILED.
- **Total vector metadata size.** It follows from proved bounds but is not one theorem: text is at most 32 KiB (`truncate_length_le`), filterable fields at most 2 KiB (`fit_fits`), and the preview at most 200 UTF-16 units (600 bytes). That is about 35 KiB of the 40 KiB S3 Vectors allows.
- **I/O glue**: building SDK requests, parsing events, HTTP responses. Existing unit tests cover these.
- **Third-party behavior**: PDF parsing, the GPT tokenizer, Cohere embeddings, Shoo token verification.
- **The web app.**
- **Float rounding.** The models use exact integer arithmetic. The TypeScript uses doubles for the rate-limit refill and storage cost, and the storage-cost vectors, generated from the proved `piece`, pin its rounding.
- **Unicode case and whitespace.** The tag and chunker theorems take `trim` and the case key as parameters, so they hold for JavaScript's `trim()` and `toLowerCase()`. The vectors use JavaScript's full whitespace set, and letters from ASCII, Latin-1, Greek and Cyrillic, whose lowercase the generator computes the way JavaScript does.
