import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
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
      const now = new Date().toISOString();
      dynamoMock.on(GetCommand).resolves({
        Item: {
          pk: "ACCOUNT#user-1",
          sk: "PROFILE",
          planId: "basic",
          priceMonthlyCents: 0,
          monthlyAllowanceCents: 100,
          storageBytes: 0,
          storageCostCycleStart: now,
          storageCostNano: 0,
          storageCostUpdatedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      dynamoMock.on(TransactWriteCommand).resolves({});

      await updateStorageBytes("user-1", "table", 1024);

      const update =
        dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
          .TransactItems?.[0].Update;
      expect(update?.ExpressionAttributeValues?.[":nextBytes"]).toBe(1024);
      expect(update?.ExpressionAttributeValues?.[":cost"]).toBe(0);
    });

    it("accrues the old storage size before a deletion", async () => {
      const cycleStart = "2024-01-01T00:00:00.000Z";
      const now = Date.UTC(2024, 0, 16);
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      dynamoMock.on(GetCommand).resolves({
        Item: {
          pk: "ACCOUNT#user-1",
          sk: "PROFILE",
          planId: "basic",
          priceMonthlyCents: 0,
          monthlyAllowanceCents: 100,
          storageBytes: 1024 * 1024 * 1024,
          storageCostCycleStart: cycleStart,
          storageCostNano: 0,
          storageCostUpdatedAt: cycleStart,
          createdAt: cycleStart,
          updatedAt: cycleStart,
        },
      });
      dynamoMock.on(TransactWriteCommand).resolves({});

      try {
        await updateStorageBytes("user-1", "table", -(1024 * 1024 * 1024));
      } finally {
        clock.mockRestore();
      }

      const update =
        dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
          .TransactItems?.[0].Update;
      expect(update?.ExpressionAttributeValues?.[":nextBytes"]).toBe(0);
      expect(update?.ExpressionAttributeValues?.[":cost"]).toBe(
        PRICING.storagePerGbMonth / 2,
      );
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
        Math.round(500 * PRICING.embedPerToken),
      );
    });

    it("records an idempotency marker with retried usage", async () => {
      dynamoMock.on(TransactWriteCommand).resolves({});

      await recordUsage("user-1", "table", "ingest", 1, "doc-1:sequence-1");

      const transaction =
        dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
          .TransactItems;
      expect(transaction?.[0].Update?.ExpressionAttributeValues?.[":u"]).toBe(
        1,
      );
      expect(transaction?.[1].Put?.Item?.sk).toBe(
        "USAGEEVENT#doc-1:sequence-1",
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
        Math.round(queryTokens * PRICING.embedPerToken),
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
      dynamoMock
        .on(GetCommand, {
          TableName: "table",
          Key: { pk: "PLAN#basic", sk: "PLAN" },
        })
        .resolves({
          Item: {
            planId: "basic",
            label: "Basic",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 100,
          },
        });
      dynamoMock.on(QueryCommand).resolves({ Items: [] });

      const summary = await getUsageSummary("user-1", "table");

      expect(summary.planId).toBe("basic");
      expect(summary.allowanceUsd).toBe(1);
      expect(summary.paused).toBe(false);
    });

    it("uses the deploy-owned default for an account with an old custom plan", async () => {
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
            planId: "pro",
            priceMonthlyCents: 500,
            monthlyAllowanceCents: 400,
            storageBytes: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        });
      dynamoMock
        .on(GetCommand, {
          TableName: "table",
          Key: { pk: "PLAN#pro", sk: "PLAN" },
        })
        .resolves({
          Item: {
            pk: "PLAN#pro",
            sk: "PLAN",
            planId: "pro",
            label: "Pro",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 999_999_999,
          },
        });
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
      dynamoMock.on(QueryCommand).resolves({ Items: [] });

      const summary = await getUsageSummary("user-1", "table");

      expect(summary.planId).toBe("basic");
      expect(summary.allowanceUsd).toBe(1);
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
      dynamoMock
        .on(GetCommand, {
          TableName: "table",
          Key: { pk: "PLAN#basic", sk: "PLAN" },
        })
        .resolves({
          Item: {
            planId: "basic",
            label: "Basic",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 100,
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
