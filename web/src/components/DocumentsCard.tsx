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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
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
import {
  extractMetadata,
  getFileMimeType,
  getStatusBadgeVariant,
  isActiveStatus,
  uploadDocument,
  writePendingDocuments,
} from "@/lib/client";
import type { Document, UploadQueueItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ArrowDownUp,
  Eye,
  FilePlus2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const PAGE_SIZE = 50;
const STALLED_AFTER_MS = 5 * 60 * 1000;
const SUPPORTED_EXTENSIONS = [".pdf", ".txt", ".md"];

type SortKey = "title" | "status" | "createdAt" | "updatedAt";

export function DocumentsCard({
  documents,
  loading,
  token,
  setDocuments,
  loadDocuments,
  notify,
  onDelete,
  onReindex,
  onView,
}: {
  documents: Document[];
  loading: boolean;
  token: string;
  setDocuments: React.Dispatch<React.SetStateAction<Document[]>>;
  loadDocuments: (showLoading?: boolean) => Promise<void>;
  notify: (message: string, type?: string) => void;
  onDelete: (documentId: string) => void;
  onReindex: (documentId: string) => void;
  onView: (documentId: string) => void;
}) {
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [descending, setDescending] = useState(true);
  const [page, setPage] = useState(1);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  const syncingRef = useRef(syncing);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    syncingRef.current = syncing;
  }, [syncing]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (syncingRef.current) return;
      const validFiles = files.filter((file) =>
        SUPPORTED_EXTENSIONS.some((extension) =>
          file.name.toLowerCase().endsWith(extension),
        ),
      );
      if (validFiles.length !== files.length) {
        notify("Only PDF, Markdown, and text files were added.", "error");
      }

      const existing = new Set(
        itemsRef.current.map(
          (item) =>
            `${item.file.name}:${item.file.size}:${item.file.lastModified}`,
        ),
      );
      const queued: UploadQueueItem[] = [];
      for (const file of validFiles) {
        const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
        if (existing.has(fingerprint)) continue;
        existing.add(fingerprint);
        queued.push({
          authors: "",
          error: "",
          file,
          id: crypto.randomUUID(),
          progress: "Reading metadata",
          state: "EXTRACTING",
          tags: "",
          title: file.name.replace(/\.[^/.]+$/, ""),
          year: "",
        });
      }

      if (!queued.length) return;
      setItems((current) => [...current, ...queued]);
      for (const item of queued) {
        const metadata = await extractMetadata(item.file);
        setItems((current) =>
          current.map((currentItem) =>
            currentItem.id === item.id
              ? {
                  ...currentItem,
                  authors: metadata.authors.join(", "),
                  progress: "Ready to sync",
                  state: "READY",
                  title: metadata.title || currentItem.title,
                  year: metadata.year?.toString() || "",
                }
              : currentItem,
          ),
        );
      }
    },
    [notify],
  );

  useEffect(() => {
    function dragEnter(event: DragEvent) {
      if (syncingRef.current || !event.dataTransfer?.types.includes("Files")) {
        return;
      }
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    }

    function dragOver(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }

    function dragLeave(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    }

    function drop(event: DragEvent) {
      if (syncingRef.current || !event.dataTransfer?.files.length) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void addFiles(Array.from(event.dataTransfer.files));
    }

    window.addEventListener("dragenter", dragEnter);
    window.addEventListener("dragover", dragOver);
    window.addEventListener("dragleave", dragLeave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", dragEnter);
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("dragleave", dragLeave);
      window.removeEventListener("drop", drop);
    };
  }, [addFiles]);

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

  const filteredItems = useMemo(() => {
    const value = query.trim().toLowerCase();
    return items.filter((item) =>
      value
        ? [item.title, item.file.name, item.state].some((field) =>
            field.toLowerCase().includes(value),
          )
        : true,
    );
  }, [items, query]);

  const totalCount = filteredItems.length + filtered.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const combined = [
    ...filteredItems.map((item) => ({ item })),
    ...filtered.map((document) => ({ document })),
  ];
  const visible = combined.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selectedItem = items.find((item) => item.id === selectedItemId) || null;
  const readyCount = items.filter((item) =>
    ["READY", "FAILED"].includes(item.state),
  ).length;

  useEffect(() => {
    setPage(1);
  }, [query, sortKey, descending]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  async function syncAll() {
    if (syncingRef.current) return;
    const pending = itemsRef.current.filter((item) =>
      ["READY", "FAILED"].includes(item.state),
    );
    if (!pending.length) return;

    syncingRef.current = true;
    setSyncing(true);
    let succeeded = 0;
    let failed = 0;

    for (const item of pending) {
      updateItem(item.id, {
        error: "",
        progress: "Requesting upload URL",
        state: "SYNCING",
      });
      try {
        const documentId = await uploadDocument(
          token,
          item.file,
          {
            authors: splitList(item.authors),
            tags: splitList(item.tags),
            title: item.title.trim() || item.file.name,
            year: Number(item.year) || undefined,
          },
          (progress) => updateItem(item.id, { progress }),
        );
        const now = new Date().toISOString();
        setDocuments((current) => {
          const byId = new Map(
            current.map((document) => [document.documentId, document]),
          );
          byId.set(documentId, {
            createdAt: now,
            documentId,
            mimeType: getFileMimeType(item.file),
            status: "QUEUED",
            title: item.title.trim() || item.file.name,
            updatedAt: now,
          });
          const next = Array.from(byId.values());
          writePendingDocuments(next);
          return next;
        });
        setItems((current) =>
          current.filter((currentItem) => currentItem.id !== item.id),
        );
        succeeded += 1;
      } catch (error) {
        updateItem(item.id, {
          error: (error as Error).message,
          progress: "Sync failed",
          state: "FAILED",
        });
        failed += 1;
      }
    }

    syncingRef.current = false;
    setSyncing(false);
    await loadDocuments();
    if (failed) {
      notify(`${succeeded} synced, ${failed} need attention.`, "error");
    } else {
      notify(
        `${succeeded} document${succeeded === 1 ? "" : "s"} synced.`,
        "success",
      );
    }
  }

  function updateItem(id: string, values: Partial<UploadQueueItem>) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...values } : item)),
    );
  }

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
    if (selectedItemId === id) setSelectedItemId(null);
  }

  function sort(nextKey: SortKey) {
    if (sortKey === nextKey) setDescending((current) => !current);
    else {
      setSortKey(nextKey);
      setDescending(false);
    }
  }

  return (
    <>
      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-2 border-dashed bg-background/90">
          <p>Drop files to add them</p>
        </div>
      ) : null}
      <Card className="h-full min-w-0">
        <CardHeader>
          <CardTitle>Documents</CardTitle>
          <CardDescription>
            {documents.length + items.length} total · 50 per page
          </CardDescription>
          <CardAction className="flex items-center gap-2">
            {loading ? <Spinner /> : null}
            <Button
              disabled={syncing}
              onClick={() => fileInput.current?.click()}
              variant="outline"
            >
              <FilePlus2 data-icon="inline-start" />
              Add files
            </Button>
            <Button disabled={!readyCount || syncing} onClick={syncAll}>
              {syncing ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCw data-icon="inline-start" />
              )}
              Sync all{readyCount ? ` (${readyCount})` : ""}
            </Button>
          </CardAction>
          <input
            ref={fileInput}
            accept=".pdf,.txt,.md"
            className="hidden"
            multiple
            onChange={(event) => {
              void addFiles(Array.from(event.target.files || []));
              event.target.value = "";
            }}
            type="file"
          />
        </CardHeader>
        <CardContent className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          <InputGroup className="max-w-sm">
            <InputGroupInput
              aria-label="Search documents"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search documents"
              value={query}
            />
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
          </InputGroup>

          <div className="min-h-0 min-w-0 flex-1 overflow-hidden *:data-[slot=table-container]:h-full">
            <Table className="min-w-3xl table-fixed">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <SortableHead
                    className="w-1/2"
                    label="Document"
                    onClick={() => sort("title")}
                  />
                  <SortableHead
                    className="w-1/8"
                    label="Status"
                    onClick={() => sort("status")}
                  />
                  <SortableHead
                    className="w-1/8"
                    label="Uploaded"
                    onClick={() => sort("createdAt")}
                  />
                  <SortableHead
                    className="w-1/8"
                    label="Modified"
                    onClick={() => sort("updatedAt")}
                  />
                  <TableHead className="w-1/8 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && !documents.length && !items.length ? (
                  Array.from({ length: 4 }).map((_, index) => (
                    <TableRow key={index}>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : visible.length ? (
                  visible.map((row) =>
                    "item" in row ? (
                      <UploadRow
                        item={row.item}
                        key={row.item.id}
                        onEdit={() => setSelectedItemId(row.item.id)}
                        onRemove={() => removeItem(row.item.id)}
                      />
                    ) : (
                      <DocumentRow
                        document={row.document}
                        key={row.document.documentId}
                        onDelete={onDelete}
                        onReindex={onReindex}
                        onView={onView}
                      />
                    ),
                  )
                ) : (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>
                            {query ? "No matching documents" : "No documents"}
                          </EmptyTitle>
                          <EmptyDescription>
                            {query
                              ? "Try a different search."
                              : "Drop PDF, Markdown, or text files anywhere on this page."}
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
        <CardFooter className="justify-between">
          <CardDescription>
            {totalCount
              ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, totalCount)} of ${totalCount}`
              : "0 documents"}
          </CardDescription>
          {pageCount > 1 ? (
            <Pagination className="w-auto">
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
          ) : null}
        </CardFooter>
      </Card>

      <UploadMetadataSheet
        item={selectedItem}
        onClose={() => setSelectedItemId(null)}
        onUpdate={updateItem}
        syncing={syncing}
      />
    </>
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
        className="justify-start bg-transparent! px-0 text-inherit! hover:bg-transparent! hover:text-inherit! active:translate-y-0"
        onClick={onClick}
        size="sm"
        variant="ghost"
      >
        {label}
        <ArrowDownUp data-icon="inline-end" />
      </Button>
    </TableHead>
  );
}

function UploadRow({
  item,
  onEdit,
  onRemove,
}: {
  item: UploadQueueItem;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <TableRow
      aria-label={`Edit ${item.title}`}
      className="cursor-pointer"
      onClick={onEdit}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onEdit();
      }}
      tabIndex={0}
    >
      <TableCell className="max-w-0">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium">{item.title}</span>
          <span className="truncate text-muted-foreground">
            {getFileMimeType(item.file)} · {formatBytes(item.file.size)}
          </span>
          {item.error ? (
            <span className="truncate text-destructive">{item.error}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="max-w-0">
        <div className="flex items-center gap-2">
          {item.state === "EXTRACTING" || item.state === "SYNCING" ? (
            <Spinner />
          ) : null}
          <Badge variant="outline">{item.state}</Badge>
        </div>
      </TableCell>
      <TableCell className="truncate">—</TableCell>
      <TableCell className="truncate">—</TableCell>
      <TableCell
        className="max-w-0"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="flex justify-end gap-1">
          <ActionButton
            disabled={item.state === "SYNCING"}
            label="Edit metadata"
            onClick={onEdit}
          >
            <Pencil />
          </ActionButton>
          <ActionButton
            disabled={item.state === "SYNCING"}
            label="Remove file"
            onClick={onRemove}
          >
            <Trash2 />
          </ActionButton>
        </div>
      </TableCell>
    </TableRow>
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
  const updatedAt = Date.parse(document.updatedAt ?? document.createdAt ?? "");
  const stalled =
    isActiveStatus(document.status) &&
    Date.now() - updatedAt > STALLED_AFTER_MS;
  return (
    <TableRow
      aria-label={`View ${document.title || document.documentId}`}
      className="cursor-pointer"
      onClick={() => onView(document.documentId)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onView(document.documentId);
      }}
      tabIndex={0}
    >
      <TableCell className="max-w-0">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium">
            {document.title || document.documentId}
          </span>
          <span className="truncate text-muted-foreground">
            {document.mimeType || document.documentId}
          </span>
          {document.lastError ? (
            <span className="truncate text-destructive">
              {document.lastError}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={getStatusBadgeVariant(document.status)}>
          {document.status}
        </Badge>
      </TableCell>
      <TableCell className="truncate">
        {formatDate(document.createdAt)}
      </TableCell>
      <TableCell className="truncate">
        {formatDate(document.updatedAt)}
      </TableCell>
      <TableCell
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="flex justify-end gap-1">
          <ActionButton
            label="View details"
            onClick={() => onView(document.documentId)}
          >
            <Eye />
          </ActionButton>
          <ActionButton
            disabled={isActiveStatus(document.status) && !stalled}
            label="Reindex"
            onClick={() => onReindex(document.documentId)}
          >
            <RefreshCw />
          </ActionButton>
          <AlertDialog>
            <Tooltip>
              <AlertDialogTrigger
                render={
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Delete document"
                        size="icon-sm"
                        variant="ghost"
                      />
                    }
                  />
                }
              >
                <Trash2 />
              </AlertDialogTrigger>
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

function UploadMetadataSheet({
  item,
  onClose,
  onUpdate,
  syncing,
}: {
  item: UploadQueueItem | null;
  onClose: () => void;
  onUpdate: (id: string, values: Partial<UploadQueueItem>) => void;
  syncing: boolean;
}) {
  return (
    <Sheet onOpenChange={(open) => !open && onClose()} open={!!item}>
      <SheetContent className="overflow-y-auto">
        {item ? (
          <SheetHeader>
            <SheetTitle>{item.file.name}</SheetTitle>
            <SheetDescription>
              {getFileMimeType(item.file)} · {formatBytes(item.file.size)}
            </SheetDescription>
            <FieldGroup>
              <Field data-disabled={syncing || undefined}>
                <FieldLabel htmlFor={`title-${item.id}`}>Title</FieldLabel>
                <Input
                  disabled={syncing}
                  id={`title-${item.id}`}
                  onChange={(event) =>
                    onUpdate(item.id, { title: event.target.value })
                  }
                  value={item.title}
                />
              </Field>
              <Field data-disabled={syncing || undefined}>
                <FieldLabel htmlFor={`authors-${item.id}`}>Authors</FieldLabel>
                <Input
                  disabled={syncing}
                  id={`authors-${item.id}`}
                  onChange={(event) =>
                    onUpdate(item.id, { authors: event.target.value })
                  }
                  placeholder="Alice, Bob"
                  value={item.authors}
                />
              </Field>
              <Field data-disabled={syncing || undefined}>
                <FieldLabel htmlFor={`year-${item.id}`}>Year</FieldLabel>
                <Input
                  disabled={syncing}
                  id={`year-${item.id}`}
                  onChange={(event) =>
                    onUpdate(item.id, { year: event.target.value })
                  }
                  placeholder="2026"
                  type="number"
                  value={item.year}
                />
              </Field>
              <Field data-disabled={syncing || undefined}>
                <FieldLabel htmlFor={`tags-${item.id}`}>Tags</FieldLabel>
                <Input
                  disabled={syncing}
                  id={`tags-${item.id}`}
                  onChange={(event) =>
                    onUpdate(item.id, { tags: event.target.value })
                  }
                  placeholder="research, product"
                  value={item.tags}
                />
                <FieldDescription>
                  Separate values with commas.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </SheetHeader>
        ) : null}
      </SheetContent>
    </Sheet>
  );
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
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function getSortValue(document: Document, key: SortKey): string {
  if (key === "title") return document.title || document.documentId;
  return document[key] || "";
}

function splitList(value: string): string[] | undefined {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
