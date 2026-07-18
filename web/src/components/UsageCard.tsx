import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { UsageSummary } from "@/lib/types";
import { formatBytes } from "@/lib/utils";

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
        </div>

        <Progress value={shown}>
          <ProgressLabel>Usage progress</ProgressLabel>
          <ProgressValue />
        </Progress>

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
