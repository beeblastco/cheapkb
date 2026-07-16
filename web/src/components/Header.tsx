import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getAccount,
  getUserProfile,
  listPlans,
  updatePlan,
} from "@/lib/client";
import type { Account, Plan, ShooIdentity, UsageSummary } from "@/lib/types";
import { formatBytes } from "@/lib/utils";
import { HelpCircle, LogOut, Scale, Settings, Shield } from "lucide-react";
import { useEffect, useState } from "react";

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
  onUsageChange,
  onSignOut,
}: {
  identity?: ShooIdentity | null;
  usage?: UsageSummary | null;
  onUsageChange?: () => void;
  onSignOut?: () => void;
}) {
  const [dialog, setDialog] = useState<keyof typeof MENU_CONTENT | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [account, setAccount] = useState<Account | null>(null);
  const [updating, setUpdating] = useState(false);
  const profile = identity?.token ? getUserProfile(identity) : null;
  const usagePct = usage ? Math.min(usage.pctUsed, 100) : 0;

  useEffect(() => {
    async function loadSettings(token: string) {
      try {
        const [plansData, accountData] = await Promise.all([
          listPlans(token),
          getAccount(token),
        ]);
        setPlans(plansData);
        setAccount(accountData);
      } catch {
        setPlans([]);
        setAccount(null);
      }
    }
    const token = identity?.token;
    if (token && dialog === "settings") {
      loadSettings(token);
    }
  }, [identity?.token, dialog]);

  return (
    <>
      <header className="sticky top-0 z-40 bg-background">
        <div className="flex h-16 w-full items-center justify-between px-3">
          <p className="font-semibold">cheapkb</p>

          {profile ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="cursor-pointer!"
                render={
                  <Button
                    className="bg-transparent! text-inherit! hover:bg-transparent! hover:text-inherit! active:translate-y-0"
                    variant="ghost"
                  />
                }
              >
                <span className="hidden max-w-48 truncate sm:block">
                  {profile.email || profile.name}
                </span>
                {usage ? (
                  <Badge variant="secondary" className="hidden sm:flex">
                    {usage.planLabel}
                  </Badge>
                ) : null}
                <Avatar size="sm">
                  {profile.picture ? (
                    <AvatarImage alt={profile.name} src={profile.picture} />
                  ) : null}
                  <AvatarFallback>{profile.initials}</AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
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
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled>
                    <span className="flex flex-1 items-center justify-between">
                      <span className="text-muted-foreground">Usage</span>
                      <span className="font-medium tabular-nums">
                        {usagePct.toFixed(0)}%
                      </span>
                    </span>
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
          {dialog === "settings" ? (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium">
                    Current usage
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
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
                </CardContent>
              </Card>
              <div className="space-y-2">
                <p className="text-sm font-medium">Plan</p>
                <div className="grid gap-2">
                  {plans.map((plan) => (
                    <Card key={plan.planId}>
                      <CardContent className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{plan.label}</p>
                          <p className="text-sm text-muted-foreground">
                            ${plan.allowanceUsd.toFixed(2)} allowance
                          </p>
                        </div>
                        {account?.planId === plan.planId ? (
                          <Badge variant="secondary">Current</Badge>
                        ) : (
                          <Button
                            disabled={updating}
                            onClick={async () => {
                              const token = identity?.token;
                              if (!token) return;
                              setUpdating(true);
                              try {
                                const updated = await updatePlan(
                                  token,
                                  plan.planId,
                                );
                                setAccount(updated);
                                onUsageChange?.();
                              } finally {
                                setUpdating(false);
                              }
                            }}
                            size="sm"
                          >
                            Select
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
