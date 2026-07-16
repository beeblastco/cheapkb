import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  QueryVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { checkRateLimit, extractUserId } from "../utils";
import { checkUsageLimit, recordUsage } from "../billing/usage";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;
const TableName = process.env.TABLE_NAME!;
const StorageBucketName = process.env.STORAGE_BUCKET_NAME!;
const FILTER_KEYS = new Set(["documentId", "title", "tags", "authors", "year"]);
const FILTER_OPERATORS = new Set(["$eq", "$gte", "$lte", "$in"]);

export async function handler(event: any) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const { allowed: rateAllowed, remaining } = await checkRateLimit(
    userId,
    TableName,
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

  const { allowed: usageAllowed } = await checkUsageLimit(userId, TableName);
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
    let body: any;
    try {
      body = JSON.parse(event.body);
    } catch (err) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: `Invalid JSON: ${(err as Error).message}`,
        }),
      };
    }
    const { query, topK = 10, filters } = body;
    if (typeof query !== "string" || !query.trim()) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Query is required" }),
      };
    }
    if (query.length > 4000) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Query must be 4000 characters or fewer",
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

    let vectorFilter: Record<string, any>;
    try {
      vectorFilter = buildFilter(filters, userId);
    } catch (err: any) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: err.message }),
      };
    }
    const queryVector = await embedQuery(query.trim());

    const searchResp = await vectors.send(
      new QueryVectorsCommand({
        vectorBucketName: VectorBucketName,
        indexName: VectorIndexName,
        queryVector: { float32: Array.from(queryVector) },
        topK: topK,
        filter: vectorFilter,
        returnMetadata: true,
        returnDistance: true,
      }),
    );

    const matches = (searchResp as any).vectors ?? [];
    const texts = await Promise.all(
      matches.map(async (match: any) => {
        const metadata = match.metadata ?? {};
        const chunkKey = metadata.s3ChunkKey;
        if (!chunkKey) return "";
        try {
          const resp = await s3.send(
            new GetObjectCommand({
              Bucket: StorageBucketName,
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

    const results = matches.map((match: any, i: number) => {
      const metadata = match.metadata ?? {};
      return {
        documentId: metadata.documentId ?? "",
        chunkId: match.key ?? "",
        score: 1 - (match.distance ?? 0),
        title: metadata.title,
        pageStart: metadata.pageStart,
        pageEnd: metadata.pageEnd,
        text: texts[i],
        source: {
          bucket: StorageBucketName,
          key: `raw/${metadata.documentId}/`,
        },
      };
    });

    await recordUsage(userId, TableName, "query", 1);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": String(remaining),
      },
      body: JSON.stringify({
        query: query,
        topK: topK,
        resultCount: results.length,
        results: results,
      }),
    };
  } catch (err: any) {
    console.error("[query]", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Query failed" }),
    };
  }
}

async function embedQuery(text: string): Promise<number[]> {
  const providerUrl = process.env.EMBEDDING_PROVIDER_URL;
  const model = process.env.EMBEDDING_MODEL;
  if (!providerUrl) throw new Error("EMBEDDING_PROVIDER_URL not set");

  const resp = await fetch(`${providerUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({ model, input: [text] }),
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(
      `Embedding provider error ${resp.status}: ${errText.slice(0, 1000)}`,
    );
  }
  const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

export function buildFilter(
  filters: Record<string, unknown> | undefined,
  userId: string,
): Record<string, any> {
  const result: Record<string, any> = { userId };
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
      result[key] = Object.fromEntries(entries);
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
      result[key] = value;
    }
  }
  return result;
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
