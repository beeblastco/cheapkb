import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, extractUserId } from "../utils";
import type { Plan } from "../types";

const TableName = process.env.PLANS_TABLE_NAME!;

interface PlanInputBody {
  planId?: unknown;
  label?: unknown;
  priceMonthlyCents?: unknown;
  monthlyAllowanceCents?: unknown;
}

export async function handler(event: APIGatewayProxyEventV2) {
  const { response: authError } = await extractUserId(event);
  if (authError) return authError;

  let body: PlanInputBody;
  try {
    body = JSON.parse(event.body ?? "{}") as PlanInputBody;
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const planId = typeof body.planId === "string" ? body.planId : undefined;
  const label = typeof body.label === "string" ? body.label : undefined;
  const priceMonthlyCents = Number(body.priceMonthlyCents);
  const monthlyAllowanceCents = Number(body.monthlyAllowanceCents);
  if (
    typeof planId !== "string" ||
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

  const existing = await dynamo.send(
    new GetCommand({
      TableName,
      Key: { pk: `PLAN#${planId}`, sk: "PLAN" },
    }),
  );
  if (existing.Item) {
    return {
      statusCode: 409,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Plan already exists" }),
    };
  }

  const now = new Date().toISOString();
  const plan: Plan = {
    planId,
    label,
    priceMonthlyCents,
    monthlyAllowanceCents,
  };
  await dynamo.send(
    new PutCommand({
      TableName,
      Item: {
        pk: `PLAN#${planId}`,
        sk: "PLAN",
        ...plan,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  return {
    statusCode: 201,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planId,
      label,
      priceMonthlyCents,
      monthlyAllowanceCents,
    }),
  };
}
