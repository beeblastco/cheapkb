import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  extractUserId,
  getDocument,
  listDocumentChunkItems,
  retagDocumentVectors,
} from "../utils";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;

// Tags are copied into vectors while the pipeline runs, so editing mid-flight
// would race the pipeline and lose either the edit or the chunk it was applied
// to. Only settled documents can be retagged.
const EDITABLE_STATUSES = new Set(["EMBEDDED", "FAILED", "CHUNKED", "PARSED"]);

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function handler(event: any) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const documentId = event.pathParameters?.id;
  if (!documentId) return json(400, { error: "Document ID is required" });

  if (!event.body) return json(400, { error: "Request body is required" });
  let body: any;
  try {
    body = JSON.parse(event.body);
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const validationError = validateBody(body);
  if (validationError) return json(400, { error: validationError });

  const document = await getDocument(documentId, dynamo, TableName);
  if (!document) return json(404, { error: "Document not found" });
  if (document.userId !== userId) {
    return json(403, { error: "You do not have access to this document" });
  }
  if (!EDITABLE_STATUSES.has(document.status)) {
    return json(409, {
      error: `Cannot edit metadata while the document is ${document.status}`,
    });
  }

  const tags = normalizeTags(body.tags);
  const now = new Date().toISOString();

  // The META row is the source of truth for a re-chunk, the S3 chunk JSON for a
  // re-embed, and the vector metadata for search. All three must agree, or a
  // later reindex silently restores the previous tags.
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression: "SET tags = :tags, updatedAt = :now",
        ConditionExpression: "userId = :userId AND #s = :expected",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":tags": tags,
          ":now": now,
          ":userId": userId,
          ":expected": document.status,
        },
      }),
    );
  } catch (error) {
    // The pipeline moved the document between the read above and this write, so
    // the edit would be racing it after all.
    if (error instanceof ConditionalCheckFailedException) {
      return json(409, {
        error: "Document changed while updating; retry the edit",
      });
    }
    throw error;
  }

  const chunkItems = await listDocumentChunkItems(
    documentId,
    dynamo,
    TableName,
  );
  await updateChunkObjects(chunkItems, tags);
  const updatedVectors = await retagDocumentVectors(
    chunkItems,
    tags,
    vectors,
    VectorBucketName,
    VectorIndexName,
  );

  return json(200, {
    documentId,
    tags: tags ?? [],
    updatedVectors,
    updatedAt: now,
  });
}

async function updateChunkObjects(chunkItems: any[], tags: string[] | null) {
  for (const item of chunkItems) {
    if (!item.s3ChunkKey) continue;
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: StorageBucketName,
        Key: item.s3ChunkKey,
      }),
    );
    const chunkData = JSON.parse(await response.Body!.transformToString());
    await s3.send(
      new PutObjectCommand({
        Bucket: StorageBucketName,
        Key: item.s3ChunkKey,
        Body: JSON.stringify({ ...chunkData, tags }),
        ContentType: "application/json",
      }),
    );
  }
}

function normalizeTags(tags: unknown): string[] | null {
  if (!Array.isArray(tags)) return null;
  const deduped = new Map<string, string>();
  for (const tag of tags as string[]) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    // First occurrence wins, so the casing the user picked first is the casing
    // that survives a case-insensitive duplicate.
    const key = trimmed.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, trimmed);
  }
  return deduped.size > 0 ? [...deduped.values()] : null;
}

function validateBody(body: any): string | null {
  if (body.tags === undefined) return "tags is required";
  if (body.tags !== null && !isShortStringArray(body.tags)) {
    return "tags must be an array of short strings";
  }
  return null;
}

function isShortStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every((item) => typeof item === "string" && item.length <= 100)
  );
}
