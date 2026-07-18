import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { extractUserId, listPlans } from "../utils";

const TableName = process.env.PLANS_TABLE_NAME!;

export async function handler(event: APIGatewayProxyEventV2) {
  const { response: authError } = await extractUserId(event);
  if (authError) return authError;

  const plans = await listPlans(TableName);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      plans: plans.map((plan) => ({
        planId: plan.planId,
        label: plan.label,
        priceMonthlyCents: plan.priceMonthlyCents,
        monthlyAllowanceCents: plan.monthlyAllowanceCents,
      })),
    }),
  };
}
