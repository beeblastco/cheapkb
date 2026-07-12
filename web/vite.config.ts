import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const API_URL = process.env.VITE_API_URL || process.env.API_URL || "";
const API_ORIGIN =
  process.env.VITE_API_ORIGIN || (API_URL ? new URL(API_URL).origin : "");
const STORAGE_ORIGIN = process.env.VITE_STORAGE_ORIGIN || "";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "content-security-policy",
      transformIndexHtml(html) {
        return html
          .replaceAll("__API_ORIGIN__", API_ORIGIN)
          .replaceAll("__STORAGE_ORIGIN__", STORAGE_ORIGIN);
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
  },
  define: {
    "import.meta.env.VITE_API_URL": JSON.stringify(API_URL),
  },
});
