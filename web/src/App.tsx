import { DocumentDialog } from "@/components/DocumentDialog";
import { DocumentsCard } from "@/components/DocumentsCard";
import { Header } from "@/components/Header";
import { Notices, type Notice } from "@/components/Notices";
import { QueryCard } from "@/components/QueryCard";
import { UsageCard } from "@/components/UsageCard";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTags } from "@/hooks/use-tags";
import {
  apiCall,
  getIdentity,
  getUsageSummary,
  handleSignInCallback,
  isActiveStatus,
  mergeDocuments,
  readPendingDocuments,
  signOut,
  startSignIn,
  watchSession,
  writePendingDocuments,
} from "@/lib/client";
import type { Document, ShooIdentity, UsageSummary } from "@/lib/types";
import { LogIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const NOTICE_MS = 6000;

function Guest({ onSignIn }: { onSignIn: () => void }) {
  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col">
        <main className="flex flex-1 items-center justify-center px-4">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle>Sign in</CardTitle>
              <CardDescription>
                Continue to your private knowledge base.
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Button className="w-full cursor-pointer" onClick={onSignIn}>
                <LogIn data-icon="inline-start" /> Continue with Google
              </Button>
            </CardFooter>
          </Card>
        </main>
      </div>
    </TooltipProvider>
  );
}

function App() {
  const [identity, setIdentity] = useState<ShooIdentity | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(
    null,
  );
  const [selectedDocumentData, setSelectedDocumentData] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const documentsRef = useRef(documents);
  const documentRequest = useRef(0);
  const usageRequest = useRef(0);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  const dismissNotice = useCallback((id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  // Shows an error at the top of the screen. A repeat replaces the one shown
  // with a fresh timer, and a notice with a retry stays until used or closed.
  const notify = useCallback(
    (title: string, message: string, retry?: () => void) => {
      const id = crypto.randomUUID();
      setNotices((current) => [
        ...current.filter(
          (notice) => notice.title !== title || notice.message !== message,
        ),
        { id: id, message: message, retry: retry, title: title },
      ]);
      if (!retry) window.setTimeout(() => dismissNotice(id), NOTICE_MS);
    },
    [dismissNotice],
  );

  // Lifted above DocumentsCard so the detail panel can color tags too.
  const tagVocabulary = useTags(identity?.token ?? "");

  const request = useCallback(
    (method: string, path: string, body?: Record<string, unknown>) =>
      apiCall(identity?.token ?? "", method, path, body),
    [identity?.token],
  );

  // Loads usage on sign-in and after uploads, queries and deletes. A backend
  // push (WebSocket or SSE) could replace these refreshes later.
  const refreshUsage = useCallback(async () => {
    if (!identity?.token) return;
    const requestId = usageRequest.current + 1;
    usageRequest.current = requestId;
    try {
      const data = await getUsageSummary(identity.token);
      if (requestId !== usageRequest.current) return;
      setUsage(data);
    } catch (error) {
      if (requestId !== usageRequest.current) return;
      notify("Couldn't load usage", (error as Error).message, refreshUsage);
    }
  }, [identity?.token, notify]);

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
        notify("Couldn't load documents", (error as Error).message, () =>
          loadDocuments(true),
        );
      } finally {
        setLoadingDocuments(false);
      }
    },
    [identity?.token, notify, request],
  );

  useEffect(() => {
    async function initialize() {
      if (!import.meta.env.VITE_API_URL) {
        notify("App is not configured", "The API URL is missing.");
        return;
      }
      try {
        if (await handleSignInCallback()) return;
      } catch (error) {
        notify("Sign-in failed", (error as Error).message);
      }
      const currentIdentity = getIdentity();
      setIdentity(currentIdentity);
      if (currentIdentity?.token) {
        setDocuments(readPendingDocuments());
        watchSession();
      }
    }
    initialize();
  }, [notify]);

  useEffect(() => {
    if (identity?.token) loadDocuments(true);
  }, [identity?.token, loadDocuments]);

  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  useEffect(() => {
    const hasInflight = documents.some(
      (document) =>
        isActiveStatus(document.status) ||
        (document.status === "DELETING" && !document.lastError),
    );
    if (!hasInflight) return;
    const timer = window.setInterval(() => loadDocuments(false), 3000);
    return () => window.clearInterval(timer);
  }, [documents, loadDocuments]);

  async function signIn() {
    try {
      await startSignIn();
    } catch {
      notify("Sign-in failed", "Could not start sign-in. Please try again.");
    }
  }

  async function showDocument(documentId: string) {
    const requestId = documentRequest.current + 1;
    documentRequest.current = requestId;
    const document = documentsRef.current.find(
      (current) => current.documentId === documentId,
    );
    setSelectedDocument(
      document || { documentId: documentId, status: "", title: documentId },
    );
    setSelectedDocumentData(null);
    setLoadingDocument(true);
    try {
      const data = await request(
        "GET",
        `/documents/${encodeURIComponent(documentId)}`,
      );
      if (requestId === documentRequest.current) {
        setSelectedDocumentData(data);
      }
    } catch (error) {
      if (requestId === documentRequest.current) {
        closeDocument();
        notify("Couldn't load document details", (error as Error).message);
      }
    } finally {
      if (requestId === documentRequest.current) setLoadingDocument(false);
    }
  }

  function closeDocument() {
    documentRequest.current += 1;
    setSelectedDocument(null);
    setSelectedDocumentData(null);
    setLoadingDocument(false);
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
      await request(
        "POST",
        `/documents/${encodeURIComponent(documentId)}/reindex`,
      );
      await loadDocuments();
    } catch (error) {
      setDocuments(previous);
      notify("Reindex failed", (error as Error).message);
    }
  }

  async function deleteDocument(
    documentId: string,
    refresh = true,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const deletedSnapshot = documentsRef.current.find(
      (document) => document.documentId === documentId,
    );
    setDocuments((current) =>
      current.map((document) =>
        document.documentId === documentId
          ? {
              ...document,
              lastError: null,
              status: "DELETING",
              updatedAt: now,
            }
          : document,
      ),
    );
    try {
      await request("DELETE", `/documents/${encodeURIComponent(documentId)}`);
      if (refresh) {
        await loadDocuments();
        refreshUsage();
      }
      return true;
    } catch (error) {
      const message = (error as Error).message;
      const current = documentsRef.current;
      let restored: Document[];
      if (!deletedSnapshot) {
        restored = current;
      } else if (
        current.some((document) => document.documentId === documentId)
      ) {
        restored = current.map((document) =>
          document.documentId === documentId ? deletedSnapshot : document,
        );
      } else {
        restored = [deletedSnapshot, ...current];
      }
      setDocuments(restored);
      writePendingDocuments(restored);
      notify("Delete failed", message);
      return false;
    }
  }

  async function deleteDocuments(documentIds: string[]): Promise<string[]> {
    const failedDocumentIds: string[] = [];
    for (const documentId of documentIds) {
      if (!(await deleteDocument(documentId, false))) {
        failedDocumentIds.push(documentId);
      }
    }
    await loadDocuments();
    if (failedDocumentIds.length < documentIds.length) {
      refreshUsage();
    }
    return failedDocumentIds;
  }

  if (!identity?.token) {
    return (
      <>
        <Notices notices={notices} onDismiss={dismissNotice} />
        <Guest onSignIn={signIn} />
      </>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
        <Header identity={identity} usage={usage} onSignOut={signOut} />
        <main className="flex min-h-0 w-full flex-1 flex-col">
          <div className="mx-auto grid min-h-0 w-full max-w-380 flex-1 items-stretch gap-3 p-3 lg:grid-cols-12">
            <div className="min-h-0 min-w-0 lg:col-span-8 xl:col-span-9">
              <DocumentsCard
                documents={documents}
                loading={loadingDocuments}
                token={identity.token}
                setDocuments={setDocuments}
                loadDocuments={loadDocuments}
                notify={notify}
                onDelete={deleteDocument}
                onDeleteSelected={deleteDocuments}
                onReindex={reindexDocument}
                onView={showDocument}
                onUsageChange={refreshUsage}
                tagVocabulary={tagVocabulary}
              />
            </div>
            <div className="flex min-h-0 flex-col gap-3 min-w-0 lg:col-span-4 xl:col-span-3">
              <UsageCard summary={usage} />
              <QueryCard
                request={request}
                onView={showDocument}
                onUsageChange={refreshUsage}
              />
            </div>
          </div>
        </main>
        <DocumentDialog
          colorOf={tagVocabulary.colorOf}
          data={selectedDocumentData}
          document={selectedDocument}
          loading={loadingDocument}
          onClose={closeDocument}
        />
        <Notices notices={notices} onDismiss={dismissNotice} />
      </div>
    </TooltipProvider>
  );
}

export default App;
