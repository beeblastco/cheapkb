import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { AccountRow, DocumentRow } from "../types";
import { checkRateLimit, extractUserId, updateStorageBytes } from "../utils";

const s3 = new S3Client({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;
const TagsTableName = process.env.TAGS_TABLE_NAME!;
const RateLimitsTableName = process.env.RATE_LIMITS_TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const BATCH_SIZE = 25;

// Deletes every document and tag the caller owns and brings stored bytes to 0.
// Usage history stays, so a reset never grants a fresh allowance.
export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const { allowed } = await checkRateLimit(
    userId,
    RateLimitsTableName,
    "RESET",
    3,
    3,
  );
  if (!allowed) {
    return json(429, { error: "Rate limit exceeded. Try again later." });
  }

  try {
    const documents = await listDocuments(userId);
    const account = await dynamo.send(
      new GetCommand({
        TableName: AccountsTableName,
        Key: { pk: `ACCOUNT#${userId}`, sk: "PROFILE" },
        ConsistentRead: true,
      }),
    );
    const storedBytes =
      (account.Item as AccountRow | undefined)?.storageBytes ?? 0;

    // Marking returns each document's current row, so the counted bytes are
    // read consistently, not from the eventually consistent index.
    let countedBytes = 0;
    for (let start = 0; start < documents.length; start += BATCH_SIZE) {
      const marked = await Promise.all(
        documents.slice(start, start + BATCH_SIZE).map(markDeleting),
      );
      for (const bytes of marked) countedBytes += bytes;
    }

    // Bytes counted on no document are drift from earlier failed deletes. They
    // go before any cleanup starts, and only if the total hasn't moved since.
    if (storedBytes > countedBytes) {
      await updateStorageBytes(
        userId,
        AccountsTableName,
        countedBytes - storedBytes,
        undefined,
        undefined,
        storedBytes,
      );
    }

    // A delete marker on each source runs the cleanup adapter, which removes
    // the document's data and subtracts its counted bytes.
    for (let start = 0; start < documents.length; start += BATCH_SIZE) {
      await Promise.all(
        documents
          .slice(start, start + BATCH_SIZE)
          .filter((document) => document.sourceKey)
          .map((document) =>
            s3.send(
              new DeleteObjectCommand({
                Bucket: StorageBucketName,
                Key: document.sourceKey,
              }),
            ),
          ),
      );
    }

    const deletedTags = await deleteTags(userId);
    return json(202, {
      deletingDocuments: documents.length,
      deletedTags: deletedTags,
    });
  } catch (error) {
    console.error("[reset]", error);
    return json(500, { error: "Failed to delete your data. Try again." });
  }
}

async function deleteTags(userId: string): Promise<number> {
  let deleted = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamo.send(
      new QueryCommand({
        TableName: TagsTableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":prefix": "TAG#",
        },
        ProjectionExpression: "pk, sk",
        ExclusiveStartKey: lastKey,
      }),
    );
    const keys = page.Items ?? [];
    for (let start = 0; start < keys.length; start += 25) {
      let requests = keys.slice(start, start + 25).map((key) => ({
        DeleteRequest: { Key: { pk: key.pk, sk: key.sk } },
      }));
      // Throttled deletes come back as UnprocessedItems and are sent again.
      for (let attempt = 0; requests.length > 0 && attempt < 3; attempt++) {
        const response = await dynamo.send(
          new BatchWriteCommand({
            RequestItems: { [TagsTableName]: requests },
          }),
        );
        requests = (response.UnprocessedItems?.[TagsTableName] ??
          []) as typeof requests;
      }
      if (requests.length > 0) throw new Error("Failed to delete tags");
    }
    deleted += keys.length;
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return deleted;
}

async function listDocuments(userId: string): Promise<DocumentRow[]> {
  const documents: DocumentRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamo.send(
      new QueryCommand({
        TableName,
        IndexName: "GSI2",
        KeyConditionExpression: "gsi2pk = :pk",
        ExpressionAttributeValues: { ":pk": `USER#${userId}` },
        ExclusiveStartKey: lastKey,
      }),
    );
    documents.push(...((page.Items as DocumentRow[] | undefined) ?? []));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return documents;
}

// Returns the document's counted bytes, or 0 if it was already gone.
async function markDeleting(document: DocumentRow): Promise<number> {
  const now = new Date().toISOString();
  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: document.pk, sk: "META" },
        UpdateExpression:
          "SET #s = :s, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :t REMOVE lastError",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":gsi1pk": "STATUS#DELETING",
          ":s": "DELETING",
          ":t": now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return (result.Attributes as DocumentRow | undefined)?.countedBytes ?? 0;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return 0;
    throw error;
  }
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode: statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
