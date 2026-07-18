import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { AccountRow } from "../types";
import { accountId, dynamo, extractUserId } from "../utils";

const tableName = process.env.ACCOUNTS_TABLE_NAME!;

export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const result = await dynamo.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `ACCOUNT#${userId}`, sk: "PROFILE" },
    }),
  );

  const account = result.Item as AccountRow | undefined;
  if (!account) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Account not found" }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: accountId(account.pk),
      planId: account.planId,
      priceMonthlyCents: account.priceMonthlyCents,
      monthlyAllowanceCents: account.monthlyAllowanceCents,
      storageBytes: account.storageBytes,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    }),
  };
}
