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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  apiUrl,
  formatDate,
  getMcpKey,
  revokeMcpKey,
  rotateMcpKey,
} from "@/lib/client";
import type { UsageSummary } from "@/lib/types";
import { formatBytes } from "@/lib/utils";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type SettingsTab = "usage" | "agent" | "account";

/** Settings dialog with usage, MCP agent connection and account data tabs.
 * App opens it from the account menu and the usage line in the documents footer. */
export function SettingsDialog({
  tab,
  usage,
  onTabChange,
  onDeleteAllData,
  notify,
  token,
}: {
  tab: SettingsTab | null;
  usage: UsageSummary | null;
  onTabChange: (tab: SettingsTab | null) => void;
  onDeleteAllData: () => Promise<void>;
  notify: (title: string, message: string) => void;
  token: string;
}): React.JSX.Element {
  const [deletingData, setDeletingData] = useState(false);
  // undefined until the key status loads, so a failed load never offers "Create key".
  const [keyCreatedAt, setKeyCreatedAt] = useState<string | null | undefined>(
    undefined,
  );
  const [newKey, setNewKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const keyRequest = useRef(0);
  const usagePct = usage ? Math.min(usage.pctUsed, 100) : 0;
  const shownKey = newKey || "<MCP_KEY>";

  const open = tab !== null;
  const mcpUrl = `${apiUrl()}/mcp`;

  // Loads the key state once per dialog open; a rotate or revoke since then wins.
  useEffect(() => {
    if (!open) return;
    keyRequest.current += 1;
    const requestId = keyRequest.current;
    getMcpKey(token)
      .then((createdAt) =>
        setKeyCreatedAt((current) =>
          requestId === keyRequest.current ? createdAt : current,
        ),
      )
      .catch((error: Error) => notify("Couldn't load MCP key", error.message));
  }, [notify, open, token]);

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      notify("Couldn't copy", "Select the text and copy it manually.");
    }
  }

  async function deleteAllData(): Promise<void> {
    setDeletingData(true);
    try {
      await onDeleteAllData();
      onTabChange(null);
    } catch {
      // App already showed the error; the dialog stays open to retry.
    } finally {
      setDeletingData(false);
    }
  }

  async function revokeKey(): Promise<void> {
    keyRequest.current += 1;
    setSavingKey(true);
    try {
      await revokeMcpKey(token);
      setKeyCreatedAt(null);
      setNewKey("");
    } catch (error) {
      notify("Couldn't revoke MCP key", (error as Error).message);
    } finally {
      setSavingKey(false);
    }
  }

  async function rotateKey(): Promise<void> {
    keyRequest.current += 1;
    setSavingKey(true);
    try {
      const { apiKey, createdAt } = await rotateMcpKey(token);
      setNewKey(apiKey);
      setKeyCreatedAt(createdAt);
    } catch (error) {
      notify("Couldn't create MCP key", (error as Error).message);
    } finally {
      setSavingKey(false);
    }
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) return;
        onTabChange(null);
        setKeyCreatedAt(undefined);
        setNewKey("");
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <Tabs
          onValueChange={(value) => onTabChange(value as SettingsTab)}
          value={tab ?? "usage"}
        >
          <TabsList>
            <TabsTrigger className="cursor-pointer" value="usage">
              Usage
            </TabsTrigger>
            <TabsTrigger className="cursor-pointer" value="agent">
              Connect agent
            </TabsTrigger>
            <TabsTrigger className="cursor-pointer" value="account">
              Account
            </TabsTrigger>
          </TabsList>

          <TabsContent value="usage">
            {usage ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-baseline justify-between">
                  <p className="text-2xl font-semibold tabular-nums">
                    {usagePct.toFixed(0)}%
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      of {usage.planLabel} plan
                    </span>
                  </p>
                  <p className="text-muted-foreground tabular-nums">
                    Resets {formatDate(usage.resetAt)}
                  </p>
                </div>
                <Progress value={usagePct} />
                <p className="text-muted-foreground tabular-nums">
                  Storage {formatBytes(usage.storageBytes)}
                </p>
              </div>
            ) : (
              <Skeleton className="h-20 w-full" />
            )}
          </TabsContent>

          <TabsContent value="agent">
            <div className="flex flex-col gap-3">
              <p className="text-muted-foreground">
                Search and read your documents from Claude Code, Codex or Broods
                over MCP.
              </p>
              {newKey ? (
                <div className="flex flex-col gap-1">
                  <CodeLine onCopy={copy} text={newKey} />
                  <p className="text-muted-foreground">
                    Shown once. Copy it now.
                  </p>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <p className="flex-1 text-muted-foreground">
                  {keyCreatedAt === undefined
                    ? "Loading key status"
                    : keyCreatedAt
                      ? `Active key created ${formatDate(keyCreatedAt)}`
                      : "No key yet"}
                </p>
                {keyCreatedAt ? (
                  <>
                    <ConfirmButton
                      action="Rotate"
                      description="Agents using the current key get 401 until you give them the new one."
                      disabled={savingKey}
                      onConfirm={rotateKey}
                      title="Replace the MCP key?"
                      variant="outline"
                    >
                      <KeyRound data-icon="inline-start" />
                      Rotate
                    </ConfirmButton>
                    <ConfirmButton
                      action="Revoke"
                      description="Agents using this key get 401 from now on."
                      disabled={savingKey}
                      onConfirm={revokeKey}
                      title="Revoke the MCP key?"
                      variant="destructive"
                    >
                      Revoke
                    </ConfirmButton>
                  </>
                ) : (
                  <Button
                    className="cursor-pointer"
                    disabled={savingKey || keyCreatedAt === undefined}
                    onClick={rotateKey}
                    size="sm"
                    variant="outline"
                  >
                    <KeyRound data-icon="inline-start" />
                    Create key
                  </Button>
                )}
              </div>
              <p className="font-medium">Claude Code</p>
              <CodeLine
                onCopy={copy}
                text={`claude mcp add --transport http cheapkb ${mcpUrl} --header "Authorization: Bearer ${shownKey}"`}
              />
              <p className="font-medium">Codex, in ~/.codex/config.toml</p>
              <CodeLine
                onCopy={copy}
                text={`[mcp_servers.cheapkb]\nurl = "${mcpUrl}"\nbearer_token_env_var = "CHEAPKB_MCP_KEY"`}
              />
              <CodeLine
                onCopy={copy}
                text={`export CHEAPKB_MCP_KEY=${shownKey}`}
              />
              <p className="font-medium">Broods</p>
              <CodeLine onCopy={copy} text="broods env set CHEAPKB_MCP_KEY" />
              <CodeLine
                onCopy={copy}
                text={`defineMcp({\n  name: "cheapkb",\n  url: "${mcpUrl}",\n  headers: { Authorization: "Bearer \${CHEAPKB_MCP_KEY}" },\n});`}
              />
            </div>
          </TabsContent>

          <TabsContent value="account">
            <div className="flex flex-col items-start gap-3">
              <p className="text-muted-foreground">
                Delete every document, image and tag in this account and reset
                storage to 0. Usage already spent this cycle stays.
              </p>
              <ConfirmButton
                action="Delete everything"
                description="All documents, their search data and your tags are deleted. This can't be undone."
                disabled={deletingData}
                onConfirm={deleteAllData}
                title="Delete all your data?"
                variant="destructive"
              >
                <Trash2 data-icon="inline-start" />
                Delete all my data
              </ConfirmButton>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Monospace snippet with a copy button, used for the MCP key and setup commands. */
function CodeLine({
  text,
  onCopy,
}: {
  text: string;
  onCopy: (text: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted p-2">
      <pre className="min-w-0 flex-1 font-mono text-xs break-all whitespace-pre-wrap">
        {text}
      </pre>
      <Button
        aria-label="Copy"
        className="cursor-pointer"
        onClick={() => onCopy(text)}
        size="icon-xs"
        variant="ghost"
      >
        <Copy />
      </Button>
    </div>
  );
}

/** Button that asks for confirmation before a destructive action: key rotate,
 * key revoke and delete all data. */
function ConfirmButton({
  action,
  children,
  description,
  disabled,
  onConfirm,
  title,
  variant,
}: {
  action: string;
  children: React.ReactNode;
  description: string;
  disabled: boolean;
  onConfirm: () => void;
  title: string;
  variant: "destructive" | "outline";
}): React.JSX.Element {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            className="cursor-pointer"
            disabled={disabled}
            size="sm"
            variant={variant}
          />
        }
      >
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} variant="destructive">
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
