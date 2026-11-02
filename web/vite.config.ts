import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const API_URL = process.env.VITE_API_URL || process.env.API_URL || "";
const API_ORIGIN =
  process.env.VITE_API_ORIGIN || (API_URL ? new URL(API_URL).origin : "");
const STORAGE_ORIGIN = process.env.VITE_STORAGE_ORIGIN || "";
// PostHog's no-external build fetches its config from the assets host next to ingest.
const POSTHOG_HOST = process.env.VITE_POSTHOG_HOST || "";
const POSTHOG_ORIGINS = POSTHOG_HOST
  ? `${POSTHOG_HOST} ${POSTHOG_HOST.replace(".i.posthog.com", "-assets.i.posthog.com")}`
  : "";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "content-security-policy",
      transformIndexHtml: function (html) {
        return {
          html: html
            .replaceAll("__API_ORIGIN__", API_ORIGIN)
            .replaceAll("__STORAGE_ORIGIN__", STORAGE_ORIGIN)
            .replaceAll("__POSTHOG_ORIGINS__", POSTHOG_ORIGINS),
          // Opens the API connection while the JavaScript downloads; fetch uses CORS mode.
          tags: API_ORIGIN
            ? [
                {
                  tag: "link",
                  attrs: {
                    crossorigin: true,
                    href: API_ORIGIN,
                    rel: "preconnect",
                  },
                  injectTo: "head",
                },
              ]
            : [],
        };
      },
    },
    {
      // A static import cycle between the codeSplitting chunks can run a chunk before its
      // imports exist and blank the app at boot, so it fails the build instead.
      name: "chunk-cycle-guard",
      apply: "build",
      generateBundle: function (_options, bundle): void {
        const done = new Set<string>();
        const visit = (fileName: string, trail: string[]): void => {
          if (done.has(fileName)) return;
          const start = trail.indexOf(fileName);
          if (start !== -1) {
            this.error(
              `Chunk import cycle: ${[...trail.slice(start), fileName].join(" -> ")}`,
            );
          }
          const chunk = bundle[fileName];
          if (chunk?.type !== "chunk") return;
          for (const imported of chunk.imports) {
            visit(imported, [...trail, fileName]);
          }
          done.add(fileName);
        };
        for (const fileName of Object.keys(bundle)) visit(fileName, []);
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Libraries the first paint needs; their hash changes only on dependency bumps.
            { name: "vendor", tags: ["$initial"], test: /node_modules/ },
            // Libraries only the workspace needs. PostHog and pdf.js keep their own lazy chunks.
            {
              name: "vendor-workspace",
              test: /node_modules[\\/](?!posthog-js[\\/]|pdfjs-dist[\\/])/,
            },
          ],
        },
      },
    },
  },
  define: {
    "import.meta.env.VITE_API_URL": JSON.stringify(API_URL),
  },
});
