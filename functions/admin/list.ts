import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = Resource.Meta.name;

const STATUSES = [
  "UPLOADED",
  "QUEUED",
  "PARSING",
  "PARSED",
  "CHUNKING",
  "CHUNKED",
  "EMBEDDING",
  "EMBEDDED",
  "FAILED",
];

export async function handler() {
  const results = await Promise.all(
    STATUSES.map((status) =>
      dynamo.send(
        new QueryCommand({
          TableName,
          IndexName: "GSI1",
          KeyConditionExpression: "gsi1pk = :pk",
          ExpressionAttributeValues: { ":pk": `STATUS#${status}` },
        }),
      ),
    ),
  );

  const documents = results
    .flatMap((res) => res.Items ?? [])
    .map((doc) => ({
      documentId: doc.documentId,
      title: doc.title,
      status: doc.status,
      lastError: doc.lastError ?? null,
      retryCount: doc.retryCount ?? 0,
      failedStep: doc.failedStep ?? null,
      mimeType: doc.mimeType,
      tags: doc.tags,
      authors: doc.authors,
      year: doc.year,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count: documents.length, documents }),
  };
}
