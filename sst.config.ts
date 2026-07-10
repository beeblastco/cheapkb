/// <reference path="./.sst/platform/config.d.ts" />

const PROJECT = "cheapkb";
// Stage name "prod" is poisoned in SST Ion cloud state from failed prior deploys; using "production" as standard alias
const PROD_STAGE = "production";

export default $config({
  app(input) {
    return {
      name: PROJECT,
      providers: {
        aws: {
          // Use profile locally; CI uses AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars
          ...(!process.env.AWS_ACCESS_KEY_ID && { profile: "954475336309" }),
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
    const REGION = (await pulumiAws.getRegion({})).name;
    const STAGE = $app.stage;
    const stagePrefix = STAGE === PROD_STAGE ? "" : `${STAGE}-`;
    const name = (service: string) =>
      `${PROJECT}-${stagePrefix}${service}-${ACCOUNT_ID}-${REGION}`;
    const vectorBucketName = name("vecs");
    const vectorIndexName = STAGE === PROD_STAGE ? "default" : STAGE;

    const api = new sst.aws.ApiGatewayV2("Api", {
      cors: {
        allowOrigins: ["*"],
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["*"],
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
        API_URL: api.url,
      },
    });

    // Base environment variables for all functions
    const baseEnv = {
      VECTOR_BUCKET_NAME: vectorBucketName,
      VECTOR_INDEX_NAME: vectorIndexName,
      CHUNK_MAX_TOKENS: process.env.CHUNK_MAX_TOKENS!,
      CHUNK_OVERLAP_TOKENS: process.env.CHUNK_OVERLAP_TOKENS!,
      APP_ORIGIN: $dev ? "http://localhost:5173" : web.url,
    };

    // Environment variables for embedding functions
    const embedEnv = {
      ...baseEnv,
      EMBEDDING_PROVIDER_URL: process.env.EMBEDDING_PROVIDER_URL!,
      EMBEDDING_MODEL: process.env.EMBEDDING_MODEL!,
      EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY!,
    };

    const storage = new sst.aws.Bucket("Storage", {
      versioning: true,
      transform: {
        bucket: (a) => {
          a.bucket = name("storage");
        },
      },
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
      transform: {
        table: (a) => {
          a.name = name("meta");
        },
      },
    });

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
      link: [storage, table],
      environment: baseEnv,
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
      link: [table, ingestQueue],
      environment: baseEnv,
      transform: {
        function: (a) => {
          a.name = name("ingest");
        },
      },
    });

    ingestQueue.subscribe({
      handler: "./functions/parse/index.handler",
      runtime: "nodejs22.x",
      timeout: "300 seconds",
      memory: "1024 MB",
      description: "Extract text from raw document files using pdf-parse",
      link: [storage, table, chunkQueue, ingestQueue],
      environment: baseEnv,
      permissions: [
        {
          actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
          resources: [storage.arn, pulumi.interpolate`${storage.arn}/*`],
        },
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:Query",
          ],
          resources: [table.arn],
        },
        {
          actions: ["sqs:SendMessage"],
          resources: [chunkQueue.arn, ingestQueue.arn],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("parse");
        },
      },
    });

    chunkQueue.subscribe({
      handler: "./functions/chunk/index.handler",
      runtime: "nodejs22.x",
      timeout: "300 seconds",
      memory: "1024 MB",
      description: "Split parsed text into embeddable chunks",
      link: [storage, table, embedQueue],
      environment: baseEnv,
      permissions: [
        {
          actions: ["s3:GetObject", "s3:PutObject"],
          resources: [storage.arn, pulumi.interpolate`${storage.arn}/*`],
        },
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:Query",
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
    });

    embedQueue.subscribe({
      handler: "./functions/embed/index.handler",
      runtime: "nodejs22.x",
      timeout: "300 seconds",
      memory: "128 MB",
      description: "Generate vectors from chunks and store in S3 Vectors",
      link: [storage, table],
      environment: {
        ...embedEnv,
        VECTOR_BATCH: process.env.VECTOR_BATCH!,
        EMBED_BATCH: process.env.EMBED_BATCH!,
      },
      permissions: [
        {
          actions: [
            "s3vectors:PutVectors",
            "s3vectors:GetVectors",
            "s3vectors:DeleteVectors",
            "s3vectors:QueryVectors",
            "s3vectors:ListVectors",
          ],
          resources: ["*"],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("embed");
        },
      },
    });

    const queryFn = new sst.aws.Function("Query", {
      handler: "./functions/query/index.handler",
      runtime: "nodejs22.x",
      timeout: "30 seconds",
      memory: "256 MB",
      description: "Vector similarity search with metadata filters",
      link: [storage, table],
      environment: embedEnv,
      permissions: [
        {
          actions: [
            "s3vectors:PutVectors",
            "s3vectors:GetVectors",
            "s3vectors:DeleteVectors",
            "s3vectors:QueryVectors",
            "s3vectors:ListVectors",
          ],
          resources: ["*"],
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
      link: [table],
      environment: baseEnv,
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
      link: [table],
      environment: baseEnv,
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
      link: [table, ingestQueue],
      environment: baseEnv,
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
      link: [storage, table],
      environment: baseEnv,
      permissions: [
        {
          actions: [
            "s3vectors:DeleteVectors",
            "s3vectors:QueryVectors",
            "s3vectors:ListVectors",
            "s3vectors:GetVectors",
          ],
          resources: ["*"],
        },
      ],
      transform: {
        function: (a) => {
          a.name = name("admin-delete");
        },
      },
    });

    const adminJobFn = new sst.aws.Function("AdminJob", {
      handler: "./functions/admin/job.handler",
      runtime: "nodejs22.x",
      timeout: "10 seconds",
      memory: "128 MB",
      description: "Get the status and details of an ingest job",
      link: [table],
      environment: baseEnv,
      transform: {
        function: (a) => {
          a.name = name("admin-job");
        },
      },
    });

    const ingestAdapterFn = new sst.aws.Function("IngestAdapter", {
      handler: "./functions/s3/ingest-adapter.handler",
      runtime: "nodejs22.x",
      timeout: "30 seconds",
      memory: "128 MB",
      description: "Bridge S3 ObjectCreated events to the ingest queue",
      link: [table, ingestQueue],
      environment: baseEnv,
      permissions: [
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
          ],
          resources: [table.arn],
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
      link: [storage, table],
      environment: baseEnv,
      permissions: [
        {
          actions: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:ListBucket",
            "s3:DeleteObject",
          ],
          resources: [storage.arn, pulumi.interpolate`${storage.arn}/*`],
        },
        {
          actions: ["dynamodb:DeleteItem", "dynamodb:GetItem"],
          resources: [table.arn],
        },
        {
          actions: [
            "s3vectors:DeleteVectors",
            "s3vectors:ListVectors",
            "s3vectors:GetVectors",
          ],
          resources: ["*"],
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
    api.route("DELETE /documents/{id}", adminDeleteFn.arn);
    api.route("GET /jobs/{id}", adminJobFn.arn);

    return {
      apiEndpoint: api.url,
      webEndpoint: web.url,
    };
  },
});
