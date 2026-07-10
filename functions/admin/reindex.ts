import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { extractUserId } from "../utils";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = Resource.Meta.name;

export async function handler(event: any) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

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

  const doc = result.Item;
  if (doc.userId !== userId) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "You do not have access to this document" }),
    };
  }
  const now = new Date().toISOString();
  const status = doc.status;
  const failedStep = doc.failedStep;

  if (status === "EMBEDDED") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId,
        status,
        message: "Document already embedded, no reindex needed",
      }),
    };
  }

  let targetQueue: string;
  let targetStep: string;
  let messageBody: any;

  if (status === "FAILED" && failedStep === "EMBEDDING") {
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
    targetQueue = Resource.Embed.url;
    targetStep = "EMBEDDING";
    messageBody = { documentId, chunkKeys };
  } else if (status === "FAILED" && failedStep === "CHUNKING") {
    targetQueue = Resource.Chunk.url;
    targetStep = "CHUNKING";
    messageBody = {
      documentId,
      parsedKey: `parsed/${documentId}/v1/pages.json`,
    };
  } else {
    targetQueue = Resource.Ingest.url;
    targetStep = "PARSING";
    messageBody = {
      documentId,
      sourceKey: doc.sourceKey,
      mimeType: doc.mimeType,
    };
  }

  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, lastError = :null, retryCount = :zero, failedStep = :null, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "QUEUED",
        ":null": null,
        ":zero": 0,
        ":t": now,
        ":gsi1pk": "STATUS#QUEUED",
        ":gsi1sk": now,
      },
    }),
  );

  if (targetStep === "EMBEDDING") {
    for (const s3ChunkKey of messageBody.chunkKeys) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: targetQueue,
          MessageBody: JSON.stringify({ documentId, s3ChunkKey }),
        }),
      );
    }
  } else {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: targetQueue,
        MessageBody: JSON.stringify(messageBody),
      }),
    );
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
        Bucket: Resource.Storage.name,
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
