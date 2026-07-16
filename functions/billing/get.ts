import { extractUserId } from "../utils";
import { getUsageSummary } from "./usage";

const TableName = process.env.TABLE_NAME!;

export async function handler(event: any) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const summary = await getUsageSummary(userId, TableName);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(summary),
  };
}
