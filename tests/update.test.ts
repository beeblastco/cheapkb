import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  GetVectorsCommand,
  PutVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../functions/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../functions/utils")>()),
  extractUserId: vi.fn().mockResolvedValue({ userId: "owner" }),
}));

import { handler as update } from "../functions/admin/update";
import { apiEvent, jsonApiEvent } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const vectorsMock = mockClient(S3VectorsClient);

function patchEvent(body: unknown, id = "doc-1") {
  return jsonApiEvent(body, { pathParameters: { id } });
}

function rawBodyEvent(body: string, id = "doc-1") {
  return apiEvent({ body, pathParameters: { id } });
}

function embeddedDocument(overrides: Record<string, any> = {}) {
  return {
    Item: {
      pk: "DOC#doc-1",
      sk: "META",
      documentId: "doc-1",
      userId: "owner",
      status: "EMBEDDED",
      tags: ["old"],
      ...overrides,
    },
  };
}

function chunkRecords(count = 1) {
  return {
    Items: Array.from({ length: count }, (_, i) => ({
      pk: "DOC#doc-1",
      sk: `CHUNK#chunk_doc-1_${i}`,
      chunkId: `chunk_doc-1_${i}`,
      s3ChunkKey: `chunks/doc-1/chunk_doc-1_${i}.json`,
    })),
  };
}

function chunkObject(tags: string[] | null = ["old"]) {
  return {
    Body: {
      transformToString: async () =>
        JSON.stringify({
          documentId: "doc-1",
          userId: "owner",
          chunkId: "chunk_doc-1_0",
          text: "chunk body",
          title: "Title",
          tags,
          pageStart: 1,
          pageEnd: 2,
        }),
    } as any,
  };
}

// Mirrors what the embed step actually writes, so the preservation assertions
// below are meaningful rather than testing a stripped-down fixture.
function storedVector(key = "chunk_doc-1_0") {
  return {
    key,
    data: { float32: [0.25, -0.5, 0.75] },
    metadata: {
      documentId: "doc-1",
      userId: "owner",
      chunkId: key,
      title: "Title",
      tags: ["old"],
      authors: ["Ada"],
      year: 2026,
      pageStart: 1,
      pageEnd: 2,
      s3ChunkKey: `chunks/doc-1/${key}.json`,
      text: "chunk body",
      chunkPreview: "chunk bod",
    },
  };
}

describe("PATCH /documents/{id}", () => {
  beforeEach(() => {
    dynamoMock.reset();
    s3Mock.reset();
    vectorsMock.reset();
    dynamoMock.on(GetCommand).resolves(embeddedDocument());
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(QueryCommand).resolves(chunkRecords());
    s3Mock.on(GetObjectCommand).resolves(chunkObject());
    s3Mock.on(PutObjectCommand).resolves({});
    vectorsMock.on(GetVectorsCommand).resolves({ vectors: [storedVector()] });
    vectorsMock.on(PutVectorsCommand).resolves({});
  });

  describe("vector metadata preservation", () => {
    it("replaces only tags and preserves every other metadata field", async () => {
      const response = await update(patchEvent({ tags: ["research"] }));

      expect(response.statusCode).toBe(200);
      const put = vectorsMock.commandCalls(PutVectorsCommand)[0].args[0].input;
      // PutVectors REPLACES metadata rather than merging, so anything not
      // carried over here would be silently destroyed.
      expect(put.vectors![0].metadata).toEqual({
        documentId: "doc-1",
        userId: "owner",
        chunkId: "chunk_doc-1_0",
        title: "Title",
        tags: ["research"],
        authors: ["Ada"],
        year: 2026,
        pageStart: 1,
        pageEnd: 2,
        s3ChunkKey: "chunks/doc-1/chunk_doc-1_0.json",
        text: "chunk body",
        chunkPreview: "chunk bod",
      });
    });

    it("keeps userId so retagged chunks stay visible to their owner's search", async () => {
      await update(patchEvent({ tags: ["research"] }));

      const put = vectorsMock.commandCalls(PutVectorsCommand)[0].args[0].input;
      // Every query filters on userId metadata; losing it would make the
      // document permanently invisible instead of raising an error.
      expect((put.vectors![0].metadata as any).userId).toBe("owner");
    });

    it("re-puts the existing embedding unchanged", async () => {
      await update(patchEvent({ tags: ["research"] }));

      const put = vectorsMock.commandCalls(PutVectorsCommand)[0].args[0].input;
      expect(put.vectors![0].data).toEqual({ float32: [0.25, -0.5, 0.75] });
      expect(put.vectors![0].key).toBe("chunk_doc-1_0");
    });

    it("reads back both data and metadata, or it cannot preserve either", async () => {
      await update(patchEvent({ tags: ["research"] }));

      const get = vectorsMock.commandCalls(GetVectorsCommand)[0].args[0].input;
      expect(get.returnData).toBe(true);
      expect(get.returnMetadata).toBe(true);
    });

    it("drops the tags key entirely when tags are cleared", async () => {
      await update(patchEvent({ tags: [] }));

      const put = vectorsMock.commandCalls(PutVectorsCommand)[0].args[0].input;
      expect(put.vectors![0].metadata).not.toHaveProperty("tags");
      expect((put.vectors![0].metadata as any).userId).toBe("owner");
    });
  });

  describe("propagation to all three stores", () => {
    it("updates the META row", async () => {
      await update(patchEvent({ tags: ["research"] }));

      const call = dynamoMock.commandCalls(UpdateCommand)[1].args[0].input;
      expect(call.Key).toEqual({ pk: "DOC#doc-1", sk: "META" });
      expect(call.ExpressionAttributeValues![":tags"]).toEqual(["research"]);
    });

    it("rewrites the S3 chunk JSON so a later reindex cannot restore old tags", async () => {
      await update(patchEvent({ tags: ["research"] }));

      const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
      expect(put.Key).toBe("chunks/doc-1/chunk_doc-1_0.json");
      const written = JSON.parse(put.Body as string);
      expect(written.tags).toEqual(["research"]);
      // The rest of the chunk payload must survive the rewrite.
      expect(written.text).toBe("chunk body");
      expect(written.userId).toBe("owner");
      expect(written.chunkId).toBe("chunk_doc-1_0");
    });
  });

  describe("batching", () => {
    it("splits vector reads into GetVectors-sized batches of 100", async () => {
      dynamoMock.on(QueryCommand).resolves(chunkRecords(150));
      vectorsMock.on(GetVectorsCommand).resolves({ vectors: [storedVector()] });

      await update(patchEvent({ tags: ["research"] }));

      const calls = vectorsMock.commandCalls(GetVectorsCommand);
      expect(calls).toHaveLength(2);
      expect(calls[0].args[0].input.keys).toHaveLength(100);
      expect(calls[1].args[0].input.keys).toHaveLength(50);
    });

    it("skips chunks that were never embedded", async () => {
      // A chunk with no text is never given a vector, so GetVectors omits it.
      vectorsMock.on(GetVectorsCommand).resolves({ vectors: [] });

      const response = await update(patchEvent({ tags: ["research"] }));

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).updatedVectors).toBe(0);
      expect(vectorsMock.commandCalls(PutVectorsCommand)).toHaveLength(0);
    });
  });

  describe("access control and status guards", () => {
    it("rejects a document owned by someone else", async () => {
      dynamoMock.on(GetCommand).resolves(embeddedDocument({ userId: "other" }));

      const response = await update(patchEvent({ tags: ["research"] }));

      expect(response.statusCode).toBe(403);
      expect(vectorsMock.commandCalls(PutVectorsCommand)).toHaveLength(0);
    });

    it("returns 404 for a missing document", async () => {
      dynamoMock.on(GetCommand).resolves({});

      const response = await update(patchEvent({ tags: ["research"] }));

      expect(response.statusCode).toBe(404);
    });

    it("refuses to edit a document that is mid-pipeline", async () => {
      dynamoMock
        .on(GetCommand)
        .resolves(embeddedDocument({ status: "EMBEDDING" }));

      const response = await update(patchEvent({ tags: ["research"] }));

      expect(response.statusCode).toBe(409);
      // Nothing may be written while the pipeline owns the document.
      expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(vectorsMock.commandCalls(PutVectorsCommand)).toHaveLength(0);
    });

    it("conditions the write on the revision it read, not just the status", async () => {
      dynamoMock
        .on(GetCommand)
        .resolves(embeddedDocument({ updatedAt: "2026-01-01T00:00:00.000Z" }));

      await update(patchEvent({ tags: ["research"] }));

      const call = dynamoMock.commandCalls(UpdateCommand)[0].args[0].input;
      // Status alone would let two concurrent edits both pass and then
      // interleave their S3 and vector writes.
      expect(call.ConditionExpression).toContain("updatedAt = :revision");
      expect(call.ExpressionAttributeValues![":revision"]).toBe(
        "2026-01-01T00:00:00.000Z",
      );
    });

    it("holds an UPDATING lease across propagation and restores the status after", async () => {
      await update(patchEvent({ tags: ["research"] }));

      const [acquire, finalize] = dynamoMock
        .commandCalls(UpdateCommand)
        .map((call) => call.args[0].input);
      // The lease must be taken before any store is touched and carry the
      // displaced status, or a takeover could not restore it.
      expect(acquire.ExpressionAttributeValues![":updating"]).toBe("UPDATING");
      expect(acquire.ExpressionAttributeValues![":restoreTo"]).toBe("EMBEDDED");
      expect(acquire.ExpressionAttributeValues!).not.toHaveProperty(":tags");
      // Tags land only once every store agreed.
      expect(finalize.ExpressionAttributeValues![":restoreTo"]).toBe(
        "EMBEDDED",
      );
      expect(finalize.UpdateExpression).toContain("REMOVE previousStatus");
    });

    it("keeps gsi1pk in step with status through the lease", async () => {
      await update(patchEvent({ tags: ["research"] }));

      const [acquire, finalize] = dynamoMock
        .commandCalls(UpdateCommand)
        .map((call) => call.args[0].input);
      // Every status write in the pipeline mirrors status into gsi1pk. Nothing
      // queries that index yet, so only this test would catch them diverging.
      expect(acquire.ExpressionAttributeValues![":gsi1pk"]).toBe(
        "STATUS#UPDATING",
      );
      expect(finalize.ExpressionAttributeValues![":gsi1pk"]).toBe(
        "STATUS#EMBEDDED",
      );
    });

    it("restores the original status rather than assuming EMBEDDED", async () => {
      dynamoMock
        .on(GetCommand)
        .resolves(embeddedDocument({ status: "FAILED" }));

      await update(patchEvent({ tags: ["research"] }));

      const finalize = dynamoMock.commandCalls(UpdateCommand)[1].args[0].input;
      expect(finalize.ExpressionAttributeValues![":restoreTo"]).toBe("FAILED");
    });

    it("rejects a second edit that reads while the first is propagating", async () => {
      // The loser's read sees UPDATING, which is not editable, so it never
      // reaches the store rewrites the winner is midway through.
      dynamoMock.on(GetCommand).resolves(
        embeddedDocument({
          status: "UPDATING",
          previousStatus: "EMBEDDED",
          updatedAt: new Date().toISOString(),
        }),
      );

      const response = await update(patchEvent({ tags: ["research"] }));

      expect(response.statusCode).toBe(409);
      expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(vectorsMock.commandCalls(PutVectorsCommand)).toHaveLength(0);
    });

    it("takes over a lease abandoned by a dead handler", async () => {
      dynamoMock.on(GetCommand).resolves(
        embeddedDocument({
          status: "UPDATING",
          previousStatus: "EMBEDDED",
          // Older than the TTL, so no live handler can still hold it.
          updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        }),
      );

      const response = await update(patchEvent({ tags: ["research"] }));

      expect(response.statusCode).toBe(200);
      // Restoring UPDATING would strand the document as permanently uneditable.
      const finalize = dynamoMock.commandCalls(UpdateCommand)[1].args[0].input;
      expect(finalize.ExpressionAttributeValues![":restoreTo"]).toBe(
        "EMBEDDED",
      );
    });

    it("releases the lease when propagation fails so the document stays editable", async () => {
      vectorsMock.on(PutVectorsCommand).rejects(new Error("vector store down"));

      await expect(update(patchEvent({ tags: ["research"] }))).rejects.toThrow(
        "vector store down",
      );

      const release = dynamoMock.commandCalls(UpdateCommand)[1].args[0].input;
      expect(release.ExpressionAttributeValues![":restoreTo"]).toBe("EMBEDDED");
      // The row must not advertise tags the vectors never received.
      expect(release.ExpressionAttributeValues!).not.toHaveProperty(":tags");
    });

    it("only releases a lease it still owns", async () => {
      await update(patchEvent({ tags: ["research"] }));

      const [acquire, finalize] = dynamoMock
        .commandCalls(UpdateCommand)
        .map((call) => call.args[0].input);
      // A successor that took over an expired lease is also UPDATING, so
      // matching status alone would let a late handler clobber its edit.
      expect(finalize.ConditionExpression).toContain("updatedAt = :heldSince");
      expect(finalize.ExpressionAttributeValues![":heldSince"]).toBe(
        acquire.ExpressionAttributeValues![":now"],
      );
    });

    it("returns 409 when the pipeline claims the document mid-update", async () => {
      dynamoMock.on(UpdateCommand).rejects(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "conditional request failed",
        }),
      );

      const response = await update(patchEvent({ tags: ["research"] }));

      expect(response.statusCode).toBe(409);
      expect(vectorsMock.commandCalls(PutVectorsCommand)).toHaveLength(0);
    });
  });

  describe("validation", () => {
    it.each(["null", "[]", '"tags"'])(
      "rejects the non-object JSON body %s instead of throwing a 500",
      async (body) => {
        // JSON.parse succeeds for all of these, so reading body.tags off the
        // result would throw and surface as a 500.
        const response = await update(rawBodyEvent(body));

        expect(response.statusCode).toBe(400);
        expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
      },
    );

    it("rejects a missing tags field", async () => {
      const response = await update(patchEvent({}));

      expect(response.statusCode).toBe(400);
      expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it("rejects tags that are not strings", async () => {
      const response = await update(patchEvent({ tags: [1, 2] }));

      expect(response.statusCode).toBe(400);
    });

    it("rejects more than 20 tags", async () => {
      const response = await update(
        patchEvent({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
      );

      expect(response.statusCode).toBe(400);
    });

    it("trims and de-duplicates tags case-insensitively", async () => {
      await update(
        patchEvent({ tags: ["  Research  ", "RESEARCH", "product"] }),
      );

      const call = dynamoMock.commandCalls(UpdateCommand)[1].args[0].input;
      expect(call.ExpressionAttributeValues![":tags"]).toEqual([
        "Research",
        "product",
      ]);
    });
  });
});
