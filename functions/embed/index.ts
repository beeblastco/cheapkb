import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PutVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { Resource } from "sst";

const s3 = new S3Client({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const vectors = new S3VectorsClient({});
const TableName = Resource.Meta.name;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;
const VECTOR_BATCH = process.env.VECTOR_BATCH
  ? parseInt(process.env.VECTOR_BATCH)
  : 100;
const EMBED_BATCH = process.env.EMBED_BATCH
  ? parseInt(process.env.EMBED_BATCH)
  : 25;

export async function handler(event: any) {
  for (const record of event.Records ?? []) {
    let body: any;
    try {
      body = JSON.parse(record.body);
    } catch {
      console.error("[embed] Invalid JSON in record:", record.messageId);
      throw new Error("Invalid JSON in SQS record");
    }
    const { documentId, chunkKeys } = body;
    try {
      await embedDocument(documentId, chunkKeys);
    } catch (err) {
      console.error(`[embed] Failed for ${documentId}:`, err);
      await updateStatus(documentId, "FAILED");
      throw err;
    }
  }
}

async function embedDocument(documentId: string, chunkKeys: string[]) {
  console.log(`[embed] Embedding ${chunkKeys.length} chunks for ${documentId}`);
  await updateStatus(documentId, "EMBEDDING");

  const chunks: Array<{ chunkId: string; text: string; metadata: any }> = [];
  for (const key of chunkKeys) {
    const resp = await s3.send(
      new GetObjectCommand({ Bucket: Resource.Storage.name, Key: key }),
    );
    const data = JSON.parse(await resp.Body!.transformToString());
    chunks.push({
      chunkId: data.chunkId,
      text: data.text,
      metadata: {
        documentId: data.documentId,
        chunkId: data.chunkId,
        title: data.metadata?.title ?? "",
        year: data.metadata?.year ?? null,
        tags: data.metadata?.tags ?? [],
        authors: data.metadata?.authors ?? [],
        pageStart: data.pageStart,
        pageEnd: data.pageEnd,
        s3ChunkKey: key,
      },
    });
  }

  const texts = chunks.map((c) => c.text);
  const embeddings = await getEmbeddings(texts);

  const entries = chunks.map((chunk, i) => ({
    key: chunk.chunkId,
    data: { float32: Array.from(embeddings[i]) },
    metadata: sanitizeMetadata({
      ...chunk.metadata,
      text: chunk.text.substring(0, 200),
      chunkPreview: chunk.text.substring(0, 100),
    }),
  }));

  let successCount = 0;
  for (let i = 0; i < entries.length; i += VECTOR_BATCH) {
    const batch = entries.slice(i, i + VECTOR_BATCH);
    try {
      await vectors.send(
        new PutVectorsCommand({
          vectorBucketName: VectorBucketName,
          indexName: VectorIndexName,
          vectors: batch,
        }),
      );
      successCount += batch.length;
    } catch (err: any) {
      console.error(
        `[embed] batch ${i}-${i + batch.length} failed:`,
        err.message,
      );
      for (const entry of batch) {
        try {
          await vectors.send(
            new PutVectorsCommand({
              vectorBucketName: VectorBucketName,
              indexName: VectorIndexName,
              vectors: [entry],
            }),
          );
          successCount++;
        } catch (singleErr: any) {
          console.error(`[embed] ${entry.key} failed:`, singleErr.message);
        }
      }
    }
  }
  if (successCount === 0) {
    throw new Error(
      `All ${entries.length} vector writes failed for ${documentId}`,
    );
  }

  for (const chunk of chunks) {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: {
          pk: `DOC#${documentId}`,
          sk: `CHUNK#${chunk.chunkId.split("#")[1]}`,
        },
        UpdateExpression: "SET #s = :s, updatedAt = :t",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "EMBEDDED",
          ":t": new Date().toISOString(),
        },
      }),
    );
  }

  await updateStatus(documentId, "EMBEDDED");
  console.log(
    `[embed] Done: ${chunks.length} vectors written for ${documentId}`,
  );
}

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const providerUrl = process.env.EMBEDDING_PROVIDER_URL;
  const model = process.env.EMBEDDING_MODEL;
  if (!providerUrl) {
    throw new Error("EMBEDDING_PROVIDER_URL not set");
  }
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const resp = await fetch(`${providerUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.EMBEDDING_API_KEY}`,
      },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Embedding provider error ${resp.status}: ${errText}`);
    }
    const data = (await resp.json()) as {
      data: Array<{ embedding: number[]; index?: number }>;
    };
    const sorted = data.data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    all.push(...sorted.map((d) => d.embedding));
  }
  return all;
}

function sanitizeMetadata(meta: Record<string, any>): Record<string, any> {
  const MAX = 1800;
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const arr = value.filter((v) => v !== null && v !== undefined);
      if (arr.length > 0) clean[key] = arr;
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      clean[key] = value;
    } else {
      clean[key] = String(value);
    }
  }
  if (JSON.stringify(clean).length > MAX) {
    const strings = Object.entries(clean)
      .filter(([, v]) => typeof v === "string" && v.length > 50)
      .sort((a, b) => (b[1] as string).length - (a[1] as string).length);
    for (const [key, val] of strings) {
      if (JSON.stringify(clean).length <= MAX) break;
      const excess = JSON.stringify(clean).length - MAX;
      const newLen = Math.max(50, (val as string).length - excess - 10);
      clean[key] = (val as string).substring(0, newLen) + "...";
    }
    if (JSON.stringify(clean).length > MAX) {
      const arrays = Object.entries(clean)
        .filter(([, v]) => Array.isArray(v))
        .sort(
          (a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length,
        );
      for (const [key, val] of arrays) {
        if (JSON.stringify(clean).length <= MAX) break;
        clean[key] = (val as any[]).slice(
          0,
          Math.max(1, Math.floor((val as any[]).length / 2)),
        );
      }
    }
  }
  return clean;
}

async function updateStatus(documentId: string, status: string) {
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": status,
        ":t": now,
        ":gsi1pk": `STATUS#${status}`,
        ":gsi1sk": now,
      },
    }),
  );
}
