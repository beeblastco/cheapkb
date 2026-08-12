import { ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { handler } from "../functions/s3/cleanup-adapter";
import { s3Event } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const vectorsMock = mockClient(S3VectorsClient);

describe("S3 cleanup adapter", () => {
  beforeEach(() => {
    dynamoMock.reset();
    s3Mock.reset();
    vectorsMock.reset();
  });

  it("subtracts source storage once for a direct S3 deletion", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk === "ACCOUNT#owner" && input.Key?.sk === "PROFILE") {
        return {
          Item: {
            pk: "ACCOUNT#owner",
            sk: "PROFILE",
            planId: "basic",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 100,
            storageBytes: 100,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#owner") return {};
      return {
        Item: {
          countedBytes: 100,
          dedupeKey: "dedupe-1",
          pk: "DOC#doc-1",
          sk: "META",
          status: "EMBEDDED",
          userId: "owner",
        },
      };
    });
    dynamoMock.on(QueryCommand).resolves({ Items: [] });
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(DeleteCommand).resolves({});
    s3Mock.on(ListObjectVersionsCommand).resolves({});

    await handler(s3Event("raw/doc-1/file.pdf", 0));

    const transaction =
      dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
        .TransactItems;
    expect(
      transaction?.[0].Update?.ExpressionAttributeValues?.[":nextBytes"],
    ).toBe(0);
    expect(transaction?.[1].Put?.Item?.sk).toBe("STORAGE#delete:doc-1");
  });
});
