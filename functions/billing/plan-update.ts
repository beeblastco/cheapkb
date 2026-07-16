import { extractUserId } from "../utils";
import { PLANS, updatePlan } from "./utils";

const TableName = process.env.TABLE_NAME!;

export async function handler(event: any) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  let body: any;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const planId =
    typeof body?.planId === "string" && Object.hasOwn(PLANS, body.planId)
      ? body.planId
      : undefined;
  if (!planId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid planId" }),
    };
  }

  const account = await updatePlan(userId, TableName, planId);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: account.userId,
      planId: account.planId,
      priceMonthlyCents: account.priceMonthlyCents,
      monthlyAllowanceCents: account.monthlyAllowanceCents,
      storageBytes: account.storageBytes,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    }),
  };
}
