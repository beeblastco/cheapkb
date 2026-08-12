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
  TransactWriteCommand,
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

  it("queues a valid image upload", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "image/png", userId: "user-1" },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event("raw/doc-1/photo.png", 1024));

    const message = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    expect(JSON.parse(String(message.MessageBody))).toEqual(
      expect.objectContaining({
        stage: "parse",
        mimeType: "image/png",
      }),
    );
  });

  it("rejects images over the configured five MB limit", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "image/png", userId: "user-1" },
    });
    dynamoMock.on(UpdateCommand).resolves({});

    await handler(s3Event("raw/doc-1/photo.png", 5242881));

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(
      dynamoMock.commandCalls(UpdateCommand).at(-1)?.args[0].input,
    ).toEqual(
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ":s": "FAILED",
        }),
      }),
    );
  });

  it("charges only the source size delta on re-ingest", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk === "ACCOUNT#user-1" && input.Key?.sk === "PROFILE") {
        return {
          Item: {
            pk: "ACCOUNT#user-1",
            sk: "PROFILE",
            planId: "basic",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 100,
            storageBytes: 30,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "UPLOADED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 30,
        },
      };
    });
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event("raw/doc-1/sample.txt", 100));

    const storageUpdate = dynamoMock
      .commandCalls(TransactWriteCommand)
      .map((call) => call.args[0].input.TransactItems?.[0].Update)
      .find((update) => update?.ExpressionAttributeValues?.[":nextBytes"]);
    expect(storageUpdate?.ExpressionAttributeValues?.[":nextBytes"]).toBe(100);
  });

  it("rolls back to uploaded when usage accounting fails", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "UPLOADED",
        mimeType: "text/plain",
        userId: "user-1",
      },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock
      .on(TransactWriteCommand)
      .rejectsOnce(new Error("accounting unavailable"));

    await expect(handler(s3Event())).rejects.toThrow("accounting unavailable");

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    const rollbackCall = dynamoMock.commandCalls(UpdateCommand).at(-1);
    expect(rollbackCall?.args[0].input.ExpressionAttributeValues).toEqual(
      expect.objectContaining({ ":uploaded": "UPLOADED" }),
    );
  });

  it("resumes a queued upload after a rollback failure", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk === "ACCOUNT#user-1" && input.Key?.sk === "PROFILE") {
        return {
          Item: {
            pk: "ACCOUNT#user-1",
            sk: "PROFILE",
            planId: "basic",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 100,
            storageBytes: 20,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "QUEUED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 20,
        },
      };
    });
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event());

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("does not overlap an active queued dispatch", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "QUEUED",
        mimeType: "text/plain",
        userId: "user-1",
        dispatchState: "CLAIMED",
        dispatchLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    await expect(handler(s3Event())).rejects.toThrow(
      "Document dispatch is already in progress",
    );

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("reclaims an expired queued dispatch", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk === "ACCOUNT#user-1" && input.Key?.sk === "PROFILE") {
        return {
          Item: {
            pk: "ACCOUNT#user-1",
            sk: "PROFILE",
            storageBytes: 20,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "QUEUED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 20,
          dispatchState: "CLAIMED",
          dispatchLeaseUntil: new Date(Date.now() - 1).toISOString(),
        },
      };
    });
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event());

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("does not resend a completed queued dispatch", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "QUEUED",
        mimeType: "text/plain",
        userId: "user-1",
        dispatchState: "SENT",
      },
    });

    await handler(s3Event());

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
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
