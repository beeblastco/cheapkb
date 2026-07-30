import type { SQSEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sqsEvent } from "./helpers/events";

vi.mock("../functions/parse/index", () => ({
  handler: vi.fn(async () => ({ batchItemFailures: [] })),
}));
vi.mock("../functions/chunk/index", () => ({
  handler: vi.fn(async () => ({ batchItemFailures: [] })),
}));
vi.mock("../functions/embed/index", () => ({
  handler: vi.fn(async () => ({ batchItemFailures: [] })),
}));

import { handler as chunk } from "../functions/chunk/index";
import { handler as embed } from "../functions/embed/index";
import { handler as parse } from "../functions/parse/index";
import { handler as pipeline } from "../functions/pipeline/index";

function batch(...bodies: Array<[string, string]>): SQSEvent {
  return {
    Records: bodies.flatMap(
      ([messageId, body]) => sqsEvent(messageId, body).Records,
    ),
  };
}

describe("pipeline dispatcher", () => {
  beforeEach(() => {
    vi.mocked(parse).mockClear();
    vi.mocked(chunk).mockClear();
    vi.mocked(embed).mockClear();
  });

  it("routes each record to the handler named by its stage", async () => {
    const result = await pipeline(
      batch(
        ["m1", JSON.stringify({ stage: "parse", documentId: "d1" })],
        ["m2", JSON.stringify({ stage: "chunk", documentId: "d2" })],
        ["m3", JSON.stringify({ stage: "embed", documentId: "d3" })],
      ),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(vi.mocked(parse).mock.calls[0][0].Records[0].messageId).toBe("m1");
    expect(vi.mocked(chunk).mock.calls[0][0].Records[0].messageId).toBe("m2");
    expect(vi.mocked(embed).mock.calls[0][0].Records[0].messageId).toBe("m3");
  });

  it("groups same-stage records into one handler invocation", async () => {
    await pipeline(
      batch(
        ["m1", JSON.stringify({ stage: "embed", documentId: "d1" })],
        ["m2", JSON.stringify({ stage: "embed", documentId: "d2" })],
      ),
    );

    expect(vi.mocked(embed)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(embed).mock.calls[0][0].Records).toHaveLength(2);
  });

  it("fails records with a missing, unknown or unparseable stage", async () => {
    const result = await pipeline(
      batch(
        ["m1", "not-json"],
        ["m2", JSON.stringify({ documentId: "d2" })],
        ["m3", JSON.stringify({ stage: "nope", documentId: "d3" })],
      ),
    );

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "m1" },
      { itemIdentifier: "m2" },
      { itemIdentifier: "m3" },
    ]);
    expect(vi.mocked(parse)).not.toHaveBeenCalled();
  });

  it("propagates partial failures from a stage handler", async () => {
    vi.mocked(chunk).mockResolvedValueOnce({
      batchItemFailures: [{ itemIdentifier: "m2" }],
    });

    const result = await pipeline(
      batch(
        ["m1", JSON.stringify({ stage: "parse", documentId: "d1" })],
        ["m2", JSON.stringify({ stage: "chunk", documentId: "d2" })],
      ),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m2" }]);
  });

  it("isolates a throwing stage so other stages still commit", async () => {
    vi.mocked(embed).mockRejectedValueOnce(new Error("boom"));

    const result = await pipeline(
      batch(
        ["m1", JSON.stringify({ stage: "parse", documentId: "d1" })],
        ["m2", JSON.stringify({ stage: "embed", documentId: "d2" })],
      ),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m2" }]);
    expect(vi.mocked(parse)).toHaveBeenCalledTimes(1);
  });
});
