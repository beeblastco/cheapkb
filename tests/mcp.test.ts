import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../functions/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../functions/utils")>()),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 49 }),
  checkUsageLimit: vi.fn().mockResolvedValue({ allowed: true }),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: vi.fn().mockResolvedValue({
    url: "https://storage.example.com",
    fields: { key: "raw/doc/notes.md" },
  }),
}));

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
    vi.unstubAllGlobals();
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
    const apiKey = await trustIssuedKey();

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

  it("refuses a 2025-era client, since only 2026-07-28 is served", async () => {
    const apiKey = await trustIssuedKey();

    await expect(connect(apiKey, "2025-11-25")).rejects.toThrow(
      /Unsupported protocol version/,
    );
  });

  it("serves a 2026-07-28 client: lists and adds the caller's documents", async () => {
    const apiKey = await trustIssuedKey();
    dynamoMock.on(QueryCommand).resolves({ Items: [] });
    dynamoMock.on(TransactWriteCommand).resolves({});
    const storage = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", storage);
    const client = await connect(apiKey, "2026-07-28");

    const { tools } = await client.listTools();
    const listed = await client.callTool({
      name: "list_documents",
      arguments: {},
    });
    const added = await client.callTool({
      name: "add_document",
      arguments: {
        filename: "notes.md",
        mimeType: "text/markdown",
        content: "# Notes",
      },
    });
    await client.close();

    expect(tools.map((tool) => tool.name)).toEqual([
      "search",
      "list_documents",
      "get_document",
      "add_document",
    ]);
    expect(tools.every((tool) => tool.inputSchema.type === "object")).toBe(
      true,
    );
    expect(listed.content).toEqual([
      { type: "text", text: JSON.stringify({ count: 0, documents: [] }) },
    ]);
    expect(added.isError).toBe(false);
    expect(storage).toHaveBeenCalledWith(
      "https://storage.example.com",
      expect.objectContaining({ method: "POST" }),
    );
    const form = storage.mock.calls[0][1].body as FormData;
    expect(await (form.get("file") as Blob).text()).toBe("# Notes");
  });
});

/** Connects a client pinned to one revision, the way Broods connects. */
async function connect(apiKey: string, version: string): Promise<Client> {
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

  return client;
}

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

/** Issues a key and makes the key row read return its hash, so the key verifies. */
async function trustIssuedKey(): Promise<string> {
  const apiKey = await issueKey();
  const { keyHash } =
    dynamoMock.commandCalls(PutCommand)[0].args[0].input.Item!;
  dynamoMock.on(GetCommand).resolves({});
  dynamoMock
    .on(GetCommand, { Key: { pk: "ACCOUNT#owner", sk: "MCP_KEY" } })
    .resolves({ Item: { keyHash: keyHash } });

  return apiKey;
}
