// Costs are tracked in integer nano-USD (1e-9 USD) to avoid
// floating-point drift. Rates approximate blended AWS costs.

export const NANO_PER_USD = 1_000_000_000;
export const NANO_PER_CENT = NANO_PER_USD / 100; // 10_000_000

// Approximate AWS costs per billable unit (nano-USD).
export const PRICING = {
  // One query: API Gateway + Lambda + S3 Vectors query + S3 GetObject.
  queryPerRequest: 5_000,

  // One upload: API Gateway + Lambda + DynamoDB + S3 PutObject.
  uploadPerRequest: 2_000,

  // Ingest pipeline for one document: parse + chunk + embed Lambdas,
  // SQS, S3 reads/writes, and S3 Vectors PutVectors overhead.
  ingestPerDocument: 5_000,

  // Per chunk embedded: embedding Lambda + S3 + S3 Vectors PutVectors.
  embedPerChunk: 500,

  // Storage: S3 + S3 Vectors blended cost per GB per month.
  // $0.023 / GB / month.
  storagePerGbMonth: 23_000_000,
} as const;

export interface Plan {
  planId: string;
  label: string;
  priceMonthlyCents: number;
  monthlyAllowanceCents: number;
}

// Basic is free with a small monthly subsidy.
// Pro is paid and includes a larger usable allowance.
export const PLANS: Record<string, Plan> = {
  basic: {
    planId: "basic",
    label: "Basic",
    priceMonthlyCents: 0,
    monthlyAllowanceCents: 100,
  },
  pro: {
    planId: "pro",
    label: "Pro",
    priceMonthlyCents: 500,
    monthlyAllowanceCents: 400,
  },
} as const;

export const DEFAULT_PLAN = PLANS.basic;

export function centsToNanoUsd(cents: number): number {
  return cents * NANO_PER_CENT;
}

export function nanoUsdToUsd(nano: number): number {
  return nano / NANO_PER_USD;
}

export function nanoUsdToCents(nano: number): number {
  return Math.floor(nano / NANO_PER_CENT);
}

// Seconds in a 30-day month, used for prorated storage cost.
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;

export function storageCostNanoUsd(bytes: number, seconds: number): number {
  const gb = bytes / (1024 * 1024 * 1024);
  const prorated = (seconds / SECONDS_PER_MONTH) * gb;
  return Math.round(prorated * PRICING.storagePerGbMonth);
}
