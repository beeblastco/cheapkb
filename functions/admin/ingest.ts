import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DocumentRow } from "../types";
import { extractUserId } from "../utils";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;

interface IngestBody {
  documentId?: unknown;
}

/**
 * The S3 upload event is the only path that queues and charges a document, so
 * this endpoint reports status and never starts processing itself.
 */
export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  if (!event.body) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Request body is required" }),
    };
  }
  let body: IngestBody;
  try {
    body = JSON.parse(event.body) as IngestBody;
  } catch (err) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: `Invalid JSON: ${(err as Error).message}`,
      }),
    };
  }

  const documentId = typeof body.documentId === "string" ? body.documentId : "";
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

  const doc = result.Item as DocumentRow;
  if (doc.userId !== userId) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document not found" }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId: documentId, status: doc.status }),
  };
}
