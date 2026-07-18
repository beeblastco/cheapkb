import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { extractUserId } from "../utils";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TAGS_TABLE_NAME!;

export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const name = decodeTagName(event);
  if (typeof name !== "string") return name;

  await dynamo.send(
    new DeleteCommand({
      TableName,
      Key: { pk: `USER#${userId}`, sk: `TAG#${name.toLowerCase()}` },
    }),
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, deleted: true }),
  };
}

function decodeTagName(event: {
  pathParameters?: Record<string, string | undefined>;
}):
  | string
  | { statusCode: number; headers: Record<string, string>; body: string } {
  const raw = event.pathParameters?.name;
  let decoded: string;
  try {
    decoded = raw ? decodeURIComponent(raw) : "";
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Tag name contains invalid URL encoding" }),
    };
  }
  const name = decoded.trim();
  if (!name) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Tag name is required" }),
    };
  }
  return name;
}
