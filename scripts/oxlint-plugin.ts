import {
  definePlugin,
  defineRule,
  type Comment,
  type Context,
  type ESTree,
  type Visitor,
} from "@oxlint/plugins";

const DIRECTIVE_PATTERN =
  /^\s*\*?\s*(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck))/u;
const EM_DASH = "\u2014";
const EMPTY_COMMENT_PATTERN = /^[\s*]*$/u;
const TS_DIRECTIVE_PATTERN =
  /^\s*\*?\s*@ts-(?:expect-error|ignore|nocheck)(?![\w-])(.*)$/su;

// Local oxlint rules ported from T3 Code, loaded through jsPlugins in .oxlintrc.json.
export default definePlugin({
  meta: {
    name: "cheapkb",
  },
  rules: {
    "no-em-dash-copy": defineRule({
      meta: {
        type: "suggestion",
        docs: {
          description: "Disallow em dashes in strings and JSX text.",
        },
      },
      create: (context: Context): Visitor => ({
        JSXText: (node): void => {
          reportEmDash(context, node, node.value);
        },
        Literal: (node): void => {
          if (typeof node.value === "string") {
            reportEmDash(context, node, node.value);
          }
        },
        TemplateElement: (node): void => {
          reportEmDash(context, node, node.value.cooked);
        },
      }),
    }),
    "require-suppression-reason": defineRule({
      meta: {
        type: "suggestion",
        docs: {
          description: "Require every lint or type suppression to say why.",
        },
      },
      create: (context: Context): Visitor => ({
        Program: (): void => {
          reportUnexplainedSuppressions(context);
        },
      }),
    }),
  },
});

/** True when a plain comment sits right above the directive, skipping stacked directives. */
function explainedAbove(
  directive: Comment,
  ownLineCommentsByEndLine: Map<number, Comment>,
): boolean {
  let above = ownLineCommentsByEndLine.get(directive.loc.start.line - 1);
  while (
    above &&
    (DIRECTIVE_PATTERN.test(above.value) ||
      EMPTY_COMMENT_PATTERN.test(above.value))
  ) {
    above = ownLineCommentsByEndLine.get(above.loc.start.line - 1);
  }

  return above !== undefined;
}

/** Reports copy that contains an em dash. Comments are not copy, so they are never checked. */
function reportEmDash(
  context: Context,
  node: ESTree.Node,
  text: string | null | undefined,
): void {
  if (text?.includes(EM_DASH)) {
    context.report({
      node: node,
      message:
        "No em dashes in copy. Use a period, comma, colon, parentheses or a hyphen.",
    });
  }
}

/** Reports oxlint, eslint and @ts- directives that have no `-- reason` and no comment above. */
function reportUnexplainedSuppressions(context: Context): void {
  const { sourceCode } = context;
  const comments = sourceCode.getAllComments();
  const ownLineCommentsByEndLine = new Map<number, Comment>();
  for (const comment of comments) {
    const { line, column } = comment.loc.start;
    // A JSX comment `{/* reason */}` starts after its brace.
    const before = (sourceCode.lines[line - 1] ?? "").slice(0, column).trim();
    if (before === "" || before === "{") {
      ownLineCommentsByEndLine.set(comment.loc.end.line, comment);
    }
  }

  for (const directive of sourceCode.getDisableDirectives().directives) {
    if (directive.type === "enable" || directive.justification.trim()) {
      continue;
    }
    if (explainedAbove(directive.node, ownLineCommentsByEndLine)) continue;
    context.report({
      loc: directive.node.loc,
      message:
        "Say why: end the directive with `-- reason` or put a comment on the line above.",
    });
  }

  for (const comment of comments) {
    const after = TS_DIRECTIVE_PATTERN.exec(comment.value)?.[1];
    if (after === undefined || after.replace(/^[\s:-]+/u, "").trim()) continue;
    if (explainedAbove(comment, ownLineCommentsByEndLine)) continue;
    context.report({
      loc: comment.loc,
      message:
        "Say why: write the reason after the directive or in a comment on the line above.",
    });
  }
}
