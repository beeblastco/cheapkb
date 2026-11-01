import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  type CallToolResult,
  createMcpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { z } from "zod";
import { handler as getHandler } from "../admin/get";
import { handler as listHandler } from "../admin/list";
import { handler as queryHandler } from "../query/index";
import { dynamo, hashMcpKey } from "../utils";

const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
// Built once per container; each request gets a fresh server for the user in its authInfo.
const mcp = createMcpHandler(
  ({ authInfo }) => {
    const event = authInfo?.extra?.event as APIGatewayProxyEventV2 | undefined;
    if (!event || !authInfo?.clientId)
      throw new Error("MCP request without a user");

    return createServer(event, authInfo.clientId);
  },
  { responseMode: "json" },
);

/** ANY /mcp: stateless MCP 2026-07-28, plus 2025-era clients, authenticated by the MCP key.
 * Tools run the matching API handler, so search keeps its rate limit and usage charge. */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const authorization = event.headers.authorization ?? "";
  const userId = await verifyMcpKey(
    /^bearer /i.test(authorization) ? authorization.slice(7).trim() : "",
  );
  if (!userId) {
    return {
      statusCode: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer error="invalid_token"',
      },
      body: JSON.stringify({ error: "Invalid or missing MCP key" }),
    };
  }
  // A listen stream never ends, and a buffered Lambda would hold it until timeout.
  if (event.headers["mcp-method"] === "subscriptions/listen") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "subscriptions/listen is not supported" }),
    };
  }

  const response = await mcp.fetch(
    new Request(`https://${event.requestContext.domainName}${event.rawPath}`, {
      method: event.requestContext.http.method,
      headers: Object.entries(event.headers).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, value]],
      ),
      body:
        event.body === undefined
          ? undefined
          : Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8"),
    }),
    {
      authInfo: {
        token: "",
        clientId: userId,
        scopes: [],
        extra: {
          event: {
            ...event,
            headers: { ...event.headers, authorization: undefined },
          },
        },
      },
    },
  );
  const body = await response.text();

  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    body: body,
  };
}

/** Returns the user id a well-formed, current MCP key belongs to, or null.
 * A key is ckb_<base64url user id>.<secret>; a rotated or revoked key no longer matches. */
async function verifyMcpKey(apiKey: string): Promise<string | null> {
  const match = /^ckb_([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{43}$/.exec(apiKey);
  if (!match) return null;
  const userId = Buffer.from(match[1], "base64url").toString();
  const result = await dynamo.send(
    new GetCommand({
      TableName: AccountsTableName,
      Key: { pk: `ACCOUNT#${userId}`, sk: "MCP_KEY" },
    }),
  );

  return result.Item?.keyHash === hashMcpKey(apiKey) ? userId : null;
}

/** Builds the per-request server with the three read-only tools, bound to the key's user. */
function createServer(
  event: APIGatewayProxyEventV2,
  userId: string,
): McpServer {
  const server = new McpServer({ name: "cheapkb", version: "1.0.0" });
  server.registerTool(
    "search",
    {
      title: "Search documents",
      description:
        "Semantic search over the user's cheapkb documents and images. Returns ranked chunks with their text, document id and title.",
      inputSchema: z.object({
        query: z.string().describe("Natural-language search text"),
        topK: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Number of results, 10 by default"),
        filters: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Metadata filters on authors, documentId, mimeType, modality, tags, title or year, e.g. {"tags": {"$in": ["work"]}}',
          ),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      toToolResult(
        await queryHandler(
          withUser(event, userId, {
            body: JSON.stringify(args),
          }),
        ),
      ),
  );
  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description:
        "List every document in the user's cheapkb with its id, title, status, tags and dates.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => toToolResult(await listHandler(withUser(event, userId, {}))),
  );
  server.registerTool(
    "get_document",
    {
      title: "Get document",
      description:
        "Get one cheapkb document's metadata and the status of its chunks.",
      inputSchema: z.object({
        documentId: z.string().describe("Document id"),
      }),
      annotations: READ_ONLY,
    },
    async ({ documentId }) =>
      toToolResult(
        await getHandler(
          withUser(event, userId, { pathParameters: { id: documentId } }),
        ),
      ),
  );

  return server;
}

/** Wraps an API handler response as an MCP tool result, an error for 4xx and 5xx. */
function toToolResult(
  response: APIGatewayProxyStructuredResultV2,
): CallToolResult {
  return {
    content: [{ type: "text", text: response.body ?? "" }],
    isError: (response.statusCode ?? 200) >= 400,
  };
}

/** The incoming event as the API handlers see it behind the Shoo authorizer. */
function withUser(
  event: APIGatewayProxyEventV2,
  userId: string,
  input: Pick<APIGatewayProxyEventV2, "body" | "pathParameters">,
): Parameters<typeof listHandler>[0] {
  return {
    ...event,
    pathParameters: {},
    ...input,
    requestContext: {
      ...event.requestContext,
      authorizer: { lambda: { userId: userId } },
    },
  };
}
