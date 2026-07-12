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

export interface Toast {
  message: string;
  type: "info" | "error" | "success";
}
