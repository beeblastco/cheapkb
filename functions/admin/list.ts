import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { Document, DocumentRow } from "../types";
import { docId, extractUserId } from "../utils";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;

export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const allItems: DocumentRow[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await dynamo.send(
      new QueryCommand({
        TableName,
        IndexName: "GSI2",
        KeyConditionExpression: "gsi2pk = :pk",
        ExpressionAttributeValues: { ":pk": `USER#${userId}` },
        ScanIndexForward: false,
        ExclusiveStartKey: lastKey,
      }),
    );
    allItems.push(...((res.Items as unknown as DocumentRow[]) ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const documents: Document[] = allItems.map((doc: DocumentRow) => {
    return {
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
    };
  });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count: documents.length, documents }),
  };
}
