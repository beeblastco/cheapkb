import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDate } from "@/lib/client";
import type { Document } from "@/lib/types";
import { cn } from "@/lib/utils";

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
    ["ID", document.documentId] as const,
    ["Status", document.status] as const,
    ["MIME type", document.mimeType] as const,
    ["Chunks", String(Number(data?.chunkCount) || 0)] as const,
    ["Created", formatDate(document.createdAt)] as const,
    ["Updated", formatDate(document.updatedAt)] as const,
    ["Tags", tags] as const,
    ["Authors", authors] as const,
    ["Last error", document.lastError] as const,
  ].filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
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
          {fields.map(([label, value]) => (
            <div
              className={cn(
                label === "ID" || label === "Tags" || label === "Authors"
                  ? "sm:col-span-2"
                  : "",
              )}
              key={label}
            >
              <p className="text-xs text-muted-foreground">{label}</p>
              <p
                className={cn(
                  "mt-1 wrap-break-word text-sm text-foreground",
                  label === "ID" && "font-mono text-xs",
                  label === "Last error" && "text-destructive",
                )}
              >
                {String(value)}
              </p>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
