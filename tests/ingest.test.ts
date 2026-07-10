import { SQSClient } from "@aws-sdk/client-sqs";
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
});
