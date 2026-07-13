import { DocumentDialog } from "@/components/DocumentDialog";
import { DocumentsCard } from "@/components/DocumentsCard";
import { Header } from "@/components/Header";
import { QueryCard } from "@/components/QueryCard";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  const documentsRef = useRef(documents);
  const documentRequest = useRef(0);

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
        <main className="container mx-auto grid items-start gap-4 px-4 py-4 lg:grid-cols-12">
          <div className="lg:col-span-8 xl:col-span-9">
            <DocumentsCard
              documents={documents}
              loading={loadingDocuments}
              token={identity.token}
              setDocuments={setDocuments}
              loadDocuments={loadDocuments}
              notify={notify}
              onDelete={deleteDocument}
              onReindex={reindexDocument}
              onView={showDocument}
            />
          </div>
          <div className="lg:col-span-4 xl:col-span-3">
            <QueryCard request={request} onView={showDocument} />
          </div>
        </main>
        <DocumentDialog
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
