import { jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: { pairwise_sub: "owner" },
  }),
}));

import { verifyShooToken } from "../functions/utils";

describe("Shoo token audience", () => {
  afterEach(() => {
    delete process.env.DEPLOYMENT_STAGE;
  });

  it("accepts local dev tokens outside production", async () => {
    process.env.DEPLOYMENT_STAGE = "dev";

    await verifyShooToken("token", "https://app.example.com");

    expect(vi.mocked(jwtVerify).mock.lastCall?.[2]?.audience).toEqual([
      "origin:https://app.example.com",
      "origin:http://localhost:5173",
    ]);
  });

  it("accepts only the app origin in production", async () => {
    process.env.DEPLOYMENT_STAGE = "production";

    await verifyShooToken("token", "https://app.example.com");

    expect(vi.mocked(jwtVerify).mock.lastCall?.[2]?.audience).toEqual([
      "origin:https://app.example.com",
    ]);
  });
});
