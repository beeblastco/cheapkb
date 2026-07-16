import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { UsageSummary } from "@/lib/types";
import { formatBytes } from "@/lib/utils";
import { AlertCircle } from "lucide-react";

export function UsageCard({ summary }: { summary: UsageSummary | null }) {
  if (!summary) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
        </CardContent>
      </Card>
    );
  }

  const shown = Math.min(summary.pctUsed, 100);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary.paused ? (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>
              Monthly allowance reached. Upgrade to continue using queries and
              uploads.
            </span>
          </div>
        ) : null}

        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            {summary.planLabel} plan
          </p>
          <p className="text-2xl font-semibold tracking-tight tabular-nums">
            {shown.toFixed(0)}%
            <span className="ml-2 text-base font-normal text-muted-foreground">
              used
            </span>
          </p>
          <p className="text-sm text-muted-foreground">
            ${summary.spentUsd.toFixed(2)} of ${summary.allowanceUsd.toFixed(2)}{" "}
            this cycle
          </p>
        </div>

        <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              summary.paused ? "bg-destructive" : "bg-primary"
            }`}
            style={{ width: `${shown}%` }}
          />
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Storage</p>
            <p className="font-medium tabular-nums">
              {formatBytes(summary.storageBytes)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Resets</p>
            <p className="font-medium">
              {new Date(summary.resetAt).toLocaleDateString()}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
