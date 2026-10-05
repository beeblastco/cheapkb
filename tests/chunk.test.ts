import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  BatchWriteCommand,
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
import { sqsEvent } from "./helpers/events";

const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);
const vectorsMock = mockClient(S3VectorsClient);

function sentMessages(): Array<Record<string, unknown>> {
  return sqsMock
    .commandCalls(SendMessageBatchCommand)
    .flatMap((call) => call.args[0].input.Entries ?? [])
    .map((entry) => JSON.parse(String(entry.MessageBody)));
}

describe("chunk records", () => {
  beforeEach(() => {
    s3Mock.reset();
    sqsMock.reset();
    sqsMock.resolves({});
    dynamoMock.reset();
    vectorsMock.reset();
  });

  it("stores API-visible chunk metadata and queues the chunk text inline", async () => {
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

    const result = await handler(
      sqsEvent(
        "chunk-1",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
        }),
      ),
    );

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
    expect(item).not.toHaveProperty("s3ChunkKey");
    // The parsed file is the source of truth, so no chunk object is written.
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(sentMessages()).toEqual([
      {
        stage: "embed",
        documentId: "doc-1",
        chunkId: "chunk_doc-1_0",
        createdAt: item?.createdAt,
        modality: "text",
        text: "Hello world",
        tokenCount: item?.tokenCount,
        pageStart: 1,
        pageEnd: 1,
      },
    ]);
  });

  it("writes every chunk of a long document across write groups", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { userId: "owner", title: "Title" },
    });
    dynamoMock.on(PutCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    const text = Array.from({ length: 12_000 }, (_, i) => `word${i}`).join(" ");
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () =>
          JSON.stringify({ pages: [{ pageNumber: 1, text: text }] }),
      } as any,
    });

    const result = await handler(
      sqsEvent(
        "chunk-long",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    const written = dynamoMock.commandCalls(PutCommand).length;
    expect(written).toBeGreaterThan(10);
    expect(sentMessages()).toHaveLength(written);
  });

  it("does not emit the overlap tail again as its own chunk", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { userId: "owner", title: "Title" },
    });
    dynamoMock.on(PutCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    // 1,300 tokens at 700 max and 100 overlap is two windows: 0-699 and 600-1299.
    const text = Array.from({ length: 1300 }, () => "hello").join(" ");
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () =>
          JSON.stringify({ pages: [{ pageNumber: 1, text: text }] }),
      } as any,
    });

    await handler(
      sqsEvent(
        "chunk-tail",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
        }),
      ),
    );

    const items = dynamoMock
      .commandCalls(PutCommand)
      .map((call) => call.args[0].input.Item);
    expect(items.map((item) => item?.tokenCount)).toEqual([700, 700]);
  });

  it("lets chunks span pages and records their page range", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { userId: "owner", title: "Title" },
    });
    dynamoMock.on(PutCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    const text = Array.from({ length: 100 }, () => "hello").join(" ");
    const pages = Array.from({ length: 10 }, (_, i) => ({
      pageNumber: i + 1,
      text: text,
    }));
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () => JSON.stringify({ pages: pages }),
      } as any,
    });

    await handler(
      sqsEvent(
        "chunk-pages",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
        }),
      ),
    );

    const ranges = dynamoMock
      .commandCalls(PutCommand)
      .map((call) => call.args[0].input.Item)
      .sort((a, b) => a?.pageStart - b?.pageStart)
      .map((item) => [item?.pageStart, item?.pageEnd]);
    // About 1,000 tokens: the second window starts in page 6 with the overlap.
    expect(ranges).toEqual([
      [1, 7],
      [6, 10],
    ]);
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

    const result = await handler(
      sqsEvent(
        "chunk-special",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(sentMessages()[0].text).toBe("Before <|endoftext|> after");
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

    const result = await handler(
      sqsEvent(
        "chunk-image",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/image.json",
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    // The embed step reads the source key and MIME type from the META row.
    expect(sentMessages()).toEqual([
      {
        stage: "embed",
        documentId: "doc-1",
        chunkId: "image_doc-1_0",
        createdAt: expect.any(String),
        modality: "image",
        pageStart: 1,
        pageEnd: 1,
      },
    ]);
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

    const result = await handler(
      sqsEvent(
        "chunk-again",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
        }),
        2,
      ),
    );

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

  it("keeps embedded chunks when a duplicate delivery reports a first receive", async () => {
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

    await handler(
      sqsEvent(
        "chunk-duplicate",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
        }),
      ),
    );

    // Overwriting a counted EMBEDDED row would make embeddedCount count it twice.
    expect(
      dynamoMock.commandCalls(PutCommand)[0].args[0].input.ConditionExpression,
    ).toBe("attribute_not_exists(pk) OR #s <> :embedded");
  });

  it("redoes chunks embedded before the reindex the document records", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        userId: "owner",
        title: "Title",
        reindexedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    dynamoMock.on(PutCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () =>
          JSON.stringify({ pages: [{ pageNumber: 1, text: "Hello world" }] }),
      } as any,
    });

    // A reindex that restarts from parsing sends a chunk message without reindexedAt.
    await handler(
      sqsEvent(
        "chunk-after-reparse",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
        }),
      ),
    );

    const put = dynamoMock.commandCalls(PutCommand)[0].args[0].input;
    expect(put.ConditionExpression).toContain("createdAt < :reindexedAt");
    expect(put.ExpressionAttributeValues?.[":reindexedAt"]).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("redoes chunks embedded before the reindex that a redelivery restarts", async () => {
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

    await handler(
      sqsEvent(
        "chunk-reindex-again",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
          reindexedAt: "2026-01-01T00:00:00.000Z",
        }),
        2,
      ),
    );

    const put = dynamoMock.commandCalls(PutCommand)[0].args[0].input;
    // Only chunks embedded since the reindex are kept; older ones are embedded again.
    expect(put.ConditionExpression).toContain("createdAt < :reindexedAt");
    expect(put.ExpressionAttributeValues?.[":reindexedAt"]).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("removes the rows and vectors of chunks a shorter re-chunk no longer has", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { userId: "owner", title: "Title", chunkCount: 3 },
    });
    dynamoMock.on(PutCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(BatchWriteCommand).resolves({});
    vectorsMock.on(DeleteVectorsCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () =>
          JSON.stringify({ pages: [{ pageNumber: 1, text: "Hello world" }] }),
      } as any,
    });

    const result = await handler(
      sqsEvent(
        "chunk-shrink",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(
      vectorsMock.commandCalls(DeleteVectorsCommand)[0].args[0].input.keys,
    ).toEqual(["chunk_doc-1_1", "chunk_doc-1_2"]);
    const [deletes] = Object.values(
      dynamoMock.commandCalls(BatchWriteCommand)[0].args[0].input
        .RequestItems ?? {},
    );
    expect(deletes?.map((request) => request.DeleteRequest?.Key?.sk)).toEqual([
      "CHUNK#chunk_doc-1_1",
      "CHUNK#chunk_doc-1_2",
    ]);
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

    await handler(
      sqsEvent(
        "chunk-swept",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
          sweeps: 1,
        }),
      ),
    );

    expect(
      dynamoMock.commandCalls(PutCommand)[0].args[0].input.ConditionExpression,
    ).toContain(":embedded");
  });

  it("fails only the record whose error could not be recorded", async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error("parsed pages missing"));
    dynamoMock.on(GetCommand).resolves({ Item: { retryCount: 0 } });
    dynamoMock.on(UpdateCommand).rejects(new Error("dynamo unavailable"));

    const result = await handler(
      sqsEvent(
        "chunk-failed",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "chunk-failed" },
    ]);
  });

  it("drops the message when the document was deleted", async () => {
    dynamoMock
      .on(UpdateCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "gone" }),
      );

    const result = await handler(
      sqsEvent(
        "chunk-deleted",
        JSON.stringify({
          documentId: "doc-1",
          parsedKey: "parsed/doc-1/v1/pages.json",
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sqsMock.calls()).toHaveLength(0);
  });
});
