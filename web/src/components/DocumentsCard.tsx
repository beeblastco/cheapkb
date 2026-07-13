import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isActiveStatus } from "@/lib/client";
import type { Document, DocumentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ArrowDownUp,
  Eye,
  FileText,
  Loader2,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const PAGE_SIZE = 50;
const STALLED_AFTER_MS = 5 * 60 * 1000;

type SortKey = "title" | "status" | "createdAt" | "updatedAt";

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
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [descending, setDescending] = useState(true);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    return documents
      .filter((document) =>
        value
          ? [document.title, document.documentId, document.status]
              .filter(Boolean)
              .some((field) => field!.toLowerCase().includes(value))
          : true,
      )
      .sort((left, right) => {
        const a = getSortValue(left, sortKey);
        const b = getSortValue(right, sortKey);
        return a.localeCompare(b) * (descending ? -1 : 1);
      });
  }, [descending, documents, query, sortKey]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [query, sortKey, descending]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  function sort(nextKey: SortKey) {
    if (sortKey === nextKey) setDescending((current) => !current);
    else {
      setSortKey(nextKey);
      setDescending(false);
    }
  }

  return (
    <Card className="min-h-[34rem] gap-0 overflow-hidden py-0">
      <CardHeader className="flex-row items-center justify-between border-b border-border py-4">
        <div>
          <CardTitle>Documents</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {documents.length} total · 50 per page
          </p>
        </div>
        {loading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
        )}
      </CardHeader>
      <CardContent className="flex min-h-[30rem] flex-col p-0">
        <div className="border-b border-border p-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search documents"
              className="pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search documents"
              value={query}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1">
          <Table className="table-fixed">
            <colgroup>
              <col className="w-[40%]" />
              <col className="w-auto" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-32" />
            </colgroup>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortableHead label="Document" onClick={() => sort("title")} />
                <SortableHead label="Status" onClick={() => sort("status")} />
                <SortableHead
                  label="Uploaded"
                  onClick={() => sort("createdAt")}
                />
                <SortableHead
                  label="Modified"
                  onClick={() => sort("updatedAt")}
                />
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !documents.length
                ? Array.from({ length: 4 }).map((_, index) => (
                    <TableRow key={index}>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                : visible.map((document) => (
                    <DocumentRow
                      document={document}
                      key={document.documentId}
                      onDelete={onDelete}
                      onReindex={onReindex}
                      onView={onView}
                    />
                  ))}
            </TableBody>
          </Table>

          {!loading && !visible.length && (
            <Empty className="border-0">
              <EmptyMedia variant="icon">
                <FileText />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>
                  {query ? "No matching documents" : "No documents yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {query
                    ? "Try a different search."
                    : "Drop files into the queue, then sync them."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            {filtered.length
              ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, filtered.length)} of ${filtered.length}`
              : "0 documents"}
          </p>
          {pageCount > 1 && (
            <Pagination className="mx-0 w-auto">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    aria-disabled={page === 1}
                    className={cn(
                      page === 1 && "pointer-events-none opacity-50",
                    )}
                    href="#"
                    onClick={(event) => {
                      event.preventDefault();
                      setPage((current) => Math.max(1, current - 1));
                    }}
                    text=""
                  />
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    aria-disabled={page === pageCount}
                    className={cn(
                      page === pageCount && "pointer-events-none opacity-50",
                    )}
                    href="#"
                    onClick={(event) => {
                      event.preventDefault();
                      setPage((current) => Math.min(pageCount, current + 1));
                    }}
                    text=""
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SortableHead({
  className,
  label,
  onClick,
}: {
  className?: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <TableHead className={className}>
      <Button
        className="-ml-3 h-8 px-3 text-xs"
        onClick={onClick}
        variant="ghost"
      >
        {label}
        <ArrowDownUp className="size-3" />
      </Button>
    </TableHead>
  );
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
  const title = document.title || document.documentId;
  const subtitle = document.mimeType || document.documentId;
  return (
    <TableRow>
      <TableCell className="overflow-hidden">
        <p className="truncate font-medium" title={title}>
          {title}
        </p>
        <p
          className="mt-1 truncate text-xs text-muted-foreground"
          title={subtitle}
        >
          {subtitle}
        </p>
        {document.lastError && (
          <p
            className="mt-1 truncate text-xs text-destructive"
            title={document.lastError}
          >
            {document.lastError}
          </p>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge
          optimistic={optimistic}
          stalled={stalled}
          status={document.status as DocumentStatus}
        />
      </TableCell>
      <TableCell className="truncate text-xs text-muted-foreground">
        {formatDate(document.createdAt)}
      </TableCell>
      <TableCell className="truncate text-xs text-muted-foreground">
        {formatDate(document.updatedAt)}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <ActionButton
            disabled={optimistic}
            label="View details"
            onClick={() => onView(document.documentId)}
          >
            <Eye />
          </ActionButton>
          <ActionButton
            disabled={
              optimistic || (isActiveStatus(document.status) && !stalled)
            }
            label="Reindex"
            onClick={() => onReindex(document.documentId)}
          >
            <RefreshCw />
          </ActionButton>
          <AlertDialog>
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertDialogTrigger asChild>
                  <Button
                    aria-label="Delete document"
                    disabled={optimistic || document.status === "DELETING"}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2 />
                  </Button>
                </AlertDialogTrigger>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this document?</AlertDialogTitle>
                <AlertDialogDescription>
                  The source, parsed content, chunks, and vectors will be
                  removed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDelete(document.documentId)}
                  variant="destructive"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TableCell>
    </TableRow>
  );
}

function StatusBadge({
  optimistic,
  stalled,
  status,
}: {
  optimistic: boolean;
  stalled: boolean;
  status: DocumentStatus | string;
}) {
  if (optimistic) {
    return (
      <Badge variant="secondary">
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
        Uploading
      </Badge>
    );
  }
  if (status === "FAILED") {
    return <Badge variant="destructive">Failed</Badge>;
  }
  if (status === "EMBEDDED") {
    return <Badge variant="default">Ready</Badge>;
  }
  if (stalled) {
    return <Badge variant="destructive">Stalled</Badge>;
  }
  if (isActiveStatus(status)) {
    return (
      <Badge variant="secondary">
        <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
        {humanize(status)}
      </Badge>
    );
  }
  if (status === "DELETING") {
    return (
      <Badge variant="secondary">
        <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
        Deleting
      </Badge>
    );
  }
  return <Badge variant="outline">{humanize(status)}</Badge>;
}

function humanize(status: string): string {
  return status
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function ActionButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-sm"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function getSortValue(document: Document, key: SortKey): string {
  if (key === "title") return document.title || document.documentId;
  return document[key] || "";
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
