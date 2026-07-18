import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, extractUserId, getPlan } from "../utils";
import type { Plan } from "../types";

const TableName = process.env.PLANS_TABLE_NAME!;

interface PlanUpdateBody {
  label?: unknown;
  priceMonthlyCents?: unknown;
  monthlyAllowanceCents?: unknown;
}

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

  let body: PlanUpdateBody;
  try {
    body = JSON.parse(event.body ?? "{}") as PlanUpdateBody;
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const label = typeof body.label === "string" ? body.label : undefined;
  const priceMonthlyCents = Number(body.priceMonthlyCents);
  const monthlyAllowanceCents = Number(body.monthlyAllowanceCents);
  if (
    typeof label !== "string" ||
    !Number.isFinite(priceMonthlyCents) ||
    !Number.isFinite(monthlyAllowanceCents)
  ) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid plan fields" }),
    };
  }

  const existing = await getPlan(planId, TableName);
  if (!existing) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Plan not found" }),
    };
  }

  const now = new Date().toISOString();
  const result = await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `PLAN#${planId}`, sk: "PLAN" },
      UpdateExpression:
        "SET label = :label, priceMonthlyCents = :price, monthlyAllowanceCents = :allowance, updatedAt = :now",
      ExpressionAttributeValues: {
        ":label": label,
        ":price": priceMonthlyCents,
        ":allowance": monthlyAllowanceCents,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    }),
  );

  const plan = result.Attributes as Plan;
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
