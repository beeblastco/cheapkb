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
const UPDATING_STATUS = "UPDATING";
// A handler killed mid-propagation cannot release its lease, so an abandoned
// one must expire or the document stays uneditable. It times out at 60s.
const LEASE_TTL_MS = 5 * 60 * 1000;
// Two S3 calls per chunk against a 200-chunk ceiling would not finish inside the
// timeout if run one at a time.
const CHUNK_REWRITE_CONCURRENCY = 8;

interface Lease {
  restoreTo: string;
  heldSince: string;
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
  } catch (err) {
    return json(400, { error: `Invalid JSON: ${(err as Error).message}` });
  }

  const validationError = validateBody(body);
  if (validationError) return json(400, { error: validationError });

  const document = await getDocument(documentId, dynamo, TableName);
  if (!document) return json(404, { error: "Document not found" });
  if (document.userId !== userId) {
    return json(404, { error: "Document not found" });
  }
  if (!isEditable(document)) {
    return json(409, {
      error: `Cannot edit metadata while the document is ${document.status}`,
    });
  }

  const tags = normalizeTags(body.tags);
  // Held across propagation to serialize edits: a revision check alone lets one
  // that read mid-propagation pass and split chunks between two edits' tags.
  const lease = await acquireLease(document, userId);
  if (!lease) {
    return json(409, { error: "Document changed while updating; retry" });
  }

  try {
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

    const updatedAt = await finalizeLease(document, lease, tags);
    return json(200, {
      documentId,
      tags,
      updatedVectors,
      updatedAt,
    });
  } catch (error) {
    // The META row still holds the old tags, so releasing the lease reports the
    // edit as not applied. Retrying re-propagates and converges.
    await releaseLease(document, lease);
    return json(500, { error: "Failed to update document tags" });
  }
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isEditable(document: any): boolean {
  if (EDITABLE_STATUSES.has(document.status)) return true;
  return isLeaseExpired(document);
}

// An UPDATING row whose lease has outlived the function's own timeout belongs to
// a handler that died before releasing it, so it is safe to take over.
function isLeaseExpired(document: any): boolean {
  if (document.status !== UPDATING_STATUS) return false;
  const heldSince = Date.parse(document.updatedAt ?? "");
  return !Number.isFinite(heldSince) || Date.now() - heldSince > LEASE_TTL_MS;
}

// Returns the lease, or null if it was not taken. updatedAt doubles as the
// revision token and the lease timestamp.
async function acquireLease(
  document: any,
  userId: string,
): Promise<Lease | null> {
  // Taking over an expired lease must not restore UPDATING as a real status;
  // the dead handler recorded what it displaced.
  const restoreTo =
    document.status === UPDATING_STATUS
      ? (document.previousStatus ?? "EMBEDDED")
      : document.status;
  const revisionMatches = document.updatedAt
    ? "updatedAt = :revision"
    : "attribute_not_exists(updatedAt)";
  const heldSince = new Date().toISOString();

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: document.pk, sk: document.sk },
        // gsi1pk mirrors status everywhere else in the pipeline; leaving it
        // behind would hand a stale status to the first query that uses it.
        UpdateExpression:
          "SET #s = :updating, gsi1pk = :gsi1pk, gsi1sk = :now, previousStatus = :restoreTo, updatedAt = :now",
        ConditionExpression: `userId = :userId AND #s = :expected AND ${revisionMatches}`,
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":updating": UPDATING_STATUS,
          ":gsi1pk": `STATUS#${UPDATING_STATUS}`,
          ":restoreTo": restoreTo,
          ":now": heldSince,
          ":userId": userId,
          ":expected": document.status,
          ...(document.updatedAt ? { ":revision": document.updatedAt } : {}),
        },
      }),
    );
    return { restoreTo, heldSince };
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return null;
    throw error;
  }
}

// Tags land only once every store agreed, so a failure leaves the row reporting
// the edit as not applied rather than advertising tags the vectors lack.
async function finalizeLease(
  document: any,
  lease: Lease,
  tags: string[] | null,
): Promise<string> {
  const now = new Date().toISOString();
  await releaseWith(
    document,
    lease,
    "SET tags = :tags, #s = :restoreTo, gsi1pk = :gsi1pk, gsi1sk = :now, updatedAt = :now REMOVE previousStatus",
    { ":tags": tags, ":now": now },
  );
  return now;
}

async function releaseLease(document: any, lease: Lease) {
  try {
    await releaseWith(
      document,
      lease,
      "SET #s = :restoreTo, gsi1pk = :gsi1pk, gsi1sk = :now, updatedAt = :now REMOVE previousStatus",
      { ":now": new Date().toISOString() },
    );
  } catch {
    // The original failure is the one worth reporting; an unreleased lease
    // expires on its own.
  }
}

// Conditioned on the lease still being ours: a successor that took over an
// expired lease is also UPDATING, so status alone would let us clobber it.
async function releaseWith(
  document: any,
  lease: Lease,
  updateExpression: string,
  values: Record<string, unknown>,
) {
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: document.pk, sk: document.sk },
      UpdateExpression: updateExpression,
      ConditionExpression: "#s = :updating AND updatedAt = :heldSince",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ...values,
        ":restoreTo": lease.restoreTo,
        ":gsi1pk": `STATUS#${lease.restoreTo}`,
        ":updating": UPDATING_STATUS,
        ":heldSince": lease.heldSince,
      },
    }),
  );
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
  if (body.tags === undefined) return "Tags is required";
  if (body.tags !== null && !isShortStringArray(body.tags)) {
    return "Tags must be an array of at most 20 strings, each 100 characters or fewer";
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
