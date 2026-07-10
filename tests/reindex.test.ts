import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
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
vi.mock("../functions/utils", () => ({
  extractUserId: vi.fn().mockResolvedValue({ userId: "owner" }),
}));

import { handler } from "../functions/admin/reindex";

const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("reindex migration", () => {
  beforeEach(() => {
    s3Mock.reset();
    sqsMock.reset();
    dynamoMock.reset();
  });

  it("re-embeds completed documents so tenant metadata can be migrated", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { documentId: "doc-1", userId: "owner", status: "EMBEDDED" },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "chunks/doc-1/chunk_doc-1_0.json" }],
    });
    sqsMock.on(SendMessageBatchCommand).resolves({});

    const response = await handler({
      headers: {},
      pathParameters: { id: "doc-1" },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).restartFrom).toBe("EMBEDDING");
    expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(1);
  });
});
