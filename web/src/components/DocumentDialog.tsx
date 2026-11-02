import { TagBadge } from "@/components/TagBadge";
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
import { formatDate, getStatusBadgeVariant } from "@/lib/client";
import type { Document, TagColor } from "@/lib/types";

export function DocumentDialog({
  colorOf,
  document,
  data,
  loading,
  onClose,
}: {
  colorOf: (name: string) => TagColor;
  document: Document | null;
  data: Record<string, unknown> | null;
  loading: boolean;
  onClose: () => void;
}) {
  const detailedDocument = (data?.document as Document | undefined) || document;
  const tags = Array.isArray(detailedDocument?.tags)
    ? detailedDocument.tags
    : [];
  const authors = Array.isArray(detailedDocument?.authors)
    ? detailedDocument.authors.join(", ")
    : detailedDocument?.authors;
  const fields: Array<[string, React.ReactNode]> = detailedDocument
    ? (
        [
          ["ID", detailedDocument.documentId],
          ["MIME type", detailedDocument.mimeType],
          // Only the chunk count waits on the details fetch; the list already has the rest.
          [
            "Chunks",
            data
              ? String(Number(data.chunkCount) || 0)
              : loading
                ? "Loading"
                : undefined,
          ],
          ["Uploaded", formatDate(detailedDocument.createdAt, true)],
          ["Modified", formatDate(detailedDocument.updatedAt, true)],
          [
            "Tags",
            // A span, not a div: FieldDescription renders a <p>.
            tags.length ? (
              <span className="flex flex-wrap gap-1.5">
                {tags.map((name) => (
                  <TagBadge color={colorOf(name)} key={name} name={name} />
                ))}
              </span>
            ) : undefined,
          ],
          ["Authors", authors],
          ["Last error", detailedDocument.lastError],
        ] as Array<[string, React.ReactNode]>
      ).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      )
    : [];

  return (
    <Sheet onOpenChange={(open) => !open && onClose()} open={Boolean(document)}>
      <SheetContent className="overflow-y-auto">
        {detailedDocument ? (
          <SheetHeader>
            <SheetTitle>
              {detailedDocument.title || detailedDocument.documentId}
            </SheetTitle>
            <SheetDescription>Document details</SheetDescription>
            <Badge variant={getStatusBadgeVariant(detailedDocument.status)}>
              {detailedDocument.status}
            </Badge>
            <FieldGroup>
              {fields.map(([label, value]) => (
                <Field key={label}>
                  <FieldLabel>{label}</FieldLabel>
                  <FieldDescription>{value}</FieldDescription>
                </Field>
              ))}
            </FieldGroup>
          </SheetHeader>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
