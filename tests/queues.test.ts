import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
    Chunk: { url: "chunk-queue" },
    Embed: { url: "embed-queue" },
  },
}));

import { handler as embed } from "../functions/embed/index";
import { handler as parse } from "../functions/parse/index";

const s3Mock = mockClient(S3Client);
const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("SQS partial failures", () => {
  beforeEach(() => {
    s3Mock.reset();
    dynamoMock.reset();
  });

  it("returns malformed parse records to SQS", async () => {
    const result = await parse(sqsEvent("parse-1", "not-json", "1"));
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "parse-1" }]);
  });

  it("returns failed embedding records to SQS and records the attempt", async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error("temporary S3 failure"));
    dynamoMock.on(GetCommand).resolves({ Item: { retryCount: 0 } });
    dynamoMock.on(UpdateCommand).resolves({});

    const result = await embed(
      sqsEvent(
        "embed-1",
        JSON.stringify({
          documentId: "doc-1",
          s3ChunkKey: "chunks/doc-1/chunk.json",
        }),
        "2",
      ),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "embed-1" }]);
    expect(dynamoMock.commandCalls(UpdateCommand)[0].args[0].input).toEqual(
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({ ":r": 2 }),
      }),
    );
  });
});

function sqsEvent(messageId: string, body: string, attempt: string): any {
  return {
    Records: [
      {
        messageId,
        receiptHandle: "receipt",
        body,
        attributes: {
          ApproximateReceiveCount: attempt,
          SentTimestamp: "0",
          SenderId: "sender",
          ApproximateFirstReceiveTimestamp: "0",
        },
        messageAttributes: {},
        md5OfBody: "hash",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:queue",
        awsRegion: "us-east-1",
      },
    ],
  };
}
