import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { accountId, extractUserId, updatePlan } from "../utils";
import type { AccountRow } from "../types";

const PlansTableName = process.env.PLANS_TABLE_NAME!;
const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;

interface AssignBody {
  planId?: unknown;
}

export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  let body: AssignBody;
  try {
    body = JSON.parse(event.body ?? "{}") as AssignBody;
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const planId = typeof body.planId === "string" ? body.planId : undefined;
  if (!planId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid planId" }),
    };
  }

  const account: AccountRow | null = await updatePlan(
    userId,
    PlansTableName,
    AccountsTableName,
    planId,
  );
  if (!account) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid planId" }),
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
