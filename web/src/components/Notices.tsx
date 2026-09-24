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
  title: string;
  message: string;
}

// Error notices drop down from the top center of the screen. App owns the list
// and removes each notice after a few seconds or when it is closed.
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
        <Alert
          className="pointer-events-auto w-full max-w-md shadow-sm animate-in fade-in-0 slide-in-from-top-4"
          key={notice.id}
          variant="destructive"
        >
          <CircleAlert />
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.message}</AlertDescription>
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
      ))}
    </div>
  );
}
