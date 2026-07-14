import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiCall,
  getFileMimeType,
  getUserProfile,
  groupResults,
  mergeDocuments,
  readPendingDocuments,
  updateDocumentTags,
  uploadDocument,
} from "../web/src/lib/client";

const API_URL = "https://api.cheapkb.test/v1";
const PENDING_DOCUMENTS_KEY = "cheapkb_pending_documents";
const STORAGE_ORIGIN =
  "https://cheapkb-storage-954475336309-us-east-1.s3.us-east-1.amazonaws.com";

describe("frontend", () => {
  beforeEach(() => {
    const dom = new JSDOM("", { url: "https://cheapkb.test" });
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("localStorage", dom.window.localStorage);
    vi.stubGlobal("sessionStorage", dom.window.sessionStorage);
    vi.stubGlobal("FormData", dom.window.FormData);
    vi.stubEnv("VITE_API_URL", API_URL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("API client", () => {
    it("sends authenticated JSON requests to the configured API", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ documents: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

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
      vi.stubGlobal("fetch", fetchMock);

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
      vi.stubGlobal("fetch", fetchMock);
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
      vi.stubGlobal("fetch", fetchMock);
      const file = new window.File(["hello"], "file.txt", {
        type: "text/plain",
      });

      await expect(
        uploadDocument("token", file, {}, vi.fn()),
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
      vi.stubGlobal("fetch", fetchMock);
      const file = new window.File(["hello"], "file.txt", {
        type: "text/plain",
      });

      await expect(uploadDocument("token", file, {}, vi.fn())).rejects.toThrow(
        "Failed to upload file to S3",
      );
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
    it("infers supported MIME types from file extensions", () => {
      expect(getFileMimeType({ name: "notes.md", type: "" })).toBe(
        "text/markdown",
      );
      expect(getFileMimeType({ name: "report.pdf", type: "" })).toBe(
        "application/pdf",
      );
    });

    it("groups query results by document and highest score", () => {
      const groups = groupResults([
        { documentId: "doc-low", score: 0.2 },
        { documentId: "doc-high", score: 0.8 },
        { documentId: "doc-high", score: 0.6 },
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
          API_URL,
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
      expect(sourceHtml).toContain("script-src 'self' https://shoo.dev");
      expect(sourceHtml).toContain("https://lh3.googleusercontent.com");
      expect(sourceHtml).toContain('data-shoo-pii="true"');
      expect(sourceHtml).not.toContain("cdn.tailwindcss.com");
      expect(documentsSource).toContain("multiple");
      expect(documentsSource).toContain('window.addEventListener("drop"');
      expect(documentsSource).toContain("Sync all");
      expect(documentsSource).toContain(
        'Table className="min-w-3xl table-fixed"',
      );
      expect(documentsSource).toContain(
        'TableHeader className="sticky top-0 z-10 bg-card"',
      );
      expect(documentsSource).toContain("bg-transparent!");
      expect(documentsSource).toContain("text-inherit!");
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
