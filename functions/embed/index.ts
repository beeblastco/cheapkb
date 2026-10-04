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
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { encode } from "gpt-tokenizer";
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
  s3ChunkKey: string;
  sourceKey?: string;
  modality: "image" | "text";
  mimeType?: string;
  text?: string;
  chunkPreview?: string;
}

interface EmbeddingWork {
  attempt: number;
  imageBase64?: string;
  imageFormat?: "gif" | "jpeg" | "png" | "webp";
  messageId: string;
  metadata: ChunkMetadata;
  text?: string;
}

/** Embed stage entry, called by the pipeline router with embed records. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const chunks: Array<{
    documentId: string;
    s3ChunkKey: string;
    messageId: string;
    attempt: number;
  }> = [];
  const failedMessageIds = new Set<string>();

  for (const record of event.Records) {
    let body: { documentId?: string; s3ChunkKey?: string };
    try {
      body = JSON.parse(record.body);
    } catch {
      console.error("[embed] Invalid JSON in record:", record.messageId);
      failedMessageIds.add(record.messageId);
      continue;
    }
    const { documentId, s3ChunkKey } = body;
    if (!documentId || !s3ChunkKey) {
      console.error("[embed] Missing required fields:", record.messageId);
      failedMessageIds.add(record.messageId);
      continue;
    }
    chunks.push({
      documentId: documentId,
      s3ChunkKey: s3ChunkKey,
      messageId: record.messageId,
      attempt: parseInt(record.attributes.ApproximateReceiveCount ?? "1", 10),
    });
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

/** Embeds one batch of chunks, writes their vectors and marks them embedded.
 * Returns the per-message failures for the handler to record. */
async function batchProcess(
  batch: Array<{
    documentId: string;
    s3ChunkKey: string;
    messageId: string;
    attempt: number;
  }>,
): Promise<
  Map<string, { attempt: number; documentId: string; error: unknown }>
> {
  const owners = new Map<string, string>();
  const reconcileDocuments = new Set<string>();
  const failures = new Map<
    string,
    { attempt: number; documentId: string; error: unknown }
  >();

  const loaded = await Promise.all(
    batch.map(async (chunk): Promise<EmbeddingWork | undefined> => {
      try {
        const resp = await s3.send(
          new GetObjectCommand({
            Bucket: StorageBucketName,
            Key: chunk.s3ChunkKey,
          }),
        );
        const chunkData = JSON.parse(await resp.Body!.transformToString());
        let userId: string | undefined =
          chunkData.userId ?? owners.get(chunk.documentId);
        if (!userId) {
          const doc = await getDocument(
            chunk.documentId,
            dynamo,
            TableName,
            false,
          );
          userId = doc?.userId;
          if (!userId) throw new Error("Document owner is missing");
          owners.set(chunk.documentId, userId);
        }
        const modality = chunkData.modality === "image" ? "image" : "text";
        const text = typeof chunkData.text === "string" ? chunkData.text : "";
        if (modality === "text" && !text.trim()) return undefined;
        const tokenCount =
          modality === "text"
            ? typeof chunkData.tokenCount === "number" &&
              chunkData.tokenCount > 0
              ? chunkData.tokenCount
              : encode(text, { disallowedSpecial: new Set() }).length
            : undefined;
        const metadata: ChunkMetadata = {
          documentId: chunk.documentId,
          userId: userId,
          chunkId: chunkData.chunkId,
          modality: modality,
          ...(tokenCount ? { tokenCount: tokenCount } : {}),
          ...(chunkData.title ? { title: chunkData.title } : {}),
          ...(chunkData.tags ? { tags: chunkData.tags } : {}),
          ...(chunkData.authors ? { authors: chunkData.authors } : {}),
          ...(chunkData.year ? { year: chunkData.year } : {}),
          ...(chunkData.mimeType ? { mimeType: chunkData.mimeType } : {}),
          ...(chunkData.sourceKey ? { sourceKey: chunkData.sourceKey } : {}),
          pageStart: chunkData.pageStart,
          pageEnd: chunkData.pageEnd,
          s3ChunkKey: chunk.s3ChunkKey,
        };

        // A duplicate message for an embedded chunk must not be embedded and
        // billed again, whichever delivery it is.
        const existing = await dynamo.send(
          new GetCommand({
            TableName: TableName,
            Key: {
              pk: `DOC#${chunk.documentId}`,
              sk: `CHUNK#${metadata.chunkId}`,
            },
            ConsistentRead: true,
          }),
        );
        if (existing.Item?.status === "EMBEDDED") {
          reconcileDocuments.add(chunk.documentId);
          return undefined;
        }
        // Two deliveries can both pass the read above, so only the one that
        // claims the chunk calls Bedrock; the other is dropped.
        if (
          existing.Item &&
          !(await claimChunk(chunk.documentId, metadata.chunkId))
        ) {
          console.log(
            `[embed] ${metadata.chunkId} is claimed by another delivery, dropping`,
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
            imageBase64: Buffer.from(imageBytes).toString("base64"),
            imageFormat: imageFormat(metadata.mimeType),
            messageId: chunk.messageId,
            metadata: metadata,
            text: buildImageDescription(metadata),
          };
        }

        return {
          attempt: chunk.attempt,
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
    data: number[];
    key: string;
    messageId: string;
    metadata: ChunkMetadata;
  }> = [];
  for (const item of workItems) {
    const meta = item.metadata;
    const preview = item.text ?? "";
    const embedding = embeddingsByChunk.get(meta.chunkId);
    if (!embedding) continue;
    vectorBatch.push({
      key: meta.chunkId,
      data: embedding,
      attempt: item.attempt,
      messageId: item.messageId,
      metadata: {
        ...fitFilterableMetadata({
          ...meta,
          embeddingModel: embeddingModel(),
        }),
        text: preview.substring(0, 500),
        chunkPreview: preview.substring(0, 200),
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

  for (const vector of writtenVectors) {
    await markChunkEmbedded(vector.metadata.documentId, vector.key);
    writtenDocuments.add(vector.metadata.documentId);
  }
  await Promise.all(
    Array.from(writtenDocuments, (documentId) => markEmbedded(documentId)),
  );
  console.log(`[embed] OK: ${writtenVectors.length} vectors written`);

  return failures;
}

/** Claims a chunk for this delivery, or returns false when another delivery holds a
 * live claim or the chunk is already embedded. */
async function claimChunk(
  documentId: string,
  chunkId: string,
): Promise<boolean> {
  const now = Date.now();
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: `CHUNK#${chunkId}` },
        UpdateExpression: "SET embedClaimedAt = :now",
        ConditionExpression:
          "attribute_exists(pk) AND #s <> :embedded AND (attribute_not_exists(embedClaimedAt) OR embedClaimedAt < :expired)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":embedded": "EMBEDDED",
          ":expired": now - EMBED_CLAIM_LEASE_MS,
          ":now": now,
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
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

/** Marks a chunk EMBEDDED and bumps the document count in one transaction.
 * A chunk already embedded is left alone; one whose document is gone loses its vector. */
async function markChunkEmbedded(
  documentId: string,
  chunkId: string,
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
                "attribute_exists(pk) AND (attribute_not_exists(#s) OR #s <> :embedded)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":embedded": "EMBEDDED" },
            },
          },
          {
            Update: {
              TableName: TableName,
              Key: { pk: `DOC#${documentId}`, sk: "META" },
              UpdateExpression:
                "SET #s = :embedding, embeddedCount = if_not_exists(embeddedCount, :zero) + :one",
              ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
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
    // Delete marks META as DELETING before it removes vectors, so a vector
    // written after that point is removed here instead of staying searchable.
    const doc = await getDocument(documentId, dynamo, TableName);
    if (!doc || doc.status === "DELETING") {
      await vectors.send(
        new DeleteVectorsCommand({
          vectorBucketName: VectorBucketName,
          indexName: VectorIndexName,
          keys: [chunkId],
        }),
      );
      return;
    }
    const existing = await dynamo.send(
      new GetCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: `CHUNK#${chunkId}` },
        ConsistentRead: true,
      }),
    );
    if (existing.Item?.status === "EMBEDDED") return;
    throw err;
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

/** Groups items into Cohere requests by owner, item count and request size.
 * A request's size is its empty body plus each input and the comma between inputs. */
function packEmbeddingBatches(items: EmbeddingWork[]): EmbeddingWork[][] {
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
