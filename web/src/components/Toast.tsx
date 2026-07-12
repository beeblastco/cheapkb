import type { Toast } from "@/lib/types";

export function Toast({ toast }: { toast: Toast | null }) {
  if (!toast) return null;
  return (
    <div
      className={`fixed bottom-4 right-4 z-[100] max-w-sm rounded-lg border px-4 py-3 text-sm shadow-2xl ${
        toast.type === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : toast.type === "success"
            ? "border-emerald-500/30 bg-emerald-950 text-emerald-200"
            : "border-border bg-background text-foreground"
      }`}
      role="status"
    >
      {toast.message}
    </div>
  );
}
