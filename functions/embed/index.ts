import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { encode } from "gpt-tokenizer";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { recordUsage } from "../billing/utils";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const chunks: Array<{
    documentId: string;
    s3ChunkKey: string;
    messageId: string;
    attempt: number;
  }> = [];
  const failedMessageIds = new Set<string>();

  for (const record of event.Records) {
    let body: any;
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

  const batchSize = parseInt(process.env.EMBED_BATCH ?? "25");
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    try {
      await processBatch(batch);
    } catch (err: any) {
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

async function processBatch(
  batch: Array<{
    documentId: string;
    s3ChunkKey: string;
    messageId: string;
    attempt: number;
  }>,
) {
  const texts: string[] = [];
  const metadata: any[] = [];
  const owners = new Map<string, string>();

  for (const chunk of batch) {
    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: StorageBucketName,
        Key: chunk.s3ChunkKey,
      }),
    );
    const chunkData = JSON.parse(await resp.Body!.transformToString());
    let userId = chunkData.userId ?? owners.get(chunk.documentId);
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
    if (!chunkData.text) {
      texts.push("");
      metadata.push({ documentId: chunk.documentId, skipped: true });
      continue;
    }
    texts.push(chunkData.text);
    const tokenCount =
      typeof chunkData.tokenCount === "number" && chunkData.tokenCount > 0
        ? chunkData.tokenCount
        : encode(chunkData.text ?? "").length;
    metadata.push({
      documentId: chunk.documentId,
      userId,
      chunkId: chunkData.chunkId,
      tokenCount,
      ...(chunkData.title ? { title: chunkData.title } : {}),
      ...(chunkData.tags ? { tags: chunkData.tags } : {}),
      ...(chunkData.authors ? { authors: chunkData.authors } : {}),
      ...(chunkData.year ? { year: chunkData.year } : {}),
      pageStart: chunkData.pageStart,
      pageEnd: chunkData.pageEnd,
      s3ChunkKey: chunk.s3ChunkKey,
    });
  }

  const embeddings = await embedBatch(texts);

  const vectorBatch: Array<{ key: string; data: number[]; metadata: any }> = [];
  for (let i = 0; i < embeddings.length; i++) {
    if (metadata[i].skipped) continue;
    vectorBatch.push({
      key: metadata[i].chunkId,
      data: embeddings[i],
      metadata: {
        ...metadata[i],
        text: texts[i].substring(0, 500),
        chunkPreview: texts[i].substring(0, 200),
      },
    });
  }

  if (vectorBatch.length === 0) return;

  const vectorBatchSize = parseInt(process.env.VECTOR_BATCH ?? "500");
  for (let i = 0; i < vectorBatch.length; i += vectorBatchSize) {
    const chunk = vectorBatch.slice(i, i + vectorBatchSize);
    await vectors.send(
      new PutVectorsCommand({
        vectorBucketName: VectorBucketName,
        indexName: VectorIndexName,
        vectors: chunk.map((v) => ({
          key: v.key,
          data: { float32: v.data },
          metadata: v.metadata,
        })),
      }),
    );
  }

  const docCounts: Record<string, number> = {};
  const usageByUser: Record<string, number> = {};
  for (const vector of vectorBatch) {
    const changed = await markChunkEmbedded(
      vector.metadata.documentId,
      vector.metadata.chunkId,
    );
    if (changed) {
      docCounts[vector.metadata.documentId] =
        (docCounts[vector.metadata.documentId] ?? 0) + 1;
      const userId = vector.metadata.userId as string;
      const tokens = (vector.metadata.tokenCount as number) ?? 0;
      usageByUser[userId] = (usageByUser[userId] ?? 0) + tokens;
    }
  }
  for (const [documentId, count] of Object.entries(docCounts)) {
    await markEmbedded(documentId, count);
  }
  for (const [userId, count] of Object.entries(usageByUser)) {
    await recordUsage(userId, TableName, "embed", count);
  }

  console.log(`[embed] OK: ${vectorBatch.length} vectors written`);
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const providerUrl = process.env.EMBEDDING_PROVIDER_URL;
  const model = process.env.EMBEDDING_MODEL;
  if (!providerUrl) throw new Error("EMBEDDING_PROVIDER_URL not set");

  const resp = await fetch(`${providerUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(240000),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(
      `Embedding provider error ${resp.status}: ${errText.slice(0, 1000)}`,
    );
  }
  const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => d.embedding);
}

async function markEmbedded(documentId: string, count: number) {
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, embeddedCount = if_not_exists(embeddedCount, :z) + :inc, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "EMBEDDING",
        ":t": now,
        ":z": 0,
        ":inc": count,
        ":gsi1pk": "STATUS#EMBEDDING",
        ":gsi1sk": now,
      },
    }),
  );

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
      await clearError(documentId, now);
    } catch (err: any) {
      if (err.name !== "ConditionalCheckFailedException") {
        throw err;
      }
    }
  }
}

async function handleError(documentId: string, err: any, attempt: number) {
  const now = new Date().toISOString();
  const lastError = err.message ?? String(err);

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

async function markChunkEmbedded(
  documentId: string,
  chunkId: string,
): Promise<boolean> {
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: `CHUNK#${chunkId}` },
        UpdateExpression: "SET #s = :embedded",
        ConditionExpression: "attribute_not_exists(#s) OR #s <> :embedded",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":embedded": "EMBEDDED" },
      }),
    );
    return true;
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
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
