import {
  createTag as createTagRequest,
  deleteTag as deleteTagRequest,
  listTags,
  updateTagColor as updateTagColorRequest,
} from "@/lib/client";
import { DEFAULT_TAG_COLOR, type Tag, type TagColor } from "@/lib/types";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface TagVocabulary {
  tags: Tag[];
  error: string | null;
  colorOf: (name: string) => TagColor;
  createTag: (name: string, color?: TagColor) => Promise<Tag>;
  recolorTag: (name: string, color: TagColor) => Promise<void>;
  deleteTag: (name: string) => Promise<void>;
}

// Owns the user's tag vocabulary. Mutations apply locally first and undo only
// their own tag on failure, so a concurrent success is never clobbered.
export function useTags(token: string): TagVocabulary {
  const [tags, setTags] = useState<Tag[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    listTags(token)
      .then((loaded) => {
        if (!cancelled) setTags(sortByName(loaded));
      })
      .catch((loadError) => {
        // An empty list and a failed load look identical without this.
        if (!cancelled) setError((loadError as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const colorMap = useMemo(() => {
    const map = new Map<string, TagColor>();
    for (const tag of tags) map.set(byName(tag.name), tag.color);
    return map;
  }, [tags]);

  const colorOf = useCallback(
    (name: string) => colorMap.get(byName(name)) ?? DEFAULT_TAG_COLOR,
    [colorMap],
  );

  const createTag = useCallback(
    async (name: string, color: TagColor = DEFAULT_TAG_COLOR) => {
      // Unique per call and copied by object spread, so rollback finds the entry
      // this request added even after a recolor replaced the object.
      const marker = Symbol("optimisticCreate");
      const optimistic = { name, color, [marker]: true } as Tag;
      let inserted = false;
      setError(null);
      setTags((current) => {
        if (current.some((tag) => byName(tag.name) === byName(name))) {
          return current;
        }
        inserted = true;
        return sortByName([...current, optimistic]);
      });

      try {
        const saved = await createTagRequest(token, name, color);
        setTags((current) => {
          const mine = current.find((tag) => marker in tag);
          // Inserted then gone means deleted in flight: honour that, do not
          // resurrect it. Never inserted means another entry already stands in.
          if (inserted && !mine) return current;
          // The server owns canonical casing, but a recolor that landed while
          // this was in flight is newer than the color in this response.
          const reconciled =
            mine && mine.color !== color
              ? { ...saved, color: mine.color }
              : saved;
          return sortByName([
            ...current.filter(
              (tag) =>
                !(marker in tag) && byName(tag.name) !== byName(saved.name),
            ),
            reconciled,
          ]);
        });
        return saved;
      } catch (createError) {
        // Only this call's entry: a canonical tag another create stored under
        // the same name is not ours to withdraw.
        setTags((current) => current.filter((tag) => !(marker in tag)));
        setError((createError as Error).message);
        throw createError;
      }
    },
    [token],
  );

  const recolorTag = useCallback(
    async (name: string, color: TagColor) => {
      let previous: TagColor | undefined;
      setError(null);
      setTags((current) =>
        current.map((tag) => {
          if (byName(tag.name) !== byName(name)) return tag;
          previous = tag.color;
          return { ...tag, color };
        }),
      );

      try {
        await updateTagColorRequest(token, name, color);
      } catch (recolorError) {
        // Only undo while the tag still holds the color this call set, so a
        // newer recolor that already succeeded is not reverted to a stale one.
        setTags((current) =>
          current.map((tag) =>
            byName(tag.name) === byName(name) && previous && tag.color === color
              ? { ...tag, color: previous }
              : tag,
          ),
        );
        setError((recolorError as Error).message);
        throw recolorError;
      }
    },
    [token],
  );

  const deleteTag = useCallback(
    async (name: string) => {
      let removed: Tag | undefined;
      setError(null);
      setTags((current) => {
        removed = current.find((tag) => byName(tag.name) === byName(name));
        return current.filter((tag) => byName(tag.name) !== byName(name));
      });

      try {
        await deleteTagRequest(token, name);
      } catch (deleteError) {
        if (removed) {
          const restored = removed;
          setTags((current) =>
            current.some((tag) => byName(tag.name) === byName(restored.name))
              ? current
              : sortByName([...current, restored]),
          );
        }
        setError((deleteError as Error).message);
        throw deleteError;
      }
    },
    [token],
  );

  return { tags, error, colorOf, createTag, recolorTag, deleteTag };
}

function byName(name: string) {
  return name.toLowerCase();
}

function sortByName(tags: Tag[]): Tag[] {
  return [...tags].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}
