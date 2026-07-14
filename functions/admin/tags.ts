import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { extractUserId } from "../utils";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const MAX_TAG_LENGTH = 50;

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

  const now = new Date().toISOString();
  const tag = { name, createdAt: now };
  try {
    await dynamo.send(
      new PutCommand({
        TableName,
        Item: {
          pk: `USER#${userId}`,
          sk: `TAG#${name.toLowerCase()}`,
          entityType: "Tag",
          name,
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (error: any) {
    // Tag already exists — treat create as idempotent.
    if (error.name !== "ConditionalCheckFailedException") throw error;
  }

  return json(200, { tag });
}

async function deleteTag(userId: string, event: any) {
  const raw = event.pathParameters?.name;
  const name = raw ? decodeURIComponent(raw).trim() : "";
  if (!name) return json(400, { error: "Tag name is required" });

  await dynamo.send(
    new DeleteCommand({
      TableName,
      Key: { pk: `USER#${userId}`, sk: `TAG#${name.toLowerCase()}` },
    }),
  );

  return json(200, { name, deleted: true });
}
