import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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
import { sqsEvent } from "./helpers/events";

const s3Mock = mockClient(S3Client);
const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("SQS partial failures", () => {
  beforeEach(() => {
    s3Mock.reset();
    dynamoMock.reset();
  });

  it("returns malformed parse records to SQS", async () => {
    const result = await parse(sqsEvent("parse-1", "not-json"));
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "parse-1" }]);
  });

  it("fails a document with no text on the first attempt", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToByteArray: async () => new TextEncoder().encode("   "),
      } as any,
    });
    dynamoMock.on(UpdateCommand).resolves({});

    const result = await parse(
      sqsEvent(
        "parse-empty",
        JSON.stringify({
          documentId: "doc-1",
          sourceKey: "raw/doc-1/empty.txt",
          mimeType: "text/plain",
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(
      dynamoMock.commandCalls(UpdateCommand).at(-1)?.args[0].input
        .ExpressionAttributeValues,
    ).toEqual(expect.objectContaining({ ":s": "FAILED", ":f": "PARSING" }));
  });

  it("fails text too long to fit the chunk cap before it is tokenized", async () => {
    // 1,000 chunks x 700 tokens x 16 characters per token, plus one.
    const text = "a".repeat(1000 * 700 * 16 + 1);
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToByteArray: async () => new TextEncoder().encode(text),
      } as any,
    });
    dynamoMock.on(UpdateCommand).resolves({});

    const result = await parse(
      sqsEvent(
        "parse-huge",
        JSON.stringify({
          documentId: "doc-1",
          sourceKey: "raw/doc-1/huge.txt",
          mimeType: "text/plain",
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(
      dynamoMock.commandCalls(UpdateCommand).at(-1)?.args[0].input
        .ExpressionAttributeValues,
    ).toEqual(
      expect.objectContaining({
        ":e": "Document exceeds the 1000 chunk limit",
        ":s": "FAILED",
      }),
    );
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
        2,
      ),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "embed-1" }]);
    expect(dynamoMock.commandCalls(UpdateCommand)[0].args[0].input).toEqual(
      expect.objectContaining({
        // The raw S3 error stays in the logs, not on the document.
        ExpressionAttributeValues: expect.objectContaining({
          ":r": 2,
          ":e": "Embedding failed. Reindex to try again.",
        }),
      }),
    );
  });
});
