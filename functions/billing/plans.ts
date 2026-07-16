import { extractUserId } from "../utils";
import { PLANS } from "./pricing";

export async function handler(event: any) {
  const { response: authError } = await extractUserId(event);
  if (authError) return authError;

  const plans = Object.values(PLANS).map((plan) => ({
    planId: plan.planId,
    label: plan.label,
    priceMonthlyUsd: plan.priceMonthlyCents / 100,
    allowanceUsd: plan.monthlyAllowanceCents / 100,
  }));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plans }),
  };
}
