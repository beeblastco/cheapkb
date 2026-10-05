/-!
`fitFilterableMetadata` in functions/utils.ts keeps a vector's filterable metadata
under the 2 KB S3 Vectors cap. When the whole record is over, it rebuilds it from the
required fields and adds sourceKey, title, then each tag and author while they fit.
The theorems hold for any size test `fits`, so they do not depend on JSON details.
-/
namespace Proofs.Metadata

/-- The optional filterable fields; the required ones are carried unchanged. -/
structure Meta where
  sourceKey : Option String := none
  title : Option String := none
  tags : Option (List String) := none
  authors : Option (List String) := none
  deriving DecidableEq, Repr

/-- Adds each value to a list field while the record still fits, in input order. -/
def addGreedy (fits : Meta → Bool) (get : Meta → List String)
    (put : Meta → List String → Meta) : Meta → List String → Meta
  | m, [] => m
  | m, v :: vs =>
    let next := put m (get m ++ [v])
    if fits next then addGreedy fits get put next vs else addGreedy fits get put m vs

def getTags (m : Meta) : List String := m.tags.getD []
def putTags (m : Meta) (l : List String) : Meta := { m with tags := some l }
def getAuthors (m : Meta) : List String := m.authors.getD []
def putAuthors (m : Meta) (l : List String) : Meta := { m with authors := some l }

/-- Adds one optional field back when the record still fits with it. -/
def addOptional (fits : Meta → Bool) (m next : Meta) (present : Bool) : Meta :=
  if present && fits next then next else m

def fit (fits : Meta → Bool) (m : Meta) : Meta :=
  if fits m then m else
    let f0 : Meta := {}
    let f1 := addOptional fits f0 { f0 with sourceKey := m.sourceKey } m.sourceKey.isSome
    let f2 := addOptional fits f1 { f1 with title := m.title } m.title.isSome
    let f3 := addGreedy fits getTags putTags f2 (m.tags.getD [])
    addGreedy fits getAuthors putAuthors f3 (m.authors.getD [])

theorem addGreedy_fits (fits : Meta → Bool) (get : Meta → List String) put :
    ∀ m vs, fits m = true → fits (addGreedy fits get put m vs) = true
  | m, [], h => h
  | m, v :: vs, h => by
    simp only [addGreedy]; split
    · exact addGreedy_fits fits get put _ vs (by assumption)
    · exact addGreedy_fits fits get put m vs h

theorem addOptional_fits (fits : Meta → Bool) (m next : Meta) (p : Bool)
    (h : fits m = true) : fits (addOptional fits m next p) = true := by
  unfold addOptional; split
  · rename_i hp; simp at hp; exact hp.2
  · exact h

/-- A record that already fits is returned unchanged. -/
theorem fit_of_fits (fits : Meta → Bool) (m : Meta) (h : fits m = true) : fit fits m = m := by
  simp [fit, h]

/-- The result always fits, as long as the required fields alone do. -/
theorem fit_fits (fits : Meta → Bool) (m : Meta) (hreq : fits {} = true) :
    fits (fit fits m) = true := by
  unfold fit; split
  · assumption
  · exact addGreedy_fits _ _ _ _ _ (addGreedy_fits _ _ _ _ _
      (addOptional_fits _ _ _ _ (addOptional_fits _ _ _ _ hreq)))

theorem addGreedy_sublist (fits : Meta → Bool) (get : Meta → List String) put
    (hput : ∀ m l, get (put m l) = l) :
    ∀ m vs, ∃ kept, kept.Sublist vs ∧ get (addGreedy fits get put m vs) = get m ++ kept
  | m, [] => ⟨[], List.Sublist.slnil, by simp [addGreedy]⟩
  | m, v :: vs => by
    simp only [addGreedy]; split
    · obtain ⟨k, hk, he⟩ := addGreedy_sublist fits get put hput (put m (get m ++ [v])) vs
      exact ⟨v :: k, hk.cons_cons v, by rw [he, hput]; simp⟩
    · obtain ⟨k, hk, he⟩ := addGreedy_sublist fits get put hput m vs
      exact ⟨k, hk.cons v, he⟩

theorem addGreedy_other (fits : Meta → Bool) (get : Meta → List String) put
    (f : Meta → α) (hf : ∀ m l, f (put m l) = f m) :
    ∀ m vs, f (addGreedy fits get put m vs) = f m
  | m, [] => rfl
  | m, v :: vs => by
    simp only [addGreedy]; split
    · rw [addGreedy_other fits get put f hf _ vs, hf]
    · exact addGreedy_other fits get put f hf m vs

/-- Kept tags are the input tags in their original order, some possibly dropped. -/
theorem fit_tags_sublist (fits : Meta → Bool) (m : Meta) :
    (getTags (fit fits m)).Sublist (getTags m) := by
  unfold fit; split
  · exact List.Sublist.refl _
  · dsimp only
    rw [addGreedy_other fits getAuthors putAuthors getTags (fun _ _ => rfl)]
    obtain ⟨k, hk, he⟩ := addGreedy_sublist fits getTags putTags (fun _ _ => rfl) _ (m.tags.getD [])
    rw [he]
    have h0 : ∀ x : Meta, x = {} ∨ x = { sourceKey := m.sourceKey } →
        getTags (addOptional fits x { x with title := m.title } m.title.isSome) = [] := by
      intro x hx; rcases hx with rfl | rfl <;> simp only [addOptional] <;> split <;> rfl
    rw [h0 _ (by simp only [addOptional]; split <;> simp)]
    simpa [getTags] using hk

/-- Kept authors are the input authors in their original order, some possibly dropped. -/
theorem fit_authors_sublist (fits : Meta → Bool) (m : Meta) :
    (getAuthors (fit fits m)).Sublist (getAuthors m) := by
  unfold fit; split
  · exact List.Sublist.refl _
  · dsimp only
    obtain ⟨k, hk, he⟩ := addGreedy_sublist fits getAuthors putAuthors (fun _ _ => rfl) _ (m.authors.getD [])
    rw [he, addGreedy_other fits getTags putTags getAuthors (fun _ _ => rfl)]
    have h0 : ∀ x : Meta, x = {} ∨ x = { sourceKey := m.sourceKey } →
        getAuthors (addOptional fits x { x with title := m.title } m.title.isSome) = [] := by
      intro x hx; rcases hx with rfl | rfl <;> simp only [addOptional] <;> split <;> rfl
    rw [h0 _ (by simp only [addOptional]; split <;> simp)]
    simpa [getAuthors] using hk

/-- sourceKey has priority: it survives whenever it fits beside the required fields,
so a search result keeps its file link over a long title. -/
theorem fit_keeps_sourceKey (fits : Meta → Bool) (m : Meta) (h : m.sourceKey.isSome = true)
    (hfit : fits { sourceKey := m.sourceKey } = true) :
    (fit fits m).sourceKey = m.sourceKey := by
  unfold fit; split
  · rfl
  · dsimp only
    rw [addGreedy_other fits getAuthors putAuthors Meta.sourceKey (fun _ _ => rfl),
      addGreedy_other fits getTags putTags Meta.sourceKey (fun _ _ => rfl)]
    simp only [addOptional, h, hfit, Bool.and_self, ite_true]
    split <;> rfl

/-- The title is either dropped or the input's; nothing is invented. -/
theorem fit_title_from_input (fits : Meta → Bool) (m : Meta) :
    (fit fits m).title = none ∨ (fit fits m).title = m.title := by
  unfold fit; split
  · exact Or.inr rfl
  · dsimp only
    rw [addGreedy_other fits getAuthors putAuthors Meta.title (fun _ _ => rfl),
      addGreedy_other fits getTags putTags Meta.title (fun _ _ => rfl)]
    simp only [addOptional]; split <;> split <;> simp

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/utils.ts", "const MAX_FILTERABLE_METADATA_BYTES = 2048;"),
   ("functions/utils.ts", "if (sourceKey !== undefined && fits({ ...fitted, sourceKey: sourceKey })) {"),
   ("functions/utils.ts", "if (title !== undefined && fits({ ...fitted, title: title })) {"),
   ("functions/utils.ts", "if (fits({ ...fitted, [field]: next })) fitted[field] = next;")]

end Proofs.Metadata
