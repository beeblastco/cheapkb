import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Tag } from "@/lib/types";
import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

export function TagPicker({
  value,
  tags,
  onChange,
  onCreate,
  onDeleteTag,
  disabled,
}: {
  value: string[];
  tags: Tag[];
  onChange: (next: string[]) => void;
  onCreate: (name: string) => Promise<void>;
  onDeleteTag: (name: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedSet = useMemo(
    () => new Set(value.map((name) => name.toLowerCase())),
    [value],
  );

  const query = input.trim().toLowerCase();
  const available = useMemo(
    () =>
      tags
        .filter((tag) => !selectedSet.has(tag.name.toLowerCase()))
        .filter((tag) => !query || tag.name.toLowerCase().includes(query)),
    [tags, selectedSet, query],
  );
  const exactMatch = tags.find(
    (tag) => tag.name.toLowerCase() === query && query.length > 0,
  );

  function select(name: string) {
    if (selectedSet.has(name.toLowerCase())) return;
    onChange([...value, name]);
  }

  function deselect(name: string) {
    onChange(value.filter((tag) => tag.toLowerCase() !== name.toLowerCase()));
  }

  async function addFromInput() {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    const existing = tags.find(
      (tag) => tag.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (existing) {
      select(existing.name);
      setInput("");
      return;
    }
    setBusy(true);
    try {
      await onCreate(trimmed);
      select(trimmed);
      setInput("");
    } catch {
      // The parent surfaces the error to the user; swallow the rejection here
      // so it doesn't become an unhandled promise rejection.
    } finally {
      setBusy(false);
    }
  }

  async function removeFromVocabulary(name: string) {
    if (busy) return;
    setBusy(true);
    try {
      await onDeleteTag(name);
      deselect(name);
    } catch {
      // The parent surfaces the error to the user; swallow the rejection here.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-6 flex-wrap items-center gap-1.5">
        {value.length ? (
          value.map((name) => (
            <Badge key={name} variant="secondary">
              {name}
              <button
                aria-label={`Remove ${name}`}
                className="ml-0.5 opacity-70 hover:opacity-100 disabled:pointer-events-none"
                disabled={disabled}
                onClick={() => deselect(name)}
                type="button"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))
        ) : (
          <span className="text-muted-foreground text-xs">
            No tags selected.
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Input
          disabled={disabled || busy}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void addFromInput();
            }
          }}
          placeholder="Find or create a tag…"
          value={input}
        />
        <Button
          disabled={disabled || busy || !input.trim() || !!exactMatch}
          onClick={() => void addFromInput()}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="size-4" />
          Create
        </Button>
      </div>

      {available.length ? (
        <div className="flex flex-wrap gap-1.5">
          {available.map((tag) => (
            <Badge
              className="cursor-pointer"
              key={tag.name}
              onClick={() => !disabled && select(tag.name)}
              variant="outline"
            >
              {tag.name}
              <button
                aria-label={`Delete tag ${tag.name}`}
                className="ml-0.5 opacity-50 hover:text-destructive hover:opacity-100 disabled:pointer-events-none"
                disabled={disabled || busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void removeFromVocabulary(tag.name);
                }}
                type="button"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : query && !exactMatch ? (
        <span className="text-muted-foreground text-xs">
          No matching tag. Press Create to add “{input.trim()}”.
        </span>
      ) : null}
    </div>
  );
}
