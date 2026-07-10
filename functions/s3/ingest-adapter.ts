import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const IngestQueueUrl = process.env.INGEST_QUEUE_URL!;
const MAX_UPLOAD_BYTES = parseInt(
  process.env.MAX_UPLOAD_BYTES ?? "10485760",
  10,
);
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/markdown",
  "text/plain",
]);

export async function handler(event: any) {
  for (const record of event.Records ?? []) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const parts = key.split("/");
    if (parts.length < 3 || parts[0] !== "raw") {
      console.log(`[ingest-adapter] Skipping non-raw object: ${key}`);
      continue;
    }
    const documentId = parts[1];
    const filename = parts.slice(2).join("/");
    const now = new Date().toISOString();

    let doc = await getDocument(documentId);
    if (!doc) {
      doc = await createMinimalRecord(documentId, key, filename, now);
    }

    const objectSize = Number(record.s3.object.size ?? 0);
    if (
      objectSize < 1 ||
      objectSize > MAX_UPLOAD_BYTES ||
      !ALLOWED_MIME_TYPES.has(doc.mimeType)
    ) {
      await updateFailure(
        documentId,
        objectSize > MAX_UPLOAD_BYTES
          ? "File exceeds upload size limit"
          : "Unsupported or empty file",
        now,
      );
      continue;
    }

    if (doc.status === "EMBEDDED") {
      console.log(
        `[ingest-adapter] Document ${documentId} already embedded, skipping`,
      );
      continue;
    }

    await updateStatus(documentId, "QUEUED", now);

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: IngestQueueUrl,
        MessageBody: JSON.stringify({
          documentId,
          sourceKey: key,
          mimeType: doc.mimeType ?? "application/octet-stream",
        }),
      }),
    );

    console.log(`[ingest-adapter] Triggered ingest for ${documentId}`);
  }
}

async function getDocument(documentId: string) {
  const result = await dynamo.send(
    new GetCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  return result.Item ?? null;
}

async function createMinimalRecord(
  documentId: string,
  sourceKey: string,
  filename: string,
  now: string,
) {
  const mimeType = guessMimeType(filename);
  const item = {
    pk: `DOC#${documentId}`,
    sk: "META",
    entityType: "Document",
    documentId,
    title: filename,
    sourceKey,
    mimeType,
    status: "UPLOADED",
    tags: null,
    authors: null,
    year: null,
    createdAt: now,
    updatedAt: now,
    gsi1pk: "STATUS#UPLOADED",
    gsi1sk: now,
  };
  await dynamo.send(new PutCommand({ TableName, Item: item }));
  return item;
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

async function updateFailure(documentId: string, error: string, now: string) {
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, lastError = :e, failedStep = :f, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "FAILED",
        ":e": error,
        ":f": "UPLOAD",
        ":t": now,
        ":gsi1pk": "STATUS#FAILED",
        ":gsi1sk": now,
      },
    }),
  );
}

function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    pdf: "application/pdf",
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    html: "text/html",
    htm: "text/html",
  };
  return mimeMap[ext ?? ""] ?? "application/octet-stream";
}
