import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Field({
  className,
  label,
  children,
}: {
  className?: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
