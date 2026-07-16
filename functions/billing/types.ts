export interface Plan {
  planId: string;
  label: string;
  priceMonthlyCents: number;
  monthlyAllowanceCents: number;
}

export interface Account {
  pk: string;
  sk: string;
  entityType: "Account";
  userId: string;
  planId: string;
  priceMonthlyCents: number;
  monthlyAllowanceCents: number;
  storageBytes: number;
  createdAt: string;
  updatedAt: string;
}

export type UsageCategory = "query" | "upload" | "ingest" | "embed";

export interface UsageSummary {
  planId: string;
  planLabel: string;
  priceMonthlyUsd: number;
  allowanceUsd: number;
  spentUsd: number;
  storageUsd: number;
  pctUsed: number;
  paused: boolean;
  resetAt: string;
  storageBytes: number;
}
