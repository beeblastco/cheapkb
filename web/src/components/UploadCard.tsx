import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  extractMetadata,
  getFileMimeType,
  uploadDocument,
  writePendingDocuments,
} from "@/lib/client";
import type { Document, Toast } from "@/lib/types";
import { cn } from "@/lib/utils";
import { LoaderCircle, Plus, Upload } from "lucide-react";
import { useRef, useState } from "react";

const EMPTY_VALUES = {
  title: "",
  tags: "",
  year: "",
  authors: "",
};

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
  const [values, setValues] = useState(EMPTY_VALUES);
  const details = useRef<HTMLDetailsElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function chooseFile(selectedFile: File | undefined) {
    if (!selectedFile || extracting || uploading) return;
    setFile(selectedFile);
    setExtracting(true);
    try {
      const metadata = await extractMetadata(selectedFile);
      setValues({
        title: metadata.title || "",
        tags: "",
        year: metadata.year?.toString() || "",
        authors: metadata.authors?.join(", ") || "",
      });
    } catch {
      setValues(EMPTY_VALUES);
      notify("Could not read document metadata.", "error");
    } finally {
      setExtracting(false);
    }
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
      notify("Uploaded. Indexing has started.", "success");
      void loadDocuments();
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
      notify((error as Error).message, "error");
    } finally {
      setFile(null);
      setValues(EMPTY_VALUES);
      setStatus("");
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
      if (details.current) details.current.open = false;
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
            disabled={extracting || uploading}
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

          <details
            ref={details}
            className="group rounded-lg border border-border bg-muted/30"
          >
            <summary className="cursor-pointer list-none px-4 py-3 text-sm text-muted-foreground hover:text-foreground">
              Optional details
              <Plus className="float-right size-4 transition-transform group-open:rotate-45" />
            </summary>
            <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-2">
              <Field
                className="sm:col-span-2"
                htmlFor="upload-title"
                label="Title"
              >
                <Input
                  disabled={uploading}
                  id="upload-title"
                  onChange={(event) =>
                    setValues({ ...values, title: event.target.value })
                  }
                  placeholder="My document"
                  value={values.title}
                />
              </Field>
              <Field htmlFor="upload-tags" label="Tags">
                <Input
                  disabled={uploading}
                  id="upload-tags"
                  onChange={(event) =>
                    setValues({ ...values, tags: event.target.value })
                  }
                  placeholder="research, blog"
                  value={values.tags}
                />
              </Field>
              <Field htmlFor="upload-year" label="Year">
                <Input
                  disabled={uploading}
                  id="upload-year"
                  onChange={(event) =>
                    setValues({ ...values, year: event.target.value })
                  }
                  placeholder="2026"
                  type="number"
                  value={values.year}
                />
              </Field>
              <Field
                className="sm:col-span-2"
                htmlFor="upload-authors"
                label="Authors"
              >
                <Input
                  disabled={uploading}
                  id="upload-authors"
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
              disabled={!file || extracting || uploading}
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

function splitList(value: string): string[] | undefined {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}
