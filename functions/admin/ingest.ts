import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { dynamo, extractUserId, getDocument } from "../utils";

const TableName = process.env.TABLE_NAME!;

/**
 * The S3 upload event is the only path that queues and charges a document, so
 * this endpoint reports status and never starts processing itself.
 */
export async function handler(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<{ userId: string }>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, response: authError } = extractUserId(event);
  if (authError) return authError;

  if (!event.body) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Request body is required" }),
    };
  }
  let body: { documentId?: unknown };
  try {
    body = JSON.parse(event.body) as { documentId?: unknown };
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

  const doc = await getDocument(documentId, dynamo, TableName, false);
  if (!doc || doc.userId !== userId) {
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
