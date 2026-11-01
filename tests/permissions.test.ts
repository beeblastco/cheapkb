import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

// The IAM action each AWS call needs, checked per function but not per resource. TransactWrite
// and DeleteObject also need the per-item and per-version actions, read from the request.
const COMMAND_ACTIONS: Record<string, string> = {
  BatchWriteCommand: "dynamodb:BatchWriteItem",
  DeleteCommand: "dynamodb:DeleteItem",
  DeleteMessageCommand: "sqs:DeleteMessage",
  DeleteObjectCommand: "s3:DeleteObject",
  DeleteObjectsCommand: "s3:DeleteObject",
  DeleteVectorsCommand: "s3vectors:DeleteVectors",
  GetCommand: "dynamodb:GetItem",
  GetObjectCommand: "s3:GetObject",
  GetVectorsCommand: "s3vectors:GetVectors",
  HeadObjectCommand: "s3:GetObject",
  InvokeCommand: "lambda:InvokeFunction",
  InvokeModelCommand: "bedrock:InvokeModel",
  ListObjectVersionsCommand: "s3:ListBucketVersions",
  PutCommand: "dynamodb:PutItem",
  PutObjectCommand: "s3:PutObject",
  PutVectorsCommand: "s3vectors:PutVectors",
  QueryCommand: "dynamodb:Query",
  QueryVectorsCommand: "s3vectors:QueryVectors",
  ReceiveMessageCommand: "sqs:ReceiveMessage",
  SendMessageBatchCommand: "sqs:SendMessage",
  SendMessageCommand: "sqs:SendMessage",
  TransactWriteCommand: "dynamodb:TransactWriteItems",
  UpdateCommand: "dynamodb:UpdateItem",
};
const TRANSACT_ITEM_ACTIONS: Record<string, string> = {
  ConditionCheck: "dynamodb:ConditionCheckItem",
  Delete: "dynamodb:DeleteItem",
  Put: "dynamodb:PutItem",
  Update: "dynamodb:UpdateItem",
};
const UTILS = "functions/utils.ts";
// Calls the code can't reach: query records usage without an operationId, so it never
// takes recordUsage's transaction branch.
const UNREACHABLE: Record<string, string[]> = {
  "functions/query/index": ["dynamodb:TransactWriteItems"],
};

describe("Lambda IAM permissions", () => {
  it("grants every AWS action a handler's code can call", () => {
    const config = read("sst.config.ts");
    const handlers = [
      ...config.matchAll(/handler: "\.\/(functions\/[^"]+)\.handler"/g),
    ];
    expect(handlers.length).toBeGreaterThan(15);
    for (const [index, match] of handlers.entries()) {
      // A function's permissions follow its handler and end before the next handler.
      const block = config.slice(match.index, handlers[index + 1]?.index);
      const granted = new Set(
        [...block.matchAll(/"([a-z0-9]+:[A-Za-z]+)"/g)].map(
          ([, action]) => action,
        ),
      );
      // This shared grant is InvokeModel, or AssumeRole into a role that has it.
      if (block.includes("embeddingInvocationPermission")) {
        granted.add("bedrock:InvokeModel");
      }
      const missing = [...neededActions(resolve(`${match[1]}.ts`))].filter(
        (action) =>
          !granted.has(action) && !UNREACHABLE[match[1]]?.includes(action),
      );
      expect(missing, `${match[1]} lacks IAM actions`).toEqual([]);
    }
  });
});

/** Collects the actions of every command in a handler and the modules it imports. Only
 * the utils functions a module imports count, with the utils functions those call. */
function neededActions(entry: string): Set<string> {
  const actions = new Set<string>();
  const seenFiles = new Set<string>();
  const seenUtils = new Set<string>();
  const utilBodies = splitFunctions(read(UTILS));
  const files = [entry];

  while (files.length > 0) {
    const file = files.pop()!;
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const source = read(file);
    addActions(source, actions);
    for (const [, names, from] of source.matchAll(
      /import\s*{([^}]*)}\s*from\s*"(\.[^"]+)"/g,
    )) {
      const target = resolve(join(dirname(file), from));
      if (target === UTILS) {
        const queue = names.split(",").map((name) => name.trim());
        while (queue.length > 0) {
          const name = queue.pop()!;
          const body = utilBodies.get(name);
          if (!body || seenUtils.has(name)) continue;
          seenUtils.add(name);
          addActions(body, actions);
          for (const other of utilBodies.keys()) {
            if (new RegExp(`\\b${other}\\(`).test(body)) queue.push(other);
          }
        }
      } else if (
        target.startsWith("functions/") &&
        !target.endsWith("types.ts")
      ) {
        files.push(target);
      }
    }
  }

  return actions;
}

function addActions(source: string, actions: Set<string>): void {
  for (const [, command] of source.matchAll(/new (\w+Command)\(/g)) {
    if (COMMAND_ACTIONS[command]) actions.add(COMMAND_ACTIONS[command]);
  }
  // A presigned POST is signed with the function's own credentials.
  if (source.includes("createPresignedPost(")) actions.add("s3:PutObject");
  if (source.includes("new TransactWriteCommand(")) {
    for (const [, kind] of source.matchAll(
      /\b(ConditionCheck|Delete|Put|Update): \{/g,
    )) {
      actions.add(TRANSACT_ITEM_ACTIONS[kind]);
    }
  }
  if (/new DeleteObjectCommand\(\{[^}]*VersionId/.test(source)) {
    actions.add("s3:DeleteObjectVersion");
  }
}

function read(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), {
    encoding: "utf8",
  });
}

/** Maps a relative import to its file: `../utils` to functions/utils.ts, `../chunk` to its index. */
function resolve(path: string): string {
  const file = normalize(path).replace(/\.ts$/, "");
  try {
    read(`${file}.ts`);
    return `${file}.ts`;
  } catch {
    return `${file}/index.ts`;
  }
}

function splitFunctions(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const starts = [
    ...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm),
  ];
  for (const [index, match] of starts.entries()) {
    bodies.set(match[1], source.slice(match.index, starts[index + 1]?.index));
  }

  return bodies;
}
