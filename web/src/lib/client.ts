import type { Document, QueryResult, ResultGroup, ShooIdentity } from "./types";

const SHOO_CALLBACK_PATH = "/shoo/callback";
const SHOO_PKCE_KEY = "shoo_pkce";
const SHOO_PKCE_BACKUP_KEY = "shoo_pkce_backup";
const SHOO_PKCE_MAX_AGE_MS = 10 * 60 * 1000;
const PENDING_DOCUMENTS_KEY = "cheapkb_pending_documents";
const PENDING_DOCUMENT_MAX_AGE_MS = 30 * 60 * 1000;
const API_TIMEOUT_MS = 20000;
const UPLOAD_TIMEOUT_MS = 120000;
const ACTIVE_STATUSES = [
  "UPLOADED",
  "QUEUED",
  "PARSING",
  "PARSED",
  "CHUNKING",
  "CHUNKED",
  "EMBEDDING",
] as const;

interface PkceBundle {
  state: string;
  verifier: string;
}

interface PkceBackup extends PkceBundle {
  createdAt: number;
}

interface UploadMetadata {
  documentId: string;
  uploadUrl: string;
  uploadFields: Record<string, string>;
  maxUploadBytes: number;
}

declare global {
  interface Window {
    Shoo?: {
      getIdentity(): ShooIdentity | null;
      createPkceBundle(): Promise<PkceBundle>;
      startSignIn(opts: { bundle: PkceBundle }): Promise<void>;
      handleCallback(): Promise<void>;
      clearIdentity(): void;
    };
  }
}

export function getIdentity(): ShooIdentity | null {
  try {
    return window.Shoo?.getIdentity() ?? null;
  } catch {
    return null;
  }
}

export async function startSignIn(): Promise<void> {
  if (!window.Shoo) throw new Error("Shoo SDK not loaded");
  const bundle = await window.Shoo.createPkceBundle();
  localStorage.setItem(
    SHOO_PKCE_BACKUP_KEY,
    JSON.stringify({
      state: bundle.state,
      verifier: bundle.verifier,
      createdAt: Date.now(),
    }),
  );
  try {
    await window.Shoo.startSignIn({ bundle });
  } catch (error) {
    localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
    throw error;
  }
}

export function signOut(): void {
  window.Shoo?.clearIdentity();
  localStorage.removeItem("shoo_id_token");
  localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
  window.location.reload();
}

export async function handleSignInCallback(): Promise<boolean> {
  if (window.location.pathname !== SHOO_CALLBACK_PATH) return false;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("code") || !params.has("state")) return false;

  restorePkceVerifier(params.get("state"));
  try {
    await window.Shoo!.handleCallback();
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

export async function apiCall(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!token) throw new Error("Not signed in");
  const apiUrl = import.meta.env.VITE_API_URL ?? "";
  const options: RequestInit = {
    method,
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

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function mergeDocuments(
  currentDocuments: Document[],
  serverDocuments: Document[],
): Document[] {
  const merged: Document[] = [];
  const serverById = new Map(
    serverDocuments.map((document) => [document.documentId, document]),
  );

  for (const document of currentDocuments) {
    const serverDocument = serverById.get(document.documentId);
    if (serverDocument) {
      const localUpdatedAt =
        Date.parse(document.updatedAt ?? document.createdAt ?? "") || 0;
      const serverUpdatedAt =
        Date.parse(
          serverDocument.updatedAt ?? serverDocument.createdAt ?? "",
        ) || 0;
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
    const isRecent = Date.now() - updatedAt < PENDING_DOCUMENT_MAX_AGE_MS;
    if (
      document.documentId.startsWith("temp_") ||
      document.status === "UPLOADING" ||
      document.status === "FAILED" ||
      (isActiveStatus(document.status) && isRecent)
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

export function readPendingDocuments(): Document[] {
  try {
    const documents = JSON.parse(
      localStorage.getItem(PENDING_DOCUMENTS_KEY) ?? "[]",
    );
    if (!Array.isArray(documents)) return [];
    return documents.filter((document: Document) => {
      const updatedAt =
        Date.parse(document.updatedAt ?? document.createdAt ?? "") || 0;
      return (
        !document.documentId.startsWith("temp_") &&
        Date.now() - updatedAt < PENDING_DOCUMENT_MAX_AGE_MS
      );
    });
  } catch {
    localStorage.removeItem(PENDING_DOCUMENTS_KEY);
    return [];
  }
}

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

export function getFileMimeType(file: File): string {
  if (["application/pdf", "text/plain", "text/markdown"].includes(file.type)) {
    return file.type;
  }
  if (file.name.toLowerCase().endsWith(".pdf")) return "application/pdf";
  if (file.name.toLowerCase().endsWith(".txt")) return "text/plain";
  if (file.name.toLowerCase().endsWith(".md")) return "text/markdown";
  return file.type;
}

export async function uploadDocument(
  token: string,
  file: File,
  values: { title: string; tags?: string[]; year?: number; authors?: string[] },
  onProgress: (status: string) => void,
): Promise<string> {
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
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("Failed to upload file to S3");
    onProgress("Starting indexing…");
    await apiCall(token, "POST", "/ingest", {
      documentId: metadata.documentId,
    });
    return metadata.documentId;
  } catch (error) {
    try {
      await apiCall(token, "DELETE", `/documents/${metadata.documentId}`);
    } catch {}
    (error as Error & { documentId?: string }).documentId = metadata.documentId;
    throw error;
  }
}

export async function extractMetadata(
  file: File,
): Promise<{ title: string; year: number | null; authors: string[] }> {
  const fallback = {
    title: file.name.replace(/\.[^/.]+$/, ""),
    year: null as number | null,
    authors: [] as string[],
  };
  try {
    if (getFileMimeType(file) === "application/pdf") {
      return await extractPdfMetadata(file, fallback);
    }
    return parseMetadata(await file.text(), fallback);
  } catch {
    return fallback;
  }
}

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
    const pages: string[] = [];
    for (let index = 1; index <= Math.min(3, pdf.numPages); index += 1) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      pages.push(content.items.filter((item) => "str" in item).map((item) => (item as { str: string }).str).join(" "));
    }
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

function normalizeAuthors(
  authors: string | string[] | undefined,
): string[] {
  if (!authors) return [];
  if (Array.isArray(authors)) {
    return authors.map((author) => author.trim()).filter(Boolean);
  }
  return authors
    .split(/[,;]|\band\b|\//i)
    .map((author) => author.trim())
    .filter(Boolean);
}

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

export function formatDate(value: string | undefined): string {
  if (!value) return "Just now";
  return new Date(value).toLocaleString();
}
