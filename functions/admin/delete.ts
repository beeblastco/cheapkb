import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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
  extractUserId,
} from "../utils";

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
      statusCode: 403,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "You do not have access to this document",
      }),
    };
  }
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
    await deleteS3Prefix(doc.sourceKey);
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

async function deleteS3Prefix(prefix: string) {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: StorageBucketName,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );
    const objects = [...(list.Versions ?? []), ...(list.DeleteMarkers ?? [])];
    if (objects.length === 0) break;

    const response = await s3.send(
      new DeleteObjectsCommand({
        Bucket: StorageBucketName,
        Delete: {
          Objects: objects.map((object) => ({
            Key: object.Key!,
            VersionId: object.VersionId,
          })),
          Quiet: true,
        },
      }),
    );
    if (response.Errors?.length)
      throw new Error("Failed to delete S3 versions");
    keyMarker = list.IsTruncated ? list.NextKeyMarker : undefined;
    versionIdMarker = list.IsTruncated ? list.NextVersionIdMarker : undefined;
  } while (keyMarker);
}
