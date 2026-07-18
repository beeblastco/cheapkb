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

  it("exposes metadata updates through a PATCH route the browser can reach", () => {
    expect(config).toContain('api.route("PATCH /documents/{id}"');
    // Without PATCH in the CORS allowlist the browser preflight fails and the
    // route is unreachable from the web app even though it deployed fine.
    expect(config).toContain(
      'allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]',
    );
  });

  it("grants vector writes only to the embed and update functions", () => {
    expect(config.match(/"s3vectors:PutVectors"/g)).toHaveLength(2);
  });

  it("scopes the update function's storage access to chunk objects", () => {
    // Other functions are legitimately scoped to chunks/*, so a bare substring
    // check would still pass if AdminUpdate regressed to the whole bucket.
    const block = config.slice(
      config.indexOf('new sst.aws.Function("AdminUpdate"') + 1,
    );
    const adminUpdateFn = block.slice(
      0,
      block.indexOf("new sst.aws.Function("),
    );
    expect(adminUpdateFn).toContain("${storage.arn}/chunks/*");
    expect(adminUpdateFn).not.toContain("${storage.arn}/*");
  });

  it("refuses to provision into the wrong AWS account", () => {
    // Resource names embed the account, so a wrong caller would silently build a
    // parallel stack elsewhere rather than fail.
    expect(config).toContain("process.env.AWS_ACCOUNT_ID");
    expect(config).toContain("Refusing to deploy as account");
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
