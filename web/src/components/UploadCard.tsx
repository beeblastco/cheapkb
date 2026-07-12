import { useState, useRef } from "react";
import { LoaderCircle, Plus, Upload } from "lucide-react";
import type { Document, Toast } from "@/lib/types";
import {
  extractMetadata,
  getFileMimeType,
  uploadDocument,
  writePendingDocuments,
} from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/Field";
import { cn } from "@/lib/utils";

function splitList(value: string): string[] | undefined {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

export function UploadCard({
  token,
  documents,
  setDocuments,
  loadDocuments,
  notify,
}: {
  token: string;
  documents: Document[];
  setDocuments: React.Dispatch<React.SetStateAction<Document[]>>;
  loadDocuments: (showLoading?: boolean) => Promise<void>;
  notify: (message: string, type?: Toast["type"]) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState("");
  const [values, setValues] = useState({
    title: "",
    tags: "",
    year: "",
    authors: "",
  });
  const fileInput = useRef<HTMLInputElement>(null);

  async function chooseFile(selectedFile: File | undefined) {
    if (!selectedFile || uploading) return;
    setFile(selectedFile);
    setExtracting(true);
    const metadata = await extractMetadata(selectedFile);
    setValues((current) => ({
      title: current.title || metadata.title || "",
      tags: current.tags,
      year: current.year?.toString() || "",
      authors: current.authors || metadata.authors?.join(", ") || "",
    }));
    setExtracting(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file || uploading) return;
    setUploading(true);
    setStatus("Requesting upload URL…");
    const tempId = `temp_${Date.now()}`;
    const now = new Date().toISOString();
    const optimistic: Document = {
      documentId: tempId,
      title: values.title.trim() || file.name,
      status: "UPLOADING",
      mimeType: getFileMimeType(file),
      createdAt: now,
      updatedAt: now,
    };
    const next = [optimistic, ...documents];
    setDocuments(next);
    writePendingDocuments(next);

    let createdDocumentId: string | null = null;
    try {
      createdDocumentId = await uploadDocument(
        token,
        file,
        {
          title: values.title.trim() || file.name,
          tags: splitList(values.tags),
          year: Number(values.year) || undefined,
          authors: splitList(values.authors),
        },
        setStatus,
      );
      setDocuments((current) =>
        current.map((document) =>
          document.documentId === tempId
            ? {
                ...document,
                documentId: createdDocumentId!,
                status: "QUEUED",
                updatedAt: new Date().toISOString(),
              }
            : document,
        ),
      );
      setFile(null);
      setValues({ title: "", tags: "", year: "", authors: "" });
      setStatus("");
      notify("Uploaded. Indexing has started.", "success");
      await loadDocuments();
    } catch (error) {
      const failedDocumentId =
        createdDocumentId ??
        (error as Error & { documentId?: string }).documentId ??
        tempId;
      setDocuments((current) => {
        const failed = current.map((document) =>
          document.documentId === tempId
            ? {
                ...document,
                documentId: failedDocumentId,
                status: "FAILED",
                lastError: (error as Error).message,
                updatedAt: new Date().toISOString(),
              }
            : document,
        );
        writePendingDocuments(failed);
        return failed;
      });
      setStatus("");
      notify((error as Error).message, "error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload document</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <button
            className={cn(
              "flex w-full cursor-pointer flex-col items-center rounded-lg border border-dashed border-border bg-muted/50 px-6 py-8 text-center transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50",
              dragging && "border-primary bg-primary/5",
            )}
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              chooseFile(event.dataTransfer.files[0]);
            }}
            type="button"
          >
            <Upload className="mb-3 size-5 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              {file?.name || "Drop a file here, or click to browse"}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              {extracting ? "Extracting metadata…" : "PDF, Markdown, or text"}
            </span>
          </button>
          <input
            ref={fileInput}
            accept=".pdf,.txt,.md"
            className="hidden"
            onChange={(event) => chooseFile(event.target.files?.[0])}
            type="file"
          />

          <details className="group rounded-lg border border-border bg-muted/30">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm text-muted-foreground hover:text-foreground">
              Optional details
              <Plus className="float-right size-4 transition-transform group-open:rotate-45" />
            </summary>
            <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-2">
              <Field className="sm:col-span-2" label="Title">
                <Input
                  disabled={uploading}
                  onChange={(event) =>
                    setValues({ ...values, title: event.target.value })
                  }
                  placeholder="My document"
                  value={values.title}
                />
              </Field>
              <Field label="Tags">
                <Input
                  disabled={uploading}
                  onChange={(event) =>
                    setValues({ ...values, tags: event.target.value })
                  }
                  placeholder="research, blog"
                  value={values.tags}
                />
              </Field>
              <Field label="Year">
                <Input
                  disabled={uploading}
                  onChange={(event) =>
                    setValues({ ...values, year: event.target.value })
                  }
                  placeholder="2026"
                  type="number"
                  value={values.year}
                />
              </Field>
              <Field className="sm:col-span-2" label="Authors">
                <Input
                  disabled={uploading}
                  onChange={(event) =>
                    setValues({ ...values, authors: event.target.value })
                  }
                  placeholder="Alice, Bob"
                  value={values.authors}
                />
              </Field>
            </div>
          </details>
          <div className="flex items-center gap-3">
            <Button
              className="cursor-pointer"
              disabled={!file || uploading}
              type="submit"
            >
              {uploading && (
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              )}
              {uploading ? "Uploading" : "Upload"}
            </Button>
            <span className="text-xs text-muted-foreground">{status}</span>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
