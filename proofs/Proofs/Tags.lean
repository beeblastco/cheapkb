/-!
`normalizeTags` in functions/admin/update.ts: trims each tag, drops blanks and drops later
tags equal to an earlier one ignoring case, keeping the first spelling; no tags left is null.
The theorems hold for any trim that is idempotent and any case key.
-/
namespace Proofs.Tags

def normalizeGo (trim key : String → String) : List String → List String → List String
  | [], kept => kept
  | t :: ts, kept =>
    let tt := trim t
    if tt.isEmpty || kept.any (fun k => key k == key tt) then normalizeGo trim key ts kept
    else normalizeGo trim key ts (kept ++ [tt])

def normalize (trim key : String → String) (tags : List String) : Option (List String) :=
  let kept := normalizeGo trim key tags []
  if kept.isEmpty then none else some kept

/-- The kept list: no blanks, no two tags with the same key, each the trim of an input. -/
def Clean (trim key : String → String) (inputs kept : List String) : Prop :=
  (∀ k ∈ kept, k.isEmpty = false) ∧ (kept.map key).Nodup ∧ (∀ k ∈ kept, ∃ t ∈ inputs, trim t = k)

theorem go_clean (trim key : String → String) :
    ∀ (ts kept : List String) (pre : List String), Clean trim key pre kept →
      Clean trim key (pre ++ ts) (normalizeGo trim key ts kept)
  | [], kept, pre, h => by simp only [normalizeGo, List.append_nil]; exact h
  | t :: ts, kept, pre, h => by
    simp only [normalizeGo]
    have hpre : pre ++ t :: ts = (pre ++ [t]) ++ ts := by simp
    rw [hpre]
    split
    · apply go_clean trim key ts kept (pre ++ [t])
      obtain ⟨h1, h2, h3⟩ := h
      exact ⟨h1, h2, fun k hk => by obtain ⟨x, hx, e⟩ := h3 k hk; exact ⟨x, by simp [hx], e⟩⟩
    · rename_i hc
      simp only [Bool.or_eq_true, not_or, Bool.not_eq_true, List.any_eq_false, beq_iff_eq] at hc
      apply go_clean trim key ts (kept ++ [trim t]) (pre ++ [t])
      obtain ⟨h1, h2, h3⟩ := h
      refine ⟨fun k hk => ?_, ?_, fun k hk => ?_⟩
      · rcases List.mem_append.1 hk with hk | hk
        · exact h1 k hk
        · simp at hk; subst hk; exact hc.1
      · rw [List.map_append, List.nodup_append]
        refine ⟨h2, by simp, fun a ha b hb => ?_⟩
        simp at hb; subst hb
        obtain ⟨k, hk, rfl⟩ := List.mem_map.1 ha
        exact hc.2 k hk
      · rcases List.mem_append.1 hk with hk | hk
        · obtain ⟨x, hx, e⟩ := h3 k hk; exact ⟨x, by simp [hx], e⟩
        · simp at hk; subst hk; exact ⟨t, by simp, rfl⟩

/-- Every saved tag is a trimmed input, none is blank, and no two differ only in case. -/
theorem normalize_clean (trim key : String → String) (tags kept : List String)
    (h : normalize trim key tags = some kept) : Clean trim key tags kept := by
  unfold normalize at h; dsimp only at h; split at h
  · cases h
  · cases h; simpa using go_clean trim key tags [] [] ⟨by simp, by simp, by simp⟩

theorem go_keeps (trim key : String → String) :
    ∀ (ts kept : List String), kept <+: normalizeGo trim key ts kept
  | [], kept => List.prefix_refl _
  | t :: ts, kept => by
    simp only [normalizeGo]; split
    · exact go_keeps trim key ts kept
    · exact (List.prefix_append kept _).trans (go_keeps trim key ts _)

/-- The first spelling wins: a later tag never displaces one already kept. -/
theorem first_spelling_wins (trim key : String → String) (t : String) (ts : List String)
    (h : (trim t).isEmpty = false) : ∃ rest, normalizeGo trim key (t :: ts) [] = trim t :: rest := by
  simp only [normalizeGo, h, Bool.false_or, List.any_nil, ite_false, Bool.false_eq_true, List.nil_append]
  obtain ⟨rest, hr⟩ := go_keeps trim key ts [trim t]
  exact ⟨rest, by rw [← hr]; rfl⟩

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/utils.ts", "const key = trimmed.toLowerCase();"),
   ("functions/utils.ts", "if (!deduped.has(key)) deduped.set(key, trimmed);"),
   ("functions/admin/upload.ts", "tags: normalizeTags(body.tags),"),
   ("functions/admin/upload.ts", "\":tags\": normalizeTags(body.tags),")]

end Proofs.Tags
