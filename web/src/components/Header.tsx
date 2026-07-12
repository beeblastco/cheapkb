import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getUserProfile } from "@/lib/client";
import type { ShooIdentity } from "@/lib/types";
import {
  ChevronDown,
  Contact,
  FileLock,
  LogOut,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { useState } from "react";

const MENU_CONTENT = {
  settings: {
    title: "Settings",
    description:
      "Your workspace follows your Google identity. Documents, searches, and rate limits stay scoped to this account.",
  },
  terms: {
    title: "Terms and conditions",
    description:
      "Only upload material you are allowed to process. This service is provided as-is for private knowledge retrieval.",
  },
  privacy: {
    title: "Privacy policy",
    description:
      "Source files, metadata, and vectors are stored in this project's private AWS resources and isolated by your signed identity.",
  },
} as const;

export function Header({
  identity,
  onSignOut,
}: {
  identity?: ShooIdentity | null;
  onSignOut?: () => void;
}) {
  const [dialog, setDialog] = useState<keyof typeof MENU_CONTENT | null>(null);
  const profile = identity?.token ? getUserProfile(identity) : null;

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-4 sm:px-6">
          <div>
            <p className="text-base font-semibold tracking-tight">cheapkb</p>
          </div>

          {profile ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="h-10 gap-2 px-2" variant="ghost">
                  <Avatar size="sm">
                    <AvatarImage alt={profile.name} src={profile.picture} />
                    <AvatarFallback>{profile.initials}</AvatarFallback>
                  </Avatar>
                  <span className="hidden max-w-40 truncate text-sm sm:block">
                    {profile.name}
                  </span>
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>
                  <span className="block truncate font-medium text-foreground">
                    {profile.name}
                  </span>
                  <span className="mt-0.5 block truncate font-normal">
                    {profile.email || identity?.userId}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setDialog("settings")}>
                  <Settings /> Settings
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog("terms")}>
                  <SlidersHorizontal /> Terms and conditions
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog("privacy")}>
                  <FileLock /> Privacy policy
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a
                    href="https://github.com/beeblastco/cheapkb/issues"
                    rel="noreferrer"
                    target="_blank"
                  >
                    <Contact /> Contact
                  </a>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onSignOut} variant="destructive">
                  <LogOut /> Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </header>

      <Dialog onOpenChange={(open) => !open && setDialog(null)} open={!!dialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog ? MENU_CONTENT[dialog].title : ""}
            </DialogTitle>
            <DialogDescription>
              {dialog ? MENU_CONTENT[dialog].description : ""}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
