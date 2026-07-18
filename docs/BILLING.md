# Billing and usage

## Plans

Billing plans are stored in a dedicated DynamoDB table (`pk: "PLAN#<planId>"`, `sk: "PLAN"`) and seeded at deploy time from `SEED_PLANS` in `sst.config.ts`. The default plan id is injected as `DEFAULT_PLAN_ID`. There is no hardcoded plan list in the functions; all reads and writes go through the database.

## Usage cycles

Usage cycles are anchored to each account's creation timestamp and advance by whole calendar months (a day-29 to 31 anchor clamps to the last day of shorter months, and the UTC time of day is preserved on every boundary).

Usage events are written per day under `sk: "USAGE#<yyyy-mm-dd>"` with a 90-day TTL, and `/account/usage` sums the current cycle plus prorated storage cost to decide when the account is paused. DynamoDB TTL is enabled on the accounts table so expired usage rows are reaped automatically; `PROFILE` rows carry no `ttl` attribute and are never expired.

## Storage accounting

Storage is tracked as a running `storageBytes` total on the account. Each document records the size it was charged (`countedBytes`), so a re-ingest or replacement upload only applies the size delta and a delete subtracts exactly what was counted. Costs are accounted in nano-USD internally and exposed as USD on the `/account/usage` response.
