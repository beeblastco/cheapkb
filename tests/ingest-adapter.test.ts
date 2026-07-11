import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { handler } from "../functions/s3/ingest-adapter";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

describe("S3 ingest adapter", () => {
  beforeEach(() => {
    dynamoMock.reset();
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
});

function s3Event() {
  return {
    Records: [
      {
        s3: {
          object: {
            key: "raw/doc-1/sample.txt",
            size: 20,
          },
        },
      },
    ],
  };
}
