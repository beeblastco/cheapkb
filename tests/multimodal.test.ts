import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteVectorsCommand,
  PutVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler as embed } from "../functions/embed/index";
import { handler as parse } from "../functions/parse/index";
import { bedrockEmbeddings, sqsEvent } from "./helpers/events";

const bedrockMock = mockClient(BedrockRuntimeClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);
const vectorsMock = mockClient(S3VectorsClient);

const CHUNKED_AT = "2026-01-01T00:00:00.000Z";

function embedMessage(
  documentId: string,
  chunkId: string,
  fields: Record<string, unknown> = { modality: "text", text: "hello" },
): string {
  return JSON.stringify({
    stage: "embed",
    documentId: documentId,
    chunkId: chunkId,
    createdAt: CHUNKED_AT,
    pageStart: 1,
    pageEnd: 1,
    ...fields,
  });
}

describe("multimodal pipeline", () => {
  beforeEach(() => {
    process.env.ACCOUNTS_TABLE_NAME = "accounts";
    process.env.BEDROCK_EMBEDDING_MODEL = "us.cohere.embed-v4:0";
    process.env.EMBEDDING_DIMENSION = "3";
    process.env.STORAGE_BUCKET_NAME = "storage";
    process.env.TABLE_NAME = "meta";
    process.env.VECTOR_BUCKET_NAME = "vectors";
    process.env.VECTOR_INDEX_NAME = "default";
    bedrockMock.reset();
    dynamoMock.reset();
    s3Mock.reset();
    sqsMock.reset();
    vectorsMock.reset();
  });

  it("validates an image and queues an image manifest for chunking", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => png } as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    const result = await parse(
      sqsEvent(
        "parse-image",
        JSON.stringify({
          documentId: "doc-1",
          sourceKey: "raw/doc-1/photo.png",
          mimeType: "image/png",
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    // Only the magic bytes are read; the embed stage downloads the whole image.
    expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input.Range).toBe(
      "bytes=0-15",
    );
    const manifest = JSON.parse(
      String(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Body),
    );
    expect(manifest).toEqual(
      expect.objectContaining({
        modality: "image",
        mimeType: "image/png",
        sourceKey: "raw/doc-1/photo.png",
      }),
    );
    expect(
      JSON.parse(
        String(
          sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody,
        ),
      ),
    ).toEqual(
      expect.objectContaining({
        stage: "chunk",
        parsedKey: "parsed/doc-1/v1/image.json",
      }),
    );
  });

  it("embeds image bytes with Cohere and keeps searchable metadata", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => png } as any,
    });
    bedrockMock.send.callsFake(bedrockEmbeddings([[0.1, 0.2, 0.3]], 321));
    vectorsMock.on(PutVectorsCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(GetCommand).callsFake((input) =>
      input.Key?.sk === "META"
        ? {
            Item: {
              userId: "user-1",
              title: "Product photo",
              tags: ["catalog"],
              sourceKey: "raw/doc-1/photo.png",
              mimeType: "image/png",
              chunkCount: 1,
              embeddedCount: 1,
            },
          }
        : {},
    );

    const result = await embed(
      sqsEvent(
        "embed-image",
        embedMessage("doc-1", "image_doc-1_0", { modality: "image" }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    // The only S3 read left in embedding is the image itself.
    expect(
      s3Mock
        .commandCalls(GetObjectCommand)
        .map((call) => call.args[0].input.Key),
    ).toEqual(["raw/doc-1/photo.png"]);
    const invocation =
      bedrockMock.commandCalls(InvokeModelCommand)[0].args[0].input;
    const request = JSON.parse(String(invocation.body));
    expect(invocation.modelId).toBe("us.cohere.embed-v4:0");
    expect(invocation.trace).toBe("ENABLED");
    expect(JSON.parse(String(invocation.requestMetadata))).toEqual(
      expect.objectContaining({
        cheapkbOperation: "ingest",
        cheapkbInputModality: "image",
        cheapkbUsageCategory: "embed",
        cheapkbUserId: "user-1",
      }),
    );
    expect(request).toEqual(
      expect.objectContaining({
        input_type: "search_document",
        embedding_types: ["float"],
        output_dimension: 3,
      }),
    );
    expect(request.inputs[0].content).toEqual([
      { type: "text", text: "Product photo\nTags: catalog" },
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        },
      },
    ]);
    const vector =
      vectorsMock.commandCalls(PutVectorsCommand)[0].args[0].input.vectors?.[0];
    expect(vector?.metadata).toEqual(
      expect.objectContaining({
        modality: "image",
        mimeType: "image/png",
        sourceKey: "raw/doc-1/photo.png",
      }),
    );
    const usage = dynamoMock
      .commandCalls(UpdateCommand)
      .find((call) => call.args[0].input.TableName === "accounts");
    expect(usage?.args[0].input.ExpressionAttributeValues?.[":u"]).toBe(321);
  });

  it("embeds inline text chunks with document fields from one META read", async () => {
    bedrockMock.send.callsFake(
      bedrockEmbeddings(
        [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
        4,
      ),
    );
    vectorsMock.on(PutVectorsCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(GetCommand).callsFake((input) =>
      input.Key?.sk === "META"
        ? {
            Item: {
              userId: "user-1",
              title: "Report",
              tags: ["finance"],
              sourceKey: "raw/doc-1/report.pdf",
              mimeType: "application/pdf",
            },
          }
        : {},
    );
    const first = sqsEvent(
      "embed-text-1",
      embedMessage("doc-1", "chunk_doc-1_0", {
        modality: "text",
        text: "First chunk",
        tokenCount: 2,
      }),
    );
    const second = sqsEvent(
      "embed-text-2",
      embedMessage("doc-1", "chunk_doc-1_1", {
        modality: "text",
        text: "Second chunk",
        tokenCount: 2,
      }),
    );

    const result = await embed({
      Records: [...first.Records, ...second.Records],
    });

    expect(result.batchItemFailures).toEqual([]);
    expect(s3Mock.calls()).toHaveLength(0);
    const metaReads = dynamoMock
      .commandCalls(GetCommand)
      .filter((call) => call.args[0].input.Key?.sk === "META");
    // One read for the document fields, one strong read to settle the status.
    expect(metaReads).toHaveLength(2);
    const written =
      vectorsMock.commandCalls(PutVectorsCommand)[0].args[0].input.vectors;
    expect(written?.map((vector) => vector.metadata)).toEqual([
      expect.objectContaining({
        text: "First chunk",
        chunkPreview: "First chunk",
        title: "Report",
        tags: ["finance"],
        sourceKey: "raw/doc-1/report.pdf",
      }),
      expect.objectContaining({ text: "Second chunk" }),
    ]);
    expect(written?.[0].metadata).not.toHaveProperty("s3ChunkKey");
  });

  it("stores the full chunk text in vector metadata up to 32 KB", async () => {
    // Each character is 3 bytes, so the cut must back off to a whole character.
    const text = "報".repeat(20_000);
    bedrockMock.send.callsFake(bedrockEmbeddings([[0.1, 0.2, 0.3]], 1));
    vectorsMock.on(PutVectorsCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(GetCommand).resolves({ Item: { userId: "user-1" } });

    await embed(
      sqsEvent(
        "embed-long",
        embedMessage("doc-1", "chunk_doc-1_0", {
          modality: "text",
          text: text,
          tokenCount: 20_000,
        }),
      ),
    );

    const metadata = vectorsMock.commandCalls(PutVectorsCommand)[0].args[0]
      .input.vectors?.[0].metadata as Record<string, string>;
    expect(metadata.text).toBe("報".repeat(Math.floor((32 * 1024) / 3)));
    expect(Buffer.byteLength(metadata.text)).toBeLessThanOrEqual(32 * 1024);
    expect(metadata.chunkPreview).toBe("報".repeat(200));
  });

  it("batches multiple images into one Cohere request", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => png } as any,
    });
    bedrockMock.send.callsFake(
      bedrockEmbeddings(
        [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
        642,
      ),
    );
    vectorsMock.on(PutVectorsCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk !== "META") return {};
      const documentId = String(input.Key.pk).replace("DOC#", "");
      return {
        Item: {
          userId: "user-1",
          title: `Photo ${documentId}`,
          sourceKey: `raw/${documentId}/photo.png`,
          mimeType: "image/png",
          chunkCount: 1,
          embeddedCount: 1,
        },
      };
    });
    const first = sqsEvent(
      "embed-image-1",
      embedMessage("doc-1", "image_doc-1_0", { modality: "image" }),
    );
    const second = sqsEvent(
      "embed-image-2",
      embedMessage("doc-2", "image_doc-2_0", { modality: "image" }),
    );

    const result = await embed({
      Records: [...first.Records, ...second.Records],
    });

    expect(result.batchItemFailures).toEqual([]);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(1);
    const request = JSON.parse(
      String(
        bedrockMock.commandCalls(InvokeModelCommand)[0].args[0].input.body,
      ),
    );
    expect(request.inputs).toHaveLength(2);
    expect(
      request.inputs.every((input: { content: Array<{ type: string }> }) =>
        input.content.some((part) => part.type === "image_url"),
      ),
    ).toBe(true);
    expect(
      vectorsMock.commandCalls(PutVectorsCommand)[0].args[0].input.vectors,
    ).toHaveLength(2);
  });

  it("repairs document status on retry without embedding an accounted chunk again", async () => {
    bedrockMock.send.callsFake(bedrockEmbeddings([[0.1, 0.2, 0.3]], 1));
    vectorsMock.on(PutVectorsCommand).resolves({});
    let chunkStatus = "QUEUED";
    dynamoMock.on(TransactWriteCommand).callsFake(() => {
      chunkStatus = "EMBEDDED";
      return {};
    });
    dynamoMock.on(UpdateCommand).callsFake((input) => {
      if (input.Key?.sk === "CHUNK#chunk-1" && chunkStatus === "EMBEDDED") {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "embedded",
          Item: { createdAt: { S: CHUNKED_AT }, status: { S: "EMBEDDED" } },
        });
      }
      return {};
    });
    let metadataReads = 0;
    dynamoMock.on(GetCommand).callsFake(() => {
      metadataReads += 1;
      // The read that settles the document fails after the chunk was embedded.
      if (metadataReads === 2) throw new Error("metadata unavailable");
      return { Item: { userId: "user-1", chunkCount: 1, embeddedCount: 1 } };
    });
    const body = embedMessage("doc-1", "chunk-1");

    const first = await embed(sqsEvent("embed-1", body, 1));
    const second = await embed(sqsEvent("embed-1", body, 2));

    expect(first.batchItemFailures).toEqual([{ itemIdentifier: "embed-1" }]);
    expect(second.batchItemFailures).toEqual([]);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(1);
    expect(vectorsMock.commandCalls(PutVectorsCommand)).toHaveLength(1);
  });

  it("reads the embedded count strongly before marking the document EMBEDDED", async () => {
    bedrockMock.send.callsFake(bedrockEmbeddings([[0.1, 0.2, 0.3]], 1));
    vectorsMock.on(PutVectorsCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(GetCommand).resolves({
      Item: { userId: "user-1", chunkCount: 1, embeddedCount: 1 },
    });

    await embed(sqsEvent("embed-strong", embedMessage("doc-1", "chunk-1")));

    const metaReads = dynamoMock
      .commandCalls(GetCommand)
      .filter((call) => call.args[0].input.Key?.sk === "META");
    expect(metaReads).toHaveLength(2);
    expect(metaReads[1].args[0].input.ConsistentRead).toBe(true);
  });

  it("keeps filterable vector metadata under 2 KB for the largest inputs", async () => {
    const long = (char: string, length: number): string => char.repeat(length);
    bedrockMock.send.callsFake(bedrockEmbeddings([[0.1, 0.2, 0.3]], 1));
    vectorsMock.on(PutVectorsCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(GetCommand).callsFake((input) =>
      input.Key?.sk === "META"
        ? {
            Item: {
              userId: "user-1",
              title: long("t", 200),
              tags: Array.from(
                { length: 20 },
                (_, i) => `${i}${long("g", 99)}`,
              ),
              authors: Array.from({ length: 20 }, () => long("a", 100)),
              year: 2024,
              mimeType: "application/pdf",
              sourceKey: `raw/doc-1/${long("f", 255)}`,
            },
          }
        : {},
    );

    await embed(sqsEvent("embed-large", embedMessage("doc-1", "chunk-1")));

    const metadata = vectorsMock.commandCalls(PutVectorsCommand)[0].args[0]
      .input.vectors?.[0].metadata as Record<string, unknown>;
    const filterable = {
      ...metadata,
      chunkPreview: undefined,
      s3ChunkKey: undefined,
      text: undefined,
    };
    expect(Buffer.byteLength(JSON.stringify(filterable))).toBeLessThanOrEqual(
      2048,
    );
    expect(metadata).toEqual(
      expect.objectContaining({
        documentId: "doc-1",
        userId: "user-1",
        embeddingModel: "us.cohere.embed-v4:0",
        title: long("t", 200),
        year: 2024,
        text: "hello",
        // The file link is kept before the long fields are trimmed.
        sourceKey: `raw/doc-1/${long("f", 255)}`,
      }),
    );
    // Tags are kept in order until the budget runs out.
    expect((metadata.tags as string[])[0]).toBe(`0${long("g", 99)}`);
  });

  it.each([
    [
      "already embedded",
      { createdAt: { S: CHUNKED_AT }, status: { S: "EMBEDDED" } },
      true,
    ],
    [
      "claimed by another delivery",
      {
        createdAt: { S: CHUNKED_AT },
        status: { S: "QUEUED" },
        embedClaimedAt: { N: String(Date.now()) },
      },
      false,
    ],
    [
      "re-chunked since the message was sent",
      { createdAt: { S: "2026-02-01T00:00:00.000Z" }, status: { S: "QUEUED" } },
      false,
    ],
    ["gone", undefined, false],
  ])(
    "drops a chunk whose claim finds it %s without calling Bedrock",
    async (_, item, reconciles) => {
      dynamoMock.on(GetCommand).resolves({
        Item: { userId: "user-1", chunkCount: 1, embeddedCount: 1 },
      });
      dynamoMock.on(UpdateCommand).callsFake((input) => {
        if (input.Key?.sk === "META") return {};
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
          Item: item,
        });
      });

      const result = await embed(
        sqsEvent("embed-dup", embedMessage("doc-1", "chunk-1")),
      );

      expect(result.batchItemFailures).toEqual([]);
      expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
      const updates = dynamoMock
        .commandCalls(UpdateCommand)
        .map((call) => call.args[0].input);
      // The failed claim returns the row, so the chunk is never read first.
      expect(updates[0].ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
      expect(
        dynamoMock
          .commandCalls(GetCommand)
          .filter((call) => call.args[0].input.Key?.sk !== "META"),
      ).toHaveLength(0);
      // Only an embedded chunk settles its document, as a retry after a crash would.
      expect(
        updates.some(
          (input) => input.ExpressionAttributeValues?.[":s"] === "EMBEDDED",
        ),
      ).toBe(reconciles);
    },
  );

  it("keeps embedded chunks when recording another chunk's error fails", async () => {
    bedrockMock.send.callsFake(bedrockEmbeddings([[0.1, 0.2, 0.3]], 1));
    vectorsMock.on(PutVectorsCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.pk === "DOC#doc-2") throw new Error("dynamo unavailable");
      return {
        Item: {
          userId: "user-1",
          chunkCount: 1,
          embeddedCount: 1,
          retryCount: 0,
        },
      };
    });
    dynamoMock.on(UpdateCommand).callsFake((input) => {
      if (input.Key?.pk === "DOC#doc-2") throw new Error("dynamo unavailable");
      return {};
    });

    const ok = sqsEvent("embed-ok", embedMessage("doc-1", "chunk-1"));
    const bad = sqsEvent("embed-bad", embedMessage("doc-2", "chunk-2"));

    const result = await embed({ Records: [...ok.Records, ...bad.Records] });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "embed-bad" }]);
    expect(vectorsMock.commandCalls(PutVectorsCommand)).toHaveLength(1);
  });

  it("removes a vector written after its document was deleted", async () => {
    bedrockMock.send.callsFake(bedrockEmbeddings([[0.1, 0.2, 0.3]], 2));
    vectorsMock.on(PutVectorsCommand).resolves({});
    vectorsMock.on(DeleteVectorsCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).callsFake((input) => {
      if (input.TransactItems?.[0]?.Update?.Key?.sk?.startsWith("CHUNK#")) {
        const error = new Error("cancelled");
        error.name = "TransactionCanceledException";
        throw error;
      }
      return {};
    });
    let metadataReads = 0;
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk !== "META") return {};
      metadataReads += 1;
      // The delete lands between loading the chunk and marking it embedded.
      return metadataReads === 1 ? { Item: { userId: "user-1" } } : {};
    });

    const result = await embed(
      sqsEvent(
        "embed-deleted",
        embedMessage("doc-1", "chunk_doc-1_0", {
          modality: "text",
          text: "Deleted text",
          tokenCount: 2,
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(
      vectorsMock.commandCalls(DeleteVectorsCommand)[0].args[0].input.keys,
    ).toEqual(["chunk_doc-1_0"]);
  });

  it("removes a vector whose chunk row a shorter re-chunk deleted", async () => {
    bedrockMock.send.callsFake(bedrockEmbeddings([[0.1, 0.2, 0.3]], 2));
    vectorsMock.on(PutVectorsCommand).resolves({});
    vectorsMock.on(DeleteVectorsCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).callsFake((input) => {
      if (input.TransactItems?.[0]?.Update?.Key?.sk?.startsWith("CHUNK#")) {
        const error = new Error("cancelled");
        error.name = "TransactionCanceledException";
        throw error;
      }
      return {};
    });
    dynamoMock
      .on(GetCommand)
      .callsFake((input) =>
        input.Key?.sk === "META"
          ? { Item: { userId: "user-1", status: "EMBEDDING" } }
          : {},
      );

    const result = await embed(
      sqsEvent(
        "embed-surplus",
        embedMessage("doc-1", "chunk_doc-1_5", {
          modality: "text",
          text: "Surplus text",
          tokenCount: 2,
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(
      vectorsMock.commandCalls(DeleteVectorsCommand)[0].args[0].input.keys,
    ).toEqual(["chunk_doc-1_5"]);
  });

  it("marks a document's chunks EMBEDDED in one transaction", async () => {
    bedrockMock.send.callsFake(
      bedrockEmbeddings(
        [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
        2,
      ),
    );
    vectorsMock.on(PutVectorsCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(GetCommand).resolves({ Item: { userId: "user-1" } });
    const first = sqsEvent("embed-a", embedMessage("doc-1", "chunk_doc-1_0"));
    const second = sqsEvent("embed-b", embedMessage("doc-1", "chunk_doc-1_1"));

    const result = await embed({
      Records: [...first.Records, ...second.Records],
    });

    expect(result.batchItemFailures).toEqual([]);
    const transactions = dynamoMock.commandCalls(TransactWriteCommand);
    expect(transactions).toHaveLength(1);
    const items = transactions[0].args[0].input.TransactItems ?? [];
    expect(items.map((item) => item.Update?.Key?.sk)).toEqual([
      "CHUNK#chunk_doc-1_0",
      "CHUNK#chunk_doc-1_1",
      "META",
    ]);
    expect(items[2].Update?.UpdateExpression).toContain("ADD embeddedCount :n");
    expect(items[2].Update?.ExpressionAttributeValues?.[":n"]).toBe(2);
  });

  it("falls back to one chunk at a time when the batched transaction is cancelled", async () => {
    bedrockMock.send.callsFake(
      bedrockEmbeddings(
        [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
        2,
      ),
    );
    vectorsMock.on(PutVectorsCommand).resolves({});
    vectorsMock.on(DeleteVectorsCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    // chunk_doc-1_0 was embedded by an earlier delivery, which cancels the group.
    dynamoMock.on(TransactWriteCommand).callsFake((input) => {
      const items = input.TransactItems ?? [];
      if (
        items.length > 2 ||
        items[0]?.Update?.Key?.sk === "CHUNK#chunk_doc-1_0"
      ) {
        const error = new Error("cancelled");
        error.name = "TransactionCanceledException";
        throw error;
      }
      return {};
    });
    dynamoMock
      .on(GetCommand)
      .callsFake((input) =>
        input.Key?.sk === "META"
          ? { Item: { userId: "user-1", status: "EMBEDDING" } }
          : { Item: { status: "EMBEDDED" } },
      );
    const first = sqsEvent("embed-a", embedMessage("doc-1", "chunk_doc-1_0"));
    const second = sqsEvent("embed-b", embedMessage("doc-1", "chunk_doc-1_1"));

    const result = await embed({
      Records: [...first.Records, ...second.Records],
    });

    expect(result.batchItemFailures).toEqual([]);
    const transactions = dynamoMock
      .commandCalls(TransactWriteCommand)
      .map((call) => call.args[0].input.TransactItems?.length);
    expect(transactions).toEqual([3, 2, 2]);
    // The already embedded chunk is skipped, and the live document keeps its vectors.
    expect(vectorsMock.commandCalls(DeleteVectorsCommand)).toHaveLength(0);
  });
});
