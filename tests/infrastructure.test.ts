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
});
