import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import {
  S3VectorsClient,
  ListVectorsCommand,
  DeleteVectorsCommand,
} from "@aws-sdk/client-s3vectors";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = Resource.Meta.name;
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
    try {
      await deleteVectors(documentId);
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
      await deleteDynamoRecord(documentId);
    } catch (err: any) {
      errors.push(`dynamo: ${err.message}`);
      console.error(`[cleanup-adapter] dynamo delete failed:`, err);
    }

    if (errors.length > 0) {
      console.log(
        `[cleanup-adapter] Completed ${documentId} with errors: ${errors.join("; ")}`,
      );
    } else {
      console.log(`[cleanup-adapter] Completed cleanup for ${documentId}`);
    }
  }
}

async function deleteVectors(documentId: string) {
  let nextToken: string | undefined;
  const vectorKeys: string[] = [];
  do {
    const resp = await vectors.send(
      new ListVectorsCommand({
        vectorBucketName: VectorBucketName,
        indexName: VectorIndexName,
        nextToken,
        returnMetadata: true,
      }),
    );
    for (const v of resp.vectors ?? []) {
      if (v.key) {
        const meta = v.metadata as Record<string, any> | undefined;
        if (meta?.documentId === documentId) {
          vectorKeys.push(v.key);
        }
      }
    }
    nextToken = resp.nextToken;
  } while (nextToken);

  if (vectorKeys.length === 0) return;

  for (let i = 0; i < vectorKeys.length; i += 100) {
    const batch = vectorKeys.slice(i, i + 100);
    await vectors.send(
      new DeleteVectorsCommand({
        vectorBucketName: VectorBucketName,
        indexName: VectorIndexName,
        keys: batch,
      }),
    );
  }
  console.log(`[cleanup-adapter] Deleted ${vectorKeys.length} vectors`);
}

async function deleteS3Prefix(prefix: string) {
  let continuationToken: string | undefined;
  let count = 0;
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
    count += objects.length;
    continuationToken = list.IsTruncated
      ? list.NextContinuationToken
      : undefined;
  } while (continuationToken);
  console.log(`[cleanup-adapter] Deleted ${count} objects from ${prefix}`);
}

async function deleteDynamoRecord(documentId: string) {
  await dynamo.send(
    new DeleteCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  console.log(`[cleanup-adapter] Deleted DynamoDB record for ${documentId}`);
}
