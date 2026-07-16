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

export interface Document {
  documentId: string;
  title?: string;
  status: DocumentStatus | string;
  lastError?: string | null;
  retryCount?: number;
  failedStep?: string | null;
  mimeType?: string;
  tags?: string[];
  authors?: string[];
  year?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

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

export type TagColor = (typeof TAG_COLORS)[number];

export const DEFAULT_TAG_COLOR: TagColor = "gray";

export interface Tag {
  name: string;
  color: TagColor;
  createdAt?: string;
}

export interface QueryResult {
  documentId: string;
  chunkId: string;
  score: number;
  title?: string;
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

export interface ShooIdentity {
  token: string;
  userId?: string;
}

export interface UserProfile {
  email: string;
  initials: string;
  name: string;
  picture: string;
}

export interface UploadQueueItem {
  authors: string;
  error: string;
  file: File;
  id: string;
  progress: string;
  state: "EXTRACTING" | "READY" | "SYNCING" | "FAILED";
  tags: string[];
  title: string;
  year: string;
}
