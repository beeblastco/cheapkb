import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
          <Skeleton className="h-44 w-full" />
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
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Monthly allowance reached</AlertTitle>
            <AlertDescription>
              Upgrade to continue using queries and uploads.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-1">
          <Badge variant="secondary">{summary.planLabel}</Badge>
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

        <div
          aria-label="Usage progress"
          aria-valuemax={100}
          aria-valuenow={Math.round(shown)}
          className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
        >
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
