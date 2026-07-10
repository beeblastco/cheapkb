import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  QueryVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { Resource } from "sst";
import { checkRateLimit, extractUserId } from "../utils";

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});
const VectorBucketName = process.env.VECTOR_BUCKET_NAME!;
const VectorIndexName = process.env.VECTOR_INDEX_NAME!;
const TableName = Resource.Meta.name;

export async function handler(event: any) {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const { allowed, remaining } = await checkRateLimit(userId, TableName, 100, 50);
  if (!allowed) {
    return {
      statusCode: 429,
      headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": String(remaining) },
      body: JSON.stringify({ error: "Rate limit exceeded. Try again later." }),
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
    } catch {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid JSON in request body" }),
      };
    }
    const { query, topK = 10, filters } = body;
    if (!query) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "query is required" }),
      };
    }

    const queryVector = await embedQuery(query);
    const vectorFilter = filters ? buildFilter(filters) : undefined;

    const searchResp = await vectors.send(
      new QueryVectorsCommand({
        vectorBucketName: VectorBucketName,
        indexName: VectorIndexName,
        queryVector: { float32: Array.from(queryVector) },
        topK,
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
              Bucket: Resource.Storage.name,
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
        score: match.distance ?? 0,
        title: metadata.title,
        pageStart: metadata.pageStart,
        pageEnd: metadata.pageEnd,
        text: texts[i],
        source: {
          bucket: Resource.Storage.name,
          key: `raw/${metadata.documentId}/`,
        },
      };
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": String(remaining) },
      body: JSON.stringify({
        query,
        topK,
        resultCount: results.length,
        results,
      }),
    };
  } catch (err: any) {
    console.error("[query]", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message ?? "Internal error" }),
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
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Embedding provider error ${resp.status}: ${errText}`);
  }
  const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

function buildFilter(filters: Record<string, unknown>): any {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const op = value as Record<string, unknown>;
      if ("$eq" in op) result[key] = op.$eq;
      else if ("$gte" in op) result[key] = op.$gte;
      else if ("$lte" in op) result[key] = op.$lte;
      else if ("$in" in op) result[key] = op.$in;
    } else {
      result[key] = value;
    }
  }
  if (Object.keys(result).length === 0) return undefined;
  return result;
}
