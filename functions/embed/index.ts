import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DeleteVectorsCommand,
  PutVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DocumentType } from "@smithy/types";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { encode } from "gpt-tokenizer";
import type { EmbedMessage } from "../types";
import {
  dynamo,
  embeddingDimension,
  embeddingModel,
  fitFilterableMetadata,
  getDocument,
  invokeEmbeddingModel,
  MAX_IMAGE_UPLOAD_BYTES,
  recordStageError,
} from "../utils";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const bedrockRoleArn = process.env.BEDROCK_ASSUME_ROLE_ARN;
const bedrockExternalId = process.env.BEDROCK_ASSUME_ROLE_EXTERNAL_ID;
const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
  ...(bedrockRoleArn
    ? {
        credentials: fromTemporaryCredentials({
          clientConfig: { region: process.env.AWS_REGION },
          params: {
            RoleArn: bedrockRoleArn,
            RoleSessionName: "cheapkb-pipeline",
            ...(bedrockExternalId ? { ExternalId: bedrockExternalId } : {}),
          },
        }),
      }
    : {}),
});
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;
const MAX_COHERE_ITEMS = 96;
const MAX_COHERE_REQUEST_BYTES = 19 * 1024 * 1024;
// Matches the pipeline Lambda timeout, so a crashed attempt's claim has expired
// before SQS redelivers its message (visibility timeout 900 seconds).
const EMBED_CLAIM_LEASE_MS = 300_000;
// S3 Vectors allows 40 KB of metadata per vector, 2 KB of it filterable. The full
// chunk text (about 3 KB at 700 tokens) is kept so search needs no S3 read.
const MAX_VECTOR_TEXT_BYTES = 32 * 1024;
// A transaction holds up to 100 items: the chunk rows plus their META row.
const MAX_TRANSACT_CHUNKS = 99;

interface ChunkMetadata {
  documentId: string;
  userId: string;
  chunkId: string;
  embeddingModel?: string;
  tokenCount?: number;
  title?: string;
  tags?: string[];
  authors?: string[];
  year?: number;
  pageStart?: number;
  pageEnd?: number;
  sourceKey?: string;
  modality: "image" | "text";
  mimeType?: string;
  text?: string;
  chunkPreview?: string;
}

interface EmbeddingChunk {
  attempt: number;
  chunkId: string;
  createdAt: string;
  documentId: string;
  messageId: string;
  modality: "image" | "text";
  pageEnd?: number;
  pageStart?: number;
  text: string;
  tokenCount?: number;
}

interface EmbeddingWork {
  attempt: number;
  createdAt: string;
  imageBase64?: string;
  imageFormat?: "gif" | "jpeg" | "png" | "webp";
  messageId: string;
  metadata: ChunkMetadata;
  text?: string;
}

/** Embed stage entry, called by the pipeline router with embed records. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const chunks: EmbeddingChunk[] = [];
  const failedMessageIds = new Set<string>();

  for (const record of event.Records) {
    const chunk = parseEmbedRecord(record);
    if (chunk) {
      chunks.push(chunk);
    } else {
      failedMessageIds.add(record.messageId);
    }
  }

  if (chunks.length === 0) {
    return {
      batchItemFailures: Array.from(failedMessageIds).map((itemIdentifier) => ({
        itemIdentifier: itemIdentifier,
      })),
    };
  }

  const batchSize = Math.max(1, parseInt(process.env.EMBED_BATCH ?? "10", 10));
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const documents = new Map<string, { attempt: number; error: unknown }>();
    try {
      const failures = await batchProcess(batch);
      for (const [messageId, failure] of failures) {
        failedMessageIds.add(messageId);
        const previous = documents.get(failure.documentId);
        if (!previous || previous.attempt < failure.attempt) {
          documents.set(failure.documentId, {
            attempt: failure.attempt,
            error: failure.error,
          });
        }
      }
    } catch (err) {
      console.error(`[embed] Batch failed:`, err);
      for (const chunk of batch) {
        failedMessageIds.add(chunk.messageId);
        const previous = documents.get(chunk.documentId);
        documents.set(chunk.documentId, {
          attempt: Math.max(previous?.attempt ?? 1, chunk.attempt),
          error: err,
        });
      }
    }
    // Error writes run outside the batch try, so one failing write cannot fail
    // chunks that were already embedded; their own messages are retried anyway.
    const writes = await Promise.allSettled(
      Array.from(documents, ([documentId, failure]) =>
        recordStageError(
          documentId,
          TableName,
          "EMBEDDING",
          failure.error,
          failure.attempt,
        ),
      ),
    );
    for (const write of writes) {
      if (write.status === "rejected") {
        console.error("[embed] Could not record failure:", write.reason);
      }
    }
  }

  return {
    batchItemFailures: Array.from(failedMessageIds).map((itemIdentifier) => ({
      itemIdentifier: itemIdentifier,
    })),
  };
}

/** Groups items into Cohere requests by owner, item count and request size.
 * A request's size is its empty body plus each input and the comma between inputs. */
export function packEmbeddingBatches(
  items: EmbeddingWork[],
): EmbeddingWork[][] {
  const emptyBytes = Buffer.byteLength(
    JSON.stringify(buildEmbeddingRequest([])),
  );
  const batches: EmbeddingWork[][] = [];
  let current: EmbeddingWork[] = [];
  let currentBytes = emptyBytes;

  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(embeddingInput(item)));
    const differentOwner =
      current.length > 0 && current[0].metadata.userId !== item.metadata.userId;
    const requestBytes =
      currentBytes + itemBytes + (current.length > 0 ? 1 : 0);
    if (
      current.length > 0 &&
      (differentOwner ||
        current.length + 1 > MAX_COHERE_ITEMS ||
        requestBytes > MAX_COHERE_REQUEST_BYTES)
    ) {
      batches.push(current);
      current = [item];
      currentBytes = emptyBytes + itemBytes;
    } else {
      current.push(item);
      currentBytes = requestBytes;
    }
    if (currentBytes > MAX_COHERE_REQUEST_BYTES) {
      throw new Error("One Cohere embedding input exceeds the request limit");
    }
  }

  if (current.length > 0) batches.push(current);

  return batches;
}

/** Cuts text to at most maxBytes of UTF-8, backing off a split character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // Continuation bytes are 10xxxxxx, so the cut moves back to a character start.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;

  return bytes.subarray(0, end).toString("utf8");
}

/** Embeds one batch of chunks, writes their vectors and marks them embedded.
 * Returns the per-message failures for the handler to record. */
async function batchProcess(
  batch: EmbeddingChunk[],
): Promise<
  Map<string, { attempt: number; documentId: string; error: unknown }>
> {
  // Title, tags and source come from META, read once per document in the batch.
  const documents = new Map<string, ReturnType<typeof getDocument>>();
  const reconcileDocuments = new Set<string>();
  const failures = new Map<
    string,
    { attempt: number; documentId: string; error: unknown }
  >();

  const loaded = await Promise.all(
    batch.map(async (chunk): Promise<EmbeddingWork | undefined> => {
      try {
        let document = documents.get(chunk.documentId);
        if (!document) {
          document = getDocument(chunk.documentId, dynamo, TableName, false);
          documents.set(chunk.documentId, document);
        }
        let doc = await document;
        // An eventually consistent miss is confirmed with a strong read before dropping.
        if (!doc || doc.status === "DELETING") {
          doc = await getDocument(chunk.documentId, dynamo, TableName);
        }
        if (!doc || doc.status === "DELETING") {
          console.log(`[embed] ${chunk.documentId} was deleted, dropping`);
          return undefined;
        }
        if (!doc.userId) throw new Error("Document owner is missing");
        if (doc.reindexedAt && chunk.createdAt <= doc.reindexedAt) {
          console.log(`[embed] ${chunk.chunkId} predates a reindex, dropping`);
          return undefined;
        }
        const { modality, text } = chunk;
        if (modality === "text" && !text.trim()) return undefined;
        const tokenCount =
          modality === "text"
            ? typeof chunk.tokenCount === "number" && chunk.tokenCount > 0
              ? chunk.tokenCount
              : encode(text, { disallowedSpecial: new Set() }).length
            : undefined;
        const metadata: ChunkMetadata = {
          documentId: chunk.documentId,
          userId: doc.userId,
          chunkId: chunk.chunkId,
          modality: modality,
          ...(tokenCount ? { tokenCount: tokenCount } : {}),
          ...(doc.title ? { title: doc.title } : {}),
          ...(doc.tags ? { tags: doc.tags } : {}),
          ...(doc.authors ? { authors: doc.authors } : {}),
          ...(doc.year ? { year: doc.year } : {}),
          ...(doc.mimeType ? { mimeType: doc.mimeType } : {}),
          ...(doc.sourceKey ? { sourceKey: doc.sourceKey } : {}),
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
        };

        // Only the delivery that claims the chunk calls Bedrock, so a duplicate
        // message is never embedded and billed twice.
        const claim = await claimChunk(
          chunk.documentId,
          metadata.chunkId,
          chunk.createdAt,
        );
        if (claim === "embedded") {
          reconcileDocuments.add(chunk.documentId);
          return undefined;
        }
        if (claim === "held") {
          console.log(
            `[embed] ${metadata.chunkId} is claimed by another delivery, dropping`,
          );
          return undefined;
        }
        if (claim === "missing" || claim === "stale") {
          console.log(
            `[embed] ${metadata.chunkId} is ${claim}, its document was deleted or re-chunked, dropping`,
          );
          return undefined;
        }

        if (modality === "image") {
          if (!metadata.sourceKey || !metadata.mimeType) {
            throw new Error(
              "Image chunk is missing its source key or MIME type",
            );
          }
          const image = await s3.send(
            new GetObjectCommand({
              Bucket: StorageBucketName,
              Key: metadata.sourceKey,
            }),
          );
          const imageBytes = await image.Body!.transformToByteArray();
          if (imageBytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
            throw new Error(
              "Image exceeds the configured Cohere embedding limit",
            );
          }
          return {
            attempt: chunk.attempt,
            createdAt: chunk.createdAt,
            imageBase64: Buffer.from(imageBytes).toString("base64"),
            imageFormat: imageFormat(metadata.mimeType),
            messageId: chunk.messageId,
            metadata: metadata,
            text: buildImageDescription(metadata),
          };
        }

        return {
          attempt: chunk.attempt,
          createdAt: chunk.createdAt,
          messageId: chunk.messageId,
          metadata: metadata,
          text: text,
        };
      } catch (error) {
        failures.set(chunk.messageId, {
          attempt: chunk.attempt,
          documentId: chunk.documentId,
          error: error,
        });
        return undefined;
      }
    }),
  );
  const workItems = loaded.filter((item) => item !== undefined);

  const embeddingsByChunk = new Map<string, number[]>();
  await Promise.all(
    packEmbeddingBatches(workItems).map((items) =>
      embedItems(items, embeddingsByChunk, failures),
    ),
  );

  const vectorBatch: Array<{
    attempt: number;
    createdAt: string;
    data: number[];
    key: string;
    messageId: string;
    metadata: ChunkMetadata;
  }> = [];
  for (const item of workItems) {
    const meta = item.metadata;
    const fullText = item.text ?? "";
    const embedding = embeddingsByChunk.get(meta.chunkId);
    if (!embedding) continue;
    vectorBatch.push({
      key: meta.chunkId,
      data: embedding,
      attempt: item.attempt,
      createdAt: item.createdAt,
      messageId: item.messageId,
      metadata: {
        ...fitFilterableMetadata({
          ...meta,
          embeddingModel: embeddingModel(),
        }),
        text: truncateUtf8(fullText, MAX_VECTOR_TEXT_BYTES),
        chunkPreview: fullText.substring(0, 200),
      },
    });
  }

  const writtenDocuments = new Set(reconcileDocuments);
  if (vectorBatch.length === 0) {
    await Promise.all(
      Array.from(writtenDocuments, (documentId) => markEmbedded(documentId)),
    );
    return failures;
  }

  const vectorBatchSize = parseInt(process.env.VECTOR_BATCH ?? "500", 10);
  const writtenVectors: typeof vectorBatch = [];
  for (let i = 0; i < vectorBatch.length; i += vectorBatchSize) {
    const chunk = vectorBatch.slice(i, i + vectorBatchSize);
    try {
      await vectors.send(
        new PutVectorsCommand({
          vectorBucketName: VectorBucketName,
          indexName: VectorIndexName,
          vectors: chunk.map((v) => ({
            key: v.key,
            data: { float32: v.data },
            metadata: v.metadata as unknown as DocumentType,
          })),
        }),
      );
      writtenVectors.push(...chunk);
    } catch (error) {
      for (const item of chunk) {
        failures.set(item.messageId, {
          attempt: item.attempt,
          documentId: item.metadata.documentId,
          error: error,
        });
      }
    }
  }

  const chunksByDocument = new Map<
    string,
    Array<{ chunkId: string; createdAt: string }>
  >();
  for (const vector of writtenVectors) {
    const { documentId } = vector.metadata;
    chunksByDocument.set(documentId, [
      ...(chunksByDocument.get(documentId) ?? []),
      { chunkId: vector.key, createdAt: vector.createdAt },
    ]);
    writtenDocuments.add(documentId);
  }
  for (const [documentId, chunks] of chunksByDocument) {
    await markChunksEmbedded(documentId, chunks);
  }
  await Promise.all(
    Array.from(writtenDocuments, (documentId) => markEmbedded(documentId)),
  );
  console.log(`[embed] OK: ${writtenVectors.length} vectors written`);

  return failures;
}

/** Claims a chunk for this delivery. A failed claim returns the row it saw, which tells an
 * embedded chunk from a live claim, a row from a newer chunking, or one that no longer exists. */
async function claimChunk(
  documentId: string,
  chunkId: string,
  createdAt: string,
): Promise<"claimed" | "embedded" | "held" | "missing" | "stale"> {
  const now = Date.now();
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: `CHUNK#${chunkId}` },
        UpdateExpression: "SET embedClaimedAt = :now",
        ConditionExpression:
          "attribute_exists(pk) AND createdAt = :createdAt AND #s <> :embedded AND (attribute_not_exists(embedClaimedAt) OR embedClaimedAt < :expired)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":createdAt": createdAt,
          ":embedded": "EMBEDDED",
          ":expired": now - EMBED_CLAIM_LEASE_MS,
          ":now": now,
        },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      }),
    );
    return "claimed";
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
    if (!error.Item) return "missing";
    if (error.Item.createdAt?.S !== createdAt) return "stale";

    return error.Item.status?.S === "EMBEDDED" ? "embedded" : "held";
  }
}

/** Embeds one packed request, halving it on error to isolate the failing item. */
async function embedItems(
  items: EmbeddingWork[],
  embeddingsByChunk: Map<string, number[]>,
  failures: Map<
    string,
    { attempt: number; documentId: string; error: unknown }
  >,
): Promise<void> {
  try {
    const hasImage = items.some((item) => item.imageBase64);
    const hasText = items.some((item) => !item.imageBase64);
    const modality =
      hasImage && hasText ? "mixed" : hasImage ? "image" : "text";
    const embeddings = await invokeEmbeddingModel(
      bedrock,
      buildEmbeddingRequest(items),
      items[0].metadata.userId,
      process.env.ACCOUNTS_TABLE_NAME!,
      "ingest",
      modality,
    );
    for (let index = 0; index < items.length; index += 1) {
      embeddingsByChunk.set(items[index].metadata.chunkId, embeddings[index]);
    }
  } catch (error) {
    if (items.length > 1) {
      const middle = Math.ceil(items.length / 2);
      await Promise.all([
        embedItems(items.slice(0, middle), embeddingsByChunk, failures),
        embedItems(items.slice(middle), embeddingsByChunk, failures),
      ]);
      return;
    }
    const [item] = items;
    failures.set(item.messageId, {
      attempt: item.attempt,
      documentId: item.metadata.documentId,
      error: error,
    });
  }
}

/** Marks a chunk EMBEDDED and bumps the document count in one transaction. A chunk already
 * embedded or older than the last reindex is left alone; one whose document or row is gone
 * loses its vector. proofs/EmbedProtocol.lean shows the count then never drifts. */
async function markChunkEmbedded(
  documentId: string,
  chunkId: string,
  createdAt: string,
): Promise<void> {
  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TableName,
              Key: { pk: `DOC#${documentId}`, sk: `CHUNK#${chunkId}` },
              UpdateExpression: "SET #s = :embedded",
              ConditionExpression:
                "attribute_exists(pk) AND createdAt = :createdAt AND (attribute_not_exists(#s) OR #s <> :embedded)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":createdAt": createdAt,
                ":embedded": "EMBEDDED",
              },
            },
          },
          {
            Update: {
              TableName: TableName,
              Key: { pk: `DOC#${documentId}`, sk: "META" },
              UpdateExpression:
                "SET #s = :embedding, embeddedCount = if_not_exists(embeddedCount, :zero) + :one",
              ConditionExpression:
                "attribute_exists(pk) AND #s <> :deleting AND (attribute_not_exists(reindexedAt) OR reindexedAt < :createdAt)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":createdAt": createdAt,
                ":deleting": "DELETING",
                ":embedding": "EMBEDDING",
                ":one": 1,
                ":zero": 0,
              },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if ((err as Error).name !== "TransactionCanceledException") throw err;
    // Delete marks META as DELETING before it removes vectors, and a shorter re-chunk removes
    // surplus rows, so a vector written after either is removed instead of staying searchable.
    const doc = await getDocument(documentId, dynamo, TableName);
    const existing = await dynamo.send(
      new GetCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: `CHUNK#${chunkId}` },
        ConsistentRead: true,
      }),
    );
    if (!doc || doc.status === "DELETING" || !existing.Item) {
      await vectors.send(
        new DeleteVectorsCommand({
          vectorBucketName: VectorBucketName,
          indexName: VectorIndexName,
          keys: [chunkId],
        }),
      );
      return;
    }
    // A newer chunking owns the row and writes its own vector under this key.
    if (existing.Item.createdAt !== createdAt) return;
    if (existing.Item.status === "EMBEDDED") return;
    // A reindex reset the count after this chunking; its re-chunk embeds the row again.
    if (doc.reindexedAt && createdAt <= doc.reindexedAt) return;
    throw err;
  }
}

/** Marks a document's chunks EMBEDDED and adds them to its count, one transaction
 * per 99 chunks. A cancelled group retries chunk by chunk to keep those semantics. */
async function markChunksEmbedded(
  documentId: string,
  chunks: Array<{ chunkId: string; createdAt: string }>,
): Promise<void> {
  for (let i = 0; i < chunks.length; i += MAX_TRANSACT_CHUNKS) {
    const group = chunks.slice(i, i + MAX_TRANSACT_CHUNKS);
    try {
      await dynamo.send(
        new TransactWriteCommand({
          TransactItems: [
            ...group.map(({ chunkId, createdAt }) => ({
              Update: {
                TableName: TableName,
                Key: { pk: `DOC#${documentId}`, sk: `CHUNK#${chunkId}` },
                UpdateExpression: "SET #s = :embedded",
                ConditionExpression:
                  "attribute_exists(pk) AND createdAt = :createdAt AND (attribute_not_exists(#s) OR #s <> :embedded)",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                  ":createdAt": createdAt,
                  ":embedded": "EMBEDDED",
                },
              },
            })),
            {
              Update: {
                TableName: TableName,
                Key: { pk: `DOC#${documentId}`, sk: "META" },
                UpdateExpression: "SET #s = :embedding ADD embeddedCount :n",
                ConditionExpression:
                  "attribute_exists(pk) AND #s <> :deleting AND (attribute_not_exists(reindexedAt) OR reindexedAt < :createdAt)",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                  // The oldest chunk decides; a group mixing generations retries chunk by chunk.
                  ":createdAt": group
                    .map(({ createdAt }) => createdAt)
                    .reduce((oldest, next) => (next < oldest ? next : oldest)),
                  ":deleting": "DELETING",
                  ":embedding": "EMBEDDING",
                  ":n": group.length,
                },
              },
            },
          ],
        }),
      );
    } catch (err) {
      if ((err as Error).name !== "TransactionCanceledException") throw err;
      for (const { chunkId, createdAt } of group) {
        await markChunkEmbedded(documentId, chunkId, createdAt);
      }
    }
  }
}

/** Marks the document EMBEDDED once every chunk has been embedded. */
async function markEmbedded(documentId: string): Promise<void> {
  // Read strongly so the count includes the increment this call just committed.
  const doc = await getDocument(documentId, dynamo, TableName);
  const expected = doc?.chunkCount ?? 0;
  const done = doc?.embeddedCount ?? 0;
  if (expected <= 0 || done < expected) return;

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :s, updatedAt = :t, lastError = :null, retryCount = :zero, failedStep = :null",
        ConditionExpression:
          "attribute_exists(pk) AND embeddedCount >= :expected AND #s <> :s AND #s <> :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":s": "EMBEDDED",
          ":t": new Date().toISOString(),
          ":expected": expected,
          ":null": null,
          ":zero": 0,
        },
      }),
    );
  } catch (err) {
    if ((err as Error).name !== "ConditionalCheckFailedException") {
      throw err;
    }
  }
}

/** Builds the Cohere Embed v4 search_document request body for text and image items. */
function buildEmbeddingRequest(
  items: EmbeddingWork[],
): Record<string, unknown> {
  return {
    input_type: "search_document",
    inputs: items.map((item) => embeddingInput(item)),
    embedding_types: ["float"],
    output_dimension: embeddingDimension(),
    max_tokens: 128000,
    truncate: "RIGHT",
  };
}

function buildImageDescription(metadata: ChunkMetadata): string {
  return [
    metadata.title,
    metadata.authors?.length
      ? `Authors: ${metadata.authors.join(", ")}`
      : undefined,
    metadata.tags?.length ? `Tags: ${metadata.tags.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Builds one Cohere input: the text alone, or the image with its description. */
function embeddingInput(item: EmbeddingWork): Record<string, unknown> {
  if (!item.imageBase64 || !item.imageFormat) {
    return { content: [{ type: "text", text: item.text ?? "" }] };
  }
  const content: Array<Record<string, unknown>> = [];
  if (item.text) content.push({ type: "text", text: item.text });
  content.push({
    type: "image_url",
    image_url: {
      url: `data:image/${item.imageFormat};base64,${item.imageBase64}`,
    },
  });

  return { content: content };
}

function imageFormat(mimeType: string): "gif" | "jpeg" | "png" | "webp" {
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/jpeg") return "jpeg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  throw new Error(`Unsupported image MIME type: ${mimeType}`);
}

/** Reads one embed record, or returns undefined after logging why it is unusable. */
function parseEmbedRecord(record: SQSRecord): EmbeddingChunk | undefined {
  let body: Partial<EmbedMessage>;
  try {
    body = JSON.parse(record.body);
  } catch {
    console.error("[embed] Invalid JSON in record:", record.messageId);
    return undefined;
  }
  const { chunkId, createdAt, documentId } = body;
  if (!documentId || !chunkId || !createdAt) {
    console.error("[embed] Missing required fields:", record.messageId);
    return undefined;
  }

  return {
    documentId: documentId,
    chunkId: chunkId,
    createdAt: createdAt,
    modality: body.modality === "image" ? "image" : "text",
    text: typeof body.text === "string" ? body.text : "",
    tokenCount: body.tokenCount,
    pageStart: body.pageStart,
    pageEnd: body.pageEnd,
    messageId: record.messageId,
    attempt: parseInt(record.attributes.ApproximateReceiveCount ?? "1", 10),
  };
}
