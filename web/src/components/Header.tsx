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
  DropdownMenuGroup,
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
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="flex h-16 w-full items-center justify-between px-4">
          <p className="font-semibold">cheapkb</p>

          {profile ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost">
                  <Avatar size="sm">
                    {profile.picture ? (
                      <AvatarImage alt={profile.name} src={profile.picture} />
                    ) : null}
                    <AvatarFallback>{profile.initials}</AvatarFallback>
                  </Avatar>
                  <span className="hidden max-w-48 truncate sm:block">
                    {profile.email || profile.name}
                  </span>
                  <ChevronDown data-icon="inline-end" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                  <div className="flex flex-col gap-1">
                    <span className="truncate">{profile.name}</span>
                    <span className="truncate font-normal text-muted-foreground">
                      {profile.email || "Google account"}
                    </span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
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
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={onSignOut} variant="destructive">
                    <LogOut /> Log out
                  </DropdownMenuItem>
                </DropdownMenuGroup>
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
