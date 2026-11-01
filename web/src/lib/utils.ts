import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1),
  );
  return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

/** Formats a usage percentage, showing "<1%" rather than a misleading "0%". */
export function formatPercent(pct: number): string {
  if (pct > 0 && pct < 1) return "<1%";

  return `${Math.min(pct, 100).toFixed(0)}%`;
}
