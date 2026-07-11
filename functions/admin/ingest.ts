import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { extractUserId } from "../utils";

const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const IngestQueueUrl = process.env.INGEST_QUEUE_URL!;

export async function handler(event: any) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  if (!event.body) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Request body is required" }),
    };
  }
  let body: any;
  try {
    body = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON in request body" }),
    };
  }

  const documentId = body.documentId;
  if (!documentId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "documentId is required" }),
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
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Document not found" }),
    };
  }
  const now = new Date().toISOString();

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :queued, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
        ExpressionAttributeNames: { "#s": "status" },
        ConditionExpression: "userId = :userId AND #s = :uploaded",
        ExpressionAttributeValues: {
          ":queued": "QUEUED",
          ":uploaded": "UPLOADED",
          ":t": now,
          ":gsi1pk": "STATUS#QUEUED",
          ":gsi1sk": now,
          ":userId": userId,
        },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId,
          status: doc.status,
          alreadyStarted: true,
        }),
      };
    }
    throw error;
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: IngestQueueUrl,
      MessageBody: JSON.stringify({
        documentId,
        sourceKey: doc.sourceKey,
        mimeType: doc.mimeType,
      }),
    }),
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, status: "QUEUED" }),
  };
}
