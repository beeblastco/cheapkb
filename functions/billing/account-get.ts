import { extractUserId } from "../utils";
import { getAccount } from "./account";

const TableName = process.env.TABLE_NAME!;

export async function handler(event: any) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const account = await getAccount(userId, TableName);
  if (!account) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Account not found" }),
    };
  }

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
