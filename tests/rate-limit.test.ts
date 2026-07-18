import { describe, expect, it, vi } from "vitest";

describe("rate limit buckets", () => {
  it("uses an operation-specific key", async () => {
    const { checkRateLimit } = await import("../functions/utils");

    const send = vi.fn().mockResolvedValue({});
    const client = { send } as any;

    await checkRateLimit("user", "table", "QUERY", 100, 100, client);

    const putCall = send.mock.calls.find(
      ([command]) => (command as any).constructor?.name === "PutCommand",
    );
    expect(putCall).toBeDefined();
    expect((putCall![0] as any).input.Item?.sk).toBe("LIMIT#QUERY");
  });
});
