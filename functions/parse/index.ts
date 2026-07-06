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
import { Resource } from "sst";
import { extractText } from "unpdf";

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
      console.error("[parse] Invalid JSON in record:", record.messageId);
      continue;
    }
    const { documentId, sourceKey, mimeType } = body;
    if (!documentId || !sourceKey) {
      console.error("[parse] Missing required fields:", record.messageId);
      continue;
    }
    try {
      await parseDocument(documentId, sourceKey, mimeType);
    } catch (err: any) {
      console.error(`[parse] Failed for ${documentId}:`, err);
      await handleError(documentId, sourceKey, mimeType, err);
    }
  }
}

async function parseDocument(
  documentId: string,
  sourceKey: string,
  mimeType: string,
) {
  const now = new Date().toISOString();
  await updateStatus(documentId, "PARSING", now);

  const resp = await s3.send(
    new GetObjectCommand({ Bucket: Resource.Storage.name, Key: sourceKey }),
  );
  const bytes = new Uint8Array(await resp.Body!.transformToByteArray());

  let pages: Array<{ pageNumber: number; text: string }>;
  if (mimeType === "application/pdf") {
    pages = await extractPdfText(bytes);
  } else if (
    mimeType === "text/markdown" ||
    mimeType === "text/plain" ||
    mimeType === "text/html"
  ) {
    pages = [{ pageNumber: 1, text: new TextDecoder().decode(bytes) }];
  } else {
    try {
      pages = await extractPdfText(bytes);
    } catch {
      pages = [{ pageNumber: 1, text: new TextDecoder().decode(bytes) }];
    }
  }

  const hasText = pages.some((p) => p.text && p.text.trim().length > 0);
  if (!hasText) {
    throw new Error("Document produced no extractable text");
  }

  const parsedKey = `parsed/${documentId}/v1/pages.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: Resource.Storage.name,
      Key: parsedKey,
      Body: JSON.stringify({
        documentId,
        parserVersion: "unpdf-v1",
        extractedAt: now,
        pageCount: pages.length,
        pages,
      }),
      ContentType: "application/json",
    }),
  );

  await updateStatus(documentId, "PARSED", now);
  await clearError(documentId, now);

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: Resource.Chunk.url,
      MessageBody: JSON.stringify({ documentId, parsedKey }),
    }),
  );

  console.log(
    `[parse] OK: ${documentId} - ${pages.length} pages -> ${parsedKey}`,
  );
}

async function extractPdfText(bytes: Uint8Array) {
  const { text } = await extractText(bytes, { mergePages: false });
  return (text as string[])
    .map((pageText: string, i: number) => ({
      pageNumber: i + 1,
      text: pageText.trim(),
    }))
    .filter((p) => p.text.length > 0);
}

async function handleError(
  documentId: string,
  sourceKey: string,
  mimeType: string,
  err: any,
) {
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
  const realSourceKey = doc?.sourceKey ?? sourceKey;
  const realMimeType = doc?.mimeType ?? mimeType;

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
          ":f": "PARSING",
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
        ":f": "PARSING",
        ":t": now,
      },
    }),
  );

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: Resource.Ingest.url,
      MessageBody: JSON.stringify({
        documentId,
        sourceKey: realSourceKey,
        mimeType: realMimeType,
      }),
    }),
  );
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
