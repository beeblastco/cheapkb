import fs from "node:fs";
import { JSDOM } from "jsdom";
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
    const dom = new JSDOM("", {
      runScripts: "outside-only",
      url: "https://cheapkb.test",
    });
    const now = new Date().toISOString();
    const older = new Date(Date.now() - 1000).toISOString();
    Object.assign(dom.window, {
      APP_CONFIG: { apiUrl: "https://api.cheapkb.test" },
      CHEAPKB_TEST: true,
    });
    dom.window.eval(main);
    const api = (dom.window as any).CHEAPKB_TEST_API;
    api.state.documents = [
      {
        documentId: "doc_1",
        status: "FAILED",
        lastError: "Upload interrupted",
        createdAt: older,
        updatedAt: now,
      },
    ];

    const documents = api.mergeDocuments([
      {
        documentId: "doc_1",
        status: "UPLOADED",
        createdAt: older,
        updatedAt: older,
      },
    ]);

    expect(documents[0]).toMatchObject({
      status: "FAILED",
      lastError: "Upload interrupted",
    });
  });

  it("shows calm button progress and supports reduced motion", () => {
    const main = fs.readFileSync("web/main.js", "utf8");
    const css = fs.readFileSync("web/input.css", "utf8");
    const dom = new JSDOM('<button id="submit">Upload</button>', {
      runScripts: "outside-only",
      url: "https://cheapkb.test",
    });
    Object.assign(dom.window, {
      APP_CONFIG: { apiUrl: "https://api.cheapkb.test" },
      CHEAPKB_TEST: true,
    });
    dom.window.eval(main);
    const api = (dom.window as any).CHEAPKB_TEST_API;
    const button = dom.window.document.getElementById(
      "submit",
    ) as HTMLButtonElement;

    api.setButtonLoading(button, true);
    expect(button.disabled).toBe(true);
    expect(button.classList.contains("is-working")).toBe(true);
    expect(button.querySelector("svg")).toBeNull();

    api.setButtonLoading(button, false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Upload");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation-duration: 0.01ms !important");
  });
});
