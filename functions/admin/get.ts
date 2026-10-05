import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  chunkId,
  docId,
  dynamo,
  extractUserId,
  getDocument,
  listDocumentChunkItems,
} from "../utils";

const TableName = process.env.TABLE_NAME!;

/** GET /documents/{id}: returns one owned document and its chunk statuses. */
export async function handler(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<{ userId: string }>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, response: authError } = extractUserId(event);
  if (authError) return authError;

  const documentId = event.pathParameters?.id;
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
      document: {
        documentId: docId(doc.pk),
        title: doc.title,
        status: doc.status,
        lastError: doc.lastError ?? null,
        retryCount: doc.retryCount ?? 0,
        failedStep: doc.failedStep ?? null,
        mimeType: doc.mimeType,
        tags: doc.tags ?? null,
        authors: doc.authors ?? null,
        year: doc.year ?? null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      },
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
