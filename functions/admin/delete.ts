import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { ChunkItem, DocumentRow } from "../types";
import {
  deleteDocumentChunkRecords,
  deleteDocumentS3Data,
  deleteDocumentVectors,
  deleteS3Prefix,
  extractUserId,
  updateStorageBytes,
} from "../utils";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;

export async function handler(event: APIGatewayProxyEventV2) {
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

  const result = await dynamo.send(
    new GetCommand({
      TableName: TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  if (!result.Item) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document not found" }),
    };
  }

  const doc = result.Item as DocumentRow;
  if (doc.userId !== userId) {
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
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document not found" }),
    };
  }

  let sourceSize = 0;
  try {
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: StorageBucketName,
        Key: doc.sourceKey,
      }),
    );
    sourceSize = head.ContentLength ?? 0;
  } catch {}
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
    errors.push(`vectors: ${(err as Error).message}`);
  }

  try {
    await deleteDocumentS3Data(documentId, s3, StorageBucketName);
  } catch (err) {
    errors.push(`derived data: ${(err as Error).message}`);
  }

  if (doc.sourceKey) {
    try {
      await deleteS3Prefix(doc.sourceKey, s3, StorageBucketName);
    } catch (err) {
      errors.push(`source: ${(err as Error).message}`);
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
    await markDeleting(documentId, "Delete did not finish, try again");
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: documentId,
        deleted: false,
        warnings: [`dynamo: ${(err as Error).message}`],
      }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId: documentId, deleted: true }),
  };
}

// A failed delete stays DELETING so in-flight pipeline work still cannot write
// to it; lastError tells the user to delete again.
async function markDeleting(documentId: string, lastError: string | null) {
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateCommand({
      TableName: TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, lastError = :e, failedStep = :f, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :t",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":e": lastError,
        ":f": lastError ? "DELETE" : null,
        ":gsi1pk": "STATUS#DELETING",
        ":s": "DELETING",
        ":t": now,
      },
    }),
  );
}
