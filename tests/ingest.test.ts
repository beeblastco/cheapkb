import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
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
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: { pairwise_sub: "user-a" },
  }),
}));

import { handler } from "../functions/admin/ingest";
import { jsonApiEvent } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

describe("manual ingest authorization", () => {
  beforeEach(() => {
    dynamoMock.reset();
    sqsMock.reset();
  });

  it("does not update or enqueue another user's document", async () => {
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk?.startsWith("RATE#")) return {};
      return {
        Item: {
          documentId: "doc-1",
          userId: "user-b",
          sourceKey: "raw/doc-1/file.pdf",
          mimeType: "application/pdf",
        },
      };
    });

    const response = await handler(jsonApiEvent({ documentId: "doc-1" }));

    expect(response.statusCode).toBe(404);
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("queues an uploaded document exactly once", async () => {
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk?.startsWith("RATE#")) return {};
      return {
        Item: {
          documentId: "doc-1",
          userId: "user-a",
          sourceKey: "raw/doc-1/file.pdf",
          mimeType: "application/pdf",
          status: "UPLOADED",
        },
      };
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    const response = await handler(jsonApiEvent({ documentId: "doc-1" }));

    expect(response.statusCode).toBe(200);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("does not enqueue when the S3 adapter already started ingestion", async () => {
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk?.startsWith("RATE#")) return {};
      return {
        Item: {
          documentId: "doc-1",
          userId: "user-a",
          sourceKey: "raw/doc-1/file.pdf",
          mimeType: "application/pdf",
          status: "UPLOADED",
        },
      };
    });
    dynamoMock
      .on(UpdateCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "race" }),
      );

    const response = await handler(jsonApiEvent({ documentId: "doc-1" }));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).alreadyStarted).toBe(true);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("rolls back to uploaded when SQS rejects the job", async () => {
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk?.startsWith("RATE#")) return {};
      return {
        Item: {
          documentId: "doc-1",
          userId: "user-a",
          sourceKey: "raw/doc-1/file.pdf",
          mimeType: "application/pdf",
          status: "UPLOADED",
        },
      };
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).rejects(new Error("SQS unavailable"));

    const response = await handler(jsonApiEvent({ documentId: "doc-1" }));

    expect(response).toEqual({
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to queue document for processing",
      }),
    });

    expect(dynamoMock.commandCalls(UpdateCommand)[1].args[0].input).toEqual(
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ":uploaded": "UPLOADED",
        }),
      }),
    );
  });
});
