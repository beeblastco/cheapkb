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
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PIPELINE_DLQ_URL = "pipeline-dlq";
  process.env.ADAPTER_DLQ_URL = "adapter-dlq";
  process.env.PIPELINE_QUEUE_URL = "pipeline";
});

import { handler } from "../functions/sweeper/index";

const sqsMock = mockClient(SQSClient);
const lambdaMock = mockClient(LambdaClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);

function queueOnce(queueUrl: string, body: unknown) {
  sqsMock
    .on(ReceiveMessageCommand, { QueueUrl: queueUrl })
    .resolvesOnce({
      Messages: [
        { MessageId: "m1", ReceiptHandle: "r1", Body: JSON.stringify(body) },
      ],
    })
    .resolves({});
}

describe("dead-letter sweeper", () => {
  beforeEach(() => {
    sqsMock.reset();
    lambdaMock.reset();
    dynamoMock.reset();
    sqsMock.on(ReceiveMessageCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "PARSING", updatedAt: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("gives a pipeline message one more try", async () => {
    queueOnce("pipeline-dlq", { stage: "parse", documentId: "doc-1" });

    await handler();

    const sent = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    expect(sent.QueueUrl).toBe("pipeline");
    expect(JSON.parse(String(sent.MessageBody))).toEqual({
      stage: "parse",
      documentId: "doc-1",
      sweeps: 1,
    });
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);
  });

  it("marks the document FAILED when the retry fails too", async () => {
    queueOnce("pipeline-dlq", {
      stage: "embed",
      documentId: "doc-1",
      sweeps: 1,
    });

    await handler();

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    const update = dynamoMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ExpressionAttributeValues).toEqual(
      expect.objectContaining({ ":failed": "FAILED", ":f": "EMBEDDING" }),
    );
  });

  it("drops the message of a document that already failed", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "FAILED", updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    queueOnce("pipeline-dlq", { stage: "parse", documentId: "doc-1" });

    await handler();

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);
  });

  it("leaves the message while a reindex is moving the document", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "PARSING", updatedAt: new Date().toISOString() },
    });
    queueOnce("pipeline-dlq", { stage: "parse", documentId: "doc-1" });

    await handler();

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
  });

  it("re-invokes a failed adapter event once", async () => {
    queueOnce("adapter-dlq", {
      requestContext: { functionArn: "arn:ingest" },
      requestPayload: { Records: [] },
    });

    await handler();

    const invoke = lambdaMock.commandCalls(InvokeCommand)[0].args[0].input;
    expect(invoke.FunctionName).toBe("arn:ingest");
    expect(JSON.parse(String(invoke.Payload))).toEqual({
      Records: [],
      sweeps: 1,
    });
  });

  it("drops an adapter event that already failed its retry", async () => {
    queueOnce("adapter-dlq", {
      requestContext: { functionArn: "arn:ingest" },
      requestPayload: { Records: [], sweeps: 1 },
    });

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);
  });
});
