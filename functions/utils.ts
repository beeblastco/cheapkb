import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteVectorsCommand,
  type S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

const SHOO_BASE_URL = "https://shoo.dev";
const SHOO_ISSUER = "https://shoo.dev";
const jwks = createRemoteJWKSet(
  new URL("/.well-known/jwks.json", SHOO_BASE_URL),
);

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
  event: any,
): Promise<{ userId: string; response?: any }> {
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

export async function checkRateLimit(
  userId: string,
  tableName: string,
  operation: string,
  maxTokens: number,
  refillPerHour: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date();
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await dynamo.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `RATE#${userId}`, sk: `LIMIT#${operation}` },
      }),
    );
    const item = result.Item as any;

    if (!item) {
      try {
        await dynamo.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: `RATE#${userId}`,
              sk: `LIMIT#${operation}`,
              entityType: "RateLimit",
              tokens: maxTokens - 1,
              lastRefill: now.toISOString(),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return { allowed: true, remaining: maxTokens - 1 };
      } catch (err: any) {
        if (err.name === "ConditionalCheckFailedException") continue;
        throw err;
      }
    }

    const lastRefill = new Date(item.lastRefill);
    const hoursPassed =
      (now.getTime() - lastRefill.getTime()) / (1000 * 60 * 60);
    let tokens = Math.min(maxTokens, item.tokens + hoursPassed * refillPerHour);

    if (tokens < 1) {
      return { allowed: false, remaining: 0 };
    }

    tokens -= 1;
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: `RATE#${userId}`, sk: `LIMIT#${operation}` },
          UpdateExpression: "SET tokens = :t, lastRefill = :lr",
          ConditionExpression: "lastRefill = :oldLr",
          ExpressionAttributeValues: {
            ":t": tokens,
            ":lr": now.toISOString(),
            ":oldLr": item.lastRefill,
          },
        }),
      );
      return { allowed: true, remaining: Math.floor(tokens) };
    } catch (err: any) {
      if (err.name === "ConditionalCheckFailedException") continue;
      throw err;
    }
  }

  return { allowed: false, remaining: 0 };
}

export async function deleteDocumentVectors(
  documentId: string,
  documentClient: DynamoDBDocumentClient,
  vectorClient: S3VectorsClient,
  tableName: string,
  vectorBucketName: string,
  vectorIndexName: string,
): Promise<any[]> {
  const chunkItems: any[] = [];
  let lastKey: Record<string, any> | undefined;

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
    chunkItems.push(...(chunkRecords.Items ?? []));
    lastKey = chunkRecords.LastEvaluatedKey;
  } while (lastKey);

  const vectorKeys = chunkItems.map((item) => item.chunkId).filter(Boolean);
  for (let i = 0; i < vectorKeys.length; i += 500) {
    await vectorClient.send(
      new DeleteVectorsCommand({
        vectorBucketName,
        indexName: vectorIndexName,
        keys: vectorKeys.slice(i, i + 500),
      }),
    );
  }

  return chunkItems;
}

const CHUNK_DELETE_BACKOFF_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getDocument(
  documentId: string,
  documentClient: DynamoDBDocumentClient,
  tableName: string,
) {
  const result = await documentClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  return result.Item ?? null;
}

export async function deleteDocumentChunkRecords(
  chunkItems: any[],
  documentClient: DynamoDBDocumentClient,
  tableName: string,
) {
  for (let i = 0; i < chunkItems.length; i += 25) {
    let requests: any[] = chunkItems.slice(i, i + 25).map((item) => ({
      DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
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
