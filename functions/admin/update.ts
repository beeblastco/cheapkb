import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
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

// A running pipeline copies tags into chunks itself, so an edit mid-flight
// would race it. Only settled documents can be retagged.
const EDITABLE_STATUSES = new Set(["EMBEDDED", "FAILED", "CHUNKED", "PARSED"]);
// Two S3 calls per chunk against a 200-chunk ceiling would not finish inside the
// timeout if run one at a time.
const CHUNK_REWRITE_CONCURRENCY = 8;

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
  const claimed = await claimDocument(document, userId, tags, now);
  if (!claimed) {
    return json(409, { error: "Document changed while updating; retry" });
  }

  // Tags live in the META row, the chunk JSON a re-embed reads, and the vector
  // metadata search filters on. All three must agree or a reindex undoes this.
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

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Uses updatedAt as a revision token: conditioning on status alone would let two
// concurrent edits both pass and interleave their S3 and vector writes.
async function claimDocument(
  document: any,
  userId: string,
  tags: string[] | null,
  now: string,
): Promise<boolean> {
  const revisionMatches = document.updatedAt
    ? "updatedAt = :revision"
    : "attribute_not_exists(updatedAt)";

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: document.pk, sk: document.sk },
        UpdateExpression: "SET tags = :tags, updatedAt = :now",
        ConditionExpression: `userId = :userId AND #s = :expected AND ${revisionMatches}`,
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":tags": tags,
          ":now": now,
          ":userId": userId,
          ":expected": document.status,
          ...(document.updatedAt ? { ":revision": document.updatedAt } : {}),
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

async function updateChunkObjects(chunkItems: any[], tags: string[] | null) {
  const pending = chunkItems.filter((item) => item.s3ChunkKey);
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      const item = pending[cursor++];
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

  await Promise.all(
    Array.from(
      { length: Math.min(CHUNK_REWRITE_CONCURRENCY, pending.length) },
      worker,
    ),
  );
}

function normalizeTags(tags: unknown): string[] | null {
  if (!Array.isArray(tags)) return null;
  const deduped = new Map<string, string>();
  for (const tag of tags as string[]) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    // First occurrence wins, so the casing the user picked first survives a
    // case-insensitive duplicate.
    const key = trimmed.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, trimmed);
  }
  return deduped.size > 0 ? [...deduped.values()] : null;
}

function validateBody(body: any): string | null {
  // JSON.parse("null") and "[]" both succeed, so reading body.tags off the
  // result would throw and surface as a 500 instead of a validation error.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be an object";
  }
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
