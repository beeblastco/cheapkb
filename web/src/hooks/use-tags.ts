import {
  createTag as createTagRequest,
  deleteTag as deleteTagRequest,
  listTags,
  updateTagColor as updateTagColorRequest,
} from "@/lib/client";
import { DEFAULT_TAG_COLOR, type Tag, type TagColor } from "@/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

export interface TagVocabulary {
  tags: Tag[];
  error: string | null;
  colorOf: (name: string) => TagColor;
  createTag: (name: string, color?: TagColor) => Promise<Tag>;
  recolorTag: (name: string, color: TagColor) => Promise<void>;
  deleteTag: (name: string) => Promise<void>;
}

// Shared by every tag mutation so a settled one can tell whether others are
// still in flight before refetching.
const TAG_MUTATION_KEY = ["tags"];
const NO_TAGS: Tag[] = [];

// Owns the user's tag vocabulary. Mutations apply to the cache immediately and
// a refetch after the last one settles reconciles them against the server.
export function useTags(token: string): TagVocabulary {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const queryKey = useMemo(() => ["tags", token], [token]);

  const { data: tags = NO_TAGS, error: loadError } = useQuery({
    queryKey,
    queryFn: () => listTags(token),
    enabled: Boolean(token),
    select: sortByName,
  });

  // Snapshot and restore the whole list: a refetch follows every mutation, so
  // anything this rollback overwrites is corrected from the server.
  const optimistic = useCallback(
    (apply: (current: Tag[]) => Tag[]) => async () => {
      setError(null);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Tag[]>(queryKey) ?? NO_TAGS;
      queryClient.setQueryData<Tag[]>(queryKey, (current = NO_TAGS) =>
        apply(current),
      );
      return { previous };
    },
    [queryClient, queryKey],
  );

  const rollback = useCallback(
    (caught: unknown, _variables: unknown, context?: { previous: Tag[] }) => {
      if (context) queryClient.setQueryData(queryKey, context.previous);
      setError((caught as Error).message);
    },
    [queryClient, queryKey],
  );

  const settle = useCallback(() => {
    // The last mutation refetches, so server order decides the outcome rather
    // than whichever response happened to arrive last.
    if (queryClient.isMutating({ mutationKey: TAG_MUTATION_KEY }) === 1) {
      return queryClient.invalidateQueries({ queryKey });
    }
  }, [queryClient, queryKey]);

  const createMutation = useMutation({
    mutationKey: TAG_MUTATION_KEY,
    mutationFn: ({ name, color }: { name: string; color: TagColor }) =>
      createTagRequest(token, name, color),
    onMutate: ({ name, color }) =>
      optimistic((current) =>
        current.some((tag) => byName(tag.name) === byName(name))
          ? current
          : [...current, { name, color }],
      )(),
    onError: rollback,
    onSettled: settle,
  });

  const recolorMutation = useMutation({
    mutationKey: TAG_MUTATION_KEY,
    mutationFn: ({ name, color }: { name: string; color: TagColor }) =>
      updateTagColorRequest(token, name, color),
    onMutate: ({ name, color }) =>
      optimistic((current) =>
        current.map((tag) =>
          byName(tag.name) === byName(name) ? { ...tag, color } : tag,
        ),
      )(),
    onError: rollback,
    onSettled: settle,
  });

  const deleteMutation = useMutation({
    mutationKey: TAG_MUTATION_KEY,
    mutationFn: (name: string) => deleteTagRequest(token, name),
    onMutate: (name) =>
      optimistic((current) =>
        current.filter((tag) => byName(tag.name) !== byName(name)),
      )(),
    onError: rollback,
    onSettled: settle,
  });

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
    (name: string, color: TagColor = DEFAULT_TAG_COLOR) =>
      createMutation.mutateAsync({ name, color }),
    [createMutation],
  );

  const recolorTag = useCallback(
    async (name: string, color: TagColor) => {
      await recolorMutation.mutateAsync({ name, color });
    },
    [recolorMutation],
  );

  const deleteTag = useCallback(
    async (name: string) => {
      await deleteMutation.mutateAsync(name);
    },
    [deleteMutation],
  );

  return {
    tags,
    // An empty list and a failed load look identical without this.
    error: error ?? (loadError ? (loadError as Error).message : null),
    colorOf,
    createTag,
    recolorTag,
    deleteTag,
  };
}

function byName(name: string) {
  return name.toLowerCase();
}

function sortByName(tags: Tag[]): Tag[] {
  return [...tags].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}
