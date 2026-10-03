import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sst", () => ({
  Resource: { Meta: { name: "table" }, Storage: { name: "storage" } },
}));
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: { pairwise_sub: "user-a" },
  }),
}));
vi.mock("../functions/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../functions/utils")>()),
  extractUserId: vi.fn().mockResolvedValue({ userId: "user-1" }),
  checkUsageLimit: vi.fn().mockResolvedValue({
    allowed: true,
    summary: { storageBytes: 0 },
  }),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: vi.fn().mockResolvedValue({
    url: "https://upload.example.com",
    fields: { key: "raw/doc/file.pdf" },
  }),
}));

import { handler } from "../functions/admin/upload";
import { checkUsageLimit } from "../functions/utils";
import { jsonApiEvent } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("upload validation", () => {
  beforeEach(() => {
    dynamoMock.reset();
    dynamoMock.on(GetCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(QueryCommand).resolves({ Items: [] });
    vi.clearAllMocks();
  });

  it("rejects uploads once the account reaches the storage cap", async () => {
    vi.mocked(checkUsageLimit).mockResolvedValueOnce({
      allowed: true,
      summary: { storageBytes: 1024 * 1024 * 1024 },
    } as Awaited<ReturnType<typeof checkUsageLimit>>);

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(429);
    expect(createPresignedPost).not.toHaveBeenCalled();
  });

  it("rejects unsupported content types before creating storage", async () => {
    const response = await handler(
      jsonApiEvent({ filename: "page.html", mimeType: "text/html" }),
    );

    expect(response.statusCode).toBe(400);
    expect(createPresignedPost).not.toHaveBeenCalled();
    expect(
      dynamoMock
        .calls()
        .filter(
          (c) =>
            !c.args[0].input.Key?.pk?.startsWith("RATE#") &&
            !c.args[0].input.Item?.pk?.startsWith("RATE#"),
        ),
    ).toHaveLength(0);
  });

  it("rejects a JSON null body with a 400", async () => {
    const response = await handler(jsonApiEvent(null));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe(
      "Request body must be an object",
    );
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
          ["content-length-range", 1, 52428800],
        ]),
      }),
    );
  });

  it("accepts images within the configured five MB limit", async () => {
    const response = await handler(
      jsonApiEvent({ filename: "photo.png", mimeType: "image/png" }),
    );

    expect(response.statusCode).toBe(200);
    expect(createPresignedPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        Conditions: expect.arrayContaining([
          ["content-length-range", 1, 5242880],
        ]),
      }),
    );
  });

  it("reuses a completed document with the same filename and mime type", async () => {
    dynamoMock
      .on(GetCommand)
      .resolvesOnce({})
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
      .resolvesOnce({})
      .resolvesOnce({ Item: { documentId: "doc-existing" } })
      .resolvesOnce({
        Item: {
          documentId: "doc-existing",
          userId: "user-a",
          status: status,
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

  it("keeps distinct non-ASCII filenames as distinct documents", async () => {
    for (const filename of [
      "報告.pdf",
      "資料.pdf",
      "báo cáo.pdf",
      "bìo cùo.pdf",
    ]) {
      await handler(
        jsonApiEvent({ filename: filename, mimeType: "application/pdf" }),
      );
    }

    const created = dynamoMock
      .commandCalls(TransactWriteCommand)
      .map((call) => call.args[0].input.TransactItems![1].Put!.Item!);
    // A shared dedupe key would make the second upload replace the first.
    expect(new Set(created.map((item) => item.dedupeKey)).size).toBe(4);
    expect(created[0].sourceKey).toMatch(/^raw\/doc_[^/]+\/報告\.pdf$/);
    expect(created[2].filename).toBe("báo_cáo.pdf");
  });

  it("maps an ASCII filename to the same dedupe key as before", async () => {
    await handler(
      jsonApiEvent({
        filename: " my report (1).pdf",
        mimeType: "application/pdf",
      }),
    );

    const mapping =
      dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
        .TransactItems![0].Put!.Item!;
    // Existing mappings were keyed on this exact sanitized name.
    const expected = createHash("sha256")
      .update("user-1\0my_report__1_.pdf\0application/pdf")
      .digest("hex");
    expect(mapping.sk).toBe(`DOCUMENT#${expected}`);
  });

  it("rejects a new document while ten are still processing", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(QueryCommand).resolves({
      Items: Array.from({ length: 10 }, () => ({
        status: "EMBEDDING",
        updatedAt: now,
      })),
    });

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(429);
    expect(createPresignedPost).not.toHaveBeenCalled();
  });

  it("does not count abandoned upload forms or tag edits as processing", async () => {
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    dynamoMock.on(QueryCommand).resolves({
      Items: [
        ...Array.from({ length: 10 }, () => ({
          status: "UPLOADED",
          updatedAt: stale,
        })),
        ...Array.from({ length: 10 }, () => ({
          status: "UPDATING",
          updatedAt: now,
        })),
      ],
    });

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(200);
  });

  it("counts a pending replacement as processing", async () => {
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    dynamoMock.on(QueryCommand).resolves({
      Items: Array.from({ length: 10 }, () => ({
        status: "EMBEDDED",
        replacementExpiresAt: expires,
      })),
    });

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(429);
  });

  it("rejects title, tags and authors over the shared metadata budget", async () => {
    const response = await handler(
      jsonApiEvent({
        filename: "paper.pdf",
        mimeType: "application/pdf",
        tags: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(90, "t")),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain("1200 bytes");
    expect(createPresignedPost).not.toHaveBeenCalled();
  });

  it("counts a filename used as the title against the metadata budget", async () => {
    const response = await handler(
      jsonApiEvent({
        filename: `${"報".repeat(250)}.pdf`,
        mimeType: "application/pdf",
        authors: Array.from({ length: 5 }, (_, i) => `${i}`.padEnd(100, "a")),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(createPresignedPost).not.toHaveBeenCalled();
  });

  it("finds a document stored under the old ASCII-only filename", async () => {
    const legacyKey = createHash("sha256")
      .update("user-1\0r_sum_.pdf\0application/pdf")
      .digest("hex");
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === `DOCUMENT#${legacyKey}`) {
        return { Item: { documentId: "doc-old" } };
      }
      if (input.Key?.pk === "DOC#doc-old") {
        return {
          Item: {
            pk: "DOC#doc-old",
            sk: "META",
            userId: "user-1",
            status: "EMBEDDED",
            sourceKey: "raw/doc-old/r_sum_.pdf",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        };
      }
      return {};
    });
    dynamoMock.on(UpdateCommand).resolves({});

    const response = await handler(
      jsonApiEvent({ filename: "résumé.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      documentId: "doc-old",
      reused: true,
    });
  });

  it("rejects a new document at the per-account document cap", async () => {
    dynamoMock.on(QueryCommand).resolves({
      Items: Array.from({ length: 1000 }, () => ({ status: "EMBEDDED" })),
    });

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(429);
    expect(createPresignedPost).not.toHaveBeenCalled();
  });
});
