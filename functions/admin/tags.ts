import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { extractUserId } from "../utils";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_USER = 200;

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
  if (method === "DELETE") return deleteTag(userId, event);
  return json(405, { error: "Method not allowed" });
}

async function listTags(userId: string) {
  const tags: Array<{ name: string; createdAt?: string }> = [];
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
      tags.push({ name: item.name, createdAt: item.createdAt });
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
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json(400, { error: "Tag name is required" });
  if (name.length > MAX_TAG_LENGTH) {
    return json(400, {
      error: `Tag name must be ${MAX_TAG_LENGTH} characters or fewer`,
    });
  }

  const key = { pk: `USER#${userId}`, sk: `TAG#${name.toLowerCase()}` };

  // Idempotent create: if the tag already exists, echo the stored canonical
  // record (its original casing and createdAt) so POST and GET agree.
  const existing = await dynamo.send(new GetCommand({ TableName, Key: key }));
  if (existing.Item) {
    return json(200, {
      tag: { name: existing.Item.name, createdAt: existing.Item.createdAt },
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
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return json(200, { tag: { name, createdAt: now } });
  } catch (error: any) {
    if (error.name !== "ConditionalCheckFailedException") throw error;
    // Lost a race with a concurrent create — return the canonical record.
    const raced = await dynamo.send(new GetCommand({ TableName, Key: key }));
    return json(200, {
      tag: raced.Item
        ? { name: raced.Item.name, createdAt: raced.Item.createdAt }
        : { name, createdAt: now },
    });
  }
}

async function deleteTag(userId: string, event: any) {
  const raw = event.pathParameters?.name;
  let decoded: string;
  try {
    decoded = raw ? decodeURIComponent(raw) : "";
  } catch {
    // Malformed percent-encoding is a client error, not a 500.
    return json(400, { error: "Invalid tag name" });
  }
  const name = decoded.trim();
  if (!name) return json(400, { error: "Tag name is required" });

  await dynamo.send(
    new DeleteCommand({
      TableName,
      Key: { pk: `USER#${userId}`, sk: `TAG#${name.toLowerCase()}` },
    }),
  );

  return json(200, { name, deleted: true });
}
