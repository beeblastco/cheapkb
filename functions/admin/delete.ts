import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  deleteDocumentChunkRecords,
  deleteDocumentS3Data,
  deleteDocumentVectors,
  deleteS3Prefix,
  extractUserId,
} from "../utils";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { updateStorageBytes } from "../billing/account";
const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;

export async function handler(event: any) {
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

  const doc = result.Item;
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
  let chunkItems: any[] = [];

  try {
    chunkItems = await deleteDocumentVectors(
      documentId,
      dynamo,
      vectors,
      TableName,
      VectorBucketName,
      VectorIndexName,
    );
  } catch (err: any) {
    errors.push(`vectors: ${err.message}`);
  }

  try {
    await deleteDocumentS3Data(documentId, s3, StorageBucketName);
  } catch (err: any) {
    errors.push(`derived data: ${err.message}`);
  }

  try {
    await deleteS3Prefix(doc.sourceKey, s3, StorageBucketName);
  } catch (err: any) {
    errors.push(`source: ${err.message}`);
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
    await updateStorageBytes(doc.userId, TableName, -sourceSize);
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId,
        deleted: false,
        warnings: [`dynamo: ${err.message}`],
      }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, deleted: true }),
  };
}
