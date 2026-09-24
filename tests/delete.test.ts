import {
  DeleteObjectsCommand,
  HeadObjectCommand,
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
  UpdateCommand,
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

  it("keeps a failed delete DELETING so the pipeline still cannot write to it", async () => {
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
    const updates = dynamoMock
      .commandCalls(UpdateCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues);
    expect(updates.map((values) => values?.[":s"])).toEqual([
      "DELETING",
      "DELETING",
    ]);
    expect(updates[1]?.[":e"]).toBe("Delete did not finish, try again");
  });

  it("deletes every S3 object version before metadata", async () => {
    dynamoMock.on(QueryCommand).resolves({ Items: [] });
    dynamoMock.on(BatchWriteCommand).resolves({});
    dynamoMock.on(DeleteCommand).resolves({});
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [{ Key: "raw/doc-1/file.pdf", VersionId: "version-1" }],
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 10 });

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

  it("stops before deleting when the source size cannot be read", async () => {
    s3Mock
      .on(HeadObjectCommand)
      .rejects(Object.assign(new Error("denied"), { name: "AccessDenied" }));

    const response = await handler(
      apiEvent({ pathParameters: { id: "doc-1" } }),
    );

    expect(response.statusCode).toBe(500);
    expect(vectorsMock.commandCalls(DeleteVectorsCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(ListObjectVersionsCommand)).toHaveLength(0);
    expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });
});
