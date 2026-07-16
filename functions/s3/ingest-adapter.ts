import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { recordUsage, updateStorageBytes } from "../billing/utils";
import {
  deleteDocumentChunkRecords,
  deleteDocumentS3Data,
  deleteDocumentVectors,
  getDocument,
} from "../utils";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;
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
    const now = new Date().toISOString();

    let doc = await getDocument(documentId, dynamo, TableName);
    if (!doc) {
      console.log(`[ingest-adapter] Document ${documentId} not found`);
      continue;
    }

    if (doc.replacementToken) {
      const object = await s3.send(
        new HeadObjectCommand({ Bucket: StorageBucketName, Key: key }),
      );
      if (object.Metadata?.["upload-token"] !== doc.replacementToken) {
        console.log(
          `[ingest-adapter] Skipping stale replacement event for ${documentId}`,
        );
        continue;
      }
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

    if (doc.replacementToken) {
      const finalized = await finalizeReplacement(documentId, doc, now);
      if (!finalized) {
        console.log(
          `[ingest-adapter] Skipping stale replacement event for ${documentId}`,
        );
        continue;
      }
      doc = { ...doc, status: "UPLOADED" };
    }

    if (doc.status === "EMBEDDED") {
      console.log(
        `[ingest-adapter] Document ${documentId} already embedded, skipping`,
      );
      continue;
    }

    const queued = await queueDocument(documentId, now);
    if (!queued) {
      console.log(
        `[ingest-adapter] Document ${documentId} already started, skipping`,
      );
      continue;
    }

    await recordUsage(doc.userId, TableName, "ingest", 1);
    await updateStorageBytes(doc.userId, TableName, objectSize);

    try {
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
    } catch (error) {
      await rollbackQueueStatus(documentId);
      throw error;
    }

    console.log(`[ingest-adapter] Triggered ingest for ${documentId}`);
  }
}

async function finalizeReplacement(documentId: string, doc: any, now: string) {
  const chunkItems = await deleteDocumentVectors(
    documentId,
    dynamo,
    vectors,
    TableName,
    VectorBucketName,
    VectorIndexName,
  );
  await deleteDocumentS3Data(documentId, s3, StorageBucketName);
  await deleteDocumentChunkRecords(chunkItems, dynamo, TableName);

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :uploaded, filename = :filename, title = :title, tags = :tags, authors = :authors, #year = :year, updatedAt = :now, gsi1pk = :gsi1pk, gsi1sk = :now REMOVE chunkCount, embeddedCount, lastError, retryCount, failedStep, replacementToken, replacementExpiresAt, replacementPreviousStatus, pendingFilename, pendingTitle, pendingTags, pendingAuthors, pendingYear",
        ConditionExpression:
          "replacementToken = :token AND #s = :previousStatus",
        ExpressionAttributeNames: { "#s": "status", "#year": "year" },
        ExpressionAttributeValues: {
          ":uploaded": "UPLOADED",
          ":filename": doc.pendingFilename,
          ":title": doc.pendingTitle,
          ":tags": doc.pendingTags,
          ":authors": doc.pendingAuthors,
          ":year": doc.pendingYear,
          ":now": now,
          ":gsi1pk": "STATUS#UPLOADED",
          ":token": doc.replacementToken,
          ":previousStatus": doc.replacementPreviousStatus,
        },
      }),
    );
    return true;
  } catch (error) {
    // A duplicate/concurrent S3 event for the same replacement loses the
    // conditional write; treat it as a stale event rather than crashing.
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

async function queueDocument(documentId: string, now: string) {
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :queued, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
        ExpressionAttributeNames: { "#s": "status" },
        ConditionExpression: "#s = :uploaded",
        ExpressionAttributeValues: {
          ":queued": "QUEUED",
          ":uploaded": "UPLOADED",
          ":t": now,
          ":gsi1pk": "STATUS#QUEUED",
          ":gsi1sk": now,
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

async function rollbackQueueStatus(documentId: string) {
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :uploaded, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ExpressionAttributeNames: { "#s": "status" },
      ConditionExpression: "#s = :queued",
      ExpressionAttributeValues: {
        ":queued": "QUEUED",
        ":uploaded": "UPLOADED",
        ":t": now,
        ":gsi1pk": "STATUS#UPLOADED",
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
