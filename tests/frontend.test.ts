import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("frontend hardening", () => {
  it("uses local executable assets and a restrictive CSP", () => {
    const html = fs.readFileSync("web/index.html", "utf8");
    const main = fs.readFileSync("web/main.js", "utf8");

    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("script-src 'self'");
    expect(html).not.toContain("cdn.tailwindcss.com");
    expect(main).not.toContain("cdnjs.cloudflare.com");
  });

  it("uploads through the constrained POST form", () => {
    const main = fs.readFileSync("web/main.js", "utf8");
    expect(main).toContain('method: "POST"');
    expect(main).toContain("meta.uploadFields");
    expect(main).toContain("meta.maxUploadBytes");
  });

  it("keeps optimistic documents while the list index catches up", () => {
    const main = fs.readFileSync("web/main.js", "utf8");
    expect(main).toContain(
      'PENDING_DOCUMENTS_KEY = "cheapkb_pending_documents"',
    );
    expect(main).toContain("writePendingDocuments(documents, serverDocuments)");
    expect(main).toContain("state.documents = readPendingDocuments()");
    expect(main).toContain(
      'doc.status === "FAILED" && localUpdatedAt > serverUpdatedAt',
    );
  });

  it("uses the dark theme without a rotating SVG loader", () => {
    const html = fs.readFileSync("web/index.html", "utf8");
    const main = fs.readFileSync("web/main.js", "utf8");
    expect(html).toContain("bg-zinc-950");
    expect(main).not.toContain("SPINNER_SVG");
  });
});
