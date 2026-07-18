export { DEFAULT_TAG_COLOR, TAG_COLORS } from "../../../functions/types";
export type {
  Account,
  Document,
  DocumentStatus,
  Plan,
  QueryResult,
  ResultGroup,
  Tag,
  TagColor,
  UsageSummary,
} from "../../../functions/types";

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
