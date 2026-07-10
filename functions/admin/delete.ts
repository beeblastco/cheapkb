import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { extractUserId } from "../utils";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = Resource.Meta.name;
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
      body: JSON.stringify({ error: "You do not have access to this document" }),
    };
  }
  const errors: string[] = [];

  try {
    await deleteVectors(documentId);
  } catch (err: any) {
    errors.push(`vectors: ${err.message}`);
  }

  try {
    await deleteS3Prefix(`chunks/${documentId}/`);
  } catch (err: any) {
    errors.push(`chunks: ${err.message}`);
  }

  try {
    await deleteS3Prefix(`parsed/${documentId}/`);
  } catch (err: any) {
    errors.push(`parsed: ${err.message}`);
  }

  try {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: Resource.Storage.name,
        Delete: {
          Objects: [{ Key: doc.sourceKey }],
          Quiet: true,
        },
      }),
    );
  } catch (err: any) {
    errors.push(`source: ${err.message}`);
  }

  try {
    await dynamo.send(
      new DeleteCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
      }),
    );
  } catch (err: any) {
    errors.push(`dynamo: ${err.message}`);
  }

  if (errors.length > 0) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId,
        deleted: true,
        warnings: errors,
      }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, deleted: true }),
  };
}

async function deleteVectors(documentId: string) {
  const allChunkItems: any[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const chunkRecords = await dynamo.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `DOC#${documentId}`,
          ":prefix": "CHUNK#",
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    allChunkItems.push(...(chunkRecords.Items ?? []));
    lastKey = chunkRecords.LastEvaluatedKey;
  } while (lastKey);

  const vectorKeys = allChunkItems
    .map((item) => item.chunkId)
    .filter(Boolean);
  if (vectorKeys.length === 0) return;

  for (let i = 0; i < vectorKeys.length; i += 500) {
    const batch = vectorKeys.slice(i, i + 500);
    await vectors.send(
      new DeleteVectorsCommand({
        vectorBucketName: VectorBucketName,
        indexName: VectorIndexName,
        keys: batch,
      }),
    );
  }

  for (const item of allChunkItems) {
    await dynamo.send(
      new DeleteCommand({
        TableName,
        Key: { pk: item.pk, sk: item.sk },
      }),
    );
  }
}

async function deleteS3Prefix(prefix: string) {
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: Resource.Storage.name,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = list.Contents ?? [];
    if (objects.length === 0) break;

    await s3.send(
      new DeleteObjectsCommand({
        Bucket: Resource.Storage.name,
        Delete: {
          Objects: objects.map((o) => ({ Key: o.Key! })),
          Quiet: true,
        },
      }),
    );
    continuationToken = list.IsTruncated
      ? list.NextContinuationToken
      : undefined;
  } while (continuationToken);
}
