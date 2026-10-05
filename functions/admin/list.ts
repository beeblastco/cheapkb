import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { Document, DocumentRow } from "../types";
import { docId, dynamo, extractUserId, isDocumentInFlight } from "../utils";

const TableName = process.env.TABLE_NAME!;

/** GET /documents: lists every document the caller owns, newest first.
 * inFlight uses the upload handler's rule, so the client can wait for a free slot. */
export async function handler(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<{ userId: string }>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, response: authError } = extractUserId(event);
  if (authError) return authError;

  const allItems: DocumentRow[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await dynamo.send(
      new QueryCommand({
        TableName: TableName,
        IndexName: "GSI2",
        KeyConditionExpression: "gsi2pk = :pk",
        ExpressionAttributeValues: { ":pk": `USER#${userId}` },
        ScanIndexForward: false,
        ExclusiveStartKey: lastKey,
      }),
    );
    allItems.push(...((res.Items as DocumentRow[] | undefined) ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const nowMs = Date.now();
  const documents: Document[] = allItems.map((doc) => ({
    documentId: docId(doc.pk),
    title: doc.title,
    status: doc.status,
    userId: doc.userId,
    lastError: doc.lastError ?? null,
    retryCount: doc.retryCount ?? 0,
    failedStep: doc.failedStep ?? null,
    mimeType: doc.mimeType,
    tags: doc.tags ?? null,
    authors: doc.authors ?? null,
    year: doc.year ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    inFlight: isDocumentInFlight(doc, nowMs),
  }));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count: documents.length, documents: documents }),
  };
}
