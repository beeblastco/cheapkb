import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("infrastructure hardening", () => {
  const config = fs.readFileSync("sst.config.ts", "utf8");

  it("enables partial SQS failures for the pipeline consumer", () => {
    expect(config.match(/partialResponses: true/g)).toHaveLength(1);
    expect(config).toContain('window: "1 second"');
    expect(config).toContain("size: 10");
  });

  // Every extra Lambda event source idle-polls ~260k SQS requests/month, so the
  // three stages must stay on one queue to fit the 1M free tier.
  it("keeps all pipeline stages on a single queue", () => {
    expect(config.match(/\.subscribe\(/g)).toHaveLength(1);
    expect(config).toContain("PIPELINE_QUEUE_URL: pipelineQueue.url");
    expect(config).not.toContain("INGEST_QUEUE_URL");
    expect(config).not.toContain("CHUNK_QUEUE_URL");
    expect(config).not.toContain("EMBED_QUEUE_URL");
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

  it("limits cross-account Bedrock access to the configured assume role", () => {
    expect(config).toContain("process.env.BEDROCK_ASSUME_ROLE_ARN");
    expect(config).toContain('actions: ["sts:AssumeRole"]');
    expect(config).toContain("resources: [bedrockAssumeRoleArn]");
    expect(config.match(/embeddingInvocationPermission/g)?.length).toBe(3);
    expect(config).not.toContain("BEDROCK_REGION");
  });

  it("keeps plans deployment-owned", () => {
    expect(config).toContain(
      "new pulumiAws.dynamodb.TableItem(`Plan-${DEFAULT_PLAN.planId}`",
    );
    expect(config).not.toContain('api.route("GET /plans"');
    expect(config).not.toContain('api.route("POST /plans"');
    expect(config).not.toContain('api.route("PATCH /account/plan"');
  });

  it("expires noncurrent object versions", () => {
    expect(config).toContain("BucketLifecycleConfigurationV2");
    expect(config).toContain("noncurrentDays: 7");
  });

  it("grants transactions to upload and storage-accounting handlers", () => {
    expect(config).toContain('"dynamodb:TransactWriteItems"');
    expect(config).toContain('"s3:GetObject"');
    expect(
      config.match(/"dynamodb:BatchWriteItem"/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(config).toContain('new sst.aws.Function("Upload"');
    expect(config.match(/"dynamodb:TransactWriteItems"/g)).toHaveLength(5);
  });

  it("keeps Bedrock invocation logs in S3 without a trigger Lambda", () => {
    expect(config).toContain("if (STAGE === PROD_STAGE)");
    expect(config).not.toContain("BEDROCK_LOGGING_OWNER_STAGE");
    expect(config).toContain("InvocationLoggingConfiguration");
    expect(config).toContain("s3Config:");
    expect(config).toContain("embeddingDataDeliveryEnabled: true");
    expect(config).toContain("imageDataDeliveryEnabled: true");
    expect(config).toContain("textDataDeliveryEnabled: true");
    expect(config).toContain("expiration: { days: 7 }");
    expect(config).not.toContain('new sst.aws.Function("BedrockUsage"');
    expect(config).not.toContain('name: "bedrock-usage"');
    expect(config).not.toContain("cloudwatchConfig:");
    expect(config).not.toContain("LogSubscriptionFilter");
    expect(config).not.toContain("BedrockInvocationLogGroup");
  });
});
