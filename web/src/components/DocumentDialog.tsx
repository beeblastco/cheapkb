import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/client";
import type { Document } from "@/lib/types";
import { cn } from "@/lib/utils";

const FAILED_STATUSES = new Set(["FAILED"]);
const READY_STATUSES = new Set(["EMBEDDED"]);
const ACTIVE_STATUSES = new Set([
  "UPLOADING",
  "UPLOADED",
  "QUEUED",
  "PARSING",
  "PARSED",
  "CHUNKING",
  "CHUNKED",
  "EMBEDDING",
  "DELETING",
]);

function statusVariant(
  status: string | undefined,
): "default" | "secondary" | "destructive" | "outline" {
  if (!status) return "outline";
  if (FAILED_STATUSES.has(status)) return "destructive";
  if (READY_STATUSES.has(status)) return "default";
  if (ACTIVE_STATUSES.has(status)) return "secondary";
  return "outline";
}

function humanize(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function DocumentDialog({
  data,
  onClose,
}: {
  data: Record<string, unknown> | null;
  onClose: () => void;
}) {
  const document = data?.document as Document | undefined;
  if (!document) return null;
  const tags = Array.isArray(document.tags)
    ? document.tags.join(", ")
    : document.tags;
  const authors = Array.isArray(document.authors)
    ? document.authors.join(", ")
    : document.authors;
  const fields = [
    ["ID", document.documentId, "default"] as const,
    [
      "Status",
      { status: document.status, variant: statusVariant(document.status) },
      "status",
    ] as const,
    ["MIME type", document.mimeType, "default"] as const,
    ["Chunks", String(Number(data?.chunkCount) || 0), "default"] as const,
    ["Created", formatDate(document.createdAt), "default"] as const,
    ["Updated", formatDate(document.updatedAt), "default"] as const,
    ["Tags", tags, "default"] as const,
    ["Authors", authors, "default"] as const,
    ["Last error", document.lastError, "error"] as const,
  ].filter(
    ([, value]) =>
      (typeof value === "string" && value !== "") ||
      (value && typeof value === "object" && "status" in value),
  );

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{document.title || document.documentId}</DialogTitle>
          <DialogDescription>
            Document metadata and processing details
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map(([label, value, kind]) => (
            <div
              className={cn(
                label === "ID" || label === "Tags" || label === "Authors"
                  ? "sm:col-span-2"
                  : "",
              )}
              key={label}
            >
              <p className="text-xs text-muted-foreground">{label}</p>
              {kind === "status" && value && typeof value === "object" ? (
                <div className="mt-1">
                  <Badge variant={value.variant}>
                    {humanize(value.status)}
                  </Badge>
                </div>
              ) : kind === "error" && value ? (
                <p className="mt-1 wrap-break-word text-sm text-destructive">
                  {String(value)}
                </p>
              ) : label === "ID" ? (
                <p className="mt-1 wrap-break-word font-mono text-xs text-foreground">
                  {String(value)}
                </p>
              ) : (
                <p className="mt-1 wrap-break-word text-sm text-foreground">
                  {String(value)}
                </p>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
