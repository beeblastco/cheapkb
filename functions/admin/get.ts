import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { DocumentRow } from "../types";
import {
  chunkId,
  docId,
  extractUserId,
  listDocumentChunkItems,
} from "../utils";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;

/** GET /documents/{id}: returns one owned document and its chunk statuses. */
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
      TableName: TableName,
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

  // A large document's chunk rows span several 1 MB query pages.
  const chunkItems = await listDocumentChunkItems(
    documentId,
    dynamo,
    TableName,
  );
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document: pickDocumentFields(result.Item as DocumentRow),
      chunks: chunkItems.map((c) => ({
        chunkId: chunkId(c.sk),
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        tokenCount: c.tokenCount,
        status: c.status,
      })),
      chunkCount: chunkItems.length,
    }),
  };
}

/** Maps a META row to the document fields the API returns. */
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
