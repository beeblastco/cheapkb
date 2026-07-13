import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Toast } from "@/lib/types";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

const ICONS = {
  error: AlertCircle,
  info: Info,
  success: CheckCircle2,
} as const;

export function Banner({
  toast,
  onDismiss,
}: {
  toast: Toast | null;
  onDismiss: () => void;
}) {
  if (!toast) return null;
  const Icon = ICONS[toast.type];
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex justify-center px-3">
      <Alert
        className="pointer-events-auto w-full max-w-md"
        variant={toast.type === "error" ? "destructive" : "default"}
      >
        <Icon />
        <AlertDescription>{toast.message}</AlertDescription>
        <AlertAction>
          <Button
            aria-label="Dismiss notification"
            onClick={onDismiss}
            size="icon-sm"
            variant="ghost"
          >
            <X />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
