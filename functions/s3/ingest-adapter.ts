import type { S3Event } from "aws-lambda";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { recordUsage, updateStorageBytes } from "../utils";
import {
  deleteDocumentChunkRecords,
  deleteDocumentS3Data,
  deleteDocumentVectors,
  getDocument,
} from "../utils";
import type { DocumentRow } from "../types";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;
const PipelineQueueUrl = process.env.PIPELINE_QUEUE_URL!;
const DISPATCH_LEASE_MS = 60 * 1000;
const MAX_UPLOAD_BYTES = parseInt(
  process.env.MAX_UPLOAD_BYTES ?? "10485760",
  10,
);
const MAX_IMAGE_UPLOAD_BYTES = Math.min(
  parseInt(process.env.MAX_IMAGE_UPLOAD_BYTES ?? "5242880", 10),
  5 * 1024 * 1024,
);
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/markdown",
  "text/plain",
]);

export async function handler(event: S3Event) {
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
    const maxUploadBytes = doc.mimeType?.startsWith("image/")
      ? MAX_IMAGE_UPLOAD_BYTES
      : MAX_UPLOAD_BYTES;
    if (
      objectSize < 1 ||
      objectSize > maxUploadBytes ||
      !ALLOWED_MIME_TYPES.has(doc.mimeType ?? "")
    ) {
      await updateFailure(
        documentId,
        objectSize > maxUploadBytes
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

    const eventId = `${documentId}:${record.s3.object.sequencer}`;
    const queued = await claimDispatch(documentId, doc, now, eventId);
    if (!queued) {
      console.log(
        `[ingest-adapter] Document ${documentId} already started, skipping`,
      );
      continue;
    }

    try {
      await recordUsage(doc.userId, AccountsTableName, "ingest", 1, eventId);
      // Charge only the change in source size so a re-ingest or replacement
      // does not double-count bytes already attributed to this document.
      await updateStorageBytes(
        doc.userId,
        AccountsTableName,
        objectSize - (doc.countedBytes ?? 0),
        `ingest:${eventId}`,
      );
      await setCountedBytes(documentId, objectSize);
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: PipelineQueueUrl,
          MessageBody: JSON.stringify({
            stage: "parse",
            documentId,
            sourceKey: key,
            mimeType: doc.mimeType ?? "application/octet-stream",
          }),
        }),
      );
    } catch (error) {
      await rollbackQueueStatus(documentId, eventId);
      throw error;
    }
    await markDispatchSent(documentId, eventId);

    console.log(`[ingest-adapter] Triggered ingest for ${documentId}`);
  }
}

async function claimDispatch(
  documentId: string,
  doc: DocumentRow,
  now: string,
  eventId: string,
) {
  if (doc.status !== "UPLOADED" && doc.status !== "QUEUED") return false;
  if (doc.status === "QUEUED") {
    if (doc.dispatchState === "SENT") return false;
    const leaseUntil = Date.parse(doc.dispatchLeaseUntil ?? "");
    if (Number.isFinite(leaseUntil) && leaseUntil > Date.parse(now)) {
      throw new Error("Document dispatch is already in progress");
    }
  }

  const wasUploaded = doc.status === "UPLOADED";
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :queued, dispatchState = :claimed, dispatchEventId = :eventId, dispatchLeaseUntil = :leaseUntil, updatedAt = :now, gsi1pk = :gsi1pk, gsi1sk = :now",
        ConditionExpression: wasUploaded
          ? "#s = :uploaded"
          : "#s = :queued AND (attribute_not_exists(dispatchLeaseUntil) OR dispatchLeaseUntil <= :now) AND (attribute_not_exists(dispatchState) OR dispatchState = :claimed)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":claimed": "CLAIMED",
          ":eventId": eventId,
          ":gsi1pk": "STATUS#QUEUED",
          ":leaseUntil": new Date(
            Date.parse(now) + DISPATCH_LEASE_MS,
          ).toISOString(),
          ":now": now,
          ":queued": "QUEUED",
          ...(wasUploaded ? { ":uploaded": "UPLOADED" } : {}),
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException && wasUploaded) {
      return false;
    }
    throw error;
  }
}

async function finalizeReplacement(
  documentId: string,
  doc: DocumentRow,
  now: string,
) {
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

async function markDispatchSent(documentId: string, eventId: string) {
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression: "SET dispatchState = :sent REMOVE dispatchLeaseUntil",
      ConditionExpression:
        "dispatchState = :claimed AND dispatchEventId = :eventId",
      ExpressionAttributeValues: {
        ":claimed": "CLAIMED",
        ":eventId": eventId,
        ":sent": "SENT",
      },
    }),
  );
}

async function rollbackQueueStatus(documentId: string, eventId: string) {
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :uploaded, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk REMOVE dispatchState, dispatchEventId, dispatchLeaseUntil",
      ExpressionAttributeNames: { "#s": "status" },
      ConditionExpression:
        "#s = :queued AND dispatchState = :claimed AND dispatchEventId = :eventId",
      ExpressionAttributeValues: {
        ":claimed": "CLAIMED",
        ":eventId": eventId,
        ":queued": "QUEUED",
        ":uploaded": "UPLOADED",
        ":t": now,
        ":gsi1pk": "STATUS#UPLOADED",
        ":gsi1sk": now,
      },
    }),
  );
}

async function setCountedBytes(documentId: string, countedBytes: number) {
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression: "SET countedBytes = :counted",
      ConditionExpression: "#s = :queued",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":counted": countedBytes,
        ":queued": "QUEUED",
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
