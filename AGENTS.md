The current project name is `cheapkb`. Focus on cheap solution for RAG, priority features and engineering way to make it cheaps, trade off with latency and critical speed (S3 Vector, Lambda batch, SQS, DynamoDB), all covered by the free tier.

IaC using sst. Configure the target AWS account with the `AWS_ACCOUNT_ID` env var and your AWS credentials (a named profile or access keys). When `AWS_ACCOUNT_ID` is set, `sst.config.ts` refuses to deploy to any other account.

Before every AWS CLI or SST interaction, verify with `aws sts get-caller-identity` that the caller matches your configured `AWS_ACCOUNT_ID`, and abort on any mismatch. Resource names embed the account id, so a wrong caller silently provisions a parallel copy of the stack. If resources are accidentally created in another account, inventory and remove them immediately rather than retaining stale stages or endpoints.

The .env file is used to store the environment variables. The sst.config.ts will load the env variables from the .env file.

README.md is the entry point. Architecture lives in docs/ARCHITECTURE.md, billing in docs/BILLING.md, deploy in docs/DEPLOY.md, the API in docs/openapi.yaml and the proofs in proofs/README.md. Update the matching doc on any behaviour change, so none goes stale.

Do not use dash comments, banner comments, separate comments in the code.

Write simple code, priority duplicate code for readability, no abstraction, no custom type, interface when can use library, dependancy.

functions folder hold all the lambda functions logic. Each folder inside represent a separate function. Do not create config.ts file for share configuration, use the sst.config.ts file as a configuration file. Use types.ts file for shared types between functions and utils.ts file for shared small logics between functions.

Naming convention AWS Services: <project>-<service_name>-<account_id>-<region>. If we deployed with staging then it will be: <project>-<staging>-<service_name>-<account_id>-<region>

Put all defined const, types, interface at the beginning of the scripts. Next should be the export or main logic of the script. At the bottom of the scripts should be private, internal functions that use inisde the file. All the functions types should be group together or place next together, for example: all async functions should be placed in a rows, next will be all function, etc... Follow strictly this structure behaviour when writing, edit or delete code. Only add comments into key sections, keep comments max 2 lines with clear explaination. All the group function should be in alphabet order to better finding and lookup.

Always check for lint, typescript errors and warnings. Use prettier to format the code.

No sonner or other toast libraries. Errors go through `notify()` in App.tsx, which shows the shadcn Alert in `Notices.tsx` at the top center of the screen. Everything else should be visible and interactive through the main components.

Don't try to add custom gap an stuff as the current shadcn/ui already include the theme and style itself. Try to use default first, only add custom gap, margin, padding when specifically asked.

## Checks and automation

- Run `npm run check` (oxlint, prettier, tsc, vitest) before calling work done. After a web build, `npm run bundle:check` compares the shipped JavaScript with `scripts/bundle-budgets.json`; re-record with `npm run bundle:record` only for intended growth, and say why in the PR.
- `.oxlintrc.json` runs `@shadcn/lint` on `web/src`: style shadcn components through their variants and sizes, not by overriding their color, spacing or typography. `web/src/components/ui/**` is exempt.
- `.oxlintrc.json` also enforces `eqeqeq`, `radix`, `no-empty`, `no-implicit-coercion`, `no-plusplus`, `prefer-destructuring`, `import/no-duplicates` and the promise rules. `no-await-in-loop` stays off: pagination, retries, ordered side effects and free-tier throttling are sequential on purpose, so parallelize only when the iterations are independent.
- `.codeant/configuration.json` turns off CodeAnt's antipattern scan, since oxlint now owns those rules. Its security, secrets, dependency, IaC and docstring scans stay on.
- `npm install` sets `core.hooksPath` to `.githooks`, whose pre-commit runs gitleaks, oxlint and prettier on staged files. `.claude/settings.json` formats and lints every file an agent edits.
- Editing a source line a proof is anchored to fails `tests/proofs.test.ts`. Update the model in `proofs/Proofs/*.lean`, run `cd proofs && lake build && lake exe vectors`, and commit the regenerated vectors. See `proofs/README.md`.
- CI runs three jobs on every PR and push. Check runs lint, format, typecheck, tests, the web build and the bundle budget, plus an npm audit gate on PRs whose allowed advisories expire once a fix ships. Secrets scan runs gitleaks. Proofs runs `lake build`, fails on banned words or warnings, and checks the vectors are unchanged. `main` deploys to production only after all three pass.
