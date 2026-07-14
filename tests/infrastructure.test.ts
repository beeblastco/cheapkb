import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("infrastructure hardening", () => {
  const config = fs.readFileSync("sst.config.ts", "utf8");

  it("enables partial SQS failures for every pipeline consumer", () => {
    expect(config.match(/partialResponses: true/g)).toHaveLength(3);
  });

  it("scopes vector permissions to the stage index", () => {
    expect(config).not.toContain('resources: ["*"]');
    expect(config).not.toContain("link:");
    expect(config).toContain("resources: [vectorIndexArn]");
    expect(config).toContain('"s3vectors:GetVectors"');
  });

  it("expires noncurrent object versions", () => {
    expect(config).toContain("BucketLifecycleConfigurationV2");
    expect(config).toContain("noncurrentDays: 7");
  });

  it("grants replacement cleanup only to the ingest adapter", () => {
    expect(config).toContain('"dynamodb:TransactWriteItems"');
    expect(config).toContain('"s3:GetObject"');
    expect(
      config.match(/"dynamodb:BatchWriteItem"/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    // The transactional replacement write must be scoped to a single function's
    // policy, not leaked into any other Lambda's permissions.
    expect(config.match(/"dynamodb:TransactWriteItems"/g)).toHaveLength(1);
  });
});
