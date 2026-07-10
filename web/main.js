const API_URL = window.APP_CONFIG?.apiUrl ?? "";

const state = {
  token: null,
  userId: null,
  documents: [],
  loading: false,
  pollTimer: null,
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

function startSignIn() {
  if (typeof window.Shoo === "undefined") {
    showToast("Shoo SDK not loaded", "error");
    return;
  }
  window.Shoo.startSignIn();
}

function signOut() {
  if (typeof window.Shoo !== "undefined") {
    window.Shoo.clearIdentity();
  }
  state.token = null;
  state.userId = null;
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  localStorage.removeItem("shoo_id_token");
  window.location.reload();
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
    loadDocuments();
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
    headers: {
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
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
  switch (status) {
    case "EMBEDDED":
      return "bg-emerald-100 text-emerald-700";
    case "FAILED":
      return "bg-rose-100 text-rose-700";
    case "UPLOADED":
    case "QUEUED":
    case "PARSING":
    case "CHUNKING":
    case "EMBEDDING":
      return "bg-amber-100 text-amber-700";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

function renderDocuments() {
  els.documentsList.innerHTML = "";
  if (!state.documents.length) {
    els.documentsEmpty.classList.remove("hidden");
    return;
  }
  els.documentsEmpty.classList.add("hidden");

  for (const doc of state.documents) {
    const card = document.createElement("div");
    card.className =
      "py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3";
    card.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <h3 class="font-medium text-slate-900 truncate">${escapeHtml(doc.title || doc.documentId)}</h3>
          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(doc.status)}">${doc.status}</span>
        </div>
        <p class="text-xs text-slate-500 mt-1 truncate">${escapeHtml(doc.mimeType || "")} &middot; ${new Date(doc.createdAt).toLocaleString()}</p>
        ${doc.lastError ? `<p class="text-xs text-rose-600 mt-1 truncate">Error: ${escapeHtml(doc.lastError)}</p>` : ""}
      </div>
      <div class="flex items-center gap-2">
        <button data-id="${doc.documentId}" class="view-btn rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors">View</button>
        ${doc.status === "FAILED" ? `<button data-id="${doc.documentId}" class="reindex-btn rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors">Reindex</button>` : ""}
        <button data-id="${doc.documentId}" class="delete-btn rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 transition-colors">Delete</button>
      </div>
    `;
    els.documentsList.appendChild(card);
  }

  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => showDetail(btn.dataset.id));
  });
  document.querySelectorAll(".reindex-btn").forEach((btn) => {
    btn.addEventListener("click", () => reindexDocument(btn.dataset.id));
  });
  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteDocument(btn.dataset.id));
  });
}

async function loadDocuments() {
  try {
    const data = await apiCall("GET", "/documents");
    state.documents = data.documents || [];
    renderDocuments();
    schedulePolling();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function schedulePolling() {
  const terminal = ["EMBEDDED", "FAILED"];
  const hasActive = state.documents.some((d) => !terminal.includes(d.status));
  if (hasActive && !state.pollTimer) {
    state.pollTimer = setInterval(async () => {
      try {
        const data = await apiCall("GET", "/documents");
        state.documents = data.documents || [];
        renderDocuments();
        if (!state.documents.some((d) => !terminal.includes(d.status))) {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      } catch (err) {
        console.warn("[poll] failed to refresh documents:", err.message);
      }
    }, 3000);
  } else if (!hasActive && state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function showDetail(id) {
  try {
    const data = await apiCall("GET", `/documents/${id}`);
    const doc = data.document;
    els.detailTitle.textContent = doc.title || doc.documentId;
    els.detailBody.innerHTML = `
      <div class="grid grid-cols-2 gap-4">
        <div><span class="text-slate-500">ID</span><p class="font-mono text-xs break-all">${escapeHtml(doc.documentId)}</p></div>
        <div><span class="text-slate-500">Status</span><p>${escapeHtml(doc.status)}</p></div>
        <div><span class="text-slate-500">MIME type</span><p>${escapeHtml(doc.mimeType)}</p></div>
        <div><span class="text-slate-500">Chunks</span><p>${data.chunkCount}</p></div>
        <div><span class="text-slate-500">Created</span><p>${new Date(doc.createdAt).toLocaleString()}</p></div>
        <div><span class="text-slate-500">Updated</span><p>${new Date(doc.updatedAt).toLocaleString()}</p></div>
        ${doc.tags ? `<div class="col-span-2"><span class="text-slate-500">Tags</span><p>${escapeHtml(Array.isArray(doc.tags) ? doc.tags.join(", ") : doc.tags)}</p></div>` : ""}
        ${doc.authors ? `<div class="col-span-2"><span class="text-slate-500">Authors</span><p>${escapeHtml(Array.isArray(doc.authors) ? doc.authors.join(", ") : doc.authors)}</p></div>` : ""}
        ${doc.lastError ? `<div class="col-span-2"><span class="text-slate-500">Last error</span><p class="text-rose-600">${escapeHtml(doc.lastError)}</p></div>` : ""}
      </div>
    `;
    els.detailModal.classList.remove("hidden");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function reindexDocument(id) {
  try {
    const data = await apiCall("POST", `/documents/${id}/reindex`);
    showToast(data.message || "Reindex started", "success");
    await loadDocuments();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteDocument(id) {
  if (!confirm("Delete this document and all its data?")) return;
  try {
    await apiCall("DELETE", `/documents/${id}`);
    showToast("Document deleted", "success");
    await loadDocuments();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function handleUpload(e) {
  e.preventDefault();
  const file = els.uploadFile.files[0];
  if (!file) return;

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

  const submitBtn = document.getElementById("upload-submit");
  submitBtn.disabled = true;
  els.uploadStatus.textContent = "Requesting upload URL...";

  try {
    const meta = await apiCall("POST", "/upload", {
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      title,
      tags: tags.length ? tags : undefined,
      year,
      authors: authors.length ? authors : undefined,
    });

    els.uploadStatus.textContent = "Uploading file...";
    const putRes = await fetch(meta.uploadUrl, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    if (!putRes.ok) throw new Error("Failed to upload file to S3");

    els.uploadStatus.textContent = "Ingest queued.";
    showToast("Upload complete", "success");
    els.uploadForm.reset();
    els.uploadFileName.classList.add("hidden");
    els.uploadFileName.textContent = "";
    els.extractStatus.classList.add("hidden");
    els.extractStatus.textContent = "";
    await loadDocuments();
  } catch (err) {
    els.uploadStatus.textContent = "";
    showToast(err.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
}

async function handleQuery(e) {
  e.preventDefault();
  const query = els.queryInput.value.trim();
  const topK = parseInt(els.queryTopk.value, 10) || 5;
  if (!query) return;

  const submitBtn = document.getElementById("query-submit");
  submitBtn.disabled = true;
  els.queryResults.innerHTML = `<p class="text-sm text-slate-500">Searching...</p>`;

  try {
    const data = await apiCall("POST", "/query", { query, topK });
    renderQueryResults(data);
  } catch (err) {
    els.queryResults.innerHTML = `<p class="text-sm text-rose-600">${escapeHtml(err.message)}</p>`;
  } finally {
    submitBtn.disabled = false;
  }
}

function renderQueryResults(data) {
  if (!data.results?.length) {
    els.queryResults.innerHTML = `<p class="text-sm text-slate-500">No results.</p>`;
    return;
  }

  const groups = new Map();
  for (const r of data.results) {
    if (!groups.has(r.documentId)) {
      groups.set(r.documentId, {
        doc: r,
        chunks: [],
        maxScore: 0,
      });
    }
    const g = groups.get(r.documentId);
    g.chunks.push(r);
    g.maxScore = Math.max(g.maxScore, r.score || 0);
  }

  const sortedGroups = Array.from(groups.values()).sort(
    (a, b) => b.maxScore - a.maxScore,
  );

  els.queryResults.innerHTML = `<p class="text-xs text-slate-500">${data.resultCount} results across ${sortedGroups.length} documents</p>`;

  for (const g of sortedGroups) {
    g.chunks.sort((a, b) => (b.score || 0) - (a.score || 0));
    const details = document.createElement("details");
    details.className =
      "rounded-lg border border-slate-200 bg-slate-50 overflow-hidden";
    details.open = true;

    const summary = document.createElement("summary");
    summary.className =
      "cursor-pointer list-none bg-slate-100 px-3 py-2 flex items-center justify-between hover:bg-slate-200 transition-colors";
    summary.innerHTML = `
      <span class="text-sm font-medium text-slate-800">${escapeHtml(g.doc.title || g.doc.documentId)}</span>
      <span class="text-xs text-slate-500">best score ${g.maxScore.toFixed(3)} · ${g.chunks.length} chunk${g.chunks.length === 1 ? "" : "s"}</span>
    `;

    const body = document.createElement("div");
    body.className = "divide-y divide-slate-200";
    for (const c of g.chunks) {
      const row = document.createElement("div");
      row.className = "p-3";
      row.innerHTML = `
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs text-slate-500">score ${(c.score || 0).toFixed(3)}</span>
        </div>
        <p class="text-sm text-slate-800">${escapeHtml(c.text || "")}</p>
      `;
      body.appendChild(row);
    }

    details.appendChild(summary);
    details.appendChild(body);
    els.queryResults.appendChild(details);
  }
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  const color =
    type === "error"
      ? "bg-rose-600"
      : type === "success"
        ? "bg-emerald-600"
        : "bg-indigo-600";
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

function loadPdfJs() {
  return new Promise((resolve, reject) => {
    if (window.pdfjsLib) return resolve();

    const script = document.createElement("script");
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve();
    };
    script.onerror = () => reject(new Error("Failed to load PDF.js"));
    document.head.appendChild(script);
  });
}

async function handleFileSelect(file) {
  if (!file) return;

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
  } catch (err) {
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

function init() {
  if (!API_URL) {
    els.guestState.innerHTML = `<p class="text-rose-600">API URL is not configured. Please check window.APP_CONFIG.</p>`;
    return;
  }

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
  initUploadDropZone();

  updateAuthUI();
}

init();
