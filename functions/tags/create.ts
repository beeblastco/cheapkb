import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
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
const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_USER = 200;
// Creates that lose the TAGSEQ race recount and retry this many times.
const MAX_COMMIT_ATTEMPTS = 3;

/** API handler for POST /tags; creates a tag, or returns the existing one with that name. */
export async function handler(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<{ userId: string }>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, response: authError } = extractUserId(event);
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

  const existing = await dynamo.send(
    new GetCommand({ TableName: TableName, Key: key }),
  );
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

  return createWithinCap(key, name, color);
}

/** Creates the tag unless the user is at the cap. Creates commit one at a time against
 * TAGSEQ, so concurrent ones cannot pass the cap (proofs/Proofs/TagCap.lean). */
async function createWithinCap(
  key: { pk: string; sk: string },
  name: string,
  color: TagColor,
): Promise<APIGatewayProxyStructuredResultV2> {
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const sequence = await dynamo.send(
      new GetCommand({
        TableName: TableName,
        Key: { pk: key.pk, sk: "TAGSEQ" },
        ConsistentRead: true,
      }),
    );
    const seenSeq: number = sequence.Item?.seq ?? 0;
    const countRes = await dynamo.send(
      new QueryCommand({
        TableName: TableName,
        Select: "COUNT",
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": key.pk,
          ":prefix": "TAG#",
        },
        ConsistentRead: true,
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

    try {
      await dynamo.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TableName,
                Item: {
                  pk: key.pk,
                  sk: key.sk,
                  name: name,
                  color: color,
                  createdAt: now,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Update: {
                TableName: TableName,
                Key: { pk: key.pk, sk: "TAGSEQ" },
                UpdateExpression: "SET seq = :next",
                ConditionExpression: "attribute_not_exists(seq) OR seq = :seen",
                ExpressionAttributeValues: {
                  ":next": seenSeq + 1,
                  ":seen": seenSeq,
                },
              },
            },
          ],
        }),
      );
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag: { name: name, color: color, createdAt: now },
        }),
      };
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;
      // A failed Put means another request created this tag; anything else recounts.
      if (error.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") {
        return racedResponse(key);
      }
    }
  }

  return {
    statusCode: 409,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Tag changed concurrently; please retry" }),
  };
}

/** Returns the tag a concurrent create stored, or a conflict when it is already gone. */
async function racedResponse(key: {
  pk: string;
  sk: string;
}): Promise<APIGatewayProxyStructuredResultV2> {
  const raced = await dynamo.send(
    new GetCommand({ TableName: TableName, Key: key, ConsistentRead: true }),
  );
  if (!raced.Item) {
    return {
      statusCode: 409,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Tag changed concurrently; please retry" }),
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

function parseColor(value: unknown): TagColor | undefined {
  return typeof value === "string" && TAG_COLORS.includes(value as TagColor)
    ? (value as TagColor)
    : undefined;
}
