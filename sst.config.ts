/// <reference path="./.sst/platform/config.d.ts" />

const PROJECT = "cheapkb";
const PROD_STAGE = "production";
const EXPECTED_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;

export default $config({
  app(input) {
    return {
      name: PROJECT,
      providers: {
        aws: {
          // Use profile locally; CI uses AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars
          ...(!process.env.AWS_ACCESS_KEY_ID && {
            profile: process.env.AWS_PROFILE,
          }),
        },
      },
      removal: input?.stage === PROD_STAGE ? "retain" : "remove",
      protect: [PROD_STAGE].includes(input?.stage),
      home: "aws",
    };
  },
  async run() {
    const pulumi = await import("@pulumi/pulumi");
    const pulumiAws = await import("@pulumi/aws");
    const ACCOUNT_ID = (await pulumiAws.getCallerIdentity({})).accountId;
    // Optional pin: when AWS_ACCOUNT_ID is set, refuse to deploy anywhere else,
    // since resource names embed the account and a wrong caller builds a copy.
    if (EXPECTED_ACCOUNT_ID && ACCOUNT_ID !== EXPECTED_ACCOUNT_ID) {
      throw new Error(
        `Refusing to deploy as account ${ACCOUNT_ID}; expected ${EXPECTED_ACCOUNT_ID}`,
      );
    }
    const REGION = (await pulumiAws.getRegion({})).name;
    const STAGE = $app.stage;
    const stagePrefix = STAGE === PROD_STAGE ? "" : `${STAGE}-`;
    const name = (service: string) =>
      `${PROJECT}-${stagePrefix}${service}-${ACCOUNT_ID}-${REGION}`;
    const vectorBucketName = name("vecs");
    const storageBucketName = name("storage");
    const storageOrigin = `https://${storageBucketName}.s3.${REGION}.amazonaws.com`;
    const vectorIndexName = STAGE === PROD_STAGE ? "default" : STAGE;
    const vectorIndexArn = `arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/${vectorBucketName}/index/${vectorIndexName}`;

    const api = new sst.aws.ApiGatewayV2("Api", {
      cors: {
        allowOrigins: ["*"],
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      },
      transform: {
        api: (a) => {
          a.name = name("api");
        },
        stage: (s) => {
          s.name = "v1";
        },
      },
    });

    // Deploy the frontend to an S3 bucket served by a CloudFront distribution
    const web = new sst.aws.StaticSite("Web", {
      path: "web",
      build: {
        command: "npm install && npm run build",
        output: "dist",
      },
      environment: {
        VITE_API_URL: pulumi.interpolate`${api.url}/v1`,
        VITE_API_ORIGIN: api.url,
        VITE_STORAGE_ORIGIN: storageOrigin,
      },
    });

    const storage = new sst.aws.Bucket("Storage", {
      versioning: true,
      transform: {
        bucket: (a) => {
          a.bucket = storageBucketName;
        },
      },
    });

    new pulumiAws.s3.BucketCorsConfigurationV2("StorageCors", {
      bucket: storage.name,
      corsRules: [
        {
          allowedHeaders: ["*"],
          allowedMethods: ["POST"],
          allowedOrigins: [web.url],
          exposeHeaders: ["ETag"],
          maxAgeSeconds: 3600,
        },
      ],
    });

    new pulumiAws.s3.BucketLifecycleConfigurationV2("StorageLifecycle", {
      bucket: storage.name,
      rules: [
        {
          id: "expire-noncurrent-versions",
          status: "Enabled",
          filter: { prefix: "" },
          noncurrentVersionExpiration: { noncurrentDays: 7 },
          abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
        },
      ],
    });

    const table = new sst.aws.Dynamo("Meta", {
      fields: {
        pk: "string",
        sk: "string",
        gsi1pk: "string",
        gsi1sk: "string",
        gsi2pk: "string",
        gsi2sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      globalIndexes: {
        GSI1: { hashKey: "gsi1pk", rangeKey: "gsi1sk" },
        GSI2: { hashKey: "gsi2pk", rangeKey: "gsi2sk" },
      },
      ttl: "ttl",
      transform: {
        table: (a) => {
          a.name = name("meta");
        },
      },
    });

    const plansTable = new sst.aws.Dynamo("Plans", {
      fields: {
        pk: "string",
        sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      transform: {
        table: (a) => {
          a.name = name("plans");
        },
      },
    });

    const accountsTable = new sst.aws.Dynamo("Accounts", {
      fields: {
        pk: "string",
        sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      ttl: "ttl",
      transform: {
        table: (a) => {
          a.name = name("accounts");
        },
      },
    });

    const tagsTable = new sst.aws.Dynamo("Tags", {
      fields: {
        pk: "string",
        sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      transform: {
        table: (a) => {
          a.name = name("tags");
        },
      },
    });

    const rateLimitsTable = new sst.aws.Dynamo("RateLimits", {
      fields: {
        pk: "string",
        sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      transform: {
        table: (a) => {
          a.name = name("rate-limits");
        },
      },
    });

    const DEFAULT_PLAN_ID = "basic";

    const SEED_PLANS = [
      {
        planId: "basic",
        label: "Basic",
        priceMonthlyCents: 0,
        monthlyAllowanceCents: 100,
      },
      {
        planId: "pro",
        label: "Pro",
        priceMonthlyCents: 500,
        monthlyAllowanceCents: 400,
      },
    ];

    for (const plan of SEED_PLANS) {
      new pulumiAws.dynamodb.TableItem(`Plan-${plan.planId}`, {
        tableName: plansTable.name,
        hashKey: "pk",
        rangeKey: "sk",
        item: JSON.stringify({
          pk: `PLAN#${plan.planId}`,
          sk: "PLAN",
          planId: plan.planId,
          label: plan.label,
          priceMonthlyCents: plan.priceMonthlyCents,
          monthlyAllowanceCents: plan.monthlyAllowanceCents,
        }),
      });
    }

    const ingestDlq = new sst.aws.Queue("IngestDLQ", {
      transform: {
        queue: (a) => {
          a.name = name("ingest-dlq");
        },
      },
    });
    const chunkDlq = new sst.aws.Queue("ChunkDLQ", {
      transform: {
        queue: (a) => {
          a.name = name("chunk-dlq");
        },
      },
    });
    const embedDlq = new sst.aws.Queue("EmbedDLQ", {
      transform: {
        queue: (a) => {
          a.name = name("embed-dlq");
        },
      },
    });
    const ingestQueue = new sst.aws.Queue("Ingest", {
      visibilityTimeout: "900 seconds",
      dlq: { queue: ingestDlq.arn, retry: 3 },
      transform: {
        queue: (a) => {
          a.name = name("ingest-queue");
        },
      },
    });
    const chunkQueue = new sst.aws.Queue("Chunk", {
      visibilityTimeout: "900 seconds",
      dlq: { queue: chunkDlq.arn, retry: 3 },
      transform: {
        queue: (a) => {
          a.name = name("chunk-queue");
        },
      },
    });
    const embedQueue = new sst.aws.Queue("Embed", {
      visibilityTimeout: "900 seconds",
      dlq: { queue: embedDlq.arn, retry: 3 },
      transform: {
        queue: (a) => {
          a.name = name("embed-queue");
        },
      },
    });

    const baseEnv = {
      TABLE_NAME: table.name,
      PLANS_TABLE_NAME: plansTable.name,
      ACCOUNTS_TABLE_NAME: accountsTable.name,
      TAGS_TABLE_NAME: tagsTable.name,
      RATE_LIMITS_TABLE_NAME: rateLimitsTable.name,
      DEFAULT_PLAN_ID,
      STORAGE_BUCKET_NAME: storage.name,
      INGEST_QUEUE_URL: ingestQueue.url,
      CHUNK_QUEUE_URL: chunkQueue.url,
      EMBED_QUEUE_URL: embedQueue.url,
      VECTOR_BUCKET_NAME: vectorBucketName,
      VECTOR_INDEX_NAME: vectorIndexName,
      CHUNK_MAX_TOKENS: process.env.CHUNK_MAX_TOKENS!,
      CHUNK_OVERLAP_TOKENS: process.env.CHUNK_OVERLAP_TOKENS!,
      MAX_UPLOAD_BYTES: process.env.MAX_UPLOAD_BYTES ?? "10485760",
      MAX_CHUNKS_PER_DOCUMENT: process.env.MAX_CHUNKS_PER_DOCUMENT ?? "200",
      EMBEDDING_INPUT_PRICE_PER_1M_TOKENS:
        process.env.EMBEDDING_INPUT_PRICE_PER_1M_TOKENS ?? "0.01",
      APP_ORIGIN: $dev ? "http://localhost:5173" : web.url,
    };

    const embedEnv = {
      ...baseEnv,
      EMBEDDING_PROVIDER_URL: process.env.EMBEDDING_PROVIDER_URL!,
      EMBEDDING_MODEL: process.env.EMBEDDING_MODEL!,
      EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY!,
    };

    new pulumiAws.cloudformation.Stack("Vectors", {
      name: name("vectors"),
      templateBody: JSON.stringify({
        AWSTemplateFormatVersion: "2010-09-09",
        Resources: {
          VectorBucket: {
            Type: "AWS::S3Vectors::VectorBucket",
            Properties: { VectorBucketName: vectorBucketName },
          },
          VectorIndex: {
            Type: "AWS::S3Vectors::Index",
            DependsOn: "VectorBucket",
            Properties: {
              VectorBucketName: vectorBucketName,
              IndexName: vectorIndexName,
              DataType: "float32",
              Dimension: 1024,
              DistanceMetric: "cosine",
              MetadataConfiguration: {
                NonFilterableMetadataKeys: [
                  "text",
                  "chunkPreview",
                  "s3ChunkKey",
                ],
              },
            },
          },
        },
      }),
    });

    const uploadFn = new sst.aws.Function("Upload", {
      handler: "./functions/admin/upload.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Generate presigned upload URL and create document record",
      environment: baseEnv,
      permissions: [
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:Query",
            "dynamodb:TransactWriteItems",
            "dynamodb:UpdateItem",
          ],
          resources: [table.arn, accountsTable.arn, rateLimitsTable.arn],
        },
        {
          actions: ["s3:PutObject"],
          resources: [pulumi.interpolate`${storage.arn}/raw/*`],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("upload");
        },
      },
    });

    const ingestFn = new sst.aws.Function("IngestFn", {
      handler: "./functions/admin/ingest.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description:
        "Manually trigger the ingest pipeline for an existing document",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
          resources: [table.arn],
        },
        { actions: ["sqs:SendMessage"], resources: [ingestQueue.arn] },
      ],
      transform: {
        function: (a) => {
          a.name = name("ingest");
        },
      },
    });

    ingestQueue.subscribe(
      {
        handler: "./functions/parse/index.handler",
        runtime: "nodejs22.x",
        timeout: "300 seconds",
        memory: "1024 MB",
        description: "Extract text from raw document files using pdf-parse",
        environment: baseEnv,
        permissions: [
          {
            actions: ["s3:GetObject"],
            resources: [pulumi.interpolate`${storage.arn}/raw/*`],
          },
          {
            actions: ["s3:PutObject"],
            resources: [pulumi.interpolate`${storage.arn}/parsed/*`],
          },
          {
            actions: ["dynamodb:UpdateItem"],
            resources: [table.arn],
          },
          {
            actions: ["sqs:SendMessage"],
            resources: [chunkQueue.arn],
          },
        ],
        transform: {
          function: (a) => {
            a.name = name("parse");
          },
        },
      },
      { batch: { partialResponses: true } },
    );

    chunkQueue.subscribe(
      {
        handler: "./functions/chunk/index.handler",
        runtime: "nodejs22.x",
        timeout: "300 seconds",
        memory: "1024 MB",
        description: "Split parsed text into embeddable chunks",
        environment: baseEnv,
        permissions: [
          {
            actions: ["s3:GetObject"],
            resources: [pulumi.interpolate`${storage.arn}/parsed/*`],
          },
          {
            actions: ["s3:PutObject"],
            resources: [pulumi.interpolate`${storage.arn}/chunks/*`],
          },
          {
            actions: [
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
            ],
            resources: [table.arn],
          },
          { actions: ["sqs:SendMessage"], resources: [embedQueue.arn] },
        ],
        transform: {
          function: (a) => {
            a.name = name("chunk");
          },
        },
      },
      { batch: { partialResponses: true } },
    );

    embedQueue.subscribe(
      {
        handler: "./functions/embed/index.handler",
        runtime: "nodejs22.x",
        timeout: "300 seconds",
        memory: "128 MB",
        description: "Generate vectors from chunks and store in S3 Vectors",
        environment: {
          ...embedEnv,
          VECTOR_BATCH: process.env.VECTOR_BATCH!,
          EMBED_BATCH: process.env.EMBED_BATCH!,
        },
        permissions: [
          {
            actions: ["s3:GetObject"],
            resources: [pulumi.interpolate`${storage.arn}/chunks/*`],
          },
          {
            actions: [
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
            ],
            resources: [table.arn, accountsTable.arn],
          },
          {
            actions: ["s3vectors:PutVectors"],
            resources: [vectorIndexArn],
          },
        ],
        transform: {
          function: (a) => {
            a.name = name("embed");
          },
        },
      },
      { batch: { partialResponses: true } },
    );

    const queryFn = new sst.aws.Function("Query", {
      handler: "./functions/query/index.handler",
      runtime: "nodejs22.x",
      timeout: "30 seconds",
      memory: "256 MB",
      description: "Vector similarity search with metadata filters",
      environment: embedEnv,
      permissions: [
        {
          actions: ["s3:GetObject"],
          resources: [pulumi.interpolate`${storage.arn}/chunks/*`],
        },
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:Query",
            "dynamodb:UpdateItem",
          ],
          resources: [table.arn, accountsTable.arn, rateLimitsTable.arn],
        },
        {
          actions: ["s3vectors:QueryVectors", "s3vectors:GetVectors"],
          resources: [vectorIndexArn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("query");
        },
      },
    });

    const adminListFn = new sst.aws.Function("AdminList", {
      handler: "./functions/admin/list.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "List all documents with status and metadata",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:Query"],
          resources: [table.arn, pulumi.interpolate`${table.arn}/index/*`],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("admin-list");
        },
      },
    });

    const adminGetFn = new sst.aws.Function("AdminGet", {
      handler: "./functions/admin/get.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Get a single document with its chunk details",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:Query"],
          resources: [table.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("admin-get");
        },
      },
    });

    const adminReindexFn = new sst.aws.Function("AdminReindex", {
      handler: "./functions/admin/reindex.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Restart a failed document from its failed pipeline step",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
          resources: [table.arn],
        },
        { actions: ["s3:ListBucket"], resources: [storage.arn] },
        {
          actions: ["sqs:SendMessage"],
          resources: [ingestQueue.arn, chunkQueue.arn, embedQueue.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("admin-reindex");
        },
      },
    });

    const adminDeleteFn = new sst.aws.Function("AdminDelete", {
      handler: "./functions/admin/delete.handler",
      runtime: "nodejs22.x",
      timeout: "30 seconds",
      memory: "128 MB",
      description:
        "Delete a document and all derived data (vectors, chunks, parsed, source)",
      environment: baseEnv,
      permissions: [
        {
          actions: [
            "s3:ListBucketVersions",
            "s3:GetObject",
            "s3:DeleteObject",
            "s3:DeleteObjectVersion",
          ],
          resources: [storage.arn, pulumi.interpolate`${storage.arn}/*`],
        },
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:BatchWriteItem",
          ],
          resources: [table.arn],
        },
        {
          actions: ["s3vectors:DeleteVectors"],
          resources: [vectorIndexArn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("admin-delete");
        },
      },
    });

    const adminUpdateFn = new sst.aws.Function("AdminUpdate", {
      handler: "./functions/admin/update.handler",
      runtime: "nodejs22.x",
      timeout: "60 seconds",
      memory: "256 MB",
      description:
        "Update document metadata and propagate tags to chunks and vectors",
      environment: baseEnv,
      permissions: [
        {
          // Only chunk JSON is rewritten; raw uploads and parsed pages are not.
          actions: ["s3:GetObject", "s3:PutObject"],
          resources: [pulumi.interpolate`${storage.arn}/chunks/*`],
        },
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:UpdateItem",
          ],
          resources: [table.arn],
        },
        {
          actions: ["s3vectors:GetVectors", "s3vectors:PutVectors"],
          resources: [vectorIndexArn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("admin-update");
        },
      },
    });

    const tagsListFn = new sst.aws.Function("TagsList", {
      handler: "./functions/tags/list.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "List per-user tags",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:Query"],
          resources: [tagsTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("tags-list");
        },
      },
    });

    const tagsCreateFn = new sst.aws.Function("TagsCreate", {
      handler: "./functions/tags/create.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Create a per-user tag",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem"],
          resources: [tagsTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("tags-create");
        },
      },
    });

    const tagsUpdateFn = new sst.aws.Function("TagsUpdate", {
      handler: "./functions/tags/update.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Update a per-user tag color",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:UpdateItem"],
          resources: [tagsTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("tags-update");
        },
      },
    });

    const tagsDeleteFn = new sst.aws.Function("TagsDelete", {
      handler: "./functions/tags/delete.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Delete a per-user tag",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:DeleteItem"],
          resources: [tagsTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("tags-delete");
        },
      },
    });

    const billingFn = new sst.aws.Function("Billing", {
      handler: "./functions/admin/usage.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Return current account usage and billing summary",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
          resources: [accountsTable.arn],
        },
        {
          actions: ["dynamodb:GetItem"],
          resources: [plansTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("billing");
        },
      },
    });

    const plansListFn = new sst.aws.Function("PlansList", {
      handler: "./functions/plans/list.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "List all billing plans",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:Scan"],
          resources: [plansTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("plans-list");
        },
      },
    });

    const plansGetFn = new sst.aws.Function("PlansGet", {
      handler: "./functions/plans/get.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Get a single billing plan",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:GetItem"],
          resources: [plansTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("plans-get");
        },
      },
    });

    const plansCreateFn = new sst.aws.Function("PlansCreate", {
      handler: "./functions/plans/create.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Create a billing plan",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
          resources: [plansTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("plans-create");
        },
      },
    });

    const plansUpdateFn = new sst.aws.Function("PlansUpdate", {
      handler: "./functions/plans/update.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Update a billing plan",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
          resources: [plansTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("plans-update");
        },
      },
    });

    const plansDeleteFn = new sst.aws.Function("PlansDelete", {
      handler: "./functions/plans/delete.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Delete a billing plan",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:DeleteItem"],
          resources: [plansTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("plans-delete");
        },
      },
    });

    const plansAssignFn = new sst.aws.Function("PlansAssign", {
      handler: "./functions/plans/assign.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Assign a billing plan to the current account",
      environment: baseEnv,
      permissions: [
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
          ],
          resources: [plansTable.arn, accountsTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("plans-assign");
        },
      },
    });

    const billingAccountFn = new sst.aws.Function("BillingAccount", {
      handler: "./functions/admin/account.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Return current account profile and plan",
      environment: baseEnv,
      permissions: [
        {
          actions: ["dynamodb:GetItem"],
          resources: [accountsTable.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("billing-account");
        },
      },
    });

    const ingestAdapterFn = new sst.aws.Function("IngestAdapter", {
      handler: "./functions/s3/ingest-adapter.handler",
      runtime: "nodejs22.x",
      timeout: "60 seconds",
      memory: "256 MB",
      description:
        "Finalize uploads, clean replaced data, and queue document ingestion",
      environment: baseEnv,
      permissions: [
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:Query",
            "dynamodb:DeleteItem",
            "dynamodb:BatchWriteItem",
          ],
          resources: [table.arn, accountsTable.arn],
        },
        {
          actions: [
            "s3:GetObject",
            "s3:ListBucketVersions",
            "s3:DeleteObject",
            "s3:DeleteObjectVersion",
          ],
          resources: [storage.arn, pulumi.interpolate`${storage.arn}/*`],
        },
        {
          actions: ["s3vectors:DeleteVectors"],
          resources: [vectorIndexArn],
        },
        { actions: ["sqs:SendMessage"], resources: [ingestQueue.arn] },
      ],
      transform: {
        function: (a) => {
          a.name = name("ingest-adapter");
        },
      },
    });

    const cleanupAdapterFn = new sst.aws.Function("CleanupAdapter", {
      handler: "./functions/s3/cleanup-adapter.handler",
      runtime: "nodejs22.x",
      timeout: "300 seconds",
      memory: "512 MB",
      description:
        "Delete all derived data when a source file is removed from S3",
      environment: baseEnv,
      permissions: [
        {
          actions: [
            "s3:ListBucketVersions",
            "s3:DeleteObject",
            "s3:DeleteObjectVersion",
          ],
          resources: [storage.arn, pulumi.interpolate`${storage.arn}/*`],
        },
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:DeleteItem",
            "dynamodb:Query",
            "dynamodb:BatchWriteItem",
          ],
          resources: [table.arn],
        },
        {
          actions: ["s3vectors:DeleteVectors"],
          resources: [vectorIndexArn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("cleanup-adapter");
        },
      },
    });

    storage.notify({
      notifications: [
        {
          name: "ingest-adapter",
          function: ingestAdapterFn.arn,
          events: ["s3:ObjectCreated:Put", "s3:ObjectCreated:Post"],
          filterPrefix: "raw/",
        },
        {
          name: "cleanup-adapter",
          function: cleanupAdapterFn.arn,
          events: [
            "s3:ObjectRemoved:Delete",
            "s3:ObjectRemoved:DeleteMarkerCreated",
          ],
          filterPrefix: "raw/",
        },
      ],
    });

    api.route("POST /upload", uploadFn.arn);
    api.route("POST /ingest", ingestFn.arn);
    api.route("POST /query", queryFn.arn);
    api.route("GET /documents", adminListFn.arn);
    api.route("GET /documents/{id}", adminGetFn.arn);
    api.route("POST /documents/{id}/reindex", adminReindexFn.arn);
    api.route("PATCH /documents/{id}", adminUpdateFn.arn);
    api.route("DELETE /documents/{id}", adminDeleteFn.arn);
    api.route("GET /tags", tagsListFn.arn);
    api.route("POST /tags", tagsCreateFn.arn);
    api.route("PATCH /tags/{name}", tagsUpdateFn.arn);
    api.route("DELETE /tags/{name}", tagsDeleteFn.arn);
    api.route("GET /account/usage", billingFn.arn);
    api.route("GET /plans", plansListFn.arn);
    api.route("POST /plans", plansCreateFn.arn);
    api.route("GET /plans/{id}", plansGetFn.arn);
    api.route("PATCH /plans/{id}", plansUpdateFn.arn);
    api.route("DELETE /plans/{id}", plansDeleteFn.arn);
    api.route("GET /account/plans", plansListFn.arn);
    api.route("GET /account", billingAccountFn.arn);
    api.route("PATCH /account/plan", plansAssignFn.arn);

    return {
      apiEndpoint: api.url,
      webEndpoint: web.url,
    };
  },
});
