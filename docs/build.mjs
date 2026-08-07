// cheapkb — serverless RAG on the AWS free tier. Type "pipeline".
// Layout engine only: no hand-written coordinates, no recolored icons.
// Every icon labelled "N fns" stands for N separate sst.aws.Function resources (23 total).
import { writeFileSync } from "node:fs";
import { Diagram } from "/opt/homebrew/lib/node_modules/drawio-ai-kit/src/builder.mjs";
import {
  group,
  icon,
  stage,
  band,
  box,
  frame,
  endpoint,
  phantom,
  renderTree,
} from "/opt/homebrew/lib/node_modules/drawio-ai-kit/src/layout-engine.mjs";

const d = new Diagram("pipeline");

const edge = stage("edge", 0, "1 · Edge", [
  icon("cf", "cloudfront", "CloudFront"),
  icon("web", "s3", "S3 (React SPA)"),
  icon("api", "api_gateway", "API Gateway v2 (/v1)"),
]);

const apis = stage("apis", 1, "2 · API Lambdas · 19 functions", [
  icon("upload", "lambda", "Upload · 1 fn"),
  icon("ingestfn", "lambda", "Ingest · 1 fn"),
  icon(
    "docs",
    "lambda",
    "Documents API · 5 fns\nlist get reindex update delete",
  ),
  icon("tags", "lambda", "Tags API · 4 fns"),
  icon("plansacct", "lambda", "Plans & Account · 8 fns"),
]);

const ingest = stage(
  "ingest",
  2,
  "3 · S3 event adapters",
  [
    icon("adapter", "lambda", "IngestAdapter · 1 fn\nObjectCreated raw/"),
    icon("s3raw", "s3", "S3 storage bucket\nraw/ parsed/ chunks/"),
    icon("cleanup", "lambda", "CleanupAdapter · 1 fn\nObjectRemoved raw/"),
  ],
  { routeGap: 56 },
);

const pipe = stage(
  "pipe",
  3,
  "4 · Pipeline · one queue, three stages",
  [
    phantom("pq", "", { dir: "row", gap: 40, header: 0 }, [
      icon("sqs", "sqs", "Pipeline queue"),
      icon("dlq", "sqs", "Pipeline DLQ"),
    ]),
    icon("worker", "lambda", "Pipeline · 1 fn\nparse → chunk → embed"),
  ],
  { routeGap: 56, gap: 72 },
);

const serve = stage("serve", 4, "6 · Read path", [
  icon("query", "lambda", "Query · 1 fn\nembed → top-k → chunk text"),
]);

// Invisible spacers align each store's centre with its dominant consumer's column, so
// tags/plans, query and the pipeline reach their table on a straight vertical run.
// Widths solved against the measured layout: ops_ddb->677, meta_ddb->901, vectors->1324.
const spacer = (id, w) =>
  box(id, "", { w, h: 8, fill: "none", stroke: "none" });

const data = frame(
  "data",
  "5 \u00b7 Data plane \u00b7 shared by the API, pipeline, read and cleanup paths",
  { dir: "row", gap: 0 },
  [
    spacer("sp0", 195),
    icon(
      "ops_ddb",
      "dynamodb",
      "DynamoDB\nplans \u00b7 accounts\ntags \u00b7 rate limits",
    ),
    spacer("sp1", 24),
    icon("meta_ddb", "dynamodb", "DynamoDB Meta\ndocs \u00b7 chunks"),
    spacer("sp2", 227),
    icon("vectors", "s3_vectors", "S3 Vectors\n1024-d cosine"),
  ],
);

const xcut = band(
  "band",
  "Cross-cutting — SST (Pulumi) IaC · least-privilege IAM per function",
  [
    icon("cfn", "cloudformation", "CloudFormation\nS3 Vectors stack"),
    icon("iam", "identity_and_access_management", "IAM roles"),
    icon("cw", "cloudwatch_2", "CloudWatch Logs"),
  ],
);

const region = group(
  "region",
  "group_region",
  "Region",
  { dir: "col", gap: 44 },
  [
    phantom("flow", "", { dir: "row", gap: 46, align: "top", header: 0 }, [
      edge,
      apis,
      ingest,
      pipe,
    ]),
    data,
    serve,
    xcut,
  ],
);

const cloud = group(
  "aws",
  "group_aws_cloud_alt",
  "AWS Cloud",
  { dir: "col", gap: 24 },
  [region],
);

const tree = phantom(
  "root",
  "",
  { dir: "row", gap: 46, align: "center", header: 0, pad: 10 },
  [
    endpoint("users", "USERS\n\nBrowser\nupload · search"),
    cloud,
    endpoint("embed", "EMBEDDING API\n\nOpenAI-compatible\n1024 dimensions"),
  ],
);

renderTree(d, tree, [40, 80]);
d.title(
  "cheapkb — serverless RAG knowledge base · 23 Lambda functions on the AWS free tier",
);

// Square corners throughout — the AWS house style, and consistent across every edge.
const link = (a, b, label = "", opts = {}) => d.link(a, b, label, opts);

link("users", "cf", "web app", { role: "fanout", dir: "LR" });
link("users", "api", "HTTPS /v1", { role: "fanout", dir: "LR" });
link("cf", "web", "");

link("api", "upload", "", { role: "fanout" });
link("api", "ingestfn", "", { role: "fanout" });
link("api", "docs", "", { role: "fanout" });
link("api", "tags", "", { role: "fanout" });
link("api", "plansacct", "", { role: "fanout" });
// Enter Query from the left through open space, so the vertical corridor between
// DynamoDB Meta and Query carries only the "chunks" edge.
link("api", "query", "POST /query", { role: "fanout", dir: "LR" });

link("upload", "s3raw", "presigned URL", { flow: true });
link("s3raw", "adapter", "", { flow: true });
link("s3raw", "cleanup", "");
link("ingestfn", "sqs", "enqueue");
link("docs", "sqs", "reindex");
link("adapter", "sqs", "stage: parse", { flow: true });
link("sqs", "worker", "batch", { flow: true });
link("worker", "sqs", "requeue", { dash: true });
link("worker", "dlq", "3 failures");
link("worker", "s3raw", "parsed/ \u00b7 chunks/", { dash: true });

link("worker", "vectors", "PutVectors", { flow: true, dir: "TB" });
link("worker", "meta_ddb", "status", { dir: "TB" });
link("query", "vectors", "QueryVectors", { dir: "TB" });
link("query", "meta_ddb", "chunks", { dir: "TB" });
link("tags", "ops_ddb", "tags", { dir: "TB" });
link("plansacct", "ops_ddb", "plans \u00b7 usage", { dir: "TB" });
link("cleanup", "meta_ddb", "delete records", { dash: true, dir: "TB" });
// Enter S3 Vectors from the left, not the top edge: sharing the top with PutVectors put the
// two corridors 9.6px apart (under the router's 16px separation) and nudged PutVectors off-straight.
link("cleanup", "vectors", "DeleteVectors", { dash: true, dir: "LR" });

link("worker", "embed", "embed chunks", { dir: "LR" });
link("query", "embed", "embed question", { dir: "LR" });

const res = d.validate();
console.log(
  "VALIDATE:",
  JSON.stringify({
    ok: res.ok,
    errors: res.errors,
    warnings: res.warnings,
    advice: res.audit.advice,
  }),
);
writeFileSync(
  new URL("./architecture.drawio", import.meta.url),
  d.mxfile("cheapkb architecture"),
);

// Self-check tail: build + validate + render in one run. The installed drawio (31.1.5)
// numbers pages from 1, so call it directly instead of `drawio-ai render`.
import { execFileSync as __exec } from "node:child_process";
const scale = process.argv.includes("--full") ? "1" : "0.55";
const out = process.argv.includes("--full")
  ? "architecture.png"
  : "architecture-check.png";
try {
  const f = new URL("./architecture.drawio", import.meta.url).pathname;
  const png = new URL(`./${out}`, import.meta.url).pathname;
  __exec(
    "drawio",
    ["-x", "-f", "png", "-s", scale, "-p", "1", "--no-sandbox", "-o", png, f],
    {
      encoding: "utf8",
    },
  );
  console.log("RENDERED:", png);
} catch (e) {
  console.error("RENDER-SKIPPED:", String(e.message).split("\n")[0]);
}
