import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.TABLE_NAME = "meta";
  process.env.ACCOUNTS_TABLE_NAME = "accounts";
  process.env.TAGS_TABLE_NAME = "tags";
  process.env.RATE_LIMITS_TABLE_NAME = "rate-limits";
  process.env.STORAGE_BUCKET_NAME = "storage";
});
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: { pairwise_sub: "owner" },
  }),
}));

import { handler } from "../functions/admin/reset";
import { apiEvent } from "./helpers/events";

const s3Mock = mockClient(S3Client);
const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("DELETE /account/data", () => {
  beforeEach(() => {
    s3Mock.reset();
    dynamoMock.reset();
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === "rate-limits") return {};
      return {
        Item: {
          pk: "ACCOUNT#owner",
          sk: "PROFILE",
          storageBytes: 400,
          storageCostCycleStart: now,
          storageCostNano: 0,
          storageCostUpdatedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      };
    });
    dynamoMock.on(PutCommand).resolves({});
    // Marking returns the consistent row, which is where counted bytes come from.
    dynamoMock.on(UpdateCommand).callsFake((input) => ({
      Attributes: { countedBytes: input.Key.pk === "DOC#a" ? 100 : 50 },
    }));
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(BatchWriteCommand).resolves({});
    dynamoMock.on(QueryCommand, { IndexName: "GSI2" }).resolves({
      Items: [
        {
          pk: "DOC#a",
          sk: "META",
          countedBytes: 100,
          sourceKey: "raw/a/a.pdf",
        },
        { pk: "DOC#b", sk: "META", countedBytes: 50, sourceKey: "raw/b/b.md" },
      ],
    });
    dynamoMock
      .on(QueryCommand, { TableName: "tags" })
      .resolves({ Items: [{ pk: "USER#owner", sk: "TAG#research" }] });
    s3Mock.on(DeleteObjectCommand).resolves({});
  });

  it("skips the drift correction when storage changed after it was read", async () => {
    let reads = 0;
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === "rate-limits") return {};
      reads += 1;
      return {
        Item: {
          pk: "ACCOUNT#owner",
          sk: "PROFILE",
          storageBytes: reads === 1 ? 400 : 900,
          storageCostUpdatedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      };
    });

    await handler(apiEvent());

    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(2);
  });

  it("removes drift, then deletes every source and tag", async () => {
    const response = await handler(apiEvent());

    expect(response.statusCode).toBe(202);
    // 400 stored, 150 counted on documents: the 250 of drift goes first, and
    // the cleanup adapter subtracts the remaining 150 per document.
    const storage =
      dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
        .TransactItems?.[0].Update;
    expect(storage?.ExpressionAttributeValues?.[":nextBytes"]).toBe(150);
    expect(
      s3Mock.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input.Key),
    ).toEqual(["raw/a/a.pdf", "raw/b/b.md"]);
    expect(
      dynamoMock
        .commandCalls(UpdateCommand)
        .map((c) => c.args[0].input.ExpressionAttributeValues?.[":s"]),
    ).toEqual(["DELETING", "DELETING"]);
    expect(dynamoMock.commandCalls(BatchWriteCommand)).toHaveLength(1);
  });

  it("backs off before resending throttled tag deletes", async () => {
    const unprocessed = {
      tags: [
        { DeleteRequest: { Key: { pk: "USER#owner", sk: "TAG#research" } } },
      ],
    };
    dynamoMock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: unprocessed })
      .resolvesOnce({ UnprocessedItems: unprocessed })
      .resolves({});
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const response = await handler(apiEvent());

    expect(response.statusCode).toBe(202);
    expect(dynamoMock.commandCalls(BatchWriteCommand)).toHaveLength(3);
    expect(setTimeoutSpy.mock.calls.map(([, ms]) => ms)).toEqual(
      expect.arrayContaining([100, 200]),
    );
    setTimeoutSpy.mockRestore();
  });

  it("does not touch storage when it matches the documents", async () => {
    dynamoMock
      .on(UpdateCommand)
      .resolves({ Attributes: { countedBytes: 400 } });
    dynamoMock.on(QueryCommand, { IndexName: "GSI2" }).resolves({
      Items: [
        {
          pk: "DOC#a",
          sk: "META",
          countedBytes: 400,
          sourceKey: "raw/a/a.pdf",
        },
      ],
    });

    await handler(apiEvent());

    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
