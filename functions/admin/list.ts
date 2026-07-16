import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { extractUserId } from "../utils";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;

export async function handler(event: any) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const allItems: any[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const res = await dynamo.send(
      new QueryCommand({
        TableName,
        IndexName: "GSI2",
        KeyConditionExpression: "gsi2pk = :pk",
        ExpressionAttributeValues: { ":pk": `USER#${userId}` },
        ExclusiveStartKey: lastKey,
      }),
    );
    allItems.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const documents = allItems
    .map((doc) => ({
      documentId: doc.documentId,
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
    }))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count: documents.length, documents }),
  };
}
