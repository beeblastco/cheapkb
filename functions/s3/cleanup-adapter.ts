import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;

export async function handler(event: any) {
  for (const record of event.Records ?? []) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const parts = key.split("/");
    if (parts.length < 3 || parts[0] !== "raw") {
      console.log(`[cleanup-adapter] Skipping non-raw object: ${key}`);
      continue;
    }
    const documentId = parts[1];
    console.log(`[cleanup-adapter] Cleaning up document ${documentId}`);

    const errors: string[] = [];
    let chunkItems: any[] = [];
    try {
      chunkItems = await deleteVectors(documentId);
    } catch (err: any) {
      errors.push(`vectors: ${err.message}`);
      console.error(`[cleanup-adapter] vector delete failed:`, err);
    }
    try {
      await deleteS3Prefix(`chunks/${documentId}/`);
    } catch (err: any) {
      errors.push(`chunks: ${err.message}`);
      console.error(`[cleanup-adapter] chunk delete failed:`, err);
    }
    try {
      await deleteS3Prefix(`parsed/${documentId}/`);
    } catch (err: any) {
      errors.push(`parsed: ${err.message}`);
      console.error(`[cleanup-adapter] parsed delete failed:`, err);
    }
    try {
      await deleteS3Prefix(`raw/${documentId}/`);
    } catch (err: any) {
      errors.push(`raw: ${err.message}`);
      console.error(`[cleanup-adapter] raw delete failed:`, err);
    }

    if (errors.length > 0) {
      console.log(
        `[cleanup-adapter] Completed ${documentId} with errors: ${errors.join("; ")}`,
      );
      throw new Error(errors.join("; "));
    }

    try {
      await deleteDynamoRecords(documentId, chunkItems);
    } catch (err: any) {
      console.error(`[cleanup-adapter] dynamo delete failed:`, err);
      throw err;
    }
    console.log(`[cleanup-adapter] Completed cleanup for ${documentId}`);
  }
}

async function deleteVectors(documentId: string): Promise<any[]> {
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

  const vectorKeys = allChunkItems.map((item) => item.chunkId).filter(Boolean);
  if (vectorKeys.length === 0) return allChunkItems;

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

  console.log(`[cleanup-adapter] Deleted ${vectorKeys.length} vectors`);
  return allChunkItems;
}

async function deleteS3Prefix(prefix: string) {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  let count = 0;
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
    count += objects.length;
    keyMarker = list.IsTruncated ? list.NextKeyMarker : undefined;
    versionIdMarker = list.IsTruncated ? list.NextVersionIdMarker : undefined;
  } while (keyMarker);
  console.log(`[cleanup-adapter] Deleted ${count} objects from ${prefix}`);
}

async function deleteDynamoRecords(documentId: string, chunkItems: any[]) {
  for (const item of chunkItems) {
    await dynamo.send(
      new DeleteCommand({
        TableName,
        Key: { pk: item.pk, sk: item.sk },
      }),
    );
  }
  await dynamo.send(
    new DeleteCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  console.log(`[cleanup-adapter] Deleted DynamoDB record for ${documentId}`);
}
