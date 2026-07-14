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
} from "../utils";

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
    const document = await getDocument(documentId);

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
      console.error(`[cleanup-adapter] vector delete failed:`, err);
    }
    try {
      await deleteDocumentS3Data(documentId, s3, StorageBucketName);
    } catch (err: any) {
      errors.push(`derived data: ${err.message}`);
      console.error(`[cleanup-adapter] derived data delete failed:`, err);
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
      await deleteDynamoRecords(documentId, chunkItems, document);
    } catch (err: any) {
      console.error(`[cleanup-adapter] dynamo delete failed:`, err);
      throw err;
    }
    console.log(`[cleanup-adapter] Completed cleanup for ${documentId}`);
  }
}

async function getDocument(documentId: string) {
  const result = await dynamo.send(
    new GetCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  return result.Item ?? null;
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

async function deleteDynamoRecords(
  documentId: string,
  chunkItems: any[],
  document: any,
) {
  await deleteDocumentChunkRecords(chunkItems, dynamo, TableName);
  if (document) {
    await dynamo.send(
      new DeleteCommand({
        TableName,
        Key: {
          pk: `USER#${document.userId}`,
          sk: `DOCUMENT#${document.dedupeKey}`,
        },
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
