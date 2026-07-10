import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
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
vi.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: vi.fn().mockResolvedValue({
    url: "https://upload.example.com",
    fields: { key: "raw/doc/file.pdf" },
  }),
}));

import { handler } from "../functions/admin/upload";

const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("upload validation", () => {
  beforeEach(() => {
    dynamoMock.reset();
    vi.mocked(createPresignedPost).mockClear();
  });

  it("rejects unsupported content types before creating storage", async () => {
    const response = await handler({
      headers: {},
      body: JSON.stringify({ filename: "page.html", mimeType: "text/html" }),
    });

    expect(response.statusCode).toBe(400);
    expect(createPresignedPost).not.toHaveBeenCalled();
    expect(dynamoMock.calls()).toHaveLength(0);
  });

  it("creates a size-constrained presigned POST", async () => {
    const response = await handler({
      headers: {},
      body: JSON.stringify({
        filename: "file.pdf",
        mimeType: "application/pdf",
        title: "File",
      }),
    });

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
});
