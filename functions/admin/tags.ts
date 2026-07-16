import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { extractUserId } from "../utils";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_USER = 200;

// Colors are stored as palette names, not raw CSS values, so the web app owns
// how each one renders in light and dark mode.
const TAG_COLORS = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;
const DEFAULT_TAG_COLOR: TagColor = "gray";

type TagColor = (typeof TAG_COLORS)[number];

function parseColor(value: unknown): TagColor | undefined {
  return typeof value === "string" && TAG_COLORS.includes(value as TagColor)
    ? (value as TagColor)
    : undefined;
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function handler(event: any) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const method =
    event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  if (method === "GET") return listTags(userId);
  if (method === "POST") return createTag(userId, event);
  if (method === "PATCH") return updateTag(userId, event);
  if (method === "DELETE") return deleteTag(userId, event);
  return json(405, { error: "Method not allowed" });
}

async function listTags(userId: string) {
  const tags: Array<{ name: string; color: TagColor; createdAt?: string }> = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const res = await dynamo.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":prefix": "TAG#",
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of res.Items ?? []) {
      // Tags created before colors existed have no color attribute.
      tags.push({
        name: item.name,
        color: parseColor(item.color) ?? DEFAULT_TAG_COLOR,
        createdAt: item.createdAt,
      });
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  tags.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  return json(200, { count: tags.length, tags });
}

async function createTag(userId: string, event: any) {
  let body: any;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch (err) {
    return json(400, { error: `Invalid JSON: ${(err as Error).message}` });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json(400, { error: "Tag name is required" });
  if (name.length > MAX_TAG_LENGTH) {
    return json(400, {
      error: `Tag name must be ${MAX_TAG_LENGTH} characters or fewer`,
    });
  }

  if (body.color !== undefined && !parseColor(body.color)) {
    return json(400, {
      error: `Tag color must be one of: ${TAG_COLORS.join(", ")}`,
    });
  }
  const color = parseColor(body.color) ?? DEFAULT_TAG_COLOR;

  const key = { pk: `USER#${userId}`, sk: `TAG#${name.toLowerCase()}` };

  // Idempotent create: if the tag already exists, echo the stored canonical
  // record (its original casing and createdAt) so POST and GET agree.
  const existing = await dynamo.send(new GetCommand({ TableName, Key: key }));
  if (existing.Item) {
    return json(200, {
      tag: {
        name: existing.Item.name,
        color: parseColor(existing.Item.color) ?? DEFAULT_TAG_COLOR,
        createdAt: existing.Item.createdAt,
      },
    });
  }

  // Bound how many tags a single user can accumulate.
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
    return json(409, {
      error: `Tag limit reached (${MAX_TAGS_PER_USER} per user)`,
    });
  }

  const now = new Date().toISOString();
  try {
    await dynamo.send(
      new PutCommand({
        TableName,
        Item: {
          pk: key.pk,
          sk: key.sk,
          entityType: "Tag",
          name,
          color,
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return json(200, { tag: { name, color, createdAt: now } });
  } catch (error: any) {
    if (error.name !== "ConditionalCheckFailedException") throw error;
    // Lost a race with a concurrent create — return the canonical record.
    const raced = await dynamo.send(new GetCommand({ TableName, Key: key }));
    // Deleted again before the read: nothing was stored, so do not report success.
    if (!raced.Item) {
      return json(409, { error: "Tag changed concurrently; please retry" });
    }
    return json(200, {
      tag: {
        name: raced.Item.name,
        color: parseColor(raced.Item.color) ?? DEFAULT_TAG_COLOR,
        createdAt: raced.Item.createdAt,
      },
    });
  }
}

async function updateTag(userId: string, event: any) {
  const name = decodeTagName(event);
  if (typeof name !== "string") return name;

  let body: any;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch (err) {
    return json(400, { error: `Invalid JSON: ${(err as Error).message}` });
  }

  const color = parseColor(body.color);
  if (!color) {
    return json(400, {
      error: `Tag color must be one of: ${TAG_COLORS.join(", ")}`,
    });
  }

  try {
    const updated = await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `USER#${userId}`, sk: `TAG#${name.toLowerCase()}` },
        UpdateExpression: "SET #color = :color",
        ExpressionAttributeNames: { "#color": "color" },
        ExpressionAttributeValues: { ":color": color },
        // Recoloring must not resurrect a tag that was deleted concurrently.
        ConditionExpression: "attribute_exists(pk)",
        ReturnValues: "ALL_NEW",
      }),
    );
    return json(200, {
      tag: {
        name: updated.Attributes?.name ?? name,
        color,
        createdAt: updated.Attributes?.createdAt,
      },
    });
  } catch (error: any) {
    if (error.name !== "ConditionalCheckFailedException") throw error;
    return json(404, { error: "Tag not found" });
  }
}

function decodeTagName(event: any): string | ReturnType<typeof json> {
  const raw = event.pathParameters?.name;
  let decoded: string;
  try {
    decoded = raw ? decodeURIComponent(raw) : "";
  } catch {
    return json(400, { error: "Tag name contains invalid URL encoding" });
  }
  const name = decoded.trim();
  if (!name) return json(400, { error: "Tag name is required" });
  return name;
}

async function deleteTag(userId: string, event: any) {
  const name = decodeTagName(event);
  if (typeof name !== "string") return name;

  await dynamo.send(
    new DeleteCommand({
      TableName,
      Key: { pk: `USER#${userId}`, sk: `TAG#${name.toLowerCase()}` },
    }),
  );

  return json(200, { name, deleted: true });
}
