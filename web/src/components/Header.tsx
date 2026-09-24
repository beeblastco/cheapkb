import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { ShooIdentity, UsageSummary } from "@/lib/types";
import { formatBytes } from "@/lib/utils";
import {
  HelpCircle,
  LogOut,
  Scale,
  Settings,
  Shield,
  Trash2,
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
  usage,
  onSignOut,
  onDeleteAllData,
}: {
  identity?: ShooIdentity | null;
  usage?: UsageSummary | null;
  onSignOut?: () => void;
  onDeleteAllData?: () => Promise<void>;
}) {
  const [dialog, setDialog] = useState<keyof typeof MENU_CONTENT | null>(null);
  const [deletingData, setDeletingData] = useState(false);
  const profile = identity?.token ? getUserProfile(identity) : null;
  const usagePct = usage ? Math.min(usage.pctUsed, 100) : 0;

  return (
    <>
      <header className="sticky top-0 z-40 bg-background px-3 pt-3">
        <Card size="sm">
          <CardContent className="flex items-center justify-between">
            <p className="font-semibold">cheapkb</p>

            {profile ? (
              <DropdownMenu>
                <DropdownMenuTrigger className="cursor-pointer">
                  <span className="flex items-center gap-2">
                    <span className="hidden max-w-48 truncate sm:block">
                      {profile.email || profile.name}
                    </span>
                    <Avatar size="sm">
                      {profile.picture ? (
                        <AvatarImage alt={profile.name} src={profile.picture} />
                      ) : null}
                      <AvatarFallback>{profile.initials}</AvatarFallback>
                    </Avatar>
                  </span>
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
                    <DropdownMenuItem onClick={() => setDialog("settings")}>
                      <Settings /> Settings
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => setDialog("terms")}>
                      <Scale /> Terms and conditions
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDialog("privacy")}>
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
            ) : null}
          </CardContent>
        </Card>
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
          {dialog === "settings" ? (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Current usage</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-2">
                    <p className="text-2xl font-semibold tracking-tight tabular-nums">
                      {usagePct.toFixed(0)}%
                      <span className="ml-2 text-base font-normal text-muted-foreground">
                        used
                      </span>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {usage ? `${usage.planLabel} plan` : "—"}
                    </p>
                    {usage ? (
                      <p className="text-sm text-muted-foreground">
                        Storage: {formatBytes(usage.storageBytes)}
                      </p>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Your data</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col items-start gap-2">
                    <p className="text-sm text-muted-foreground">
                      Delete every document, image and tag in this account and
                      reset storage to 0. Usage already spent this cycle stays.
                    </p>
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button
                            disabled={deletingData}
                            variant="destructive"
                          />
                        }
                      >
                        <Trash2 data-icon="inline-start" />
                        Delete all my data
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Delete all your data?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            All documents, their search data and your tags are
                            deleted. This can't be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={async () => {
                              setDeletingData(true);
                              try {
                                await onDeleteAllData?.();
                                setDialog(null);
                              } finally {
                                setDeletingData(false);
                              }
                            }}
                            variant="destructive"
                          >
                            Delete everything
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
