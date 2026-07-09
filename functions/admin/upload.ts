import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { Resource } from "sst";

const s3 = new S3Client({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = Resource.Meta.name;

export async function handler(event: any) {
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

  const documentId = `doc_${randomUUID()}`;
  const filename = body.filename ?? `${documentId}.pdf`;
  const mimeType = body.mimeType ?? "application/pdf";
  const sourceKey = `raw/${documentId}/${filename}`;
  const now = new Date().toISOString();

  await dynamo.send(
    new PutCommand({
      TableName,
      Item: {
        pk: `DOC#${documentId}`,
        sk: "META",
        entityType: "Document",
        documentId,
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
      },
    }),
  );

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: Resource.Storage.name,
      Key: sourceKey,
      ContentType: mimeType,
    }),
    { expiresIn: 900 },
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, uploadUrl, sourceKey }),
  };
}
