/-!
Batching. Every AWS call with a per-request limit is fed by a `for (i = 0; i < n; i += size)
slice(i, i + size)` loop, and the embed stage packs Cohere requests with
`packEmbeddingBatches` in functions/embed/index.ts.

AWS limits assumed (from the service docs): BatchWriteItem 25 items, TransactWriteItems 100,
SendMessageBatch 10, GetVectors 100, PutVectors and DeleteVectors 500; Cohere Embed v4 takes
96 inputs and a 20 MB request.
-/
namespace Proofs.Batching

/-- The slice loop. -/
def slices (size : Nat) (l : List α) : List (List α) :=
  if _h : size = 0 ∨ l = [] then [] else l.take size :: slices size (l.drop size)
termination_by l.length
decreasing_by
  have := List.length_pos_iff.2 (by simp_all : l ≠ [])
  have : 0 < size := by simp_all; omega
  simp only [List.length_drop]; omega

theorem slices_concat (size : Nat) (hs : 0 < size) (l : List α) : (slices size l).flatten = l := by
  induction l using (measure List.length).wf.induction with
  | _ l ih =>
    unfold slices; split
    · rename_i h; rcases h with h | h
      · omega
      · simp [h]
    · rename_i h
      simp only [not_or] at h
      simp only [List.flatten_cons]
      have hlt : (l.drop size).length < l.length := by
        have := List.length_pos_iff.2 h.2; simp only [List.length_drop]; omega
      rw [ih (l.drop size) hlt]
      exact List.take_append_drop _ _

theorem slices_size (size : Nat) (l : List α) : ∀ b ∈ slices size l, 0 < b.length ∧ b.length ≤ size := by
  induction l using (measure List.length).wf.induction with
  | _ l ih =>
    unfold slices; split
    · intro b hb; cases hb
    · rename_i h
      simp only [not_or] at h
      intro b hb
      rcases List.mem_cons.1 hb with rfl | hb
      · have := List.length_pos_iff.2 h.2
        simp only [List.length_take]; omega
      · have hlt : (l.drop size).length < l.length := by
          have := List.length_pos_iff.2 h.2; simp only [List.length_drop]; omega
        exact ih (l.drop size) hlt b hb

/-! ### Cohere request packing -/

structure Item where
  owner : Nat
  bytes : Nat
  deriving DecidableEq, Repr

structure Limits where
  maxItems : Nat
  maxBytes : Nat
  emptyBytes : Nat

/-- A request's size: the empty body, each input, and a comma between inputs. -/
def requestBytes (lim : Limits) (b : List Item) : Nat :=
  lim.emptyBytes + (b.map Item.bytes).sum + (b.length - 1)

def tooLarge : String := "One Cohere embedding input exceeds the request limit"

/-- One iteration of packEmbeddingBatches: the finished requests and the open one. The open
request's size is always `requestBytes` of it, so the TS running total is not needed. -/
def packStep (lim : Limits) (done : List (List Item)) (cur : List Item) (item : Item) :
    Except String (List (List Item) × List Item) :=
  let next := requestBytes lim (cur ++ [item])
  if cur ≠ [] ∧ (cur.head?.map Item.owner ≠ some item.owner ∨ lim.maxItems < cur.length + 1 ∨
      lim.maxBytes < next) then
    if lim.maxBytes < requestBytes lim [item] then .error tooLarge else .ok (done ++ [cur], [item])
  else if lim.maxBytes < next then .error tooLarge else .ok (done, cur ++ [item])

def packGo (lim : Limits) : List Item → List (List Item) → List Item → Except String (List (List Item))
  | [], done, cur => .ok (if cur = [] then done else done ++ [cur])
  | item :: rest, done, cur =>
    match packStep lim done cur item with
    | .ok (done', cur') => packGo lim rest done' cur'
    | .error e => .error e

def packAll (lim : Limits) (items : List Item) : Except String (List (List Item)) :=
  packGo lim items [] []

/-- What every request it sends satisfies. -/
def Good (lim : Limits) (b : List Item) : Prop :=
  b ≠ [] ∧ b.length ≤ lim.maxItems ∧ requestBytes lim b ≤ lim.maxBytes ∧
    ∀ x ∈ b, ∀ y ∈ b, x.owner = y.owner

theorem good_single (lim : Limits) (h1 : 1 ≤ lim.maxItems) (item : Item)
    (h : requestBytes lim [item] ≤ lim.maxBytes) : Good lim [item] :=
  ⟨by simp, by simpa using h1, h, by simp⟩

theorem good_snoc (lim : Limits) (cur : List Item) (item : Item) (hc : cur ≠ [])
    (hg : Good lim cur) (hown : cur.head?.map Item.owner = some item.owner)
    (hlen : cur.length + 1 ≤ lim.maxItems) (hb : requestBytes lim (cur ++ [item]) ≤ lim.maxBytes) :
    Good lim (cur ++ [item]) := by
  obtain ⟨c, cs, rfl⟩ := List.exists_cons_of_ne_nil hc
  obtain ⟨_, _, _, ho⟩ := hg
  have hco : c.owner = item.owner := by simpa using hown
  refine ⟨by simp, by simpa using hlen, hb, fun x hx y hy => ?_⟩
  have hx' : x ∈ c :: cs ∨ x = item := (List.mem_append.1 hx).imp id (by simp)
  have hy' : y ∈ c :: cs ∨ y = item := (List.mem_append.1 hy).imp id (by simp)
  have hcm : c ∈ c :: cs := by simp
  rcases hx' with hx' | rfl <;> rcases hy' with hy' | rfl
  · exact ho x hx' y hy'
  · rw [← hco]; exact ho x hx' c hcm
  · rw [← hco]; exact ho c hcm y hy'
  · rfl

theorem packGo_spec (lim : Limits) (h1 : 1 ≤ lim.maxItems) :
    ∀ (items : List Item) (done : List (List Item)) (cur : List Item) (bs : List (List Item)),
      (∀ b ∈ done, Good lim b) → (cur ≠ [] → Good lim cur) →
      packGo lim items done cur = .ok bs →
      bs.flatten = done.flatten ++ cur ++ items ∧ ∀ b ∈ bs, Good lim b := by
  intro items
  induction items with
  | nil =>
    intro done cur bs hd hc h
    simp only [packGo] at h; cases h
    split
    · rename_i hcur; subst hcur; exact ⟨by simp, hd⟩
    · rename_i hcur
      refine ⟨by simp, fun b hb => ?_⟩
      rcases List.mem_append.1 hb with hb | hb
      · exact hd b hb
      · simp at hb; subst hb; exact hc hcur
  | cons item rest ih =>
    intro done cur bs hd hc h
    simp only [packGo] at h
    split at h
    · rename_i done' cur' hstep
      simp only [packStep] at hstep
      split at hstep
      · rename_i hsplit
        split at hstep
        · cases hstep
        · rename_i hfit
          cases hstep
          have := ih (done ++ [cur]) [item] bs (fun b hb => by
            rcases List.mem_append.1 hb with hb | hb
            · exact hd b hb
            · simp at hb; subst hb; exact hc hsplit.1)
            (fun _ => good_single lim h1 item (by omega)) h
          exact ⟨by rw [this.1]; simp, this.2⟩
      · rename_i hnosplit
        split at hstep
        · cases hstep
        · rename_i hfit
          cases hstep
          have hgood : Good lim (cur ++ [item]) := by
            by_cases hcur : cur = []
            · subst hcur; exact good_single lim h1 item (by simpa using Nat.le_of_not_lt hfit)
            · have := not_and.1 hnosplit hcur
              simp only [not_or, Nat.not_lt] at this
              exact good_snoc lim cur item hcur (hc hcur) (Classical.not_not.1 this.1) this.2.1
                (Nat.le_of_not_lt hfit)
          have := ih done (cur ++ [item]) bs hd (fun _ => hgood) h
          exact ⟨by rw [this.1]; simp, this.2⟩
    · cases h

/-- Packing loses, duplicates and reorders nothing, and every request it sends has one
owner, at most maxItems inputs, and fits the request size. -/
theorem packAll_spec (lim : Limits) (h1 : 1 ≤ lim.maxItems) (items : List Item)
    (bs : List (List Item)) (h : packAll lim items = .ok bs) :
    bs.flatten = items ∧ ∀ b ∈ bs, Good lim b := by
  have := packGo_spec lim h1 items [] [] bs (fun _ h => nomatch h) (fun h => absurd rfl h) h
  simpa using this

/-- It fails only when one input alone is too large for a request. -/
theorem packAll_error (lim : Limits) (items : List Item) (e : String)
    (h : packAll lim items = .error e) : ∃ item ∈ items, lim.maxBytes < requestBytes lim [item] := by
  suffices ∀ (items : List Item) (done : List (List Item)) (cur : List Item),
      packGo lim items done cur = .error e → ∃ item ∈ items, lim.maxBytes < requestBytes lim [item] from
    this items [] [] h
  intro items
  induction items with
  | nil => intro done cur h; simp only [packGo] at h; cases h
  | cons item rest ih =>
    intro done cur h
    simp only [packGo] at h
    split at h
    · rename_i done' cur' _
      obtain ⟨x, hx, hb⟩ := ih done' cur' h
      exact ⟨x, List.mem_cons_of_mem _ hx, hb⟩
    · rename_i err hstep
      refine ⟨item, List.mem_cons_self .., ?_⟩
      simp only [packStep] at hstep
      split at hstep
      · split at hstep
        · assumption
        · cases hstep
      · rename_i hnosplit
        split at hstep
        · rename_i hbig
          by_cases hcur : cur = []
          · subst hcur; simpa using hbig
          · have := not_and.1 hnosplit hcur
            simp only [not_or] at this
            exact absurd hbig this.2.2
        · cases hstep

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/embed/index.ts", "const MAX_COHERE_ITEMS = 96;"),
   ("functions/embed/index.ts", "const MAX_COHERE_REQUEST_BYTES = 19 * 1024 * 1024;"),
   ("functions/embed/index.ts", "const MAX_TRANSACT_CHUNKS = 99;"),
   ("functions/utils.ts", "const VECTOR_GET_BATCH = 100;"),
   ("functions/utils.ts", "const VECTOR_DELETE_BATCH = 500;"),
   ("functions/utils.ts", "for (let i = 0; i < chunkItems.length; i += 25) {"),
   ("functions/chunk/index.ts", "const sendSize = 10;")]

end Proofs.Batching
