import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DeleteVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
} from "aws-lambda";
import { decode, encode } from "gpt-tokenizer";
import type { EmbedMessage } from "../types";
import {
  ContentError,
  deleteDocumentChunkRecords,
  dynamo,
  getDocument,
  recordStageError,
  setDocumentStatus,
} from "../utils";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const vectors = new S3VectorsClient({});
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const PipelineQueueUrl = process.env.PIPELINE_QUEUE_URL!;
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;
const CHUNK_WRITE_CONCURRENCY = 10;
// DeleteVectors accepts up to 500 keys per call.
const VECTOR_DELETE_BATCH = 500;

/** Chunk stage entry, called by the pipeline router with chunk records. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    let body: {
      documentId?: string;
      parsedKey?: string;
      reindexedAt?: string;
      sweeps?: number;
    };
    try {
      body = JSON.parse(record.body);
    } catch {
      console.error("[chunk] Invalid JSON in record:", record.messageId);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    const { documentId, parsedKey } = body;
    if (!documentId || !parsedKey) {
      console.error("[chunk] Missing required fields:", record.messageId);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    // A message the sweeper re-queued starts a new receive count, but it is
    // still a redelivery.
    const attempt = Math.max(
      parseInt(record.attributes.ApproximateReceiveCount ?? "1", 10),
      body.sweeps ? 2 : 1,
    );
    try {
      await chunkDocument(documentId, parsedKey, body.reindexedAt);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        console.log(`[chunk] Document ${documentId} was deleted, dropping`);
        continue;
      }
      console.error(`[chunk] Failed for ${documentId}:`, err);
      // A failed error write retries only this record, so the records already
      // chunked in this batch are not replayed.
      try {
        await recordStageError(
          documentId,
          TableName,
          "CHUNKING",
          err,
          err instanceof ContentError ? 3 : attempt,
        );
        if (err instanceof ContentError) continue;
      } catch (writeErr) {
        console.error(
          `[chunk] Could not record failure for ${documentId}:`,
          writeErr,
        );
      }
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: batchItemFailures };
}

/** Splits page text into overlapping token windows, capped at maxChunks. Windows
 * span pages, and each token remembers its page so the range stays exact. */
export function splitIntoChunks(
  pages: Array<{ pageNumber: number; text: string }>,
  maxTokens: number,
  overlapTokens: number,
  maxChunks: number,
): Array<{
  chunk: { text: string; pageStart: number; pageEnd: number };
  i: number;
}> {
  const out: Array<{
    chunk: { text: string; pageStart: number; pageEnd: number };
    i: number;
  }> = [];
  let buffer: number[] = [];
  let bufferPages: number[] = [];
  let fresh = 0;

  /** Emits the buffered tokens as a chunk and keeps the overlap tail. A tail
   * with no new tokens after it was already emitted, so it is skipped. */
  const flush = (): void => {
    if (fresh === 0) return;
    const text = decode(buffer).trim();
    if (text) {
      out.push({
        chunk: {
          text: text,
          pageStart: bufferPages[0],
          pageEnd: bufferPages[bufferPages.length - 1],
        },
        i: out.length,
      });
      if (out.length > maxChunks) {
        throw new ContentError(`Document exceeds the ${maxChunks} chunk limit`);
      }
    }
    const keepFrom = Math.max(0, buffer.length - overlapTokens);
    buffer = buffer.slice(keepFrom);
    bufferPages = bufferPages.slice(keepFrom);
    fresh = 0;
  };

  for (const page of pages) {
    if (!page.text.trim()) continue;
    // The separator belongs to the page before it, so a window that fills on it
    // does not claim a page it has no text from.
    const separatorPage = bufferPages[bufferPages.length - 1];
    const separator =
      separatorPage === undefined
        ? []
        : encode("\n\n", { disallowedSpecial: new Set() });
    const tokens = encode(page.text, { disallowedSpecial: new Set() });
    for (const [index, tok] of [...separator, ...tokens].entries()) {
      buffer.push(tok);
      bufferPages.push(
        index < separator.length ? separatorPage! : page.pageNumber,
      );
      fresh += 1;
      if (buffer.length >= maxTokens) flush();
    }
  }
  flush();

  return out;
}

/** Splits a parsed document into chunk rows and queues one inline embed message
 * per chunk. The parsed file stays the source of truth, so no chunk object is written. */
async function chunkDocument(
  documentId: string,
  parsedKey: string,
  reindexedAt: string | undefined,
): Promise<void> {
  const now = new Date().toISOString();
  await setDocumentStatus(documentId, TableName, "CHUNKING", now, false);
  const doc = await getDocument(documentId, dynamo, TableName);
  const previousCount = doc?.chunkCount ?? 0;
  // A re-parse after a reindex carries no reindexedAt, so META's is used when it has one.
  const resetAt = doc?.reindexedAt ?? reindexedAt;

  const resp = await s3.send(
    new GetObjectCommand({ Bucket: StorageBucketName, Key: parsedKey }),
  );
  const parsed = JSON.parse(await resp.Body!.transformToString());
  if (parsed.modality === "image") {
    const chunkId = `image_${documentId}_0`;
    const queued = await putChunkRecord(
      {
        pk: `DOC#${documentId}`,
        sk: `CHUNK#${chunkId}`,
        chunkId: chunkId,
        pageStart: 1,
        pageEnd: 1,
        status: "QUEUED",
        createdAt: now,
      },
      resetAt,
    );
    const message: EmbedMessage = {
      stage: "embed",
      documentId: documentId,
      chunkId: chunkId,
      createdAt: now,
      modality: "image",
      pageStart: 1,
      pageEnd: 1,
    };
    await finishChunking(documentId, 1, queued ? [message] : [], now);
    console.log(`[chunk] OK: ${documentId} - image -> ${chunkId}`);
    return;
  }
  const { pages }: { pages: Array<{ pageNumber: number; text: string }> } =
    parsed;

  const maxTokens = parseInt(process.env.CHUNK_MAX_TOKENS ?? "700", 10);
  const overlapTokens = parseInt(process.env.CHUNK_OVERLAP_TOKENS ?? "100", 10);
  const maxChunks = parseInt(process.env.MAX_CHUNKS_PER_DOCUMENT ?? "1000", 10);

  const chunks = splitIntoChunks(pages, maxTokens, overlapTokens, maxChunks);
  // A re-chunk that yields fewer chunks must not leave the old tail searchable.
  await removeSurplusChunks(documentId, chunks.length, previousCount);
  if (chunks.length === 0) {
    await setDocumentStatus(documentId, TableName, "CHUNKED", now, true);
    return;
  }

  // Chunks are written a few at a time so a 1,000-chunk document fits the
  // Lambda timeout.
  const messages: EmbedMessage[] = [];
  for (let start = 0; start < chunks.length; start += CHUNK_WRITE_CONCURRENCY) {
    const written = await Promise.all(
      chunks
        .slice(start, start + CHUNK_WRITE_CONCURRENCY)
        .map(async ({ chunk, i }): Promise<EmbedMessage | null> => {
          const chunkId = `chunk_${documentId}_${i}`;
          const tokenCount = encode(chunk.text, {
            disallowedSpecial: new Set(),
          }).length;
          const queued = await putChunkRecord(
            {
              pk: `DOC#${documentId}`,
              sk: `CHUNK#${chunkId}`,
              chunkId: chunkId,
              pageStart: chunk.pageStart,
              pageEnd: chunk.pageEnd,
              tokenCount: tokenCount,
              status: "QUEUED",
              createdAt: now,
            },
            resetAt,
          );
          return queued
            ? {
                stage: "embed",
                documentId: documentId,
                chunkId: chunkId,
                createdAt: now,
                modality: "text",
                text: chunk.text,
                tokenCount: tokenCount,
                pageStart: chunk.pageStart,
                pageEnd: chunk.pageEnd,
              }
            : null;
        }),
    );
    for (const message of written) if (message) messages.push(message);
  }

  await finishChunking(documentId, chunks.length, messages, now);

  console.log(
    `[chunk] OK: ${documentId} - ${chunks.length} chunks, ${messages.length} queued`,
  );
}

/** Marks the document CHUNKED and queues one embed message per new chunk. */
async function finishChunking(
  documentId: string,
  chunkCount: number,
  messages: EmbedMessage[],
  now: string,
): Promise<void> {
  await dynamo.send(
    new UpdateCommand({
      TableName: TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, chunkCount = :c, updatedAt = :t, lastError = :null, retryCount = :zero, failedStep = :null",
      ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":deleting": "DELETING",
        ":s": "CHUNKED",
        ":c": chunkCount,
        ":t": now,
        ":null": null,
        ":zero": 0,
      },
    }),
  );
  if (messages.length === 0) await markEmbeddedIfDone(documentId, chunkCount);

  const sendSize = 10;
  for (let i = 0; i < messages.length; i += sendSize) {
    const group = messages.slice(i, i + sendSize);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: PipelineQueueUrl,
        Entries: group.map((message, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify(message),
        })),
      }),
    );
    if (response.Failed?.length) throw new Error("Failed to queue some chunks");
  }
}

/** Finishes a document whose chunks were all embedded by an earlier delivery,
 * since no embed step will run for it. */
async function markEmbeddedIfDone(
  documentId: string,
  chunkCount: number,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression: "SET #s = :s, updatedAt = :t",
        ConditionExpression:
          "attribute_exists(pk) AND embeddedCount >= :count AND #s <> :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":count": chunkCount,
          ":deleting": "DELETING",
          ":s": "EMBEDDED",
          ":t": now,
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}

/** Writes a chunk record, returning false when it is already embedded and counted, so
 * it is not billed twice. A chunk embedded before the last reindex is started over. SQS
 * can deliver a message twice as a first receive, so every delivery checks. */
async function putChunkRecord(
  item: Record<string, unknown>,
  reindexedAt: string | undefined,
): Promise<boolean> {
  try {
    await dynamo.send(
      new PutCommand({
        TableName: TableName,
        Item: item,
        ConditionExpression: reindexedAt
          ? "attribute_not_exists(pk) OR #s <> :embedded OR createdAt < :reindexedAt"
          : "attribute_not_exists(pk) OR #s <> :embedded",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":embedded": "EMBEDDED",
          ...(reindexedAt ? { ":reindexedAt": reindexedAt } : {}),
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

/** Deletes the vectors and chunk rows past the new chunk count. Chunk ids are
 * positional, so the surplus is every index from chunkCount to previousCount. */
async function removeSurplusChunks(
  documentId: string,
  chunkCount: number,
  previousCount: number,
): Promise<void> {
  if (previousCount <= chunkCount) return;
  const chunkIds = Array.from(
    { length: previousCount - chunkCount },
    (_, offset) => `chunk_${documentId}_${chunkCount + offset}`,
  );
  for (let i = 0; i < chunkIds.length; i += VECTOR_DELETE_BATCH) {
    await vectors.send(
      new DeleteVectorsCommand({
        vectorBucketName: VectorBucketName,
        indexName: VectorIndexName,
        keys: chunkIds.slice(i, i + VECTOR_DELETE_BATCH),
      }),
    );
  }
  await deleteDocumentChunkRecords(
    chunkIds.map((chunkId) => ({
      pk: `DOC#${documentId}`,
      sk: `CHUNK#${chunkId}`,
    })),
    dynamo,
    TableName,
  );
  console.log(
    `[chunk] Removed ${chunkIds.length} surplus chunks of ${documentId}`,
  );
}
