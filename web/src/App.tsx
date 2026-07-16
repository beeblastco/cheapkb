import { DocumentDialog } from "@/components/DocumentDialog";
import { DocumentsCard } from "@/components/DocumentsCard";
import { Header } from "@/components/Header";
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
  writePendingDocuments,
} from "@/lib/client";
import type { Document, ShooIdentity, UsageSummary } from "@/lib/types";
import { LogIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

function Guest({ onSignIn }: { onSignIn: () => void }) {
  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col">
        <Header />
        <main className="flex flex-1 items-center justify-center px-4">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle>Sign in</CardTitle>
              <CardDescription>
                Continue to your private knowledge base.
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Button className="w-full" onClick={onSignIn}>
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
  const documentsRef = useRef(documents);
  const documentRequest = useRef(0);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  const notify = useCallback((_message: string, _type?: string) => {}, []);

  // Lifted above DocumentsCard so the detail panel can color tags too.
  const tagVocabulary = useTags(identity?.token ?? "");

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
    async function loadUsage() {
      if (!identity?.token) return;
      try {
        const data = await getUsageSummary(identity.token);
        setUsage(data);
      } catch (error) {
        notify((error as Error).message, "error");
      }
    }
    loadUsage();
  }, [identity?.token, notify]);

  useEffect(() => {
    const hasInflight = documents.some(
      (document) =>
        isActiveStatus(document.status) || document.status === "DELETING",
    );
    if (!hasInflight) return;
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
    const requestId = documentRequest.current + 1;
    documentRequest.current = requestId;
    const document = documentsRef.current.find(
      (current) => current.documentId === documentId,
    );
    setSelectedDocument(
      document || { documentId, status: "", title: documentId },
    );
    setSelectedDocumentData(null);
    setLoadingDocument(true);
    try {
      const data = await request("GET", `/documents/${documentId}`);
      if (requestId === documentRequest.current) {
        setSelectedDocumentData(data);
      }
    } catch (error) {
      notify((error as Error).message, "error");
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
      const data = await request("POST", `/documents/${documentId}/reindex`);
      notify((data.message as string) || "Reindex started", "success");
      await loadDocuments();
    } catch (error) {
      setDocuments(previous);
      notify((error as Error).message, "error");
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
      await request("DELETE", `/documents/${documentId}`);
      if (refresh) await loadDocuments();
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
      notify(message, "error");
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
    const deleted = documentIds.length - failedDocumentIds.length;
    notify(
      failedDocumentIds.length
        ? `${deleted} deleted, ${failedDocumentIds.length} failed.`
        : `${deleted} document${deleted === 1 ? "" : "s"} deleted.`,
      failedDocumentIds.length ? "error" : "success",
    );
    return failedDocumentIds;
  }

  if (!identity?.token) {
    return <Guest onSignIn={signIn} />;
  }

  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
        <Header identity={identity} onSignOut={signOut} />
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
                tagVocabulary={tagVocabulary}
              />
            </div>
            <div className="flex min-h-0 flex-col gap-3 min-w-0 lg:col-span-4 xl:col-span-3">
              <UsageCard summary={usage} />
              <QueryCard request={request} onView={showDocument} />
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
      </div>
    </TooltipProvider>
  );
}

export default App;
