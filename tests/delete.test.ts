import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sst", () => ({
  Resource: { Meta: { name: "table" }, Storage: { name: "storage" } },
}));
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: { pairwise_sub: "owner" },
  }),
}));

import { handler } from "../functions/admin/delete";
import { apiEvent } from "./helpers/events";

const s3Mock = mockClient(S3Client);
const vectorsMock = mockClient(S3VectorsClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("document deletion", () => {
  beforeEach(() => {
    s3Mock.reset();
    vectorsMock.reset();
    dynamoMock.reset();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk?.startsWith("RATE#")) return {};
      return {
        Item: {
          documentId: "doc-1",
          userId: "owner",
          dedupeKey: "dedupe-1",
          sourceKey: "raw/doc-1/file.pdf",
        },
      };
    });
  });

  it("preserves DynamoDB cleanup keys when vector deletion fails", async () => {
    dynamoMock.on(QueryCommand).resolves({
      Items: [{ pk: "DOC#doc-1", sk: "CHUNK#1", chunkId: "chunk-1" }],
    });
    vectorsMock.on(DeleteVectorsCommand).rejects(new Error("vector failure"));
    s3Mock.on(ListObjectVersionsCommand).resolves({});

    const response = await handler(
      apiEvent({ pathParameters: { id: "doc-1" } }),
    );

    expect(response.statusCode).toBe(500);
    expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it("deletes every S3 object version before metadata", async () => {
    dynamoMock.on(QueryCommand).resolves({ Items: [] });
    dynamoMock.on(BatchWriteCommand).resolves({});
    dynamoMock.on(DeleteCommand).resolves({});
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [{ Key: "raw/doc-1/file.pdf", VersionId: "version-1" }],
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const response = await handler(
      apiEvent({ pathParameters: { id: "doc-1" } }),
    );

    expect(response.statusCode).toBe(200);
    for (const call of s3Mock.commandCalls(DeleteObjectsCommand)) {
      expect(call.args[0].input.Delete?.Objects?.[0].VersionId).toBe(
        "version-1",
      );
    }
    expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(2);
  });
});
