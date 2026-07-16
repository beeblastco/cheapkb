import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sst", () => ({
  Resource: { Meta: { name: "table" }, Storage: { name: "storage" } },
}));
vi.mock("../functions/utils", () => ({
  extractUserId: vi.fn().mockResolvedValue({ userId: "user-a" }),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 49 }),
}));
vi.mock("../functions/billing/usage", () => ({
  checkUsageLimit: vi.fn().mockResolvedValue({ allowed: true }),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: vi.fn().mockResolvedValue({
    url: "https://upload.example.com",
    fields: { key: "raw/doc/file.pdf" },
  }),
}));

import { handler } from "../functions/admin/upload";
import { jsonApiEvent } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("upload validation", () => {
  beforeEach(() => {
    dynamoMock.reset();
    dynamoMock.on(GetCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    vi.mocked(createPresignedPost).mockClear();
  });

  it("rejects unsupported content types before creating storage", async () => {
    const response = await handler(
      jsonApiEvent({ filename: "page.html", mimeType: "text/html" }),
    );

    expect(response.statusCode).toBe(400);
    expect(createPresignedPost).not.toHaveBeenCalled();
    expect(dynamoMock.calls()).toHaveLength(0);
  });

  it("creates a size-constrained presigned POST", async () => {
    const response = await handler(
      jsonApiEvent({
        filename: "file.pdf",
        mimeType: "application/pdf",
        title: "File",
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(createPresignedPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        Conditions: expect.arrayContaining([
          ["content-length-range", 1, 10485760],
        ]),
      }),
    );
  });

  it("reuses a completed document with the same filename and mime type", async () => {
    dynamoMock
      .on(GetCommand)
      .resolvesOnce({ Item: { documentId: "doc-existing" } })
      .resolvesOnce({
        Item: {
          pk: "DOC#doc-existing",
          sk: "META",
          documentId: "doc-existing",
          userId: "user-a",
          sourceKey: "raw/doc-existing/file.pdf",
          status: "EMBEDDED",
        },
      });
    dynamoMock.on(UpdateCommand).resolves({});

    const response = await handler(
      jsonApiEvent({ filename: "file.pdf", mimeType: "application/pdf" }),
    );
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.documentId).toBe("doc-existing");
    expect(body.reused).toBe(true);
    expect(body.sourceKey).toBe("raw/doc-existing/file.pdf");
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it.each([
    "UPLOADED",
    "QUEUED",
    "PARSING",
    "PARSED",
    "CHUNKING",
    "CHUNKED",
    "EMBEDDING",
  ])("rejects a duplicate while status is %s", async (status) => {
    dynamoMock
      .on(GetCommand)
      .resolvesOnce({ Item: { documentId: "doc-existing" } })
      .resolvesOnce({
        Item: {
          documentId: "doc-existing",
          userId: "user-a",
          status,
        },
      });

    const response = await handler(
      jsonApiEvent({ filename: "file.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(409);
    expect(createPresignedPost).not.toHaveBeenCalled();
  });

  it("creates different documents for a different filename or mime type", async () => {
    const first = await handler(
      jsonApiEvent({ filename: "file.pdf", mimeType: "application/pdf" }),
    );
    const second = await handler(
      jsonApiEvent({ filename: "file.txt", mimeType: "text/plain" }),
    );

    expect(JSON.parse(first.body).documentId).not.toBe(
      JSON.parse(second.body).documentId,
    );
    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });
});
