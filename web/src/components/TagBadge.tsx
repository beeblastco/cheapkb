import { Badge } from "@/components/ui/badge";
import { TAG_BADGE_CLASSES, TAG_SWATCH_CLASSES } from "@/lib/tag-colors";
import type { TagColor } from "@/lib/types";
import { cn } from "@/lib/utils";

export function TagBadge({
  className,
  color,
  name,
}: {
  className?: string;
  color: TagColor;
  name: string;
}) {
  return (
    <Badge
      className={cn(TAG_BADGE_CLASSES[color], className)}
      variant="secondary"
    >
      <span className="max-w-40 truncate">{name}</span>
    </Badge>
  );
}

export function TagSwatch({
  className,
  color,
}: {
  className?: string;
  color: TagColor;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2.5 shrink-0 rounded-full",
        TAG_SWATCH_CLASSES[color],
        className,
      )}
    />
  );
}
