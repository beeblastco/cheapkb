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
  colorOf: (name: string) => TagColor;
  createTag: (name: string, color?: TagColor) => Promise<Tag>;
  recolorTag: (name: string, color: TagColor) => Promise<void>;
  deleteTag: (name: string) => Promise<void>;
}

const byName = (name: string) => name.toLowerCase();

function sortByName(tags: Tag[]): Tag[] {
  return [...tags].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/**
 * Owns the user's tag vocabulary. Every mutation applies locally first and
 * rolls back to the pre-mutation list if the request fails, so the picker stays
 * responsive without waiting on the network.
 */
export function useTags(
  token: string,
  notify: (message: string, tone: "error") => void,
): TagVocabulary {
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    listTags(token)
      .then((loaded) => {
        if (!cancelled) setTags(sortByName(loaded));
      })
      .catch(() => {});
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
      let rollback: Tag[] = [];
      setTags((current) => {
        rollback = current;
        return current.some((tag) => byName(tag.name) === byName(name))
          ? current
          : sortByName([...current, optimistic]);
      });

      try {
        const saved = await createTagRequest(token, name, color);
        // The server owns canonical casing and may return an existing tag whose
        // name or color differs from what we optimistically inserted.
        setTags((current) =>
          sortByName([
            ...current.filter((tag) => byName(tag.name) !== byName(saved.name)),
            saved,
          ]),
        );
        return saved;
      } catch (error) {
        setTags(rollback);
        notify((error as Error).message, "error");
        throw error;
      }
    },
    [notify, token],
  );

  const recolorTag = useCallback(
    async (name: string, color: TagColor) => {
      let rollback: Tag[] = [];
      setTags((current) => {
        rollback = current;
        return current.map((tag) =>
          byName(tag.name) === byName(name) ? { ...tag, color } : tag,
        );
      });

      try {
        await updateTagColorRequest(token, name, color);
      } catch (error) {
        setTags(rollback);
        notify((error as Error).message, "error");
        throw error;
      }
    },
    [notify, token],
  );

  const deleteTag = useCallback(
    async (name: string) => {
      let rollback: Tag[] = [];
      setTags((current) => {
        rollback = current;
        return current.filter((tag) => byName(tag.name) !== byName(name));
      });

      try {
        await deleteTagRequest(token, name);
      } catch (error) {
        setTags(rollback);
        notify((error as Error).message, "error");
        throw error;
      }
    },
    [notify, token],
  );

  return { tags, colorOf, createTag, recolorTag, deleteTag };
}
