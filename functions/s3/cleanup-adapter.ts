import type { S3Event } from "aws-lambda";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { ChunkItem, DocumentRow } from "../types";
import {
  deleteDocumentChunkRecords,
  deleteDocumentS3Data,
  deleteDocumentVectors,
  deleteS3Prefix,
  getDocument,
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

export async function handler(event: S3Event) {
  for (const record of event.Records ?? []) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const parts = key.split("/");
    if (parts.length < 3 || parts[0] !== "raw") {
      console.log(`[cleanup-adapter] Skipping non-raw object: ${key}`);
      continue;
    }
    const documentId = parts[1];
    console.log(`[cleanup-adapter] Cleaning up document ${documentId}`);
    const document = await getDocument(documentId, dynamo, TableName);
    if (document && document.status !== "DELETING") {
      await markDeleting(documentId);
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
      errors.push(`vectors: ${(err as Error).message}`);
      console.error(`[cleanup-adapter] vector delete failed:`, err);
    }
    try {
      await deleteDocumentS3Data(documentId, s3, StorageBucketName);
    } catch (err) {
      errors.push(`derived data: ${(err as Error).message}`);
      console.error(`[cleanup-adapter] derived data delete failed:`, err);
    }
    try {
      const removed = await deleteS3Prefix(
        `raw/${documentId}/`,
        s3,
        StorageBucketName,
      );
      console.log(
        `[cleanup-adapter] Deleted ${removed} objects from raw/${documentId}/`,
      );
    } catch (err) {
      errors.push(`raw: ${(err as Error).message}`);
      console.error(`[cleanup-adapter] raw delete failed:`, err);
    }

    if (errors.length > 0) {
      console.log(
        `[cleanup-adapter] Completed ${documentId} with errors: ${errors.join("; ")}`,
      );
      throw new Error(errors.join("; "));
    }

    try {
      if (document?.countedBytes) {
        await updateStorageBytes(
          document.userId,
          AccountsTableName,
          -document.countedBytes,
          `delete:${documentId}`,
        );
      }
      await deleteDynamoRecords(documentId, chunkItems, document);
    } catch (err) {
      console.error(`[cleanup-adapter] dynamo delete failed:`, err);
      throw err;
    }
    console.log(`[cleanup-adapter] Completed cleanup for ${documentId}`);
  }
}

async function deleteDynamoRecords(
  documentId: string,
  chunkItems: ChunkItem[],
  document: DocumentRow | null,
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

// Pipeline stages refuse to write to a DELETING document, so a vector written
// during this cleanup cannot stay searchable.
async function markDeleting(documentId: string) {
  const now = new Date().toISOString();
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :s, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :t",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":gsi1pk": "STATUS#DELETING",
          ":s": "DELETING",
          ":t": now,
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}
