import { useCallback, useEffect, useRef, useState } from "react";
import type { Document, ShooIdentity, Toast as ToastType } from "@/lib/types";
import {
  apiCall,
  getIdentity,
  handleSignInCallback,
  isActiveStatus,
  mergeDocuments,
  readPendingDocuments,
  signOut,
  startSignIn,
  writePendingDocuments,
} from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Header } from "@/components/Header";
import { UploadCard } from "@/components/UploadCard";
import { DocumentsCard } from "@/components/DocumentsCard";
import { QueryCard } from "@/components/QueryCard";
import { DocumentDialog } from "@/components/DocumentDialog";
import { Toast } from "@/components/Toast";

function Guest({
  onSignIn,
  toast,
}: {
  onSignIn: () => void;
  toast: ToastType | null;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header onSignIn={onSignIn} />
      <main className="flex flex-1 items-center justify-center px-6 py-24">
        <div className="max-w-xl text-center">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            A small knowledge base that stays small.
          </h1>
          <p className="mx-auto mt-5 max-w-md text-base leading-7 text-zinc-500">
            Upload documents, follow the ingest pipeline, and query your vectors
            without the infrastructure tax.
          </p>
          <Button className="mt-8 cursor-pointer" onClick={onSignIn}>
            Sign in with Google
          </Button>
        </div>
      </main>
      <Toast toast={toast} />
    </div>
  );
}

function App() {
  const [identity, setIdentity] = useState<ShooIdentity | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [toast, setToast] = useState<ToastType | null>(null);
  const documentsRef = useRef(documents);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  const notify = useCallback(
    (message: string, type: ToastType["type"] = "info") => {
      setToast({ message, type });
      window.setTimeout(() => setToast(null), 3000);
    },
    [],
  );

  const request = useCallback(
    (method: string, path: string, body?: Record<string, unknown>) =>
      apiCall(identity?.token ?? "", method, path, body),
    [identity?.token],
  );

  const loadDocuments = useCallback(
    async (showLoading = false) => {
      if (!identity?.token) return;
      if (showLoading) setLoadingDocuments(true);
      try {
        const data = await request("GET", "/documents");
        setDocuments((current) =>
          mergeDocuments(current, (data.documents as Document[]) || []),
        );
      } catch (error) {
        notify((error as Error).message, "error");
      } finally {
        setLoadingDocuments(false);
      }
    },
    [identity?.token, notify, request],
  );

  useEffect(() => {
    async function initialize() {
      if (!import.meta.env.VITE_API_URL) {
        notify("API URL is not configured.", "error");
        return;
      }
      try {
        if (await handleSignInCallback()) return;
      } catch (error) {
        notify((error as Error).message, "error");
      }
      const currentIdentity = getIdentity();
      setIdentity(currentIdentity);
      if (currentIdentity?.token) setDocuments(readPendingDocuments());
    }
    initialize();
  }, [notify]);

  useEffect(() => {
    if (identity?.token) loadDocuments(true);
  }, [identity?.token, loadDocuments]);

  useEffect(() => {
    if (!documents.some((document) => isActiveStatus(document.status))) return;
    const timer = window.setInterval(() => loadDocuments(false), 3000);
    return () => window.clearInterval(timer);
  }, [documents, loadDocuments]);

  async function signIn() {
    try {
      await startSignIn();
    } catch {
      notify("Could not start sign-in. Please try again.", "error");
    }
  }

  async function showDocument(documentId: string) {
    try {
      const data = await request("GET", `/documents/${documentId}`);
      setSelectedDocument(data);
    } catch (error) {
      notify((error as Error).message, "error");
    }
  }

  async function reindexDocument(documentId: string) {
    const previous = documentsRef.current;
    setDocuments((current) =>
      current.map((document) =>
        document.documentId === documentId
          ? { ...document, status: "QUEUED", lastError: null }
          : document,
      ),
    );
    try {
      const data = await request("POST", `/documents/${documentId}/reindex`);
      notify((data.message as string) || "Reindex started", "success");
      await loadDocuments();
    } catch (error) {
      setDocuments(previous);
      notify((error as Error).message, "error");
    }
  }

  async function deleteDocument(documentId: string) {
    if (!window.confirm("Delete this document and all its data?")) return;
    const previous = documentsRef.current;
    const next = previous.filter(
      (document) => document.documentId !== documentId,
    );
    setDocuments(next);
    writePendingDocuments(next);
    try {
      await request("DELETE", `/documents/${documentId}`);
      notify("Document deleted", "success");
    } catch (error) {
      setDocuments(previous);
      writePendingDocuments(previous);
      notify((error as Error).message, "error");
    }
  }

  if (!identity?.token) {
    return <Guest onSignIn={signIn} toast={toast} />;
  }

  return (
    <div className="min-h-screen">
      <Header identity={identity} onSignOut={signOut} />
      <main className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Workspace
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
              Knowledge, ready when you need it.
            </h1>
            <p className="mt-2 max-w-xl text-sm text-zinc-500">
              Upload a source, watch it index, then search it from one quiet
              workspace.
            </p>
          </div>
          <Badge className="w-fit">
            {documents.length} document{documents.length === 1 ? "" : "s"}
          </Badge>
        </div>

        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-6 lg:col-span-8">
            <UploadCard
              token={identity.token}
              documents={documents}
              setDocuments={setDocuments}
              loadDocuments={loadDocuments}
              notify={notify}
            />
            <DocumentsCard
              documents={documents}
              loading={loadingDocuments}
              onDelete={deleteDocument}
              onReindex={reindexDocument}
              onView={showDocument}
            />
          </div>
          <QueryCard request={request} />
        </div>
      </main>
      <DocumentDialog
        data={selectedDocument}
        onClose={() => setSelectedDocument(null)}
      />
      <Toast toast={toast} />
    </div>
  );
}

export default App;
