import {
  DynamoDBClient,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { centsToNanoUsd, DEFAULT_PLAN, PLANS, type Plan } from "./pricing";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface Account {
  pk: string;
  sk: string;
  entityType: "Account";
  userId: string;
  planId: string;
  priceMonthlyCents: number;
  monthlyAllowanceCents: number;
  storageBytes: number;
  createdAt: string;
  updatedAt: string;
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
    pk,
    sk,
    entityType: "Account",
    userId,
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

export function planFromId(planId: string): Plan {
  return PLANS[planId] ?? DEFAULT_PLAN;
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

export function allowanceNanoUsd(account: Account): number {
  return centsToNanoUsd(account.monthlyAllowanceCents);
}
