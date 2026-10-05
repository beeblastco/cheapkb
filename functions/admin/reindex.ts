import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  checkRateLimit,
  checkUsageLimit,
  dynamo,
  extractUserId,
  getDocument,
} from "../utils";

const sqs = new SQSClient({});
const TableName = process.env.TABLE_NAME!;
const PipelineQueueUrl = process.env.PIPELINE_QUEUE_URL!;
const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;
const RateLimitsTableName = process.env.RATE_LIMITS_TABLE_NAME!;
// SQS gives a message 3 receives at 900s visibility, so a document still in a
// processing status after an hour is stuck and safe to restart.
const STALE_PROCESSING_MS = 60 * 60 * 1000;
// Matches the ingest adapter's grace for a late replacement POST, so a reindex
// never races a replacement that may still land.
const REPLACEMENT_GRACE_MS = 15 * 60 * 1000;
const PROCESSING_STATUSES = new Set([
  "QUEUED",
  "PARSING",
  "PARSED",
  "CHUNKING",
  "CHUNKED",
  "EMBEDDING",
]);

/** POST /documents/{id}/reindex: requeues a settled or stuck document from its last good stage. */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
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

  const doc = await getDocument(documentId, dynamo, TableName, false);
  if (!doc || doc.userId !== userId) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document not found" }),
    };
  }
  if (
    Date.parse(doc.replacementExpiresAt ?? "") + REPLACEMENT_GRACE_MS >
    Date.now()
  ) {
    return {
      statusCode: 409,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "A replacement upload is pending; try again once it finishes",
      }),
    };
  }
  const now = new Date().toISOString();
  const { status, failedStep } = doc;

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
        status: status,
      }),
    };
  }

  // Chunking is deterministic from the parsed file, so a document that reached
  // chunking restarts there and re-embeds every chunk it produces.
  const rechunk =
    status === "PARSED" ||
    status === "CHUNKING" ||
    status === "CHUNKED" ||
    status === "EMBEDDING" ||
    status === "EMBEDDED" ||
    (status === "FAILED" &&
      (failedStep === "CHUNKING" || failedStep === "EMBEDDING"));
  const targetStep = rechunk ? "CHUNKING" : "PARSING";

  // The status and updatedAt match makes a second concurrent reindex lose. A pending
  // replacement deletes the chunks it would re-chunk, so it refuses that too.
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :s, lastError = :null, retryCount = :zero, embeddedCount = :zero, failedStep = :null, updatedAt = :t",
        ConditionExpression: doc.updatedAt
          ? "#s = :current AND updatedAt = :updatedAt AND (attribute_not_exists(replacementToken) OR attribute_not_exists(replacementExpiresAt) OR replacementExpiresAt < :replacementCutoff)"
          : "#s = :current AND attribute_not_exists(updatedAt) AND (attribute_not_exists(replacementToken) OR attribute_not_exists(replacementExpiresAt) OR replacementExpiresAt < :replacementCutoff)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "QUEUED",
          ":current": status,
          ...(doc.updatedAt ? { ":updatedAt": doc.updatedAt } : {}),
          ":null": null,
          ":zero": 0,
          ":t": now,
          ":replacementCutoff": new Date(
            Date.parse(now) - REPLACEMENT_GRACE_MS,
          ).toISOString(),
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

  // reindexedAt lets a redelivered chunk message redo chunks embedded before now.
  const message = rechunk
    ? {
        stage: "chunk",
        documentId: documentId,
        parsedKey: `parsed/${documentId}/v1/${doc.mimeType?.startsWith("image/") ? "image.json" : "pages.json"}`,
        reindexedAt: now,
      }
    : {
        stage: "parse",
        documentId: documentId,
        sourceKey: doc.sourceKey,
        mimeType: doc.mimeType ?? undefined,
      };
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: PipelineQueueUrl,
        MessageBody: JSON.stringify(message),
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
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      documentId: documentId,
      status: "QUEUED",
      restartFrom: targetStep,
      message: `Reindex started from ${targetStep}`,
    }),
  };
}
