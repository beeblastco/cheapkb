import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DocumentRow } from "../types";
import { checkRateLimit, checkUsageLimit, extractUserId } from "../utils";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const PipelineQueueUrl = process.env.PIPELINE_QUEUE_URL!;
const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;
const RateLimitsTableName = process.env.RATE_LIMITS_TABLE_NAME!;
// SQS gives a message 3 receives at 900s visibility, so a document still in a
// processing status after an hour is stuck and safe to restart.
const STALE_PROCESSING_MS = 60 * 60 * 1000;
const PROCESSING_STATUSES = new Set([
  "QUEUED",
  "PARSING",
  "PARSED",
  "CHUNKING",
  "CHUNKED",
  "EMBEDDING",
]);

interface ReindexMessage {
  documentId: string;
  chunkKeys?: string[];
  parsedKey?: string;
  sourceKey?: string;
  mimeType?: string;
}

export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const { allowed, remaining } = await checkRateLimit(
    userId,
    RateLimitsTableName,
    "REINDEX",
    10,
    10,
  );
  if (!allowed) {
    return {
      statusCode: 429,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": String(remaining),
      },
      body: JSON.stringify({
        error: "Rate limit exceeded. Try again later.",
      }),
    };
  }

  const { allowed: usageAllowed } = await checkUsageLimit(
    userId,
    AccountsTableName,
  );
  if (!usageAllowed) {
    return {
      statusCode: 429,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Monthly usage allowance reached. Upgrade to continue.",
      }),
    };
  }

  const documentId = event.pathParameters?.id;
  if (!documentId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document ID is required" }),
    };
  }

  const result = await dynamo.send(
    new GetCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  if (!result.Item) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document not found" }),
    };
  }

  const doc = result.Item as DocumentRow;
  if (doc.userId !== userId) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document not found" }),
    };
  }
  const now = new Date().toISOString();
  const status = doc.status;
  const failedStep = doc.failedStep;

  const updatedAtMs = Date.parse(doc.updatedAt ?? "");
  const stale =
    PROCESSING_STATUSES.has(status) &&
    Number.isFinite(updatedAtMs) &&
    Date.now() - updatedAtMs > STALE_PROCESSING_MS;
  const restartable =
    status === "EMBEDDED" ||
    (status === "FAILED" && failedStep !== "UPLOAD") ||
    stale;
  if (!restartable) {
    return {
      statusCode: 409,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error:
          status === "FAILED"
            ? "Upload the file again instead of reindexing"
            : "Document is still processing",
        status,
      }),
    };
  }

  let targetStage: string;
  let targetStep: string;
  let messageBody: ReindexMessage;

  if (
    status === "EMBEDDED" ||
    status === "CHUNKED" ||
    status === "EMBEDDING" ||
    (status === "FAILED" && failedStep === "EMBEDDING")
  ) {
    const chunkKeys = await listChunkKeys(documentId);
    if (chunkKeys.length === 0) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "No chunks found to re-embed; restart from CHUNKING",
        }),
      };
    }
    targetStage = "embed";
    targetStep = "EMBEDDING";
    messageBody = { documentId, chunkKeys };
  } else if (
    status === "PARSED" ||
    status === "CHUNKING" ||
    (status === "FAILED" && failedStep === "CHUNKING")
  ) {
    targetStage = "chunk";
    targetStep = "CHUNKING";
    messageBody = {
      documentId,
      parsedKey: `parsed/${documentId}/v1/${doc.mimeType?.startsWith("image/") ? "image.json" : "pages.json"}`,
    };
  } else {
    targetStage = "parse";
    targetStep = "PARSING";
    messageBody = {
      documentId,
      sourceKey: doc.sourceKey,
      mimeType: doc.mimeType ?? undefined,
    };
  }

  // The status and updatedAt match makes a second concurrent reindex lose.
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :s, lastError = :null, retryCount = :zero, embeddedCount = :zero, failedStep = :null, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
        ConditionExpression: doc.updatedAt
          ? "#s = :current AND updatedAt = :updatedAt"
          : "#s = :current AND attribute_not_exists(updatedAt)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "QUEUED",
          ":current": status,
          ...(doc.updatedAt ? { ":updatedAt": doc.updatedAt } : {}),
          ":null": null,
          ":zero": 0,
          ":t": now,
          ":gsi1pk": "STATUS#QUEUED",
          ":gsi1sk": now,
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
    return {
      statusCode: 409,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document changed, try again" }),
    };
  }

  if (targetStep === "EMBEDDING") {
    const reindexChunkKeys = messageBody.chunkKeys ?? [];
    await resetChunkStatuses(documentId, reindexChunkKeys);
    for (let i = 0; i < reindexChunkKeys.length; i += 10) {
      const chunkKeys = reindexChunkKeys.slice(i, i + 10);
      try {
        const response = await sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: PipelineQueueUrl,
            Entries: chunkKeys.map((s3ChunkKey: string, index: number) => ({
              Id: String(index),
              MessageBody: JSON.stringify({
                stage: "embed",
                documentId,
                s3ChunkKey,
              }),
            })),
          }),
        );
        if (response.Failed?.length) {
          return {
            statusCode: 500,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              error: "Failed to queue some chunks for re-embedding",
            }),
          };
        }
      } catch {
        return {
          statusCode: 500,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: "Failed to queue chunks for re-embedding",
          }),
        };
      }
    }
  } else {
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: PipelineQueueUrl,
          MessageBody: JSON.stringify({ stage: targetStage, ...messageBody }),
        }),
      );
    } catch {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: `Failed to queue document for ${targetStep}`,
        }),
      };
    }
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      documentId,
      status: "QUEUED",
      restartFrom: targetStep,
      message: `Reindex started from ${targetStep}`,
    }),
  };
}

async function listChunkKeys(documentId: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: StorageBucketName,
        Prefix: `chunks/${documentId}/`,
        ContinuationToken: token,
      }),
    );
    for (const obj of list.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

// Updated 25 at a time so a 1,000-chunk document resets inside the timeout.
async function resetChunkStatuses(documentId: string, chunkKeys: string[]) {
  const chunkIds = chunkKeys
    .map((chunkKey) =>
      chunkKey
        .split("/")
        .pop()
        ?.replace(/\.json$/, ""),
    )
    .filter((chunkId): chunkId is string => Boolean(chunkId));
  for (let start = 0; start < chunkIds.length; start += 25) {
    await Promise.all(
      chunkIds.slice(start, start + 25).map((chunkId) =>
        dynamo.send(
          new UpdateCommand({
            TableName,
            Key: { pk: `DOC#${documentId}`, sk: `CHUNK#${chunkId}` },
            UpdateExpression: "SET #s = :queued",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":queued": "QUEUED" },
          }),
        ),
      ),
    );
  }
}
