import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { randomBytes } from "node:crypto";
import { dynamo, extractUserId, hashMcpKey } from "../utils";

const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;

/** GET, POST and DELETE /account/mcp-key: reads, rotates or revokes the caller's MCP key.
 * POST returns the new key once; only its hash is stored, next to the account row. */
export async function handler(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<{ userId: string }>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, response: authError } = extractUserId(event);
  if (authError) return authError;
  const key = { pk: `ACCOUNT#${userId}`, sk: "MCP_KEY" };
  const { method } = event.requestContext.http;

  if (method === "DELETE") {
    await dynamo.send(
      new DeleteCommand({ TableName: AccountsTableName, Key: key }),
    );
    return { statusCode: 204 };
  }

  if (method === "POST") {
    const apiKey = `ckb_${Buffer.from(userId).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
    const createdAt = new Date().toISOString();
    await dynamo.send(
      new PutCommand({
        TableName: AccountsTableName,
        Item: { ...key, keyHash: hashMcpKey(apiKey), createdAt: createdAt },
      }),
    );
    return {
      statusCode: 201,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: apiKey, createdAt: createdAt }),
    };
  }

  const result = await dynamo.send(
    new GetCommand({ TableName: AccountsTableName, Key: key }),
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      createdAt: (result.Item?.createdAt as string | undefined) ?? null,
    }),
  };
}
