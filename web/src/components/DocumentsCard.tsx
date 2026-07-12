import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isActiveStatus } from "@/lib/client";
import type { Document } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FileText, LoaderCircle } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
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

const STATUS_PROGRESS: Record<string, string> = {
  UPLOADING: "w-[12%]",
  UPLOADED: "w-1/5",
  QUEUED: "w-[28%]",
  PARSING: "w-[42%]",
  PARSED: "w-[55%]",
  CHUNKING: "w-[68%]",
  CHUNKED: "w-[78%]",
  EMBEDDING: "w-[88%]",
};

const STALLED_AFTER_MS = 5 * 60 * 1000;

function StatusBadge({
  stalled,
  status,
}: {
  stalled: boolean;
  status: string;
}) {
  const variant =
    status === "EMBEDDED"
      ? "default"
      : status === "FAILED"
        ? "destructive"
        : ["UPLOADED", "QUEUED"].includes(status) || stalled
          ? "secondary"
          : "outline";
  return (
    <Badge variant={variant}>
      {stalled ? "Delayed" : STATUS_LABELS[status] || status}
    </Badge>
  );
}

function formatDate(value: string | undefined): string {
  if (!value) return "Just now";
  return new Date(value).toLocaleString();
}

function DocumentRow({
  document,
  onDelete,
  onReindex,
  onView,
}: {
  document: Document;
  onDelete: (documentId: string) => void;
  onReindex: (documentId: string) => void;
  onView: (documentId: string) => void;
}) {
  const optimistic = document.documentId.startsWith("temp_");
  const updatedAt = Date.parse(document.updatedAt ?? document.createdAt ?? "");
  const stalled =
    isActiveStatus(document.status) &&
    Date.now() - updatedAt > STALLED_AFTER_MS;
  return (
    <div className="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">
            {document.title || document.documentId}
          </p>
          <StatusBadge stalled={stalled} status={document.status} />
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {document.mimeType || "Document"} · {formatDate(document.createdAt)}
        </p>
        {document.lastError && (
          <p className="mt-2 text-xs text-destructive">{document.lastError}</p>
        )}
        {isActiveStatus(document.status) && (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full",
                STATUS_PROGRESS[document.status] || "w-0",
                stalled ? "bg-amber-400" : "bg-primary",
              )}
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          className="cursor-pointer"
          disabled={optimistic}
          onClick={() => onView(document.documentId)}
          size="sm"
          variant="secondary"
        >
          View
        </Button>
        {!optimistic && (!isActiveStatus(document.status) || stalled) && (
          <Button
            className="cursor-pointer"
            onClick={() => onReindex(document.documentId)}
            size="sm"
            variant="ghost"
          >
            {stalled ? "Restart" : "Reindex"}
          </Button>
        )}
        <Button
          className="cursor-pointer"
          disabled={optimistic}
          onClick={() => onDelete(document.documentId)}
          size="sm"
          variant="destructive"
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

export function DocumentsCard({
  documents,
  loading,
  onDelete,
  onReindex,
  onView,
}: {
  documents: Document[];
  loading: boolean;
  onDelete: (documentId: string) => void;
  onReindex: (documentId: string) => void;
  onView: (documentId: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Documents</CardTitle>
        {loading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
        )}
      </CardHeader>
      <CardContent>
        {!documents.length && !loading ? (
          <div className="py-10 text-center">
            <FileText className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              Upload your first document to begin.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {documents.map((document) => (
              <DocumentRow
                document={document}
                key={document.documentId}
                onDelete={onDelete}
                onReindex={onReindex}
                onView={onView}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
