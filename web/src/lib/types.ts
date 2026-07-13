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
  mimeType?: string;
  tags?: string[];
  authors?: string[];
  lastError?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface QueryResult {
  documentId: string;
  title?: string;
  score?: number;
  text?: string;
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
  tags: string;
  title: string;
  year: string;
}

export interface Toast {
  message: string;
  type: "info" | "error" | "success";
}
