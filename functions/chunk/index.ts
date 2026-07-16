import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
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

const s3 = new S3Client({});
const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const EmbedQueueUrl = process.env.EMBED_QUEUE_URL!;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    let body: any;
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
    try {
      await chunkDocument(documentId, parsedKey);
    } catch (err: any) {
      console.error(`[chunk] Failed for ${documentId}:`, err);
      const attempt = parseInt(
        record.attributes.ApproximateReceiveCount ?? "1",
        10,
      );
      await handleError(documentId, err, attempt);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

async function chunkDocument(documentId: string, parsedKey: string) {
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
  const userId = doc.userId;
  if (!userId) throw new Error("Document owner is missing");

  const resp = await s3.send(
    new GetObjectCommand({ Bucket: StorageBucketName, Key: parsedKey }),
  );
  const parsed = JSON.parse(await resp.Body!.transformToString());
  const pages: Array<{ pageNumber: number; text: string }> = parsed.pages;

  const maxTokens = parseInt(process.env.CHUNK_MAX_TOKENS ?? "700");
  const overlapTokens = parseInt(process.env.CHUNK_OVERLAP_TOKENS ?? "100");
  const maxChunks = parseInt(process.env.MAX_CHUNKS_PER_DOCUMENT ?? "200");

  const chunks = splitIntoChunks(pages, maxTokens, overlapTokens, maxChunks);
  if (chunks.length === 0) {
    await updateStatus(documentId, "CHUNKED", now);
    await clearError(documentId, now);
    return;
  }

  const chunkKeys: string[] = [];
  for (const { chunk, i } of chunks) {
    const chunkId = `chunk_${documentId}_${i}`;
    const s3ChunkKey = `chunks/${documentId}/${chunkId}.json`;
    const tokenCount = encode(chunk.text).length;
    await s3.send(
      new PutObjectCommand({
        Bucket: StorageBucketName,
        Key: s3ChunkKey,
        Body: JSON.stringify({
          documentId,
          userId,
          chunkId,
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
    await dynamo.send(
      new PutCommand({
        TableName,
        Item: {
          pk: `DOC#${documentId}`,
          sk: `CHUNK#${chunkId}`,
          entityType: "Chunk",
          chunkId,
          s3ChunkKey,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          tokenCount,
          status: "QUEUED",
          createdAt: now,
        },
      }),
    );
    chunkKeys.push(s3ChunkKey);
  }

  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, chunkCount = :c, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "CHUNKED",
        ":c": chunks.length,
        ":t": now,
        ":gsi1pk": "STATUS#CHUNKED",
        ":gsi1sk": now,
      },
    }),
  );
  await clearError(documentId, now);

  const sendSize = 10;
  for (let i = 0; i < chunkKeys.length; i += sendSize) {
    const group = chunkKeys.slice(i, i + sendSize);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: EmbedQueueUrl,
        Entries: group.map((s3ChunkKey, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify({ documentId, s3ChunkKey }),
        })),
      }),
    );
    if (response.Failed?.length) throw new Error("Failed to queue some chunks");
  }

  console.log(
    `[chunk] OK: ${documentId} - ${chunks.length} chunks -> ${chunkKeys[0]}`,
  );
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
      ExpressionAttributeValues: {
        ":e": lastError,
        ":r": attempt,
        ":f": "CHUNKING",
        ":t": now,
      },
    }),
  );

  console.log(`[chunk] Retry ${attempt}/3 for ${documentId}`);
}

async function updateStatus(documentId: string, status: string, now: string) {
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
        throw new Error(`Document exceeds the ${maxChunks} chunk limit`);
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
    const tokens = encode(page.text);
    for (const tok of tokens) {
      buffer.push(tok);
      if (buffer.length >= maxTokens) flush();
    }
  }
  flush();
  return out;
}
