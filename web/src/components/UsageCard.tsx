import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { UsageSummary } from "@/lib/types";
import { formatBytes } from "@/lib/utils";

export function UsageCard({ summary }: { summary: UsageSummary | null }) {
  if (!summary) {
    return (
      <Card className="shrink-0">
        <CardHeader>
          <CardTitle>Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  const shown = Math.min(summary.pctUsed, 100);

  return (
    <Card className="min-w-0 shrink-0">
      <CardHeader>
        <CardTitle className="flex items-baseline gap-2">
          <span>Usage</span>
          <span className="whitespace-nowrap text-sm font-normal text-muted-foreground">
            {summary.planLabel} plan
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <div className="grid grid-cols-2 items-baseline gap-3 text-sm">
          <p className="whitespace-nowrap text-xl font-semibold tracking-tight tabular-nums">
            {shown.toFixed(0)}%
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">
              used
            </span>
          </p>
          <p className="flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="text-muted-foreground">Storage</span>
            <span className="font-medium tabular-nums">
              {formatBytes(summary.storageBytes)}
            </span>
          </p>
        </div>
        <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
          <p>Resets</p>
          <p className="whitespace-nowrap font-medium tabular-nums">
            {new Date(summary.resetAt).toLocaleDateString()}
          </p>
        </div>

        <Progress className="w-full shrink-0" value={shown} />
      </CardContent>
    </Card>
  );
}
