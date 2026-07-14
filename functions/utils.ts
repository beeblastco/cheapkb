import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
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

// GetVectors caps at 100 keys per call; PutVectors and DeleteVectors allow 500.
const VECTOR_GET_BATCH = 100;
const VECTOR_DELETE_BATCH = 500;

export async function listDocumentChunkItems(
  documentId: string,
  documentClient: DynamoDBDocumentClient,
  tableName: string,
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

  return chunkItems;
}

export async function deleteDocumentVectors(
  documentId: string,
  documentClient: DynamoDBDocumentClient,
  vectorClient: S3VectorsClient,
  tableName: string,
  vectorBucketName: string,
  vectorIndexName: string,
): Promise<any[]> {
  const chunkItems = await listDocumentChunkItems(
    documentId,
    documentClient,
    tableName,
  );

  const vectorKeys = chunkItems.map((item) => item.chunkId).filter(Boolean);
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

// PutVectors requires data and replaces metadata instead of merging it, so each
// vector is read back and re-put with only tags swapped. Dropping any other key
// would break search silently: losing userId hides the chunk from its owner.
export async function retagDocumentVectors(
  chunkItems: any[],
  tags: string[] | null,
  vectorClient: S3VectorsClient,
  vectorBucketName: string,
  vectorIndexName: string,
): Promise<number> {
  const vectorKeys = chunkItems.map((item) => item.chunkId).filter(Boolean);
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

function applyTags(metadata: any, tags: string[] | null): Record<string, any> {
  const next = { ...(metadata ?? {}) };
  // The embed step omits the key rather than storing an empty value; match it so
  // retagged vectors keep the same shape as freshly built ones.
  if (tags && tags.length > 0) next.tags = tags;
  else delete next.tags;
  return next;
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
