import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CircleAlert, X } from "lucide-react";

export interface Notice {
  id: string;
  message: string;
  retry?: () => void;
  title: string;
}

/** Error notices dropping down at the top center, fed by notify() in App. Keyed
 * by content, so a repeated error updates in place instead of replaying. */
export function Notices({
  notices,
  onDismiss,
}: {
  notices: Notice[];
  onDismiss: (id: string) => void;
}) {
  if (!notices.length) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-3">
      {notices.map((notice) => (
        <div
          className="pointer-events-auto w-full max-w-md rounded-2xl shadow-sm animate-in fade-in-0 slide-in-from-top-4"
          key={`${notice.title}:${notice.message}`}
        >
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>{notice.title}</AlertTitle>
            <AlertDescription>
              <p>{notice.message}</p>
              {notice.retry ? (
                <Button
                  className="cursor-pointer"
                  onClick={() => {
                    onDismiss(notice.id);
                    notice.retry?.();
                  }}
                  size="sm"
                  variant="outline"
                >
                  Retry
                </Button>
              ) : null}
            </AlertDescription>
            <AlertAction>
              <Button
                aria-label="Dismiss"
                className="cursor-pointer"
                onClick={() => onDismiss(notice.id)}
                size="icon-sm"
                variant="ghost"
              >
                <X />
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ))}
    </div>
  );
}
