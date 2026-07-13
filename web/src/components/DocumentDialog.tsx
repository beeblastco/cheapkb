import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/client";
import type { Document } from "@/lib/types";

export function DocumentDialog({
  document,
  data,
  loading,
  onClose,
}: {
  document: Document | null;
  data: Record<string, unknown> | null;
  loading: boolean;
  onClose: () => void;
}) {
  const detailedDocument = (data?.document as Document | undefined) || document;
  const tags = Array.isArray(detailedDocument?.tags)
    ? detailedDocument.tags.join(", ")
    : detailedDocument?.tags;
  const authors = Array.isArray(detailedDocument?.authors)
    ? detailedDocument.authors.join(", ")
    : detailedDocument?.authors;
  const fields = detailedDocument
    ? [
        ["ID", detailedDocument.documentId],
        ["MIME type", detailedDocument.mimeType],
        ["Chunks", data ? String(Number(data.chunkCount) || 0) : undefined],
        ["Uploaded", formatDate(detailedDocument.createdAt)],
        ["Modified", formatDate(detailedDocument.updatedAt)],
        ["Tags", tags],
        ["Authors", authors],
        ["Last error", detailedDocument.lastError],
      ].filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      )
    : [];

  return (
    <Sheet onOpenChange={(open) => !open && onClose()} open={!!document}>
      <SheetContent className="overflow-y-auto">
        {detailedDocument ? (
          <SheetHeader>
            <SheetTitle>
              {detailedDocument.title || detailedDocument.documentId}
            </SheetTitle>
            <SheetDescription>Document details</SheetDescription>
            <Badge
              variant={
                detailedDocument.status === "FAILED"
                  ? "destructive"
                  : detailedDocument.status === "EMBEDDED"
                    ? "default"
                    : "outline"
              }
            >
              {detailedDocument.status}
            </Badge>
            {loading ? (
              <FieldGroup>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </FieldGroup>
            ) : (
              <FieldGroup>
                {fields.map(([label, value]) => (
                  <Field key={String(label)}>
                    <FieldLabel>{label}</FieldLabel>
                    <FieldDescription>{String(value)}</FieldDescription>
                  </Field>
                ))}
              </FieldGroup>
            )}
          </SheetHeader>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
