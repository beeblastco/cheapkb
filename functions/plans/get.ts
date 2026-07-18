import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { extractUserId, getPlan } from "../utils";

const TableName = process.env.PLANS_TABLE_NAME!;

export async function handler(event: APIGatewayProxyEventV2) {
  const { response: authError } = await extractUserId(event);
  if (authError) return authError;

  const planId = event.pathParameters?.id;
  if (typeof planId !== "string") {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing plan id" }),
    };
  }

  const plan = await getPlan(planId, TableName);
  if (!plan) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Plan not found" }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planId: plan.planId,
      label: plan.label,
      priceMonthlyCents: plan.priceMonthlyCents,
      monthlyAllowanceCents: plan.monthlyAllowanceCents,
    }),
  };
}
