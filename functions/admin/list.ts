import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = Resource.Meta.name;

export async function handler() {
  const scan = await dynamo.send(
    new ScanCommand({
      TableName,
      FilterExpression: "entityType = :et",
      ExpressionAttributeValues: { ":et": "Document" },
      Limit: 200,
    }),
  );
  const documents = (scan.Items ?? []).map((doc) => ({
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
  }));
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count: documents.length, documents }),
  };
}
