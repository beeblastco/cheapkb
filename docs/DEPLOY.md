# Deploy

Copy `.env.example` to `.env`, set `AWS_ACCOUNT_ID` to the deployment account, and review the optional model and pricing values.

```bash
aws sts get-caller-identity --query Account --output text
npx sst deploy --stage production
```

The caller account must match `AWS_ACCOUNT_ID`. The deployment output includes the web address and the API base URL, `/v1` included.

The deployer owns plan configuration. Update the seeded default plan in `sst.config.ts` and deploy; existing accounts use its current price and allowance, and accounts on a removed plan fall back to it. Users cannot create or assign plans through the API.

## Custom domain

Set `DOMAIN` to serve production on it: the web app on `DOMAIN` and the API on `api.DOMAIN/v1`. SST creates the certificates and DNS records, so the deploy account needs a Route53 public hosted zone for `DOMAIN`. When the parent domain lives in another account, create the zone in the deploy account, then delegate to it with an NS record in the parent zone:

```bash
aws route53 create-hosted-zone --name cheapkb.example.com --caller-reference "$(date +%s)"
```

Leave `DOMAIN` unset to keep the CloudFront and API Gateway URLs. Other stages always use those. Shoo tokens are scoped to the web app origin, so moving to a domain signs every user out once.

## Bedrock

`BEDROCK_EMBEDDING_MODEL` defaults to `us.cohere.embed-v4:0`. Enable access to Cohere Embed v4 in Amazon Bedrock in the deployment account before deploying; the Pipeline and Query Lambdas call it directly.

Production keeps short-lived Bedrock diagnostic logs in S3.

## Analytics

Set `POSTHOG_KEY` (a PostHog project token) to send product analytics; `POSTHOG_HOST` defaults to `https://eu.i.posthog.com`. Leave the key unset to send nothing. The web app bundles PostHog's no-external build, so no PostHog script loads at runtime; its Content Security Policy only adds the ingest host and the matching assets host, which serves the project config, to `connect-src`. Session replay and surveys need PostHog's external scripts, so they are not available.

## CI

Merges to `main` deploy through GitHub Actions in the `production` environment, only after the Check, Secrets scan and Proofs jobs pass. Besides lint, knip, format, typecheck and tests, Check builds the web app, fails when its JavaScript moves past `scripts/bundle-budgets.json`, and boots the build in headless Chromium against a mocked API, failing on page errors, CSP violations, missing rows or React renders that move off `scripts/render-budgets.json`. The production stage creates a `github-deploy` IAM role that trusts GitHub's OIDC provider for this repository's `production` environment only; the deploy job assumes it with short-lived tokens.

Run the first production deploy locally, since it creates that role. Then set `AWS_ACCOUNT_ID` as a repository secret and the role ARN (the `deployRoleArn` output) as the `AWS_DEPLOY_ROLE_ARN` variable.

CI does not read `.env`. Its configuration is the `env` block in `.github/workflows/deploy.yml` and the `DOMAIN` in its deploy step, plus the optional `POSTHOG_KEY` and `POSTHOG_HOST` repository variables.
