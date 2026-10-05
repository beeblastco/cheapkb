import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { S3Event } from "aws-lambda";
import type { ChunkItem, DocumentRow } from "../types";
import {
  deleteDocumentChunkRecords,
  deleteDocumentS3Data,
  deleteDocumentVectors,
  deleteS3Prefix,
  dynamo,
  getDocument,
  updateStorageBytes,
} from "../utils";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const TableName = process.env.TABLE_NAME!;
const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;

/** S3 ObjectRemoved handler for raw/ objects; deletes the document's vectors, data and records. */
export async function handler(event: S3Event): Promise<void> {
  for (const record of event.Records ?? []) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const parts = key.split("/");
    if (parts.length < 3 || parts[0] !== "raw") {
      console.log(`[cleanup-adapter] Skipping non-raw object: ${key}`);
      continue;
    }
    const [, documentId] = parts;
    console.log(`[cleanup-adapter] Cleaning up document ${documentId}`);
    const document = await getDocument(documentId, dynamo, TableName);
    // S3 can deliver a removal after the same key was uploaded again, so a live
    // document is only cleaned up once its object is gone and no upload is reserved.
    let countedBytes = document?.countedBytes;
    if (document && document.status !== "DELETING") {
      const marked = (await objectExists(key))
        ? null
        : await markDeleting(documentId);
      if (!marked) {
        console.log(`[cleanup-adapter] Skipping stale removal for ${key}`);
        continue;
      }
      ({ countedBytes } = marked);
    }

    // The three deletes are independent, so they run together and every
    // failure is still reported.
    const [vectorResult, derivedResult, rawResult] = await Promise.allSettled([
      deleteDocumentVectors(
        documentId,
        dynamo,
        vectors,
        TableName,
        VectorBucketName,
        VectorIndexName,
      ),
      deleteDocumentS3Data(documentId, s3, StorageBucketName),
      deleteS3Prefix(`raw/${documentId}/`, s3, StorageBucketName),
    ]);
    const errors: string[] = [];
    let chunkItems: ChunkItem[] = [];
    if (vectorResult.status === "fulfilled") {
      chunkItems = vectorResult.value;
    } else {
      errors.push(`vectors: ${(vectorResult.reason as Error).message}`);
      console.error(
        `[cleanup-adapter] vector delete failed:`,
        vectorResult.reason,
      );
    }
    if (derivedResult.status === "rejected") {
      errors.push(`derived data: ${(derivedResult.reason as Error).message}`);
      console.error(
        `[cleanup-adapter] derived data delete failed:`,
        derivedResult.reason,
      );
    }
    if (rawResult.status === "fulfilled") {
      console.log(
        `[cleanup-adapter] Deleted ${rawResult.value} objects from raw/${documentId}/`,
      );
    } else {
      errors.push(`raw: ${(rawResult.reason as Error).message}`);
      console.error(`[cleanup-adapter] raw delete failed:`, rawResult.reason);
    }

    if (errors.length > 0) {
      console.log(
        `[cleanup-adapter] Completed ${documentId} with errors: ${errors.join("; ")}`,
      );
      throw new Error(errors.join("; "));
    }

    if (document && countedBytes) {
      await updateStorageBytes(
        document.userId,
        AccountsTableName,
        -countedBytes,
        `delete:${documentId}`,
      );
    }
    await deleteDynamoRecords(documentId, chunkItems, document);
    console.log(`[cleanup-adapter] Completed cleanup for ${documentId}`);
  }
}

/** Deletes the chunk rows, dedupe row and META row of a cleaned-up document. */
async function deleteDynamoRecords(
  documentId: string,
  chunkItems: ChunkItem[],
  document: DocumentRow | null,
): Promise<void> {
  await deleteDocumentChunkRecords(chunkItems, dynamo, TableName);
  if (document) {
    await dynamo.send(
      new DeleteCommand({
        TableName: TableName,
        Key: {
          pk: `USER#${document.userId}`,
          sk: `DOCUMENT#${document.dedupeKey}`,
        },
      }),
    );
  }
  await dynamo.send(
    new DeleteCommand({
      TableName: TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  console.log(`[cleanup-adapter] Deleted DynamoDB record for ${documentId}`);
}

/** Marks the document DELETING so pipeline stages stop writing to it, and returns the
 * counted bytes it now refunds, which nothing changes after the mark. Returns null while
 * a replacement upload is reserved, since upload cannot reserve a DELETING one. */
async function markDeleting(
  documentId: string,
): Promise<{ countedBytes?: number } | null> {
  const now = new Date().toISOString();
  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression: "SET #s = :s, updatedAt = :t",
        ConditionExpression:
          "attribute_exists(pk) AND (attribute_not_exists(replacementToken) OR replacementExpiresAt < :t)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "DELETING",
          ":t": now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return {
      countedBytes: (result.Attributes as DocumentRow | undefined)
        ?.countedBytes,
    };
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
  // Only a document that is gone may still be cleaned up; whoever removed it refunded it.
  const document = await getDocument(documentId, dynamo, TableName);

  return document ? null : {};
}

/** Reports whether the removed object has been uploaded again since the event. */
async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(
      new HeadObjectCommand({ Bucket: StorageBucketName, Key: key }),
    );
    return true;
  } catch (error) {
    if ((error as Error).name === "NotFound") return false;
    throw error;
  }
}
