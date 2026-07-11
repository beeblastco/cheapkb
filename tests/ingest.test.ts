import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sst", () => ({
  Resource: { Meta: { name: "table" }, Ingest: { url: "queue" } },
}));
vi.mock("../functions/utils", () => ({
  extractUserId: vi.fn().mockResolvedValue({ userId: "user-a" }),
}));

import { handler } from "../functions/admin/ingest";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

describe("manual ingest authorization", () => {
  beforeEach(() => {
    dynamoMock.reset();
    sqsMock.reset();
  });

  it("does not update or enqueue another user's document", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        documentId: "doc-1",
        userId: "user-b",
        sourceKey: "raw/doc-1/file.pdf",
        mimeType: "application/pdf",
      },
    });

    const response = await handler({
      headers: {},
      body: JSON.stringify({ documentId: "doc-1" }),
    });

    expect(response.statusCode).toBe(404);
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("queues an uploaded document exactly once", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        documentId: "doc-1",
        userId: "user-a",
        sourceKey: "raw/doc-1/file.pdf",
        mimeType: "application/pdf",
        status: "UPLOADED",
      },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    const response = await handler({
      headers: {},
      body: JSON.stringify({ documentId: "doc-1" }),
    });

    expect(response.statusCode).toBe(200);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("does not enqueue when the S3 adapter already started ingestion", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        documentId: "doc-1",
        userId: "user-a",
        sourceKey: "raw/doc-1/file.pdf",
        mimeType: "application/pdf",
        status: "UPLOADED",
      },
    });
    dynamoMock
      .on(UpdateCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "race" }),
      );

    const response = await handler({
      headers: {},
      body: JSON.stringify({ documentId: "doc-1" }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).alreadyStarted).toBe(true);
    expect(sqsMock.calls()).toHaveLength(0);
  });
});
