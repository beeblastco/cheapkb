import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { DocumentRow } from "../types";
import { docId, chunkId, extractUserId } from "../utils";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;

export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const documentId = event.pathParameters?.id;
  if (!documentId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document ID is required" }),
    };
  }

  const result = await dynamo.send(
    new GetCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  if (!result.Item) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document not found" }),
    };
  }

  if (result.Item.userId !== userId) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document not found" }),
    };
  }

  const chunksResult = await dynamo.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: {
        ":pk": `DOC#${documentId}`,
        ":sk": "CHUNK#",
      },
    }),
  );
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document: pickDocumentFields(result.Item as DocumentRow),
      chunks: (chunksResult.Items ?? []).map((c) => ({
        chunkId: chunkId(c.sk),
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        tokenCount: c.tokenCount,
        status: c.status,
      })),
      chunkCount: chunksResult.Count ?? 0,
    }),
  };
}

function pickDocumentFields(item: DocumentRow) {
  return {
    documentId: docId(item.pk),
    title: item.title,
    status: item.status,
    lastError: item.lastError ?? null,
    retryCount: item.retryCount ?? 0,
    failedStep: item.failedStep ?? null,
    mimeType: item.mimeType,
    tags: item.tags ?? null,
    authors: item.authors ?? null,
    year: item.year ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
