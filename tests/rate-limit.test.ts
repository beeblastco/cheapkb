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

  it("peek reports the balance without consuming a token", async () => {
    const { peekRateLimit } = await import("../functions/utils");

    const send = vi.fn().mockResolvedValue({});
    const client = { send } as any;

    const result = await peekRateLimit(
      "user",
      "table",
      "QUERY",
      100,
      100,
      client,
    );

    expect(result).toEqual({ allowed: true, remaining: 100 });
    const writeCall = send.mock.calls.find(([command]) =>
      ["PutCommand", "UpdateCommand"].includes(
        (command as any).constructor?.name,
      ),
    );
    expect(writeCall).toBeUndefined();
  });
});
