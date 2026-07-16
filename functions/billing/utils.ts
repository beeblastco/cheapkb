import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Account, Plan, UsageCategory, UsageSummary } from "./types";

export const NANO_PER_USD = 1_000_000_000;
export const NANO_PER_CENT = NANO_PER_USD / 100;

export const PRICING = {
  queryPerRequest: 5_000,
  uploadPerRequest: 2_000,
  ingestPerDocument: 5_000,
  embedPerChunk: 500,
  storagePerGbMonth: 23_000_000,
} as const;

export const PLANS: Record<string, Plan> = {
  basic: {
    planId: "basic",
    label: "Basic",
    priceMonthlyCents: 0,
    monthlyAllowanceCents: 100,
  },
  pro: {
    planId: "pro",
    label: "Pro",
    priceMonthlyCents: 500,
    monthlyAllowanceCents: 400,
  },
} as const;

export const DEFAULT_PLAN = PLANS.basic;

const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export function centsToNanoUsd(cents: number): number {
  return cents * NANO_PER_CENT;
}

export function nanoUsdToUsd(nano: number): number {
  return nano / NANO_PER_USD;
}

export function nanoUsdToCents(nano: number): number {
  return Math.floor(nano / NANO_PER_CENT);
}

export function storageCostNanoUsd(bytes: number, seconds: number): number {
  const gb = bytes / (1024 * 1024 * 1024);
  const prorated = (seconds / SECONDS_PER_MONTH) * gb;
  return Math.round(prorated * PRICING.storagePerGbMonth);
}

export function planFromId(planId: string): Plan {
  return PLANS[planId] ?? DEFAULT_PLAN;
}

export function allowanceNanoUsd(account: Account): number {
  return centsToNanoUsd(account.monthlyAllowanceCents);
}

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

export async function getOrCreateAccount(
  userId: string,
  tableName: string,
): Promise<Account> {
  const pk = `ACCOUNT#${userId}`;
  const sk = "PROFILE";
  const existing = await dynamo.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk } }),
  );
  if (existing.Item) return existing.Item as Account;

  const now = new Date().toISOString();
  const account: Account = {
    pk: pk,
    sk: sk,
    entityType: "Account",
    userId: userId,
    planId: DEFAULT_PLAN.planId,
    priceMonthlyCents: DEFAULT_PLAN.priceMonthlyCents,
    monthlyAllowanceCents: DEFAULT_PLAN.monthlyAllowanceCents,
    storageBytes: 0,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await dynamo.send(
      new PutCommand({
        TableName: tableName,
        Item: account,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return account;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      const retry = await dynamo.send(
        new GetCommand({ TableName: tableName, Key: { pk, sk } }),
      );
      return retry.Item as Account;
    }
    throw error;
  }
}

export async function getAccount(
  userId: string,
  tableName: string,
): Promise<Account | null> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `ACCOUNT#${userId}`, sk: "PROFILE" },
    }),
  );
  return (result.Item as Account) ?? null;
}

export async function updatePlan(
  userId: string,
  tableName: string,
  planId: string,
): Promise<Account> {
  const plan = planFromId(planId);
  const pk = `ACCOUNT#${userId}`;
  const sk = "PROFILE";
  const now = new Date().toISOString();
  await getOrCreateAccount(userId, tableName);
  const result = await dynamo.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression:
        "SET planId = :planId, priceMonthlyCents = :price, monthlyAllowanceCents = :allowance, updatedAt = :now",
      ExpressionAttributeValues: {
        ":planId": plan.planId,
        ":price": plan.priceMonthlyCents,
        ":allowance": plan.monthlyAllowanceCents,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  return result.Attributes as Account;
}

export async function updateStorageBytes(
  userId: string,
  tableName: string,
  deltaBytes: number,
) {
  if (deltaBytes === 0) return;
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: `ACCOUNT#${userId}`, sk: "PROFILE" },
      UpdateExpression:
        "SET storageBytes = if_not_exists(storageBytes, :zero) + :delta, updatedAt = :now",
      ConditionExpression:
        "attribute_not_exists(storageBytes) OR storageBytes >= :minDelta",
      ExpressionAttributeValues: {
        ":delta": deltaBytes,
        ":zero": 0,
        ":minDelta": Math.max(0, -deltaBytes),
        ":now": now,
      },
    }),
  );
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
  const ttl = Math.floor(now.getTime() / 1000) + 90 * 24 * 60 * 60;

  await dynamo.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression: `SET ${field} = if_not_exists(${field}, :zero) + :u, costNano = if_not_exists(costNano, :zero) + :c, userId = :userId, #day = :day, entityType = :entity, updatedAt = :t, ttl = :ttl`,
      ExpressionAttributeNames: { "#day": "day" },
      ExpressionAttributeValues: {
        ":u": units,
        ":c": costNano,
        ":zero": 0,
        ":userId": userId,
        ":day": day,
        ":entity": "UsageDay",
        ":t": now.toISOString(),
        ":ttl": ttl,
      },
    }),
  );
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
    for (const item of result?.Items ?? []) {
      total += (item.costNano as number) ?? 0;
    }
    lastKey = result?.LastEvaluatedKey;
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
    planLabel: PLANS[account.planId]?.label ?? account.planId,
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
