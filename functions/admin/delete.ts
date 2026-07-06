import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  DeleteVectorsCommand,
  ListVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { Resource } from "sst";

const s3 = new S3Client({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const vectors = new S3VectorsClient({});
const TableName = Resource.Meta.name;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;

export async function handler(event: any) {
  const documentId = event.pathParameters?.id;
  if (!documentId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document ID is required" }),
    };
  }

  try {
    const keysToDelete: string[] = [];
    let nextToken: string | undefined;
    do {
      const listResp = await vectors.send(
        new ListVectorsCommand({
          vectorBucketName: VectorBucketName,
          indexName: VectorIndexName,
          returnMetadata: true,
          ...(nextToken ? { nextToken } : {}),
        }),
      );
      const list = (listResp as any).vectors ?? [];
      for (const v of list) {
        if (v.metadata?.documentId === documentId) keysToDelete.push(v.key);
      }
      nextToken = (listResp as any).nextToken;
    } while (nextToken);

    for (let i = 0; i < keysToDelete.length; i += 100) {
      const batch = keysToDelete.slice(i, i + 100);
      await vectors.send(
        new DeleteVectorsCommand({
          vectorBucketName: VectorBucketName,
          indexName: VectorIndexName,
          keys: batch,
        }),
      );
    }
    if (keysToDelete.length > 0) {
      console.log(
        `[admin] Deleted ${keysToDelete.length} vectors for ${documentId}`,
      );
    }
  } catch (err) {
    console.warn(`[admin] Could not delete vectors for ${documentId}:`, err);
  }

  const chunksResult = await dynamo.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: {
        ":pk": `DOC#${documentId}`,
        ":sk": "CHUNK#",
      },
    }),
  );
  for (const chunk of chunksResult.Items ?? []) {
    await dynamo.send(
      new DeleteCommand({ TableName, Key: { pk: chunk.pk, sk: chunk.sk } }),
    );
  }

  const prefixes = [
    `raw/${documentId}/`,
    `parsed/${documentId}/`,
    `chunks/${documentId}/`,
  ];
  for (const prefix of prefixes) {
    try {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: Resource.Storage.name,
          Prefix: prefix,
        }),
      );
      for (const obj of listed.Contents ?? []) {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: Resource.Storage.name,
            Key: obj.Key!,
          }),
        );
      }
    } catch (err) {
      console.warn(`[admin] Could not delete S3 objects for ${prefix}:`, err);
    }
  }

  await dynamo.send(
    new DeleteCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, deleted: true }),
  };
}
