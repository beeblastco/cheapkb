import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { DocumentType } from "@smithy/types";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  QueryVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import {
  checkRateLimit,
  checkUsageLimit,
  extractUserId,
  recordUsage,
} from "../utils";
import type { QueryResult } from "../types";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const bedrockRoleArn = process.env.BEDROCK_ASSUME_ROLE_ARN;
const bedrockExternalId = process.env.BEDROCK_ASSUME_ROLE_EXTERNAL_ID;
const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
  ...(bedrockRoleArn
    ? {
        credentials: fromTemporaryCredentials({
          clientConfig: { region: process.env.AWS_REGION },
          params: {
            RoleArn: bedrockRoleArn,
            RoleSessionName: "cheapkb-query",
            ...(bedrockExternalId ? { ExternalId: bedrockExternalId } : {}),
          },
        }),
      }
    : {}),
});
const COHERE_EMBEDDING_MODEL = "us.cohere.embed-v4:0";
const FILTER_KEYS = new Set([
  "authors",
  "documentId",
  "mimeType",
  "modality",
  "tags",
  "title",
  "year",
]);
const FILTER_OPERATORS = new Set(["$eq", "$gte", "$lte", "$in"]);
const IMAGE_DATA_URI =
  /^data:(image\/(?:gif|jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

interface QueryBody {
  image?: unknown;
  query?: unknown;
  topK?: unknown;
  filters?: unknown;
}

interface VectorMetadata {
  s3ChunkKey?: string;
  text?: string;
  documentId?: string;
  embeddingModel?: string;
  title?: string;
  pageStart?: number;
  pageEnd?: number;
  sourceKey?: string;
  modality?: "image" | "text";
  mimeType?: string;
  [key: string]: unknown;
}

interface VectorMatch {
  key?: string;
  distance?: number;
  metadata?: VectorMetadata;
}

interface CohereEmbeddingResponse {
  embeddings: number[][] | { float?: number[][] };
}

export async function handler(event: APIGatewayProxyEventV2) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;
  const { allowed: rateAllowed, remaining } = await checkRateLimit(
    userId,
    env("RATE_LIMITS_TABLE_NAME"),
    "QUERY",
    100,
    100,
  );
  if (!rateAllowed) {
    return {
      statusCode: 429,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": String(remaining),
      },
      body: JSON.stringify({ error: "Rate limit exceeded. Try again later." }),
    };
  }
  const { allowed: usageAllowed } = await checkUsageLimit(
    userId,
    env("ACCOUNTS_TABLE_NAME"),
  );
  if (!usageAllowed) {
    return {
      statusCode: 429,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Monthly usage allowance reached. Upgrade to continue.",
      }),
    };
  }

  try {
    if (!event.body) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Request body is required" }),
      };
    }
    let body: QueryBody;
    try {
      body = JSON.parse(event.body) as QueryBody;
    } catch (err) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: `Invalid JSON: ${(err as Error).message}`,
        }),
      };
    }
    const query = typeof body.query === "string" ? body.query : undefined;
    const image = typeof body.image === "string" ? body.image : undefined;
    const topK = typeof body.topK === "number" ? body.topK : 10;
    const filters = body.filters;
    if (!query?.trim() && !image) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Query text or image is required" }),
      };
    }
    if (query && query.length > 4000) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Query must be 4000 characters or fewer",
        }),
      };
    }
    if (image && !isValidImageDataUri(image)) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Image must be a JPEG, PNG, WebP, or GIF data URI up to 5 MB",
        }),
      };
    }
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "TopK must be an integer from 1 to 100",
        }),
      };
    }
    if (
      filters !== undefined &&
      (!filters || typeof filters !== "object" || Array.isArray(filters))
    ) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Filters must be an object" }),
      };
    }

    let vectorFilter: Record<string, DocumentType>;
    try {
      vectorFilter = buildFilter(
        filters as Record<string, unknown> | undefined,
        userId,
      );
    } catch (err) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: (err as Error).message }),
      };
    }
    const queryText = query?.trim() ?? "";
    const queryVector = await embedQuery(queryText, userId, image);
    const searchResponse = await vectors.send(
      new QueryVectorsCommand({
        vectorBucketName: env("VECTOR_BUCKET_NAME"),
        indexName: env("VECTOR_INDEX_NAME"),
        queryVector: { float32: Array.from(queryVector) },
        topK: topK,
        filter: vectorFilter,
        returnMetadata: true,
        returnDistance: true,
      }),
    );
    const matches =
      (searchResponse as unknown as { vectors?: VectorMatch[] }).vectors ?? [];
    const texts = await Promise.all(
      matches.map(async (match) => {
        const metadata = match.metadata ?? {};
        const chunkKey = metadata.s3ChunkKey;
        if (!chunkKey) return "";
        try {
          const resp = await s3.send(
            new GetObjectCommand({
              Bucket: env("STORAGE_BUCKET_NAME"),
              Key: chunkKey,
            }),
          );
          const chunkData = JSON.parse(await resp.Body!.transformToString());
          return chunkData.text ?? "";
        } catch {
          return metadata.text ?? "";
        }
      }),
    );

    const results: QueryResult[] = matches.map((match, i) => {
      const metadata = match.metadata ?? {};
      return {
        documentId: metadata.documentId ?? "",
        chunkId: match.key ?? "",
        score: 1 - (match.distance ?? 0),
        title: metadata.title,
        pageStart: metadata.pageStart,
        pageEnd: metadata.pageEnd,
        modality: metadata.modality,
        mimeType: metadata.mimeType,
        text: texts[i],
        source: {
          bucket: env("STORAGE_BUCKET_NAME"),
          key: metadata.sourceKey ?? `raw/${metadata.documentId}/`,
        },
      };
    });

    await recordUsage(userId, env("ACCOUNTS_TABLE_NAME"), "query", 1);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": String(remaining),
      },
      body: JSON.stringify({
        query: queryText,
        inputModality: image ? (queryText ? "mixed" : "image") : "text",
        topK: topK,
        resultCount: results.length,
        results: results,
      }),
    };
  } catch (err) {
    console.error("[query]", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Query failed" }),
    };
  }
}

export function buildFilter(
  filters: Record<string, unknown> | undefined,
  userId: string,
): Record<string, DocumentType> {
  const result: Record<string, DocumentType> = {
    embeddingModel: embeddingModel(),
    userId,
  };
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (key === "userId") continue;
    if (!FILTER_KEYS.has(key)) {
      throw new Error(
        `Unsupported filter: ${key}. Allowed keys: ${[...FILTER_KEYS].join(", ")}`,
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const op = value as Record<string, unknown>;
      const entries = Object.entries(op);
      if (
        entries.length === 0 ||
        entries.some(
          ([operator, operatorValue]) =>
            !FILTER_OPERATORS.has(operator) ||
            !isValidOperatorValue(operator, operatorValue),
        )
      ) {
        throw new Error(
          `Unsupported operator for filter: ${key}. Allowed operators: ${[...FILTER_OPERATORS].join(", ")}`,
        );
      }
      result[key] = Object.fromEntries(entries) as DocumentType;
    } else {
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(
          `Invalid filter value for: ${key}. Must be a string, number, boolean, or operator object`,
        );
      }
      result[key] = value as DocumentType;
    }
  }
  return result;
}

async function embedQuery(
  text: string,
  userId: string,
  image?: string,
): Promise<number[]> {
  const modality = image ? (text ? "mixed" : "image") : "text";
  const dimension = parseInt(process.env.EMBEDDING_DIMENSION ?? "1024", 10);
  let responseInputTokenCount: number | undefined;
  const command = new InvokeModelCommand({
    modelId: embeddingModel(),
    contentType: "application/json",
    accept: "application/json",
    requestMetadata: JSON.stringify({
      cheapkbEmbeddingModel: embeddingModel(),
      cheapkbInputModality: modality,
      cheapkbOperation: "query",
      cheapkbStage: process.env.DEPLOYMENT_STAGE ?? "unknown",
      cheapkbUsageCategory: "embed",
      cheapkbUserId: userId,
    }),
    trace: "ENABLED",
    body: JSON.stringify(buildEmbeddingRequest(text, image)),
  });
  command.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      const headers = (
        result as typeof result & {
          response?: { headers?: Record<string, string> };
        }
      ).response?.headers;
      const tokenHeader = headers?.["x-amzn-bedrock-input-token-count"];
      const parsed = tokenHeader ? Number.parseInt(tokenHeader, 10) : NaN;
      responseInputTokenCount =
        Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
      return result;
    },
    {
      name: "captureBedrockInputTokens",
      priority: "low",
      step: "deserialize",
    },
  );
  const response = await bedrock.send(command);
  const metadata = response.$metadata as typeof response.$metadata & {
    bedrockInputTokenCount?: number;
  };
  const inputTokenCount =
    responseInputTokenCount ?? metadata.bedrockInputTokenCount;
  if (inputTokenCount) {
    await recordUsage(
      userId,
      env("ACCOUNTS_TABLE_NAME"),
      "embed",
      inputTokenCount,
    );
  } else {
    console.warn("[query] Bedrock response omitted its input token count", {
      requestId: response.$metadata.requestId,
    });
  }
  const payload = JSON.parse(
    new TextDecoder().decode(response.body),
  ) as CohereEmbeddingResponse;
  const embeddings = Array.isArray(payload.embeddings)
    ? payload.embeddings
    : payload.embeddings?.float;
  const embedding = embeddings?.[0];
  if (!embedding || embedding.length !== dimension) {
    throw new Error(`Cohere Embed v4 returned a non-${dimension}D vector`);
  }
  return embedding;
}

function buildEmbeddingRequest(text: string, image?: string) {
  const content: Array<Record<string, unknown>> = [];
  if (text) content.push({ type: "text", text });
  if (image) {
    const parsed = parseImageDataUri(image);
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/${parsed.format};base64,${parsed.base64}`,
      },
    });
  }
  return {
    input_type: "search_query",
    inputs: [{ content }],
    embedding_types: ["float"],
    output_dimension: parseInt(process.env.EMBEDDING_DIMENSION ?? "1024", 10),
    max_tokens: 128000,
    truncate: "RIGHT",
  };
}

function embeddingModel() {
  return process.env.BEDROCK_EMBEDDING_MODEL ?? COHERE_EMBEDDING_MODEL;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function isValidImageDataUri(value: string) {
  try {
    parseImageDataUri(value);
    return true;
  } catch {
    return false;
  }
}

function isValidOperatorValue(operator: string, value: unknown): boolean {
  if (operator === "$gte" || operator === "$lte") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (operator === "$in") {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 100 &&
      value.every(
        (item) =>
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean",
      )
    );
  }
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

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

function parseImageDataUri(value: string) {
  const match = IMAGE_DATA_URI.exec(value);
  if (!match) throw new Error("Invalid image data URI");
  const bytes = Buffer.from(match[2], "base64");
  if (
    bytes.byteLength > 5 * 1024 * 1024 ||
    !matchesImageSignature(bytes, match[1])
  ) {
    throw new Error("Invalid image data URI");
  }
  const format = match[1].replace("image/", "") as
    "gif" | "jpeg" | "png" | "webp";
  return { base64: match[2], format };
}
