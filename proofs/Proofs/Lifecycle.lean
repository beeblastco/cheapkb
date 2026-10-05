/-!
A document's META row across every writer: the pipeline stages and sweeper, the ingest
adapter, edits (functions/admin/update.ts), delete, reset and the cleanup adapter,
re-uploads and reindex. Each step is one conditional write, taken in any order.

Assumptions: DynamoDB conditional writes are atomic; `clock` never runs backwards; a
replacement's form expires within `ttl`, and edits and reindex wait out `grace` after it.
-/
namespace Proofs.Lifecycle

inductive Status
  | uploaded | queued | parsing | parsed | chunking | chunked | embedding | embedded | failed
  | updating | deleting
  deriving DecidableEq, Repr

def settled : Status → Bool
  | .embedded | .failed => true
  | _ => false

structure Doc where
  status : Status
  /-- updatedAt while UPDATING: when the edit lease was taken. -/
  leaseAt : Nat := 0
  /-- replacementExpiresAt, when a re-upload is reserved. -/
  replacement : Option Nat := none

structure St where
  doc : Option Doc
  clock : Nat := 0

structure Params where
  leaseTtl : Nat
  ttl : Nat
  grace : Nat

/-- After this change the ingest adapter's failure write needs the row to exist and not
be DELETING; before, it was an unconditional update, which DynamoDB runs as an upsert. -/
structure Variant where
  guardedFailure : Bool

def liveLease (p : Params) (d : Doc) (now : Nat) : Bool :=
  d.status == .updating && decide (now < d.leaseAt + p.leaseTtl)

/-- A reservation is pending until its grace has passed: `expiresAt + GRACE > now`. -/
def pendingReplacement (p : Params) (d : Doc) (now : Nat) : Bool :=
  match d.replacement with
  | none => false
  | some e => decide (now ≤ e + p.grace)

/-- PROCESSING_STATUSES in functions/admin/reindex.ts. -/
def processing : Status → Bool
  | .queued | .parsing | .parsed | .chunking | .chunked | .embedding => true
  | _ => false

def pipelineStatus : Status → Bool
  | .updating | .deleting | .uploaded => false
  | _ => true

inductive Step (v : Variant) (p : Params) : St → St → Prop
  | tick (s : St) : Step v p s { s with clock := s.clock + 1 }
  /-- Any pipeline or sweeper status write: `attribute_exists(pk) AND #s <> :deleting`. -/
  | pipeline (s : St) (d : Doc) (st : Status) (hd : s.doc = some d) (hst : pipelineStatus st = true)
      (hnd : d.status ≠ .deleting) : Step v p s { s with doc := some { d with status := st } }
  /-- The ingest adapter marks an unusable upload FAILED. -/
  | ingestFailure (s : St) (old : Option Doc) (hd : s.doc = old)
      (hguard : v.guardedFailure = true → ∃ d, old = some d ∧ d.status ≠ .deleting) :
      Step v p s { s with doc := some { (old.getD ⟨.failed, 0, none⟩) with status := .failed } }
  /-- An edit takes the lease on a settled document, or over an expired lease, while no
  replacement is pending. -/
  | acquire (s : St) (d : Doc) (hd : s.doc = some d)
      (hok : settled d.status = true ∨ (d.status = .updating ∧ liveLease p d s.clock = false))
      (hrep : pendingReplacement p d s.clock = false) :
      Step v p s { s with doc := some { d with status := .updating, leaseAt := s.clock } }
  /-- An edit releases only the lease it took: `#s = :updating AND updatedAt = :heldSince`. -/
  | release (s : St) (d : Doc) (held : Nat) (back : Status) (hd : s.doc = some d)
      (hu : d.status = .updating) (hh : d.leaseAt = held) (hb : settled back = true) :
      Step v p s { s with doc := some { d with status := back } }
  /-- Delete waits for a live lease; reset and the cleanup adapter mark regardless. -/
  | markDeleting (s : St) (d : Doc) (hd : s.doc = some d) :
      Step v p s { s with doc := some { d with status := .deleting } }
  | remove (s : St) (d : Doc) (hd : s.doc = some d) (hdel : d.status = .deleting) :
      Step v p s { s with doc := none }
  /-- A re-upload reserves a settled document that has no unexpired reservation. -/
  | reserve (s : St) (d : Doc) (hd : s.doc = some d) (hs : settled d.status = true)
      (hfree : ∀ e, d.replacement = some e → e < s.clock) :
      Step v p s { s with doc := some { d with replacement := some (s.clock + p.ttl) } }
  /-- The replacement lands within its grace (later ones are reverted):
  `replacementToken = :token AND #s <> :deleting`. -/
  | finalize (s : St) (d : Doc) (e : Nat) (hd : s.doc = some d) (he : d.replacement = some e)
      (hnd : d.status ≠ .deleting) (hlate : s.clock ≤ e + p.grace) :
      Step v p s { s with doc := some { d with status := .uploaded, replacement := none } }
  /-- Reindex restarts a settled document, or one stuck processing for an hour (the hour
  is left out, so the step allows more than the code), once any replacement is past its
  grace. -/
  | reindex (s : St) (d : Doc) (hd : s.doc = some d)
      (hs : settled d.status = true ∨ processing d.status = true)
      (hrep : pendingReplacement p d s.clock = false) :
      Step v p s { s with doc := some { d with status := .queued } }

/-- A DELETING document only stays DELETING or disappears: no pipeline stage, edit,
upload or reindex brings it back. -/
theorem deleting_absorbing (p : Params) (s t : St) (d : Doc) (hd : s.doc = some d)
    (hdel : d.status = .deleting) (h : Step ⟨true⟩ p s t) :
    t.doc = none ∨ ∃ d', t.doc = some d' ∧ d'.status = .deleting := by
  cases h with
  | tick => exact Or.inr ⟨d, hd, hdel⟩
  | pipeline d' st hd' hst hnd => rw [hd] at hd'; cases hd'; exact absurd hdel hnd
  | ingestFailure old hold hguard =>
    obtain ⟨d', rfl, hnd⟩ := hguard rfl; rw [hd] at hold; cases hold; exact absurd hdel hnd
  | acquire d' hd' hok hrep =>
    rw [hd] at hd'; cases hd'
    rcases hok with h | ⟨h, _⟩ <;> simp [hdel, settled] at h
  | release d' held back hd' hu => rw [hd] at hd'; cases hd'; rw [hdel] at hu; cases hu
  | markDeleting d' hd' => exact Or.inr ⟨_, rfl, rfl⟩
  | remove => exact Or.inl rfl
  | reserve d' hd' hs => rw [hd] at hd'; cases hd'; simp [hdel, settled] at hs
  | finalize d' e hd' he hnd _ => rw [hd] at hd'; cases hd'; exact absurd hdel hnd
  | reindex d' hd' hs => rw [hd] at hd'; cases hd'; simp [hdel, settled, processing] at hs

/-- A deleted document stays deleted: no write recreates its row. -/
theorem no_resurrection (p : Params) (s t : St) (hd : s.doc = none) (h : Step ⟨true⟩ p s t) :
    t.doc = none := by
  cases h with
  | tick => exact hd
  | ingestFailure old hold hguard => obtain ⟨d', rfl, _⟩ := hguard rfl; rw [hd] at hold; cases hold
  | remove => rfl
  | _ => simp_all

/-- Before: the failure write upserted, so an upload event that raced a delete recreated
the row as an orphan FAILED document that nothing would clean up. -/
theorem old_failure_write_resurrects (p : Params) :
    ∃ t, Step ⟨false⟩ p { doc := none } t ∧ t.doc.isSome := by
  exact ⟨_, .ingestFailure { doc := none } none rfl (fun h => nomatch h), rfl⟩

inductive Reachable (v : Variant) (p : Params) : St → Prop
  | init (clock : Nat) : Reachable v p { doc := some { status := .uploaded }, clock := clock }
  | step (s t : St) : Reachable v p s → Step v p s t → Reachable v p t

/-- While an edit holds the lease, any reservation on the document had passed its grace
before the lease was taken. -/
def LeaseInv (p : Params) (s : St) : Prop :=
  ∀ d, s.doc = some d → d.status = .updating →
    d.leaseAt ≤ s.clock ∧ ∀ e, d.replacement = some e → e + p.grace < d.leaseAt

theorem leaseInv_step (p : Params) (s t : St) (hi : LeaseInv p s) (h : Step ⟨true⟩ p s t) :
    LeaseInv p t := by
  intro d' ht hu
  cases h with
  | tick =>
    obtain ⟨h1, h2⟩ := hi d' ht hu; exact ⟨by dsimp only; omega, h2⟩
  | pipeline d st hd hst hnd =>
    cases ht; simp only at hu; subst hu; simp [pipelineStatus] at hst
  | ingestFailure old _ _ => cases ht; cases hu
  | acquire d hd hok hrep =>
    cases ht; refine ⟨Nat.le_refl _, fun e he => ?_⟩
    simp only [pendingReplacement] at hrep; simp only at he; rw [he] at hrep
    simp at hrep; exact hrep
  | release d held back hd hu' hh hb =>
    cases ht; simp only at hu; subst hu; cases hb
  | markDeleting d hd => cases ht; cases hu
  | remove => cases ht
  | reserve d hd hs hfree =>
    cases ht; simp only at hu; rw [hu] at hs; cases hs
  | finalize d e hd he hnd hlate => cases ht; cases hu
  | reindex d hd hs hrep => cases ht; cases hu

theorem leaseInv_reachable (p : Params) (s : St) (h : Reachable ⟨true⟩ p s) : LeaseInv p s := by
  induction h with
  | init => intro d hd hu; cases hd; cases hu
  | step s t _ hst ih => exact leaseInv_step p s t ih hst

/-- No replacement lands under an edit: while a lease is held, the finalize step that
deletes the document's chunks and vectors is impossible. -/
theorem no_finalize_during_edit (p : Params) (s : St) (h : Reachable ⟨true⟩ p s) (d : Doc)
    (hd : s.doc = some d) (hu : d.status = .updating) (e : Nat) (he : d.replacement = some e) :
    ¬ s.clock ≤ e + p.grace := by
  obtain ⟨h1, h2⟩ := leaseInv_reachable p s h d hd hu
  have := h2 e he; omega

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/utils.ts", "ConditionExpression: \"attribute_exists(pk) AND #s <> :deleting\","),
   ("functions/s3/ingest-adapter.ts", ": \"attribute_exists(pk) AND #s <> :deleting\","),
   ("functions/admin/update.ts", "ConditionExpression: \"#s = :updating AND updatedAt = :heldSince\","),
   ("functions/s3/ingest-adapter.ts", "ConditionExpression: \"replacementToken = :token AND #s <> :deleting\","),
   ("functions/sweeper/index.ts", "\"attribute_exists(pk) AND NOT #s IN (:deleting, :embedded, :failed, :updating)\","),
   ("functions/admin/reindex.ts", "PROCESSING_STATUSES.has(status) &&")]

end Proofs.Lifecycle
