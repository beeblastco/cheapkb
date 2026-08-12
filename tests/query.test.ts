import { S3Client } from "@aws-sdk/client-s3";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  QueryVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sst", () => ({
  Resource: {
    Meta: { name: "table" },
    Storage: { name: "storage" },
  },
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: { pairwise_sub: "user-1" },
  }),
}));

vi.mock("../functions/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../functions/utils")>()),
  extractUserId: vi.fn().mockResolvedValue({ userId: "user-1" }),
  checkUsageLimit: vi.fn(async () => ({ allowed: true, summary: {} })),
  recordUsage: vi.fn(async () => {}),
}));

import { recordUsage } from "../functions/utils";
import { buildFilter, handler as queryHandler } from "../functions/query/index";

const s3Mock = mockClient(S3Client);
const vectorsMock = mockClient(S3VectorsClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);
const bedrockMock = mockClient(BedrockRuntimeClient);

describe("query tenant filter", () => {
  it("always uses the authenticated user and ignores a caller override", () => {
    expect(
      buildFilter({ userId: "attacker", year: { $gte: 2024 } }, "owner"),
    ).toEqual({
      embeddingModel: "us.cohere.embed-v4:0",
      userId: "owner",
      year: { $gte: 2024 },
    });
  });

  it("rejects unknown metadata keys", () => {
    expect(() => buildFilter({ secret: "value" }, "owner")).toThrow(
      "Unsupported filter",
    );
  });
});

describe("query handler usage", () => {
  beforeEach(() => {
    process.env.TABLE_NAME = "test-table";
    process.env.ACCOUNTS_TABLE_NAME = "test-accounts-table";
    process.env.RATE_LIMITS_TABLE_NAME = "test-rate-limits-table";
    process.env.VECTOR_BUCKET_NAME = "test-vector-bucket";
    process.env.VECTOR_INDEX_NAME = "test-index";
    process.env.STORAGE_BUCKET_NAME = "test-storage-bucket";
    process.env.BEDROCK_EMBEDDING_MODEL = "us.cohere.embed-v4:0";
    process.env.EMBEDDING_DIMENSION = "3";

    vi.clearAllMocks();
    bedrockMock.reset();
    s3Mock.reset();
    vectorsMock.reset();
    dynamoMock.reset();
    dynamoMock.on(GetCommand).resolves({});
    dynamoMock.on(PutCommand).resolves({});
    bedrockMock.on(InvokeModelCommand).resolves({
      $metadata: { bedrockInputTokenCount: 11 } as any,
      body: new TextEncoder().encode(
        JSON.stringify({
          embeddings: { float: [[0.1, 0.2, 0.3]] },
        }),
      ),
    });

    vectorsMock.on(QueryVectorsCommand).resolves({ vectors: [] });
  });

  it("records the query operation after a successful search", async () => {
    const event = {
      headers: { authorization: "Bearer token" },
      body: JSON.stringify({ query: "hello world" }),
    };

    const response = await queryHandler(event);

    expect(response.statusCode).toBe(200);
    expect(recordUsage).toHaveBeenCalledWith(
      "user-1",
      expect.any(String),
      "query",
      1,
    );
    expect(recordUsage).toHaveBeenCalledWith(
      "user-1",
      expect.any(String),
      "embed",
      11,
    );
    const invocation =
      bedrockMock.commandCalls(InvokeModelCommand)[0].args[0].input;
    expect(invocation.trace).toBe("ENABLED");
    expect(JSON.parse(String(invocation.requestMetadata))).toEqual(
      expect.objectContaining({
        cheapkbInputModality: "text",
        cheapkbOperation: "query",
        cheapkbUsageCategory: "embed",
        cheapkbUserId: "user-1",
      }),
    );
  });

  it("accepts an image query and uses Cohere search retrieval", async () => {
    const image = `data:image/png;base64,${Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]).toString("base64")}`;
    const response = await queryHandler({
      headers: { authorization: "Bearer token" },
      body: JSON.stringify({ image }),
    });

    expect(response.statusCode).toBe(200);
    const request = JSON.parse(
      String(
        bedrockMock.commandCalls(InvokeModelCommand)[0].args[0].input.body,
      ),
    );
    expect(request.input_type).toBe("search_query");
    expect(request.inputs).toEqual([
      {
        content: [
          {
            type: "image_url",
            image_url: { url: image },
          },
        ],
      },
    ]);
  });

  it("fuses text and image into one mixed query", async () => {
    const image = `data:image/png;base64,${Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]).toString("base64")}`;
    const response = await queryHandler({
      headers: { authorization: "Bearer token" },
      body: JSON.stringify({ query: "catalog photo", image }),
    });

    expect(response.statusCode).toBe(200);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(1);
    expect(vectorsMock.commandCalls(QueryVectorsCommand)).toHaveLength(1);
    const call = bedrockMock.commandCalls(InvokeModelCommand)[0];
    const metadata = JSON.parse(String(call.args[0].input.requestMetadata));
    const request = JSON.parse(String(call.args[0].input.body));
    expect(metadata.cheapkbInputModality).toBe("mixed");
    expect(
      request.inputs[0].content.map((part: { type: string }) => part.type),
    ).toEqual(["text", "image_url"]);
  });

  it("rejects a mislabeled image before invoking Bedrock", async () => {
    const response = await queryHandler({
      headers: { authorization: "Bearer token" },
      body: JSON.stringify({
        image: `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`,
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });
});
