/-!
An account's `storageBytes` against its documents' `countedBytes`. The ingest adapter
charges a document's new size minus what it already counted, a recount does the same for a
source overwritten after dispatch, and delete and the cleanup adapter refund what the
document counted. Every write is guarded by an operation id, so a retried event is a no-op;
the model therefore takes each operation once.

Assumptions: DynamoDB transactions are atomic; once a document is DELETING no charge
touches it (the ingest and recount conditions exclude DELETING).
-/
namespace Proofs.StorageAccounting

structure Doc where
  counted : Nat := 0
  deleting : Bool := false
  /-- The counted bytes the deleting process will refund. -/
  snap : Option Nat := none
  refunded : Bool := false

structure St where
  storage : Nat := 0
  docs : List Doc := []

/-- After this change (`true`), ingest charges storage and records countedBytes in one
transaction, and delete refunds the countedBytes returned by its DELETING mark. Before it,
ingest wrote them separately and delete refunded the value it read before marking. -/
structure Variant where
  atomicCharge : Bool
  snapAtMark : Bool

def fixed : Variant := ⟨true, true⟩

def weight (d : Doc) : Nat := if d.refunded then 0 else d.counted

def total (docs : List Doc) : Nat := (docs.map weight).sum

def doc (s : St) (i : Nat) : Doc := s.docs.getD i {}

def St.setDoc (s : St) (i : Nat) (d : Doc) : St := { s with docs := s.docs.set i d }

/-- The DELETING mark; `atMark` records the counted bytes it returns for the refund. -/
def markDoc (d : Doc) (atMark : Bool) : Doc :=
  { d with deleting := true, snap := if atMark then some d.counted else d.snap }

inductive Step (v : Variant) : St → St → Prop
  | create (s : St) : Step v s { s with docs := s.docs ++ [{}] }
  /-- Ingest or recount: storage moves by size - counted and countedBytes becomes size. -/
  | charge (s : St) (i size : Nat) (hi : i < s.docs.length) (hd : (doc s i).deleting = false)
      (ha : v.atomicCharge = true) :
      Step v s ({ s.setDoc i { doc s i with counted := size } with
        storage := s.storage - (doc s i).counted + size })
  /-- The old ingest's first write: storage moves, countedBytes does not yet. -/
  | chargeStorageOnly (s : St) (i size : Nat) (hi : i < s.docs.length)
      (hd : (doc s i).deleting = false) (ha : v.atomicCharge = false) :
      Step v s { s with storage := s.storage - (doc s i).counted + size }
  /-- The old ingest's second write, which a failed dispatch may never reach. -/
  | setCountedOnly (s : St) (i size : Nat) (hi : i < s.docs.length)
      (hd : (doc s i).deleting = false) (ha : v.atomicCharge = false) :
      Step v s (s.setDoc i { doc s i with counted := size })
  /-- Delete reads the document before it marks it (old). -/
  | readForDelete (s : St) (i : Nat) (hi : i < s.docs.length) (hd : (doc s i).deleting = false)
      (hv : v.snapAtMark = false) :
      Step v s (s.setDoc i { doc s i with snap := some (doc s i).counted })
  | markDeleting (s : St) (i : Nat) (hi : i < s.docs.length) (hd : (doc s i).deleting = false) :
      Step v s (s.setDoc i (markDoc (doc s i) v.snapAtMark))
  | refund (s : St) (i c : Nat) (hi : i < s.docs.length) (hd : (doc s i).deleting = true)
      (hr : (doc s i).refunded = false) (hs : (doc s i).snap = some c) :
      Step v s ({ s.setDoc i { doc s i with refunded := true } with storage := s.storage - c })

inductive Reachable (v : Variant) : St → Prop
  | init : Reachable v {}
  | step (s t : St) : Reachable v s → Step v s t → Reachable v t

theorem total_set (docs : List Doc) (i : Nat) (hi : i < docs.length) (d : Doc) :
    total (docs.set i d) + weight (docs.getD i {}) = total docs + weight d := by
  induction docs generalizing i with
  | nil => simp at hi
  | cons x xs ih =>
    cases i with
    | zero => simp [total]; omega
    | succ i =>
      simp only [List.set_cons_succ, List.getD_cons_succ, total, List.map_cons, List.sum_cons]
      have := ih i (by simpa using hi); simp only [total] at this; omega

theorem weight_le_total (docs : List Doc) (i : Nat) : weight (docs.getD i {}) ≤ total docs := by
  induction docs generalizing i with
  | nil => simp [weight]
  | cons x xs ih =>
    cases i with
    | zero => simp [total]
    | succ i => have := ih i; simp only [List.getD_cons_succ, total, List.map_cons, List.sum_cons] at this ⊢; omega

theorem doc_mem (s : St) (i : Nat) (hi : i < s.docs.length) : doc s i ∈ s.docs := by
  simp only [doc, List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hi, Option.getD_some]
  exact List.getElem_mem hi

structure Inv (s : St) : Prop where
  storage : s.storage = total s.docs
  snap : ∀ d ∈ s.docs, d.deleting = true → d.snap = some d.counted
  refunded : ∀ d ∈ s.docs, d.refunded = true → d.deleting = true

theorem mem_set_cases {l : List Doc} {i : Nat} {d x : Doc} (h : x ∈ l.set i d) : x = d ∨ x ∈ l := by
  rcases List.mem_or_eq_of_mem_set h with h | h
  · exact Or.inr h
  · exact Or.inl h

theorem not_refunded (s : St) (i : Nat) (hi : i < s.docs.length) (h3 : ∀ d ∈ s.docs,
    d.refunded = true → d.deleting = true) (hd : (doc s i).deleting = false) :
    (doc s i).refunded = false := by
  cases hr : (doc s i).refunded
  · rfl
  · have := h3 _ (doc_mem s i hi) hr; rw [hd] at this; cases this

theorem inv_step (s t : St) (hi : Inv s) (h : Step fixed s t) : Inv t := by
  obtain ⟨h1, h2, h3⟩ := hi
  cases h with
  | create =>
    refine ⟨by simp [h1, total, weight], fun d hd => ?_, fun d hd => ?_⟩
    · rcases List.mem_append.1 hd with hd | hd
      · exact h2 d hd
      · simp at hd; subst hd; intro h; cases h
    · rcases List.mem_append.1 hd with hd | hd
      · exact h3 d hd
      · simp at hd; subst hd; intro h; cases h
  | charge i size hi hd ha =>
    have hnr := not_refunded s i hi h3 hd
    have hset : total (s.docs.set i { doc s i with counted := size }) + weight (doc s i) =
        total s.docs + weight { doc s i with counted := size } := total_set s.docs i hi _
    have hle : weight (doc s i) ≤ total s.docs := weight_le_total s.docs i
    have hw1 : weight (doc s i) = (doc s i).counted := by simp [weight, hnr]
    have hw2 : weight { doc s i with counted := size } = size := by simp [weight, hnr]
    refine ⟨?_, fun d hd' hdel => ?_, fun d hd' hr => ?_⟩
    · show s.storage - (doc s i).counted + size = total (s.docs.set i _)
      omega
    · rcases mem_set_cases hd' with rfl | hd'
      · simp [hd] at hdel
      · exact h2 d hd' hdel
    · rcases mem_set_cases hd' with rfl | hd'
      · simp [hnr] at hr
      · exact h3 d hd' hr
  | chargeStorageOnly i size hi hd ha => cases ha
  | setCountedOnly i size hi hd ha => cases ha
  | readForDelete i hi hd hv => cases hv
  | markDeleting i hi hd =>
    change Inv (s.setDoc i (markDoc (doc s i) true))
    have hnr := not_refunded s i hi h3 hd
    have hset : total (s.docs.set i (markDoc (doc s i) true)) + weight (doc s i) =
        total s.docs + weight (markDoc (doc s i) true) := total_set s.docs i hi _
    have hw : weight (markDoc (doc s i) true) = weight (doc s i) := by simp [weight, markDoc]
    refine ⟨?_, fun d hd' hdel => ?_, fun d hd' hr => ?_⟩
    · show s.storage = total (s.docs.set i _)
      omega
    · rcases mem_set_cases hd' with rfl | hd'
      · simp [markDoc]
      · exact h2 d hd' hdel
    · rcases mem_set_cases hd' with rfl | hd'
      · rfl
      · exact h3 d hd' hr
  | refund i c hi hd hr hs =>
    have hc : c = (doc s i).counted := by
      have := h2 _ (doc_mem s i hi) hd; rw [hs] at this; cases this; rfl
    have hset : total (s.docs.set i { doc s i with refunded := true }) + weight (doc s i) =
        total s.docs + weight { doc s i with refunded := true } := total_set s.docs i hi _
    have hw1 : weight (doc s i) = (doc s i).counted := by simp [weight, hr]
    have hw2 : weight { doc s i with refunded := true } = 0 := by simp [weight]
    refine ⟨?_, fun d hd' hdel => ?_, fun d hd' hr' => ?_⟩
    · show s.storage - c = total (s.docs.set i _)
      omega
    · rcases mem_set_cases hd' with rfl | hd'
      · simpa [hs] using hc
      · exact h2 d hd' hdel
    · rcases mem_set_cases hd' with rfl | hd'
      · exact hd
      · exact h3 d hd' hr'

theorem inv_reachable (s : St) (h : Reachable fixed s) : Inv s := by
  induction h with
  | init => exact ⟨rfl, (fun _ h => nomatch h), (fun _ h => nomatch h)⟩
  | step s t _ hst ih => exact inv_step s t ih hst

/-- storageBytes always equals the bytes the account's documents count, so it never drifts
and deleting every document brings it back to zero. -/
theorem storage_exact (s : St) (h : Reachable fixed s) : s.storage = total s.docs :=
  (inv_reachable s h).storage

/-- Before: an ingest whose second write failed, then a second POST to the same upload form,
charged both files while the document counted one; after deleting it, 5 bytes remain. -/
theorem drifts_without_atomicCharge :
    ∃ s, Reachable ⟨false, true⟩ s ∧ total s.docs = 0 ∧ s.storage = 5 := by
  let v : Variant := ⟨false, true⟩
  let s1 : St := { docs := [{}] }
  let s2 : St := { s1 with storage := s1.storage - (doc s1 0).counted + 5 }
  let s3 : St := { s2 with storage := s2.storage - (doc s2 0).counted + 7 }
  let s4 : St := s3.setDoc 0 { doc s3 0 with counted := 7 }
  let s5 : St := s4.setDoc 0 (markDoc (doc s4 0) true)
  let s6 : St := { s5.setDoc 0 { doc s5 0 with refunded := true } with storage := s5.storage - 7 }
  refine ⟨s6, ?_, by decide, by decide⟩
  have r1 : Reachable v s1 := .step _ _ .init (.create {})
  have r2 : Reachable v s2 := .step _ _ r1 (.chargeStorageOnly s1 0 5 (by decide) rfl rfl)
  have r3 : Reachable v s3 := .step _ _ r2 (.chargeStorageOnly s2 0 7 (by decide) rfl rfl)
  have r4 : Reachable v s4 := .step _ _ r3 (.setCountedOnly s3 0 7 (by decide) rfl rfl)
  have r5 : Reachable v s5 := .step _ _ r4 (.markDeleting s4 0 (by decide) rfl)
  exact .step _ _ r5 (.refund s5 0 7 (by decide) rfl rfl rfl)

/-- Before: a delete that read countedBytes, then lost a race with a recount before its
DELETING mark, refunded the old size; after deleting it, 2 bytes remain. -/
theorem drifts_without_snapAtMark :
    ∃ s, Reachable ⟨true, false⟩ s ∧ total s.docs = 0 ∧ s.storage = 2 := by
  let v : Variant := ⟨true, false⟩
  let s1 : St := { docs := [{}] }
  let s2 : St := { s1.setDoc 0 { doc s1 0 with counted := 5 } with storage := s1.storage - (doc s1 0).counted + 5 }
  let s3 : St := s2.setDoc 0 { doc s2 0 with snap := some (doc s2 0).counted }
  let s4 : St := { s3.setDoc 0 { doc s3 0 with counted := 7 } with storage := s3.storage - (doc s3 0).counted + 7 }
  let s5 : St := s4.setDoc 0 (markDoc (doc s4 0) false)
  let s6 : St := { s5.setDoc 0 { doc s5 0 with refunded := true } with storage := s5.storage - 5 }
  refine ⟨s6, ?_, by decide, by decide⟩
  have r1 : Reachable v s1 := .step _ _ .init (.create {})
  have r2 : Reachable v s2 := .step _ _ r1 (.charge s1 0 5 (by decide) rfl rfl)
  have r3 : Reachable v s3 := .step _ _ r2 (.readForDelete s2 0 (by decide) rfl rfl)
  have r4 : Reachable v s4 := .step _ _ r3 (.charge s3 0 7 (by decide) rfl rfl)
  have r5 : Reachable v s5 := .step _ _ r4 (.markDeleting s4 0 (by decide) rfl)
  exact .step _ _ r5 (.refund s5 0 5 (by decide) rfl rfl rfl)

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/utils.ts", "ConditionExpression: `storageBytes = :currentBytes AND ${storageUpdatedCondition}`,"),
   ("functions/s3/ingest-adapter.ts", "UpdateExpression: \"SET countedBytes = :counted\","),
   ("functions/s3/ingest-adapter.ts", "ConditionExpression: \"#s = :queued\","),
   ("functions/s3/ingest-adapter.ts", ": \"countedBytes = :previous AND #s <> :deleting\","),
   ("functions/admin/delete.ts", "({ countedBytes } = await markDeleting(documentId, null));"),
   ("functions/s3/cleanup-adapter.ts", "({ countedBytes } = marked);"),
   ("functions/admin/delete.ts", "`delete:${documentId}`,"),
   ("functions/s3/cleanup-adapter.ts", "`delete:${documentId}`,")]

end Proofs.StorageAccounting
