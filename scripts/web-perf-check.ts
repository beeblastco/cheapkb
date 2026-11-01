// Boots the built web app in headless Chromium against a mocked API and counts React work per
// scenario: --check grades against render-budgets.json, --record adopts the current counts.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import type { Document, Tag, UsageSummary } from "../functions/types.ts";

const DIST_DIR = resolve("web/dist");
const BUDGETS_PATH = "scripts/render-budgets.json";
const APP_ORIGIN = "http://cheapkb.test";
// The API_URL origin the CI web build bakes in.
const API_ORIGIN = "https://example.execute-api.us-east-1.amazonaws.com";
// The CI build sets a PostHog key like production; its hosts get empty answers.
const POSTHOG_ORIGINS = new Set([
  "https://eu.i.posthog.com",
  "https://eu-assets.i.posthog.com",
]);
const FIXTURE_NOW = Date.parse("2026-10-01T12:00:00.000Z");
const DOCUMENT_COUNT = 200;
const IN_FLIGHT_COUNT = 10;
const PAGE_SIZE = 50;
const RUNS = 3;
const QUIET_MS = 300;
const SETTLE_TIMEOUT_MS = 20_000;
const SEARCH_TEXT = "contract";
const VIEWPORT = { width: 1440, height: 900 };
const CORS_HEADERS = {
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-origin": "*",
};
const TITLE_SUBJECTS = [
  "Quarterly revenue",
  "Vendor contract",
  "Employee handbook",
  "Incident postmortem",
  "Security audit",
  "Board meeting",
  "Pricing strategy",
];
const TITLE_KINDS = ["report", "notes", "summary", "draft", "memo"];
const TAGS: Tag[] = [
  { name: "finance", color: "green", createdAt: "2026-08-01T00:00:00.000Z" },
  { name: "legal", color: "purple", createdAt: "2026-08-02T00:00:00.000Z" },
  { name: "hr", color: "orange", createdAt: "2026-08-03T00:00:00.000Z" },
  { name: "research", color: "blue", createdAt: "2026-08-04T00:00:00.000Z" },
  { name: "sales", color: "red", createdAt: "2026-08-05T00:00:00.000Z" },
];
const USAGE: UsageSummary = {
  planId: "free",
  planLabel: "Free",
  priceMonthlyUsd: 0,
  allowanceUsd: 1,
  spentUsd: 0.12,
  storageUsd: 0.01,
  pctUsed: 13,
  paused: false,
  resetAt: "2026-11-30T00:00:00.000Z",
  storageBytes: 187654321,
};

interface Fiber {
  alternate: Fiber | null;
  child: Fiber | null;
  flags: number;
  sibling: Fiber | null;
  tag: number;
}

interface RenderCount {
  commits: number;
  fibers: number;
}

interface RenderBudgets {
  recordedAt: string;
  scenarios: Record<string, RenderCount>;
}

interface Session {
  documentLoads: number;
  documents: Document[];
  errors: string[];
  inflight: number;
  page: Page;
  parked: number;
  pending: { key: string; release: () => void }[];
  served: Record<string, number>;
}

declare global {
  interface Window {
    __perf: RenderCount & { everCommitted: number; violations: string[] };
  }
}

const [, , mode = "--check"] = process.argv;
if (mode !== "--check" && mode !== "--record") {
  console.error("usage: node scripts/web-perf-check.ts [--check|--record]");
  process.exit(2);
}
if (!existsSync(join(DIST_DIR, "index.html"))) {
  console.error("web/dist/index.html is missing; run the web build first.");
  process.exit(2);
}
if (!readFileSync(join(DIST_DIR, "index.html"), "utf8").includes(API_ORIGIN)) {
  console.error(`Build the web app with API_URL=${API_ORIGIN}/v1 first.`);
  process.exit(2);
}

// CHROME_PATH points at a local Chromium; CI uses the headless shell Playwright installs.
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
});
const runs: Record<string, RenderCount>[] = [];
try {
  for (let run = 0; run < RUNS; run += 1) runs.push(await measure(browser));
} finally {
  await browser.close();
}

// T3 Code's rule: counts that differ between runs measure timing, not React work.
const [first] = runs;
const unstable = Object.keys(first).filter((name) =>
  runs.some(
    (run) =>
      run[name].commits !== first[name].commits ||
      run[name].fibers !== first[name].fibers,
  ),
);
if (unstable.length > 0) {
  for (const name of unstable) {
    const counts = runs.map(
      (run) => `${run[name].commits}/${run[name].fibers}`,
    );
    console.error(`${name} differed between runs (commits/fibers): ${counts}`);
  }
  process.exit(1);
}

if (mode === "--record") {
  const budgets: RenderBudgets = {
    recordedAt: new Date().toISOString(),
    scenarios: first,
  };
  writeFileSync(BUDGETS_PATH, `${JSON.stringify(budgets, null, 2)}\n`);
  console.log(`Recorded ${RUNS} identical runs to ${BUDGETS_PATH}.`);
  process.exit(0);
}

const budgets = JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as RenderBudgets;
// The same table goes to the terminal and, in CI, to the job summary.
const rows = ["| Scenario | Commits | Budget | Fibers | Budget | Status |"];
rows.push("| --- | --- | --- | --- | --- | --- |");
let failing = 0;
for (const [name, count] of Object.entries(first)) {
  const budget = budgets.scenarios[name];
  const status = !budget
    ? "not recorded"
    : count.commits > budget.commits || count.fibers > budget.fibers
      ? "over budget"
      : count.commits < budget.commits || count.fibers < budget.fibers
        ? "under budget, re-record"
        : "ok";
  if (status !== "ok") failing += 1;
  rows.push(
    `| ${name} | ${count.commits} | ${budget?.commits ?? "-"} | ${count.fibers} | ${budget?.fibers ?? "-"} | ${status} |`,
  );
}
const report = `### Web render budget\n\n${rows.join("\n")}\n\nFibers are component renders; ${RUNS} runs gave identical counts.\n`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}
if (failing > 0) {
  console.error(
    `${failing} scenario(s) moved off budget. Fix extra renders, or run npm run perf:record to lock in a cut or accept intended growth, and say why in the PR.`,
  );
  process.exit(1);
}

// Answers one API call once settle() releases it; polls not allowed through stay parked.
async function answerApi(
  session: Session,
  route: Route,
  url: URL,
): Promise<void> {
  const method = route.request().method();
  if (method === "OPTIONS") {
    await route.fulfill({ status: 204, headers: CORS_HEADERS });
    return;
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const key = `${method} ${path}`;
  if (key === "GET /documents") {
    if (session.documentLoads === 0) {
      session.parked += 1;
      return;
    }
    session.documentLoads -= 1;
  }
  await new Promise<void>((release) => {
    session.pending.push({ key: key, release: release });
  });
  const [status, body] = apiResponse(session, key);
  if (status === 404) session.errors.push(`unmocked API call ${key}`);
  session.served[key] = (session.served[key] ?? 0) + 1;
  await route.fulfill({
    status: status,
    headers: CORS_HEADERS,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

// Fails on any page error, console error or CSP violation the session has seen so far.
async function assertClean(session: Session): Promise<void> {
  const violations = await session.page.evaluate(
    () => window.__perf.violations,
  );
  const errors = [
    ...session.errors,
    ...violations.map((violation) => `CSP violation: ${violation}`),
  ];
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

// Runs every scenario once, signed out then signed in, and returns the counts per scenario.
async function measure(browser: Browser): Promise<Record<string, RenderCount>> {
  const counts: Record<string, RenderCount> = {};
  const guest = await openSession(browser, false);
  await guest.page
    .getByRole("button", { name: "Continue with Google" })
    .waitFor();
  counts["signed-out-boot"] = await takeCounts(guest);
  await assertClean(guest);
  await guest.page.context().close();

  const session = await openSession(browser, true);
  const { page } = session;
  const rows = await page.locator('tr[aria-label^="View "]').count();
  if (rows !== PAGE_SIZE) {
    throw new Error(`signed-in boot showed ${rows} rows, not ${PAGE_SIZE}`);
  }
  counts["signed-in-boot"] = await takeCounts(session);

  // One in-flight row moves to its next status; the visibility listener polls at once.
  const polls = session.served["GET /documents"];
  session.documents = session.documents.map((document, index) =>
    index === 0
      ? {
          ...document,
          status: "PARSING",
          updatedAt: new Date(FIXTURE_NOW).toISOString(),
        }
      : document,
  );
  session.documentLoads = 1;
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  counts["changed-poll"] = await takeCounts(session);
  if (session.served["GET /documents"] !== polls + 1) {
    throw new Error("the changed poll never reached the API");
  }

  const search = page.locator('input[aria-label="Search documents"]');
  for (const character of SEARCH_TEXT) {
    await search.press(character);
    await settle(session);
  }
  counts["search-type"] = await takeCounts(session);
  await search.fill("");
  await takeCounts(session);

  const selectAll = page.getByRole("checkbox", {
    name: "Select documents on this page",
  });
  await selectAll.click();
  counts["select-all-on"] = await takeCounts(session);
  await selectAll.click();
  counts["select-all-off"] = await takeCounts(session);

  await page
    .locator('tr[aria-label^="View "]')
    .first()
    .locator("td")
    .nth(1)
    .click();
  await page.getByRole("dialog").waitFor();
  counts["document-open"] = await takeCounts(session);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  counts["document-close"] = await takeCounts(session);
  await assertClean(session);
  await session.page.context().close();

  return counts;
}

// Opens a fresh context with the fixed clock, mocks and probe, and loads the app until quiet.
async function openSession(
  browser: Browser,
  signedIn: boolean,
): Promise<Session> {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    locale: "en-US",
    serviceWorkers: "block",
    timezoneId: "UTC",
    viewport: VIEWPORT,
  });
  await context.clock.setFixedTime(FIXTURE_NOW);
  const page = await context.newPage();
  const session: Session = {
    documentLoads: 1,
    documents: buildDocuments(),
    errors: [],
    inflight: 0,
    page: page,
    parked: 0,
    pending: [],
    served: {},
  };
  page.on("pageerror", (error) => {
    session.errors.push(`page error: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      session.errors.push(`console error: ${message.text()}`);
    }
  });
  page.on("request", () => {
    session.inflight += 1;
  });
  page.on("requestfinished", () => {
    session.inflight -= 1;
  });
  page.on("requestfailed", () => {
    session.inflight -= 1;
  });
  await page.route("**/*", (route) => routeRequest(session, route));
  await page.addInitScript(installProbe, {
    identity: signedIn ? fakeIdentity() : null,
    origin: APP_ORIGIN,
  });
  await page.goto(`${APP_ORIGIN}/`);
  await settle(session);
  await assertClean(session);

  return session;
}

// Serves web/dist with the SPA fallback, mocks the API, Shoo and PostHog, and blocks anything else.
async function routeRequest(session: Session, route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin === APP_ORIGIN) {
    const file = join(DIST_DIR, decodeURIComponent(url.pathname));
    const isFile =
      file.startsWith(DIST_DIR) &&
      (statSync(file, { throwIfNoEntry: false })?.isFile() ?? false);
    await route.fulfill({ path: isFile ? file : join(DIST_DIR, "index.html") });
  } else if (url.origin === API_ORIGIN) {
    await answerApi(session, route, url);
  } else if (url.origin === "https://shoo.dev") {
    await route.fulfill({ json: { status: "active" } });
  } else if (POSTHOG_ORIGINS.has(url.origin)) {
    await route.fulfill({ json: {} });
  } else {
    session.errors.push(`unexpected request to ${url.origin}${url.pathname}`);
    await route.abort();
  }
}

// Releases held API calls one at a time, in key order, each once the page is quiet.
async function settle(session: Session): Promise<void> {
  await waitForQuiet(session);
  session.pending.sort((a, b) => a.key.localeCompare(b.key));
  let next = session.pending.shift();
  while (next) {
    next.release();
    await waitForQuiet(session);
    session.pending.sort((a, b) => a.key.localeCompare(b.key));
    next = session.pending.shift();
  }
}

// Settles the page, then returns and resets the counts since the last call.
async function takeCounts(session: Session): Promise<RenderCount> {
  await settle(session);

  return session.page.evaluate(() => {
    const { commits, fibers } = window.__perf;
    window.__perf.commits = 0;
    window.__perf.fibers = 0;
    return { commits: commits, fibers: fibers };
  });
}

// Quiet means no React commit and no unanswered request besides held ones for QUIET_MS.
async function waitForQuiet(session: Session): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let lastCommit = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const committed = await session.page.evaluate(
      () => window.__perf.everCommitted,
    );
    const busy = session.inflight > session.pending.length + session.parked;
    if (committed !== lastCommit || busy) {
      lastCommit = committed;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= QUIET_MS) {
      return;
    }
    await delay(50);
  }
  throw new Error("the page never went quiet");
}

// Routes one held API call to its fixture.
function apiResponse(session: Session, key: string): [number, unknown] {
  if (key === "GET /documents") {
    return [
      200,
      { count: session.documents.length, documents: session.documents },
    ];
  }
  if (key === "GET /tags") return [200, { tags: TAGS }];
  if (key === "GET /account/usage") return [200, USAGE];
  const document = session.documents.find(
    (current) => key === `GET /documents/${current.documentId}`,
  );
  if (!document) return [404, { error: "Not found" }];
  const chunks = Array.from({ length: 24 }, (_, index) => ({
    chunkId: `${document.documentId}#${String(index).padStart(4, "0")}`,
    pageStart: index + 1,
    pageEnd: index + 1,
    status: "EMBEDDED",
    tokenCount: 380 + ((index * 37) % 120),
  }));

  return [200, { document: document, chunks: chunks, chunkCount: 24 }];
}

// 200 documents newest first: 10 queued, a few failed, the rest embedded.
function buildDocuments(): Document[] {
  return Array.from({ length: DOCUMENT_COUNT }, (_, index) => {
    const createdAt = FIXTURE_NOW - (index + 1) * 37 * 60_000;
    const inFlight = index < IN_FLIGHT_COUNT;
    const failed = !inFlight && index % 41 === 0;
    return {
      authors: index % 3 === 0 ? null : ["Alice Nguyen"],
      createdAt: new Date(createdAt).toISOString(),
      documentId: `doc-${String(index).padStart(3, "0")}`,
      failedStep: failed ? "parse" : null,
      inFlight: inFlight,
      lastError: failed ? "Parse failed: the PDF has no text layer." : null,
      mimeType: index % 4 === 0 ? "text/markdown" : "application/pdf",
      retryCount: failed ? 3 : 0,
      status: inFlight ? "QUEUED" : failed ? "FAILED" : "EMBEDDED",
      tags: index % 2 === 0 ? [TAGS[index % TAGS.length].name] : null,
      title: `${TITLE_SUBJECTS[index % TITLE_SUBJECTS.length]} ${TITLE_KINDS[index % TITLE_KINDS.length]} ${2020 + (index % 6)}`,
      updatedAt: new Date(
        inFlight ? FIXTURE_NOW - 30_000 : createdAt + 240_000,
      ).toISOString(),
      year: 2015 + (index % 12),
    };
  });
}

// A JWT-shaped Shoo identity the client accepts without a signature check, valid until 2100.
function fakeIdentity(): { key: string; value: string } {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = {
    aud: `origin:${APP_ORIGIN}`,
    email: "perf@example.com",
    exp: 4102444800,
    iat: 1790000000,
    iss: "https://shoo.dev",
    name: "Perf User",
    picture: "",
    sub: "user_perf",
  };
  const token = `${encode({ alg: "ES256", typ: "JWT" })}.${encode(claims)}.c2lnbmF0dXJl`;

  return {
    key: "shoo_identity",
    value: JSON.stringify({
      expiresIn: 3600,
      receivedAt: FIXTURE_NOW,
      token: token,
      userId: "user_perf",
    }),
  };
}

// Runs in the page before any app script: seeds the identity, records CSP violations, and
// stands in for React DevTools to count commits and rendered components (T3 Code's walk).
function installProbe({
  identity,
  origin,
}: {
  identity: { key: string; value: string } | null;
  origin: string;
}): void {
  if (window.location.origin !== origin) return;
  if (identity) localStorage.setItem(identity.key, identity.value);
  const probe = {
    commits: 0,
    everCommitted: 0,
    fibers: 0,
    violations: [] as string[],
  };
  window.__perf = probe;
  document.addEventListener("securitypolicyviolation", (event) => {
    probe.violations.push(`${event.violatedDirective} ${event.blockedURI}`);
  });
  // Function, class, forwardRef, memo and simple memo components.
  const componentTags = new Set([0, 1, 11, 14, 15]);
  const visit = (fiber: Fiber | null): number => {
    let rendered = 0;
    for (let node = fiber; node; node = node.sibling) {
      const performed = componentTags.has(node.tag) && (node.flags & 1) === 1;
      if (performed) rendered += 1;
      // A bailed-out subtree keeps stale PerformedWork flags, so it is skipped.
      const skipped =
        node.alternate !== null &&
        node.child === node.alternate.child &&
        !performed;
      if (node.child && !skipped) rendered += visit(node.child);
    }

    return rendered;
  };
  Object.assign(window, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      checkDCE: (): void => {},
      inject: (): number => 1,
      onCommitFiberRoot: (_id: number, root: { current: Fiber }): void => {
        probe.everCommitted += 1;
        const rendered = visit(root.current.child);
        if (rendered === 0) return;
        probe.commits += 1;
        probe.fibers += rendered;
      },
      onCommitFiberUnmount: (): void => {},
      onPostCommitFiberRoot: (): void => {},
      onScheduleFiberRoot: (): void => {},
      renderers: new Map(),
      supportsFiber: true,
    },
  });
}
