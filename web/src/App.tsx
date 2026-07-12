import { DocumentDialog } from "@/components/DocumentDialog";
import { DocumentsCard } from "@/components/DocumentsCard";
import { Header } from "@/components/Header";
import { QueryCard } from "@/components/QueryCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UploadCard } from "@/components/UploadCard";
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
import type { Document, ShooIdentity } from "@/lib/types";
import { LogIn } from "lucide-react";
import { toast } from "sonner";
import { useCallback, useEffect, useRef, useState } from "react";

function Guest({ onSignIn }: { onSignIn: () => void }) {
  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col">
        <Header />
        <main className="flex flex-1 items-center justify-center px-5 py-16">
          <Card className="w-full max-w-sm border-border/80 bg-card/70 shadow-2xl shadow-black/20">
            <CardContent className="px-6 text-center">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
                cheapkb
              </p>
              <h1 className="mt-4 text-2xl font-semibold tracking-tight">
                Your documents, searchable.
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Sign in to sync sources, follow ingestion, and search your
                private knowledge base.
              </p>
              <Button className="mt-6 w-full" onClick={onSignIn}>
                <LogIn /> Continue with Google
              </Button>
            </CardContent>
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
  const [selectedDocument, setSelectedDocument] = useState<Record<
    string,
    unknown
  > | null>(null);
  const documentsRef = useRef(documents);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  const notify = useCallback(
    (message: string, type: "info" | "error" | "success" = "info") => {
      toast[type](message);
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
    return <Guest onSignIn={signIn} />;
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen">
        <Header identity={identity} onSignOut={signOut} />
        <main className="mx-auto w-full max-w-[1600px] px-3 py-3 sm:px-4 lg:px-6">
          <div className="grid items-start gap-3 lg:grid-cols-12">
            <div className="space-y-3 lg:col-span-8 xl:col-span-9">
              <UploadCard
                token={identity.token}
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
            <div className="lg:col-span-4 xl:col-span-3">
              <QueryCard request={request} onView={showDocument} />
            </div>
          </div>
        </main>
        <DocumentDialog
          data={selectedDocument}
          onClose={() => setSelectedDocument(null)}
        />
      </div>
    </TooltipProvider>
  );
}

export default App;
