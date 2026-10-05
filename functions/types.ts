export const DEFAULT_TAG_COLOR = "gray";

export const TAG_COLORS = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

export type DocumentStatus =
  | "UPLOADING"
  | "UPLOADED"
  | "QUEUED"
  | "PARSING"
  | "PARSED"
  | "CHUNKING"
  | "CHUNKED"
  | "EMBEDDING"
  | "EMBEDDED"
  | "DELETING"
  | "FAILED";

export type TagColor = (typeof TAG_COLORS)[number];

export type UsageCategory =
  "query" | "queryResult" | "upload" | "ingest" | "embed";

export interface Account {
  planId: string;
  priceMonthlyCents: number;
  monthlyAllowanceCents: number;
  storageBytes: number;
  storageCostCycleStart?: string;
  storageCostNano?: number;
  storageCostUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountRow extends Account {
  pk: string;
  sk: string;
}

export interface ChunkItem {
  pk: string;
  sk: string;
  pageStart?: number;
  pageEnd?: number;
  tokenCount?: number;
  status?: string;
  text?: string;
}

export interface Document {
  documentId: string;
  title?: string | null;
  status: DocumentStatus | string;
  lastError?: string | null;
  retryCount?: number;
  failedStep?: string | null;
  mimeType?: string | null;
  tags?: string[] | null;
  authors?: string[] | null;
  year?: number | null;
  createdAt?: string;
  updatedAt?: string;
  userId?: string;
  dedupeKey?: string;
  // Set by GET /documents: the upload cap counts this document as processing.
  inFlight?: boolean;
}

export interface DocumentRow {
  pk: string;
  sk: string;
  status: DocumentStatus | string;
  userId: string;
  sourceKey?: string;
  mimeType?: string | null;
  dedupeKey?: string;
  title?: string | null;
  lastError?: string | null;
  retryCount?: number;
  failedStep?: string | null;
  tags?: string[] | null;
  authors?: string[] | null;
  year?: number | null;
  createdAt?: string;
  updatedAt?: string;
  previousStatus?: string;
  replacementToken?: string;
  replacementExpiresAt?: string;
  replacementPreviousStatus?: string;
  pendingFilename?: string;
  pendingTitle?: string;
  pendingTags?: string[] | null;
  pendingAuthors?: string[] | null;
  pendingYear?: number | null;
  filename?: string;
  chunkCount?: number;
  embeddedCount?: number;
  // Set by reindex: chunks created before it are no longer counted as embedded.
  reindexedAt?: string;
  countedBytes?: number;
  dispatchEventId?: string;
  dispatchLeaseUntil?: string;
  dispatchState?: "CLAIMED" | "SENT";
}

// The chunk stage carries each chunk inline, so embedding reads no chunk object.
export interface EmbedMessage {
  stage: "embed";
  documentId: string;
  chunkId: string;
  // The chunk row's createdAt; a message from an earlier chunking no longer matches it.
  createdAt: string;
  modality: "image" | "text";
  text?: string;
  tokenCount?: number;
  pageStart: number;
  pageEnd: number;
}

export interface Plan {
  planId: string;
  label: string;
  priceMonthlyCents: number;
  monthlyAllowanceCents: number;
}

export interface QueryResult {
  documentId: string;
  chunkId: string;
  score: number;
  title?: string;
  modality?: "image" | "text";
  mimeType?: string;
  pageStart?: number;
  pageEnd?: number;
  text?: string;
  source?: { bucket: string; key: string };
}

export interface ResultGroup {
  document: QueryResult;
  chunks: QueryResult[];
  maxScore: number;
}

export interface Tag {
  name: string;
  color: TagColor;
  createdAt?: string;
}

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
