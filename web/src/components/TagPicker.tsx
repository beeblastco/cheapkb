import { TagSwatch } from "@/components/TagBadge";
import {
  AlertDialog,
  AlertDialogAction,
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
import { useMemo, useState } from "react";

// The "create" row lives in the same item list as real tags so it is reachable
// by keyboard. This prefix marks it apart from a tag name; the leading NUL
// keeps a tag literally named "create:x" from colliding with it.
const CREATE_PREFIX = "\u0000create:";

export function TagPicker({
  value,
  tags,
  colorOf,
  onChange,
  onCreate,
  onRecolor,
  onDeleteTag,
  disabled,
}: {
  value: string[];
  tags: Tag[];
  colorOf: (name: string) => TagColor;
  onChange: (next: string[]) => void;
  onCreate: (name: string) => Promise<Tag>;
  onRecolor: (name: string, color: TagColor) => Promise<void>;
  onDeleteTag: (name: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [inputValue, setInputValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Tag | null>(null);
  // Recoloring swaps the popup's contents instead of opening a nested menu:
  // Base UI's Combobox builds no FloatingTree, so a portalled menu inside the
  // popup reads as an outside press and dismisses the popup that renders it.
  const [recoloring, setRecoloring] = useState<Tag | null>(null);
  const anchor = useComboboxAnchor();

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
    const withoutSentinel = next.filter((entry) => entry !== createEntry);

    // Select the new tag right away, then reconcile once the server confirms
    // it. Selections made while this is in flight are lost on rollback, which
    // only matters if the create fails.
    onChange([...withoutSentinel, name]);
    void onCreate(name)
      .then((saved) => {
        if (saved.name !== name) {
          // The server owns canonical casing.
          onChange([...withoutSentinel, saved.name]);
        }
      })
      .catch(() => onChange(withoutSentinel));
  }

  async function confirmDelete() {
    const tag = pendingDelete;
    if (!tag) return;
    setPendingDelete(null);
    try {
      await onDeleteTag(tag.name);
      // The tag is gone from the vocabulary, so drop it from this selection.
      onChange(
        value.filter((name) => name.toLowerCase() !== tag.name.toLowerCase()),
      );
    } catch {
      // useTags restores the vocabulary and surfaces the error.
    }
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
                void onRecolor(recoloring.name, color);
              }}
            />
          ) : (
            <>
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
                    onRequestDelete={setPendingDelete}
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
                    <span
                      className={cn(
                        "min-w-0 truncate rounded-md px-2 py-0.5 text-xs",
                        TAG_BADGE_CLASSES[DEFAULT_TAG_COLOR],
                      )}
                    >
                      {query}
                    </span>
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
        onOpenChange={(open) => !open && setPendingDelete(null)}
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
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              Delete
            </AlertDialogAction>
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
        className="flex items-center gap-0.5"
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
      <div className="flex items-center gap-1 pb-1">
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
          className="justify-start gap-2.5 px-3 font-medium"
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
