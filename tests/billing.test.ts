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
  centsToNanoUsd,
  currentCycle,
  dayKey,
  getOrCreateAccount,
  getUsageSummary,
  NANO_PER_CENT,
  PRICING,
  recordUsage,
  storageCostNanoUsd,
  updateStorageBytes,
  accountId,
} from "../functions/utils";

const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("billing", () => {
  beforeEach(() => {
    dynamoMock.reset();
    process.env.PLANS_TABLE_NAME = "table";
  });

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
      dynamoMock
        .on(GetCommand, {
          TableName: "table",
          Key: { pk: "PLAN#basic", sk: "PLAN" },
        })
        .resolves({
          Item: {
            pk: "PLAN#basic",
            sk: "PLAN",
            planId: "basic",
            label: "Basic",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 100,
          },
        });
      dynamoMock.on(PutCommand).resolves({});

      const account = await getOrCreateAccount("user-1", "table");

      expect(accountId(account.pk)).toBe("user-1");
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

  describe("billing cycle", () => {
    const account = (createdAt: string) => ({
      planId: "basic",
      priceMonthlyCents: 0,
      monthlyAllowanceCents: 100,
      storageBytes: 0,
      createdAt,
      updatedAt: createdAt,
    });

    it("anchors to the creation day-of-month across calendar months", () => {
      const now = Date.UTC(2024, 2, 20);
      const cycle = currentCycle(account("2024-01-15T00:00:00.000Z"), now);

      expect(new Date(cycle.startMs).toISOString()).toBe(
        "2024-03-15T00:00:00.000Z",
      );
      expect(new Date(cycle.endMs).toISOString()).toBe(
        "2024-04-15T00:00:00.000Z",
      );
    });

    it("clamps a day-31 anchor to the last day of shorter months", () => {
      const now = Date.UTC(2024, 1, 10);
      const cycle = currentCycle(account("2024-01-31T00:00:00.000Z"), now);

      expect(new Date(cycle.startMs).toISOString()).toBe(
        "2024-01-31T00:00:00.000Z",
      );
      expect(new Date(cycle.endMs).toISOString()).toBe(
        "2024-02-29T00:00:00.000Z",
      );
    });

    it("returns the first cycle when now is within the creation month", () => {
      const now = Date.UTC(2024, 0, 20);
      const cycle = currentCycle(account("2024-01-15T00:00:00.000Z"), now);

      expect(new Date(cycle.startMs).toISOString()).toBe(
        "2024-01-15T00:00:00.000Z",
      );
      expect(new Date(cycle.endMs).toISOString()).toBe(
        "2024-02-15T00:00:00.000Z",
      );
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

    it("records an embed usage event priced by tokens", async () => {
      dynamoMock.on(UpdateCommand).resolves({});

      await recordUsage("user-1", "table", "embed", 500);

      const update = dynamoMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(update.UpdateExpression).toContain("embedTokens");
      expect(update.ExpressionAttributeValues[":u"]).toBe(500);
      expect(update.ExpressionAttributeValues[":c"]).toBe(
        500 * PRICING.embedPerToken,
      );
    });

    it("records a query plus its embedding token usage", async () => {
      dynamoMock.on(UpdateCommand).resolves({});

      const queryTokens = 12;
      await recordUsage("user-1", "table", "query", 1);
      await recordUsage("user-1", "table", "embed", queryTokens);

      const calls = dynamoMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(2);

      const queryUpdate = calls[0].args[0].input;
      expect(queryUpdate.UpdateExpression).toContain("queryOps");
      expect(queryUpdate.ExpressionAttributeValues[":u"]).toBe(1);
      expect(queryUpdate.ExpressionAttributeValues[":c"]).toBe(
        PRICING.queryPerRequest,
      );

      const embedUpdate = calls[1].args[0].input;
      expect(embedUpdate.UpdateExpression).toContain("embedTokens");
      expect(embedUpdate.ExpressionAttributeValues[":u"]).toBe(queryTokens);
      expect(embedUpdate.ExpressionAttributeValues[":c"]).toBe(
        queryTokens * PRICING.embedPerToken,
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

    it("marks summary as paused when usage exceeds the monthly allowance", async () => {
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
            planId: "basic",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 100,
            storageBytes: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        });
      // Basic allowance is $1 = 1_000_000_000 nano-USD; exceed it by 1 nano.
      dynamoMock.on(QueryCommand).resolves({
        Items: [{ costNano: 1_000_000_001 }],
      });

      const summary = await getUsageSummary("user-1", "table");

      expect(summary.paused).toBe(true);
      expect(summary.pctUsed).toBeGreaterThanOrEqual(100);
    });
  });
});
