import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  extractMetadata,
  getFileMimeType,
  uploadDocument,
  writePendingDocuments,
} from "@/lib/client";
import type { Document, Toast, UploadQueueItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  FileText,
  LoaderCircle,
  RefreshCw,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

const SUPPORTED_EXTENSIONS = [".pdf", ".txt", ".md"];

export function UploadCard({
  token,
  setDocuments,
  loadDocuments,
  notify,
}: {
  token: string;
  setDocuments: React.Dispatch<React.SetStateAction<Document[]>>;
  loadDocuments: (showLoading?: boolean) => Promise<void>;
  notify: (message: string, type?: Toast["type"]) => void;
}) {
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  async function addFiles(files: File[]) {
    if (syncing) return;
    const validFiles = files.filter((file) =>
      SUPPORTED_EXTENSIONS.some((extension) =>
        file.name.toLowerCase().endsWith(extension),
      ),
    );
    if (validFiles.length !== files.length) {
      notify("Only PDF, Markdown, and text files were added.", "error");
    }
    const existing = new Set(
      items.map((item) => `${item.file.name}:${item.file.size}`),
    );
    const queued = validFiles
      .filter((file) => !existing.has(`${file.name}:${file.size}`))
      .map((file) => ({
        authors: "",
        error: "",
        file,
        id: crypto.randomUUID(),
        progress: "Reading metadata",
        state: "EXTRACTING" as const,
        tags: "",
        title: file.name.replace(/\.[^/.]+$/, ""),
        year: "",
      }));

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
  }

  async function syncAll() {
    const pending = items.filter((item) =>
      ["READY", "FAILED"].includes(item.state),
    );
    if (!pending.length || syncing) return;
    setSyncing(true);
    let succeeded = 0;
    let failed = 0;

    for (const item of pending) {
      const tempId = `temp_${item.id}`;
      const now = new Date().toISOString();
      setItems((current) =>
        current.map((currentItem) =>
          currentItem.id === item.id
            ? {
                ...currentItem,
                error: "",
                progress: "Requesting upload URL",
                state: "SYNCING",
              }
            : currentItem,
        ),
      );
      setDocuments((current) => {
        const next: Document[] = [
          {
            createdAt: now,
            documentId: tempId,
            mimeType: getFileMimeType(item.file),
            status: "UPLOADING",
            title: item.title || item.file.name,
            updatedAt: now,
          },
          ...current,
        ];
        writePendingDocuments(next);
        return next;
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
          (progress) =>
            setItems((current) =>
              current.map((currentItem) =>
                currentItem.id === item.id
                  ? { ...currentItem, progress }
                  : currentItem,
              ),
            ),
        );
        setDocuments((current) =>
          current.map((document) =>
            document.documentId === tempId
              ? {
                  ...document,
                  documentId,
                  status: "QUEUED",
                  updatedAt: new Date().toISOString(),
                }
              : document,
          ),
        );
        setItems((current) =>
          current.filter((currentItem) => currentItem.id !== item.id),
        );
        succeeded += 1;
      } catch (error) {
        setDocuments((current) => {
          const next = current.filter(
            (document) => document.documentId !== tempId,
          );
          writePendingDocuments(next);
          return next;
        });
        setItems((current) =>
          current.map((currentItem) =>
            currentItem.id === item.id
              ? {
                  ...currentItem,
                  error: (error as Error).message,
                  progress: "Sync failed",
                  state: "FAILED",
                }
              : currentItem,
          ),
        );
        failed += 1;
      }
    }

    setSyncing(false);
    if (fileInput.current) fileInput.current.value = "";
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
  }

  useEffect(() => {
    function dragEnter(event: DragEvent) {
      if (syncing || !event.dataTransfer?.types.includes("Files")) return;
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
      if (syncing || !event.dataTransfer?.files.length) return;
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
  });

  const readyCount = items.filter((item) =>
    ["READY", "FAILED"].includes(item.state),
  ).length;

  return (
    <>
      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/90 backdrop-blur-md">
          <div className="text-center">
            <UploadCloud className="mx-auto size-7 text-primary" />
            <p className="mt-3 text-sm font-semibold">Drop files to add them</p>
            <p className="mt-1 text-xs text-muted-foreground">
              PDF, Markdown, and text
            </p>
          </div>
        </div>
      )}
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="flex-row items-center justify-between border-b border-border py-4">
          <div>
            <CardTitle>Upload queue</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Drop several files, review metadata, then sync once.
            </p>
          </div>
          <Button disabled={!readyCount || syncing} onClick={syncAll}>
            {syncing ? (
              <LoaderCircle className="animate-spin motion-reduce:animate-none" />
            ) : (
              <RefreshCw />
            )}
            Sync all{readyCount ? ` (${readyCount})` : ""}
          </Button>
        </CardHeader>
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/20 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">
              Drag files anywhere in the workspace or choose them manually.
            </p>
            <Button
              disabled={syncing}
              onClick={() => fileInput.current?.click()}
              size="sm"
              variant="outline"
            >
              Choose files
            </Button>
          </div>
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

          {items.length > 0 && (
            <div className="mt-4 space-y-2">
              {items.map((item) => (
                <Collapsible
                  className="overflow-hidden rounded-xl border border-border bg-background"
                  key={item.id}
                >
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                      {item.state === "EXTRACTING" ||
                      item.state === "SYNCING" ? (
                        <LoaderCircle className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
                      ) : (
                        <FileText className="size-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.file.name}
                      </p>
                      <p
                        className={cn(
                          "mt-0.5 truncate font-mono text-[10px] text-muted-foreground",
                          item.state === "FAILED" && "text-destructive",
                        )}
                      >
                        {item.state} · {item.progress}
                      </p>
                    </div>
                    <CollapsibleTrigger asChild>
                      <Button
                        aria-label={`Edit metadata for ${item.file.name}`}
                        disabled={syncing}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <ChevronDown className="size-4" />
                      </Button>
                    </CollapsibleTrigger>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          aria-label={`Remove ${item.file.name}`}
                          disabled={syncing}
                          onClick={() => removeItem(item.id)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Remove from queue</TooltipContent>
                    </Tooltip>
                  </div>
                  <CollapsibleContent>
                    <Separator />
                    <div className="grid gap-3 p-3 sm:grid-cols-2">
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor={`title-${item.id}`}>Title</Label>
                        <Input
                          disabled={syncing}
                          id={`title-${item.id}`}
                          onChange={(event) =>
                            updateItem(item.id, { title: event.target.value })
                          }
                          value={item.title}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`authors-${item.id}`}>Authors</Label>
                        <Input
                          disabled={syncing}
                          id={`authors-${item.id}`}
                          onChange={(event) =>
                            updateItem(item.id, { authors: event.target.value })
                          }
                          placeholder="Alice, Bob"
                          value={item.authors}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`year-${item.id}`}>Year</Label>
                        <Input
                          disabled={syncing}
                          id={`year-${item.id}`}
                          onChange={(event) =>
                            updateItem(item.id, { year: event.target.value })
                          }
                          placeholder="2026"
                          type="number"
                          value={item.year}
                        />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor={`tags-${item.id}`}>Tags</Label>
                        <Input
                          disabled={syncing}
                          id={`tags-${item.id}`}
                          onChange={(event) =>
                            updateItem(item.id, { tags: event.target.value })
                          }
                          placeholder="research, product"
                          value={item.tags}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground sm:col-span-2">
                        {getFileMimeType(item.file)} ·{" "}
                        {formatBytes(item.file.size)}
                      </p>
                      {item.error && (
                        <p className="text-xs text-destructive sm:col-span-2">
                          {item.error}
                        </p>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
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
