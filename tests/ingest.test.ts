import { SQSClient } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sst", () => ({
  Resource: { Meta: { name: "table" } },
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

describe("ingest status", () => {
  beforeEach(() => {
    dynamoMock.reset();
    sqsMock.reset();
  });

  it("hides another user's document", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { documentId: "doc-1", userId: "user-b", status: "UPLOADED" },
    });

    const response = await handler(jsonApiEvent({ documentId: "doc-1" }));

    expect(response.statusCode).toBe(404);
  });

  it("reports status without queueing, so only the S3 adapter charges and queues", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { documentId: "doc-1", userId: "user-a", status: "UPLOADED" },
    });

    const response = await handler(jsonApiEvent({ documentId: "doc-1" }));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      documentId: "doc-1",
      status: "UPLOADED",
    });
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sqsMock.calls()).toHaveLength(0);
  });
});
