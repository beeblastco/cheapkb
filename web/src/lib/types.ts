import type { Document as ApiDocument } from "../../../functions/types";

export { DEFAULT_TAG_COLOR, TAG_COLORS } from "../../../functions/types";
export type {
  DocumentStatus,
  QueryResult,
  ResultGroup,
  Tag,
  TagColor,
  UsageSummary,
} from "../../../functions/types";

// GET /documents marks each document the upload cap counts as in flight.
export type Document = ApiDocument & { inFlight?: boolean };

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
