import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
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

  it("chunks text that contains tokenizer special tokens", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { userId: "owner", title: "Title" },
    });
    dynamoMock.on(PutCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () =>
          JSON.stringify({
            pages: [{ pageNumber: 1, text: "Before <|endoftext|> after" }],
          }),
      } as any,
    });

    const result = await handler({
      Records: [
        {
          messageId: "chunk-special",
          body: JSON.stringify({
            documentId: "doc-1",
            parsedKey: "parsed/doc-1/v1/pages.json",
          }),
          attributes: { ApproximateReceiveCount: "1" },
        },
      ],
    } as any);

    expect(result.batchItemFailures).toEqual([]);
    const chunkBody = JSON.parse(
      String(
        s3Mock.calls().find((call) => "Body" in call.args[0].input)?.args[0]
          .input.Body,
      ),
    );
    expect(chunkBody.text).toBe("Before <|endoftext|> after");
  });

  it("creates one image chunk without text tokenization", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        userId: "owner",
        title: "Product photo",
        sourceKey: "raw/doc-1/photo.png",
        mimeType: "image/png",
      },
    });
    dynamoMock.on(PutCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () =>
          JSON.stringify({
            modality: "image",
            sourceKey: "raw/doc-1/photo.png",
            mimeType: "image/png",
          }),
      } as any,
    });

    const result = await handler({
      Records: [
        {
          messageId: "chunk-image",
          body: JSON.stringify({
            documentId: "doc-1",
            parsedKey: "parsed/doc-1/v1/image.json",
          }),
          attributes: { ApproximateReceiveCount: "1" },
        },
      ],
    } as any);

    expect(result.batchItemFailures).toEqual([]);
    const chunkBody = JSON.parse(
      String(
        s3Mock.calls().find((call) => "Body" in call.args[0].input)?.args[0]
          .input.Body,
      ),
    );
    expect(chunkBody).toEqual(
      expect.objectContaining({
        modality: "image",
        mimeType: "image/png",
        sourceKey: "raw/doc-1/photo.png",
      }),
    );
    expect(chunkBody).not.toHaveProperty("tokenCount");
  });

  it("keeps embedded chunks when a message is redelivered", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { userId: "owner", title: "Title" },
    });
    dynamoMock
      .on(PutCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "done" }),
      );
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
          messageId: "chunk-again",
          body: JSON.stringify({
            documentId: "doc-1",
            parsedKey: "parsed/doc-1/v1/pages.json",
          }),
          attributes: { ApproximateReceiveCount: "2" },
        },
      ],
    } as any);

    expect(result.batchItemFailures).toEqual([]);
    expect(
      dynamoMock.commandCalls(PutCommand)[0].args[0].input.ConditionExpression,
    ).toContain(":embedded");
    expect(sqsMock.calls()).toHaveLength(0);
    const finish = dynamoMock
      .commandCalls(UpdateCommand)
      .find((call) => call.args[0].input.ExpressionAttributeValues?.[":c"]);
    expect(finish?.args[0].input.ExpressionAttributeValues?.[":c"]).toBe(1);
    // No embed step will run, so the document is finished here.
    expect(
      dynamoMock.commandCalls(UpdateCommand).at(-1)?.args[0].input
        .ExpressionAttributeValues,
    ).toEqual(expect.objectContaining({ ":s": "EMBEDDED", ":count": 1 }));
  });

  it("treats a message the sweeper re-queued as a redelivery", async () => {
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

    await handler({
      Records: [
        {
          messageId: "chunk-swept",
          body: JSON.stringify({
            documentId: "doc-1",
            parsedKey: "parsed/doc-1/v1/pages.json",
            sweeps: 1,
          }),
          attributes: { ApproximateReceiveCount: "1" },
        },
      ],
    } as any);

    expect(
      dynamoMock.commandCalls(PutCommand)[0].args[0].input.ConditionExpression,
    ).toContain(":embedded");
  });

  it("drops the message when the document was deleted", async () => {
    dynamoMock
      .on(UpdateCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "gone" }),
      );

    const result = await handler({
      Records: [
        {
          messageId: "chunk-deleted",
          body: JSON.stringify({
            documentId: "doc-1",
            parsedKey: "parsed/doc-1/v1/pages.json",
          }),
          attributes: { ApproximateReceiveCount: "1" },
        },
      ],
    } as any);

    expect(result.batchItemFailures).toEqual([]);
    expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sqsMock.calls()).toHaveLength(0);
  });
});
