import type { TagColor } from "./types";

// Spelled out because Tailwind scans for literal class names: a template
// literal like `bg-tag-${color}` is stripped from the generated stylesheet.
export const TAG_BADGE_CLASSES: Record<TagColor, string> = {
  gray: "bg-tag-gray text-tag-gray-foreground",
  brown: "bg-tag-brown text-tag-brown-foreground",
  orange: "bg-tag-orange text-tag-orange-foreground",
  yellow: "bg-tag-yellow text-tag-yellow-foreground",
  green: "bg-tag-green text-tag-green-foreground",
  blue: "bg-tag-blue text-tag-blue-foreground",
  purple: "bg-tag-purple text-tag-purple-foreground",
  pink: "bg-tag-pink text-tag-pink-foreground",
  red: "bg-tag-red text-tag-red-foreground",
};

export const TAG_SWATCH_CLASSES: Record<TagColor, string> = {
  gray: "bg-tag-gray-foreground",
  brown: "bg-tag-brown-foreground",
  orange: "bg-tag-orange-foreground",
  yellow: "bg-tag-yellow-foreground",
  green: "bg-tag-green-foreground",
  blue: "bg-tag-blue-foreground",
  purple: "bg-tag-purple-foreground",
  pink: "bg-tag-pink-foreground",
  red: "bg-tag-red-foreground",
};

export const TAG_COLOR_LABELS: Record<TagColor, string> = {
  gray: "Gray",
  brown: "Brown",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  red: "Red",
};
