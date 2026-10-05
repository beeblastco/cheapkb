/-!
`buildFilter` in functions/query/index.ts turns a caller's filters into the S3 Vectors
filter. Tenant isolation rests on it: every query is ANDed with the caller's own userId,
and no caller-supplied condition can name userId.
Assumption: S3 Vectors applies `$and` as a conjunction.
-/
namespace Proofs.QueryFilter

/-- One condition `{ key: { op: value } }`; values are opaque here. -/
structure Cond (V : Type) where
  key : String
  op : String
  value : V

def allowedKeys : List String := ["authors", "documentId", "mimeType", "modality", "tags", "title", "year"]

/-- A caller's filter entry: a scalar, or an object of operators. `valid` stands for the
operator and value checks, which do not affect isolation. -/
inductive Entry (V : Type)
  | scalar (v : V)
  | ops (os : List (String × V))

/-- One filter entry: userId is skipped, an unknown or invalid one is refused. -/
def filterStep (valid : String → Entry V → Bool) (acc : List (Cond V)) (f : String × Entry V) :
    Except String (List (Cond V)) :=
  if f.1 = "userId" then Except.ok acc
  else if f.1 ∉ allowedKeys ∨ !valid f.1 f.2 then Except.error s!"Unsupported filter: {f.1}"
  else match f.2 with
    | .scalar v => Except.ok (acc ++ [⟨f.1, "$eq", v⟩])
    | .ops os => Except.ok (acc ++ os.map fun o => ⟨f.1, o.1, o.2⟩)

def buildFilter (valid : String → Entry V → Bool) (model user : V)
    (filters : List (String × Entry V)) : Except String (List (Cond V)) :=
  filters.foldlM (filterStep valid) [⟨"embeddingModel", "$eq", model⟩, ⟨"userId", "$eq", user⟩]

def userConds (l : List (Cond V)) : List (String × V) :=
  (l.filter (·.key == "userId")).map fun c => (c.op, c.value)

theorem fold_spec (valid : String → Entry V → Bool) (user : V) :
    ∀ (filters : List (String × Entry V)) (acc out : List (Cond V)),
      userConds acc = [("$eq", user)] → filters.foldlM (filterStep valid) acc = Except.ok out →
      userConds out = [("$eq", user)] ∧ acc <+: out
  | [], acc, out, h, hf => by
    simp only [List.foldlM_nil, pure, Except.pure, Except.ok.injEq] at hf; subst hf
    exact ⟨h, List.prefix_refl _⟩
  | f :: fs, acc, out, h, hf => by
    simp only [List.foldlM_cons, bind, Except.bind] at hf
    cases hs : filterStep valid acc f with
    | error e => rw [hs] at hf; cases hf
    | ok acc' =>
      rw [hs] at hf
      have hstep : userConds acc' = [("$eq", user)] ∧ acc <+: acc' := by
        unfold filterStep at hs
        split at hs
        · cases hs; exact ⟨h, List.prefix_refl _⟩
        · rename_i hk
          have hk' : (f.1 == "userId") = false := by simpa using hk
          split at hs
          · cases hs
          · split at hs
            · cases hs
              exact ⟨by simp [userConds, List.filter_append, hk'] at h ⊢; exact h, List.prefix_append _ _⟩
            · cases hs
              rename_i os _
              have hnone : (os.map fun o => (⟨f.1, o.1, o.2⟩ : Cond V)).filter (·.key == "userId") = [] := by
                simp [List.filter_map, Function.comp_def, hk']
              refine ⟨?_, List.prefix_append _ _⟩
              unfold userConds at h ⊢
              rw [List.filter_append, hnone, List.append_nil]; exact h
      obtain ⟨h1, h2⟩ := fold_spec valid user fs acc' out hstep.1 hf
      exact ⟨h1, hstep.2.trans h2⟩

/-- Every query is restricted to the caller: the filter's only userId condition is
`$eq` the caller's id, whatever the caller sends, and it is always present. -/
theorem caller_isolated (valid : String → Entry V → Bool) (model user : V)
    (filters : List (String × Entry V)) (out : List (Cond V))
    (h : buildFilter valid model user filters = .ok out) :
    userConds out = [("$eq", user)] ∧
      out.take 2 = [⟨"embeddingModel", "$eq", model⟩, ⟨"userId", "$eq", user⟩] := by
  obtain ⟨h1, h2⟩ := fold_spec valid user filters _ out (by simp [userConds]) h
  refine ⟨h1, ?_⟩
  obtain ⟨rest, rfl⟩ := h2
  simp

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/query/index.ts", "if (key === \"userId\") continue;"),
   ("functions/query/index.ts", "{ userId: { $eq: userId } },"),
   ("functions/query/index.ts", "return { $and: conditions };")]

end Proofs.QueryFilter
