import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  type AttributeValue,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteVectorsCommand,
  GetVectorsCommand,
  PutVectorsCommand,
  type S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DocumentType } from "@smithy/types";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type {
  Account,
  AccountRow,
  ChunkItem,
  DocumentRow,
  Plan,
  UsageCategory,
  UsageSummary,
} from "./types";

const SHOO_BASE_URL = "https://shoo.dev";
const SHOO_ISSUER = "https://shoo.dev";
const jwks = createRemoteJWKSet(
  new URL("/.well-known/jwks.json", SHOO_BASE_URL),
);

const VECTOR_GET_BATCH = 100;
const VECTOR_DELETE_BATCH = 500;
const CHUNK_DELETE_BACKOFF_MS = 100;

const NANO_PER_USD = 1_000_000_000;
const NANO_PER_CENT = NANO_PER_USD / 100;

const EMBEDDING_INPUT_PRICE_PER_1M_TOKENS = (() => {
  const raw = process.env.EMBEDDING_INPUT_PRICE_PER_1M_TOKENS ?? "0.01";
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.01;
})();

const EMBEDDING_INPUT_PRICE_PER_TOKEN =
  EMBEDDING_INPUT_PRICE_PER_1M_TOKENS / 1_000_000;

const PRICING = {
  queryPerRequest: 5_000,
  uploadPerRequest: 2_000,
  ingestPerDocument: 5_000,
  embedPerToken: EMBEDDING_INPUT_PRICE_PER_TOKEN * NANO_PER_USD,
  storagePerGbMonth: 23_000_000,
} as const;

const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;

export const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export function accountId(pk: string) {
  return pk.replace("ACCOUNT#", "");
}

export function chunkId(sk: string) {
  return sk.replace("CHUNK#", "");
}

export function docId(pk: string) {
  return pk.replace("DOC#", "");
}

export async function verifyShooToken(idToken: string, appOrigin: string) {
  const audiences = [
    `origin:${new URL(appOrigin).origin}`,
    "origin:http://localhost:5173",
  ];
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: SHOO_ISSUER,
    audience: audiences,
  });
  if (typeof payload.pairwise_sub !== "string") {
    throw new Error("Shoo token missing pairwise_sub");
  }
  return payload;
}

export async function extractUserId(
  event: APIGatewayProxyEventV2,
): Promise<{ userId: string; response?: unknown }> {
  const authHeader =
    event.headers?.authorization ?? event.headers?.Authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    return {
      userId: "",
      response: {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing authorization token" }),
      },
    };
  }

  const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:5173";
  try {
    const payload = await verifyShooToken(token, appOrigin);
    return { userId: payload.pairwise_sub as string };
  } catch {
    return {
      userId: "",
      response: {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid authorization token" }),
      },
    };
  }
}

// GetVectors caps at 100 keys per call; PutVectors and DeleteVectors allow 500.
export async function listDocumentChunkItems(
  documentId: string,
  documentClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<ChunkItem[]> {
  const chunkItems: ChunkItem[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const chunkRecords = await documentClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `DOC#${documentId}`,
          ":prefix": "CHUNK#",
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    chunkItems.push(
      ...(chunkRecords.Items as unknown as ChunkItem[]).map((item) => ({
        pk: item.pk,
        sk: item.sk,
        s3ChunkKey: item.s3ChunkKey,
        pageStart: item.pageStart,
        pageEnd: item.pageEnd,
        tokenCount: item.tokenCount,
        status: item.status,
        text: item.text,
      })),
    );
    lastKey = chunkRecords.LastEvaluatedKey;
  } while (lastKey);

  return chunkItems;
}

export async function deleteDocumentVectors(
  documentId: string,
  documentClient: DynamoDBDocumentClient,
  vectorClient: S3VectorsClient,
  tableName: string,
  vectorBucketName: string,
  vectorIndexName: string,
): Promise<ChunkItem[]> {
  const chunkItems = await listDocumentChunkItems(
    documentId,
    documentClient,
    tableName,
  );

  const vectorKeys = chunkItems
    .map((item) => chunkId(item.sk))
    .filter((id): id is string => Boolean(id));
  for (let i = 0; i < vectorKeys.length; i += VECTOR_DELETE_BATCH) {
    await vectorClient.send(
      new DeleteVectorsCommand({
        vectorBucketName,
        indexName: vectorIndexName,
        keys: vectorKeys.slice(i, i + VECTOR_DELETE_BATCH),
      }),
    );
  }

  return chunkItems;
}

// PutVectors replaces metadata instead of merging it, so each vector is
// fetched and re-put with only tags swapped to preserve search visibility.
export async function retagDocumentVectors(
  chunkItems: ChunkItem[],
  tags: string[] | null,
  vectorClient: S3VectorsClient,
  vectorBucketName: string,
  vectorIndexName: string,
): Promise<number> {
  const vectorKeys = chunkItems.map((item) => chunkId(item.sk)).filter(Boolean);
  let updated = 0;

  for (let i = 0; i < vectorKeys.length; i += VECTOR_GET_BATCH) {
    const keys = vectorKeys.slice(i, i + VECTOR_GET_BATCH);
    const existing = await vectorClient.send(
      new GetVectorsCommand({
        vectorBucketName,
        indexName: vectorIndexName,
        keys,
        returnData: true,
        returnMetadata: true,
      }),
    );

    const vectors = (existing.vectors ?? [])
      // A chunk with no text is never embedded, so it has no vector to retag.
      .filter((vector) => vector.key && vector.data)
      .map((vector) => ({
        key: vector.key!,
        data: vector.data!,
        metadata: applyTags(vector.metadata, tags),
      }));
    if (vectors.length === 0) continue;

    await vectorClient.send(
      new PutVectorsCommand({
        vectorBucketName,
        indexName: vectorIndexName,
        vectors,
      }),
    );
    updated += vectors.length;
  }

  return updated;
}

export async function getDocument(
  documentId: string,
  documentClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<DocumentRow | null> {
  const result = await documentClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  return (result.Item as DocumentRow | undefined) ?? null;
}

export async function deleteDocumentChunkRecords(
  chunkItems: ChunkItem[],
  documentClient: DynamoDBDocumentClient,
  tableName: string,
) {
  for (let i = 0; i < chunkItems.length; i += 25) {
    let requests: WriteRequest[] = chunkItems.slice(i, i + 25).map((item) => ({
      DeleteRequest: {
        Key: { pk: item.pk, sk: item.sk } as unknown as Record<
          string,
          AttributeValue
        >,
      },
    }));

    for (let attempt = 0; requests.length > 0 && attempt < 3; attempt++) {
      // Back off before resending throttled items so retries don't hammer the
      // same throttling window.
      if (attempt > 0)
        await delay(2 ** (attempt - 1) * CHUNK_DELETE_BACKOFF_MS);
      const response = await documentClient.send(
        new BatchWriteCommand({
          RequestItems: { [tableName]: requests },
        }),
      );
      requests = response.UnprocessedItems?.[tableName] ?? [];
    }

    if (requests.length > 0) {
      throw new Error("Failed to delete DynamoDB chunk records");
    }
  }
}

export async function deleteDocumentS3Data(
  documentId: string,
  s3Client: S3Client,
  storageBucketName: string,
) {
  await deleteS3Prefix(`chunks/${documentId}/`, s3Client, storageBucketName);
  await deleteS3Prefix(`parsed/${documentId}/`, s3Client, storageBucketName);
}

export async function deleteS3Prefix(
  prefix: string,
  s3Client: S3Client,
  storageBucketName: string,
): Promise<number> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  let count = 0;

  do {
    const list = await s3Client.send(
      new ListObjectVersionsCommand({
        Bucket: storageBucketName,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );
    const objects = [...(list.Versions ?? []), ...(list.DeleteMarkers ?? [])];
    if (objects.length === 0) return count;

    const response = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: storageBucketName,
        Delete: {
          Objects: objects.map((object) => ({
            Key: object.Key!,
            VersionId: object.VersionId,
          })),
          Quiet: true,
        },
      }),
    );
    if (response.Errors?.length) {
      throw new Error("Failed to delete S3 versions");
    }
    count += objects.length;
    keyMarker = list.IsTruncated ? list.NextKeyMarker : undefined;
    versionIdMarker = list.IsTruncated ? list.NextVersionIdMarker : undefined;
  } while (keyMarker);

  return count;
}

export async function checkRateLimit(
  userId: string,
  tableName: string,
  operation: string,
  maxTokens: number,
  refillPerHour: number,
  documentClient: DynamoDBDocumentClient = dynamo,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date();
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `RATE#${userId}`, sk: `LIMIT#${operation}` },
      }),
    );
    const item = result.Item as Record<string, unknown> | null;

    if (!item) {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: `RATE#${userId}`,
              sk: `LIMIT#${operation}`,
              tokens: maxTokens - 1,
              lastRefill: now.toISOString(),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return { allowed: true, remaining: maxTokens - 1 };
      } catch (err) {
        if ((err as Error).name === "ConditionalCheckFailedException") continue;
        throw err;
      }
    }

    const lastRefill = new Date(item.lastRefill as string);
    const hoursPassed =
      (now.getTime() - lastRefill.getTime()) / (1000 * 60 * 60);
    let tokens = Math.min(
      maxTokens,
      (item.tokens as number) + hoursPassed * refillPerHour,
    );

    if (tokens < 1) {
      return { allowed: false, remaining: 0 };
    }

    tokens -= 1;
    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: `RATE#${userId}`, sk: `LIMIT#${operation}` },
          UpdateExpression: "SET tokens = :t, lastRefill = :lr",
          ConditionExpression: "lastRefill = :oldLr",
          ExpressionAttributeValues: {
            ":t": tokens,
            ":lr": now.toISOString(),
            ":oldLr": item.lastRefill as string,
          },
        }),
      );
      return { allowed: true, remaining: Math.floor(tokens) };
    } catch (err) {
      if ((err as Error).name === "ConditionalCheckFailedException") continue;
      throw err;
    }
  }

  return { allowed: false, remaining: 0 };
}

export async function getPlan(
  planId: string,
  plansTableName: string,
): Promise<Plan | null> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: plansTableName,
      Key: { pk: `PLAN#${planId}`, sk: "PLAN" },
    }),
  );
  return (result?.Item as unknown as Plan) ?? null;
}

export async function listPlans(plansTableName: string): Promise<Plan[]> {
  const plans: Plan[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: plansTableName,
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result?.Items ?? []) {
      plans.push(item as unknown as Plan);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return plans;
}

export async function getDefaultPlan(
  plansTableName?: string,
): Promise<Plan | null> {
  return getPlan(
    defaultPlanId(),
    plansTableName ?? process.env.PLANS_TABLE_NAME!,
  );
}

export async function getOrCreateAccount(
  userId: string,
  tableName: string,
): Promise<AccountRow> {
  const pk = `ACCOUNT#${userId}`;
  const sk = "PROFILE";
  const existing = await dynamo.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk } }),
  );
  if (existing.Item) return existing.Item as AccountRow;

  const now = new Date().toISOString();
  const defaultPlan = await getDefaultPlan();
  const account: AccountRow = {
    pk: pk,
    sk: sk,
    planId: defaultPlan?.planId ?? defaultPlanId(),
    priceMonthlyCents: defaultPlan?.priceMonthlyCents ?? 0,
    monthlyAllowanceCents: defaultPlan?.monthlyAllowanceCents ?? 0,
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
      return retry.Item as AccountRow;
    }
    throw error;
  }
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

  const plan = await getPlan(account.planId, process.env.PLANS_TABLE_NAME!);

  return {
    planId: account.planId,
    planLabel: plan?.label ?? account.planId,
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

export async function sumUsageNano(
  userId: string,
  tableName: string,
  startDay: string,
  endDay: string,
): Promise<number> {
  let total = 0;
  let lastKey: Record<string, unknown> | undefined;
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

export async function updatePlan(
  userId: string,
  plansTableName: string,
  accountsTableName: string,
  planId: string,
): Promise<AccountRow | null> {
  const plan = await getPlan(planId, plansTableName);
  if (!plan) return null;
  const pk = `ACCOUNT#${userId}`;
  const sk = "PROFILE";
  const now = new Date().toISOString();
  await getOrCreateAccount(userId, accountsTableName);
  const result = await dynamo.send(
    new UpdateCommand({
      TableName: accountsTableName,
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
  return result.Attributes as AccountRow;
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
  if (category === "embed")
    costNano = Math.round(units * PRICING.embedPerToken);

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
      UpdateExpression: `SET ${field} = if_not_exists(${field}, :zero) + :u, costNano = if_not_exists(costNano, :zero) + :c, #day = :day, updatedAt = :t, ttl = :ttl`,
      ExpressionAttributeNames: { "#day": "day" },
      ExpressionAttributeValues: {
        ":u": units,
        ":c": costNano,
        ":zero": 0,
        ":day": day,
        ":t": now.toISOString(),
        ":ttl": ttl,
      },
    }),
  );
}

export async function recordQueryAndEmbedUsage(
  userId: string,
  tableName: string,
  queryUnits: number,
  embedTokens: number,
): Promise<void> {
  if (queryUnits <= 0 && embedTokens <= 0) return;

  const now = new Date();
  const day = dayKey(now.getTime());
  const pk = `ACCOUNT#${userId}`;
  const sk = `USAGE#${day}`;
  const ttl = Math.floor(now.getTime() / 1000) + 90 * 24 * 60 * 60;
  const costNano =
    queryUnits * PRICING.queryPerRequest +
    Math.round(embedTokens * PRICING.embedPerToken);

  await dynamo.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression:
        "SET queryOps = if_not_exists(queryOps, :zero) + :q, embedTokens = if_not_exists(embedTokens, :zero) + :e, costNano = if_not_exists(costNano, :zero) + :c, #day = :day, updatedAt = :t, ttl = :ttl",
      ExpressionAttributeNames: { "#day": "day" },
      ExpressionAttributeValues: {
        ":q": queryUnits,
        ":e": embedTokens,
        ":c": costNano,
        ":zero": 0,
        ":day": day,
        ":t": now.toISOString(),
        ":ttl": ttl,
      },
    }),
  );
}

function defaultPlanId(): string {
  return process.env.DEFAULT_PLAN_ID ?? "basic";
}

function centsToNanoUsd(cents: number): number {
  return cents * NANO_PER_CENT;
}

function nanoUsdToUsd(nano: number): number {
  return nano / NANO_PER_USD;
}

function storageCostNanoUsd(bytes: number, seconds: number): number {
  const gb = bytes / (1024 * 1024 * 1024);
  const prorated = (seconds / SECONDS_PER_MONTH) * gb;
  return Math.round(prorated * PRICING.storagePerGbMonth);
}

function allowanceNanoUsd(account: Account): number {
  return centsToNanoUsd(account.monthlyAllowanceCents);
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Billing cycles anchor on account creation day-of-month and advance by full
// months. Days 29-31 clamp to shorter month ends so boundaries stay valid.
function currentCycle(account: Account, nowMs: number) {
  const created = new Date(account.createdAt);
  const anchorDay = created.getUTCDate();
  const year = created.getUTCFullYear();
  const month = created.getUTCMonth();
  const time: [number, number, number, number] = [
    created.getUTCHours(),
    created.getUTCMinutes(),
    created.getUTCSeconds(),
    created.getUTCMilliseconds(),
  ];

  let index = 0;
  while (monthAnchor(year, month + index + 1, anchorDay, time) <= nowMs)
    index++;

  return {
    startMs: monthAnchor(year, month + index, anchorDay, time),
    endMs: monthAnchor(year, month + index + 1, anchorDay, time),
  };
}

function monthAnchor(
  year: number,
  monthIndex: number,
  day: number,
  time: [number, number, number, number],
): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Date.UTC(year, monthIndex, Math.min(day, lastDay), ...time);
}

function applyTags(
  metadata: DocumentType | undefined,
  tags: string[] | null,
): DocumentType {
  const next: Record<string, DocumentType> = {
    ...(metadata as Record<string, DocumentType> | undefined),
  };
  // The embed step omits the key rather than storing an empty value; match it so
  // retagged vectors keep the same shape as freshly built ones.
  if (tags && tags.length > 0) next.tags = tags;
  else delete next.tags;
  return next;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// embedTokens tracks input tokens (not chunk count) so cost is based on
// the configured embedding model price per 1M input tokens.
function categoryField(category: UsageCategory): string {
  if (category === "query") return "queryOps";
  if (category === "upload") return "uploadOps";
  if (category === "ingest") return "ingestOps";
  return "embedTokens";
}

export {
  centsToNanoUsd,
  currentCycle,
  dayKey,
  NANO_PER_CENT,
  NANO_PER_USD,
  nanoUsdToUsd,
  PRICING,
  storageCostNanoUsd,
};
