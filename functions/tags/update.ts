import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { TAG_COLORS, type Tag, type TagColor } from "../types";
import { decodeTagName, dynamo, extractUserId } from "../utils";

const TableName = process.env.TAGS_TABLE_NAME!;

/** API handler for PATCH /tags/{name}; changes the color of the caller's tag. */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const name = decodeTagName(event.pathParameters);
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
        TableName: TableName,
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
          color: color,
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

function parseColor(value: unknown): TagColor | undefined {
  return typeof value === "string" && TAG_COLORS.includes(value as TagColor)
    ? (value as TagColor)
    : undefined;
}
