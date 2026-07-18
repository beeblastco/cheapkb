import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, extractUserId, getPlan } from "../utils";

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

  const existing = await getPlan(planId, TableName);
  if (!existing) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Plan not found" }),
    };
  }

  if (planId === process.env.DEFAULT_PLAN_ID) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Cannot delete the default plan" }),
    };
  }

  await dynamo.send(
    new DeleteCommand({
      TableName,
      Key: { pk: `PLAN#${planId}`, sk: "PLAN" },
    }),
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId }),
  };
}
