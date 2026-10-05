import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  DEFAULT_TAG_COLOR,
  TAG_COLORS,
  type Tag,
  type TagColor,
} from "../types";
import { dynamo, extractUserId } from "../utils";

const TableName = process.env.TAGS_TABLE_NAME!;

/** API handler for GET /tags; returns the caller's tags sorted by name. */
export async function handler(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<{ userId: string }>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, response: authError } = extractUserId(event);
  if (authError) return authError;

  const tags: Tag[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await dynamo.send(
      new QueryCommand({
        TableName: TableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":prefix": "TAG#",
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of res.Items ?? []) {
      const tag = item as Tag;
      tags.push({
        name: tag.name,
        color: parseColor(tag.color) ?? DEFAULT_TAG_COLOR,
        createdAt: tag.createdAt,
      });
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  tags.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count: tags.length, tags: tags }),
  };
}

function parseColor(value: unknown): TagColor | undefined {
  return typeof value === "string" && TAG_COLORS.includes(value as TagColor)
    ? (value as TagColor)
    : undefined;
}
