import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiUrl = process.env.API_URL ?? "";
const distDir = path.join(__dirname, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
fs.writeFileSync(
  path.join(distDir, "index.html"),
  indexHtml.replace(/__API_URL__/g, apiUrl),
);

const mainJs = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const minifiedJs = await minify(mainJs, {
  sourceMap: false,
  compress: {
    drop_console: true,
    drop_debugger: true,
  },
  mangle: true,
});
if (!minifiedJs.code) {
  throw new Error("Failed to minify main.js");
}
fs.writeFileSync(path.join(distDir, "main.js"), minifiedJs.code);

console.log("Built dist/ with API_URL:", apiUrl);
