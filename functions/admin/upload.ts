import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { randomUUID } from "node:crypto";
import { checkRateLimit, extractUserId } from "../utils";

const s3 = new S3Client({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const MAX_UPLOAD_BYTES = parseInt(
  process.env.MAX_UPLOAD_BYTES ?? "10485760",
  10,
);
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/markdown",
  "text/plain",
]);

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

  const documentId = `doc_${randomUUID()}`;
  const filename = sanitizeFilename(body.filename);
  const mimeType = body.mimeType;
  const sourceKey = `raw/${documentId}/${filename}`;
  const now = new Date().toISOString();
  const upload = await createPresignedPost(s3, {
    Bucket: StorageBucketName,
    Key: sourceKey,
    Fields: { "Content-Type": mimeType },
    Conditions: [
      ["content-length-range", 1, MAX_UPLOAD_BYTES],
      ["eq", "$Content-Type", mimeType],
    ],
    Expires: 900,
  });

  await dynamo.send(
    new PutCommand({
      TableName,
      Item: {
        pk: `DOC#${documentId}`,
        sk: "META",
        entityType: "Document",
        documentId,
        userId,
        title: body.title ?? filename,
        sourceKey,
        mimeType,
        status: "UPLOADED",
        tags: body.tags,
        authors: body.authors,
        year: body.year ?? null,
        createdAt: now,
        updatedAt: now,
        gsi1pk: "STATUS#UPLOADED",
        gsi1sk: now,
        gsi2pk: `USER#${userId}`,
        gsi2sk: now,
      },
    }),
  );

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
    }),
  };
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

function isShortStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every((item) => typeof item === "string" && item.length <= 100)
  );
}
