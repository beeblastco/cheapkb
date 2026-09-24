import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { extractText, getDocumentProxy } from "unpdf";
import { ContentError } from "../utils";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const PipelineQueueUrl = process.env.PIPELINE_QUEUE_URL!;
const MAX_PDF_PAGES = 2000;
const IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Parse stage entry, called by the pipeline router with parse records. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

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
      console.error(`[parse] Failed for ${documentId}:`, err);
      if (err instanceof ContentError) {
        await handleError(documentId, err, 3);
        continue;
      }
      const attempt = parseInt(
        record.attributes.ApproximateReceiveCount ?? "1",
        10,
      );
      await handleError(documentId, err, attempt);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: batchItemFailures };
}

/** Extracts pages or image metadata from the raw upload and queues chunking. */
async function parseDocument(
  documentId: string,
  sourceKey: string,
  mimeType: string,
) {
  const now = new Date().toISOString();
  await updateStatus(documentId, "PARSING", now);

  const resp = await s3.send(
    new GetObjectCommand({ Bucket: StorageBucketName, Key: sourceKey }),
  );
  const bytes = new Uint8Array(await resp.Body!.transformToByteArray());

  if (IMAGE_MIME_TYPES.has(mimeType)) {
    if (!matchesImageSignature(bytes, mimeType)) {
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

/** Resets the error fields on a document after a stage succeeds. */
async function clearError(documentId: string, now: string) {
  await dynamo.send(
    new UpdateCommand({
      TableName: TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET lastError = :null, retryCount = :zero, failedStep = :null, updatedAt = :t",
      ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":deleting": "DELETING",
        ":null": null,
        ":zero": 0,
        ":t": now,
      },
    }),
  );
}

/** Extracts trimmed non-empty page text from a PDF. The page count is checked
 * first, so a huge PDF fails fast instead of exhausting the Lambda's memory. */
async function extractPdfText(bytes: Uint8Array) {
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
) {
  await updateStatus(documentId, "PARSED", now);
  await clearError(documentId, now);
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

// A deleted document has nothing left to record the error on.
async function handleError(documentId: string, err: unknown, attempt: number) {
  try {
    await writeError(documentId, err, attempt);
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}

/** Sets the document status and its status index keys. */
async function updateStatus(documentId: string, status: string, now: string) {
  await dynamo.send(
    new UpdateCommand({
      TableName: TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":deleting": "DELETING",
        ":s": status,
        ":t": now,
        ":gsi1pk": `STATUS#${status}`,
        ":gsi1sk": now,
      },
    }),
  );
}

/** Records a parse failure, marking the document FAILED on the third attempt. */
async function writeError(documentId: string, err: unknown, attempt: number) {
  const now = new Date().toISOString();
  // Raw SDK messages can name buckets and ARNs, so only content errors are shown.
  const lastError =
    err instanceof ContentError
      ? err.message
      : "Processing failed. Reindex to try again.";

  if (attempt >= 3) {
    await dynamo.send(
      new UpdateCommand({
        TableName: TableName,
        Key: { pk: `DOC#${documentId}`, sk: "META" },
        UpdateExpression:
          "SET #s = :s, lastError = :e, retryCount = :r, failedStep = :f, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
        ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":s": "FAILED",
          ":e": lastError,
          ":r": attempt,
          ":f": "PARSING",
          ":t": now,
          ":gsi1pk": "STATUS#FAILED",
          ":gsi1sk": now,
        },
      }),
    );
    return;
  }

  await dynamo.send(
    new UpdateCommand({
      TableName: TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET lastError = :e, retryCount = :r, failedStep = :f, updatedAt = :t",
      ConditionExpression: "attribute_exists(pk) AND #s <> :deleting",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":deleting": "DELETING",
        ":e": lastError,
        ":r": attempt,
        ":f": "PARSING",
        ":t": now,
      },
    }),
  );
}

/** Checks the leading magic bytes match the declared image MIME type. */
function matchesImageSignature(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mimeType === "image/gif") {
    const signature = new TextDecoder().decode(bytes.slice(0, 6));
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return (
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
    );
  }
  return false;
}
