import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from "aws-lambda";
import { createRemoteJWKSet, jwtVerify } from "jose";

const SHOO_BASE_URL = "https://shoo.dev";
const SHOO_ISSUER = "https://shoo.dev";
const jwks = createRemoteJWKSet(
  new URL("/.well-known/jwks.json", SHOO_BASE_URL),
);

/** API Gateway runs this before every API route and caches the verdict per token.
 * A request without an Authorization header gets a 401 without reaching any Lambda. */
export async function handler(
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerWithContextResult<{ userId: string }>> {
  const authHeader = event.headers?.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:5173";
  try {
    const userId = await verifyShooToken(token, appOrigin);

    return { isAuthorized: true, context: { userId: userId } };
  } catch {
    return { isAuthorized: false, context: { userId: "" } };
  }
}

/** Verifies a Shoo ID token for the app origin and returns its pairwise user id.
 * API Gateway's built-in JWT authorizer only accepts RSA keys and Shoo signs with ES256. */
export async function verifyShooToken(
  idToken: string,
  appOrigin: string,
): Promise<string> {
  // Tokens minted for the local dev server are only accepted outside production.
  const audiences = [
    `origin:${new URL(appOrigin).origin}`,
    ...(process.env.DEPLOYMENT_STAGE === "production"
      ? []
      : ["origin:http://localhost:5173"]),
  ];
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: SHOO_ISSUER,
    audience: audiences,
  });
  if (typeof payload.pairwise_sub !== "string") {
    throw new Error("Shoo token missing pairwise_sub");
  }

  return payload.pairwise_sub;
}
