import { LogOut } from "lucide-react";
import type { ShooIdentity } from "@/lib/types";
import { Button } from "@/components/ui/button";

export function Header({
  identity,
  onSignIn,
  onSignOut,
}: {
  identity?: ShooIdentity | null;
  onSignIn?: () => void;
  onSignOut?: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <span className="font-semibold tracking-tight">cheapkb</span>
        </div>
        {identity?.token ? (
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:block">
              {identity.userId
                ? `${identity.userId.slice(0, 12)}…`
                : "Signed in"}
            </span>
            <Button
              className="cursor-pointer"
              onClick={onSignOut}
              size="sm"
              variant="secondary"
            >
              <LogOut className="size-3.5" />
              Sign out
            </Button>
          </div>
        ) : (
          <Button className="cursor-pointer" onClick={onSignIn} size="sm">
            Sign in
          </Button>
        )}
      </div>
    </header>
  );
}
