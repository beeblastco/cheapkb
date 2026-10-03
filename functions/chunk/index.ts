import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
} from "aws-lambda";
import { decode, encode } from "gpt-tokenizer";
import {
  ContentError,
  dynamo,
  getDocument,
  recordStageError,
  setDocumentStatus,
} from "../utils";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const PipelineQueueUrl = process.env.PIPELINE_QUEUE_URL!;
const CHUNK_WRITE_CONCURRENCY = 10;

/** Chunk stage entry, called by the pipeline router with chunk records. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    let body: { documentId?: string; parsedKey?: string; sweeps?: number };
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
      await chunkDocument(documentId, parsedKey, attempt);
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

/** Splits a parsed document into chunks, stores them and queues embedding. */
async function chunkDocument(
  documentId: string,
  parsedKey: string,
  attempt: number,
): Promise<void> {
  const now = new Date().toISOString();
  await setDocumentStatus(documentId, TableName, "CHUNKING", now, false);

  const doc = await getDocument(documentId, dynamo, TableName);
  if (!doc?.userId) throw new Error("Document owner is missing");
  const title = doc.title ?? null;
  const tags = doc.tags ?? null;
  const authors = doc.authors ?? null;
  const year = doc.year ?? null;
  const { mimeType, sourceKey, userId } = doc;

  const resp = await s3.send(
    new GetObjectCommand({ Bucket: StorageBucketName, Key: parsedKey }),
  );
  const parsed = JSON.parse(await resp.Body!.transformToString());
  if (parsed.modality === "image") {
    const chunkId = `image_${documentId}_0`;
    const s3ChunkKey = `chunks/${documentId}/${chunkId}.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: StorageBucketName,
        Key: s3ChunkKey,
        Body: JSON.stringify({
          documentId: documentId,
          userId: userId,
          chunkId: chunkId,
          modality: "image",
          sourceKey: parsed.sourceKey ?? sourceKey,
          mimeType: parsed.mimeType ?? mimeType,
          title: title,
          tags: tags,
          authors: authors,
          year: year,
          pageStart: 1,
          pageEnd: 1,
        }),
        ContentType: "application/json",
      }),
    );
    const queued = await putChunkRecord(
      {
        pk: `DOC#${documentId}`,
        sk: `CHUNK#${chunkId}`,
        chunkId: chunkId,
        s3ChunkKey: s3ChunkKey,
        pageStart: 1,
        pageEnd: 1,
        status: "QUEUED",
        createdAt: now,
      },
      attempt,
    );
    await finishChunking(documentId, 1, queued ? [s3ChunkKey] : [], now);
    console.log(`[chunk] OK: ${documentId} - image -> ${s3ChunkKey}`);
    return;
  }
  const { pages }: { pages: Array<{ pageNumber: number; text: string }> } =
    parsed;

  const maxTokens = parseInt(process.env.CHUNK_MAX_TOKENS ?? "700", 10);
  const overlapTokens = parseInt(process.env.CHUNK_OVERLAP_TOKENS ?? "100", 10);
  const maxChunks = parseInt(process.env.MAX_CHUNKS_PER_DOCUMENT ?? "1000", 10);

  const chunks = splitIntoChunks(pages, maxTokens, overlapTokens, maxChunks);
  if (chunks.length === 0) {
    await setDocumentStatus(documentId, TableName, "CHUNKED", now, true);
    return;
  }

  // Chunks are written a few at a time so a 1,000-chunk document fits the
  // Lambda timeout.
  const chunkKeys: string[] = [];
  for (let start = 0; start < chunks.length; start += CHUNK_WRITE_CONCURRENCY) {
    const written = await Promise.all(
      chunks
        .slice(start, start + CHUNK_WRITE_CONCURRENCY)
        .map(async ({ chunk, i }) => {
          const chunkId = `chunk_${documentId}_${i}`;
          const s3ChunkKey = `chunks/${documentId}/${chunkId}.json`;
          const tokenCount = encode(chunk.text, {
            disallowedSpecial: new Set(),
          }).length;
          await s3.send(
            new PutObjectCommand({
              Bucket: StorageBucketName,
              Key: s3ChunkKey,
              Body: JSON.stringify({
                documentId: documentId,
                userId: userId,
                chunkId: chunkId,
                modality: "text",
                sourceKey: sourceKey,
                mimeType: mimeType,
                text: chunk.text,
                tokenCount: tokenCount,
                title: title,
                tags: tags,
                authors: authors,
                year: year,
                pageStart: chunk.pageStart,
                pageEnd: chunk.pageEnd,
              }),
              ContentType: "application/json",
            }),
          );
          const queued = await putChunkRecord(
            {
              pk: `DOC#${documentId}`,
              sk: `CHUNK#${chunkId}`,
              chunkId: chunkId,
              s3ChunkKey: s3ChunkKey,
              pageStart: chunk.pageStart,
              pageEnd: chunk.pageEnd,
              tokenCount: tokenCount,
              status: "QUEUED",
              createdAt: now,
            },
            attempt,
          );
          return queued ? s3ChunkKey : null;
        }),
    );
    for (const key of written) if (key) chunkKeys.push(key);
  }

  await finishChunking(documentId, chunks.length, chunkKeys, now);

  console.log(
    `[chunk] OK: ${documentId} - ${chunks.length} chunks -> ${chunkKeys[0]}`,
  );
}

/** Marks the document CHUNKED and queues one embed message per new chunk. */
async function finishChunking(
  documentId: string,
  chunkCount: number,
  chunkKeys: string[],
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
  if (chunkKeys.length === 0) await markEmbeddedIfDone(documentId, chunkCount);

  const sendSize = 10;
  for (let i = 0; i < chunkKeys.length; i += sendSize) {
    const group = chunkKeys.slice(i, i + sendSize);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: PipelineQueueUrl,
        Entries: group.map((s3ChunkKey, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify({
            stage: "embed",
            documentId: documentId,
            s3ChunkKey: s3ChunkKey,
          }),
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

/** Writes a chunk record, returning false when a redelivery finds it already
 * embedded, so it is not billed twice. A first delivery starts every chunk over. */
async function putChunkRecord(
  item: Record<string, unknown>,
  attempt: number,
): Promise<boolean> {
  try {
    await dynamo.send(
      new PutCommand({
        TableName: TableName,
        Item: item,
        ...(attempt > 1
          ? {
              ConditionExpression:
                "attribute_not_exists(pk) OR #s <> :embedded",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":embedded": "EMBEDDED" },
            }
          : {}),
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

/** Splits page text into overlapping token windows, capped at maxChunks. Windows
 * span pages, and each token remembers its page so the range stays exact. */
function splitIntoChunks(
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
