import { TagBadge, TagSwatch } from "@/components/TagBadge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { TAG_BADGE_CLASSES, TAG_COLOR_LABELS } from "@/lib/tag-colors";
import {
  DEFAULT_TAG_COLOR,
  type Tag,
  TAG_COLORS,
  type TagColor,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { ArrowLeft, Check, Palette, Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";

// The "create" row lives in the same item list as real tags so it is reachable
// by keyboard. The leading NUL keeps a tag named "create:x" from colliding.
const CREATE_PREFIX = "\u0000create:";

export function TagPicker({
  value,
  tags,
  error,
  colorOf,
  onChange,
  onCreate,
  onRecolor,
  onDeleteTag,
  disabled,
}: {
  value: string[];
  tags: Tag[];
  error?: string | null;
  colorOf: (name: string) => TagColor;
  onChange: (next: string[]) => void;
  onCreate: (name: string) => Promise<Tag>;
  onRecolor: (name: string, color: TagColor) => Promise<void>;
  onDeleteTag: (name: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [inputValue, setInputValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Tag | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Swaps the popup's contents rather than nesting a menu: Combobox builds no
  // FloatingTree, so a portalled menu would dismiss the popup rendering it.
  const [recoloring, setRecoloring] = useState<Tag | null>(null);
  const anchor = useComboboxAnchor();

  // Async reconciliation must read the selection as it is when the request
  // settles, not as it was when the request started.
  const valueRef = useRef(value);
  valueRef.current = value;

  const query = inputValue.trim();
  const lowerQuery = query.toLowerCase();

  const matches = useMemo(
    () =>
      tags.filter(
        (tag) => !lowerQuery || tag.name.toLowerCase().includes(lowerQuery),
      ),
    [tags, lowerQuery],
  );

  const hasExactMatch = tags.some(
    (tag) => tag.name.toLowerCase() === lowerQuery,
  );
  const canCreate = query.length > 0 && !hasExactMatch;

  // Root needs the same list we render, in the same order, to drive keyboard
  // highlighting. Filtering is ours, so `filter` is disabled below.
  const items = useMemo(() => {
    const names = matches.map((tag) => tag.name);
    return canCreate ? [...names, `${CREATE_PREFIX}${query}`] : names;
  }, [matches, canCreate, query]);

  const selectedSet = useMemo(
    () => new Set(value.map((name) => name.toLowerCase())),
    [value],
  );

  function handleValueChange(next: string[]) {
    setInputValue("");

    const createEntry = next.find((entry) => entry.startsWith(CREATE_PREFIX));
    if (!createEntry) {
      onChange(next);
      return;
    }

    const name = createEntry.slice(CREATE_PREFIX.length);
    onChange(dedupe([...next.filter((entry) => entry !== createEntry), name]));
    void onCreate(name)
      .then((saved) => {
        // The server owns canonical casing.
        if (saved.name !== name) {
          onChange(replaceTag(valueRef.current, name, saved.name));
        }
      })
      .catch(() => {
        onChange(withoutTag(valueRef.current, name));
      });
  }

  async function confirmDelete() {
    const tag = pendingDelete;
    if (!tag) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteTag(tag.name);
    } catch (caught) {
      // Stay open so the failure is visible next to the action that caused it.
      setDeleteError((caught as Error).message);
      return;
    } finally {
      setDeleting(false);
    }
    setPendingDelete(null);
    onChange(withoutTag(valueRef.current, tag.name));
  }

  return (
    <>
      <Combobox
        disabled={disabled}
        filter={null}
        inputValue={inputValue}
        // While the color panel is up its swatches are the only targets, so the
        // tag list is withdrawn from keyboard navigation.
        items={recoloring ? [] : items}
        multiple
        onInputValueChange={setInputValue}
        onOpenChange={(open) => {
          if (!open) setRecoloring(null);
        }}
        onValueChange={handleValueChange}
        value={value}
      >
        <ComboboxChips ref={anchor}>
          <ComboboxValue>
            {(selected: string[]) =>
              selected.map((name) => (
                <ComboboxChip
                  className={cn(TAG_BADGE_CLASSES[colorOf(name)])}
                  key={name}
                >
                  <span className="max-w-40 truncate">{name}</span>
                </ComboboxChip>
              ))
            }
          </ComboboxValue>
          <ComboboxChipsInput
            aria-label="Find or create a tag"
            placeholder={value.length ? "" : "Type to find or create a tag…"}
          />
        </ComboboxChips>

        <ComboboxContent anchor={anchor}>
          {recoloring ? (
            <ColorPanel
              current={colorOf(recoloring.name)}
              name={recoloring.name}
              onBack={() => setRecoloring(null)}
              onPick={(color) => {
                setRecoloring(null);
                void onRecolor(recoloring.name, color).catch(() => {});
              }}
            />
          ) : (
            <>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <ComboboxEmpty>
                {tags.length
                  ? "No matching tag."
                  : "Type to create your first tag."}
              </ComboboxEmpty>
              <ComboboxList>
                {matches.map((tag) => (
                  <TagRow
                    colorOf={colorOf}
                    disabled={disabled}
                    key={tag.name}
                    onRecolor={setRecoloring}
                    onRequestDelete={(target) => {
                      setDeleteError(null);
                      setPendingDelete(target);
                    }}
                    selected={selectedSet.has(tag.name.toLowerCase())}
                    tag={tag}
                  />
                ))}
                {canCreate ? (
                  <ComboboxItem
                    showIndicator={false}
                    value={`${CREATE_PREFIX}${query}`}
                  >
                    <Plus className="text-muted-foreground" />
                    <span className="text-muted-foreground">Create</span>
                    <TagBadge color={DEFAULT_TAG_COLOR} name={query} />
                  </ComboboxItem>
                ) : null}
              </ComboboxList>
            </>
          )}
        </ComboboxContent>
      </Combobox>

      {/* Outside the Combobox: the popup closes when this opens, which would
          unmount the dialog with it. */}
      <AlertDialog
        onOpenChange={(open) => {
          if (open) return;
          setPendingDelete(null);
          setDeleteError(null);
        }}
        open={!!pendingDelete}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete tag “{pendingDelete?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes it from your tag list and unselects it here.
              Documents already tagged with it keep the tag until you edit them.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p className="text-sm text-destructive">{deleteError}</p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            {/* A plain Button, not AlertDialogAction: that renders a Close,
                which would dismiss the dialog before a failure can show. */}
            <Button
              disabled={deleting}
              onClick={() => void confirmDelete()}
              variant="destructive"
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TagRow({
  colorOf,
  disabled,
  onRecolor,
  onRequestDelete,
  selected,
  tag,
}: {
  colorOf: (name: string) => TagColor;
  disabled?: boolean;
  onRecolor: (tag: Tag) => void;
  onRequestDelete: (tag: Tag) => void;
  selected: boolean;
  tag: Tag;
}) {
  return (
    <ComboboxItem showIndicator={false} value={tag.name}>
      <TagSwatch color={colorOf(tag.name)} />
      <span className="min-w-0 flex-1 truncate">{tag.name}</span>
      {selected ? <Check className="text-muted-foreground" /> : null}

      {/* The row itself selects the tag, so the action buttons have to keep
          their clicks from reaching it. */}
      <div
        className="flex items-center"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button
          aria-label={`Change color of ${tag.name}`}
          className="text-muted-foreground"
          disabled={disabled}
          onClick={() => onRecolor(tag)}
          size="icon-xs"
          variant="ghost"
        >
          <Palette />
        </Button>
        <Button
          aria-label={`Delete tag ${tag.name}`}
          className="text-muted-foreground hover:text-destructive"
          disabled={disabled}
          onClick={() => onRequestDelete(tag)}
          size="icon-xs"
          variant="ghost"
        >
          <Trash2 />
        </Button>
      </div>
    </ComboboxItem>
  );
}

// Padding matches ComboboxList so the panel aligns with the list it replaces.
function ColorPanel({
  current,
  name,
  onBack,
  onPick,
}: {
  current: TagColor;
  name: string;
  onBack: () => void;
  onPick: (color: TagColor) => void;
}) {
  return (
    <div className="flex flex-col p-1.5">
      <div className="flex items-center">
        <Button
          aria-label="Back to tags"
          onClick={onBack}
          size="icon-xs"
          variant="ghost"
        >
          <ArrowLeft />
        </Button>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          Color for “{name}”
        </span>
      </div>
      {TAG_COLORS.map((option) => (
        <Button
          className="justify-start font-medium"
          key={option}
          onClick={() => onPick(option)}
          variant="ghost"
        >
          <TagSwatch color={option} />
          <span className="flex-1 text-left">{TAG_COLOR_LABELS[option]}</span>
          {option === current ? (
            <Check className="text-muted-foreground" />
          ) : null}
        </Button>
      ))}
    </div>
  );
}

function dedupe(names: string[]): string[] {
  const next: string[] = [];
  for (const name of names) {
    if (
      !next.some((existing) => existing.toLowerCase() === name.toLowerCase())
    ) {
      next.push(name);
    }
  }
  return next;
}

function replaceTag(names: string[], from: string, to: string): string[] {
  return dedupe(
    names.map((name) =>
      name.toLowerCase() === from.toLowerCase() ? to : name,
    ),
  );
}

function withoutTag(names: string[], name: string): string[] {
  return names.filter((entry) => entry.toLowerCase() !== name.toLowerCase());
}
