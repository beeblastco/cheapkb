import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { createHash, randomUUID } from "node:crypto";
import { checkRateLimit, extractUserId } from "../utils";
import { checkUsageLimit, recordUsage } from "../billing/usage";

const s3 = new S3Client({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const MAX_UPLOAD_BYTES = parseInt(
  process.env.MAX_UPLOAD_BYTES ?? "10485760",
  10,
);
const REPLACEMENT_TTL_MS = 15 * 60 * 1000;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/markdown",
  "text/plain",
]);
const REPLACEABLE_STATUSES = new Set(["EMBEDDED", "FAILED"]);

export async function handler(event: any) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const { allowed, remaining } = await checkRateLimit(
    userId,
    TableName,
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
      body: JSON.stringify({ error: "Rate limit exceeded. Try again later." }),
    };
  }

  const { allowed: usageAllowed } = await checkUsageLimit(userId, TableName);
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
  let body: any;
  try {
    body = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON in request body" }),
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

  const filename = sanitizeFilename(body.filename);
  const mimeType = body.mimeType;
  const dedupeKey = createDedupeKey(userId, filename, mimeType);
  const mappingKey = {
    pk: `USER#${userId}`,
    sk: `DOCUMENT#${dedupeKey}`,
  };
  const mapping = await dynamo.send(
    new GetCommand({ TableName, Key: mappingKey, ConsistentRead: true }),
  );
  const now = new Date().toISOString();
  let documentId: string;
  let sourceKey: string;
  let replacementToken: string | undefined;
  let reused = false;

  if (mapping?.Item) {
    documentId = mapping.Item.documentId;
    const result = await dynamo.send(
      new GetCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        ConsistentRead: true,
      }),
    );
    const document = result?.Item;
    // The mapping can outlive its META row if the document was deleted
    // concurrently; respond cleanly instead of throwing an unstructured 500.
    if (!document) return conflictResponse("Document mapping is invalid");
    if (!REPLACEABLE_STATUSES.has(document.status)) {
      return conflictResponse("Document is being processed");
    }

    replacementToken = randomUUID();
    const reserved = await reserveReplacement(
      document,
      replacementToken,
      filename,
      body,
      now,
    );
    if (!reserved) return conflictResponse("Document is being processed");
    sourceKey = document.sourceKey;
    reused = true;
  } else {
    documentId = `doc_${randomUUID()}`;
    sourceKey = `raw/${documentId}/${filename}`;
    const created = await createDocument(
      documentId,
      userId,
      filename,
      mimeType,
      dedupeKey,
      sourceKey,
      body,
      now,
    );
    if (!created) return conflictResponse("Document is being uploaded");
  }

  const fields: Record<string, string> = { "Content-Type": mimeType };
  const conditions: any[] = [
    ["content-length-range", 1, MAX_UPLOAD_BYTES],
    ["eq", "$Content-Type", mimeType],
  ];
  if (replacementToken) {
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

  await recordUsage(userId, TableName, "upload", 1);

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "X-RateLimit-Remaining": String(remaining),
    },
    body: JSON.stringify({
      documentId,
      uploadUrl: upload.url,
      uploadFields: upload.fields,
      sourceKey,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      reused,
    }),
  };
}

async function reserveReplacement(
  document: any,
  replacementToken: string,
  filename: string,
  body: any,
  now: string,
) {
  const replacementExpiresAt = new Date(
    Date.now() + REPLACEMENT_TTL_MS,
  ).toISOString();

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
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
      }),
    );
    return true;
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

async function createDocument(
  documentId: string,
  userId: string,
  filename: string,
  mimeType: string,
  dedupeKey: string,
  sourceKey: string,
  body: any,
  now: string,
) {
  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName,
              Item: {
                pk: `USER#${userId}`,
                sk: `DOCUMENT#${dedupeKey}`,
                entityType: "DocumentMapping",
                documentId,
                createdAt: now,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName,
              Item: {
                pk: `DOC#${documentId}`,
                sk: "META",
                entityType: "Document",
                documentId,
                userId,
                filename,
                dedupeKey,
                title: body.title ?? filename,
                sourceKey,
                mimeType,
                status: "UPLOADED",
                tags: body.tags ?? null,
                authors: body.authors ?? null,
                year: body.year ?? null,
                createdAt: now,
                updatedAt: now,
                gsi1pk: "STATUS#UPLOADED",
                gsi1sk: now,
                gsi2pk: `USER#${userId}`,
                gsi2sk: now,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );
    return true;
  } catch (error: any) {
    if (error.name === "TransactionCanceledException") return false;
    throw error;
  }
}

function validateBody(body: any): string | null {
  if (typeof body.filename !== "string" || !body.filename.trim()) {
    return "filename is required";
  }
  if (body.filename.length > 255) return "filename is too long";
  if (!ALLOWED_MIME_TYPES.has(body.mimeType)) return "Unsupported file type";
  if (body.title !== undefined && typeof body.title !== "string") {
    return "title must be a string";
  }
  if (body.title?.length > 200) return "title is too long";
  if (body.tags !== undefined && !isShortStringArray(body.tags)) {
    return "tags must be an array of short strings";
  }
  if (body.authors !== undefined && !isShortStringArray(body.authors)) {
    return "authors must be an array of short strings";
  }
  if (
    body.year !== undefined &&
    (!Number.isInteger(body.year) || body.year < 1000 || body.year > 9999)
  ) {
    return "year must be a four-digit integer";
  }
  return null;
}

function sanitizeFilename(filename: string): string {
  return filename.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
}

function createDedupeKey(userId: string, filename: string, mimeType: string) {
  return createHash("sha256")
    .update(`${userId}\0${filename}\0${mimeType}`)
    .digest("hex");
}

function isShortStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every((item) => typeof item === "string" && item.length <= 100)
  );
}

function conflictResponse(error: string) {
  return {
    statusCode: 409,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error }),
  };
}
