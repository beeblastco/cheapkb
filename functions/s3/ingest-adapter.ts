import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { S3Event } from "aws-lambda";
import type { DocumentRow } from "../types";
import {
  checkUsageLimit,
  deleteDocumentChunkRecords,
  deleteDocumentS3Data,
  deleteDocumentVectors,
  dynamo,
  getDocument,
  isDocumentInFlight,
  LATE_REPLACEMENT_GRACE_MS,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_STORAGE_BYTES,
  MAX_UPLOAD_BYTES,
  recordUsage,
  updateStorageBytes,
} from "../utils";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const sqs = new SQSClient({});
const TableName = process.env.TABLE_NAME!;
const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;
const PipelineQueueUrl = process.env.PIPELINE_QUEUE_URL!;
const DISPATCH_LEASE_MS = 60 * 1000;
// This function's timeout, so a charge decided now commits within it.
const INVOCATION_MS = 60 * 1000;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/markdown",
  "text/plain",
]);

/** S3 ObjectCreated handler for raw/ uploads; validates the file and queues the parse stage. */
export async function handler(event: S3Event): Promise<void> {
  for (const record of event.Records ?? []) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const parts = key.split("/");
    if (parts.length < 3 || parts[0] !== "raw") {
      console.log(`[ingest-adapter] Skipping non-raw object: ${key}`);
      continue;
    }
    const [, documentId] = parts;
    const now = new Date().toISOString();

    let doc = await getDocument(documentId, dynamo, TableName);
    if (!doc || doc.status === "DELETING") {
      await removeLateUpload(documentId, key, record.s3.object.versionId);
      continue;
    }

    const eventId = `${documentId}:${record.s3.object.sequencer}`;
    // The upload caps count a document only while it is in flight, so a file that lands
    // later, or by the end of this invocation, is held to the storage cap.
    const late = !isDocumentInFlight(doc, Date.parse(now) + INVOCATION_MS);
    if (await skipStaleReplacement(documentId, doc, key, eventId)) continue;

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

    if (await refuseOverAllowance(documentId, doc, key, eventId, now, late)) {
      continue;
    }

    if (doc.replacementToken) {
      const finalized = await finalizeReplacement(documentId, doc, key, now);
      if (!finalized) {
        console.log(
          `[ingest-adapter] Skipping stale replacement event for ${documentId}`,
        );
        continue;
      }
      doc = { ...doc, status: "UPLOADED" };
    }

    if (isDispatched(doc)) {
      await recountStorage(documentId, doc, key, eventId, true);
      console.log(
        `[ingest-adapter] Document ${documentId} already dispatched, skipping`,
      );
      continue;
    }

    const queued = await claimDispatch(documentId, doc, now, eventId);
    if (!queued) {
      console.log(
        `[ingest-adapter] Document ${documentId} already started, skipping`,
      );
      continue;
    }

    try {
      // Charge only the change in source size so a re-ingest or replacement does not
      // double-count bytes. The document's count moves in the same transaction, so a
      // dispatch that fails afterwards cannot leave bytes no document accounts for.
      const charged = await updateStorageBytes(
        doc.userId,
        AccountsTableName,
        objectSize - (doc.countedBytes ?? 0),
        `ingest:${eventId}`,
        {
          Update: {
            TableName: TableName,
            Key: { pk: `DOC#${documentId}`, sk: "META" },
            UpdateExpression: "SET countedBytes = :counted",
            ConditionExpression: "#s = :queued",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":counted": objectSize,
              ":queued": "QUEUED",
            },
          },
        },
        undefined,
        late ? MAX_STORAGE_BYTES : undefined,
      );
      if (!charged) {
        await refuseLateUpload(
          documentId,
          key,
          record.s3.object.versionId,
          now,
        );
        continue;
      }
      await recordUsage(doc.userId, AccountsTableName, "ingest", 1, eventId);
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: PipelineQueueUrl,
          MessageBody: JSON.stringify({
            stage: "parse",
            documentId: documentId,
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

/** Claims the document for dispatch with a lease; returns false when another event owns it. */
async function claimDispatch(
  documentId: string,
  doc: DocumentRow,
  now: string,
  eventId: string,
): Promise<boolean> {
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
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :queued, dispatchState = :claimed, dispatchEventId = :eventId, dispatchLeaseUntil = :leaseUntil, updatedAt = :now",
        ConditionExpression: wasUploaded
          ? "#s = :uploaded"
          : "#s = :queued AND (attribute_not_exists(dispatchLeaseUntil) OR dispatchLeaseUntil <= :now) AND (attribute_not_exists(dispatchState) OR dispatchState = :claimed)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":claimed": "CLAIMED",
          ":eventId": eventId,
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

/** Promotes a pending replacement after deleting the old derived data; false for a stale
 * event. reindexedAt marks rows an older chunk run writes after the delete as stale. */
async function finalizeReplacement(
  documentId: string,
  doc: DocumentRow,
  key: string,
  now: string,
): Promise<boolean> {
  // Past the grace, edits and reindex may run again and the caps stop counting it, so
  // even a redriven event for a timely upload is rolled back, with this invocation's margin.
  const expiresAt = Date.parse(doc.replacementExpiresAt ?? "");
  if (expiresAt + LATE_REPLACEMENT_GRACE_MS < Date.parse(now) + INVOCATION_MS) {
    await revertReplacement(
      documentId,
      doc,
      key,
      "Replacement arrived too late",
    );
    return false;
  }
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
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :uploaded, filename = :filename, title = :title, tags = :tags, authors = :authors, #year = :year, updatedAt = :now, reindexedAt = :now REMOVE chunkCount, embeddedCount, lastError, retryCount, failedStep, replacementToken, replacementExpiresAt, replacementPreviousStatus, pendingFilename, pendingTitle, pendingTags, pendingAuthors, pendingYear",
        ConditionExpression: "replacementToken = :token AND #s <> :deleting",
        ExpressionAttributeNames: { "#s": "status", "#year": "year" },
        ExpressionAttributeValues: {
          ":uploaded": "UPLOADED",
          ":filename": doc.pendingFilename,
          ":title": doc.pendingTitle,
          ":tags": doc.pendingTags,
          ":authors": doc.pendingAuthors,
          ":year": doc.pendingYear,
          ":now": now,
          ":token": doc.replacementToken,
          ":deleting": "DELETING",
        },
      }),
    );
    return true;
  } catch (error) {
    // Another event already finished this replacement, or a delete took the row.
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

/** Marks the claimed dispatch as sent once the parse message is on the queue. */
async function markDispatchSent(
  documentId: string,
  eventId: string,
): Promise<void> {
  await dynamo.send(
    new UpdateCommand({
      TableName: TableName,
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

/** Charges the source's current size, since a presigned POST can overwrite it for 15
 * minutes. When capped, a version over the storage cap is removed and the one below rechecked. */
async function recountStorage(
  documentId: string,
  doc: DocumentRow,
  key: string,
  eventId: string,
  capped: boolean,
): Promise<void> {
  // Two events can both refuse the newest version, so the one under it is recounted too.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let objectSize: number;
    let versionId: string | undefined;
    try {
      const object = await s3.send(
        new HeadObjectCommand({ Bucket: StorageBucketName, Key: key }),
      );
      objectSize = object.ContentLength ?? 0;
      versionId = object.VersionId;
    } catch (error) {
      if ((error as Error).name === "NotFound") return;
      throw error;
    }
    // Each pass reads the count consistently, since another event may have moved it.
    const current = await getDocument(documentId, dynamo, TableName);
    if (!current || current.status === "DELETING") return;
    const countedBytes = current.countedBytes ?? 0;
    if (objectSize === countedBytes) return;

    const charged = await updateStorageBytes(
      doc.userId,
      AccountsTableName,
      objectSize - countedBytes,
      `recount:${eventId}:${objectSize}`,
      {
        Update: {
          TableName: TableName,
          Key: { pk: `DOC#${documentId}`, sk: "META" },
          UpdateExpression: "SET countedBytes = :counted",
          ConditionExpression:
            current.countedBytes === undefined
              ? "attribute_not_exists(countedBytes) AND #s <> :deleting"
              : "countedBytes = :previous AND #s <> :deleting",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":counted": objectSize,
            ":deleting": "DELETING",
            ...(current.countedBytes === undefined
              ? {}
              : { ":previous": current.countedBytes }),
          },
        },
      },
      undefined,
      capped ? MAX_STORAGE_BYTES : undefined,
    );
    if (charged) return;
    // Another event may have charged this version since; then it stays.
    const latest = await getDocument(documentId, dynamo, TableName);
    if (latest?.countedBytes === objectSize) return;
    // Removing the refused version makes S3 serve the version under it again.
    await s3.send(
      new DeleteObjectCommand({
        Bucket: StorageBucketName,
        Key: key,
        VersionId: versionId,
      }),
    );
    console.log(
      `[ingest-adapter] Refused a version of ${documentId} over the storage cap`,
    );
  }
}

/** Fails a late file that would pass the storage cap and removes it. Its count is left as
 * is, so it still matches the version S3 serves once this one is gone. */
async function refuseLateUpload(
  documentId: string,
  key: string,
  versionId: string | undefined,
  now: string,
): Promise<void> {
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :s, lastError = :e, failedStep = :f, updatedAt = :t",
        ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":e": "Storage limit reached. Delete documents to upload more.",
          ":f": "UPLOAD",
          ":s": "FAILED",
          ":t": now,
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
  await s3.send(
    new DeleteObjectCommand({
      Bucket: StorageBucketName,
      Key: key,
      VersionId: versionId,
    }),
  );
}

/** The allowance is checked when the upload URL is issued, but a burst of URLs
 * all pass that check before any embedding is billed. Returns true when refused. */
async function refuseOverAllowance(
  documentId: string,
  doc: DocumentRow,
  key: string,
  eventId: string,
  now: string,
  late: boolean,
): Promise<boolean> {
  if (doc.status !== "UPLOADED" && !doc.replacementToken) return false;
  const { allowed } = await checkUsageLimit(doc.userId, AccountsTableName);
  if (allowed) return false;

  const message = "Monthly usage allowance reached. Upgrade to continue.";
  if (doc.replacementToken) {
    await revertReplacement(documentId, doc, key, message);
    return true;
  }
  // Another event claimed the upload first; a retry recounts it as dispatched.
  if (!(await updateFailure(documentId, message, now, true))) {
    throw new Error(`Upload ${documentId} was claimed concurrently`);
  }
  // A failed upload keeps its source, so its bytes are charged like any other.
  await recountStorage(documentId, doc, key, eventId, late);

  return true;
}

/** Removes an upload that landed after or during its document's delete. */
async function removeLateUpload(
  documentId: string,
  key: string,
  versionId: string | undefined,
): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: StorageBucketName,
      Key: key,
      VersionId: versionId,
    }),
  );
  console.log(`[ingest-adapter] Removed late upload for ${documentId}`);
}

/** Removes every version a refused replacement form wrote, so S3 falls back to the
 * source the search data came from. The token stays until it expires with the form. */
async function revertReplacement(
  documentId: string,
  doc: DocumentRow,
  key: string,
  reason: string,
): Promise<void> {
  const listed = await s3.send(
    new ListObjectVersionsCommand({ Bucket: StorageBucketName, Prefix: key }),
  );
  for (const version of listed.Versions ?? []) {
    if (version.Key !== key) continue;
    const object = await s3.send(
      new HeadObjectCommand({
        Bucket: StorageBucketName,
        Key: key,
        VersionId: version.VersionId,
      }),
    );
    if (object.Metadata?.["upload-token"] !== doc.replacementToken) continue;
    await s3.send(
      new DeleteObjectCommand({
        Bucket: StorageBucketName,
        Key: key,
        VersionId: version.VersionId,
      }),
    );
  }
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression: "SET lastError = :e",
        ConditionExpression: "replacementToken = :token",
        ExpressionAttributeValues: {
          ":e": reason,
          ":token": doc.replacementToken,
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}

/** Returns a claimed document to UPLOADED when dispatch fails, so a retry can claim it. */
async function rollbackQueueStatus(
  documentId: string,
  eventId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateCommand({
      TableName: TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :uploaded, updatedAt = :t REMOVE dispatchState, dispatchEventId, dispatchLeaseUntil",
      ExpressionAttributeNames: { "#s": "status" },
      ConditionExpression:
        "#s = :queued AND dispatchState = :claimed AND dispatchEventId = :eventId",
      ExpressionAttributeValues: {
        ":claimed": "CLAIMED",
        ":eventId": eventId,
        ":queued": "QUEUED",
        ":uploaded": "UPLOADED",
        ":t": now,
      },
    }),
  );
}

/** Returns true when this event wrote through an old token-less POST while a
 * replacement is pending; its bytes are charged and dispatch is skipped. */
async function skipStaleReplacement(
  documentId: string,
  doc: DocumentRow,
  key: string,
  eventId: string,
): Promise<boolean> {
  if (!doc.replacementToken) return false;
  const object = await s3.send(
    new HeadObjectCommand({ Bucket: StorageBucketName, Key: key }),
  );
  if (object.Metadata?.["upload-token"] === doc.replacementToken) return false;
  // The old token-less POST can still overwrite a dispatched source, so charge what now sits there.
  if (isDispatched(doc)) {
    await recountStorage(documentId, doc, key, eventId, true);
  }
  console.log(
    `[ingest-adapter] Skipping stale replacement event for ${documentId}`,
  );

  return true;
}

/** Marks the document FAILED at the UPLOAD step with the given error. Returns false when the
 * document is gone or being deleted, or, with onlyIfUploaded, was claimed meanwhile. */
async function updateFailure(
  documentId: string,
  error: string,
  now: string,
  onlyIfUploaded = false,
): Promise<boolean> {
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :s, lastError = :e, failedStep = :f, updatedAt = :t",
        // Another event may have claimed the upload since it was read. An unconditional
        // update would recreate a row a delete just removed.
        ConditionExpression: onlyIfUploaded
          ? "#s = :uploaded"
          : "attribute_exists(pk) AND #s <> :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "FAILED",
          ":e": error,
          ":f": "UPLOAD",
          ":t": now,
          ...(onlyIfUploaded
            ? { ":uploaded": "UPLOADED" }
            : { ":deleting": "DELETING" }),
        },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

/** Dispatch already charged this document once, so later events only recount.
 * The handler skips DELETING documents before this runs. */
function isDispatched(doc: DocumentRow): boolean {
  if (doc.status === "UPLOADED") return false;

  return doc.status !== "QUEUED" || doc.dispatchState === "SENT";
}
