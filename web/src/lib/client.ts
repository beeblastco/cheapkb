import type { Badge } from "@/components/ui/badge";
import { createShooAuth, type ShooAuthClient } from "@shoojs/auth";
import type React from "react";
import {
  DEFAULT_TAG_COLOR,
  TAG_COLORS,
  type Document,
  type QueryResult,
  type ResultGroup,
  type ShooIdentity,
  type Tag,
  type TagColor,
  type UsageSummary,
  type UserProfile,
} from "./types";

const SHOO_CALLBACK_PATH = "/shoo/callback";
const SHOO_PKCE_KEY = "shoo_pkce";
const SHOO_PKCE_BACKUP_KEY = "shoo_pkce_backup";
const SHOO_PKCE_MAX_AGE_MS = 10 * 60 * 1000;
const PENDING_DOCUMENTS_KEY = "cheapkb_pending_documents";
const PENDING_DOCUMENT_MAX_AGE_MS = 30 * 60 * 1000;
const FAILED_DOCUMENT_MAX_AGE_MS = 5 * 60 * 1000;
const API_TIMEOUT_MS = 20000;
const UPLOAD_TIMEOUT_MS = 120000;
const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ACTIVE_STATUSES = [
  "UPLOADED",
  "QUEUED",
  "PARSING",
  "PARSED",
  "CHUNKING",
  "CHUNKED",
  "EMBEDDING",
] as const;

interface PkceBackup {
  state: string;
  verifier: string;
  createdAt: number;
}

interface UploadMetadata {
  documentId: string;
  uploadUrl: string;
  uploadFields: Record<string, string>;
  maxUploadBytes: number;
  sourceKey: string;
  reused: boolean;
}

let shooClient: ShooAuthClient | undefined;
let signingOut = false;

/**
 * An expired token counts as signed out, so the app never sends a burst of
 * requests that each come back 401.
 */
export function getIdentity(): ShooIdentity | null {
  try {
    const { token, userId } = shoo().getIdentity();
    if (!token) return null;
    const claims = shoo().decodeIdentityClaims(token);
    if (!claims || claims.exp * 1000 <= Date.now()) {
      shoo().clearIdentity();
      return null;
    }
    return { token: token, userId: userId ?? undefined };
  } catch {
    return null;
  }
}

/** Builds the header profile (name, initials, email, picture) from the token. */
export function getUserProfile(identity: ShooIdentity): UserProfile {
  const fallback = "Account";
  try {
    const [, payload] = identity.token.split(".");
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(
      normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
    );
    const bytes = Uint8Array.from(decoded, (character) =>
      character.charCodeAt(0),
    );
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    const email = String(claims.email || "");
    const name = String(
      claims.name ||
        [claims.given_name, claims.family_name].filter(Boolean).join(" ") ||
        email ||
        fallback,
    );
    return {
      email: email,
      initials: name
        .split(/\s+/)
        .map((part: string) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
      name: name,
      picture: String(claims.picture || ""),
    };
  } catch {
    return {
      email: "",
      initials: "A",
      name: fallback,
      picture: "",
    };
  }
}

/**
 * The verifier is also kept in localStorage, since some browsers drop
 * sessionStorage on the way back from the sign-in page.
 */
export async function startSignIn(): Promise<void> {
  const bundle = await shoo().createPkceBundle();
  const pkce = JSON.stringify({
    state: bundle.state,
    verifier: bundle.verifier,
    createdAt: Date.now(),
  });
  localStorage.setItem(SHOO_PKCE_BACKUP_KEY, pkce);
  sessionStorage.setItem(SHOO_PKCE_KEY, pkce);
  window.location.assign(
    shoo().createSignInUrl({
      state: bundle.state,
      codeChallenge: bundle.challenge,
    }),
  );
}

// Several requests can fail with 401 at once; only the first one reloads.
export function signOut(): void {
  if (signingOut) return;
  signingOut = true;
  shoo().clearIdentity();
  localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
  window.location.reload();
}

// Signs out as soon as Shoo reports that the session was revoked.
export function watchSession(): void {
  if (!getIdentity()) return;
  shoo().startSessionMonitor({ onLoginRequired: () => signOut() });
}

/** Completes sign-in on the callback path; returns true when it handled it. */
export async function handleSignInCallback(): Promise<boolean> {
  if (window.location.pathname !== SHOO_CALLBACK_PATH) return false;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("code") || !params.has("state")) return false;

  restorePkceVerifier(params.get("state"));
  try {
    await shoo().handleCallback();
    localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
    window.location.replace("/");
    return true;
  } catch {
    sessionStorage.removeItem(SHOO_PKCE_KEY);
    localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
    window.history.replaceState(null, "", "/");
    throw new Error("Sign-in expired. Please sign in again.");
  }
}

// Created on first use, because the client reads window.location.
function shoo(): ShooAuthClient {
  shooClient ??= createShooAuth({
    callbackPath: SHOO_CALLBACK_PATH,
    requestPii: true,
  });
  return shooClient;
}

/** Restores the PKCE verifier from its localStorage backup if it matches. */
function restorePkceVerifier(callbackState: string | null): void {
  if (sessionStorage.getItem(SHOO_PKCE_KEY)) return;
  const rawBackup = localStorage.getItem(SHOO_PKCE_BACKUP_KEY);
  if (!rawBackup) return;

  try {
    const backup: PkceBackup = JSON.parse(rawBackup);
    const isValid =
      backup.state === callbackState &&
      typeof backup.verifier === "string" &&
      typeof backup.createdAt === "number" &&
      Date.now() - backup.createdAt <= SHOO_PKCE_MAX_AGE_MS;
    if (isValid) sessionStorage.setItem(SHOO_PKCE_KEY, rawBackup);
    else localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
  } catch {
    localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
  }
}

/**
 * Sends an authenticated JSON request to the API and returns the parsed body.
 * A 401 signs the user out; other failures throw with the server's message.
 */
export async function apiCall(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!token) throw new Error("Not signed in");
  const apiUrl = import.meta.env.VITE_API_URL ?? "";
  const options: RequestInit = {
    method: method,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, options);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("The server took too long to respond. Please retry.");
    }
    throw new Error("Network error. Please check your connection.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) signOut();
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

export async function listTags(token: string): Promise<Tag[]> {
  const data = await apiCall(token, "GET", "/tags");
  return Array.isArray(data.tags) ? (data.tags as Tag[]).map(normalizeTag) : [];
}

export async function createTag(
  token: string,
  name: string,
  color: TagColor = DEFAULT_TAG_COLOR,
): Promise<Tag> {
  const data = await apiCall(token, "POST", "/tags", {
    name: name,
    color: color,
  });
  return normalizeTag(data.tag as Tag);
}

/** Changes a tag's color and returns the updated tag. */
export async function updateTagColor(
  token: string,
  name: string,
  color: TagColor,
): Promise<Tag> {
  const data = await apiCall(
    token,
    "PATCH",
    `/tags/${encodeURIComponent(name)}`,
    { color: color },
  );
  return normalizeTag(data.tag as Tag);
}

// Tags stored before colors existed come back without one.
function normalizeTag(tag: Tag): Tag {
  return {
    ...tag,
    color: TAG_COLORS.includes(tag.color) ? tag.color : DEFAULT_TAG_COLOR,
  };
}

export async function deleteTag(token: string, name: string): Promise<void> {
  await apiCall(token, "DELETE", `/tags/${encodeURIComponent(name)}`);
}

export async function getUsageSummary(token: string): Promise<UsageSummary> {
  const data = await apiCall(token, "GET", "/account/usage");
  return data as unknown as UsageSummary;
}

/** Replaces a document's tags and returns the tags the server saved. */
export async function updateDocumentTags(
  token: string,
  documentId: string,
  tags: string[],
): Promise<string[]> {
  const data = await apiCall(
    token,
    "PATCH",
    `/documents/${encodeURIComponent(documentId)}`,
    { tags: tags },
  );
  return Array.isArray(data.tags) ? (data.tags as string[]) : [];
}

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function getStatusBadgeVariant(
  status: string,
): React.ComponentProps<typeof Badge>["variant"] {
  if (status === "FAILED") return "destructive";
  if (status === "EMBEDDED") return "default";
  if (isActiveStatus(status) || status === "DELETING") return "secondary";
  return "outline";
}

/**
 * Merges the server list with local documents still uploading, failed or
 * being deleted, and saves the pending ones for the next page load.
 */
export function mergeDocuments(
  currentDocuments: Document[],
  serverDocuments: Document[],
): Document[] {
  const merged: Document[] = [];
  const currentById = new Map<string, Document>();
  const serverById = new Map<string, Document>();

  for (const document of currentDocuments) {
    if (!document.documentId.startsWith("temp_")) {
      currentById.set(document.documentId, document);
    }
  }
  for (const document of serverDocuments) {
    serverById.set(document.documentId, document);
  }

  for (const document of currentById.values()) {
    const serverDocument = serverById.get(document.documentId);
    if (serverDocument) {
      const localUpdatedAt =
        Date.parse(document.updatedAt ?? document.createdAt ?? "") || 0;
      const serverUpdatedAt =
        Date.parse(
          serverDocument.updatedAt ?? serverDocument.createdAt ?? "",
        ) || 0;
      if (document.status === "DELETING") {
        const maxAge = FAILED_DOCUMENT_MAX_AGE_MS;
        const isRecent = Date.now() - localUpdatedAt < maxAge;
        if (isRecent) {
          merged.push(document);
          serverById.delete(document.documentId);
        } else {
          merged.push(serverDocument);
          serverById.delete(document.documentId);
        }
        continue;
      }
      const keepLocalFailure =
        document.status === "FAILED" && localUpdatedAt > serverUpdatedAt;
      merged.push(
        keepLocalFailure ? { ...serverDocument, ...document } : serverDocument,
      );
      serverById.delete(document.documentId);
      continue;
    }
    const updatedAt =
      Date.parse(document.updatedAt ?? document.createdAt ?? "") || 0;
    const maxAge =
      document.status === "FAILED"
        ? FAILED_DOCUMENT_MAX_AGE_MS
        : PENDING_DOCUMENT_MAX_AGE_MS;
    const isRecent = Date.now() - updatedAt < maxAge;
    if (
      isRecent &&
      (document.documentId.startsWith("temp_") ||
        document.status === "UPLOADING" ||
        document.status === "FAILED" ||
        isActiveStatus(document.status))
    ) {
      merged.push(document);
    }
  }

  merged.push(...serverById.values());
  const documents = merged.sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );
  writePendingDocuments(documents, serverDocuments);
  return documents;
}

/** Loads pending documents saved by an earlier page load, minus expired ones. */
export function readPendingDocuments(): Document[] {
  try {
    const documents = JSON.parse(
      localStorage.getItem(PENDING_DOCUMENTS_KEY) ?? "[]",
    );
    if (!Array.isArray(documents)) return [];
    return documents.filter((document: Document) => {
      const updatedAt =
        Date.parse(document.updatedAt ?? document.createdAt ?? "") || 0;
      const maxAge =
        document.status === "FAILED"
          ? FAILED_DOCUMENT_MAX_AGE_MS
          : PENDING_DOCUMENT_MAX_AGE_MS;
      return (
        !document.documentId.startsWith("temp_") &&
        Date.now() - updatedAt < maxAge
      );
    });
  } catch {
    localStorage.removeItem(PENDING_DOCUMENTS_KEY);
    return [];
  }
}

/** Saves documents the server doesn't list yet, so a reload still shows them. */
export function writePendingDocuments(
  documents: Document[],
  serverDocuments: Document[] = [],
): void {
  const serverIds = new Set(
    serverDocuments.map((document) => document.documentId),
  );
  const pending = documents.filter(
    (document) =>
      !serverIds.has(document.documentId) &&
      !document.documentId.startsWith("temp_") &&
      ["UPLOADING", "QUEUED", "FAILED"].includes(document.status),
  );
  if (pending.length) {
    localStorage.setItem(PENDING_DOCUMENTS_KEY, JSON.stringify(pending));
  } else {
    localStorage.removeItem(PENDING_DOCUMENTS_KEY);
  }
}

/** Returns the file's MIME type, falling back to its extension. */
export function getFileMimeType(file: File): string {
  if (
    [
      "application/pdf",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
      "text/plain",
      "text/markdown",
    ].includes(file.type)
  ) {
    return file.type;
  }
  const name = file.name.toLowerCase();
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".jpeg") || name.endsWith(".jpg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".md")) return "text/markdown";
  return file.type;
}

/**
 * Uploads a file to S3 and starts indexing, reporting steps via onProgress.
 * On failure it deletes the new document and attaches its id to the error.
 */
export async function uploadDocument(
  token: string,
  file: File,
  values: { title: string; tags?: string[]; year?: number; authors?: string[] },
  onProgress: (status: string) => void,
): Promise<string> {
  const fileError = validateUploadFile(file);
  if (fileError) throw new Error(fileError);
  const metadata: UploadMetadata = (await apiCall(token, "POST", "/upload", {
    filename: file.name,
    mimeType: getFileMimeType(file),
    ...values,
  })) as unknown as UploadMetadata;
  try {
    if (file.size > metadata.maxUploadBytes) {
      throw new Error(
        `File exceeds the ${Math.floor(metadata.maxUploadBytes / 1024 / 1024)} MB limit`,
      );
    }
    onProgress("Uploading file…");
    const body = new FormData();
    for (const [key, value] of Object.entries(metadata.uploadFields)) {
      body.append(key, value);
    }
    body.append("file", file);
    const response = await fetch(metadata.uploadUrl, {
      method: "POST",
      body: body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("Failed to upload file to S3");
    onProgress("Starting indexing…");
    await apiCall(token, "POST", "/ingest", {
      documentId: metadata.documentId,
    });
    return metadata.documentId;
  } catch (error) {
    if (!metadata.reused) {
      try {
        await apiCall(
          token,
          "DELETE",
          `/documents/${encodeURIComponent(metadata.documentId)}`,
        );
      } catch {
        // Best-effort cleanup; the upload error below is the one to report.
      }
    }
    (error as Error & { documentId?: string }).documentId = metadata.documentId;
    throw error;
  }
}

export function validateUploadFile(file: File): string | undefined {
  if (
    getFileMimeType(file).startsWith("image/") &&
    file.size > MAX_IMAGE_UPLOAD_BYTES
  ) {
    return "Image exceeds the 5 MB limit";
  }
  if (file.size > MAX_UPLOAD_BYTES) return "File exceeds the 50 MB limit";
  return undefined;
}

/** Guesses a file's title, year and authors, falling back to its name. */
export async function extractMetadata(
  file: File,
): Promise<{ title: string; year: number | null; authors: string[] }> {
  const fallback = {
    title: file.name.replace(/\.[^/.]+$/, ""),
    year: null as number | null,
    authors: [] as string[],
  };
  try {
    const mimeType = getFileMimeType(file);
    if (mimeType === "application/pdf") {
      return await extractPdfMetadata(file, fallback);
    }
    if (mimeType.startsWith("image/")) return fallback;
    return parseMetadata(await file.text(), fallback);
  } catch {
    return fallback;
  }
}

/** Reads PDF metadata, then the first 3 pages if title or authors are missing. */
async function extractPdfMetadata(
  file: File,
  fallback: { title: string; year: number | null; authors: string[] },
): Promise<{ title: string; year: number | null; authors: string[] }> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url,
  ).href;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() })
    .promise;
  const metadata = await pdf.getMetadata().catch(() => ({}));
  const info = (metadata as { info?: Record<string, string> }).info ?? {};
  let title = info.Title || info.title;
  let authors = info.Author || info.author;
  let year = info.CreationDate?.match(/D:(\d{4})/)?.[1];

  if (!title || !authors) {
    const pages = await Promise.all(
      Array.from({ length: Math.min(3, pdf.numPages) }, async (_, index) => {
        const page = await pdf.getPage(index + 1);
        const content = await page.getTextContent();
        return content.items
          .filter((item) => "str" in item)
          .map((item) => (item as { str: string }).str)
          .join(" ");
      }),
    );
    const parsed = parseMetadata(pages.join("\n"), fallback);
    title ||= parsed.title;
    authors ||= parsed.authors.join(", ");
    year ||= parsed.year?.toString();
  }
  return {
    title: cleanTitle(title || fallback.title),
    authors: normalizeAuthors(authors),
    year: year ? Number(year) : null,
  };
}

/** Picks a title, year and authors out of text, falling back to the defaults. */
function parseMetadata(
  text: string,
  fallback: { title: string; year: number | null; authors: string[] },
): { title: string; year: number | null; authors: string[] } {
  const heading = text.match(/^#\s+(.+)$/m)?.[1];
  const title = text.match(/(?:title|subject)\s*[:-]\s*(.+)/i)?.[1];
  const author =
    text.match(/(?:author|authors)\s*[:-]\s*(.+)/i)?.[1] ??
    text.match(/(?:^|\n)\s*by\s+([^\n]{2,80})(?:\n|$)/i)?.[1];
  const year = text.match(/(?:^|\D)(19\d{2}|20\d{2})(?:\D|$)/)?.[1];
  return {
    title: cleanTitle(title || heading || fallback.title),
    authors: normalizeAuthors(author),
    year: year ? Number(year) : null,
  };
}

function cleanTitle(title: string | undefined): string {
  return title?.trim().replace(/\s+/g, " ").slice(0, 200) ?? "";
}

function normalizeAuthors(authors: string | string[] | undefined): string[] {
  if (!authors) return [];
  if (Array.isArray(authors)) {
    return authors.map((author) => author.trim()).filter(Boolean);
  }
  return authors
    .split(/[,;]|\band\b|\//i)
    .map((author) => author.trim())
    .filter(Boolean);
}

/** Groups query results by document, sorted by each document's best score. */
export function groupResults(results: QueryResult[]): ResultGroup[] {
  const groups = new Map<string, ResultGroup>();
  for (const result of results) {
    const group = groups.get(result.documentId) ?? {
      document: result,
      chunks: [],
      maxScore: 0,
    };
    group.chunks.push(result);
    group.maxScore = Math.max(group.maxScore, result.score || 0);
    groups.set(result.documentId, group);
  }
  return [...groups.values()].sort((a, b) => b.maxScore - a.maxScore);
}

export function centsToUsd(cents: number): number {
  return cents / 100;
}

/** The table shows the date only; the details sheet adds the time. */
export function formatDate(
  value: string | undefined,
  withTime = false,
): string {
  if (!value) return "Just now";
  const date = new Date(value);
  return withTime
    ? date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}
