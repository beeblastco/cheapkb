import { S3Client } from "@aws-sdk/client-s3";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../functions/billing/utils", () => ({
  checkUsageLimit: vi.fn(async () => ({ allowed: true, summary: {} })),
  recordUsage: vi.fn(async () => {}),
}));

import { handler as queryHandler, buildFilter } from "../functions/query/index";
import { recordUsage } from "../functions/billing/utils";

const s3Mock = mockClient(S3Client);
const vectorsMock = mockClient(S3VectorsClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("query tenant filter", () => {
  it("always uses the authenticated user and ignores a caller override", () => {
    expect(
      buildFilter({ userId: "attacker", year: { $gte: 2024 } }, "owner"),
    ).toEqual({ userId: "owner", year: { $gte: 2024 } });
  });

  it("rejects unknown metadata keys", () => {
    expect(() => buildFilter({ secret: "value" }, "owner")).toThrow(
      "Unsupported filter",
    );
  });
});

describe("query handler usage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.TABLE_NAME = "test-table";
    process.env.VECTOR_BUCKET_NAME = "test-vector-bucket";
    process.env.VECTOR_INDEX_NAME = "test-index";
    process.env.STORAGE_BUCKET_NAME = "test-storage-bucket";
    process.env.EMBEDDING_PROVIDER_URL = "https://test-embed.example.com";
    process.env.EMBEDDING_MODEL = "test-model";
    process.env.EMBEDDING_API_KEY = "test-key";

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    })) as unknown as typeof fetch;

    vi.clearAllMocks();
    s3Mock.reset();
    vectorsMock.reset();
    dynamoMock.reset();
    dynamoMock.on(GetCommand).resolves({});
    dynamoMock.on(PutCommand).resolves({});

    vectorsMock.on(QueryVectorsCommand).resolves({ vectors: [] });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("records both query and embed usage after a successful search", async () => {
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
      expect.any(Number),
    );
  });
});
