import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { encode, decode } from "gpt-tokenizer";
import { Resource } from "sst";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = Resource.Meta.name;

export async function handler(event: any) {
  for (const record of event.Records ?? []) {
    let body: any;
    try {
      body = JSON.parse(record.body);
    } catch {
      console.error("[chunk] Invalid JSON in record:", record.messageId);
      continue;
    }
    const { documentId, parsedKey } = body;
    if (!documentId || !parsedKey) {
      console.error("[chunk] Missing required fields:", record.messageId);
      continue;
    }
    try {
      await chunkDocument(documentId, parsedKey);
    } catch (err: any) {
      console.error(`[chunk] Failed for ${documentId}:`, err);
      await handleError(documentId, err);
    }
  }
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

  const resp = await s3.send(
    new GetObjectCommand({ Bucket: Resource.Storage.name, Key: parsedKey }),
  );
  const parsed = JSON.parse(await resp.Body!.transformToString());
  const pages: Array<{ pageNumber: number; text: string }> = parsed.pages;

  const maxTokens = parseInt(process.env.CHUNK_MAX_TOKENS ?? "700");
  const overlapTokens = parseInt(process.env.CHUNK_OVERLAP_TOKENS ?? "100");

  const chunks = splitIntoChunks(pages, maxTokens, overlapTokens);
  if (chunks.length === 0) {
    await updateStatus(documentId, "CHUNKED", now);
    await clearError(documentId, now);
    return;
  }

  const chunkKeys: string[] = [];
  for (const { chunk, i } of chunks) {
    const chunkId = `chunk_${documentId}_${i}`;
    const s3ChunkKey = `chunks/${documentId}/${chunkId}.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: Resource.Storage.name,
        Key: s3ChunkKey,
        Body: JSON.stringify({
          documentId,
          chunkId,
          text: chunk.text,
          title,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
        }),
        ContentType: "application/json",
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
    await Promise.all(
      group.map((s3ChunkKey) =>
        sqs.send(
          new SendMessageCommand({
            QueueUrl: Resource.Embed.url,
            MessageBody: JSON.stringify({ documentId, s3ChunkKey }),
          }),
        ),
      ),
    );
  }

  console.log(
    `[chunk] OK: ${documentId} - ${chunks.length} chunks -> ${chunkKeys[0]}`,
  );
}

function splitIntoChunks(
  pages: Array<{ pageNumber: number; text: string }>,
  maxTokens: number,
  overlapTokens: number,
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
          ":f": "CHUNKING",
          ":t": now,
          ":gsi1pk": "STATUS#FAILED",
          ":gsi1sk": now,
        },
      }),
    );
    console.log(
      `[chunk] Marked ${documentId} as FAILED after ${retryCount} retries`,
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
        ":f": "CHUNKING",
        ":t": now,
      },
    }),
  );

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: Resource.Chunk.url,
      MessageBody: JSON.stringify({
        documentId,
        parsedKey: `parsed/${documentId}/v1/pages.json`,
      }),
    }),
  );
  console.log(`[chunk] Retry ${retryCount}/3 for ${documentId}`);
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
