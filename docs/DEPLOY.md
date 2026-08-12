# Deploy

Copy `.env.example` to `.env`, set `AWS_ACCOUNT_ID` to the deployment account, and review the optional model, pricing, and cross-account values.

```bash
aws sts get-caller-identity --query Account --output text
npx sst deploy --stage production
```

The caller account must match `AWS_ACCOUNT_ID`. The deployment output includes the API and web addresses.

The deployer owns plan configuration. Update the seeded default plan in `sst.config.ts` and deploy; existing accounts use its current price and allowance, and accounts on a removed plan fall back to it. Users cannot create or assign plans through the API.

## Bedrock

`BEDROCK_EMBEDDING_MODEL` defaults to `us.cohere.embed-v4:0`. Enable access to Cohere Embed v4 in Amazon Bedrock before deploying.

For Bedrock in another AWS account, set `BEDROCK_ASSUME_ROLE_ARN` and `BEDROCK_ASSUME_ROLE_EXTERNAL_ID`. The target role must trust the deployment account and permit Cohere Embed v4 invocation in the deployment region.

Production keeps short-lived Bedrock diagnostic logs in S3. Enable logging in the Bedrock account when using cross-account inference.

## CI

Merges to `main` deploy through GitHub Actions. Configure `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_ACCOUNT_ID` as repository secrets.
