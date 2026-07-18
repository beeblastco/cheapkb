import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { extractUserId, getUsageSummary } from "../utils";

const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;

export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const summary = await getUsageSummary(userId, AccountsTableName);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(summary),
  };
}
