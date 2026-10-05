import { describe, expect, it, vi } from "vitest";

describe("rate limit buckets", () => {
  it("uses an operation-specific key", async () => {
    const { checkRateLimit } = await import("../functions/utils");

    const send = vi.fn().mockResolvedValue({});
    const client = { send: send } as any;

    await checkRateLimit("user", "table", "QUERY", 100, 100, client);

    const putCall = send.mock.calls.find(
      ([command]) => (command as any).constructor?.name === "PutCommand",
    );
    expect(putCall).toBeDefined();
    expect((putCall![0] as any).input.Item?.sk).toBe("LIMIT#QUERY");
  });
  it("spends a token only if the row is unchanged since it was read", async () => {
    const { checkRateLimit } = await import("../functions/utils");
    const lastRefill = new Date().toISOString();
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { tokens: 1, lastRefill: lastRefill } })
      .mockResolvedValue({});
    const client = { send: send } as any;

    await checkRateLimit("user", "table", "QUERY", 100, 100, client);

    // A write in the same millisecond keeps lastRefill, so only the tokens tell it apart.
    const update = send.mock.calls.find(
      ([command]) => (command as any).constructor?.name === "UpdateCommand",
    );
    expect((update![0] as any).input.ConditionExpression).toBe(
      "lastRefill = :oldLr AND tokens = :oldTokens",
    );
    expect(
      (update![0] as any).input.ExpressionAttributeValues[":oldTokens"],
    ).toBe(1);
  });
});
