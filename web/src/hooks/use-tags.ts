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
      const optimistic: Tag = { name, color };
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
        // The server owns canonical casing and may return an existing tag whose
        // name or color differs from what we optimistically inserted.
        setTags((current) =>
          sortByName([
            ...current.filter(
              (tag) =>
                tag !== optimistic && byName(tag.name) !== byName(saved.name),
            ),
            saved,
          ]),
        );
        return saved;
      } catch (createError) {
        // Only withdraw a tag this call added; an existing one it matched stays.
        // By name too, since recoloring it meanwhile replaces the object.
        if (inserted) {
          setTags((current) =>
            current.filter(
              (tag) => tag !== optimistic && byName(tag.name) !== byName(name),
            ),
          );
        }
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
        setTags((current) =>
          current.map((tag) =>
            byName(tag.name) === byName(name) && previous
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
