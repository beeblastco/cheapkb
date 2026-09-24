// Size budget for the JavaScript the web app ships. Run after the web build.
//   node scripts/bundle-budget.ts --check    grade against bundle-budgets.json
//   node scripts/bundle-budget.ts --record   adopt the current sizes as the baseline

import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ASSETS_DIR = "web/dist/assets";
const BUDGETS_PATH = "scripts/bundle-budgets.json";
const DEFAULT_GROWTH_PCT = 10;

interface BundleMetric {
  bytes: number;
  ceilingBytes: number;
  maxGrowthPct: number;
}

interface BundleBudgets {
  recordedAt: string;
  metrics: Record<string, BundleMetric>;
}

const [, , mode] = process.argv;
if (mode !== "--check" && mode !== "--record") {
  console.error("usage: node scripts/bundle-budget.ts --check|--record");
  process.exit(2);
}
if (!existsSync(ASSETS_DIR)) {
  console.error(`${ASSETS_DIR} is missing; run the web build first.`);
  process.exit(2);
}

const sizes = readdirSync(ASSETS_DIR)
  .filter((file) => file.endsWith(".js") || file.endsWith(".mjs"))
  .map((file) => statSync(join(ASSETS_DIR, file)).size);
const measured: Record<string, number> = {
  "web/js-total": sizes.reduce((total, size) => total + size, 0),
  "web/largest-chunk": Math.max(0, ...sizes),
};
const budgets: BundleBudgets = existsSync(BUDGETS_PATH)
  ? (JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as BundleBudgets)
  : { recordedAt: "", metrics: {} };

if (mode === "--record") {
  for (const [name, bytes] of Object.entries(measured)) {
    const prior = budgets.metrics[name];
    budgets.metrics[name] = {
      bytes: bytes,
      ceilingBytes: prior?.ceilingBytes ?? Math.round(bytes * 1.5),
      maxGrowthPct: prior?.maxGrowthPct ?? DEFAULT_GROWTH_PCT,
    };
  }
  budgets.recordedAt = new Date().toISOString();
  writeFileSync(BUDGETS_PATH, `${JSON.stringify(budgets, null, 2)}\n`);
  console.log(`Recorded web bundle sizes to ${BUDGETS_PATH}.`);
  process.exit(0);
}

// The same table goes to the terminal and, in CI, to the job summary.
const rows = ["| Metric | Size | Recorded | Delta | Ceiling | Status |"];
rows.push("| --- | --- | --- | --- | --- | --- |");
let failing = 0;
for (const [name, bytes] of Object.entries(measured)) {
  const budget = budgets.metrics[name];
  if (!budget) {
    rows.push(`| ${name} | ${formatBytes(bytes)} | - | - | - | new |`);
    continue;
  }
  const deltaPct = ((bytes - budget.bytes) / budget.bytes) * 100;
  const status =
    bytes > budget.ceilingBytes
      ? "over ceiling"
      : deltaPct > budget.maxGrowthPct
        ? "grew too much"
        : "ok";
  if (status !== "ok") failing += 1;
  rows.push(
    `| ${name} | ${formatBytes(bytes)} | ${formatBytes(budget.bytes)} | ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}% | ${formatBytes(budget.ceilingBytes)} | ${status} |`,
  );
}
const report = `### Web bundle size\n\n${rows.join("\n")}\n`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}
if (failing > 0) {
  console.error(
    `${failing} bundle metric(s) over budget. If the growth is intended, run --record and explain it in the PR.`,
  );
  process.exit(1);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

  return `${(bytes / 1024).toFixed(0)} KB`;
}
