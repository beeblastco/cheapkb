# Deploy

Copy `.env.example` to `.env`, set `AWS_ACCOUNT_ID` to the deployment account, and review the optional model and pricing values.

```bash
aws sts get-caller-identity --query Account --output text
npx sst deploy --stage production
```

The caller account must match `AWS_ACCOUNT_ID`. The deployment output includes the API and web addresses.

The deployer owns plan configuration. Update the seeded default plan in `sst.config.ts` and deploy; existing accounts use its current price and allowance, and accounts on a removed plan fall back to it. Users cannot create or assign plans through the API.

## Bedrock

`BEDROCK_EMBEDDING_MODEL` defaults to `us.cohere.embed-v4:0`. Enable access to Cohere Embed v4 in Amazon Bedrock in the deployment account before deploying; the Pipeline and Query Lambdas call it directly.

Production keeps short-lived Bedrock diagnostic logs in S3.

## S3 Vectors

Search relies on the `ENHANCED` index mode (see [ARCHITECTURE](ARCHITECTURE.md#search-flow)), which vector buckets created after September 30, 2026 use by default. CloudFormation cannot set it, so a deployment created before then upgrades once. The switch is in place, free and needs no re-ingest, and the second command keeps a replaced index in `ENHANCED` mode. The commands show production; another stage's bucket is `cheapkb-<stage>-vecs-<account_id>-<region>` and its index is the stage name.

```bash
aws s3vectors update-index-mode --vector-bucket-name cheapkb-vecs-<account_id>-<region> --index-name default --index-mode ENHANCED
aws s3vectors put-vector-bucket-default-index-mode --vector-bucket-name cheapkb-vecs-<account_id>-<region> --default-index-mode ENHANCED
```

## CI

Merges to `main` deploy through GitHub Actions in the `production` environment, only after the Check, Secrets scan and Proofs jobs pass. The production stage creates a `github-deploy` IAM role that trusts GitHub's OIDC provider for this repository's `production` environment only; the deploy job assumes it with short-lived tokens.

Run the first production deploy locally, since it creates that role. Then set `AWS_ACCOUNT_ID` as a repository secret and the role ARN (the `deployRoleArn` output) as the `AWS_DEPLOY_ROLE_ARN` variable.

CI does not read `.env`. Its configuration is the `env` block in `.github/workflows/deploy.yml`.
