import {
  createTag as createTagRequest,
  deleteTag as deleteTagRequest,
  listTags,
  updateTagColor as updateTagColorRequest,
} from "@/lib/client";
import { DEFAULT_TAG_COLOR, type Tag, type TagColor } from "@/lib/types";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

export interface TagVocabulary {
  tags: Tag[];
  error: string | null;
  colorOf: (name: string) => TagColor;
  createTag: (name: string, color?: TagColor) => Promise<Tag>;
  recolorTag: (name: string, color: TagColor) => Promise<void>;
  deleteTag: (name: string) => Promise<void>;
}

type TagMutation =
  | { type: "create"; name: string; color: TagColor }
  | { type: "recolor"; name: string; color: TagColor }
  | { type: "delete"; name: string };

const NO_TAGS: Tag[] = [];

// Owns the user's tag vocabulary. The cache holds only what the server returned;
// in-flight edits are layered on top at render time and never written to it.
export function useTags(token: string): TagVocabulary {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const queryKey = useMemo(() => ["tags", token], [token]);
  // Scoped by token so mutations for one identity never count as another's.
  const mutationKey = queryKey;

  const { data: serverTags = NO_TAGS, error: loadError } = useQuery({
    queryKey,
    queryFn: () => listTags(token),
    enabled: Boolean(token),
  });

  // A failed mutation leaves this list, so its edit disappears on its own and
  // no rollback can reach a concurrent one.
  const inFlight = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (mutation) => mutation.state.variables as TagMutation,
  });

  const tags = useMemo(
    () => sortByName(applyInFlight(serverTags, inFlight)),
    [serverTags, inFlight],
  );

  const begin = useCallback(() => setError(null), []);
  const fail = useCallback((caught: unknown) => {
    setError((caught as Error).message);
  }, []);

  const settle = useCallback(() => {
    // The last mutation refetches, so server order decides the outcome rather
    // than whichever response happened to arrive last.
    if (queryClient.isMutating({ mutationKey }) === 1) {
      return queryClient.invalidateQueries({ queryKey });
    }
  }, [queryClient, queryKey, mutationKey]);

  // Patch one tag from the server's own response so the list stays correct
  // between the mutation settling and the refetch landing.
  const patch = useCallback(
    (apply: (current: Tag[]) => Tag[]) => {
      queryClient.setQueryData<Tag[]>(queryKey, (current = NO_TAGS) =>
        apply(current),
      );
    },
    [queryClient, queryKey],
  );

  const createMutation = useMutation({
    mutationKey,
    mutationFn: (variables: TagMutation & { type: "create" }) =>
      createTagRequest(token, variables.name, variables.color),
    onMutate: begin,
    onSuccess: (saved) =>
      patch((current) =>
        current.some((tag) => byName(tag.name) === byName(saved.name))
          ? current.map((tag) =>
            byName(tag.name) === byName(saved.name) ? saved : tag,
          )
          : [...current, saved],
      ),
    onError: fail,
    onSettled: settle,
  });

  const recolorMutation = useMutation({
    mutationKey,
    mutationFn: (variables: TagMutation & { type: "recolor" }) =>
      updateTagColorRequest(token, variables.name, variables.color),
    onMutate: begin,
    onSuccess: (saved) =>
      patch((current) =>
        current.map((tag) =>
          byName(tag.name) === byName(saved.name) ? saved : tag,
        ),
      ),
    onError: fail,
    onSettled: settle,
  });

  const deleteMutation = useMutation({
    mutationKey,
    mutationFn: (variables: TagMutation & { type: "delete" }) =>
      deleteTagRequest(token, variables.name),
    onMutate: begin,
    onSuccess: (_result, variables) =>
      patch((current) =>
        current.filter((tag) => byName(tag.name) !== byName(variables.name)),
      ),
    onError: fail,
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
      createMutation.mutateAsync({ type: "create", name, color }),
    [createMutation],
  );

  const recolorTag = useCallback(
    async (name: string, color: TagColor) => {
      await recolorMutation.mutateAsync({ type: "recolor", name, color });
    },
    [recolorMutation],
  );

  const deleteTag = useCallback(
    async (name: string) => {
      await deleteMutation.mutateAsync({ type: "delete", name });
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

// Replays in-flight edits over the server list in the order they started, so
// the newest edit wins without tracking revisions.
function applyInFlight(serverTags: Tag[], inFlight: TagMutation[]): Tag[] {
  let tags = serverTags;
  for (const variables of inFlight) {
    if (variables === undefined) continue;
    if (variables.type === "create") {
      const { name, color } = variables;
      if (!tags.some((tag) => byName(tag.name) === byName(name))) {
        tags = [...tags, { name, color }];
      }
    } else if (variables.type === "recolor") {
      const { name, color } = variables;
      tags = tags.map((tag) =>
        byName(tag.name) === byName(name) ? { ...tag, color } : tag,
      );
    } else {
      tags = tags.filter((tag) => byName(tag.name) !== byName(variables.name));
    }
  }
  return tags;
}

function sortByName(tags: Tag[]): Tag[] {
  return [...tags].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}
