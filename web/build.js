import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiUrl = process.env.API_URL ?? "";
const apiOrigin = apiUrl ? new URL(apiUrl).origin : "";
const distDir = path.join(__dirname, "dist");
const builtStylesPath = path.join(__dirname, ".styles.css");
const pdfBuildDir = path.join(__dirname, "node_modules", "pdfjs-dist", "build");
const SHOO_URL = "https://shoo.dev/shoo.js";
const SHOO_SHA384 =
  "jv9n8lqJdLd5YZwYdjyBk0OSOefAgozg3lWJ75aI0duDRJJiEC9jjJx4L/RbANgv";

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

fs.writeFileSync(
  path.join(distDir, "config.js"),
  `globalThis.APP_CONFIG = Object.freeze({ apiUrl: ${JSON.stringify(apiUrl)} });\n`,
);
fs.copyFileSync(
  path.join(pdfBuildDir, "pdf.mjs"),
  path.join(distDir, "pdf.mjs"),
);
fs.copyFileSync(
  path.join(pdfBuildDir, "pdf.worker.mjs"),
  path.join(distDir, "pdf.worker.mjs"),
);

const shooResponse = await fetch(SHOO_URL);
if (!shooResponse.ok) throw new Error("Failed to fetch the pinned Shoo SDK");
const shooSource = await shooResponse.text();
const shooHash = createHash("sha384").update(shooSource).digest("base64");
if (shooHash !== SHOO_SHA384) {
  throw new Error("Shoo SDK integrity check failed");
}
fs.writeFileSync(path.join(distDir, "shoo.js"), shooSource);

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
const mainHash = createHash("sha256")
  .update(minifiedJs.code)
  .digest("hex")
  .slice(0, 12);
const styles = fs.readFileSync(builtStylesPath);
const stylesHash = createHash("sha256")
  .update(styles)
  .digest("hex")
  .slice(0, 12);
const mainFile = `main.${mainHash}.js`;
const stylesFile = `styles.${stylesHash}.css`;

fs.writeFileSync(path.join(distDir, mainFile), minifiedJs.code);
fs.writeFileSync(path.join(distDir, stylesFile), styles);
fs.rmSync(builtStylesPath, { force: true });

const indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
fs.writeFileSync(
  path.join(distDir, "index.html"),
  indexHtml
    .replace(/__API_ORIGIN__/g, apiOrigin)
    .replace("styles.css", stylesFile)
    .replace("main.js", mainFile),
);

console.log("Built dist/ with API_URL:", apiUrl);
