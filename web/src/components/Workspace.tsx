import { AccountMenu } from "@/components/AccountMenu";
import { DocumentDialog } from "@/components/DocumentDialog";
import { DocumentsCard } from "@/components/DocumentsCard";
import { Notices, type Notice } from "@/components/Notices";
import { SettingsDialog, type SettingsTab } from "@/components/SettingsDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTags } from "@/hooks/use-tags";
import { signOut } from "@/lib/client";
import { loadPostHog } from "@/lib/posthog";
import type { Document, ShooIdentity, UsageSummary } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const queryClient = new QueryClient();

/** Signed-in documents workspace with its settings. App loads it lazily and owns
 * its state, so signed-out visitors never download it. */
export default function Workspace(
  props: React.ComponentProps<typeof WorkspaceContent>,
): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspaceContent {...props} />
    </QueryClientProvider>
  );
}

/** Lays out the workspace inside the QueryClientProvider that useTags needs. */
function WorkspaceContent({
  closeDocument,
  deleteAllData,
  deleteDocument,
  deleteDocuments,
  dismissNotice,
  documents,
  identity,
  loadDocuments,
  loadingDocument,
  loadingDocuments,
  notices,
  notify,
  refreshUsage,
  reindexDocument,
  selectedDocument,
  selectedDocumentData,
  setDocuments,
  showDocument,
  usage,
}: {
  closeDocument: () => void;
  deleteAllData: () => Promise<void>;
  deleteDocument: (documentId: string) => Promise<boolean>;
  deleteDocuments: (documentIds: string[]) => Promise<string[]>;
  dismissNotice: (id: string) => void;
  documents: Document[];
  identity: ShooIdentity;
  loadDocuments: (showLoading?: boolean) => Promise<void>;
  loadingDocument: boolean;
  loadingDocuments: boolean;
  notices: Notice[];
  notify: (title: string, message: string) => void;
  refreshUsage: () => void;
  reindexDocument: (documentId: string) => void;
  selectedDocument: Document | null;
  selectedDocumentData: Record<string, unknown> | null;
  setDocuments: React.Dispatch<React.SetStateAction<Document[]>>;
  showDocument: (documentId: string) => void;
  usage: UsageSummary | null;
}): React.JSX.Element {
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  // Lifted above DocumentsCard so the detail panel can color tags too.
  const tagVocabulary = useTags(identity.token);

  useEffect(loadPostHog, []);

  return (
    <TooltipProvider>
      <main className="flex min-h-dvh flex-col p-3 lg:h-dvh lg:overflow-hidden">
        <DocumentsCard
          accountMenu={
            <AccountMenu
              identity={identity}
              onOpenSettings={setSettingsTab}
              onSignOut={signOut}
            />
          }
          usage={usage}
          onOpenUsage={() => setSettingsTab("usage")}
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
        <SettingsDialog
          notify={notify}
          onDeleteAllData={deleteAllData}
          onTabChange={setSettingsTab}
          tab={settingsTab}
          token={identity.token}
          usage={usage}
        />
        <DocumentDialog
          colorOf={tagVocabulary.colorOf}
          data={selectedDocumentData}
          document={selectedDocument}
          loading={loadingDocument}
          onClose={closeDocument}
        />
        <Notices notices={notices} onDismiss={dismissNotice} />
      </main>
    </TooltipProvider>
  );
}
