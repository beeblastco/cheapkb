import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { handler as mcp } from "../functions/mcp/index";
import { handler as mcpKey } from "../functions/mcp/key";
import { apiEvent } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const MCP_URL = "https://api.example.com/v1/mcp";
const { requestContext } = apiEvent();
const POST_CONTEXT = {
  ...requestContext,
  http: { ...requestContext.http, method: "POST" },
};

describe("MCP", () => {
  beforeEach(() => {
    dynamoMock.reset();
  });

  it("issues a key whose hash, not the key, is stored for the caller", async () => {
    const apiKey = await issueKey();

    const item = dynamoMock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(apiKey).toMatch(/^ckb_/);
    expect(item).toMatchObject({ pk: "ACCOUNT#owner", sk: "MCP_KEY" });
    expect(item.keyHash).not.toBe(apiKey);
  });

  it("rejects a key that does not match the stored hash", async () => {
    dynamoMock.on(GetCommand).resolves({ Item: { keyHash: "rotated" } });

    const response = await lambdaFetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: `Bearer ckb_b3duZXI.${"a".repeat(43)}` },
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
  });

  it("refuses a listen stream a buffered Lambda could only hold until timeout", async () => {
    const apiKey = await issueKey();
    const { keyHash } =
      dynamoMock.commandCalls(PutCommand)[0].args[0].input.Item!;
    dynamoMock.on(GetCommand).resolves({ Item: { keyHash: keyHash } });

    const response = await lambdaFetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "mcp-method": "subscriptions/listen",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(405);
  });

  // Broods pins 2026-07-28 with no initialize fallback; Claude Code and Codex speak 2025-11-25.
  it.each(["2026-07-28", "2025-11-25"])(
    "serves a client pinned to %s and lists the caller's documents",
    async (version) => {
      const apiKey = await issueKey();
      const { keyHash } =
        dynamoMock.commandCalls(PutCommand)[0].args[0].input.Item!;
      dynamoMock.on(GetCommand).resolves({ Item: { keyHash: keyHash } });
      dynamoMock.on(QueryCommand).resolves({ Items: [] });
      const client = new Client(
        { name: "test", version: "1.0.0" },
        {
          supportedProtocolVersions: [version],
          versionNegotiation: {
            mode: version === "2026-07-28" ? { pin: version } : "legacy",
          },
        },
      );

      await client.connect(
        new StreamableHTTPClientTransport(new URL(MCP_URL), {
          requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
          fetch: (input, init) => lambdaFetch(new Request(input, init)),
        }),
      );
      const { tools } = await client.listTools();
      const result = await client.callTool({
        name: "list_documents",
        arguments: {},
      });
      await client.close();

      expect(tools.map((tool) => tool.name)).toEqual([
        "search",
        "list_documents",
        "get_document",
      ]);
      expect(tools.every((tool) => tool.inputSchema.type === "object")).toBe(
        true,
      );
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify({ count: 0, documents: [] }) },
      ]);
      expect(dynamoMock.commandCalls(QueryCommand)[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: { ":pk": "USER#owner" },
        }),
      );
    },
  );
});

/** Creates an MCP key for the test user through the key route and returns it. */
async function issueKey(): Promise<string> {
  const response = await mcpKey(apiEvent({ requestContext: POST_CONTEXT }));
  expect(response.statusCode).toBe(201);

  return (JSON.parse(response.body!) as { apiKey: string }).apiKey;
}

/** Runs a fetch Request through the Lambda as API Gateway would deliver it. */
async function lambdaFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = await request.text();
  const result = await mcp({
    ...apiEvent(),
    rawPath: url.pathname,
    headers: Object.fromEntries(request.headers),
    body: body || undefined,
    requestContext: {
      ...POST_CONTEXT,
      domainName: url.host,
      http: { ...POST_CONTEXT.http, method: request.method },
    },
  });

  return new Response(result.body || null, {
    status: result.statusCode,
    headers: result.headers as Record<string, string>,
  });
}
