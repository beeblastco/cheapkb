import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = Resource.Meta.name;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;

export async function handler(event: any) {
  const records = event.Records ?? [];
  const chunks: Array<{ documentId: string; s3ChunkKey: string }> = [];

  for (const record of records) {
    let body: any;
    try {
      body = JSON.parse(record.body);
    } catch {
      console.error("[embed] Invalid JSON in record:", record.messageId);
      continue;
    }
    const { documentId, s3ChunkKey } = body;
    if (!documentId || !s3ChunkKey) {
      console.error("[embed] Missing required fields:", record.messageId);
      continue;
    }
    chunks.push({ documentId, s3ChunkKey });
  }

  if (chunks.length === 0) return;

  const batchSize = parseInt(process.env.EMBED_BATCH ?? "25");
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    try {
      await processBatch(batch);
    } catch (err: any) {
      console.error(`[embed] Batch failed:`, err);
      for (const chunk of batch) {
        await handleError(chunk.documentId, err);
      }
    }
  }
}

async function processBatch(
  batch: Array<{ documentId: string; s3ChunkKey: string }>,
) {
  const texts: string[] = [];
  const metadata: any[] = [];

  for (const chunk of batch) {
    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: Resource.Storage.name,
        Key: chunk.s3ChunkKey,
      }),
    );
    const chunkData = JSON.parse(await resp.Body!.transformToString());
    if (!chunkData.text) {
      texts.push("");
      metadata.push({ documentId: chunk.documentId, skipped: true });
      continue;
    }
    texts.push(chunkData.text);
    metadata.push({
      documentId: chunk.documentId,
      chunkId: chunkData.chunkId,
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

  const docIds = [...new Set(batch.map((c) => c.documentId))];
  for (const documentId of docIds) {
    await markEmbedded(documentId);
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
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Embedding provider error ${resp.status}: ${errText}`);
  }
  const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => d.embedding);
}

async function markEmbedded(documentId: string) {
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, embeddedCount = if_not_exists(embeddedCount, :z) + :one, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "EMBEDDING",
        ":t": now,
        ":z": 0,
        ":one": 1,
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
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :s, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "EMBEDDED",
          ":t": now,
          ":gsi1pk": "STATUS#EMBEDDED",
          ":gsi1sk": now,
        },
      }),
    );
    await clearError(documentId, now);
  }
}

async function handleError(documentId: string, err: any) {
  const now = new Date().toISOString();
  const result = await dynamo.send(
    new GetCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  const doc = result.Item;
  const retryCount = (doc?.retryCount ?? 0) + 1;
  const lastError = err.message ?? String(err);

  if (retryCount >= 3) {
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
          ":r": retryCount,
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
        ":r": retryCount,
        ":f": "EMBEDDING",
        ":t": now,
      },
    }),
  );
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
