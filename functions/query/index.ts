import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  QueryVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { DocumentType } from "@smithy/types";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { QueryResult } from "../types";
import {
  checkRateLimit,
  checkUsageLimit,
  embeddingDimension,
  embeddingModel,
  extractUserId,
  invokeEmbeddingModel,
  matchesImageSignature,
  recordUsage,
} from "../utils";

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
}

/** API handler for POST /query; embeds the text or image and searches the caller's vectors. */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
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
    const { filters } = body;
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
    const inputModality = image ? (queryText ? "mixed" : "image") : "text";
    const [queryVector] = await invokeEmbeddingModel(
      bedrock,
      buildEmbeddingRequest(queryText, image),
      userId,
      env("ACCOUNTS_TABLE_NAME"),
      "query",
      inputModality,
    );
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
    const matches = searchResponse.vectors ?? [];
    // Vectors carry their full chunk text. Only legacy vectors, cut to 500
    // characters, point at a chunk object that still holds the full text.
    const chunks = await Promise.all(
      matches.map(
        async (match): Promise<{ text: string; sourceKey?: string }> => {
          const metadata = (match.metadata ?? {}) as VectorMetadata;
          if (!metadata.s3ChunkKey) return { text: metadata.text ?? "" };
          try {
            const resp = await s3.send(
              new GetObjectCommand({
                Bucket: env("STORAGE_BUCKET_NAME"),
                Key: metadata.s3ChunkKey,
              }),
            );
            const chunkData = JSON.parse(await resp.Body!.transformToString());
            return {
              text: chunkData.text ?? metadata.text ?? "",
              sourceKey: chunkData.sourceKey,
            };
          } catch {
            return { text: metadata.text ?? "" };
          }
        },
      ),
    );

    const results: QueryResult[] = matches.map((match, i) => {
      const metadata = (match.metadata ?? {}) as VectorMetadata;
      return {
        documentId: metadata.documentId ?? "",
        chunkId: match.key ?? "",
        score: 1 - (match.distance ?? 0),
        title: metadata.title,
        pageStart: metadata.pageStart,
        pageEnd: metadata.pageEnd,
        modality: metadata.modality,
        mimeType: metadata.mimeType,
        text: chunks[i].text,
        source: {
          bucket: env("STORAGE_BUCKET_NAME"),
          key:
            metadata.sourceKey ??
            chunks[i].sourceKey ??
            `raw/${metadata.documentId}/`,
        },
      };
    });

    await recordUsage(userId, env("ACCOUNTS_TABLE_NAME"), "query", 1);
    await recordUsage(
      userId,
      env("ACCOUNTS_TABLE_NAME"),
      "queryResult",
      matches.length,
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": String(remaining),
      },
      body: JSON.stringify({
        query: queryText,
        inputModality: inputModality,
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

/** S3 Vectors rejects a filter with several top-level keys, so every condition
 * goes inside $and. The caller's userId is always replaced with their own. */
export function buildFilter(
  filters: Record<string, unknown> | undefined,
  userId: string,
): Record<string, DocumentType> {
  const conditions: DocumentType[] = [
    { embeddingModel: { $eq: embeddingModel() } },
    { userId: { $eq: userId } },
  ];
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (key === "userId") continue;
    if (!FILTER_KEYS.has(key)) {
      throw new Error(
        `Unsupported filter: ${key}. Allowed keys: ${[...FILTER_KEYS].join(", ")}`,
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
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
      for (const [operator, operatorValue] of entries) {
        conditions.push({
          [key]: { [operator]: operatorValue as DocumentType },
        });
      }
    } else {
      // JSON like 1e999 parses to Infinity, which S3 Vectors rejects with a 500.
      if (
        typeof value !== "string" &&
        !(typeof value === "number" && Number.isFinite(value)) &&
        typeof value !== "boolean"
      ) {
        throw new Error(
          `Invalid filter value for: ${key}. Must be a string, number, boolean, or operator object`,
        );
      }
      conditions.push({ [key]: { $eq: value } });
    }
  }
  return { $and: conditions };
}

/** Builds the Cohere Embed v4 search_query request body for text, image or both.
 * The handler already validated the image data URI, so it is sent as given. */
function buildEmbeddingRequest(
  text: string,
  image: string | undefined,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (text) content.push({ type: "text", text: text });
  if (image) content.push({ type: "image_url", image_url: { url: image } });

  return {
    input_type: "search_query",
    inputs: [{ content: content }],
    embedding_types: ["float"],
    output_dimension: embeddingDimension(),
    max_tokens: 128000,
    truncate: "RIGHT",
  };
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Checks a base64 image data URI is well formed, at most 5 MB, and that its
 * magic bytes match the type it names. */
function isValidImageDataUri(value: string): boolean {
  const match = IMAGE_DATA_URI.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2], "base64");

  return (
    bytes.byteLength <= 5 * 1024 * 1024 &&
    matchesImageSignature(bytes, match[1])
  );
}

/** Checks that a filter operator's value has the type S3 Vectors accepts for it. */
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
          (typeof item === "number" && Number.isFinite(item)) ||
          typeof item === "boolean",
      )
    );
  }
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}
