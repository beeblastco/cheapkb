import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import type { Conditions } from "@aws-sdk/s3-presigned-post/dist-types/types";
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { createHash, randomUUID } from "node:crypto";
import type { DocumentRow } from "../types";
import {
  checkRateLimit,
  checkUsageLimit,
  docId,
  dynamo,
  extractUserId,
  getDocument,
  isDocumentInFlight,
  isShortStringArray,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_METADATA_BYTES,
  MAX_UPLOAD_BYTES,
  metadataBytes,
  recordUsage,
  REPLACEMENT_TTL_MS,
} from "../utils";

const s3 = new S3Client({});
const TableName = process.env.TABLE_NAME!;
const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;
const RateLimitsTableName = process.env.RATE_LIMITS_TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const MAX_STORAGE_BYTES = parseInt(
  process.env.MAX_STORAGE_BYTES ?? "1073741824",
  10,
);
// Bounds GET /documents, which reads every document, and one account's share of
// the pipeline queue.
const MAX_DOCUMENTS = 1000;
const MAX_IN_FLIGHT_DOCUMENTS = 10;
// Uploads that lose the account's uploadSeq race recount and retry this many times.
const MAX_COMMIT_ATTEMPTS = 3;
// GSI2 can trail a commit, so the account row also lists commits this recent.
const RECENT_UPLOAD_WINDOW_MS = 30_000;
const COMMIT_RETRY_BACKOFF_MS = 50;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/markdown",
  "text/plain",
]);
const REPLACEABLE_STATUSES = new Set(["EMBEDDED", "FAILED"]);

/** POST /upload: creates or reserves a document and returns a presigned S3 POST for its source. */
export async function handler(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<{ userId: string }>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, response: authError } = extractUserId(event);
  if (authError) return authError;

  const { allowed, remaining } = await checkRateLimit(
    userId,
    RateLimitsTableName,
    "UPLOAD",
    50,
    50,
  );
  if (!allowed) {
    return {
      statusCode: 429,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": String(remaining),
      },
      body: JSON.stringify({
        error: "Rate limit exceeded. Try again later.",
      }),
    };
  }

  const { allowed: usageAllowed } = await checkUsageLimit(
    userId,
    AccountsTableName,
  );
  if (!usageAllowed) {
    return {
      statusCode: 429,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Monthly usage allowance reached. Upgrade to continue.",
      }),
    };
  }

  if (!event.body) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Request body is required" }),
    };
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body) as Record<string, unknown>;
  } catch (err) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: `Invalid JSON: ${(err as Error).message}`,
      }),
    };
  }

  const validationError = validateBody(body);
  if (validationError) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: validationError }),
    };
  }

  const mimeType = body.mimeType as string;
  const maxUploadBytes = mimeType.startsWith("image/")
    ? MAX_IMAGE_UPLOAD_BYTES
    : MAX_UPLOAD_BYTES;

  try {
    const filename = sanitizeFilename(body.filename as string);
    const dedupeKey = createDedupeKey(userId, filename, mimeType);
    const mapping = await dynamo.send(
      new GetCommand({
        TableName: TableName,
        Key: { pk: `USER#${userId}`, sk: `DOCUMENT#${dedupeKey}` },
        ConsistentRead: true,
      }),
    );
    const now = new Date().toISOString();
    let document: DocumentRow | null = null;
    if (mapping?.Item) {
      document = await getDocument(mapping.Item.documentId, dynamo, TableName);
      if (!document) return conflictResponse("Document mapping is invalid");
      if (!REPLACEABLE_STATUSES.has(document.status)) {
        return conflictResponse("Document is being processed");
      }
    }
    const documentId: string =
      mapping?.Item?.documentId ?? `doc_${randomUUID()}`;
    const sourceKey = document
      ? (document.sourceKey ?? "")
      : `raw/${documentId}/${filename}`;
    const replacementToken = randomUUID();

    const refusal = await commitWithinCaps(
      userId,
      documentId,
      !document,
      (seenSeq, recentUploads): Promise<"busy" | "committed" | "conflict"> =>
        document
          ? reserveReplacement(
              document,
              replacementToken,
              filename,
              body,
              now,
              seenSeq,
              recentUploads,
            )
          : createDocument(
              documentId,
              userId,
              filename,
              mimeType,
              dedupeKey,
              sourceKey,
              body,
              now,
              seenSeq,
              recentUploads,
            ),
    );
    if (refusal) return refusal;

    const fields: Record<string, string> = { "Content-Type": mimeType };
    const conditions: Conditions[] = [
      ["content-length-range", 1, maxUploadBytes],
      ["eq", "$Content-Type", mimeType],
    ];
    if (document) {
      fields["x-amz-meta-upload-token"] = replacementToken;
      conditions.push(["eq", "$x-amz-meta-upload-token", replacementToken]);
    }

    const upload = await createPresignedPost(s3, {
      Bucket: StorageBucketName,
      Key: sourceKey,
      Fields: fields,
      Conditions: conditions,
      Expires: 900,
    });

    await recordUsage(userId, AccountsTableName, "upload", 1);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": String(remaining),
      },
      body: JSON.stringify({
        documentId: documentId,
        uploadUrl: upload.url,
        uploadFields: upload.fields,
        sourceKey: sourceKey,
        maxUploadBytes: maxUploadBytes,
        reused: Boolean(document),
      }),
    };
  } catch (error) {
    console.error("Upload handler error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "An unexpected error occurred. Please try again.",
      }),
    };
  }
}

/** Returns the 429 body when the account is at its storage or in-flight cap, or at its
 * document cap for a new document, else null. Used by commitWithinCaps before each write. */
async function checkAccountLimits(
  userId: string,
  storageBytes: number,
  isNew: boolean,
  recentUploads: Record<string, number>,
): Promise<{ error: string; code?: string } | null> {
  // Bytes are counted when S3 accepts a file, so an account can pass the cap by
  // the uploads already in flight: at most MAX_IN_FLIGHT_DOCUMENTS of them.
  if (storageBytes >= MAX_STORAGE_BYTES) {
    return { error: "Storage limit reached. Delete documents to upload more." };
  }
  const nowMs = Date.now();
  // Recent commits are in flight by definition; the sets merge them with what GSI2 already shows.
  const documentIds = new Set(Object.keys(recentUploads));
  const inFlightIds = new Set(Object.keys(recentUploads));
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TableName,
        IndexName: "GSI2",
        KeyConditionExpression: "gsi2pk = :pk",
        ProjectionExpression: "pk, #s, updatedAt, replacementExpiresAt",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":pk": `USER#${userId}` },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result.Items ?? []) {
      const documentId = docId(String(item.pk));
      documentIds.add(documentId);
      if (isDocumentInFlight(item, nowMs)) inFlightIds.add(documentId);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  if (isNew && documentIds.size >= MAX_DOCUMENTS) {
    return {
      error: "Document limit reached. Delete documents to upload more.",
    };
  }
  if (inFlightIds.size >= MAX_IN_FLIGHT_DOCUMENTS) {
    // DocumentsCard's bulk sync waits and retries on this code.
    return {
      error: "Too many documents processing. Try again when they finish.",
      code: "PROCESSING_LIMIT",
    };
  }

  return null;
}

/** Counts the account's documents and runs the write, which commits only while uploadSeq
 * still holds the value read before the count. Returns the refusal response, or null on commit. */
async function commitWithinCaps(
  userId: string,
  documentId: string,
  isNew: boolean,
  write: (
    seenSeq: number,
    recentUploads: Record<string, number>,
  ) => Promise<"busy" | "committed" | "conflict">,
): Promise<APIGatewayProxyStructuredResultV2 | null> {
  // A commit between the count and the write moves uploadSeq, so concurrent uploads cannot both
  // pass the caps. Each commit also lands in recentUploads, which covers GSI2 replication lag.
  // Storage is read in the same consistent read, which bounds the overshoot (proofs/UploadCaps.lean).
  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const account = await dynamo.send(
      new GetCommand({
        TableName: AccountsTableName,
        Key: { pk: `ACCOUNT#${userId}`, sk: "PROFILE" },
        ProjectionExpression: "uploadSeq, recentUploads, storageBytes",
        ConsistentRead: true,
      }),
    );
    const seenSeq: number = account.Item?.uploadSeq ?? 0;
    const storageBytes: number = account.Item?.storageBytes ?? 0;
    const nowMs = Date.now();
    const recentUploads = Object.fromEntries(
      Object.entries(
        (account.Item?.recentUploads ?? {}) as Record<string, number>,
      ).filter(([, at]) => nowMs - at < RECENT_UPLOAD_WINDOW_MS),
    );
    const limitError = await checkAccountLimits(
      userId,
      storageBytes,
      isNew,
      recentUploads,
    );
    if (limitError) {
      return {
        statusCode: 429,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(limitError),
      };
    }
    const outcome = await write(seenSeq, {
      ...recentUploads,
      [documentId]: nowMs,
    });
    if (outcome === "committed") return null;
    if (outcome === "conflict") {
      return conflictResponse(
        isNew ? "Document is being uploaded" : "Document is being processed",
      );
    }
    if (attempt + 1 < MAX_COMMIT_ATTEMPTS) {
      await new Promise((resolve) => {
        setTimeout(
          resolve,
          (attempt + 1 + Math.random()) * COMMIT_RETRY_BACKOFF_MS,
        );
      });
    }
  }

  // DocumentsCard's bulk sync waits and retries on this code.
  return {
    statusCode: 429,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      error: "Too many uploads at once. Try again shortly.",
      code: "PROCESSING_LIMIT",
    }),
  };
}

/** Writes the dedupe mapping, META row and account uploadSeq together. Returns "conflict"
 * when the file is already being uploaded, "busy" when another upload moved uploadSeq. */
async function createDocument(
  documentId: string,
  userId: string,
  filename: string,
  mimeType: string,
  dedupeKey: string,
  sourceKey: string,
  body: Record<string, unknown>,
  now: string,
  seenSeq: number,
  recentUploads: Record<string, number>,
): Promise<"busy" | "committed" | "conflict"> {
  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TableName,
              Item: {
                pk: `USER#${userId}`,
                sk: `DOCUMENT#${dedupeKey}`,
                documentId: documentId,
                createdAt: now,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: TableName,
              Item: {
                pk: `DOC#${documentId}`,
                sk: "META",
                userId: userId,
                filename: filename,
                dedupeKey: dedupeKey,
                title: body.title ?? filename,
                sourceKey: sourceKey,
                mimeType: mimeType,
                status: "UPLOADED",
                tags: body.tags ?? null,
                authors: body.authors ?? null,
                year: body.year ?? null,
                createdAt: now,
                updatedAt: now,
                gsi2pk: `USER#${userId}`,
                gsi2sk: now,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Update: {
              TableName: AccountsTableName,
              Key: { pk: `ACCOUNT#${userId}`, sk: "PROFILE" },
              UpdateExpression:
                "SET uploadSeq = :next, recentUploads = :recentUploads",
              ConditionExpression:
                "attribute_not_exists(uploadSeq) OR uploadSeq = :seen",
              ExpressionAttributeValues: {
                ":next": seenSeq + 1,
                ":recentUploads": recentUploads,
                ":seen": seenSeq,
              },
            },
          },
        ],
      }),
    );
    return "committed";
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) throw error;
    // The account row is last. Only a failed condition on a document item is a real conflict;
    // a lost uploadSeq race, a transaction conflict or a throttle is retried.
    const reasons = error.CancellationReasons ?? [];
    const documentConflict = reasons
      .slice(0, -1)
      .some((reason) => reason.Code === "ConditionalCheckFailed");

    return reasons.length > 0 && !documentConflict ? "busy" : "conflict";
  }
}

/** Claims an existing document for a re-upload and moves the account uploadSeq. Returns "conflict"
 * when another upload holds the document or it is busy, "busy" when another upload moved uploadSeq. */
async function reserveReplacement(
  document: DocumentRow,
  replacementToken: string,
  filename: string,
  body: Record<string, unknown>,
  now: string,
  seenSeq: number,
  recentUploads: Record<string, number>,
): Promise<"busy" | "committed" | "conflict"> {
  const replacementExpiresAt = new Date(
    Date.now() + REPLACEMENT_TTL_MS,
  ).toISOString();

  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TableName,
              Key: { pk: document.pk, sk: document.sk },
              UpdateExpression:
                "SET replacementToken = :token, replacementExpiresAt = :expires, replacementPreviousStatus = :previous, pendingFilename = :filename, pendingTitle = :title, pendingTags = :tags, pendingAuthors = :authors, pendingYear = :year, updatedAt = :now",
              ConditionExpression:
                "userId = :userId AND #s = :expected AND (attribute_not_exists(replacementToken) OR replacementExpiresAt < :now)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":token": replacementToken,
                ":expires": replacementExpiresAt,
                ":previous": document.status,
                ":filename": filename,
                ":title": body.title ?? filename,
                ":tags": body.tags ?? null,
                ":authors": body.authors ?? null,
                ":year": body.year ?? null,
                ":now": now,
                ":userId": document.userId,
                ":expected": document.status,
              },
            },
          },
          {
            Update: {
              TableName: AccountsTableName,
              Key: { pk: `ACCOUNT#${document.userId}`, sk: "PROFILE" },
              UpdateExpression:
                "SET uploadSeq = :next, recentUploads = :recentUploads",
              ConditionExpression:
                "attribute_not_exists(uploadSeq) OR uploadSeq = :seen",
              ExpressionAttributeValues: {
                ":next": seenSeq + 1,
                ":recentUploads": recentUploads,
                ":seen": seenSeq,
              },
            },
          },
        ],
      }),
    );
    return "committed";
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) throw error;
    // The account row is last. Only a failed condition on a document item is a real conflict;
    // a lost uploadSeq race, a transaction conflict or a throttle is retried.
    const reasons = error.CancellationReasons ?? [];
    const documentConflict = reasons
      .slice(0, -1)
      .some((reason) => reason.Code === "ConditionalCheckFailed");

    return reasons.length > 0 && !documentConflict ? "busy" : "conflict";
  }
}

function conflictResponse(error: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 409,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: error }),
  };
}

function createDedupeKey(
  userId: string,
  filename: string,
  mimeType: string,
): string {
  return createHash("sha256")
    .update(`${userId}\0${filename}\0${mimeType}`)
    .digest("hex");
}

/** Feeds the S3 key and the dedupe key. Unicode letters, marks and digits are kept so
 * distinct non-ASCII names stay distinct; an ASCII name maps exactly as before. */
function sanitizeFilename(filename: string): string {
  return filename
    .trim()
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}._-]/gu, "_");
}

/** Returns a validation message for a bad upload body, or null when it is valid. */
function validateBody(body: Record<string, unknown>): string | null {
  // JSON.parse("null") and "[]" both succeed, so reading body.filename off the
  // result would throw and surface as a 500 instead of a validation error.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be an object";
  }
  const { filename } = body;
  if (typeof filename !== "string" || !filename.trim()) {
    return "Filename is required";
  }
  // NFC can lengthen a name, so the bound holds after normalizing to keep the S3 key short.
  if (filename.normalize("NFC").length > 255) {
    return "Filename must be 255 characters or fewer";
  }
  const { mimeType } = body;
  if (typeof mimeType !== "string" || !ALLOWED_MIME_TYPES.has(mimeType)) {
    return `MIME type must be one of: ${[...ALLOWED_MIME_TYPES].join(", ")}`;
  }
  if (body.title !== undefined && typeof body.title !== "string") {
    return "Title must be a string";
  }
  if (typeof body.title === "string" && body.title.length > 200) {
    return "Title must be 200 characters or fewer";
  }
  if (body.tags !== undefined && !isShortStringArray(body.tags)) {
    return "Tags must be an array of at most 20 strings, each 100 characters or fewer";
  }
  if (body.authors !== undefined && !isShortStringArray(body.authors)) {
    return "Authors must be an array of at most 20 strings, each 100 characters or fewer";
  }
  if (
    body.year !== undefined &&
    (typeof body.year !== "number" ||
      !Number.isInteger(body.year) ||
      body.year < 1000 ||
      body.year > 9999)
  ) {
    return "Year must be an integer from 1000 to 9999";
  }
  // A missing title falls back to the filename, so that is what gets stored.
  const title = body.title ?? body.filename;
  if (metadataBytes(title, body.tags, body.authors) > MAX_METADATA_BYTES) {
    return `Title, tags and authors together must be ${MAX_METADATA_BYTES} bytes or fewer`;
  }
  return null;
}
