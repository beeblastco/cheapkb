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
import { handler as deleteHandler } from "../admin/delete";
import { handler as getHandler } from "../admin/get";
import { handler as listHandler } from "../admin/list";
import { handler as reindexHandler } from "../admin/reindex";
import { handler as updateHandler } from "../admin/update";
import { handler as uploadHandler } from "../admin/upload";
import { handler as usageHandler } from "../admin/usage";
import { handler as queryHandler } from "../query/index";
import { handler as createTagHandler } from "../tags/create";
import { handler as deleteTagHandler } from "../tags/delete";
import { handler as listTagsHandler } from "../tags/list";
import { handler as updateTagHandler } from "../tags/update";
import { TAG_COLORS } from "../types";
import {
  dynamo,
  hashMcpKey,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
} from "../utils";

const AccountsTableName = process.env.ACCOUNTS_TABLE_NAME!;
const BASE64 = /^[A-Za-z0-9+/\s]+={0,2}\s*$/;
const MIME_TYPES = [
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/markdown",
  "text/plain",
] as const;
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
// Built once per container; each request gets a fresh server for the user in its authInfo.
const mcp = createMcpHandler(
  ({ authInfo }) => {
    const event = authInfo?.extra?.event as APIGatewayProxyEventV2 | undefined;
    if (!event || !authInfo?.clientId)
      throw new Error("MCP request without a user");

    return createServer(event, authInfo.clientId);
  },
  // Only MCP 2026-07-28: stateless by design, so there is no 2025 session fallback.
  { legacy: "reject", responseMode: "json" },
);

/** ANY /mcp: stateless MCP 2026-07-28, authenticated by the caller's MCP key.
 * Tools run the matching API handler, so every limit, ownership check and charge still applies. */
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

/** Checks the bytes, then creates the document through the upload handler, so caps, rate limit
 * and usage apply, and posts them to its S3 form; the S3 event starts indexing as for the web app. */
async function addDocument(
  event: APIGatewayProxyEventV2,
  userId: string,
  args: {
    filename: string;
    mimeType: string;
    content: string;
    title?: string;
    tags?: string[];
  },
): Promise<APIGatewayProxyStructuredResultV2> {
  const { content, ...metadata } = args;
  const isText = args.mimeType.startsWith("text/");
  const bytes = Buffer.from(content, isText ? "utf8" : "base64");
  const maxBytes = args.mimeType.startsWith("image/")
    ? MAX_IMAGE_UPLOAD_BYTES
    : MAX_UPLOAD_BYTES;
  // Checked before the upload handler reserves the name, which a rejected file would block.
  if (bytes.length === 0 || (!isText && !BASE64.test(content))) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: isText ? "content is empty" : "content must be base64",
      }),
    };
  }
  if (bytes.length > maxBytes) {
    return {
      statusCode: 413,
      body: JSON.stringify({
        error: `File is over the ${maxBytes} byte limit`,
      }),
    };
  }
  const created = await uploadHandler(
    withUser(event, userId, { body: JSON.stringify(metadata) }),
  );
  if ((created.statusCode ?? 500) >= 400) return created;
  const { documentId, uploadUrl, uploadFields } = JSON.parse(
    created.body ?? "{}",
  ) as {
    documentId: string;
    uploadUrl: string;
    uploadFields: Record<string, string>;
  };
  const form = new FormData();
  for (const [key, value] of Object.entries(uploadFields)) {
    form.append(key, value);
  }
  form.append("file", new Blob([bytes], { type: args.mimeType }));
  const stored = await fetch(uploadUrl, { method: "POST", body: form });
  if (!stored.ok) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        error:
          "Storage rejected the file. Delete this document in the web app before adding it again.",
        documentId: documentId,
      }),
    };
  }

  return {
    statusCode: 202,
    body: JSON.stringify({ documentId: documentId, status: "UPLOADED" }),
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
      // A rotate or revoke must apply to the very next call.
      ConsistentRead: true,
    }),
  );

  return result.Item?.keyHash === hashMcpKey(apiKey) ? userId : null;
}

/** Builds the per-request server bound to the key's user: everything the web app does except
 * deleting all data and managing the MCP key, which stay in the web app. */
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
  server.registerTool(
    "add_document",
    {
      title: "Add document",
      description:
        "Add a file to the user's cheapkb. Text and Markdown go in as-is; PDF and images as base64. Up to about 4 MB per file; larger files go through the web app. A file with the same name and type replaces the old one. Indexing runs in the background; check it with get_document.",
      inputSchema: z.object({
        filename: z
          .string()
          .describe('File name with extension, e.g. "notes.md"'),
        mimeType: z.enum(MIME_TYPES),
        content: z
          .string()
          .describe("UTF-8 text for text/*, base64 for PDF and images"),
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
      // A file with the same name and type replaces the old one.
      annotations: DESTRUCTIVE,
    },
    async (args) => toToolResult(await addDocument(event, userId, args)),
  );
  server.registerTool(
    "update_document_tags",
    {
      title: "Update document tags",
      description:
        "Replace a document's tags. Pass the full list; an empty list clears them.",
      inputSchema: z.object({
        documentId: z.string().describe("Document id"),
        tags: z.array(z.string()),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ documentId, tags }) =>
      toToolResult(
        await updateHandler(
          withUser(event, userId, {
            pathParameters: { id: documentId },
            body: JSON.stringify({ tags: tags }),
          }),
        ),
      ),
  );
  server.registerTool(
    "reindex_document",
    {
      title: "Reindex document",
      description:
        "Restart indexing for a failed or stuck document from its last good step.",
      inputSchema: z.object({
        documentId: z.string().describe("Document id"),
      }),
      annotations: WRITE,
    },
    async ({ documentId }) =>
      toToolResult(
        await reindexHandler(
          withUser(event, userId, { pathParameters: { id: documentId } }),
        ),
      ),
  );
  server.registerTool(
    "delete_document",
    {
      title: "Delete document",
      description:
        "Permanently delete a document with its file, search data and vectors.",
      inputSchema: z.object({
        documentId: z.string().describe("Document id"),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ documentId }) =>
      toToolResult(
        await deleteHandler(
          withUser(event, userId, { pathParameters: { id: documentId } }),
        ),
      ),
  );
  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "List the user's tags with their colors.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      toToolResult(await listTagsHandler(withUser(event, userId, {}))),
  );
  server.registerTool(
    "create_tag",
    {
      title: "Create tag",
      description:
        "Create a tag, or return the existing one with that name. Tags on documents are set with update_document_tags.",
      inputSchema: z.object({
        name: z.string(),
        color: z.enum(TAG_COLORS).optional(),
      }),
      annotations: WRITE,
    },
    async (args) =>
      toToolResult(
        await createTagHandler(
          withUser(event, userId, { body: JSON.stringify(args) }),
        ),
      ),
  );
  server.registerTool(
    "update_tag",
    {
      title: "Update tag color",
      description: "Change a tag's color.",
      inputSchema: z.object({
        name: z.string(),
        color: z.enum(TAG_COLORS),
      }),
      annotations: WRITE,
    },
    async ({ name, color }) =>
      toToolResult(
        await updateTagHandler(
          withUser(event, userId, {
            pathParameters: { name: encodeURIComponent(name) },
            body: JSON.stringify({ color: color }),
          }),
        ),
      ),
  );
  server.registerTool(
    "delete_tag",
    {
      title: "Delete tag",
      description:
        "Delete a tag from the user's tag list. Documents keep their tags until retagged.",
      inputSchema: z.object({ name: z.string() }),
      annotations: DESTRUCTIVE,
    },
    async ({ name }) =>
      toToolResult(
        await deleteTagHandler(
          withUser(event, userId, {
            pathParameters: { name: encodeURIComponent(name) },
          }),
        ),
      ),
  );
  server.registerTool(
    "get_usage",
    {
      title: "Get usage",
      description:
        "This month's usage: spend against the plan allowance, storage, and the reset date.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => toToolResult(await usageHandler(withUser(event, userId, {}))),
  );

  return server;
}

/** Wraps an API handler response as an MCP tool result, an error for 4xx and 5xx. */
function toToolResult(
  response: APIGatewayProxyStructuredResultV2,
): CallToolResult {
  return {
    // A 204 has no body, so the status stands in for it.
    content: [
      {
        type: "text",
        text: response.body || JSON.stringify({ status: response.statusCode }),
      },
    ],
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
