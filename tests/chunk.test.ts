import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sst", () => ({
  Resource: {
    Meta: { name: "table" },
    Storage: { name: "storage" },
    Embed: { url: "embed-queue" },
  },
}));

import { handler } from "../functions/chunk/index";

const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("chunk records", () => {
  beforeEach(() => {
    s3Mock.reset();
    sqsMock.reset();
    sqsMock.resolves({});
    dynamoMock.reset();
  });

  it("stores ownership and API-visible chunk metadata", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { userId: "owner", title: "Title" },
    });
    dynamoMock.on(PutCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () =>
          JSON.stringify({ pages: [{ pageNumber: 1, text: "Hello world" }] }),
      } as any,
    });

    const result = await handler({
      Records: [
        {
          messageId: "chunk-1",
          body: JSON.stringify({
            documentId: "doc-1",
            parsedKey: "parsed/doc-1/v1/pages.json",
          }),
          attributes: { ApproximateReceiveCount: "1" },
        },
      ],
    } as any);

    expect(result.batchItemFailures).toEqual([]);
    const item = dynamoMock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item).toEqual(
      expect.objectContaining({
        pageStart: 1,
        pageEnd: 1,
        tokenCount: expect.any(Number),
        status: "QUEUED",
      }),
    );
    const chunkBody = JSON.parse(
      String(
        s3Mock.calls().find((call) => "Body" in call.args[0].input)?.args[0]
          .input.Body,
      ),
    );
    expect(chunkBody.userId).toBe("owner");
  });
});
