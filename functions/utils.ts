import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

const SHOO_BASE_URL = "https://shoo.dev";
const SHOO_ISSUER = "https://shoo.dev";
const jwks = createRemoteJWKSet(new URL("/.well-known/jwks.json", SHOO_BASE_URL));

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function verifyShooToken(idToken: string, appOrigin: string) {
  const audience = `origin:${new URL(appOrigin).origin}`;
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: SHOO_ISSUER,
    audience,
  });
  if (typeof payload.pairwise_sub !== "string") {
    throw new Error("Shoo token missing pairwise_sub");
  }
  return payload;
}

export async function extractUserId(
  event: any,
): Promise<{ userId: string; response?: any }> {
  const authHeader =
    event.headers?.authorization ?? event.headers?.Authorization ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";
  if (!token) {
    return {
      userId: "",
      response: {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing authorization token" }),
      },
    };
  }

  const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:5173";
  try {
    const payload = await verifyShooToken(token, appOrigin);
    return { userId: payload.pairwise_sub as string };
  } catch (err: any) {
    return {
      userId: "",
      response: {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `Invalid token: ${err.message}` }),
      },
    };
  }
}

export async function checkRateLimit(
  userId: string,
  tableName: string,
  maxTokens: number,
  refillPerHour: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date();
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await dynamo.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `RATE#${userId}`, sk: "LIMIT" },
      }),
    );
    const item = result.Item as any;

    if (!item) {
      try {
        await dynamo.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: `RATE#${userId}`,
              sk: "LIMIT",
              entityType: "RateLimit",
              tokens: maxTokens - 1,
              lastRefill: now.toISOString(),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return { allowed: true, remaining: maxTokens - 1 };
      } catch (err: any) {
        if (err.name === "ConditionalCheckFailedException") continue;
        throw err;
      }
    }

    const lastRefill = new Date(item.lastRefill);
    const hoursPassed = (now.getTime() - lastRefill.getTime()) / (1000 * 60 * 60);
    let tokens = Math.min(maxTokens, item.tokens + hoursPassed * refillPerHour);

    if (tokens < 1) {
      return { allowed: false, remaining: 0 };
    }

    tokens -= 1;
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: `RATE#${userId}`, sk: "LIMIT" },
          UpdateExpression: "SET tokens = :t, lastRefill = :lr",
          ConditionExpression: "lastRefill = :oldLr",
          ExpressionAttributeValues: {
            ":t": Math.floor(tokens),
            ":lr": now.toISOString(),
            ":oldLr": item.lastRefill,
          },
        }),
      );
      return { allowed: true, remaining: Math.floor(tokens) };
    } catch (err: any) {
      if (err.name === "ConditionalCheckFailedException") continue;
      throw err;
    }
  }

  return { allowed: false, remaining: 0 };
}
