import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { AccountRow } from "../types";
import {
  accountId,
  defaultPlanId,
  dynamo,
  extractUserId,
  getDefaultPlan,
} from "../utils";

const tableName = process.env.ACCOUNTS_TABLE_NAME!;
const plansTableName = process.env.PLANS_TABLE_NAME!;

/** GET /account: returns the caller's profile, plan and stored bytes. */
export async function handler(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<{ userId: string }>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, response: authError } = extractUserId(event);
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
  const plan = await getDefaultPlan(plansTableName);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: accountId(account.pk),
      planId: plan?.planId ?? defaultPlanId(),
      priceMonthlyCents: plan?.priceMonthlyCents ?? 0,
      monthlyAllowanceCents: plan?.monthlyAllowanceCents ?? 0,
      storageBytes: account.storageBytes,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    }),
  };
}
