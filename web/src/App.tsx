import { Notices, type Notice } from "@/components/Notices";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  apiCall,
  getIdentity,
  getUsageSummary,
  getUserProfile,
  handleSignInCallback,
  isActiveStatus,
  mergeDocuments,
  readPendingDocuments,
  SHOO_CALLBACK_PATH,
  SIGNED_IN_KEY,
  startSignIn,
  watchSession,
  writePendingDocuments,
} from "@/lib/client";
import { loadPostHog, posthog } from "@/lib/posthog";
import type { Document, ShooIdentity, UsageSummary } from "@/lib/types";
import { LogIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const NOTICE_MS = 6000;
const POLL_MS = 3000;

/** Root component: signed-out screen, or the documents workspace with its settings. */
export default function App(): React.JSX.Element {
  // Read up front so a signed-in user never sees the sign-in card first.
  const [identity, setIdentity] = useState<ShooIdentity | null>(() =>
    window.location.pathname === SHOO_CALLBACK_PATH ? null : getIdentity(),
  );
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(
    null,
  );
  const [selectedDocumentData, setSelectedDocumentData] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  // Imported once signed in, so signed-out visitors never download the workspace.
  // Not React.lazy: Suspense holds a revealed boundary back by up to 300 ms.
  const [workspace, setWorkspace] = useState<
    typeof import("@/components/Workspace") | null
  >(null);
  const documentsRef = useRef(documents);
  const noticesRef = useRef(notices);
  const documentRequest = useRef(0);
  const documentsRequest = useRef(0);
  const usageRequest = useRef(0);
  const hadInflight = useRef(false);
  const hasInflight = documents.some(
    (document) =>
      document.inFlight ||
      isActiveStatus(document.status) ||
      (document.status === "DELETING" && !document.lastError),
  );
  const loadingDocument =
    selectedDocument !== null && selectedDocumentData === null;

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    noticesRef.current = notices;
  }, [notices]);

  const dismissNotice = useCallback((id: string): void => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  // Shows an error at the top of the screen. A repeat replaces the one shown
  // with a fresh timer, and a notice with a retry stays until used or closed.
  const notify = useCallback(
    (title: string, message: string, retry?: () => void): void => {
      const id = crypto.randomUUID();
      // Polls repeat a failure every few seconds; count it once while it is shown.
      const shown = noticesRef.current.some(
        (notice) => notice.title === title && notice.message === message,
      );
      if (!shown) posthog.capture("error_shown", { title: title });
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

  const request = useCallback(
    (
      method: string,
      path: string,
      body?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> =>
      apiCall(identity?.token ?? "", method, path, body),
    [identity?.token],
  );

  // Loads usage on sign-in and after uploads and deletes.
  const refreshUsage = useCallback(
    async function refresh(): Promise<void> {
      if (!identity?.token) return;
      const requestId = usageRequest.current + 1;
      usageRequest.current = requestId;
      try {
        const data = await getUsageSummary(identity.token);
        if (requestId !== usageRequest.current) return;
        setUsage(data);
      } catch (error) {
        if (requestId !== usageRequest.current) return;
        notify("Couldn't load usage", (error as Error).message, refresh);
      }
    },
    [identity?.token, notify],
  );

  // Polls and reloads can overlap; only the newest response is applied.
  const loadDocuments = useCallback(
    async function load(showLoading = false): Promise<void> {
      if (!identity?.token) return;
      const requestId = documentsRequest.current + 1;
      documentsRequest.current = requestId;
      if (showLoading) setLoadingDocuments(true);
      try {
        const data = await request("GET", "/documents");
        if (requestId !== documentsRequest.current) return;
        setDocuments((current) =>
          mergeDocuments(current, (data.documents as Document[]) || []),
        );
      } catch (error) {
        if (requestId !== documentsRequest.current) return;
        notify("Couldn't load documents", (error as Error).message, () =>
          load(true),
        );
      } finally {
        if (requestId === documentsRequest.current) setLoadingDocuments(false);
      }
    },
    [identity?.token, notify, request],
  );

  useEffect(() => {
    /** Finishes a sign-in redirect if present, then restores the stored session. */
    async function initialize(): Promise<void> {
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
        if (currentIdentity.userId) {
          const profile = getUserProfile(currentIdentity);
          posthog.identify(currentIdentity.userId, {
            email: profile.email,
            name: profile.name,
          });
          if (sessionStorage.getItem(SIGNED_IN_KEY)) {
            sessionStorage.removeItem(SIGNED_IN_KEY);
            posthog.capture("user_signed_in");
          }
        }
        setDocuments(readPendingDocuments());
        watchSession();
      }
    }
    initialize();
  }, [notify]);

  useEffect(() => {
    if (!identity?.token) return;
    import("@/components/Workspace")
      .then(setWorkspace)
      .catch((error: Error) => {
        // Neither screen mounts now, so analytics is released here to report this error.
        loadPostHog();
        notify("Couldn't load the app", error.message);
      });
  }, [identity?.token, notify]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- loads documents from the API when the session changes
    if (identity?.token) loadDocuments(true);
  }, [identity?.token, loadDocuments]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- loads usage from the API when the session changes
    refreshUsage();
  }, [refreshUsage]);

  // Polls while anything is in flight, skipping hidden tabs.
  useEffect(() => {
    if (!hasInflight) return;
    function poll(): void {
      if (!window.document.hidden) loadDocuments(false);
    }
    const timer = window.setInterval(poll, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasInflight, loadDocuments]);

  // Storage is counted after S3 receives the file, so usage reloads once processing settles.
  useEffect(() => {
    if (hadInflight.current && !hasInflight) refreshUsage();
    hadInflight.current = hasInflight;
  }, [hasInflight, refreshUsage]);

  // Catches up when the tab is shown again, including documents an agent added over MCP.
  useEffect(() => {
    function catchUp(): void {
      if (window.document.hidden) return;
      loadDocuments(false);
      refreshUsage();
    }
    window.document.addEventListener("visibilitychange", catchUp);
    return () =>
      window.document.removeEventListener("visibilitychange", catchUp);
  }, [loadDocuments, refreshUsage]);

  /** Clears the detail dialog; a request still in flight is ignored. */
  const closeDocument = useCallback((): void => {
    documentRequest.current += 1;
    setSelectedDocument(null);
    setSelectedDocumentData(null);
  }, []);

  async function deleteAllData(): Promise<void> {
    try {
      await request("DELETE", "/account/data");
      posthog.capture("account_data_deleted");
      await loadDocuments();
      refreshUsage();
    } catch (error) {
      notify("Couldn't delete your data", (error as Error).message);
      // Rethrown so the settings dialog stays open on failure.
      throw error;
    }
  }

  /**
   * Marks a document as deleting and deletes it; on failure it restores the row.
   * Returns false instead of throwing, so bulk deletes can collect failures.
   */
  const deleteDocument = useCallback(
    async (documentId: string, refresh = true): Promise<boolean> => {
      const now = new Date().toISOString();
      const deletedSnapshot = documentsRef.current.find(
        (document) => document.documentId === documentId,
      );
      setDocuments((current) =>
        current.map((document) => {
          return document.documentId === documentId
            ? {
                ...document,
                lastError: null,
                status: "DELETING",
                updatedAt: now,
              }
            : document;
        }),
      );
      try {
        await request("DELETE", `/documents/${encodeURIComponent(documentId)}`);
        posthog.capture("document_deleted", {
          mime_type: deletedSnapshot?.mimeType,
          status: deletedSnapshot?.status,
        });
        if (refresh) {
          await loadDocuments();
          refreshUsage();
        }
        return true;
      } catch (error) {
        const { message } = error as Error;
        const { current } = documentsRef;
        let restored: Document[];
        if (!deletedSnapshot) {
          restored = current;
        } else if (
          current.some((document) => document.documentId === documentId)
        ) {
          restored = current.map((document) => {
            return document.documentId === documentId
              ? deletedSnapshot
              : document;
          });
        } else {
          restored = [deletedSnapshot, ...current];
        }
        setDocuments(restored);
        writePendingDocuments(restored);
        notify("Delete failed", message);
        return false;
      }
    },
    [loadDocuments, notify, refreshUsage, request],
  );

  /** Deletes documents one at a time and returns the ids that failed. */
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

  /** Queues a document for reindexing and rolls the table back on failure. */
  const reindexDocument = useCallback(
    async (documentId: string): Promise<void> => {
      const previous = documentsRef.current;
      setDocuments((current) =>
        current.map((document) => {
          return document.documentId === documentId
            ? { ...document, inFlight: true, lastError: null, status: "QUEUED" }
            : document;
        }),
      );
      try {
        await request(
          "POST",
          `/documents/${encodeURIComponent(documentId)}/reindex`,
        );
        posthog.capture("document_reindexed");
        await loadDocuments();
      } catch (error) {
        setDocuments(previous);
        notify("Reindex failed", (error as Error).message);
      }
    },
    [loadDocuments, notify, request],
  );

  /** Opens the detail dialog for a document and loads its full record. Used by row and
   * citation clicks; a newer call wins over an older one still in flight. */
  const showDocument = useCallback(
    async (documentId: string): Promise<void> => {
      const requestId = documentRequest.current + 1;
      documentRequest.current = requestId;
      const document = documentsRef.current.find(
        (current) => current.documentId === documentId,
      );
      setSelectedDocument(
        document || { documentId: documentId, status: "", title: documentId },
      );
      setSelectedDocumentData(null);
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
      }
    },
    [closeDocument, notify, request],
  );

  async function signIn(): Promise<void> {
    // Handed to PostHog before the redirect, which would drop a queued event.
    await posthog.captureNow("sign_in_started", undefined, {
      send_instantly: true,
      transport: "sendBeacon",
    });
    try {
      await startSignIn();
    } catch {
      notify("Sign-in failed", "Could not start sign-in. Please try again.");
    }
  }

  if (!identity?.token) {
    return (
      <>
        <Notices notices={notices} onDismiss={dismissNotice} />
        <Guest onSignIn={signIn} />
      </>
    );
  }

  // Nothing shows until the workspace chunk arrives, except a failure to load it.
  if (!workspace) {
    return <Notices notices={notices} onDismiss={dismissNotice} />;
  }

  const { default: Workspace } = workspace;

  return (
    <Workspace
      closeDocument={closeDocument}
      deleteAllData={deleteAllData}
      deleteDocument={deleteDocument}
      deleteDocuments={deleteDocuments}
      dismissNotice={dismissNotice}
      documents={documents}
      identity={identity}
      loadDocuments={loadDocuments}
      loadingDocument={loadingDocument}
      loadingDocuments={loadingDocuments}
      notices={notices}
      notify={notify}
      refreshUsage={refreshUsage}
      reindexDocument={reindexDocument}
      selectedDocument={selectedDocument}
      selectedDocumentData={selectedDocumentData}
      setDocuments={setDocuments}
      showDocument={showDocument}
      usage={usage}
    />
  );
}

/** Signed-out screen with the Google sign-in button, shown until a token exists. */
function Guest({ onSignIn }: { onSignIn: () => void }): React.JSX.Element {
  useEffect(loadPostHog, []);

  return (
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
  );
}
