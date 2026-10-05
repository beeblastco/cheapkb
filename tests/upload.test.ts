import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// sst.config.ts sets these limits for every function, clamping images to 5 MB.
vi.hoisted(() => {
  process.env.MAX_UPLOAD_BYTES = "52428800";
  process.env.MAX_IMAGE_UPLOAD_BYTES = "5242880";
  process.env.MAX_STORAGE_BYTES = "1073741824";
});
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
    expect(JSON.parse(response.body!).error).toBe(
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
      })
      .resolvesOnce({ Item: { uploadSeq: 4 } });

    const response = await handler(
      jsonApiEvent({ filename: "file.pdf", mimeType: "application/pdf" }),
    );
    const body = JSON.parse(response.body!);

    expect(response.statusCode).toBe(200);
    expect(body.documentId).toBe("doc-existing");
    expect(body.reused).toBe(true);
    expect(body.sourceKey).toBe("raw/doc-existing/file.pdf");
    const [meta, account] =
      dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
        .TransactItems!;
    expect(meta.Update!.ConditionExpression).toContain("#s = :expected");
    expect(account.Update!.ConditionExpression).toBe(
      "attribute_not_exists(uploadSeq) OR uploadSeq = :seen",
    );
    expect(account.Update!.ExpressionAttributeValues).toMatchObject({
      ":next": 5,
      ":seen": 4,
    });
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

    expect(JSON.parse(first.body!).documentId).not.toBe(
      JSON.parse(second.body!).documentId,
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
      Items: Array.from({ length: 10 }, (_, i) => ({
        pk: `DOC#doc-embedding-${i}`,
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
        ...Array.from({ length: 10 }, (_, i) => ({
          pk: `DOC#doc-uploaded-${i}`,
          status: "UPLOADED",
          updatedAt: stale,
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          pk: `DOC#doc-updating-${i}`,
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
      Items: Array.from({ length: 10 }, (_, i) => ({
        pk: `DOC#doc-embedded-${i}`,
        status: "EMBEDDED",
        replacementExpiresAt: expires,
      })),
    });

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(429);
    expect(JSON.parse(response.body!)).toEqual({
      error: "Too many documents processing. Try again when they finish.",
      code: "PROCESSING_LIMIT",
    });
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
    expect(JSON.parse(response.body!).error).toContain("1200 bytes");
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

  it("never matches a new Unicode name to an old ASCII-only mapping", async () => {
    const legacyKey = createHash("sha256")
      .update("user-1\0__.pdf\0application/pdf")
      .digest("hex");
    dynamoMock
      .on(GetCommand)
      .callsFake((input) =>
        input.Key?.sk === `DOCUMENT#${legacyKey}`
          ? { Item: { documentId: "doc-old" } }
          : {},
      );

    const response = await handler(
      jsonApiEvent({ filename: "总结.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).reused).toBe(false);
  });

  it("rejects a new document at the per-account document cap", async () => {
    dynamoMock.on(QueryCommand).resolves({
      Items: Array.from({ length: 1000 }, (_, i) => ({
        pk: `DOC#doc-${i}`,
        status: "EMBEDDED",
      })),
    });

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(429);
    expect(createPresignedPost).not.toHaveBeenCalled();
  });

  it("commits a new document with the account uploadSeq it counted under", async () => {
    dynamoMock
      .on(GetCommand)
      .callsFake((input) =>
        input.Key?.pk === "ACCOUNT#user-1" ? { Item: { uploadSeq: 7 } } : {},
      );

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(200);
    const account =
      dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
        .TransactItems![2].Update!;
    expect(account.Key).toEqual({ pk: "ACCOUNT#user-1", sk: "PROFILE" });
    expect(account.ConditionExpression).toBe(
      "attribute_not_exists(uploadSeq) OR uploadSeq = :seen",
    );
    expect(account.ExpressionAttributeValues).toMatchObject({
      ":next": 8,
      ":seen": 7,
    });
  });

  it("starts the uploadSeq for an account that has none", async () => {
    await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    const account =
      dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
        .TransactItems![2].Update!;
    // No upload ever stores 0, so this passes only while uploadSeq is missing.
    expect(account.ConditionExpression).toContain(
      "attribute_not_exists(uploadSeq)",
    );
    expect(account.ExpressionAttributeValues).toMatchObject({
      ":next": 1,
      ":seen": 0,
    });
  });

  it("counts recent commits that GSI2 does not show yet", async () => {
    const nowMs = Date.now();
    const recentUploads = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`doc-recent-${i}`, nowMs - 1000]),
    );
    dynamoMock
      .on(GetCommand)
      .callsFake((input) =>
        input.Key?.pk === "ACCOUNT#user-1"
          ? { Item: { uploadSeq: 3, recentUploads: recentUploads } }
          : {},
      );

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(429);
    expect(JSON.parse(response.body).code).toBe("PROCESSING_LIMIT");
  });

  it("records the commit and drops recent commits past the window", async () => {
    const nowMs = Date.now();
    dynamoMock.on(GetCommand).callsFake((input) =>
      input.Key?.pk === "ACCOUNT#user-1"
        ? {
            Item: {
              uploadSeq: 3,
              recentUploads: {
                "doc-old": nowMs - 60_000,
                "doc-new": nowMs - 1000,
              },
            },
          }
        : {},
    );

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(200);
    const { documentId } = JSON.parse(response.body);
    const recent =
      dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
        .TransactItems![2].Update!.ExpressionAttributeValues![":recentUploads"];
    expect(Object.keys(recent).sort()).toEqual(["doc-new", documentId].sort());
  });

  it("recounts and retries when another upload moves the uploadSeq first", async () => {
    dynamoMock
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled(["None", "None", "ConditionalCheckFailed"]))
      .resolves({});

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(200);
    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
    expect(dynamoMock.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it("retries a throttled document write instead of returning 409", async () => {
    dynamoMock
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled(["ThrottlingError", "None", "None"]))
      .resolves({});

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(200);
    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });

  it("asks the client to retry after repeated uploadSeq conflicts", async () => {
    dynamoMock
      .on(TransactWriteCommand)
      .rejects(cancelled(["None", "None", "ConditionalCheckFailed"]));

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(429);
    expect(JSON.parse(response.body!).code).toBe("PROCESSING_LIMIT");
    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(3);
    expect(createPresignedPost).not.toHaveBeenCalled();
  });

  it("keeps the 409 when the same file is already being uploaded", async () => {
    dynamoMock
      .on(TransactWriteCommand)
      .rejects(cancelled(["ConditionalCheckFailed", "None", "None"]));

    const response = await handler(
      jsonApiEvent({ filename: "paper.pdf", mimeType: "application/pdf" }),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body!).error).toBe("Document is being uploaded");
    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });
});

function cancelled(codes: string[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: "Transaction cancelled",
    $metadata: {},
    CancellationReasons: codes.map((code) => ({ Code: code })),
  });
}
