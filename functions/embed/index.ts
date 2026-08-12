import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { DocumentType } from "@smithy/types";
import { encode } from "gpt-tokenizer";
import { recordUsage } from "../utils";

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
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;
const COHERE_EMBEDDING_MODEL = "us.cohere.embed-v4:0";
const MAX_COHERE_ITEMS = 96;
const MAX_COHERE_REQUEST_BYTES = 19 * 1024 * 1024;

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

interface CohereEmbeddingResponse {
  embeddings: number[][] | { float?: number[][] };
}

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
      documentId,
      s3ChunkKey,
      messageId: record.messageId,
      attempt: parseInt(record.attributes.ApproximateReceiveCount ?? "1", 10),
    });
  }

  if (chunks.length === 0) {
    return {
      batchItemFailures: Array.from(failedMessageIds).map((itemIdentifier) => ({
        itemIdentifier,
      })),
    };
  }

  const batchSize = Math.max(1, parseInt(process.env.EMBED_BATCH ?? "10", 10));
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    try {
      const failures = await batchProcess(batch);
      const documents = new Map<string, { attempt: number; error: unknown }>();
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
      for (const [documentId, failure] of documents) {
        await handleError(documentId, failure.error, failure.attempt);
      }
    } catch (err) {
      console.error(`[embed] Batch failed:`, err);
      const attempts = new Map<string, number>();
      for (const chunk of batch) {
        failedMessageIds.add(chunk.messageId);
        attempts.set(
          chunk.documentId,
          Math.max(attempts.get(chunk.documentId) ?? 1, chunk.attempt),
        );
      }
      for (const [documentId, attempt] of attempts) {
        await handleError(documentId, err, attempt);
      }
    }
  }
  return {
    batchItemFailures: Array.from(failedMessageIds).map((itemIdentifier) => ({
      itemIdentifier,
    })),
  };
}

async function batchProcess(
  batch: Array<{
    documentId: string;
    s3ChunkKey: string;
    messageId: string;
    attempt: number;
  }>,
) {
  const workItems: EmbeddingWork[] = [];
  const owners = new Map<string, string>();
  const reconcileDocuments = new Set<string>();
  const failures = new Map<
    string,
    { attempt: number; documentId: string; error: unknown }
  >();

  for (const chunk of batch) {
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
        const result = await dynamo.send(
          new GetCommand({
            TableName,
            Key: { pk: `DOC#${chunk.documentId}`, sk: "META" },
          }),
        );
        userId = result.Item?.userId;
        if (!userId) throw new Error("Document owner is missing");
        owners.set(chunk.documentId, userId);
      }
      const modality = chunkData.modality === "image" ? "image" : "text";
      const text = typeof chunkData.text === "string" ? chunkData.text : "";
      if (modality === "text" && !text.trim()) continue;
      const tokenCount =
        modality === "text"
          ? typeof chunkData.tokenCount === "number" && chunkData.tokenCount > 0
            ? chunkData.tokenCount
            : encode(text).length
          : undefined;
      const metadata: ChunkMetadata = {
        documentId: chunk.documentId,
        userId,
        chunkId: chunkData.chunkId,
        modality,
        ...(tokenCount ? { tokenCount } : {}),
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

      if (chunk.attempt > 1) {
        const existing = await dynamo.send(
          new GetCommand({
            TableName,
            Key: {
              pk: `DOC#${chunk.documentId}`,
              sk: `CHUNK#${metadata.chunkId}`,
            },
            ConsistentRead: true,
          }),
        );
        if (existing.Item?.status === "EMBEDDED") {
          reconcileDocuments.add(chunk.documentId);
          continue;
        }
      }

      if (modality === "image") {
        if (!metadata.sourceKey || !metadata.mimeType) {
          throw new Error("Image chunk is missing its source key or MIME type");
        }
        const image = await s3.send(
          new GetObjectCommand({
            Bucket: StorageBucketName,
            Key: metadata.sourceKey,
          }),
        );
        const imageBytes = await image.Body!.transformToByteArray();
        const maxImageBytes = Math.min(
          parseInt(process.env.MAX_IMAGE_UPLOAD_BYTES ?? "5242880", 10),
          5 * 1024 * 1024,
        );
        if (imageBytes.byteLength > maxImageBytes) {
          throw new Error(
            "Image exceeds the configured Cohere embedding limit",
          );
        }
        workItems.push({
          attempt: chunk.attempt,
          imageBase64: Buffer.from(imageBytes).toString("base64"),
          imageFormat: imageFormat(metadata.mimeType),
          messageId: chunk.messageId,
          metadata,
          text: buildImageDescription(metadata),
        });
        continue;
      }

      workItems.push({
        attempt: chunk.attempt,
        messageId: chunk.messageId,
        metadata,
        text,
      });
    } catch (error) {
      failures.set(chunk.messageId, {
        attempt: chunk.attempt,
        documentId: chunk.documentId,
        error,
      });
    }
  }

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
        ...meta,
        embeddingModel: embeddingModel(),
        text: preview.substring(0, 500),
        chunkPreview: preview.substring(0, 200),
      },
    });
  }

  const writtenDocuments = new Set(reconcileDocuments);
  if (vectorBatch.length === 0) {
    for (const documentId of writtenDocuments) {
      await markEmbedded(documentId);
    }
    return failures;
  }

  const vectorBatchSize = parseInt(process.env.VECTOR_BATCH ?? "500");
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
          error,
        });
      }
    }
  }

  for (const vector of writtenVectors) {
    const meta = vector.metadata;
    if (!meta.documentId || !meta.chunkId || !meta.userId) continue;
    await markChunkEmbedded(meta.documentId, meta.chunkId);
    writtenDocuments.add(meta.documentId);
  }
  for (const documentId of writtenDocuments) {
    await markEmbedded(documentId);
  }
  console.log(`[embed] OK: ${writtenVectors.length} vectors written`);
  return failures;
}

async function clearError(documentId: string, now: string) {
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET lastError = :null, retryCount = :zero, failedStep = :null, updatedAt = :t",
      ExpressionAttributeValues: {
        ":null": null,
        ":zero": 0,
        ":t": now,
      },
    }),
  );
}

async function embedItems(
  items: EmbeddingWork[],
  embeddingsByChunk: Map<string, number[]>,
  failures: Map<
    string,
    { attempt: number; documentId: string; error: unknown }
  >,
) {
  try {
    const hasImage = items.some((item) => item.imageBase64);
    const hasText = items.some((item) => !item.imageBase64);
    const modality =
      hasImage && hasText ? "mixed" : hasImage ? "image" : "text";
    const embeddings = await invokeBedrock(
      buildEmbeddingRequest(items, "search_document"),
      items[0].metadata.userId,
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
    const item = items[0];
    failures.set(item.messageId, {
      attempt: item.attempt,
      documentId: item.metadata.documentId,
      error,
    });
  }
}

async function handleError(documentId: string, err: unknown, attempt: number) {
  const now = new Date().toISOString();
  const lastError = (err as Error).message ?? String(err);

  if (attempt >= 3) {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :s, lastError = :e, retryCount = :r, failedStep = :f, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "FAILED",
          ":e": lastError,
          ":r": attempt,
          ":f": "EMBEDDING",
          ":t": now,
          ":gsi1pk": "STATUS#FAILED",
          ":gsi1sk": now,
        },
      }),
    );
    return;
  }

  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET lastError = :e, retryCount = :r, failedStep = :f, updatedAt = :t",
      ExpressionAttributeValues: {
        ":e": lastError,
        ":r": attempt,
        ":f": "EMBEDDING",
        ":t": now,
      },
    }),
  );
}

async function invokeBedrock(
  body: Record<string, unknown>,
  userId: string,
  modality: "image" | "mixed" | "text",
): Promise<number[][]> {
  let responseInputTokenCount: number | undefined;
  const command = new InvokeModelCommand({
    modelId: embeddingModel(),
    contentType: "application/json",
    accept: "application/json",
    requestMetadata: JSON.stringify({
      cheapkbEmbeddingModel: embeddingModel(),
      cheapkbInputModality: modality,
      cheapkbOperation: "ingest",
      cheapkbStage: process.env.DEPLOYMENT_STAGE ?? "unknown",
      cheapkbUsageCategory: "embed",
      cheapkbUserId: userId,
    }),
    trace: "ENABLED",
    body: JSON.stringify(body),
  });
  command.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      const headers = (
        result as typeof result & {
          response?: { headers?: Record<string, string> };
        }
      ).response?.headers;
      const tokenHeader = headers?.["x-amzn-bedrock-input-token-count"];
      const parsed = tokenHeader ? Number.parseInt(tokenHeader, 10) : NaN;
      responseInputTokenCount =
        Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
      return result;
    },
    {
      name: "captureBedrockInputTokens",
      priority: "low",
      step: "deserialize",
    },
  );
  const response = await bedrock.send(command);
  const metadata = response.$metadata as typeof response.$metadata & {
    bedrockInputTokenCount?: number;
  };
  const inputTokenCount =
    responseInputTokenCount ?? metadata.bedrockInputTokenCount;
  if (inputTokenCount) {
    await recordUsage(
      userId,
      process.env.ACCOUNTS_TABLE_NAME!,
      "embed",
      inputTokenCount,
    );
  } else {
    console.warn("[embed] Bedrock response omitted its input token count", {
      requestId: response.$metadata.requestId,
    });
  }
  const payload = JSON.parse(
    new TextDecoder().decode(response.body),
  ) as CohereEmbeddingResponse;
  const embeddings = Array.isArray(payload.embeddings)
    ? payload.embeddings
    : payload.embeddings?.float;
  const dimension = embeddingDimension();
  if (
    !embeddings?.length ||
    embeddings.some((embedding) => embedding.length !== dimension)
  ) {
    throw new Error(`Cohere Embed v4 returned an invalid ${dimension}D vector`);
  }
  return embeddings;
}

async function markChunkEmbedded(
  documentId: string,
  chunkId: string,
): Promise<boolean> {
  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName,
              Key: { pk: `DOC#${documentId}`, sk: `CHUNK#${chunkId}` },
              UpdateExpression: "SET #s = :embedded",
              ConditionExpression:
                "attribute_not_exists(#s) OR #s <> :embedded",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":embedded": "EMBEDDED" },
            },
          },
          {
            Update: {
              TableName,
              Key: { pk: `DOC#${documentId}`, sk: "META" },
              UpdateExpression:
                "SET #s = :embedding, embeddedCount = if_not_exists(embeddedCount, :zero) + :one",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":embedding": "EMBEDDING",
                ":one": 1,
                ":zero": 0,
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if ((err as Error).name !== "TransactionCanceledException") throw err;
    const existing = await dynamo.send(
      new GetCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: `CHUNK#${chunkId}` },
        ConsistentRead: true,
      }),
    );
    if (existing.Item?.status === "EMBEDDED") return false;
    throw err;
  }
}

async function markEmbedded(documentId: string) {
  const now = new Date().toISOString();
  const result = await dynamo.send(
    new GetCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  const doc = result.Item;
  const expected = doc?.chunkCount ?? 0;
  const done = doc?.embeddedCount ?? 0;
  if (expected > 0 && done >= expected) {
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName,
          Key: { pk: `DOC#${documentId}`, sk: "META" },
          UpdateExpression:
            "SET #s = :s, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
          ConditionExpression:
            "attribute_exists(pk) AND embeddedCount >= :expected AND #s <> :s",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": "EMBEDDED",
            ":t": now,
            ":expected": expected,
            ":gsi1pk": "STATUS#EMBEDDED",
            ":gsi1sk": now,
          },
        }),
      );
    } catch (err) {
      if ((err as Error).name !== "ConditionalCheckFailedException") {
        throw err;
      }
    }
    await clearError(documentId, now);
  }
}

function buildEmbeddingRequest(
  items: EmbeddingWork[],
  inputType: "search_document" | "search_query",
) {
  return {
    input_type: inputType,
    inputs: items.map((item) => {
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
      return { content };
    }),
    embedding_types: ["float"],
    output_dimension: embeddingDimension(),
    max_tokens: 128000,
    truncate: "RIGHT",
  };
}

function buildImageDescription(metadata: ChunkMetadata) {
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

function embeddingDimension() {
  return parseInt(process.env.EMBEDDING_DIMENSION ?? "1024", 10);
}

function embeddingModel() {
  return process.env.BEDROCK_EMBEDDING_MODEL ?? COHERE_EMBEDDING_MODEL;
}

function imageFormat(mimeType: string): "gif" | "jpeg" | "png" | "webp" {
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/jpeg") return "jpeg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  throw new Error(`Unsupported image MIME type: ${mimeType}`);
}

function packEmbeddingBatches(items: EmbeddingWork[]): EmbeddingWork[][] {
  const batches: EmbeddingWork[][] = [];
  let current: EmbeddingWork[] = [];

  for (const item of items) {
    const candidate = [...current, item];
    const differentOwner =
      current.length > 0 && current[0].metadata.userId !== item.metadata.userId;
    const requestBytes = Buffer.byteLength(
      JSON.stringify(buildEmbeddingRequest(candidate, "search_document")),
    );
    if (
      current.length > 0 &&
      (differentOwner ||
        candidate.length > MAX_COHERE_ITEMS ||
        requestBytes > MAX_COHERE_REQUEST_BYTES)
    ) {
      batches.push(current);
      current = [item];
    } else {
      current = candidate;
    }
    const currentBytes = Buffer.byteLength(
      JSON.stringify(buildEmbeddingRequest(current, "search_document")),
    );
    if (currentBytes > MAX_COHERE_REQUEST_BYTES) {
      throw new Error("One Cohere embedding input exceeds the request limit");
    }
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
