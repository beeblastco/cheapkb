import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { ChunkItem } from "../types";
import {
  deleteDocumentChunkRecords,
  deleteDocumentS3Data,
  deleteDocumentVectors,
  deleteS3Prefix,
  dynamo,
  extractUserId,
  getDocument,
  updateStorageBytes,
} from "../utils";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const TableName = process.env.TABLE_NAME!;
const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;
// Matches the update handler's lease TTL. A live edit could outlive this delete if
// its handler times out, so delete waits; reset and S3 removal rely on its cleanup.
const UPDATE_LEASE_TTL_MS = 5 * 60 * 1000;

/** DELETE /documents/{id}: removes an owned document's vectors, S3 data and rows. */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const documentId = event.pathParameters?.id;
  if (!documentId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document ID is required" }),
    };
  }

  const doc = await getDocument(documentId, dynamo, TableName);
  if (!doc || doc.userId !== userId) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document not found" }),
    };
  }

  // Pipeline stages refuse to write to a DELETING document, so nothing they
  // write after this point outlives the cleanup below.
  try {
    await markDeleting(documentId, null);
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
    return markRefusedResponse(documentId);
  }

  // Older documents have no countedBytes, so the size is read and saved before
  // the source is deleted; a retry then refunds it. Other errors stop the delete.
  let sourceSize = 0;
  if (typeof doc.countedBytes !== "number" && doc.sourceKey) {
    try {
      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: StorageBucketName,
          Key: doc.sourceKey,
        }),
      );
      sourceSize = head.ContentLength ?? 0;
      await dynamo.send(
        new UpdateCommand({
          TableName: TableName,
          Key: { pk: `DOC#${documentId}`, sk: "META" },
          UpdateExpression: "SET countedBytes = :b",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":b": sourceSize },
        }),
      );
    } catch (err) {
      if ((err as Error).name !== "NotFound") {
        console.error("[delete] source size:", err);
        await markDeleting(documentId, "Delete did not finish, try again");
        return {
          statusCode: 500,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentId: documentId,
            deleted: false,
            warnings: ["source size"],
          }),
        };
      }
    }
  }
  const errors: string[] = [];
  let chunkItems: ChunkItem[] = [];

  try {
    chunkItems = await deleteDocumentVectors(
      documentId,
      dynamo,
      vectors,
      TableName,
      VectorBucketName,
      VectorIndexName,
    );
  } catch (err) {
    console.error("[delete] vectors:", err);
    errors.push("vectors");
  }

  try {
    await deleteDocumentS3Data(documentId, s3, StorageBucketName);
  } catch (err) {
    console.error("[delete] derived data:", err);
    errors.push("derived data");
  }

  if (doc.sourceKey) {
    try {
      await deleteS3Prefix(doc.sourceKey, s3, StorageBucketName);
    } catch (err) {
      console.error("[delete] source:", err);
      errors.push("source");
    }
  }

  if (errors.length > 0) {
    await markDeleting(documentId, "Delete did not finish, try again");
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: documentId,
        deleted: false,
        warnings: errors,
      }),
    };
  }

  const decrement =
    typeof doc.countedBytes === "number" ? doc.countedBytes : sourceSize;
  try {
    await updateStorageBytes(
      doc.userId,
      AccountsTableName,
      -decrement,
      `delete:${documentId}`,
    );
    await deleteDocumentChunkRecords(chunkItems, dynamo, TableName);
    await dynamo.send(
      new DeleteCommand({
        TableName: TableName,
        Key: {
          pk: `USER#${doc.userId}`,
          sk: `DOCUMENT#${doc.dedupeKey}`,
        },
      }),
    );
    await dynamo.send(
      new DeleteCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
      }),
    );
  } catch (err) {
    console.error("[delete] dynamo:", err);
    await markDeleting(documentId, "Delete did not finish, try again");
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: documentId,
        deleted: false,
        warnings: ["dynamo"],
      }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId: documentId, deleted: true }),
  };
}

/** A failed delete stays DELETING so in-flight pipeline work still cannot write
 * to it; lastError tells the user to delete again. */
async function markDeleting(
  documentId: string,
  lastError: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateCommand({
      TableName: TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, lastError = :e, failedStep = :f, updatedAt = :t",
      // Never take over a live edit lease; a DELETING row always passes.
      ConditionExpression:
        "attribute_exists(pk) AND (#s <> :updating OR updatedAt < :leaseCutoff)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":leaseCutoff": new Date(
          Date.now() - UPDATE_LEASE_TTL_MS,
        ).toISOString(),
        ":updating": "UPDATING",
        ":e": lastError,
        ":f": lastError ? "DELETE" : null,
        ":s": "DELETING",
        ":t": now,
      },
    }),
  );
}

/** The first mark fails when the row vanished or an edit lease is live; tell the two apart. */
async function markRefusedResponse(
  documentId: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const current = await getDocument(documentId, dynamo, TableName);
  if (!current) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document not found" }),
    };
  }

  return {
    statusCode: 409,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Document is being edited, try again" }),
  };
}
