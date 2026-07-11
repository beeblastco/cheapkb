const API_URL = globalThis.APP_CONFIG?.apiUrl ?? "";
const SHOO_CALLBACK_PATH = "/shoo/callback";
const SHOO_PKCE_KEY = "shoo_pkce";
const SHOO_PKCE_BACKUP_KEY = "shoo_pkce_backup";
const SHOO_PKCE_MAX_AGE_MS = 10 * 60 * 1000;
const PENDING_DOCUMENTS_KEY = "cheapkb_pending_documents";
const PENDING_DOCUMENT_MAX_AGE_MS = 30 * 60 * 1000;
const API_TIMEOUT_MS = 20000;
const UPLOAD_TIMEOUT_MS = 120000;

const STATUS_COLORS = {
  EMBEDDED: "bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20",
  FAILED: "bg-rose-500/10 text-rose-400 ring-1 ring-rose-500/20",
  UPLOADED: "bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20",
  QUEUED: "bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20",
  PARSING: "bg-indigo-500/10 text-indigo-300 ring-1 ring-indigo-500/20",
  PARSED: "bg-indigo-500/10 text-indigo-300 ring-1 ring-indigo-500/20",
  CHUNKING: "bg-indigo-500/10 text-indigo-300 ring-1 ring-indigo-500/20",
  CHUNKED: "bg-indigo-500/10 text-indigo-300 ring-1 ring-indigo-500/20",
  EMBEDDING: "bg-indigo-500/10 text-indigo-300 ring-1 ring-indigo-500/20",
};

const BTN_BASE = "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors";
const BTN_SECONDARY = `${BTN_BASE} border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800`;
const BTN_DANGER = `${BTN_BASE} bg-rose-500/10 text-rose-400 hover:bg-rose-500/20`;
const BTN_WARNING = `${BTN_BASE} bg-amber-500/10 text-amber-300 hover:bg-amber-500/20`;
const BTN_DISABLED = "disabled:opacity-50 disabled:cursor-not-allowed";

const ACTIVE_STATUSES = [
  "UPLOADED",
  "QUEUED",
  "PARSING",
  "PARSED",
  "CHUNKING",
  "CHUNKED",
  "EMBEDDING",
];
const STATUS_LABELS = {
  UPLOADING: "Uploading",
  UPLOADED: "Uploaded",
  QUEUED: "Waiting",
  PARSING: "Reading",
  PARSED: "Read",
  CHUNKING: "Splitting",
  CHUNKED: "Split",
  EMBEDDING: "Indexing",
  EMBEDDED: "Ready",
  FAILED: "Needs attention",
};
const STATUS_PROGRESS = {
  UPLOADING: 12,
  UPLOADED: 20,
  QUEUED: 28,
  PARSING: 42,
  PARSED: 55,
  CHUNKING: 68,
  CHUNKED: 78,
  EMBEDDING: 88,
  EMBEDDED: 100,
};
const STALLED_AFTER_MS = 5 * 60 * 1000;

const state = {
  token: null,
  userId: null,
  documents: [],
  loading: false,
  pollTimer: null,
  isUploading: false,
};

const els = {
  signinBtn: document.getElementById("signin-btn"),
  heroSigninBtn: document.getElementById("hero-signin-btn"),
  signoutBtn: document.getElementById("signout-btn"),
  userPill: document.getElementById("user-pill"),
  guestState: document.getElementById("guest-state"),
  appState: document.getElementById("app-state"),
  uploadForm: document.getElementById("upload-form"),
  uploadFile: document.getElementById("upload-file"),
  uploadDropZone: document.getElementById("upload-drop-zone"),
  uploadFileName: document.getElementById("upload-file-name"),
  uploadStatus: document.getElementById("upload-status"),
  extractStatus: document.getElementById("extract-status"),
  documentsList: document.getElementById("documents-list"),
  documentsEmpty: document.getElementById("documents-empty"),
  queryForm: document.getElementById("query-form"),
  queryInput: document.getElementById("query-input"),
  queryTopk: document.getElementById("query-topk"),
  queryResults: document.getElementById("query-results"),
  detailModal: document.getElementById("detail-modal"),
  detailClose: document.getElementById("detail-close"),
  detailTitle: document.getElementById("detail-title"),
  detailBody: document.getElementById("detail-body"),
};

function getIdentity() {
  if (typeof window.Shoo === "undefined") return null;
  try {
    return window.Shoo.getIdentity();
  } catch {
    return null;
  }
}

async function startSignIn() {
  if (typeof window.Shoo === "undefined") {
    showToast("Shoo SDK not loaded", "error");
    return;
  }
  try {
    const bundle = await window.Shoo.createPkceBundle();
    localStorage.setItem(
      SHOO_PKCE_BACKUP_KEY,
      JSON.stringify({
        state: bundle.state,
        verifier: bundle.verifier,
        createdAt: Date.now(),
      }),
    );
    await window.Shoo.startSignIn({ bundle });
  } catch {
    localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
    showToast("Could not start sign-in. Please try again.", "error");
  }
}

function signOut() {
  if (typeof window.Shoo !== "undefined") {
    window.Shoo.clearIdentity();
  }
  state.token = null;
  state.userId = null;
  clearPollTimer();
  localStorage.removeItem("shoo_id_token");
  localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
  window.location.reload();
}

function clearPollTimer() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function updateAuthUI() {
  const identity = getIdentity();
  if (identity?.token) {
    state.token = identity.token;
    state.userId = identity.userId ?? null;
    els.signinBtn.classList.add("hidden");
    els.signoutBtn.classList.remove("hidden");
    els.userPill.textContent = identity.userId
      ? `Signed in as ${identity.userId.slice(0, 12)}...`
      : "Signed in";
    els.userPill.classList.remove("hidden");
    els.guestState.classList.add("hidden");
    els.appState.classList.remove("hidden");
    state.documents = readPendingDocuments();
    renderDocuments();
    loadDocuments(true);
  } else {
    state.token = null;
    state.userId = null;
    els.signinBtn.classList.remove("hidden");
    els.signoutBtn.classList.add("hidden");
    els.userPill.classList.add("hidden");
    els.guestState.classList.remove("hidden");
    els.appState.classList.add("hidden");
  }
}

async function apiCall(method, path, body) {
  if (!state.token) throw new Error("Not signed in");
  const url = `${API_URL.replace(/\/$/, "")}${path}`;
  const options = {
    method,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, options);
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new Error("The server took too long to respond. Please retry.");
    }
    throw new Error("Network error. Please check your connection.");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      signOut();
      throw new Error("Session expired. Please sign in again.");
    }
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function statusClass(status) {
  return STATUS_COLORS[status] ?? "bg-zinc-800 text-zinc-300";
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

function isStalled(doc) {
  const updatedAt = Date.parse(doc.updatedAt ?? doc.createdAt ?? "") || 0;
  return (
    isActiveStatus(doc.status) && Date.now() - updatedAt > STALLED_AFTER_MS
  );
}

function formatDate(value) {
  if (!value) return "Just now";
  return new Date(value).toLocaleString();
}

function renderDocuments() {
  els.documentsList.innerHTML = "";
  if (!state.documents.length) {
    els.documentsEmpty.classList.remove("hidden");
    return;
  }
  els.documentsEmpty.classList.add("hidden");

  for (const doc of state.documents) {
    const isOptimistic = doc.documentId.startsWith("temp_");
    const card = document.createElement("div");
    card.className =
      "py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-opacity duration-200";
    card.dataset.id = doc.documentId;
    card.innerHTML = renderDocumentCard(doc, isOptimistic);
    els.documentsList.appendChild(card);
  }
}

function renderDocumentCard(doc, isOptimistic) {
  const stalled = isStalled(doc);
  const errorHtml = doc.lastError
    ? `<p class="mt-2 text-xs text-rose-300">${escapeHtml(doc.lastError)}</p>`
    : "";
  const progress = STATUS_PROGRESS[doc.status] ?? 0;
  const progressHtml = isActiveStatus(doc.status)
    ? `<div class="mt-3 h-1 overflow-hidden rounded-full bg-zinc-800"><div class="h-full rounded-full ${stalled ? "bg-amber-400" : "bg-indigo-400"}" style="width:${progress}%"></div></div>`
    : "";

  const reindexButton =
    !isOptimistic && (!isActiveStatus(doc.status) || stalled)
      ? `<button data-action="reindex" data-id="${escapeHtml(doc.documentId)}" class="${BTN_WARNING}">${stalled ? "Restart" : "Reindex"}</button>`
      : "";

  return `
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2">
        <h3 class="font-medium text-zinc-100 truncate">${escapeHtml(doc.title || doc.documentId)}</h3>
        <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(doc.status)}">${escapeHtml(stalled ? "Delayed" : STATUS_LABELS[doc.status] || doc.status)}</span>
      </div>
      <p class="text-xs text-zinc-500 mt-1 truncate">${escapeHtml(doc.mimeType || "")} &middot; ${escapeHtml(formatDate(doc.createdAt))}</p>
      ${errorHtml}
      ${progressHtml}
    </div>
    <div class="flex items-center gap-2">
      <button data-action="view" data-id="${escapeHtml(doc.documentId)}" ${isOptimistic ? "disabled" : ""} class="${BTN_SECONDARY} ${BTN_DISABLED}">View</button>
      ${reindexButton}
      <button data-action="delete" data-id="${escapeHtml(doc.documentId)}" ${isOptimistic ? "disabled" : ""} class="${BTN_DANGER} ${BTN_DISABLED}">Delete</button>
    </div>
  `;
}

function mergeDocuments(serverDocuments) {
  const merged = [];
  const serverById = new Map(
    serverDocuments.map((doc) => [doc.documentId, doc]),
  );

  for (const doc of state.documents) {
    const serverDoc = serverById.get(doc.documentId);
    if (serverDoc) {
      const localUpdatedAt =
        Date.parse(doc.updatedAt ?? doc.createdAt ?? "") || 0;
      const serverUpdatedAt =
        Date.parse(serverDoc.updatedAt ?? serverDoc.createdAt ?? "") || 0;
      const keepLocalFailure =
        doc.status === "FAILED" && localUpdatedAt > serverUpdatedAt;
      merged.push(keepLocalFailure ? { ...serverDoc, ...doc } : serverDoc);
      serverById.delete(doc.documentId);
      continue;
    }
    const updatedAt = Date.parse(doc.updatedAt ?? doc.createdAt ?? "") || 0;
    const isRecent = Date.now() - updatedAt < PENDING_DOCUMENT_MAX_AGE_MS;
    if (
      doc.documentId.startsWith("temp_") ||
      doc.status === "UPLOADING" ||
      doc.status === "FAILED" ||
      (isActiveStatus(doc.status) && isRecent)
    ) {
      merged.push(doc);
    }
  }

  for (const doc of serverById.values()) {
    merged.push(doc);
  }

  const documents = merged.sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );
  writePendingDocuments(documents, serverDocuments);
  return documents;
}

function readPendingDocuments() {
  try {
    const documents = JSON.parse(localStorage.getItem(PENDING_DOCUMENTS_KEY));
    if (!Array.isArray(documents)) return [];
    return documents.filter((doc) => {
      const updatedAt = Date.parse(doc.updatedAt ?? doc.createdAt ?? "") || 0;
      return Date.now() - updatedAt < PENDING_DOCUMENT_MAX_AGE_MS;
    });
  } catch {
    localStorage.removeItem(PENDING_DOCUMENTS_KEY);
    return [];
  }
}

function writePendingDocuments(documents, serverDocuments = []) {
  const serverIds = new Set(serverDocuments.map((doc) => doc.documentId));
  const pending = documents.filter(
    (doc) =>
      !serverIds.has(doc.documentId) &&
      (doc.documentId.startsWith("temp_") ||
        doc.status === "UPLOADING" ||
        doc.status === "QUEUED" ||
        doc.status === "FAILED"),
  );
  if (pending.length) {
    localStorage.setItem(PENDING_DOCUMENTS_KEY, JSON.stringify(pending));
  } else {
    localStorage.removeItem(PENDING_DOCUMENTS_KEY);
  }
}

function handleDocumentAction(e) {
  const button = e.target.closest("[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  const id = button.dataset.id;
  if (!id) return;

  if (action === "view") showDetail(id);
  if (action === "reindex") reindexDocument(id);
  if (action === "delete") deleteDocument(id);
}

function renderDocumentsSkeleton() {
  els.documentsEmpty.classList.add("hidden");
  els.documentsList.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const card = document.createElement("div");
    card.className =
      "py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-pulse";
    card.innerHTML = `
      <div class="flex-1 min-w-0 space-y-2">
        <div class="h-4 w-1/3 rounded bg-zinc-800"></div>
        <div class="h-3 w-1/2 rounded bg-zinc-800"></div>
      </div>
      <div class="flex items-center gap-2">
        <div class="h-7 w-12 rounded bg-zinc-800"></div>
        <div class="h-7 w-14 rounded bg-zinc-800"></div>
      </div>
    `;
    els.documentsList.appendChild(card);
  }
}

function renderQuerySkeleton() {
  els.queryResults.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const row = document.createElement("div");
    row.className =
      "rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 animate-pulse space-y-2";
    row.innerHTML = `
      <div class="h-4 w-1/3 rounded bg-zinc-800"></div>
      <div class="h-3 w-full rounded bg-zinc-800"></div>
      <div class="h-3 w-5/6 rounded bg-zinc-800"></div>
    `;
    els.queryResults.appendChild(row);
  }
}

async function loadDocuments(showSkeleton = true) {
  if (showSkeleton && state.documents.length === 0) {
    renderDocumentsSkeleton();
  }
  try {
    const data = await apiCall("GET", "/documents");
    state.documents = mergeDocuments(data.documents || []);
    renderDocuments();
    schedulePolling();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function schedulePolling() {
  const hasActive = state.documents.some((d) => isActiveStatus(d.status));
  if (hasActive && !state.pollTimer) {
    state.pollTimer = setInterval(pollDocuments, 3000);
  } else if (!hasActive && state.pollTimer) {
    clearPollTimer();
  }
}

async function pollDocuments() {
  try {
    const data = await apiCall("GET", "/documents");
    state.documents = mergeDocuments(data.documents || []);
    renderDocuments();
    if (!state.documents.some((d) => isActiveStatus(d.status))) {
      clearPollTimer();
    }
  } catch (err) {
    console.warn("[poll] failed to refresh documents:", err.message);
  }
}

async function showDetail(id) {
  try {
    const data = await apiCall("GET", `/documents/${id}`);
    const doc = data.document;
    els.detailTitle.textContent = doc.title || doc.documentId;
    els.detailBody.innerHTML = renderDetailBody(doc, data.chunkCount);
    els.detailModal.classList.remove("hidden");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function renderDetailBody(doc, chunkCount) {
  const tags = Array.isArray(doc.tags) ? doc.tags.join(", ") : doc.tags;
  const authors = Array.isArray(doc.authors)
    ? doc.authors.join(", ")
    : doc.authors;

  return `
    <div class="grid grid-cols-2 gap-4">
      <div><span class="text-slate-500">ID</span><p class="font-mono text-xs break-all">${escapeHtml(doc.documentId)}</p></div>
      <div><span class="text-slate-500">Status</span><p>${escapeHtml(doc.status)}</p></div>
      <div><span class="text-slate-500">MIME type</span><p>${escapeHtml(doc.mimeType)}</p></div>
      <div><span class="text-slate-500">Chunks</span><p>${Number(chunkCount) || 0}</p></div>
      <div><span class="text-slate-500">Created</span><p>${escapeHtml(formatDate(doc.createdAt))}</p></div>
      <div><span class="text-slate-500">Updated</span><p>${escapeHtml(formatDate(doc.updatedAt))}</p></div>
      ${tags ? `<div class="col-span-2"><span class="text-slate-500">Tags</span><p>${escapeHtml(tags)}</p></div>` : ""}
      ${authors ? `<div class="col-span-2"><span class="text-slate-500">Authors</span><p>${escapeHtml(authors)}</p></div>` : ""}
      ${doc.lastError ? `<div class="col-span-2"><span class="text-slate-500">Last error</span><p class="text-rose-600">${escapeHtml(doc.lastError)}</p></div>` : ""}
    </div>
  `;
}

async function reindexDocument(id) {
  const doc = state.documents.find((d) => d.documentId === id);
  const originalStatus = doc?.status;
  if (doc) {
    doc.status = "QUEUED";
    doc.lastError = null;
    renderDocuments();
  }
  try {
    const data = await apiCall("POST", `/documents/${id}/reindex`);
    showToast(data.message || "Reindex started", "success");
    await loadDocuments(false);
  } catch (err) {
    if (doc) {
      doc.status = originalStatus ?? "FAILED";
      doc.lastError = err.message;
      renderDocuments();
    }
    showToast(err.message, "error");
  }
}

async function deleteDocument(id) {
  if (!confirm("Delete this document and all its data?")) return;
  const index = state.documents.findIndex((d) => d.documentId === id);
  const removed = index >= 0 ? state.documents.splice(index, 1)[0] : null;
  writePendingDocuments(state.documents);
  renderDocuments();
  try {
    await apiCall("DELETE", `/documents/${id}`);
    showToast("Document deleted", "success");
  } catch (err) {
    if (removed) {
      state.documents.splice(index, 0, removed);
      writePendingDocuments(state.documents);
      renderDocuments();
    }
    showToast(err.message, "error");
  }
}

function getUploadFormValues(file) {
  const title =
    document.getElementById("upload-title").value.trim() || file.name;
  const tags = document
    .getElementById("upload-tags")
    .value.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const year =
    parseInt(document.getElementById("upload-year").value, 10) || undefined;
  const authors = document
    .getElementById("upload-authors")
    .value.split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    title,
    tags: tags.length ? tags : undefined,
    year,
    authors: authors.length ? authors : undefined,
  };
}

async function handleUpload(e) {
  e.preventDefault();
  if (state.isUploading) return;
  const file = els.uploadFile.files[0];
  if (!file) return;

  state.isUploading = true;
  const formValues = getUploadFormValues(file);
  const submitBtn = document.getElementById("upload-submit");
  const originalBtnText = submitBtn.textContent;

  setButtonLoading(submitBtn, true);
  setUploadFormDisabled(true);
  els.uploadStatus.textContent = "Requesting upload URL...";
  clearPollTimer();

  const tempId = `temp_${Date.now()}`;
  const optimisticDoc = {
    documentId: tempId,
    title: formValues.title,
    status: "UPLOADING",
    mimeType: getFileMimeType(file),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.documents.unshift(optimisticDoc);
  writePendingDocuments(state.documents);
  renderDocuments();

  let createdDocumentId = null;
  try {
    const meta = await apiCall("POST", "/upload", {
      filename: file.name,
      mimeType: getFileMimeType(file),
      ...formValues,
    });

    createdDocumentId = meta.documentId;
    optimisticDoc.documentId = meta.documentId;
    optimisticDoc.updatedAt = new Date().toISOString();
    writePendingDocuments(state.documents);
    renderDocuments();

    els.uploadStatus.textContent = "Uploading file...";
    if (file.size > meta.maxUploadBytes) {
      throw new Error(
        `File exceeds the ${Math.floor(meta.maxUploadBytes / 1024 / 1024)} MB limit`,
      );
    }
    const uploadBody = new FormData();
    for (const [key, value] of Object.entries(meta.uploadFields)) {
      uploadBody.append(key, value);
    }
    uploadBody.append("file", file);
    const putRes = await fetch(meta.uploadUrl, {
      method: "POST",
      body: uploadBody,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!putRes.ok) throw new Error("Failed to upload file to S3");

    els.uploadStatus.textContent = "Starting indexing…";
    await apiCall("POST", "/ingest", { documentId: meta.documentId });
    optimisticDoc.status = "QUEUED";
    optimisticDoc.updatedAt = new Date().toISOString();
    writePendingDocuments(state.documents);
    renderDocuments();

    showToast("Uploaded. Indexing has started.", "success");
    resetUploadForm();
    await loadDocuments(false);
  } catch (err) {
    if (createdDocumentId) {
      try {
        await apiCall("DELETE", `/documents/${createdDocumentId}`);
      } catch {}
    }
    const idx = state.documents.findIndex(
      (d) => d.documentId === tempId || d.documentId === createdDocumentId,
    );
    if (idx >= 0) {
      state.documents[idx] = {
        ...state.documents[idx],
        documentId: failedDocumentId,
        status: "FAILED",
        lastError: err.message,
        updatedAt: new Date().toISOString(),
      };
    } else {
      state.documents.unshift({
        ...optimisticDoc,
        documentId: failedDocumentId,
        status: "FAILED",
        lastError: err.message,
        updatedAt: new Date().toISOString(),
      });
    }
    renderDocuments();
    writePendingDocuments(state.documents);
    els.uploadStatus.textContent = "";
    showToast(err.message, "error");
  } finally {
    state.isUploading = false;
    setButtonLoading(submitBtn, false, originalBtnText);
    setUploadFormDisabled(false);
    schedulePolling();
  }
}

function resetUploadForm() {
  els.uploadForm.reset();
  els.uploadFileName.classList.add("hidden");
  els.uploadFileName.textContent = "";
  els.extractStatus.classList.add("hidden");
  els.extractStatus.textContent = "";
}

function getFileMimeType(file) {
  if (file.type === "application/pdf") return file.type;
  if (file.type === "text/plain") return file.type;
  if (file.type === "text/markdown") return file.type;
  if (file.name.toLowerCase().endsWith(".pdf")) return "application/pdf";
  if (file.name.toLowerCase().endsWith(".txt")) return "text/plain";
  if (file.name.toLowerCase().endsWith(".md")) return "text/markdown";
  return file.type;
}

async function handleQuery(e) {
  e.preventDefault();
  const query = els.queryInput.value.trim();
  const topK = parseInt(els.queryTopk.value, 10) || 5;
  if (!query) return;

  const submitBtn = document.getElementById("query-submit");
  const originalBtnText = submitBtn.textContent;
  setButtonLoading(submitBtn, true);
  els.queryInput.disabled = true;
  renderQuerySkeleton();

  try {
    const data = await apiCall("POST", "/query", { query, topK });
    renderQueryResults(data);
  } catch (err) {
    els.queryResults.innerHTML = `<p class="text-sm text-rose-600">${escapeHtml(err.message)}</p>`;
  } finally {
    setButtonLoading(submitBtn, false, originalBtnText);
    els.queryInput.disabled = false;
  }
}

function renderQueryResults(data) {
  if (!data.results?.length) {
    els.queryResults.innerHTML = `<p class="text-sm text-slate-500">No results.</p>`;
    return;
  }

  const groups = groupResultsByDocument(data.results);
  els.queryResults.innerHTML = `<p class="text-xs text-slate-500">${data.results.length} results across ${groups.length} documents</p>`;

  for (const g of groups) {
    els.queryResults.appendChild(renderQueryGroup(g));
  }
}

function groupResultsByDocument(results) {
  const map = new Map();
  for (const r of results) {
    if (!map.has(r.documentId)) {
      map.set(r.documentId, { doc: r, chunks: [], maxScore: 0 });
    }
    const g = map.get(r.documentId);
    g.chunks.push(r);
    g.maxScore = Math.max(g.maxScore, r.score || 0);
  }
  return Array.from(map.values()).sort((a, b) => b.maxScore - a.maxScore);
}

function renderQueryGroup(g) {
  g.chunks.sort((a, b) => (b.score || 0) - (a.score || 0));

  const details = document.createElement("details");
  details.className =
    "rounded-lg border border-zinc-800 bg-zinc-950/50 overflow-hidden";
  details.open = true;

  const summary = document.createElement("summary");
  summary.className =
    "cursor-pointer list-none bg-zinc-900 px-3 py-2 flex items-center justify-between hover:bg-zinc-800 transition-colors";
  summary.innerHTML = `
    <span class="text-sm font-medium text-zinc-200">${escapeHtml(g.doc.title || g.doc.documentId)}</span>
    <span class="text-xs text-slate-500">best score ${g.maxScore.toFixed(3)} · ${g.chunks.length} chunk${g.chunks.length === 1 ? "" : "s"}</span>
  `;

  const body = document.createElement("div");
  body.className = "divide-y divide-zinc-800";
  for (const c of g.chunks) {
    body.appendChild(renderQueryChunk(c));
  }

  details.appendChild(summary);
  details.appendChild(body);
  return details;
}

function renderQueryChunk(c) {
  const row = document.createElement("div");
  row.className = "p-3";
  row.innerHTML = `
    <div class="flex items-center justify-between mb-1">
      <span class="text-xs text-slate-500">score ${(c.score || 0).toFixed(3)}</span>
    </div>
    <p class="text-sm text-zinc-300">${escapeHtml(c.text || "")}</p>
  `;
  return row;
}

function setUploadFormDisabled(disabled) {
  const fields = [
    "upload-file",
    "upload-title",
    "upload-tags",
    "upload-year",
    "upload-authors",
  ];
  for (const id of fields) {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  }
  if (els.uploadDropZone) {
    els.uploadDropZone.classList.toggle("pointer-events-none", disabled);
    els.uploadDropZone.classList.toggle("opacity-50", disabled);
  }
}

function setButtonLoading(btn, loading, text = "") {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.dataset.originalText = text || btn.textContent;
    btn.textContent = text || "Working…";
    btn.classList.add("is-working");
  } else {
    btn.disabled = false;
    btn.textContent = text || btn.dataset.originalText || "Submit";
    btn.classList.remove("is-working");
  }
}

function showToast(message, type = "info") {
  const color =
    type === "error"
      ? "bg-rose-600"
      : type === "success"
        ? "bg-emerald-600"
        : "bg-indigo-600";
  const toast = document.createElement("div");
  toast.className = `fixed bottom-4 right-4 ${color} text-white px-4 py-2 rounded-lg shadow-lg text-sm transition-opacity duration-300`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("opacity-0");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function extractMetadata(file) {
  const filename = file.name.replace(/\.[^/.]+$/, "");
  const fallback = { title: filename, year: null, authors: [] };

  try {
    if (
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf")
    ) {
      return await extractPdfMetadata(file, fallback);
    }

    const text = await file.text();
    return parseMetadata(text, fallback);
  } catch (err) {
    console.warn("[metadata] extraction failed:", err);
    return fallback;
  }
}

async function extractPdfMetadata(file, fallback) {
  await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const meta = await pdf.getMetadata().catch(() => ({}));
  const info = meta.info ?? {};

  let title = info.Title || info.title;
  let authors = info.Author || info.author;
  let year = null;

  const creationDate = info.CreationDate;
  if (creationDate && typeof creationDate === "string") {
    const match = creationDate.match(/D:(\d{4})/);
    if (match) year = parseInt(match[1], 10);
  }

  if (!title || !authors) {
    const pageText = await extractPdfPageText(pdf, 3);
    const parsed = parseMetadata(pageText, fallback);
    if (!title) title = parsed.title;
    if (!authors) authors = parsed.authors;
    if (!year && parsed.year) year = parsed.year;
  }

  return {
    title: cleanTitle(title || fallback.title),
    authors: normalizeAuthors(authors),
    year,
  };
}

async function extractPdfPageText(pdf, maxPages) {
  const pages = [];
  const count = Math.min(maxPages, pdf.numPages);
  for (let i = 1; i <= count; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item) => item.str).join(" ");
    pages.push(text);
  }
  return pages.join("\n");
}

function parseMetadata(text, fallback) {
  const result = { title: null, authors: [], year: null };

  const headingMatch = text.match(/^#\s+(.+)$/m);
  const titleLineMatch = text.match(/(?:title|subject)\s*[:\-]\s*(.+)/i);
  const bylineMatch = text.match(/(?:^|\n)\s*(?:by)\s+([^\n]{2,80})(?:\n|$)/i);

  if (titleLineMatch) {
    result.title = cleanTitle(titleLineMatch[1]);
  } else if (headingMatch) {
    result.title = cleanTitle(headingMatch[1]);
  } else {
    result.title = cleanTitle(fallback.title);
  }

  const authorLineMatch = text.match(/(?:author|authors)\s*[:\-]\s*(.+)/i);
  if (authorLineMatch) {
    result.authors = normalizeAuthors(authorLineMatch[1]);
  } else if (bylineMatch) {
    result.authors = normalizeAuthors(bylineMatch[1]);
  }

  const yearMatch = text.match(/(?:^|\D)(19\d{2}|20\d{2})(?:\D|$)/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    if (y >= 1900 && y <= 2030) result.year = y;
  }

  return result;
}

function cleanTitle(title) {
  if (!title) return "";
  return title.trim().replace(/\s+/g, " ").slice(0, 200);
}

function normalizeAuthors(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((a) => a.trim()).filter(Boolean);
  return input
    .split(/[,;]|\band\b|\//i)
    .map((a) => a.trim())
    .filter(Boolean);
}

function applyExtractedMetadata(metadata) {
  const titleEl = document.getElementById("upload-title");
  const yearEl = document.getElementById("upload-year");
  const authorsEl = document.getElementById("upload-authors");

  if (metadata.title && !titleEl.value) titleEl.value = metadata.title;
  if (metadata.year && !yearEl.value) yearEl.value = metadata.year;
  if (metadata.authors?.length && !authorsEl.value) {
    authorsEl.value = metadata.authors.join(", ");
  }
}

async function loadPdfJs() {
  if (window.pdfjsLib) return;
  const pdfjsLib = await import("/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
  window.pdfjsLib = pdfjsLib;
}

async function handleFileSelect(file) {
  if (!file || state.isUploading) return;

  const dt = new DataTransfer();
  dt.items.add(file);
  els.uploadFile.files = dt.files;

  els.uploadFileName.textContent = file.name;
  els.uploadFileName.classList.remove("hidden");
  els.extractStatus.textContent = "Extracting metadata...";
  els.extractStatus.classList.remove("hidden");

  try {
    const metadata = await extractMetadata(file);
    applyExtractedMetadata(metadata);
    els.extractStatus.textContent = "Metadata extracted.";
  } catch {
    els.extractStatus.textContent = "Could not extract metadata.";
  }
  setTimeout(() => {
    els.extractStatus.classList.add("hidden");
    els.extractStatus.textContent = "";
  }, 3000);
}

function initUploadDropZone() {
  const zone = els.uploadDropZone;
  if (!zone) return;

  zone.addEventListener("click", () => els.uploadFile.click());

  let dragCount = 0;
  zone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCount += 1;
    zone.classList.add("ring-2", "ring-indigo-500", "bg-indigo-50");
  });

  zone.addEventListener("dragleave", () => {
    dragCount -= 1;
    if (dragCount <= 0) {
      dragCount = 0;
      zone.classList.remove("ring-2", "ring-indigo-500", "bg-indigo-50");
    }
  });

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCount = 0;
    zone.classList.remove("ring-2", "ring-indigo-500", "bg-indigo-50");
    const files = e.dataTransfer.files;
    if (files.length) handleFileSelect(files[0]);
  });

  els.uploadFile.addEventListener("change", (e) => {
    const files = e.target.files;
    if (files.length) handleFileSelect(files[0]);
  });
}

async function init() {
  if (!API_URL) {
    els.guestState.innerHTML = `<p class="text-rose-600">API URL is not configured. Please check globalThis.APP_CONFIG.</p>`;
    return;
  }

  if (await handleSignInCallback()) return;

  els.signinBtn.addEventListener("click", startSignIn);
  els.heroSigninBtn.addEventListener("click", startSignIn);
  els.signoutBtn.addEventListener("click", signOut);
  els.uploadForm.addEventListener("submit", handleUpload);
  els.queryForm.addEventListener("submit", handleQuery);
  els.detailClose.addEventListener("click", () =>
    els.detailModal.classList.add("hidden"),
  );
  els.detailModal.addEventListener("click", (e) => {
    if (e.target === els.detailModal) els.detailModal.classList.add("hidden");
  });
  els.documentsList.addEventListener("click", handleDocumentAction);
  initUploadDropZone();

  updateAuthUI();
}

if (globalThis.CHEAPKB_TEST) {
  globalThis.CHEAPKB_TEST_API = { mergeDocuments, setButtonLoading, state };
} else {
  init();
}

async function handleSignInCallback() {
  if (window.location.pathname !== SHOO_CALLBACK_PATH) return false;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("code") || !params.has("state")) return false;

  restorePkceVerifier(params.get("state"));
  try {
    await window.Shoo.handleCallback();
    localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
    return true;
  } catch {
    sessionStorage.removeItem(SHOO_PKCE_KEY);
    localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
    window.history.replaceState(null, "", "/");
    showToast("Sign-in expired. Please sign in again.", "error");
    return false;
  }
}

function restorePkceVerifier(callbackState) {
  if (sessionStorage.getItem(SHOO_PKCE_KEY)) return;
  const rawBackup = localStorage.getItem(SHOO_PKCE_BACKUP_KEY);
  if (!rawBackup) return;

  try {
    const backup = JSON.parse(rawBackup);
    const isValid =
      backup.state === callbackState &&
      typeof backup.verifier === "string" &&
      typeof backup.createdAt === "number" &&
      Date.now() - backup.createdAt <= SHOO_PKCE_MAX_AGE_MS;
    if (isValid) {
      sessionStorage.setItem(SHOO_PKCE_KEY, rawBackup);
    } else {
      localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
    }
  } catch {
    localStorage.removeItem(SHOO_PKCE_BACKUP_KEY);
  }
}
