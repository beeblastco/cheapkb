import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { countTokens } from "gpt-tokenizer";
import { Resource } from "sst";

interface Chunk {
  text: string;
  pageStart: number;
  pageEnd: number;
  tokenCount: number;
}

const s3 = new S3Client({});
const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = Resource.Meta.name;

const CHUNK_MAX_TOKENS = Number(process.env.CHUNK_MAX_TOKENS ?? "700");
const CHUNK_OVERLAP_TOKENS = Number(process.env.CHUNK_OVERLAP_TOKENS ?? "100");

export async function handler(event: any) {
  for (const record of event.Records ?? []) {
    let body: any;
    try {
      body = JSON.parse(record.body);
    } catch {
      console.error("[chunk] Invalid JSON in record:", record.messageId);
      throw new Error("Invalid JSON in SQS record");
    }
    const { documentId, parsedKey } = body;
    try {
      await chunkDocument(documentId, parsedKey);
    } catch (err) {
      console.error(`[chunk] Failed for ${documentId}:`, err);
      await updateStatus(documentId, "FAILED");
      throw err;
    }
  }
}

async function chunkDocument(documentId: string, parsedKey: string) {
  const now = new Date().toISOString();
  await updateStatus(documentId, "CHUNKING");

  const resp = await s3.send(
    new GetObjectCommand({ Bucket: Resource.Storage.name, Key: parsedKey }),
  );
  const parsed = JSON.parse(await resp.Body!.transformToString());
  const pages = parsed.pages as Array<{ pageNumber: number; text: string }>;

  const docResp = await dynamo.send(
    new GetCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
    }),
  );
  const doc = docResp.Item ?? {};

  let fullText = "";
  const pageMap: Array<{ start: number; end: number; page: number }> = [];
  for (const page of pages) {
    const text = page.text.trim();
    if (text) {
      const start = fullText.length;
      fullText += text + "\n\n";
      pageMap.push({ start, end: fullText.length, page: page.pageNumber });
    }
  }

  if (fullText.trim().length === 0) {
    console.warn(`[chunk] No text found for ${documentId}`);
    await updateStatus(documentId, "CHUNKED");
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: Resource.Embed.url,
        MessageBody: JSON.stringify({ documentId, chunkKeys: [] }),
      }),
    );
    return;
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_MAX_TOKENS,
    chunkOverlap: CHUNK_OVERLAP_TOKENS,
    lengthFunction: (text: string) => countTokens(text),
    separators: ["\n\n", "\n", ". ", " ", ""],
  });
  const splitTexts = await splitter.splitText(fullText);

  const chunks: Chunk[] = [];
  let searchPos = 0;
  for (const text of splitTexts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const matchLen = Math.min(200, trimmed.length);
    const prefix = trimmed.substring(0, matchLen);
    const start = fullText.indexOf(prefix, searchPos);
    const actualStart = start >= 0 ? start : searchPos;
    const actualEnd = actualStart + trimmed.length;
    chunks.push({
      text: trimmed,
      pageStart: findPage(pageMap, actualStart),
      pageEnd: findPage(pageMap, actualEnd),
      tokenCount: countTokens(trimmed),
    });
    searchPos =
      actualStart + Math.max(1, trimmed.length - CHUNK_OVERLAP_TOKENS * 4);
  }

  const chunkKeys: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkId = `${documentId}#${String(i).padStart(6, "0")}`;
    const chunkKey = `chunks/${documentId}/v1/${String(i).padStart(6, "0")}.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: Resource.Storage.name,
        Key: chunkKey,
        Body: JSON.stringify({
          documentId,
          chunkId,
          index: i,
          text: chunks[i].text,
          pageStart: chunks[i].pageStart,
          pageEnd: chunks[i].pageEnd,
          tokenCount: chunks[i].tokenCount,
          metadata: {
            title: doc.title ?? "",
            authors: doc.authors ?? [],
            year: doc.year ?? null,
            tags: doc.tags ?? [],
          },
        }),
        ContentType: "application/json",
      }),
    );
    await dynamo.send(
      new PutCommand({
        TableName,
        Item: {
          pk: `DOC#${documentId}`,
          sk: `CHUNK#${String(i).padStart(6, "0")}`,
          entityType: "Chunk",
          documentId,
          chunkId,
          s3ChunkKey: chunkKey,
          vectorKey: chunkId,
          pageStart: chunks[i].pageStart,
          pageEnd: chunks[i].pageEnd,
          tokenCount: chunks[i].tokenCount,
          status: "CREATED",
          createdAt: now,
        },
      }),
    );
    chunkKeys.push(chunkKey);
  }

  await updateStatus(documentId, "CHUNKED");
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: Resource.Embed.url,
      MessageBody: JSON.stringify({ documentId, chunkKeys }),
    }),
  );
  console.log(`[chunk] OK: ${documentId} - ${chunks.length} chunks`);
}

function findPage(
  pageMap: Array<{ start: number; end: number; page: number }>,
  charPos: number,
): number {
  for (const entry of pageMap) {
    if (charPos >= entry.start && charPos < entry.end) return entry.page;
  }
  return pageMap.length > 0 ? pageMap[pageMap.length - 1].page : 1;
}

async function updateStatus(documentId: string, status: string) {
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `DOC#${documentId}`, sk: "META" },
      UpdateExpression:
        "SET #s = :s, updatedAt = :t, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": status,
        ":t": now,
        ":gsi1pk": `STATUS#${status}`,
        ":gsi1sk": now,
      },
    }),
  );
}
