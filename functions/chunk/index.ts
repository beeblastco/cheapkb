import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { decode, encode } from "gpt-tokenizer";
import { ContentError } from "../utils";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const PipelineQueueUrl = process.env.PIPELINE_QUEUE_URL!;
const CHUNK_WRITE_CONCURRENCY = 10;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    let body: { documentId?: string; parsedKey?: string; sweeps?: number };
    try {
      body = JSON.parse(record.body);
    } catch {
      console.error("[chunk] Invalid JSON in record:", record.messageId);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    const { documentId, parsedKey } = body;
    if (!documentId || !parsedKey) {
      console.error("[chunk] Missing required fields:", record.messageId);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    // A message the sweeper re-queued starts a new receive count, but it is
    // still a redelivery.
    const attempt = Math.max(
      parseInt(record.attributes.ApproximateReceiveCount ?? "1", 10),
      body.sweeps ? 2 : 1,
    );
    try {
      await chunkDocument(documentId, parsedKey, attempt);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        console.log(`[chunk] Document ${documentId} was deleted, dropping`);
        continue;
      }
      console.error(`[chunk] Failed for ${documentId}:`, err);
      if (err instanceof ContentError) {
        await handleError(documentId, err, 3);
        continue;
      }
      await handleError(documentId, err, attempt);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

async function chunkDocument(
  documentId: string,
  parsedKey: string,
  attempt: number,
) {
  const now = new Date().toISOString();
  await updateStatus(documentId, "CHUNKING", now);

  const docResult = await dynamo.send(
    new GetCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  const doc = docResult.Item ?? {};
  const title = doc.title ?? null;
  const tags = doc.tags ?? null;
  const authors = doc.authors ?? null;
  const year = doc.year ?? null;
  const sourceKey = doc.sourceKey;
  const mimeType = doc.mimeType;
  const userId = doc.userId;
  if (!userId) throw new Error("Document owner is missing");

  const resp = await s3.send(
    new GetObjectCommand({ Bucket: StorageBucketName, Key: parsedKey }),
  );
  const parsed = JSON.parse(await resp.Body!.transformToString());
  if (parsed.modality === "image") {
    const chunkId = `image_${documentId}_0`;
    const s3ChunkKey = `chunks/${documentId}/${chunkId}.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: StorageBucketName,
        Key: s3ChunkKey,
        Body: JSON.stringify({
          documentId,
          userId,
          chunkId,
          modality: "image",
          sourceKey: parsed.sourceKey ?? sourceKey,
          mimeType: parsed.mimeType ?? mimeType,
          title,
          tags,
          authors,
          year,
          pageStart: 1,
          pageEnd: 1,
        }),
        ContentType: "application/json",
      }),
    );
    const queued = await putChunkRecord(
      {
        pk: `DOC#${documentId}`,
        sk: `CHUNK#${chunkId}`,
        chunkId,
        s3ChunkKey,
        pageStart: 1,
        pageEnd: 1,
        status: "QUEUED",
        createdAt: now,
      },
      attempt,
    );
    await finishChunking(documentId, 1, queued ? [s3ChunkKey] : [], now);
    console.log(`[chunk] OK: ${documentId} - image -> ${s3ChunkKey}`);
    return;
  }
  const pages: Array<{ pageNumber: number; text: string }> = parsed.pages;

  const maxTokens = parseInt(process.env.CHUNK_MAX_TOKENS ?? "700");
  const overlapTokens = parseInt(process.env.CHUNK_OVERLAP_TOKENS ?? "100");
  const maxChunks = parseInt(process.env.MAX_CHUNKS_PER_DOCUMENT ?? "1000");

  const chunks = splitIntoChunks(pages, maxTokens, overlapTokens, maxChunks);
  if (chunks.length === 0) {
    await updateStatus(documentId, "CHUNKED", now);
    await clearError(documentId, now);
    return;
  }

  // Chunks are written a few at a time so a 1,000-chunk document fits the
  // Lambda timeout.
  const chunkKeys: string[] = [];
  for (let start = 0; start < chunks.length; start += CHUNK_WRITE_CONCURRENCY) {
    const written = await Promise.all(
      chunks
        .slice(start, start + CHUNK_WRITE_CONCURRENCY)
        .map(async ({ chunk, i }) => {
          const chunkId = `chunk_${documentId}_${i}`;
          const s3ChunkKey = `chunks/${documentId}/${chunkId}.json`;
          const tokenCount = encode(chunk.text, {
            disallowedSpecial: new Set(),
          }).length;
          await s3.send(
            new PutObjectCommand({
              Bucket: StorageBucketName,
              Key: s3ChunkKey,
              Body: JSON.stringify({
                documentId,
                userId,
                chunkId,
                modality: "text",
                sourceKey,
                mimeType,
                text: chunk.text,
                tokenCount,
                title,
                tags,
                authors,
                year,
                pageStart: chunk.pageStart,
                pageEnd: chunk.pageEnd,
              }),
              ContentType: "application/json",
            }),
          );
          const queued = await putChunkRecord(
            {
              pk: `DOC#${documentId}`,
              sk: `CHUNK#${chunkId}`,
              chunkId,
              s3ChunkKey,
              pageStart: chunk.pageStart,
              pageEnd: chunk.pageEnd,
              tokenCount,
              status: "QUEUED",
              createdAt: now,
            },
            attempt,
          );
          return queued ? s3ChunkKey : null;
        }),
    );
    for (const key of written) if (key) chunkKeys.push(key);
  }

  await finishChunking(documentId, chunks.length, chunkKeys, now);

  console.log(
    `[chunk] OK: ${documentId} - ${chunks.length} chunks -> ${chunkKeys[0]}`,
  );
}

async function clearError(documentId: string, now: string) {
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET lastError = :null, retryCount = :zero, failedStep = :null, updatedAt = :t",
      ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":deleting": "DELETING",
        ":null": null,
        ":zero": 0,
        ":t": now,
      },
    }),
  );
}

async function finishChunking(
  documentId: string,
  chunkCount: number,
  chunkKeys: string[],
  now: string,
) {
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, chunkCount = :c, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":deleting": "DELETING",
        ":s": "CHUNKED",
        ":c": chunkCount,
        ":t": now,
        ":gsi1pk": "STATUS#CHUNKED",
        ":gsi1sk": now,
      },
    }),
  );
  await clearError(documentId, now);
  if (chunkKeys.length === 0) await markEmbeddedIfDone(documentId, chunkCount);

  const sendSize = 10;
  for (let i = 0; i < chunkKeys.length; i += sendSize) {
    const group = chunkKeys.slice(i, i + sendSize);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: PipelineQueueUrl,
        Entries: group.map((s3ChunkKey, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify({
            stage: "embed",
            documentId,
            s3ChunkKey,
          }),
        })),
      }),
    );
    if (response.Failed?.length) throw new Error("Failed to queue some chunks");
  }
}

// A deleted document has nothing left to record the error on.
async function handleError(documentId: string, err: unknown, attempt: number) {
  try {
    await writeError(documentId, err, attempt);
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}

// When a redelivered message finds every chunk already embedded, no embed step
// will run to finish the document, so it is finished here.
async function markEmbeddedIfDone(documentId: string, chunkCount: number) {
  const now = new Date().toISOString();
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :s, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :t",
        ConditionExpression:
          "attribute_exists(pk) AND embeddedCount >= :count AND #s <> :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":count": chunkCount,
          ":deleting": "DELETING",
          ":gsi1pk": "STATUS#EMBEDDED",
          ":s": "EMBEDDED",
          ":t": now,
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}

// A redelivered message keeps chunks that were already embedded, so they are not
// embedded and billed twice. A first delivery starts every chunk over.
async function putChunkRecord(
  item: Record<string, unknown>,
  attempt: number,
): Promise<boolean> {
  try {
    await dynamo.send(
      new PutCommand({
        TableName,
        Item: item,
        ...(attempt > 1
          ? {
              ConditionExpression:
                "attribute_not_exists(pk) OR #s <> :embedded",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":embedded": "EMBEDDED" },
            }
          : {}),
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

async function updateStatus(documentId: string, status: string, now: string) {
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":deleting": "DELETING",
        ":s": status,
        ":t": now,
        ":gsi1pk": `STATUS#${status}`,
        ":gsi1sk": now,
      },
    }),
  );
}

async function writeError(documentId: string, err: unknown, attempt: number) {
  const now = new Date().toISOString();
  // Raw SDK messages can name buckets and ARNs, so only content errors are shown.
  const lastError =
    err instanceof ContentError
      ? err.message
      : "Processing failed. Reindex to try again.";

  if (attempt >= 3) {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :s, lastError = :e, retryCount = :r, failedStep = :f, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
        ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":s": "FAILED",
          ":e": lastError,
          ":r": attempt,
          ":f": "CHUNKING",
          ":t": now,
          ":gsi1pk": "STATUS#FAILED",
          ":gsi1sk": now,
        },
      }),
    );
    console.log(
      `[chunk] Marked ${documentId} as FAILED after ${attempt} retries`,
    );
    return;
  }

  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET lastError = :e, retryCount = :r, failedStep = :f, updatedAt = :t",
      ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":deleting": "DELETING",
        ":e": lastError,
        ":r": attempt,
        ":f": "CHUNKING",
        ":t": now,
      },
    }),
  );

  console.log(`[chunk] Retry ${attempt}/3 for ${documentId}`);
}

function splitIntoChunks(
  pages: Array<{ pageNumber: number; text: string }>,
  maxTokens: number,
  overlapTokens: number,
  maxChunks: number,
) {
  const out: Array<{
    chunk: { text: string; pageStart: number; pageEnd: number };
    i: number;
  }> = [];
  let i = 0;
  let pageStart = 0;
  let pageEnd = 0;
  let buffer: number[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const text = decode(buffer).trim();
    if (text) {
      out.push({
        chunk: { text, pageStart, pageEnd },
        i: i++,
      });
      if (out.length > maxChunks) {
        throw new ContentError(`Document exceeds the ${maxChunks} chunk limit`);
      }
    }
    const keep = buffer.slice(Math.max(0, buffer.length - overlapTokens));
    buffer = keep;
    pageStart = pageEnd;
  };

  for (const page of pages) {
    if (buffer.length > 0) flush();
    pageStart = page.pageNumber;
    pageEnd = page.pageNumber;
    const tokens = encode(page.text, { disallowedSpecial: new Set() });
    for (const tok of tokens) {
      buffer.push(tok);
      if (buffer.length >= maxTokens) flush();
    }
  }
  flush();
  return out;
}
