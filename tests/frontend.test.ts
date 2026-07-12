import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiCall,
  getFileMimeType,
  groupResults,
  mergeDocuments,
  readPendingDocuments,
  uploadDocument,
} from "../web/src/lib/client";

const API_URL = "https://api.cheapkb.test/v1";
const PENDING_DOCUMENTS_KEY = "cheapkb_pending_documents";

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

    it("rejects requests without an identity token", async () => {
      await expect(apiCall("", "GET", "/documents")).rejects.toThrow(
        "Not signed in",
      );
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
        env: { ...process.env, API_URL },
        stdio: "pipe",
      });
      const sourceHtml = fs.readFileSync("web/index.html", "utf8");
      const html = fs.readFileSync("web/dist/index.html", "utf8");
      const jsFiles = fs
        .readdirSync("web/dist/assets")
        .filter((f) => f.endsWith(".js"));
      const cssFiles = fs
        .readdirSync("web/dist/assets")
        .filter((f) => f.endsWith(".css"));

      expect(sourceHtml).toContain("Content-Security-Policy");
      expect(sourceHtml).toContain("script-src 'self'");
      expect(sourceHtml).not.toContain("cdn.tailwindcss.com");
      expect(jsFiles.length).toBeGreaterThan(0);
      expect(cssFiles.length).toBeGreaterThan(0);
      expect(html).toContain("/assets/");
      expect(html).not.toContain("__API_ORIGIN__");
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
