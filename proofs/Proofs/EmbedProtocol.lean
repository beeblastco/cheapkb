/-!
The chunk and embed stages share one counter: META's `embeddedCount`, which the embed
stage bumps in the same transaction that marks a chunk row EMBEDDED, and which
`markEmbedded` compares with `chunkCount` to finish the document.

Here every chunk row carries its generation (`createdAt`), every queued embed message
names the generation it was made for, and messages are never consumed: SQS may deliver
any of them again, late, in any order. A reindex resets the counter and records
`reindexedAt`. A replacement is the ingest adapter's separate writes: it deletes the
rows one by one while older chunk runs may still write, then resets the counter and
records `reindexedAt` in one conditional write.

Assumptions: DynamoDB conditional writes and transactions are atomic; a reindex is stamped
later than every chunk row written before it (Lambda clocks agree to within the time from
one chunk run to the next reindex); chunking after a reset is deterministic, so every run
since the reset produces the same `chunkCount`. Rows written after a reset are later than
it by construction: the chunk stage stamps them at least 1 ms after `reindexedAt`.
-/
namespace Proofs.EmbedProtocol

structure Row where
  gen : Nat
  embedded : Bool

structure Msg where
  chunk : Nat
  gen : Nat

structure St where
  rows : Nat → Option Row := fun _ => none
  count : Nat := 0
  chunkCount : Nat := 0
  /-- META's reindexedAt; 0 when the document was never reindexed. -/
  resetAt : Nat := 0
  msgs : List Msg := []
  /-- A replacement is between its first row delete and its META write. -/
  replacing : Bool := false

/-- Which of the two guards the protocol has. Before this change the embed stage counted
chunks of any generation (`freshOnly := false`), and a chunk message that reported a first
receive overwrote rows unconditionally (`keepEmbedded := false`). -/
structure Variant where
  freshOnly : Bool
  keepEmbedded : Bool

def fixed : Variant := ⟨true, true⟩

def St.put (s : St) (i : Nat) (r : Option Row) : St :=
  { s with rows := fun j => if j = i then r else s.rows j }

/-- putChunkRecord's condition: write unless the row is EMBEDDED and newer than the
reindex the chunk message belongs to. -/
def mayPut (s : St) (i ra : Nat) : Bool :=
  match s.rows i with
  | none => true
  | some r => !r.embedded || decide (r.gen < ra)

inductive Step (v : Variant) : St → St → Prop
  /-- The chunk stage writes row i of generation g and queues its message. `ra` is the
  reindexedAt its message carries, never newer than META's. -/
  | chunkRow (s : St) (i g ra : Nat) (hi : i < s.chunkCount) (hra : ra ≤ s.resetAt)
      (hput : v.keepEmbedded = true → mayPut s i ra = true) :
      Step v s { (s.put i (some ⟨g, false⟩)) with msgs := s.msgs ++ [⟨i, g⟩] }
  /-- removeSurplusChunks drops rows past chunkCount. -/
  | removeRow (s : St) (i : Nat) (hi : s.chunkCount ≤ i) : Step v s (s.put i none)
  /-- markChunksEmbedded for a delivered message: the row must exist, match the
  message's generation and not be EMBEDDED yet, and (fixed) be newer than the reindex. -/
  | mark (s : St) (m : Msg) (r : Row) (hm : m ∈ s.msgs) (hr : s.rows m.chunk = some r)
      (hgen : r.gen = m.gen) (hne : r.embedded = false) (hfresh : v.freshOnly = true → s.resetAt < m.gen) :
      Step v s { (s.put m.chunk (some ⟨r.gen, true⟩)) with count := s.count + 1 }
  /-- Reindex: embeddedCount := 0, reindexedAt := now, which is later than every row. -/
  | reindex (s : St) (t n : Nat) (ht : ∀ i r, s.rows i = some r → r.gen < t) (hle : s.resetAt ≤ t) :
      Step v s { s with count := 0, resetAt := t, chunkCount := n }
  /-- finalizeReplacement starts deleting the old chunk rows. -/
  | replaceStart (s : St) : Step v s { s with replacing := true }
  /-- It deletes any row; older chunk runs can still write rows meanwhile. -/
  | replaceDeleteRow (s : St) (i : Nat) (h : s.replacing = true) : Step v s (s.put i none)
  /-- Its META write: REMOVE embeddedCount and chunkCount, SET reindexedAt = now, which is
  later than every row written so far. -/
  | replaceFinish (s : St) (t n : Nat) (h : s.replacing = true)
      (ht : ∀ i r, s.rows i = some r → r.gen < t) (hle : s.resetAt ≤ t) :
      Step v s { s with count := 0, resetAt := t, chunkCount := n, replacing := false }

inductive Reachable (v : Variant) : St → Prop
  | init : Reachable v {}
  | step (s t : St) : Reachable v s → Step v s t → Reachable v t

/-- A row the counter accounts for: EMBEDDED and written after the last reset. -/
def cnt (resetAt : Nat) : Option Row → Bool
  | none => false
  | some r => r.embedded && decide (resetAt < r.gen)

def counted (s : St) (i : Nat) : Bool := cnt s.resetAt (s.rows i)

structure Inv (s : St) : Prop where
  count : s.replacing = false → s.count = (List.range s.chunkCount).countP (counted s)
  /-- Rows past chunkCount are left over from before the last reset. -/
  outside : ∀ i r, s.chunkCount ≤ i → s.rows i = some r → r.gen ≤ s.resetAt

theorem countP_congr (n : Nat) (f g : Nat → Bool) (h : ∀ i, i < n → f i = g i) :
    (List.range n).countP f = (List.range n).countP g := by
  apply List.countP_congr; intro i hi; simp at hi; rw [h i hi]

/-- Turning one uncounted row below n into a counted one adds one to the count. -/
theorem countP_update (n i : Nat) (hi : i < n) (f g : Nat → Bool)
    (hsame : ∀ j, j ≠ i → f j = g j) (hf : f i = false) (hg : g i = true) :
    (List.range n).countP g = (List.range n).countP f + 1 := by
  induction n with
  | zero => omega
  | succ n ih =>
    simp only [List.range_succ, List.countP_append, List.countP_singleton]
    by_cases h : i = n
    · subst h
      rw [countP_congr i g f fun j hj => (hsame j (by omega)).symm, hf, hg]; simp
    · rw [ih (by omega), hsame n (Ne.symm h)]; omega

theorem put_rows (s : St) (i j : Nat) (x : Option Row) :
    (s.put i x).rows j = if j = i then x else s.rows j := rfl

theorem inv_step (s t : St) (hi : Inv s) (h : Step fixed s t) : Inv t := by
  obtain ⟨hc, ho⟩ := hi
  cases h with
  | chunkRow i g ra hlt hra hput =>
    have hp := hput rfl
    have hold : counted s i = false := by
      unfold counted
      cases hrow : s.rows i with
      | none => rfl
      | some r =>
        simp only [mayPut, hrow, Bool.or_eq_true, Bool.not_eq_true', decide_eq_true_eq] at hp
        simp only [cnt, Bool.and_eq_false_iff, decide_eq_false_iff_not]
        rcases hp with hp | hp
        · exact Or.inl hp
        · exact Or.inr (by omega)
    refine ⟨fun hrep => ?_, fun j r hj hr => ?_⟩
    · show s.count = (List.range s.chunkCount).countP
        (fun j => cnt s.resetAt (if j = i then some ⟨g, false⟩ else s.rows j))
      rw [hc hrep]; apply countP_congr; intro j _
      show counted s j = _
      split
      · subst_vars; rw [hold]; rfl
      · rfl
    · change s.chunkCount ≤ j at hj; change r.gen ≤ s.resetAt
      have : (if j = i then some ⟨g, false⟩ else s.rows j) = some r := hr
      split at this
      · omega
      · exact ho j r hj this
  | removeRow i hle =>
    refine ⟨fun hrep => ?_, fun j r hj hr => ?_⟩
    · show s.count = (List.range s.chunkCount).countP
        (fun j => cnt s.resetAt (if j = i then none else s.rows j))
      rw [hc hrep]; apply countP_congr; intro j hj
      show counted s j = _
      split
      · omega
      · rfl
    · change s.chunkCount ≤ j at hj; change r.gen ≤ s.resetAt
      have : (if j = i then none else s.rows j) = some r := hr
      split at this
      · cases this
      · exact ho j r hj this
  | mark m r hm hr hgen hne hfresh =>
    have hf := hfresh rfl
    have hlt : m.chunk < s.chunkCount := by
      refine Nat.lt_of_not_le fun hle => ?_
      have := ho m.chunk r hle hr; omega
    have hold : counted s m.chunk = false := by unfold counted cnt; rw [hr]; simp [hne]
    refine ⟨fun hrep => ?_, fun j r' hj hr' => ?_⟩
    · show s.count + 1 = (List.range s.chunkCount).countP
        (fun j => cnt s.resetAt (if j = m.chunk then some ⟨r.gen, true⟩ else s.rows j))
      rw [countP_update s.chunkCount m.chunk hlt (counted s) _ (fun j hj => by simp [hj, counted])
        hold (by simp [cnt]; omega), hc hrep]
    · change s.chunkCount ≤ j at hj; change r'.gen ≤ s.resetAt
      have : (if j = m.chunk then some ⟨r.gen, true⟩ else s.rows j) = some r' := hr'
      split at this
      · omega
      · exact ho j r' hj this
  | reindex t n ht hle =>
    have hz : ∀ j, cnt t (s.rows j) = false := by
      intro j; unfold cnt; split
      · rfl
      · rename_i r hr; have := ht j r hr; simp; omega
    refine ⟨fun _ => ?_, fun j r _ hr => Nat.le_of_lt (ht j r hr)⟩
    show 0 = (List.range n).countP (fun j => cnt t (s.rows j))
    rw [List.countP_eq_zero.2 fun j _ => by rw [hz]; simp]
  | replaceStart => exact ⟨(fun h => nomatch h), ho⟩
  | replaceDeleteRow i hrep =>
    refine ⟨fun h => absurd hrep (by simp_all [St.put]), fun j r hj hr => ?_⟩
    change s.chunkCount ≤ j at hj; change r.gen ≤ s.resetAt
    have : (if j = i then none else s.rows j) = some r := hr
    split at this
    · cases this
    · exact ho j r hj this
  | replaceFinish t n hrep ht hle =>
    have hz : ∀ j, cnt t (s.rows j) = false := by
      intro j; unfold cnt; split
      · rfl
      · rename_i r hr; have := ht j r hr; simp; omega
    refine ⟨fun _ => ?_, fun j r _ hr => Nat.le_of_lt (ht j r hr)⟩
    show 0 = (List.range n).countP (fun j => cnt t (s.rows j))
    rw [List.countP_eq_zero.2 fun j _ => by rw [hz]; simp]

theorem inv_reachable (s : St) (h : Reachable fixed s) : Inv s := by
  induction h with
  | init => exact ⟨fun _ => by simp, fun _ _ _ h => nomatch h⟩
  | step s t _ hst ih => exact inv_step s t ih hst

/-- embeddedCount never drifts: outside a replacement's own cleanup, it equals the number
of current chunks that are EMBEDDED in a generation newer than the last reindex or
replacement, however messages are duplicated or delayed and whatever older chunk runs
write while a replacement deletes rows. -/
theorem count_exact (s : St) (h : Reachable fixed s) (hrep : s.replacing = false) :
    s.count = (List.range s.chunkCount).countP (counted s) :=
  (inv_reachable s h).count hrep

/-- markEmbedded finishes a document when embeddedCount reaches chunkCount; by then
every one of its chunks really is EMBEDDED in the current generation. -/
theorem done_means_all_embedded (s : St) (h : Reachable fixed s) (hrep : s.replacing = false)
    (hdone : s.chunkCount ≤ s.count) : ∀ i, i < s.chunkCount → counted s i = true := by
  intro i hi
  have hc := count_exact s h hrep
  have hle := List.countP_le_length (p := counted s) (l := List.range s.chunkCount)
  have hall : (List.range s.chunkCount).countP (counted s) = (List.range s.chunkCount).length := by
    simp at hle ⊢; omega
  exact List.countP_eq_length.1 hall i (by simpa using hi)

/-- Before this change, a chunk message from before a reindex could still be counted: the
reindex resets embeddedCount, the old message marks its old row, and the re-chunked rows
are counted again, so the document finishes with a chunk still unembedded. -/
theorem drifts_without_freshOnly :
    ∃ s, Reachable ⟨false, true⟩ s ∧ s.count ≠ (List.range s.chunkCount).countP (counted s) := by
  let s0 : St := {}
  let s1 : St := { s0 with count := 0, resetAt := 0, chunkCount := 1 }
  let s2 : St := { (s1.put 0 (some ⟨1, false⟩)) with msgs := s1.msgs ++ [⟨0, 1⟩] }
  let s3 : St := { s2 with count := 0, resetAt := 2, chunkCount := 1 }
  let s4 : St := { (s3.put 0 (some ⟨1, true⟩)) with count := s3.count + 1 }
  refine ⟨s4, ?_, ?_⟩
  · have r1 : Reachable ⟨false, true⟩ s1 := .step _ _ .init (.reindex s0 0 1 (fun _ _ h => nomatch h) (Nat.le_refl _))
    have r2 : Reachable ⟨false, true⟩ s2 := .step _ _ r1 (.chunkRow s1 0 1 0 (by decide) (Nat.le_refl _) (fun _ => rfl))
    have r3 : Reachable ⟨false, true⟩ s3 := .step _ _ r2 (.reindex s2 2 1 (by
      intro i r hr
      have : (if i = 0 then some (⟨1, false⟩ : Row) else none) = some r := hr
      split at this
      · cases this; decide
      · cases this) (by decide))
    exact .step _ _ r3 (.mark s3 ⟨0, 1⟩ ⟨1, false⟩ (by simp [s3, s2]) (by simp [s3, s2, St.put]) rfl rfl
      (fun h => nomatch h))
  · decide

/-- SQS can deliver the same chunk message twice, both reporting a first receive. Without
the guard the second delivery overwrites an EMBEDDED row that was already counted. -/
theorem drifts_without_keepEmbedded :
    ∃ s, Reachable ⟨true, false⟩ s ∧ s.count ≠ (List.range s.chunkCount).countP (counted s) := by
  let s0 : St := {}
  let s1 : St := { s0 with count := 0, resetAt := 0, chunkCount := 1 }
  let s2 : St := { (s1.put 0 (some ⟨1, false⟩)) with msgs := s1.msgs ++ [⟨0, 1⟩] }
  let s3 : St := { (s2.put 0 (some ⟨1, true⟩)) with count := s2.count + 1 }
  let s4 : St := { (s3.put 0 (some ⟨3, false⟩)) with msgs := s3.msgs ++ [⟨0, 3⟩] }
  refine ⟨s4, ?_, ?_⟩
  · have r1 : Reachable ⟨true, false⟩ s1 :=
      .step _ _ .init (.reindex s0 0 1 (fun _ _ h => nomatch h) (Nat.le_refl _))
    have r2 : Reachable ⟨true, false⟩ s2 :=
      .step _ _ r1 (.chunkRow s1 0 1 0 (by decide) (Nat.le_refl _) (fun h => nomatch h))
    have r3 : Reachable ⟨true, false⟩ s3 :=
      .step _ _ r2 (.mark s2 ⟨0, 1⟩ ⟨1, false⟩ (by simp [s2]) (by simp [s2, St.put]) rfl rfl
        (fun _ => by decide))
    exact .step _ _ r3 (.chunkRow s3 0 3 0 (by decide) (Nat.le_refl _) (fun h => nomatch h))
  · decide

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/embed/index.ts", "\"attribute_exists(pk) AND createdAt = :createdAt AND (attribute_not_exists(#s) OR #s <> :embedded)\","),
   ("functions/embed/index.ts", "\"attribute_exists(pk) AND #s <> :deleting AND (attribute_not_exists(reindexedAt) OR reindexedAt < :createdAt)\","),
   ("functions/chunk/index.ts", "? \"attribute_not_exists(pk) OR #s <> :embedded OR createdAt < :reindexedAt\""),
   ("functions/chunk/index.ts", ": \"attribute_not_exists(pk) OR #s <> :embedded\","),
   ("functions/chunk/index.ts", "resetAt && now <= resetAt"),
   ("functions/admin/reindex.ts", "embeddedCount = :zero, failedStep = :null, updatedAt = :t, reindexedAt = :t"),
   ("functions/embed/index.ts", "\"attribute_exists(pk) AND embeddedCount >= :expected AND #s <> :s AND #s <> :deleting\","),
   ("functions/embed/index.ts", ".reduce((oldest, next) => (next < oldest ? next : oldest)),"),
   ("functions/embed/index.ts", "if (doc.reindexedAt && chunk.createdAt <= doc.reindexedAt) {"),
   ("functions/chunk/index.ts", "\"attribute_exists(pk) AND embeddedCount >= :count AND #s <> :deleting\","),
   ("functions/s3/ingest-adapter.ts", "updatedAt = :now, reindexedAt = :now REMOVE chunkCount, embeddedCount,")]

end Proofs.EmbedProtocol
