import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  getOrCreateAccount,
  updateStorageBytes,
} from "../functions/billing/account";
import {
  centsToNanoUsd,
  NANO_PER_CENT,
  PRICING,
  storageCostNanoUsd,
} from "../functions/billing/pricing";
import {
  dayKey,
  getUsageSummary,
  recordUsage,
} from "../functions/billing/usage";

const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("billing", () => {
  beforeEach(() => dynamoMock.reset());

  describe("pricing", () => {
    it("converts cents to nano-usd", () => {
      expect(centsToNanoUsd(400)).toBe(400 * NANO_PER_CENT);
    });

    it("calculates storage cost for one GB over a month", () => {
      const bytes = 1024 * 1024 * 1024;
      const seconds = 30 * 24 * 60 * 60;
      expect(storageCostNanoUsd(bytes, seconds)).toBe(
        PRICING.storagePerGbMonth,
      );
    });
  });

  describe("account", () => {
    it("creates a default account when none exists", async () => {
      dynamoMock.on(GetCommand).resolves({});
      dynamoMock.on(PutCommand).resolves({});

      const account = await getOrCreateAccount("user-1", "table");

      expect(account.userId).toBe("user-1");
      expect(account.planId).toBe("basic");
      expect(account.monthlyAllowanceCents).toBe(100);
    });

    it("updates storage bytes", async () => {
      dynamoMock.on(UpdateCommand).resolves({});

      await updateStorageBytes("user-1", "table", 1024);

      const call = dynamoMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(call.ExpressionAttributeValues[":delta"]).toBe(1024);
    });
  });

  describe("usage", () => {
    it("records a query usage event", async () => {
      dynamoMock.on(UpdateCommand).resolves({});

      await recordUsage("user-1", "table", "query", 2);

      const update = dynamoMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(update.UpdateExpression).toContain("queryOps");
      expect(update.ExpressionAttributeValues[":u"]).toBe(2);
      expect(update.ExpressionAttributeValues[":c"]).toBe(
        2 * PRICING.queryPerRequest,
      );
    });

    it("returns usage summary with default plan", async () => {
      const now = new Date();
      dynamoMock
        .on(GetCommand, {
          TableName: "table",
          Key: { pk: "ACCOUNT#user-1", sk: "PROFILE" },
        })
        .resolves({
          Item: {
            pk: "ACCOUNT#user-1",
            sk: "PROFILE",
            userId: "user-1",
            planId: "basic",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 100,
            storageBytes: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        });
      dynamoMock.on(QueryCommand).resolves({ Items: [] });

      const summary = await getUsageSummary("user-1", "table");

      expect(summary.planId).toBe("basic");
      expect(summary.allowanceUsd).toBe(1);
      expect(summary.paused).toBe(false);
    });

    it("marks summary as paused when usage exceeds allowance", async () => {
      const now = new Date();
      dynamoMock
        .on(GetCommand, {
          TableName: "table",
          Key: { pk: "ACCOUNT#user-1", sk: "PROFILE" },
        })
        .resolves({
          Item: {
            pk: "ACCOUNT#user-1",
            sk: "PROFILE",
            userId: "user-1",
            planId: "basic",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 100,
            storageBytes: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        });
      dynamoMock.on(QueryCommand).resolves({
        Items: [{ costNano: 400 * 10_000_000 + 1 }],
      });

      const summary = await getUsageSummary("user-1", "table");

      expect(summary.paused).toBe(true);
      expect(summary.pctUsed).toBeGreaterThanOrEqual(100);
    });
  });
});
