import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { PutVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler as embed } from "../functions/embed/index";
import { handler as parse } from "../functions/parse/index";
import { sqsEvent } from "./helpers/events";

const bedrockMock = mockClient(BedrockRuntimeClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);
const vectorsMock = mockClient(S3VectorsClient);

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
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (String(input.Key).startsWith("chunks/")) {
        return {
          Body: {
            transformToString: async () =>
              JSON.stringify({
                documentId: "doc-1",
                userId: "user-1",
                chunkId: "image_doc-1_0",
                modality: "image",
                sourceKey: "raw/doc-1/photo.png",
                mimeType: "image/png",
                title: "Product photo",
                tags: ["catalog"],
                pageStart: 1,
                pageEnd: 1,
              }),
          } as any,
        };
      }
      return {
        Body: { transformToByteArray: async () => png } as any,
      };
    });
    bedrockMock.on(InvokeModelCommand).resolves({
      $metadata: { bedrockInputTokenCount: 321 } as any,
      body: new TextEncoder().encode(
        JSON.stringify({
          embeddings: { float: [[0.1, 0.2, 0.3]] },
        }),
      ),
    });
    vectorsMock.on(PutVectorsCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(GetCommand).resolves({
      Item: { chunkCount: 1, embeddedCount: 1 },
    });

    const result = await embed(
      sqsEvent(
        "embed-image",
        JSON.stringify({
          documentId: "doc-1",
          s3ChunkKey: "chunks/doc-1/image_doc-1_0.json",
        }),
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
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

  it("batches multiple images into one Cohere request", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (String(input.Key).startsWith("chunks/")) {
        const documentId = String(input.Key).includes("doc-1")
          ? "doc-1"
          : "doc-2";
        return {
          Body: {
            transformToString: async () =>
              JSON.stringify({
                documentId,
                userId: "user-1",
                chunkId: `image_${documentId}_0`,
                modality: "image",
                sourceKey: `raw/${documentId}/photo.png`,
                mimeType: "image/png",
                title: `Photo ${documentId}`,
                pageStart: 1,
                pageEnd: 1,
              }),
          } as any,
        };
      }
      return {
        Body: { transformToByteArray: async () => png } as any,
      };
    });
    bedrockMock.on(InvokeModelCommand).resolves({
      $metadata: { bedrockInputTokenCount: 642 } as any,
      body: new TextEncoder().encode(
        JSON.stringify({
          embeddings: {
            float: [
              [0.1, 0.2, 0.3],
              [0.4, 0.5, 0.6],
            ],
          },
        }),
      ),
    });
    vectorsMock.on(PutVectorsCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    dynamoMock.on(GetCommand).resolves({
      Item: { chunkCount: 1, embeddedCount: 1 },
    });
    const first = sqsEvent(
      "embed-image-1",
      JSON.stringify({
        documentId: "doc-1",
        s3ChunkKey: "chunks/doc-1/image_doc-1_0.json",
      }),
    );
    const second = sqsEvent(
      "embed-image-2",
      JSON.stringify({
        documentId: "doc-2",
        s3ChunkKey: "chunks/doc-2/image_doc-2_0.json",
      }),
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
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () =>
          JSON.stringify({
            documentId: "doc-1",
            userId: "user-1",
            chunkId: "chunk-1",
            modality: "text",
            text: "hello",
            pageStart: 1,
            pageEnd: 1,
          }),
      } as any,
    });
    bedrockMock.on(InvokeModelCommand).resolves({
      $metadata: { bedrockInputTokenCount: 1 } as any,
      body: new TextEncoder().encode(
        JSON.stringify({ embeddings: { float: [[0.1, 0.2, 0.3]] } }),
      ),
    });
    vectorsMock.on(PutVectorsCommand).resolves({});
    dynamoMock.on(TransactWriteCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
    let metadataReads = 0;
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === "CHUNK#chunk-1") {
        return { Item: { status: "EMBEDDED" } };
      }
      metadataReads += 1;
      if (metadataReads === 1) throw new Error("metadata unavailable");
      return { Item: { chunkCount: 1, embeddedCount: 1 } };
    });
    const body = JSON.stringify({
      documentId: "doc-1",
      s3ChunkKey: "chunks/doc-1/chunk-1.json",
    });

    const first = await embed(sqsEvent("embed-1", body, 1));
    const second = await embed(sqsEvent("embed-1", body, 2));

    expect(first.batchItemFailures).toEqual([{ itemIdentifier: "embed-1" }]);
    expect(second.batchItemFailures).toEqual([]);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(1);
    expect(vectorsMock.commandCalls(PutVectorsCommand)).toHaveLength(1);
  });
});
