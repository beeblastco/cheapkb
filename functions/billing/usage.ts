import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { allowanceNanoUsd, getOrCreateAccount, type Account } from "./account";
import {
  nanoUsdToUsd,
  NANO_PER_CENT,
  PRICING,
  storageCostNanoUsd,
} from "./pricing";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export type UsageCategory = "query" | "upload" | "ingest" | "embed";

export interface UsageDay {
  pk: string;
  sk: string;
  entityType: "UsageDay";
  userId: string;
  day: string;
  queryOps: number;
  uploadOps: number;
  ingestOps: number;
  embedOps: number;
  costNano: number;
  updatedAt: string;
}

export interface UsageSummary {
  planId: string;
  planLabel: string;
  priceMonthlyUsd: number;
  allowanceUsd: number;
  spentUsd: number;
  storageUsd: number;
  pctUsed: number;
  paused: boolean;
  resetAt: string;
  storageBytes: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function currentCycle(account: Account, nowMs: number) {
  const created = new Date(account.createdAt).getTime();
  const monthsSinceCreation = (nowMs - created) / MS_PER_DAY / 30;
  const cycleIndex = Math.floor(monthsSinceCreation);
  const startMs = created + cycleIndex * 30 * MS_PER_DAY;
  const endMs = startMs + 30 * MS_PER_DAY;
  return { startMs, endMs };
}

export async function recordUsage(
  userId: string,
  tableName: string,
  category: UsageCategory,
  units: number,
): Promise<void> {
  if (units <= 0) return;

  let costNano = 0;
  if (category === "query") costNano = units * PRICING.queryPerRequest;
  if (category === "upload") costNano = units * PRICING.uploadPerRequest;
  if (category === "ingest") costNano = units * PRICING.ingestPerDocument;
  if (category === "embed") costNano = units * PRICING.embedPerChunk;

  const now = new Date();
  const day = dayKey(now.getTime());
  const pk = `ACCOUNT#${userId}`;
  const sk = `USAGE#${day}`;
  const field = categoryField(category);

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk },
        UpdateExpression: `SET ${field} = if_not_exists(${field}, :zero) + :u, costNano = if_not_exists(costNano, :zero) + :c, userId = :userId, #day = :day, entityType = :entity, updatedAt = :t`,
        ExpressionAttributeNames: { "#day": "day" },
        ExpressionAttributeValues: {
          ":u": units,
          ":c": costNano,
          ":zero": 0,
          ":userId": userId,
          ":day": day,
          ":entity": "UsageDay",
          ":t": now.toISOString(),
        },
      }),
    );
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") {
      await recordUsage(userId, tableName, category, units);
      return;
    }
    throw error;
  }
}

export async function sumUsageNano(
  userId: string,
  tableName: string,
  startDay: string,
  endDay: string,
): Promise<number> {
  let total = 0;
  let lastKey: Record<string, any> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": `ACCOUNT#${userId}`,
          ":start": `USAGE#${startDay}`,
          ":end": `USAGE#${endDay}`,
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result.Items ?? []) {
      total += (item.costNano as number) ?? 0;
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return total;
}

export async function getUsageSummary(
  userId: string,
  tableName: string,
): Promise<UsageSummary> {
  const account = await getOrCreateAccount(userId, tableName);
  const nowMs = Date.now();
  const cycle = currentCycle(account, nowMs);

  const startDay = dayKey(cycle.startMs);
  const endDay = dayKey(cycle.endMs - 1);
  const spentNano = await sumUsageNano(userId, tableName, startDay, endDay);

  const storageSeconds = Math.max(0, (nowMs - cycle.startMs) / 1000);
  const storageNano = storageCostNanoUsd(
    account.storageBytes ?? 0,
    storageSeconds,
  );
  const totalSpentNano = spentNano + storageNano;
  const allowanceNano = allowanceNanoUsd(account);

  return {
    planId: account.planId,
    planLabel: account.planId === "starter" ? "Starter" : account.planId,
    priceMonthlyUsd: nanoUsdToUsd(account.priceMonthlyCents * NANO_PER_CENT),
    allowanceUsd: nanoUsdToUsd(allowanceNano),
    spentUsd: nanoUsdToUsd(totalSpentNano),
    storageUsd: nanoUsdToUsd(storageNano),
    pctUsed:
      allowanceNano > 0
        ? Math.min((totalSpentNano / allowanceNano) * 100, 999)
        : 0,
    paused: totalSpentNano >= allowanceNano,
    resetAt: new Date(cycle.endMs).toISOString(),
    storageBytes: account.storageBytes ?? 0,
  };
}

export async function checkUsageLimit(
  userId: string,
  tableName: string,
): Promise<{ allowed: boolean; summary: UsageSummary }> {
  const summary = await getUsageSummary(userId, tableName);
  return { allowed: !summary.paused, summary };
}

function categoryField(category: UsageCategory): string {
  if (category === "query") return "queryOps";
  if (category === "upload") return "uploadOps";
  if (category === "ingest") return "ingestOps";
  return "embedOps";
}
