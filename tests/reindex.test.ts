import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
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
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sst", () => ({
  Resource: {
    Meta: { name: "table" },
    Storage: { name: "storage" },
    Ingest: { url: "ingest-queue" },
    Chunk: { url: "chunk-queue" },
    Embed: { url: "embed-queue" },
  },
}));
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: { pairwise_sub: "owner" },
  }),
}));
const limits = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  checkUsageLimit: vi.fn(),
}));
vi.mock("../functions/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../functions/utils")>()),
  checkRateLimit: limits.checkRateLimit,
  checkUsageLimit: limits.checkUsageLimit,
}));

import { handler } from "../functions/admin/reindex";
import { apiEvent } from "./helpers/events";

const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("reindex migration", () => {
  beforeEach(() => {
    s3Mock.reset();
    sqsMock.reset();
    dynamoMock.reset();
    limits.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
    limits.checkUsageLimit.mockResolvedValue({ allowed: true });
  });

  it("re-embeds completed documents so tenant metadata can be migrated", async () => {
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk?.startsWith("RATE#")) return {};
      return {
        Item: {
          documentId: "doc-1",
          userId: "owner",
          status: "EMBEDDED",
          updatedAt: new Date().toISOString(),
        },
      };
    });
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "chunks/doc-1/chunk_doc-1_0.json" }],
    });
    sqsMock.on(SendMessageBatchCommand).resolves({});

    const response = await handler(
      apiEvent({ pathParameters: { id: "doc-1" } }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).restartFrom).toBe("EMBEDDING");
    expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(1);
    const chunkReset = dynamoMock
      .commandCalls(UpdateCommand)
      .find((call) => call.args[0].input.Key?.sk === "CHUNK#chunk_doc-1_0");
    expect(chunkReset?.args[0].input.UpdateExpression).toContain(
      "REMOVE embedClaimedAt",
    );
  });

  it("restarts failed image chunking from the image manifest", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        documentId: "doc-1",
        userId: "owner",
        status: "FAILED",
        failedStep: "CHUNKING",
        mimeType: "image/png",
        updatedAt: new Date().toISOString(),
      },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    const response = await handler(
      apiEvent({ pathParameters: { id: "doc-1" } }),
    );

    expect(response.statusCode).toBe(200);
    const message = JSON.parse(
      String(
        sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody,
      ),
    );
    expect(message).toEqual(
      expect.objectContaining({
        stage: "chunk",
        parsedKey: "parsed/doc-1/v1/image.json",
      }),
    );
  });

  it("refuses a document that is still processing", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        documentId: "doc-1",
        userId: "owner",
        status: "EMBEDDING",
        updatedAt: new Date().toISOString(),
      },
    });

    const response = await handler(
      apiEvent({ pathParameters: { id: "doc-1" } }),
    );

    expect(response.statusCode).toBe(409);
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("restarts a document stuck in processing for over an hour", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        documentId: "doc-1",
        userId: "owner",
        status: "PARSING",
        sourceKey: "raw/doc-1/file.pdf",
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    const response = await handler(
      apiEvent({ pathParameters: { id: "doc-1" } }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).restartFrom).toBe("PARSING");
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(1);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("refuses when the rate limit or usage allowance is used up", async () => {
    limits.checkRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
    });
    const rateLimited = await handler(
      apiEvent({ pathParameters: { id: "doc-1" } }),
    );
    limits.checkUsageLimit.mockResolvedValueOnce({ allowed: false });
    const overAllowance = await handler(
      apiEvent({ pathParameters: { id: "doc-1" } }),
    );

    expect(rateLimited.statusCode).toBe(429);
    expect(overAllowance.statusCode).toBe(429);
    expect(dynamoMock.calls()).toHaveLength(0);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("lets only one of two concurrent reindexes start", async () => {
    const stored = {
      documentId: "doc-1",
      userId: "owner",
      status: "FAILED",
      failedStep: "PARSING",
      sourceKey: "raw/doc-1/file.pdf",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const snapshot = { ...stored };
    dynamoMock.on(GetCommand).resolves({ Item: snapshot });
    dynamoMock.on(UpdateCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues;
      if (
        stored.status !== values[":current"] ||
        stored.updatedAt !== values[":updatedAt"]
      ) {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        });
      }
      stored.status = values[":s"];
      stored.updatedAt = values[":t"];
      return {};
    });
    sqsMock.on(SendMessageCommand).resolves({});

    const responses = await Promise.all([
      handler(apiEvent({ pathParameters: { id: "doc-1" } })),
      handler(apiEvent({ pathParameters: { id: "doc-1" } })),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });
});
