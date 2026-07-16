import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
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
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { handler } from "../functions/s3/ingest-adapter";
import { s3Event } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const vectorsMock = mockClient(S3VectorsClient);
const sqsMock = mockClient(SQSClient);

describe("S3 ingest adapter", () => {
  beforeEach(() => {
    dynamoMock.reset();
    s3Mock.reset();
    vectorsMock.reset();
    sqsMock.reset();
  });

  it("queues a valid uploaded object", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "text/plain" },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event());

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("does not queue duplicate work after another trigger wins", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "text/plain" },
    });
    dynamoMock
      .on(UpdateCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "race" }),
      );

    await handler(s3Event());

    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("rolls back to uploaded so an S3 retry can enqueue again", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "text/plain" },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).rejects(new Error("SQS unavailable"));

    await expect(handler(s3Event())).rejects.toThrow("SQS unavailable");

    const rollbackCall = dynamoMock.commandCalls(UpdateCommand).at(-1);
    expect(rollbackCall?.args[0].input).toEqual(
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ":uploaded": "UPLOADED",
        }),
      }),
    );
  });

  it("cleans old derived data after S3 confirms a replacement", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "EMBEDDED",
        mimeType: "text/plain",
        replacementToken: "token-1",
        replacementPreviousStatus: "EMBEDDED",
        pendingFilename: "sample.txt",
        pendingTitle: "Replacement",
        pendingTags: null,
        pendingAuthors: null,
        pendingYear: null,
      },
    });
    dynamoMock.on(QueryCommand).resolves({
      Items: [{ pk: "DOC#doc-1", sk: "CHUNK#1", chunkId: "chunk-1" }],
    });
    dynamoMock.on(BatchWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({
      Metadata: { "upload-token": "token-1" },
    });
    s3Mock.on(ListObjectVersionsCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({});
    vectorsMock.on(DeleteVectorsCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event());

    expect(vectorsMock.commandCalls(DeleteVectorsCommand)).toHaveLength(1);
    expect(dynamoMock.commandCalls(BatchWriteCommand)).toHaveLength(1);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });
});
