import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const sqs = new SQSClient({});
const lambda = new LambdaClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const PipelineQueueUrl = process.env.PIPELINE_QUEUE_URL!;
const PipelineDlqUrl = process.env.PIPELINE_DLQ_URL!;
const AdapterDlqUrl = process.env.ADAPTER_DLQ_URL!;
const MAX_BATCHES = 50;
const QUIET_MS = 30 * 60 * 1000;
const SETTLED_STATUSES = new Set(["DELETING", "EMBEDDED", "FAILED"]);
const STAGE_STEPS: Record<string, string> = {
  chunk: "CHUNKING",
  embed: "EMBEDDING",
  parse: "PARSING",
};

/** Runs hourly so nothing that lands in a dead-letter queue is silently lost. */
export async function handler(): Promise<void> {
  await drain(PipelineDlqUrl, redrivePipelineMessage);
  await drain(AdapterDlqUrl, redriveAdapterEvent);
}

/** Drains a dead-letter queue through handle, which returns false to leave
 * a message for the next run. */
async function drain(
  queueUrl: string,
  handle: (body: string) => Promise<boolean>,
): Promise<void> {
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: 300,
        WaitTimeSeconds: 1,
      }),
    );
    if (Messages.length === 0) return;

    for (const message of Messages) {
      try {
        if (!(await handle(message.Body ?? ""))) continue;
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      } catch (err) {
        console.error(`[sweeper] Kept ${message.MessageId} for later:`, err);
      }
    }
  }
}

/** Marks a stuck document FAILED at step unless it already settled. */
async function markFailed(documentId: string, step: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :failed, lastError = :e, failedStep = :f, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :t",
        ConditionExpression:
          "attribute_exists(pk) AND NOT #s IN (:deleting, :embedded, :failed)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":e": "Processing stopped unexpectedly. Reindex to try again.",
          ":embedded": "EMBEDDED",
          ":f": step,
          ":failed": "FAILED",
          ":gsi1pk": "STATUS#FAILED",
          ":t": now,
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}

/** S3 gives up on an adapter after two retries. One more try an hour later covers
 * an outage; a second failure is logged and dropped. */
async function redriveAdapterEvent(body: string): Promise<boolean> {
  const record = parseJson(body) as {
    requestContext?: { functionArn?: string };
    requestPayload?: { sweeps?: number };
  } | null;
  const functionArn = record?.requestContext?.functionArn;
  const payload = record?.requestPayload;
  if (!functionArn || !payload || (payload.sweeps ?? 0) >= 1) {
    console.error("[sweeper] Dropping adapter event:", body);
    return true;
  }

  await lambda.send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: "Event",
      Payload: JSON.stringify({ ...payload, sweeps: 1 }),
    }),
  );
  return true;
}

/** Gives a dead-lettered pipeline message one more try, then marks its document FAILED.
 * A document that already settled, or that a reindex is moving again, is left alone. */
async function redrivePipelineMessage(body: string): Promise<boolean> {
  const message = parseJson(body) as {
    documentId?: string;
    stage?: string;
    sweeps?: number;
  } | null;
  if (
    !message?.documentId ||
    !message.stage ||
    !Object.hasOwn(STAGE_STEPS, message.stage)
  ) {
    console.error("[sweeper] Dropping pipeline message:", body);
    return true;
  }

  const { Item: doc } = await dynamo.send(
    new GetCommand({
      TableName: TableName,
      Key: { pk: `DOC#${message.documentId}`, sk: "META" },
      ConsistentRead: true,
    }),
  );
  if (!doc || SETTLED_STATUSES.has(doc.status)) return true;
  const updatedAt = Date.parse(doc.updatedAt ?? "");
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt < QUIET_MS) {
    return false;
  }

  if ((message.sweeps ?? 0) < 1) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: PipelineQueueUrl,
        MessageBody: JSON.stringify({ ...message, sweeps: 1 }),
      }),
    );
    return true;
  }
  await markFailed(message.documentId, STAGE_STEPS[message.stage]);
  console.log(`[sweeper] Marked ${message.documentId} FAILED`);
  return true;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
