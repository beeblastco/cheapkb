# Deploy

## Credentials and account pinning

Configure AWS credentials the usual way (a named profile via `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). Set `AWS_ACCOUNT_ID` in `.env` to pin deploys: when it is set, `sst.config.ts` verifies the caller identity and refuses to deploy to any other account, because resource names embed the account id and a wrong caller would silently build a parallel stack. Leave `AWS_ACCOUNT_ID` unset to deploy to whatever account your credentials resolve to.

## Manual deploy

```bash
npx sst deploy --stage production
```

After deployment, SST prints both the API endpoint (`apiEndpoint`) and the web endpoint (`webEndpoint`). The API URL is baked into the frontend build, and the frontend URL is used as `APP_ORIGIN` for JWT verification.

## Continuous deployment

Production deploys through `.github/workflows/deploy.yml` after changes merge to `main`. The check job formats, typechecks, tests, builds the frontend, and audits production dependencies before the deploy job runs `sst deploy --stage production`. GitHub Actions configures AWS credentials from repository secrets and verifies the caller matches the `AWS_ACCOUNT_ID` secret immediately before deployment.

Required repository secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ACCOUNT_ID`, `EMBEDDING_PROVIDER_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`.

## First deploy notes

After the first deployment of tenant-scoped vector metadata, reindex existing embedded documents once from the UI. Old vectors without `userId` metadata are intentionally excluded from search until they are overwritten.
