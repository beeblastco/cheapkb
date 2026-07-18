import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { TAG_COLORS, type Tag, type TagColor } from "../types";
import { extractUserId } from "../utils";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TAGS_TABLE_NAME!;

export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const name = decodeTagName(event);
  if (typeof name !== "string") return name;

  let body: Record<string, unknown>;
  try {
    const parsedBody: unknown = JSON.parse(event.body ?? "{}");
    if (
      parsedBody === null ||
      typeof parsedBody !== "object" ||
      Array.isArray(parsedBody)
    ) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Request body must be a JSON object" }),
      };
    }
    body = parsedBody as Record<string, unknown>;
  } catch (err) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: `Invalid JSON: ${(err as Error).message}`,
      }),
    };
  }

  const color = parseColor(body.color);
  if (!color) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: `Tag color must be one of: ${TAG_COLORS.join(", ")}`,
      }),
    };
  }

  try {
    const updated = await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `USER#${userId}`, sk: `TAG#${name.toLowerCase()}` },
        UpdateExpression: "SET #color = :color",
        ExpressionAttributeNames: { "#color": "color" },
        ExpressionAttributeValues: { ":color": color },
        ConditionExpression: "attribute_exists(pk)",
        ReturnValues: "ALL_NEW",
      }),
    );
    const attrs = updated.Attributes as Tag | undefined;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag: {
          name: attrs?.name ?? name,
          color,
          createdAt: attrs?.createdAt,
        },
      }),
    };
  } catch (error) {
    if ((error as Error).name !== "ConditionalCheckFailedException")
      throw error;
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Tag not found" }),
    };
  }
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

function parseColor(value: unknown): TagColor | undefined {
  return typeof value === "string" && TAG_COLORS.includes(value as TagColor)
    ? (value as TagColor)
    : undefined;
}
