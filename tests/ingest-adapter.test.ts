import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

// sst.config.ts sets these limits for every function, clamping images to 5 MB.
const usage = vi.hoisted(() => {
  process.env.MAX_UPLOAD_BYTES = "52428800";
  process.env.MAX_IMAGE_UPLOAD_BYTES = "5242880";
  return { checkUsageLimit: vi.fn() };
});
vi.mock("../functions/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../functions/utils")>()),
  checkUsageLimit: usage.checkUsageLimit,
}));

import { handler } from "../functions/s3/ingest-adapter";
import { s3Event } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const vectorsMock = mockClient(S3VectorsClient);
const sqsMock = mockClient(SQSClient);

describe("S3 ingest adapter", () => {
  beforeEach(() => {
    dynamoMock.reset();
    s3Mock.reset();
    vectorsMock.reset();
    sqsMock.reset();
    s3Mock.on(HeadObjectCommand).resolves({});
    usage.checkUsageLimit.mockReset();
    usage.checkUsageLimit.mockResolvedValue({ allowed: true });
  });

  it("queues a valid uploaded object", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "text/plain" },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event());

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("queues a valid image upload", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "image/png", userId: "user-1" },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event("raw/doc-1/photo.png", 1024));

    const message = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    expect(JSON.parse(String(message.MessageBody))).toEqual(
      expect.objectContaining({
        stage: "parse",
        mimeType: "image/png",
      }),
    );
  });

  it("rejects images over the configured five MB limit", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "image/png", userId: "user-1" },
    });
    dynamoMock.on(UpdateCommand).resolves({});

    await handler(s3Event("raw/doc-1/photo.png", 5242881));

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(
      dynamoMock.commandCalls(UpdateCommand).at(-1)?.args[0].input,
    ).toEqual(
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ":s": "FAILED",
        }),
      }),
    );
  });

  it("does not recreate a document deleted before its failure is recorded", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "image/png", userId: "user-1" },
    });
    dynamoMock
      .on(UpdateCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "gone" }),
      );

    await handler(s3Event("raw/doc-1/photo.png", 5242881));

    // Without the condition the update is an upsert and leaves an orphan FAILED row.
    expect(
      dynamoMock.commandCalls(UpdateCommand)[0].args[0].input
        .ConditionExpression,
    ).toBe("attribute_exists(pk) AND #s <> :deleting");
  });

  it("keeps the queued check when a re-ingest does not change the size", async () => {
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === "PROFILE") {
        return {
          Item: { storageBytes: 100, createdAt: new Date().toISOString() },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "UPLOADED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 100,
        },
      };
    });
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event("raw/doc-1/sample.txt", 100));

    // Without it, a delete that lands meanwhile would still get a parse message.
    const charge = dynamoMock
      .commandCalls(TransactWriteCommand)
      .map((call) => call.args[0].input.TransactItems ?? [])
      .find(
        (items) => items[1]?.Update?.ConditionExpression === "#s = :queued",
      );
    expect(charge).toBeDefined();
  });

  it("charges only the source size delta on re-ingest", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk === "ACCOUNT#user-1" && input.Key?.sk === "PROFILE") {
        return {
          Item: {
            pk: "ACCOUNT#user-1",
            sk: "PROFILE",
            planId: "basic",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 100,
            storageBytes: 30,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "UPLOADED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 30,
        },
      };
    });
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event("raw/doc-1/sample.txt", 100));

    const storageUpdate = dynamoMock
      .commandCalls(TransactWriteCommand)
      .map((call) => call.args[0].input.TransactItems?.[0].Update)
      .find((update) => update?.ExpressionAttributeValues?.[":nextBytes"]);
    expect(storageUpdate?.ExpressionAttributeValues?.[":nextBytes"]).toBe(100);
  });

  it("records the document's counted bytes in the storage charge's transaction", async () => {
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === "PROFILE") {
        return {
          Item: { storageBytes: 0, createdAt: new Date().toISOString() },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: { status: "UPLOADED", mimeType: "text/plain", userId: "user-1" },
      };
    });
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event("raw/doc-1/sample.txt", 100));

    // A second write could fail after the charge and leave bytes no document counts.
    const charge = dynamoMock
      .commandCalls(TransactWriteCommand)
      .map((call) => call.args[0].input.TransactItems ?? [])
      .find(
        (items) => items[0]?.Update?.ExpressionAttributeValues?.[":nextBytes"],
      );
    expect(charge?.[1]?.Update?.Key).toEqual({ pk: "DOC#doc-1", sk: "META" });
    expect(charge?.[1]?.Update?.ExpressionAttributeValues?.[":counted"]).toBe(
      100,
    );
    expect(
      dynamoMock
        .commandCalls(UpdateCommand)
        .some(
          (call) =>
            call.args[0].input.UpdateExpression ===
            "SET countedBytes = :counted",
        ),
    ).toBe(false);
  });

  it("rolls back to uploaded when usage accounting fails", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "UPLOADED",
        mimeType: "text/plain",
        userId: "user-1",
      },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock
      .on(TransactWriteCommand)
      .rejectsOnce(new Error("accounting unavailable"));

    await expect(handler(s3Event())).rejects.toThrow("accounting unavailable");

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    const rollbackCall = dynamoMock.commandCalls(UpdateCommand).at(-1);
    expect(rollbackCall?.args[0].input.ExpressionAttributeValues).toEqual(
      expect.objectContaining({ ":uploaded": "UPLOADED" }),
    );
  });

  it("resumes a queued upload after a rollback failure", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk === "ACCOUNT#user-1" && input.Key?.sk === "PROFILE") {
        return {
          Item: {
            pk: "ACCOUNT#user-1",
            sk: "PROFILE",
            planId: "basic",
            priceMonthlyCents: 0,
            monthlyAllowanceCents: 100,
            storageBytes: 20,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "QUEUED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 20,
        },
      };
    });
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event());

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("does not overlap an active queued dispatch", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "QUEUED",
        mimeType: "text/plain",
        userId: "user-1",
        dispatchState: "CLAIMED",
        dispatchLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    await expect(handler(s3Event())).rejects.toThrow(
      "Document dispatch is already in progress",
    );

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("reclaims an expired queued dispatch", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk === "ACCOUNT#user-1" && input.Key?.sk === "PROFILE") {
        return {
          Item: {
            pk: "ACCOUNT#user-1",
            sk: "PROFILE",
            storageBytes: 20,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "QUEUED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 20,
          dispatchState: "CLAIMED",
          dispatchLeaseUntil: new Date(Date.now() - 60_000).toISOString(),
        },
      };
    });
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event());

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("charges the current size of a source overwritten after dispatch", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk === "ACCOUNT#user-1" && input.Key?.sk === "PROFILE") {
        return {
          Item: {
            pk: "ACCOUNT#user-1",
            sk: "PROFILE",
            storageBytes: 1,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "EMBEDDED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 1,
        },
      };
    });
    dynamoMock.on(TransactWriteCommand).resolves({});
    // The event is stale; S3 already holds a newer, larger object.
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1000 });

    await handler(s3Event("raw/doc-1/sample.txt", 1));

    const items =
      dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
        .TransactItems;
    expect(items?.[0].Update?.ExpressionAttributeValues?.[":nextBytes"]).toBe(
      1000,
    );
    expect(items?.[1].Update?.ConditionExpression).toContain(
      "countedBytes = :previous",
    );
    expect(items?.[1].Update?.ExpressionAttributeValues?.[":counted"]).toBe(
      1000,
    );
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("removes an overwrite that would take the account past its storage cap", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === "PROFILE") {
        return {
          Item: {
            storageBytes: 1073741824 - 500,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "EMBEDDED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 1,
        },
      };
    });
    // A settled document's form is re-posted with a larger file.
    s3Mock
      .on(HeadObjectCommand)
      .resolves({ ContentLength: 1000, VersionId: "v-overwrite" });
    s3Mock.on(DeleteObjectCommand).resolves({});

    await handler(s3Event("raw/doc-1/sample.txt", 1000));

    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(
      s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.VersionId,
    ).toBe("v-overwrite");
  });

  it("does not recount a source whose size is already counted", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "EMBEDDED",
        mimeType: "text/plain",
        userId: "user-1",
        countedBytes: 1000,
      },
    });
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1000 });

    await handler(s3Event("raw/doc-1/sample.txt", 1));

    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("does not resend a completed queued dispatch", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "QUEUED",
        mimeType: "text/plain",
        userId: "user-1",
        dispatchState: "SENT",
      },
    });

    await handler(s3Event());

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("does not queue duplicate work after another trigger wins", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "text/plain" },
    });
    dynamoMock
      .on(UpdateCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "race" }),
      );

    await handler(s3Event());

    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("rolls back to uploaded so an S3 retry can enqueue again", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "text/plain" },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).rejects(new Error("SQS unavailable"));

    await expect(handler(s3Event())).rejects.toThrow("SQS unavailable");

    const rollbackCall = dynamoMock.commandCalls(UpdateCommand).at(-1);
    expect(rollbackCall?.args[0].input).toEqual(
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ":uploaded": "UPLOADED",
        }),
      }),
    );
  });

  it("cleans old derived data after S3 confirms a replacement", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "EMBEDDED",
        mimeType: "text/plain",
        replacementToken: "token-1",
        replacementPreviousStatus: "EMBEDDED",
        pendingFilename: "sample.txt",
        pendingTitle: "Replacement",
        pendingTags: null,
        pendingAuthors: null,
        pendingYear: null,
      },
    });
    dynamoMock.on(QueryCommand).resolves({
      Items: [{ pk: "DOC#doc-1", sk: "CHUNK#1", chunkId: "chunk-1" }],
    });
    dynamoMock.on(BatchWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({
      Metadata: { "upload-token": "token-1" },
    });
    s3Mock.on(ListObjectVersionsCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({});
    vectorsMock.on(DeleteVectorsCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event());

    expect(vectorsMock.commandCalls(DeleteVectorsCommand)).toHaveLength(1);
    expect(dynamoMock.commandCalls(BatchWriteCommand)).toHaveLength(1);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    // An older chunk run can still write rows after the delete; reindexedAt makes them stale.
    const promote = dynamoMock
      .commandCalls(UpdateCommand)
      .find((call) =>
        call.args[0].input.UpdateExpression?.includes("filename = :filename"),
      );
    expect(promote?.args[0].input.UpdateExpression).toContain(
      "reindexedAt = :now",
    );
  });

  it("rolls back a replacement that lands after its window instead of wiping data", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "EMBEDDED",
        mimeType: "text/plain",
        replacementToken: "token-1",
        replacementPreviousStatus: "EMBEDDED",
        replacementExpiresAt: new Date(
          Date.now() - 60 * 60 * 1000,
        ).toISOString(),
      },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({
      Metadata: { "upload-token": "token-1" },
    });
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [{ Key: "raw/doc-1/sample.txt", VersionId: "v2" }],
    });
    s3Mock.on(DeleteObjectCommand).resolves({});

    const event = s3Event();
    event.Records[0].eventTime = new Date().toISOString();

    await handler(event);

    expect(vectorsMock.commandCalls(DeleteVectorsCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("replaces a document whose status a stray old-version write changed", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "QUEUED",
        mimeType: "text/plain",
        replacementToken: "token-1",
        replacementPreviousStatus: "FAILED",
        replacementExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
        pendingFilename: "sample.txt",
        pendingTitle: "Replacement",
      },
    });
    dynamoMock.on(QueryCommand).resolves({ Items: [] });
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({
      Metadata: { "upload-token": "token-1" },
    });
    s3Mock.on(ListObjectVersionsCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event());

    const promoted = dynamoMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(promoted.ConditionExpression).toBe(
      "replacementToken = :token AND #s <> :deleting",
    );
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("deletes a late upload whose document no longer exists", async () => {
    dynamoMock.on(GetCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    await handler(s3Event());

    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe(
      "raw/doc-1/sample.txt",
    );
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("reads the document consistently so a fresh upload is never dropped", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "UPLOADED", mimeType: "text/plain" },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event());

    const read = dynamoMock.commandCalls(GetCommand)[0].args[0].input;
    expect(read.Key).toEqual({ pk: "DOC#doc-1", sk: "META" });
    expect(read.ConsistentRead).toBe(true);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("drops a replacement whose row a delete took meanwhile", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "EMBEDDED",
        mimeType: "text/plain",
        replacementToken: "token-1",
        replacementPreviousStatus: "EMBEDDED",
      },
    });
    dynamoMock.on(QueryCommand).resolves({ Items: [] });
    dynamoMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        message: "row is DELETING",
        $metadata: {},
      }),
    );
    s3Mock.on(HeadObjectCommand).resolves({
      Metadata: { "upload-token": "token-1" },
    });
    s3Mock.on(ListObjectVersionsCommand).resolves({});

    await expect(handler(s3Event())).resolves.toBeUndefined();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("drops a replacement event another event already finalized", async () => {
    dynamoMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          status: "EMBEDDED",
          mimeType: "text/plain",
          replacementToken: "token-1",
          replacementPreviousStatus: "EMBEDDED",
        },
      })
      .resolves({ Item: { status: "QUEUED", mimeType: "text/plain" } });
    dynamoMock.on(QueryCommand).resolves({ Items: [] });
    dynamoMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        message: "token changed",
        $metadata: {},
      }),
    );
    s3Mock.on(HeadObjectCommand).resolves({
      Metadata: { "upload-token": "token-1" },
    });
    s3Mock.on(ListObjectVersionsCommand).resolves({});

    await handler(s3Event());

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("deletes an upload that lands while its document is being deleted", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { status: "DELETING", mimeType: "text/plain", userId: "user-1" },
    });
    s3Mock.on(DeleteObjectCommand).resolves({});

    await handler(s3Event());

    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("reverts every version a refused replacement form wrote", async () => {
    usage.checkUsageLimit.mockResolvedValue({ allowed: false });
    dynamoMock.on(GetCommand).resolves({
      Item: {
        status: "EMBEDDED",
        mimeType: "text/plain",
        userId: "user-1",
        countedBytes: 20,
        replacementToken: "token-1",
        replacementPreviousStatus: "EMBEDDED",
      },
    });
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [
        { Key: "raw/doc-1/sample.txt", VersionId: "v3" },
        { Key: "raw/doc-1/sample.txt", VersionId: "v2" },
        { Key: "raw/doc-1/sample.txt", VersionId: "v1" },
      ],
    });
    s3Mock
      .on(HeadObjectCommand)
      .callsFake((input) =>
        input.VersionId === "v1"
          ? { Metadata: {} }
          : { Metadata: { "upload-token": "token-1" } },
      );
    s3Mock.on(DeleteObjectCommand).resolves({});

    await handler(s3Event());

    expect(
      s3Mock
        .commandCalls(DeleteObjectCommand)
        .map((call) => call.args[0].input.VersionId),
    ).toEqual(["v3", "v2"]);
    const recorded = dynamoMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(recorded.UpdateExpression).toBe("SET lastError = :e");
    expect(vectorsMock.commandCalls(DeleteVectorsCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("charges a token-less overwrite while a replacement is pending", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk === "ACCOUNT#user-1" && input.Key?.sk === "PROFILE") {
        return {
          Item: {
            pk: "ACCOUNT#user-1",
            sk: "PROFILE",
            storageBytes: 20,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "EMBEDDED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 20,
          replacementToken: "token-1",
        },
      };
    });
    dynamoMock.on(TransactWriteCommand).resolves({});
    s3Mock
      .on(HeadObjectCommand)
      .resolves({ Metadata: {}, ContentLength: 5000 });

    await handler(s3Event("raw/doc-1/sample.txt", 5000));

    const storageUpdate = dynamoMock
      .commandCalls(TransactWriteCommand)
      .map((call) => call.args[0].input.TransactItems?.[0].Update)
      .find((update) => update?.ExpressionAttributeValues?.[":nextBytes"]);
    expect(storageUpdate?.ExpressionAttributeValues?.[":nextBytes"]).toBe(5000);
    expect(vectorsMock.commandCalls(DeleteVectorsCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("fails and charges a new upload once the monthly allowance is spent", async () => {
    const now = new Date().toISOString();
    usage.checkUsageLimit.mockResolvedValue({ allowed: false });
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk === "ACCOUNT#user-1" && input.Key?.sk === "PROFILE") {
        return {
          Item: {
            pk: "ACCOUNT#user-1",
            sk: "PROFILE",
            storageBytes: 0,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: { status: "UPLOADED", mimeType: "text/plain", userId: "user-1" },
      };
    });
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 50 });

    await handler(s3Event("raw/doc-1/sample.txt", 50));

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    const failure = dynamoMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(failure.ExpressionAttributeValues?.[":s"]).toBe("FAILED");
    expect(failure.ConditionExpression).toBe("#s = :uploaded");
    const storageUpdate = dynamoMock
      .commandCalls(TransactWriteCommand)
      .map((call) => call.args[0].input.TransactItems?.[0].Update)
      .find((update) => update?.ExpressionAttributeValues?.[":nextBytes"]);
    expect(storageUpdate?.ExpressionAttributeValues?.[":nextBytes"]).toBe(50);
  });
  it("refuses a first file that lands after its upload stops counting and would pass the cap", async () => {
    const now = Date.now();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === "PROFILE") {
        return {
          Item: {
            storageBytes: 1073741824 - 10,
            storageCostCycleStart: new Date(now).toISOString(),
            storageCostNano: 0,
            storageCostUpdatedAt: new Date(now).toISOString(),
            createdAt: new Date(now).toISOString(),
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      // The form was issued 20 minutes ago, so the caps no longer count this upload.
      return {
        Item: {
          status: "UPLOADED",
          mimeType: "text/plain",
          userId: "user-1",
          updatedAt: new Date(now - 20 * 60 * 1000).toISOString(),
        },
      };
    });
    dynamoMock.on(UpdateCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    await handler(s3Event("raw/doc-1/sample.txt", 1000));

    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    const failure = dynamoMock
      .commandCalls(UpdateCommand)
      .find(
        (call) =>
          call.args[0].input.ExpressionAttributeValues?.[":s"] === "FAILED",
      );
    // countedBytes 0 makes a retried event recount the source under the cap.
    expect(failure?.args[0].input.ExpressionAttributeValues?.[":zero"]).toBe(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it("charges a first file inside its upload window without the storage cap", async () => {
    const now = Date.now();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === "PROFILE") {
        return {
          Item: {
            storageBytes: 1073741824 - 10,
            storageCostCycleStart: new Date(now).toISOString(),
            storageCostNano: 0,
            storageCostUpdatedAt: new Date(now).toISOString(),
            createdAt: new Date(now).toISOString(),
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "UPLOADED",
          mimeType: "text/plain",
          userId: "user-1",
          updatedAt: new Date(now - 60 * 1000).toISOString(),
        },
      };
    });
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(s3Event("raw/doc-1/sample.txt", 1000));

    // The caps already counted this upload in flight, which bounds the overshoot.
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it("recounts the version under a refused overwrite", async () => {
    const now = new Date().toISOString();
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === "PROFILE") {
        return {
          Item: {
            storageBytes: 1073741824 - 500,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      return {
        Item: {
          status: "EMBEDDED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 1,
        },
      };
    });
    dynamoMock.on(TransactWriteCommand).resolves({});
    // Another event already refused V4 and removed it, so V3 is current again.
    s3Mock
      .on(HeadObjectCommand)
      .resolvesOnce({ ContentLength: 1000, VersionId: "v4" })
      .resolves({ ContentLength: 300, VersionId: "v3" });
    s3Mock.on(DeleteObjectCommand).resolves({});

    await handler(s3Event("raw/doc-1/sample.txt", 1000));

    expect(
      s3Mock
        .commandCalls(DeleteObjectCommand)
        .map((call) => call.args[0].input.VersionId),
    ).toEqual(["v4"]);
    const charge =
      dynamoMock.commandCalls(TransactWriteCommand)[0].args[0].input
        .TransactItems;
    expect(charge?.[1].Update?.ExpressionAttributeValues?.[":counted"]).toBe(
      300,
    );
  });

  it("keeps a failed upload's file when the allowance refuses it inside its window", async () => {
    const now = new Date().toISOString();
    usage.checkUsageLimit.mockResolvedValue({ allowed: false });
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === "PROFILE") {
        return {
          Item: {
            storageBytes: 1073741824 - 10,
            storageCostCycleStart: now,
            storageCostNano: 0,
            storageCostUpdatedAt: now,
            createdAt: now,
          },
        };
      }
      if (input.Key?.pk === "ACCOUNT#user-1") return {};
      // A replacement finalized just before a crash is UPLOADED with its old count.
      return {
        Item: {
          status: "UPLOADED",
          mimeType: "text/plain",
          userId: "user-1",
          countedBytes: 20,
          updatedAt: now,
        },
      };
    });
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    s3Mock
      .on(HeadObjectCommand)
      .resolves({ ContentLength: 5000, VersionId: "new" });

    await handler(s3Event("raw/doc-1/sample.txt", 5000));

    // Only a late file is held to the cap, so the user's new file is not removed.
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });
});
