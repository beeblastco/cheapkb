# Billing and usage

## Plans

The deployer defines the default plan and its monthly price and usage allowance. New accounts receive that plan. CheapKB stores plan pricing but does not collect payments.

CheapKB tracks these costs:

| Usage             | Calculation                                                      |
| ----------------- | ---------------------------------------------------------------- |
| Query service     | `$0.000005` per search request                                   |
| Upload service    | `$0.000002` per upload request                                   |
| Ingestion service | `$0.000005` per accepted document                                |
| Embedding model   | Input tokens ÷ 1,000,000 × `EMBEDDING_INPUT_PRICE_PER_1M_TOKENS` |
| Storage           | Stored source-file GiB × time × `$0.023` per GiB-month           |

The progress bar uses their combined cost in the current billing cycle:

```text
progress = spent / monthly allowance × 100
```

At `100%`, new billable activity pauses until the cycle resets or the account receives a larger allowance.

## Storage

Storage is based on the original file bytes accepted by S3. Uploads add bytes, replacements apply the size difference, and API or direct S3 deletions subtract bytes. Each change records the cost accumulated at the previous size before applying the new size.

```text
storage cost = stored GiB × elapsed fraction of a 30-day month × $0.023
```

These values are CheapKB's usage accounting and do not represent the complete AWS bill.
