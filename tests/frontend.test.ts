import { JSDOM } from "jsdom";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiCall,
  countProcessingDocuments,
  getIdentity,
  getFileMimeType,
  getUserProfile,
  groupResults,
  mergeDocuments,
  readPendingDocuments,
  updateDocumentTags,
  uploadDocument,
  validateUploadFile,
} from "../web/src/lib/client";

import type { Document } from "../web/src/lib/types";

const API_URL = "https://api.cheapkb.test/v1";
const PENDING_DOCUMENTS_KEY = "cheapkb_pending_documents";
const STORAGE_ORIGIN =
  "https://cheapkb-storage-000000000000-us-east-1.s3.us-east-1.amazonaws.com";

describe("frontend", () => {
  let originalWindow: any;
  let originalDocument: any;
  let originalLocalStorage: any;
  let originalSessionStorage: any;
  let originalFormData: any;
  let originalFetch: any;
  let originalViteApiUrl: string | undefined;

  beforeEach(() => {
    const dom = new JSDOM("", { url: "https://cheapkb.test" });
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    originalSessionStorage = globalThis.sessionStorage;
    originalFormData = globalThis.FormData;
    originalFetch = globalThis.fetch;
    originalViteApiUrl =
      (import.meta.env as Record<string, string | undefined>).VITE_API_URL ??
      process.env.VITE_API_URL;

    globalThis.window = dom.window as unknown as Window &
      typeof globalThis.window;
    globalThis.document = dom.window.document as unknown as Document &
      typeof globalThis.document;
    globalThis.localStorage = dom.window.localStorage as unknown as Storage;
    globalThis.sessionStorage = dom.window.sessionStorage as unknown as Storage;
    globalThis.FormData = dom.window.FormData as unknown as typeof FormData;
    process.env.VITE_API_URL = API_URL;
    Object.assign(import.meta.env as Record<string, string | undefined>, {
      VITE_API_URL: API_URL,
    });
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.sessionStorage = originalSessionStorage;
    globalThis.FormData = originalFormData;
    globalThis.fetch = originalFetch;
    if (originalViteApiUrl === undefined) {
      delete process.env.VITE_API_URL;
    } else {
      process.env.VITE_API_URL = originalViteApiUrl;
    }
    if (originalViteApiUrl === undefined) {
      delete (import.meta.env as Record<string, string | undefined>)
        .VITE_API_URL;
    } else {
      Object.assign(import.meta.env as Record<string, string | undefined>, {
        VITE_API_URL: originalViteApiUrl,
      });
    }
    vi.restoreAllMocks();
  });

  describe("API client", () => {
    it("treats an expired token as signed out", () => {
      window.localStorage.setItem(
        "shoo_identity",
        JSON.stringify({
          userId: "user-1",
          token: jwt({ exp: Date.now() / 1000 - 60 }),
        }),
      );

      expect(getIdentity()).toBeNull();
      expect(window.localStorage.getItem("shoo_identity")).toBeNull();
    });

    it("keeps a token that has not expired", () => {
      const token = jwt({ exp: Date.now() / 1000 + 600 });
      window.localStorage.setItem(
        "shoo_identity",
        JSON.stringify({ userId: "user-1", token: token }),
      );

      expect(getIdentity()).toEqual({ token: token, userId: "user-1" });
    });

    it("sends authenticated JSON requests to the configured API", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ documents: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        apiCall("token", "POST", "/query", { q: "cheap RAG" }),
      ).resolves.toEqual({
        documents: [],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `${API_URL}/query`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ q: "cheap RAG" }),
          headers: expect.objectContaining({ Authorization: "Bearer token" }),
        }),
      );
    });

    it("saves document tags through the PATCH route", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ tags: ["research"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        updateDocumentTags("token", "doc 1", ["research"]),
      ).resolves.toEqual(["research"]);
      expect(fetchMock).toHaveBeenCalledWith(
        // The id is encoded, so an id with a space cannot break the path.
        `${API_URL}/documents/doc%201`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ tags: ["research"] }),
        }),
      );
    });

    it("rejects requests without an identity token", async () => {
      await expect(apiCall("", "GET", "/documents")).rejects.toThrow(
        "Not signed in",
      );
    });

    it("reads the signed profile used by the user menu", () => {
      const payload = Buffer.from(
        JSON.stringify({
          email: "user@example.com",
          name: "Cheap KB",
          picture: "https://example.com/avatar.png",
        }),
      ).toString("base64url");

      expect(
        getUserProfile({
          token: `header.${payload}.signature`,
          userId: "ps-1",
        }),
      ).toEqual({
        email: "user@example.com",
        initials: "CK",
        name: "Cheap KB",
        picture: "https://example.com/avatar.png",
      });
    });
  });

  describe("upload flow", () => {
    it("rejects an oversized image before requesting a presigned form", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const file = {
        name: "large.png",
        size: 5 * 1024 * 1024 + 1,
        type: "image/png",
      } as File;

      expect(validateUploadFile(file)).toBe("Image exceeds the 5 MB limit");
      await expect(
        uploadDocument("token", file, { title: "Large" }, vi.fn()),
      ).rejects.toThrow("Image exceeds the 5 MB limit");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("uploads through the constrained POST form and starts ingestion", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            documentId: "doc-1",
            maxUploadBytes: 100,
            uploadUrl: "https://storage.example.com",
            uploadFields: { key: "raw/doc-1/file.txt" },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(jsonResponse({ queued: true }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const file = new window.File(["hello"], "file.txt", {
        type: "text/plain",
      });

      await expect(
        uploadDocument("token", file, { title: "File" }, vi.fn()),
      ).resolves.toBe("doc-1");
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://storage.example.com",
        expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        `${API_URL}/ingest`,
        expect.objectContaining({
          body: JSON.stringify({ documentId: "doc-1" }),
        }),
      );
    });

    it("deletes the document record when storage rejects the upload", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            documentId: "doc-1",
            maxUploadBytes: 100,
            uploadUrl: "https://storage.example.com",
            uploadFields: {},
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(jsonResponse({ deleted: true }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const file = new window.File(["hello"], "file.txt", {
        type: "text/plain",
      });

      await expect(
        uploadDocument("token", file, { title: "File" }, vi.fn()),
      ).rejects.toMatchObject({
        message: "Failed to upload file to S3",
        documentId: "doc-1",
      });
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        `${API_URL}/documents/doc-1`,
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("keeps an uploaded document when the ingest status check fails", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            documentId: "doc-1",
            maxUploadBytes: 100,
            uploadUrl: "https://storage.example.com",
            uploadFields: {},
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const file = new window.File(["hello"], "file.txt", {
        type: "text/plain",
      });

      await expect(
        uploadDocument("token", file, { title: "File" }, vi.fn()),
      ).resolves.toBe("doc-1");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock).not.toHaveBeenCalledWith(
        `${API_URL}/documents/doc-1`,
        expect.anything(),
      );
    });

    it("trims upload metadata to the upload handler's limits", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 400 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const file = new window.File(["hello"], "file.txt", {
        type: "text/plain",
      });

      await expect(
        uploadDocument(
          "token",
          file,
          {
            authors: [" ", "a".repeat(150), ...Array(25).fill("Ada")],
            tags: Array(25).fill("research"),
            title: ` ${"t".repeat(250)} `,
            year: 12,
          },
          vi.fn(),
        ),
      ).rejects.toThrow();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.title).toBe("t".repeat(200));
      expect(body.authors).toHaveLength(20);
      expect(body.authors[0]).toBe("a".repeat(100));
      expect(body.tags).toHaveLength(20);
      expect(body).not.toHaveProperty("year");
    });

    it("drops authors from the end to fit the shared metadata budget", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 400 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const file = new window.File(["hello"], "file.txt", {
        type: "text/plain",
      });

      await expect(
        uploadDocument(
          "token",
          file,
          {
            authors: Array.from({ length: 20 }, (_, i) =>
              `${i}`.padEnd(100, "a"),
            ),
            tags: ["research"],
            title: "Title",
          },
          vi.fn(),
        ),
      ).rejects.toThrow();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const bytes = new TextEncoder().encode(
        JSON.stringify([body.title, body.tags, body.authors]),
      ).length;
      expect(bytes).toBeLessThanOrEqual(1200);
      expect(body.tags).toEqual(["research"]);
      expect(body.authors[0]).toBe("0".padEnd(100, "a"));
    });

    it("preserves a reused document when storage rejects the replacement", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            documentId: "doc-1",
            maxUploadBytes: 100,
            reused: true,
            uploadUrl: "https://storage.example.com",
            uploadFields: {},
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 500 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const file = new window.File(["hello"], "file.txt", {
        type: "text/plain",
      });

      await expect(
        uploadDocument("token", file, { title: "File" }, vi.fn()),
      ).rejects.toThrow("Failed to upload file to S3");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("document state", () => {
    it("keeps a newer local failure while the server index catches up", () => {
      const serverTime = "2026-01-01T00:00:00.000Z";
      const localTime = "2026-01-01T00:00:01.000Z";

      const documents = mergeDocuments(
        [
          {
            documentId: "doc-1",
            status: "FAILED",
            lastError: "Upload interrupted",
            updatedAt: localTime,
          },
        ],
        [{ documentId: "doc-1", status: "UPLOADED", updatedAt: serverTime }],
      );

      expect(documents[0]).toMatchObject({
        status: "FAILED",
        lastError: "Upload interrupted",
      });
    });

    it("discards temporary and expired pending documents", () => {
      localStorage.setItem(
        PENDING_DOCUMENTS_KEY,
        JSON.stringify([
          {
            documentId: "temp_1",
            status: "UPLOADING",
            updatedAt: new Date().toISOString(),
          },
          {
            documentId: "doc-old",
            status: "FAILED",
            updatedAt: "2020-01-01T00:00:00.000Z",
          },
        ]),
      );

      expect(readPendingDocuments()).toEqual([]);
    });

    it("removes a stale local failure that no longer exists on the server", () => {
      const documents = mergeDocuments(
        [
          {
            documentId: "doc-deleted",
            status: "FAILED",
            lastError: "Failed to fetch",
            updatedAt: "2020-01-01T00:00:00.000Z",
          },
        ],
        [],
      );

      expect(documents).toEqual([]);
      expect(localStorage.getItem(PENDING_DOCUMENTS_KEY)).toBeNull();
    });

    it("renders one row when polling returns an optimistic document", () => {
      const documents = mergeDocuments(
        [
          { documentId: "doc-1", status: "QUEUED" },
          { documentId: "doc-1", status: "UPLOADED" },
          { documentId: "temp_1", status: "UPLOADING" },
        ],
        [{ documentId: "doc-1", status: "PARSING" }],
      );

      expect(documents).toEqual([
        expect.objectContaining({ documentId: "doc-1", status: "PARSING" }),
      ]);
    });
  });

  describe("document helpers", () => {
    it("counts processing documents the way the upload cap does", () => {
      const now = Date.parse("2026-10-03T12:00:00Z");
      const at = (minutesAgo: number) =>
        new Date(now - minutesAgo * 60 * 1000).toISOString();

      const count = countProcessingDocuments(
        [
          { documentId: "a", status: "EMBEDDING", updatedAt: at(30) },
          { documentId: "b", status: "UPLOADED", updatedAt: at(5) },
          { documentId: "c", status: "UPLOADED", updatedAt: at(20) },
          { documentId: "d", status: "PARSING", updatedAt: at(90) },
          { documentId: "e", status: "EMBEDDED", updatedAt: at(1) },
        ] as Document[],
        now,
      );

      expect(count).toBe(2);
    });

    it("infers supported MIME types from file extensions", () => {
      expect(getFileMimeType({ name: "notes.md", type: "" } as File)).toBe(
        "text/markdown",
      );
      expect(getFileMimeType({ name: "report.pdf", type: "" } as File)).toBe(
        "application/pdf",
      );
      expect(getFileMimeType({ name: "photo.JPG", type: "" } as File)).toBe(
        "image/jpeg",
      );
      expect(getFileMimeType({ name: "diagram.webp", type: "" } as File)).toBe(
        "image/webp",
      );
    });

    it("groups query results by document and highest score", () => {
      const groups = groupResults([
        { documentId: "doc-low", chunkId: "c1", score: 0.2 },
        { documentId: "doc-high", chunkId: "c2", score: 0.8 },
        { documentId: "doc-high", chunkId: "c3", score: 0.6 },
      ]);

      expect(groups.map((group) => group.document.documentId)).toEqual([
        "doc-high",
        "doc-low",
      ]);
      expect(groups[0]).toMatchObject({ maxScore: 0.8 });
      expect(groups[0].chunks).toHaveLength(2);
    });
  });

  describe("production build", () => {
    it("uses a restrictive CSP and fingerprints local assets", () => {
      execFileSync("npm", ["--prefix", "web", "run", "build"], {
        env: {
          ...process.env,
          API_URL: API_URL,
          VITE_STORAGE_ORIGIN: STORAGE_ORIGIN,
        },
        stdio: "pipe",
      });
      const sourceHtml = fs.readFileSync("web/index.html", "utf8");
      const documentsSource = fs.readFileSync(
        "web/src/components/DocumentsCard.tsx",
        "utf8",
      );
      const html = fs.readFileSync("web/dist/index.html", "utf8");
      const jsFiles = fs
        .readdirSync("web/dist/assets")
        .filter((f) => f.endsWith(".js"));
      const cssFiles = fs
        .readdirSync("web/dist/assets")
        .filter((f) => f.endsWith(".css"));

      expect(sourceHtml).toContain("Content-Security-Policy");
      expect(sourceHtml).toContain("script-src 'self'");
      expect(sourceHtml).toContain("script-src 'self';");
      expect(sourceHtml).not.toContain("shoo.js");
      expect(sourceHtml).toContain("https://lh3.googleusercontent.com");
      expect(sourceHtml).not.toContain("cdn.tailwindcss.com");
      expect(documentsSource).toContain("multiple");
      expect(documentsSource).toContain('window.addEventListener("drop"');
      expect(documentsSource).toContain("Sync all");
      // Wide enough that columns never truncate; narrower screens scroll.
      expect(documentsSource).toContain(
        'Table className="min-w-250 table-fixed"',
      );
      expect(documentsSource).toContain('TableHead className="w-44">Tags');
      expect(documentsSource).not.toContain("bg-transparent!");
      expect(documentsSource).toContain('className="cursor-pointer"');
      expect(documentsSource).toContain('event.key !== "Enter"');
      expect(documentsSource).not.toContain("STATUS_LABELS");
      expect(jsFiles.length).toBeGreaterThan(0);
      expect(cssFiles.length).toBeGreaterThan(0);
      expect(html).toContain("/assets/");
      expect(html).toContain(new URL(API_URL).origin);
      expect(html).toContain(STORAGE_ORIGIN);
      expect(html).not.toContain("__API_ORIGIN__");
      expect(html).not.toContain("__STORAGE_ORIGIN__");
    }, 30000);
  });
});

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
