import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The chunker model in proofs/Proofs/Chunker.lean counts one token per character.
vi.mock("gpt-tokenizer", () => ({
  decode: (tokens: number[]): string => String.fromCodePoint(...tokens),
  encode: (text: string): number[] =>
    Array.from(text, (char) => char.codePointAt(0)!),
}));

import { splitIntoChunks } from "../functions/chunk/index";
import { packEmbeddingBatches, truncateUtf8 } from "../functions/embed/index";
import { normalizeTags } from "../functions/admin/update";
import { buildFilter } from "../functions/query/index";
import {
  currentCycle,
  fitFilterableMetadata,
  storageCostNanoUsd,
} from "../functions/utils";

type Scalar = string | number | boolean;
type Filter = [string, "ops" | "scalar", Scalar | Array<[string, unknown]>];

// Vectors come from `lake exe vectors`, which runs the proved Lean models.
function vectors<T>(name: string): T[] {
  return JSON.parse(
    readFileSync(new URL(`../proofs/vectors/${name}.json`, import.meta.url), {
      encoding: "utf8",
    }),
  ) as T[];
}

describe("Lean models agree with the TypeScript", () => {
  it("keeps every source snippet a model stands for", () => {
    for (const { file, text } of vectors<{ file: string; text: string }>(
      "anchors",
    )) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), {
        encoding: "utf8",
      });
      expect(source, `${file} no longer contains: ${text}`).toContain(text);
    }
  });

  it("truncates UTF-8 like Proofs.Truncate", () => {
    for (const { text, maxBytes, expected } of vectors<{
      text: string;
      maxBytes: number;
      expected: string;
    }>("truncate")) {
      expect(truncateUtf8(text, maxBytes)).toBe(expected);
    }
  });

  it("fits filterable metadata like Proofs.Metadata", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const { input, expected } of vectors<{
      input: Record<string, unknown>;
      expected: Record<string, unknown>;
    }>("metadata")) {
      expect(fitFilterableMetadata(input)).toEqual(expected);
    }
  });

  it("splits pages into chunks like Proofs.Chunker", () => {
    for (const {
      pages,
      maxTokens,
      overlapTokens,
      maxChunks,
      expected,
    } of vectors<{
      pages: Array<{ pageNumber: number; text: string }>;
      maxTokens: number;
      overlapTokens: number;
      maxChunks: number;
      expected: {
        chunks?: Array<{ text: string; pageStart: number; pageEnd: number }>;
        error?: string;
      };
    }>("chunker")) {
      const run = (): unknown =>
        splitIntoChunks(pages, maxTokens, overlapTokens, maxChunks).map(
          ({ chunk }) => chunk,
        );
      if (expected.error) {
        expect(run).toThrow(expected.error);
      } else {
        expect(run()).toEqual(expected.chunks);
      }
    }
  });

  it("picks billing cycles like Proofs.Billing", () => {
    for (const { createdAtMs, nowMs, startMs, endMs } of vectors<{
      createdAtMs: number;
      nowMs: number;
      startMs: number;
      endMs: number;
    }>("cycles")) {
      const account = {
        planId: "basic",
        priceMonthlyCents: 0,
        monthlyAllowanceCents: 0,
        storageBytes: 0,
        createdAt: new Date(createdAtMs).toISOString(),
        updatedAt: new Date(createdAtMs).toISOString(),
      };
      expect(currentCycle(account, nowMs)).toEqual({
        startMs: startMs,
        endMs: endMs,
      });
    }
  });

  it("prices stored bytes like the Lean model's IEEE arithmetic", () => {
    for (const { bytes, milliseconds, expected } of vectors<{
      bytes: number;
      milliseconds: number;
      expected: number;
    }>("storage-cost")) {
      expect(storageCostNanoUsd(bytes, milliseconds / 1000)).toBe(expected);
    }
  });

  it("packs Cohere requests like Proofs.Batching", () => {
    process.env.EMBEDDING_DIMENSION = "1024";
    for (const { items, batchSizes } of vectors<{
      items: Array<{ userId: string; text: string; repeat: number }>;
      batchSizes: number[] | null;
    }>("packing")) {
      const work = items.map(({ userId, text, repeat }, index) => ({
        attempt: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        messageId: `m-${index}`,
        metadata: {
          chunkId: `chunk-${index}`,
          documentId: "doc",
          modality: "text" as const,
          userId: userId,
        },
        text: text.repeat(repeat),
      }));
      if (batchSizes === null) {
        expect(() => packEmbeddingBatches(work)).toThrow(
          "One Cohere embedding input exceeds the request limit",
        );
        continue;
      }
      const batches = packEmbeddingBatches(work);
      expect(batches.map((batch) => batch.length)).toEqual(batchSizes);
      expect(batches.flat()).toEqual(work);
    }
  });

  it("isolates every query to its caller like Proofs.QueryFilter", () => {
    for (const { filters, expected } of vectors<{
      filters: Filter[];
      expected: Array<[string, string, unknown]> | { error: true };
    }>("filter")) {
      const input = Object.fromEntries(
        filters.map(([key, kind, value]) => [
          key,
          kind === "ops"
            ? Object.fromEntries(value as Array<[string, unknown]>)
            : value,
        ]),
      );
      const run = (): unknown =>
        (
          buildFilter(input, "user-7").$and as Array<Record<string, object>>
        ).map((condition) => {
          const [[key, operation]] = Object.entries(condition);
          const [[operator, value]] = Object.entries(operation);
          return [key, operator, value];
        });
      if ("error" in expected) {
        expect(run).toThrow();
      } else {
        expect(run()).toEqual(expected);
      }
    }
  });

  it("normalizes tags like Proofs.Tags", () => {
    for (const { tags, expected } of vectors<{
      tags: string[];
      expected: string[] | null;
    }>("tags")) {
      expect(normalizeTags(tags)).toEqual(expected);
    }
  });
});
