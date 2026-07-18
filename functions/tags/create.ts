import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  DEFAULT_TAG_COLOR,
  TAG_COLORS,
  type Tag,
  type TagColor,
} from "../types";
import { extractUserId } from "../utils";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TAGS_TABLE_NAME!;
const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_USER = 200;

export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

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

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Tag name is required" }),
    };
  }
  if (name.length > MAX_TAG_LENGTH) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: `Tag name must be ${MAX_TAG_LENGTH} characters or fewer`,
      }),
    };
  }

  if (body.color !== undefined && !parseColor(body.color)) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: `Tag color must be one of: ${TAG_COLORS.join(", ")}`,
      }),
    };
  }
  const color = parseColor(body.color) ?? DEFAULT_TAG_COLOR;

  const key = { pk: `USER#${userId}`, sk: `TAG#${name.toLowerCase()}` };

  const existing = await dynamo.send(new GetCommand({ TableName, Key: key }));
  if (existing.Item) {
    const stored = existing.Item as Tag;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag: {
          name: stored.name,
          color: parseColor(stored.color) ?? DEFAULT_TAG_COLOR,
          createdAt: stored.createdAt,
        },
      }),
    };
  }

  const countRes = await dynamo.send(
    new QueryCommand({
      TableName,
      Select: "COUNT",
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `USER#${userId}`,
        ":prefix": "TAG#",
      },
    }),
  );
  if ((countRes.Count ?? 0) >= MAX_TAGS_PER_USER) {
    return {
      statusCode: 409,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: `Tag limit reached (${MAX_TAGS_PER_USER} per user)`,
      }),
    };
  }

  const now = new Date().toISOString();
  try {
    await dynamo.send(
      new PutCommand({
        TableName,
        Item: {
          pk: key.pk,
          sk: key.sk,
          name,
          color,
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: { name, color, createdAt: now } }),
    };
  } catch (error) {
    if ((error as Error).name !== "ConditionalCheckFailedException")
      throw error;
    const raced = await dynamo.send(
      new GetCommand({ TableName, Key: key, ConsistentRead: true }),
    );
    if (!raced.Item) {
      return {
        statusCode: 409,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Tag changed concurrently; please retry",
        }),
      };
    }
    const racedTag = raced.Item as Tag;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag: {
          name: racedTag.name,
          color: parseColor(racedTag.color) ?? DEFAULT_TAG_COLOR,
          createdAt: racedTag.createdAt,
        },
      }),
    };
  }
}

function parseColor(value: unknown): TagColor | undefined {
  return typeof value === "string" && TAG_COLORS.includes(value as TagColor)
    ? (value as TagColor)
    : undefined;
}
