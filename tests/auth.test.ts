import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import { errors, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("jose", async (importOriginal) => ({
  errors: (await importOriginal<typeof import("jose")>()).errors,
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: { pairwise_sub: "owner" },
  }),
}));

import { handler, verifyShooToken } from "../functions/authorizer/index";
import { extractUserId } from "../functions/utils";
import { apiEvent } from "./helpers/events";

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

describe("API authorizer", () => {
  it("passes the verified user id to the route", async () => {
    const result = await handler(authorizerEvent("Bearer token"));

    expect(vi.mocked(jwtVerify).mock.lastCall?.[0]).toBe("token");
    expect(result).toEqual({
      isAuthorized: true,
      context: { userId: "owner" },
    });
  });

  it("denies a token that fails verification", async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(
      new errors.JWTExpired("expired", {}),
    );

    const result = await handler(authorizerEvent("Bearer expired"));

    expect(result.isAuthorized).toBe(false);
  });

  it("fails without caching a deny when shoo.dev is unreachable", async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(new errors.JWKSTimeout());

    await expect(handler(authorizerEvent("Bearer token"))).rejects.toThrow();
  });

  it("denies a token without a pairwise user id", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {},
      protectedHeader: { alg: "ES256" },
      key: new Uint8Array(),
    });

    const result = await handler(authorizerEvent("Bearer token"));

    expect(result.isAuthorized).toBe(false);
  });
});

describe("extractUserId", () => {
  it("reads the user id the authorizer verified", () => {
    expect(extractUserId(apiEvent())).toEqual({ userId: "owner" });
  });

  it("rejects a route reached without the authorizer", () => {
    const event = apiEvent();
    const { response } = extractUserId({
      ...event,
      requestContext: {
        ...event.requestContext,
        authorizer: { lambda: { userId: "" } },
      },
    });

    expect(response?.statusCode).toBe(401);
  });
});

function authorizerEvent(
  authorization: string,
): APIGatewayRequestAuthorizerEventV2 {
  const event = apiEvent();

  return {
    version: "2.0",
    type: "REQUEST",
    routeArn: "arn:aws:execute-api:us-east-1:123456789012:api-id/v1/GET/tags",
    identitySource: [authorization],
    routeKey: "GET /tags",
    rawPath: "/tags",
    rawQueryString: "",
    cookies: [],
    headers: { authorization: authorization },
    requestContext: event.requestContext,
  };
}
