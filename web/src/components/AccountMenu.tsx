import type { SettingsTab } from "@/components/SettingsDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getUserProfile } from "@/lib/client";
import type { ShooIdentity } from "@/lib/types";
import {
  HelpCircle,
  LogOut,
  Plug,
  Scale,
  Settings,
  Shield,
} from "lucide-react";
import { useState } from "react";

const POLICIES = {
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

/** Avatar menu at the end of the documents toolbar. Opens Settings on a tab, the
 * policy dialogs, help, and sign-out. */
export function AccountMenu({
  identity,
  onOpenSettings,
  onSignOut,
}: {
  identity: ShooIdentity;
  onOpenSettings: (tab: SettingsTab) => void;
  onSignOut: () => void;
}): React.JSX.Element {
  const [policy, setPolicy] = useState<keyof typeof POLICIES | null>(null);
  const profile = getUserProfile(identity);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Account menu"
          className="cursor-pointer"
        >
          <Avatar size="sm">
            {profile.picture ? (
              <AvatarImage alt={profile.name} src={profile.picture} />
            ) : null}
            <AvatarFallback>{profile.initials}</AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              <div className="flex flex-col gap-1">
                <span className="truncate">{profile.name}</span>
                <span className="truncate font-normal text-muted-foreground">
                  {profile.email || "Google account"}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onOpenSettings("usage")}>
              <Settings /> Settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenSettings("agent")}>
              <Plug /> Connect agent
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setPolicy("terms")}>
              <Scale /> Terms and conditions
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setPolicy("privacy")}>
              <Shield /> Privacy policy
            </DropdownMenuItem>
            <DropdownMenuItem
              render={
                <a
                  href="https://github.com/beeblastco/cheapkb/issues"
                  rel="noreferrer"
                  target="_blank"
                />
              }
            >
              <HelpCircle /> Help
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={onSignOut} variant="destructive">
              <LogOut /> Log out
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        onOpenChange={(open) => !open && setPolicy(null)}
        open={Boolean(policy)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{policy ? POLICIES[policy].title : ""}</DialogTitle>
            <DialogDescription>
              {policy ? POLICIES[policy].description : ""}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
