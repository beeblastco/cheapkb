import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type {
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
} from "aws-lambda";
import { extractText, getDocumentProxy } from "unpdf";
import {
  ContentError,
  matchesImageSignature,
  recordStageError,
  setDocumentStatus,
} from "../utils";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const PipelineQueueUrl = process.env.PIPELINE_QUEUE_URL!;
const MAX_PDF_PAGES = 2000;
// No real text averages 16 characters per token, so longer text cannot fit the chunk cap.
// Rejecting it here keeps a 50 MB text file from exhausting the chunk stage's memory.
const MAX_CHARS_PER_TOKEN = 16;
const IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Parse stage entry, called by the pipeline router with parse records. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    let body: { documentId?: string; sourceKey?: string; mimeType?: string };
    try {
      body = JSON.parse(record.body);
    } catch {
      console.error("[parse] Invalid JSON in record:", record.messageId);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    const { documentId, sourceKey, mimeType } = body;
    if (!documentId || !sourceKey) {
      console.error("[parse] Missing required fields:", record.messageId);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      await parseDocument(documentId, sourceKey, mimeType ?? "");
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        console.log(`[parse] Document ${documentId} was deleted, dropping`);
        continue;
      }
      const attempt =
        err instanceof ContentError
          ? 3
          : parseInt(record.attributes.ApproximateReceiveCount ?? "1", 10);
      // A failed error write retries only this record, so the records already
      // parsed in this batch are not replayed.
      try {
        await recordStageError(documentId, TableName, "PARSING", err, attempt);
        if (err instanceof ContentError) continue;
      } catch (writeErr) {
        console.error(
          `[parse] Could not record failure for ${documentId}:`,
          writeErr,
        );
      }
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: batchItemFailures };
}

/** Extracts trimmed non-empty page text from a PDF. The page count is checked
 * first, so a huge PDF fails fast instead of exhausting the Lambda's memory. */
async function extractPdfText(
  bytes: Uint8Array,
): Promise<Array<{ pageNumber: number; text: string }>> {
  let text: string[];
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await getDocumentProxy(bytes);
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new ContentError(`PDF exceeds the ${MAX_PDF_PAGES} page limit`);
    }
    ({ text } = await extractText(pdf, { mergePages: false }));
  } catch (err) {
    if (err instanceof ContentError) throw err;
    throw new ContentError(`Could not read PDF: ${(err as Error).message}`);
  } finally {
    // unpdf only frees documents it opened itself.
    await pdf?.loadingTask.destroy();
  }

  return text
    .map((pageText: string, i: number) => ({
      pageNumber: i + 1,
      text: pageText.trim(),
    }))
    .filter((p) => p.text.length > 0);
}

/** Marks the document PARSED and queues its chunk stage message. */
async function finishParsing(
  documentId: string,
  parsedKey: string,
  now: string,
): Promise<void> {
  await setDocumentStatus(documentId, TableName, "PARSED", now, true);
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: PipelineQueueUrl,
      MessageBody: JSON.stringify({
        stage: "chunk",
        documentId: documentId,
        parsedKey: parsedKey,
      }),
    }),
  );
}

/** Extracts pages or image metadata from the raw upload and queues chunking.
 * Uploads are limited to PDF, Markdown, plain text and the image types. */
async function parseDocument(
  documentId: string,
  sourceKey: string,
  mimeType: string,
): Promise<void> {
  const now = new Date().toISOString();
  await setDocumentStatus(documentId, TableName, "PARSING", now, false);

  if (IMAGE_MIME_TYPES.has(mimeType)) {
    // Only the magic bytes are checked here; the embed stage reads the whole image.
    const head = await s3.send(
      new GetObjectCommand({
        Bucket: StorageBucketName,
        Key: sourceKey,
        Range: "bytes=0-15",
      }),
    );
    const headBytes = await head.Body!.transformToByteArray();
    if (!matchesImageSignature(headBytes, mimeType)) {
      throw new ContentError(
        "Image content does not match its declared MIME type",
      );
    }
    const parsedKey = `parsed/${documentId}/v1/image.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: StorageBucketName,
        Key: parsedKey,
        Body: JSON.stringify({
          documentId: documentId,
          parserVersion: "multimodal-v1",
          extractedAt: now,
          modality: "image",
          sourceKey: sourceKey,
          mimeType: mimeType,
          pageCount: 1,
        }),
        ContentType: "application/json",
      }),
    );
    await finishParsing(documentId, parsedKey, now);
    console.log(`[parse] OK: ${documentId} - image -> ${parsedKey}`);
    return;
  }

  const resp = await s3.send(
    new GetObjectCommand({ Bucket: StorageBucketName, Key: sourceKey }),
  );
  const bytes = new Uint8Array(await resp.Body!.transformToByteArray());
  let pages: Array<{ pageNumber: number; text: string }>;
  if (mimeType === "application/pdf") {
    pages = await extractPdfText(bytes);
  } else if (
    mimeType === "text/markdown" ||
    mimeType === "text/plain" ||
    mimeType === "text/html"
  ) {
    pages = [{ pageNumber: 1, text: new TextDecoder().decode(bytes) }];
  } else {
    // Documents stored before the MIME allow-list may be PDFs under another type.
    try {
      pages = await extractPdfText(bytes);
    } catch {
      pages = [{ pageNumber: 1, text: new TextDecoder().decode(bytes) }];
    }
  }

  const hasText = pages.some((p) => p.text && p.text.trim().length > 0);
  if (!hasText) {
    throw new ContentError("Document produced no extractable text");
  }
  const maxChunks = parseInt(process.env.MAX_CHUNKS_PER_DOCUMENT ?? "1000", 10);
  const maxTokens = parseInt(process.env.CHUNK_MAX_TOKENS ?? "700", 10);
  const textLength = pages.reduce((total, page) => total + page.text.length, 0);
  if (textLength > maxChunks * maxTokens * MAX_CHARS_PER_TOKEN) {
    throw new ContentError(`Document exceeds the ${maxChunks} chunk limit`);
  }

  const parsedKey = `parsed/${documentId}/v1/pages.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: StorageBucketName,
      Key: parsedKey,
      Body: JSON.stringify({
        documentId: documentId,
        parserVersion: "unpdf-v1",
        extractedAt: now,
        pageCount: pages.length,
        pages: pages,
      }),
      ContentType: "application/json",
    }),
  );

  await finishParsing(documentId, parsedKey, now);

  console.log(
    `[parse] OK: ${documentId} - ${pages.length} pages -> ${parsedKey}`,
  );
}
