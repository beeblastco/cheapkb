import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  listDocumentChunkItems,
  retagDocumentVectors,
} from "../../functions/utils.ts";

// Unit tests mock S3 Vectors, so they cannot prove PutVectors upserts by key and
// replaces metadata. Getting that wrong strips userId and hides the document.

const documentId = process.env.E2E_DOCUMENT_ID!;
const tableName = process.env.E2E_TABLE_NAME!;
const vectorBucketName = process.env.E2E_VECTOR_BUCKET!;
const vectorIndexName = process.env.E2E_VECTOR_INDEX!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const vectors = new S3VectorsClient({});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`ok: ${message}`);
}

async function readVectors(keys: string[]) {
  const response = await vectors.send(
    new GetVectorsCommand({
      vectorBucketName,
      indexName: vectorIndexName,
      keys,
      returnData: true,
      returnMetadata: true,
    }),
  );
  return response.vectors ?? [];
}

const chunkItems = await listDocumentChunkItems(documentId, dynamo, tableName);
assert(chunkItems.length > 0, `found ${chunkItems.length} chunk records`);

const keys = chunkItems
  .map((item) => item.chunkId)
  .filter(Boolean)
  .slice(0, 10);
const before = await readVectors(keys);
assert(before.length > 0, `read ${before.length} vectors before retag`);

const original = before[0];
const originalMetadata = original.metadata as Record<string, any>;
assert(
  originalMetadata.userId === "e2e-ci",
  "vector metadata carries userId before retag",
);

const updated = await retagDocumentVectors(
  chunkItems,
  ["e2e-verify"],
  vectors,
  vectorBucketName,
  vectorIndexName,
);
// Chunks with no text are never embedded, so the count can trail the number of
// chunk records without anything being wrong.
assert(updated > 0, `retagged ${updated} vectors`);

const after = await readVectors(keys);
const retagged = after.find((vector) => vector.key === original.key);
assert(retagged !== undefined, "retagged vector is still retrievable by key");

const metadata = retagged!.metadata as Record<string, any>;
assert(
  JSON.stringify(metadata.tags) === JSON.stringify(["e2e-verify"]),
  `tags were replaced (got ${JSON.stringify(metadata.tags)})`,
);
assert(
  metadata.userId === "e2e-ci",
  "userId survived the metadata replacement",
);
assert(
  metadata.text === originalMetadata.text,
  "non-filterable text survived the metadata replacement",
);
assert(
  metadata.documentId === originalMetadata.documentId,
  "documentId survived the metadata replacement",
);
assert(
  JSON.stringify(retagged!.data) === JSON.stringify(original.data),
  "the embedding is byte-identical after re-put",
);
assert(
  after.length === before.length,
  "re-putting an existing key upserts rather than duplicating",
);

console.log("Retag verification passed");
