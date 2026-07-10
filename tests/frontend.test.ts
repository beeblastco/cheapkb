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
});
