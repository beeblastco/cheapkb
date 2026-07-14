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
import { jsonApiEvent } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const vectorsMock = mockClient(S3VectorsClient);

function patchEvent(body: unknown, id = "doc-1") {
  return jsonApiEvent(body, { pathParameters: { id } });
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

      const call = dynamoMock.commandCalls(UpdateCommand)[0].args[0].input;
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

      const call = dynamoMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(call.ExpressionAttributeValues![":tags"]).toEqual([
        "Research",
        "product",
      ]);
    });
  });
});
