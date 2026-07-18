import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
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
      TableName,
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
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId,
        deleted: false,
        warnings: errors,
      }),
    };
  }

  try {
    await deleteDocumentChunkRecords(chunkItems, dynamo, TableName);
    await dynamo.send(
      new DeleteCommand({
        TableName,
        Key: {
          pk: `USER#${doc.userId}`,
          sk: `DOCUMENT#${doc.dedupeKey}`,
        },
      }),
    );
    await dynamo.send(
      new DeleteCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
      }),
    );
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId,
        deleted: false,
        warnings: [`dynamo: ${(err as Error).message}`],
      }),
    };
  }

  // Best-effort: the document is already gone, so a failed decrement must not fail
  // the request. Prefer countedBytes so it mirrors the increment charged at ingest.
  const decrement =
    typeof doc.countedBytes === "number" ? doc.countedBytes : sourceSize;
  try {
    await updateStorageBytes(doc.userId, AccountsTableName, -decrement);
  } catch (err) {
    console.error("[delete] storage accounting failed", err);
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, deleted: true }),
  };
}
