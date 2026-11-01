// Size ratchet for the JavaScript the web app ships, run after the web build:
// --check grades against bundle-budgets.json, --record adopts the current sizes.

import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIST_DIR = "web/dist";
const ASSETS_DIR = join(DIST_DIR, "assets");
const BUDGETS_PATH = "scripts/bundle-budgets.json";
// An identical-source rebuild drifted 1,751 B; anything past this either way needs a re-record.
const TOLERANCE_BYTES = 4096;

interface BundleBudgets {
  recordedAt: string;
  metrics: Record<string, number>;
}

const [, , mode] = process.argv;
if (mode !== "--check" && mode !== "--record") {
  console.error("usage: node scripts/bundle-budget.ts --check|--record");
  process.exit(2);
}
if (!existsSync(join(DIST_DIR, "index.html"))) {
  console.error(`${DIST_DIR}/index.html is missing; run the web build first.`);
  process.exit(2);
}

const allScripts = readdirSync(ASSETS_DIR)
  .filter((file) => file.endsWith(".js") || file.endsWith(".mjs"))
  .map((file) => join(ASSETS_DIR, file));
const initialScripts = readInitialScripts(
  readFileSync(join(DIST_DIR, "index.html"), "utf8"),
);
if (initialScripts.length === 0) {
  console.error(`${DIST_DIR}/index.html loads no JavaScript; check the build.`);
  process.exit(2);
}
const measured: Record<string, number> = {
  "web/initial-js": sumBytes(initialScripts, (file) => statSync(file).size),
  "web/initial-js-gzip": sumBytes(
    initialScripts,
    (file) => gzipSync(readFileSync(file), { level: 9 }).length,
  ),
  "web/js-total": sumBytes(allScripts, (file) => statSync(file).size),
};

if (mode === "--record") {
  const budgets: BundleBudgets = {
    recordedAt: new Date().toISOString(),
    metrics: measured,
  };
  writeFileSync(BUDGETS_PATH, `${JSON.stringify(budgets, null, 2)}\n`);
  console.log(`Recorded web bundle sizes to ${BUDGETS_PATH}.`);
  process.exit(0);
}

const budgets = JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as BundleBudgets;
// The same table goes to the terminal and, in CI, to the job summary.
const rows = ["| Metric | Size | Recorded | Delta | Status |"];
rows.push("| --- | --- | --- | --- | --- |");
let failing = 0;
for (const [name, bytes] of Object.entries(measured)) {
  const recorded = budgets.metrics[name];
  if (recorded === undefined) {
    failing += 1;
    rows.push(`| ${name} | ${formatBytes(bytes)} | - | - | not recorded |`);
    continue;
  }
  const delta = bytes - recorded;
  const status =
    delta > TOLERANCE_BYTES
      ? "grew"
      : delta < -TOLERANCE_BYTES
        ? "shrank, re-record"
        : "ok";
  if (status !== "ok") failing += 1;
  rows.push(
    `| ${name} | ${formatBytes(bytes)} | ${formatBytes(recorded)} | ${delta >= 0 ? "+" : ""}${delta.toLocaleString("en-US")} B | ${status} |`,
  );
}
const report = `### Web bundle size\n\n${rows.join("\n")}\n\nInitial JS is what index.html loads before first paint. Tolerance ${TOLERANCE_BYTES.toLocaleString("en-US")} B either way.\n`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}
if (failing > 0) {
  console.error(
    `${failing} bundle metric(s) moved past the tolerance. Run npm run bundle:record to lock in a shrink, or to accept intended growth and explain it in the PR.`,
  );
  process.exit(1);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

  return `${(bytes / 1024).toFixed(1)} KB`;
}

// The module script and modulepreload links in index.html, as dist paths.
function readInitialScripts(html: string): string[] {
  const files: string[] = [];
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    if (!tag.startsWith("<script") && !/\brel="modulepreload"/.test(tag)) {
      continue;
    }
    const source = /\b(?:src|href)="([^"]+)"/.exec(tag);
    if (source) files.push(join(DIST_DIR, source[1]));
  }

  return files;
}

/** Adds up one size measure (raw or gzip) over a list of built files. */
function sumBytes(files: string[], size: (file: string) => number): number {
  return files.reduce((total, file) => total + size(file), 0);
}
