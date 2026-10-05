/-!
The upload caps in functions/admin/upload.ts under any interleaving of concurrent
uploads. Each upload reads the account's `uploadSeq`, counts the account's documents
(GSI2 plus `recentUploads`), and commits only while `uploadSeq` still holds the value it
read, moving it on. Pipeline progress, deletes, expiry and reindex run in between.

Assumptions, each a DynamoDB or timing fact rather than code:
* the commit transaction is atomic and its `uploadSeq = :seen` condition linearizable;
* the count sees every committed document (GSI2 lag stays under RECENT_UPLOAD_WINDOW_MS),
  so a count may only over-count, which is the 30 s deleted-document gap;
* a committed upload stays in flight until its bytes are counted or its form expires.
-/
namespace Proofs.UploadCaps

structure Caps where
  maxDocs : Nat
  maxInFlight : Nat
  maxStorage : Nat
  maxUpload : Nat

/-- The constants in functions/admin/upload.ts and functions/utils.ts. -/
def tsCaps : Caps :=
  { maxDocs := 1000, maxInFlight := 10, maxStorage := 1073741824, maxUpload := 52428800 }

/-- An upload request: idle, or holding the uploadSeq, counts and storage it read,
plus the pending uploads at that moment (a ghost for the storage bound). -/
inductive Pc
  | idle
  | counted (seen docs inFlight reindexes storage pending : Nat)

structure St where
  seq : Nat := 0
  docs : Nat := 0
  inFlight : Nat := 0
  /-- Committed uploads whose bytes S3 has not reported yet. -/
  pending : Nat := 0
  storage : Nat := 0
  reindexes : Nat := 0
  procs : Nat → Pc := fun _ => .idle

def St.set (s : St) (p : Nat) (pc : Pc) : St :=
  { s with procs := fun q => if q = p then pc else s.procs q }

/-- A commit moves uploadSeq and adds one pending in-flight upload; a new document also
adds one document. -/
def afterCommit (s : St) (newDocs : Nat) : St :=
  { s with seq := s.seq + 1, docs := s.docs + newDocs, inFlight := s.inFlight + 1,
           pending := s.pending + 1 }

def removeInFlight (s : St) (x : Nat) : St :=
  { s with docs := s.docs - 1, inFlight := s.inFlight - 1, storage := s.storage - x }

/-- One step of any upload request or background process. `checkSeq := false` is the
protocol without the uploadSeq condition, kept to show the condition is needed. -/
inductive Step (c : Caps) (checkSeq : Bool) : St → St → Prop
  /-- Read uploadSeq, storage and the counts in one consistent read; counts may be high. -/
  | read (s : St) (p docs inFlight : Nat) (h : s.procs p = .idle)
      (hd : s.docs ≤ docs) (hf : s.inFlight ≤ inFlight) :
      Step c checkSeq s (s.set p (.counted s.seq docs inFlight s.reindexes s.storage s.pending))
  | commitNew (s : St) (p seen d f r v pr : Nat) (h : s.procs p = .counted seen d f r v pr)
      (hseq : checkSeq = true → seen = s.seq) (hd : d < c.maxDocs) (hf : f < c.maxInFlight)
      (hv : v < c.maxStorage) :
      Step c checkSeq s (afterCommit (s.set p .idle) 1)
  | commitReplace (s : St) (p seen d f r v pr : Nat) (h : s.procs p = .counted seen d f r v pr)
      (hseq : checkSeq = true → seen = s.seq) (hf : f < c.maxInFlight) (hv : v < c.maxStorage)
      (hsettled : s.inFlight < s.docs) :
      Step c checkSeq s (afterCommit (s.set p .idle) 0)
  /-- A refused or busy request returns; a busy one may read again. -/
  | giveUp (s : St) (p : Nat) : Step c checkSeq s (s.set p .idle)
  | ingest (s : St) (b : Nat) (hp : 0 < s.pending) (hb : b ≤ c.maxUpload) :
      Step c checkSeq s { s with pending := s.pending - 1, storage := s.storage + b }
  | expire (s : St) (hp : 0 < s.pending) :
      Step c checkSeq s { s with pending := s.pending - 1, inFlight := s.inFlight - 1 }
  | settle (s : St) (h : s.pending < s.inFlight) :
      Step c checkSeq s { s with inFlight := s.inFlight - 1 }
  | deleteSettled (s : St) (x : Nat) (h : s.inFlight < s.docs) :
      Step c checkSeq s { s with docs := s.docs - 1, storage := s.storage - x }
  | deleteInFlight (s : St) (x : Nat) (h : s.pending < s.inFlight) :
      Step c checkSeq s (removeInFlight s x)
  /-- Reindex makes a settled document busy again without taking the in-flight cap. -/
  | reindex (s : St) (h : s.inFlight < s.docs) :
      Step c checkSeq s { s with inFlight := s.inFlight + 1, reindexes := s.reindexes + 1 }

inductive Reachable (c : Caps) (checkSeq : Bool) : St → Prop
  | init : Reachable c checkSeq {}
  | step (s t : St) : Reachable c checkSeq s → Step c checkSeq s t → Reachable c checkSeq t

def ProcInv (c : Caps) (s : St) : Pc → Prop
  | .idle => True
  | .counted seen d f r v pr => seen ≤ s.seq ∧ r ≤ s.reindexes ∧ pr ≤ f ∧
      (seen = s.seq → s.docs ≤ d ∧ s.inFlight + r ≤ f + s.reindexes ∧
        s.storage + c.maxUpload * s.pending ≤ v + c.maxUpload * pr)

structure Inv (c : Caps) (s : St) : Prop where
  docs : s.docs ≤ c.maxDocs
  inFlightDocs : s.inFlight ≤ s.docs
  pendingInFlight : s.pending ≤ s.inFlight
  inFlight : s.inFlight ≤ c.maxInFlight + s.reindexes
  storage : s.storage + c.maxUpload * s.pending + 1 ≤ c.maxStorage + c.maxUpload * c.maxInFlight
  procs : ∀ p, ProcInv c s (s.procs p)

theorem set_procs (s : St) (p q : Nat) (pc : Pc) :
    (s.set p pc).procs q = if q = p then pc else s.procs q := rfl

@[simp] theorem set_seq (s : St) p pc : (s.set p pc).seq = s.seq := rfl
@[simp] theorem set_docs (s : St) p pc : (s.set p pc).docs = s.docs := rfl
@[simp] theorem set_inFlight (s : St) p pc : (s.set p pc).inFlight = s.inFlight := rfl
@[simp] theorem set_pending (s : St) p pc : (s.set p pc).pending = s.pending := rfl
@[simp] theorem set_storage (s : St) p pc : (s.set p pc).storage = s.storage := rfl
@[simp] theorem set_reindexes (s : St) p pc : (s.set p pc).reindexes = s.reindexes := rfl

theorem inv_step (c : Caps) (s t : St) (hi : Inv c s)
    (hstep : Step c true s t) : Inv c t := by
  obtain ⟨h1, h2, h3, h4, h5, h6⟩ := hi
  cases hstep with
  | read p d f hp hd hf =>
    refine ⟨h1, h2, h3, h4, h5, fun q => ?_⟩
    simp only [set_procs]; split
    · simp only [ProcInv, set_seq, set_docs, set_inFlight, set_pending, set_storage, set_reindexes]
      omega
    · exact h6 q
  | commitNew p seen d f r v pr hp hseq hd hf hv =>
    have hpi := h6 p; rw [hp] at hpi; simp only [ProcInv] at hpi
    have := hseq rfl; obtain ⟨_, _, hpr, hcur⟩ := hpi; obtain ⟨hcd, hcf, hcs⟩ := hcur this
    refine ⟨by simp [afterCommit]; omega, by simp [afterCommit]; omega, by simp [afterCommit]; omega,
      by simp [afterCommit]; omega, ?_, fun q => ?_⟩
    · have hpr' : c.maxUpload * pr + c.maxUpload ≤ c.maxUpload * c.maxInFlight := by
        rw [← Nat.mul_succ]; exact Nat.mul_le_mul_left _ (by omega)
      simp only [afterCommit, set_storage, set_pending, Nat.mul_succ]; omega
    · simp only [afterCommit, set_procs]; split
      · trivial
      · have hq := h6 q
        revert hq; cases s.procs q with
        | idle => intro; trivial
        | counted seen' d' f' r' v' pr' =>
          simp only [ProcInv, set_seq, set_docs, set_inFlight, set_pending, set_storage,
            set_reindexes]
          intro hq; refine ⟨by omega, hq.2.1, hq.2.2.1, fun h => by omega⟩
  | commitReplace p seen d f r v pr hp hseq hf hv hset =>
    have hpi := h6 p; rw [hp] at hpi; simp only [ProcInv] at hpi
    have := hseq rfl; obtain ⟨_, _, hpr, hcur⟩ := hpi; obtain ⟨_, hcf, hcs⟩ := hcur this
    refine ⟨by simp [afterCommit]; omega, by simp [afterCommit]; omega, by simp [afterCommit]; omega,
      by simp [afterCommit]; omega, ?_, fun q => ?_⟩
    · have hpr' : c.maxUpload * pr + c.maxUpload ≤ c.maxUpload * c.maxInFlight := by
        rw [← Nat.mul_succ]; exact Nat.mul_le_mul_left _ (by omega)
      simp only [afterCommit, set_storage, set_pending, Nat.mul_succ]; omega
    · simp only [afterCommit, set_procs]; split
      · trivial
      · have hq := h6 q
        revert hq; cases s.procs q with
        | idle => intro; trivial
        | counted seen' d' f' r' v' pr' =>
          simp only [ProcInv, set_seq, set_docs, set_inFlight, set_pending, set_storage,
            set_reindexes]
          intro hq; refine ⟨by omega, hq.2.1, hq.2.2.1, fun h => by omega⟩
  | giveUp p =>
    refine ⟨h1, h2, h3, h4, h5, fun q => ?_⟩
    simp only [set_procs]; split
    · trivial
    · exact h6 q
  | ingest b hp hb =>
    have hmul : c.maxUpload * s.pending = c.maxUpload * (s.pending - 1) + c.maxUpload := by
      rw [← Nat.mul_succ]; congr 1; omega
    have hb' : b ≤ c.maxUpload := hb
    refine ⟨h1, h2, by simp; omega, h4, by simp; omega, fun q => ?_⟩
    have hq := h6 q; revert hq
    cases s.procs q with
    | idle => intro; trivial
    | counted seen d f r v pr => simp only [ProcInv]; intro hq; exact ⟨hq.1, hq.2.1, hq.2.2.1, fun h => by
        have := hq.2.2.2 h; omega⟩
  | expire hp =>
    have hmul : c.maxUpload * s.pending = c.maxUpload * (s.pending - 1) + c.maxUpload := by
      rw [← Nat.mul_succ]; congr 1; omega
    refine ⟨h1, by simp; omega, by simp; omega, by simp; omega, by simp; omega, fun q => ?_⟩
    have hq := h6 q; revert hq
    cases s.procs q with
    | idle => intro; trivial
    | counted seen d f r v pr => simp only [ProcInv]; intro hq; exact ⟨hq.1, hq.2.1, hq.2.2.1, fun h => by
        have := hq.2.2.2 h; omega⟩
  | settle h =>
    refine ⟨h1, by simp; omega, by simp; omega, by simp; omega, h5, fun q => ?_⟩
    have hq := h6 q; revert hq
    cases s.procs q with
    | idle => intro; trivial
    | counted seen d f r v pr => simp only [ProcInv]; intro hq; exact ⟨hq.1, hq.2.1, hq.2.2.1, fun h => by
        have := hq.2.2.2 h; omega⟩
  | deleteSettled x h =>
    refine ⟨by simp; omega, by simp; omega, h3, h4, by simp; omega, fun q => ?_⟩
    have hq := h6 q; revert hq
    cases s.procs q with
    | idle => intro; trivial
    | counted seen d f r v pr => simp only [ProcInv]; intro hq; exact ⟨hq.1, hq.2.1, hq.2.2.1, fun h => by
        have := hq.2.2.2 h; omega⟩
  | deleteInFlight x h =>
    simp only [removeInFlight]
    refine ⟨by simp; omega, by simp; omega, by simp; omega, by simp; omega, by simp; omega, fun q => ?_⟩
    have hq := h6 q; revert hq
    cases s.procs q with
    | idle => intro; trivial
    | counted seen d f r v pr => simp only [ProcInv]; intro hq; exact ⟨hq.1, hq.2.1, hq.2.2.1, fun h => by
        have := hq.2.2.2 h; omega⟩
  | reindex h =>
    refine ⟨h1, by simp; omega, by simp; omega, by simp; omega, h5, fun q => ?_⟩
    have hq := h6 q; revert hq
    cases s.procs q with
    | idle => intro; trivial
    | counted seen d f r v pr => simp only [ProcInv]; intro hq; exact ⟨hq.1, by omega, hq.2.2.1, fun h => by
        have := hq.2.2.2 h; omega⟩

theorem inv_reachable (c : Caps) (hs : 0 < c.maxStorage) (s : St) (h : Reachable c true s) :
    Inv c s := by
  induction h with
  | init => exact ⟨by simp, by simp, by simp, by simp, by simp; omega, fun _ => trivial⟩
  | step s t _ hst ih => exact inv_step c s t ih hst

/-- No interleaving of uploads takes an account past the document cap. -/
theorem docs_le_cap (c : Caps) (hs : 0 < c.maxStorage) (s : St) (h : Reachable c true s) :
    s.docs ≤ c.maxDocs :=
  (inv_reachable c hs s h).docs

/-- Uploads never take the account past the in-flight cap; only reindexes, which the
cap does not cover by design, add documents beyond it. -/
theorem inFlight_le_cap (c : Caps) (hs : 0 < c.maxStorage) (s : St) (h : Reachable c true s) :
    s.inFlight ≤ c.maxInFlight + s.reindexes :=
  (inv_reachable c hs s h).inFlight

/-- Storage is checked when the form is issued and counted when the file lands, so it
can overshoot, but only by the in-flight uploads: at most maxInFlight × maxUpload. -/
theorem storage_overshoot (c : Caps) (hs : 0 < c.maxStorage) (s : St) (h : Reachable c true s) :
    s.storage < c.maxStorage + c.maxUpload * c.maxInFlight := by
  have := (inv_reachable c hs s h).storage; omega

/-- With the shipped constants: at most 1,000 documents, and storage under 1.5 GB. -/
theorem ts_caps (s : St) (h : Reachable tsCaps true s) :
    s.docs ≤ 1000 ∧ s.inFlight ≤ 10 + s.reindexes ∧ s.storage < 1073741824 + 524288000 :=
  ⟨docs_le_cap tsCaps (by decide) s h, inFlight_le_cap tsCaps (by decide) s h,
    storage_overshoot tsCaps (by decide) s h⟩

/-- Without the uploadSeq condition two uploads that counted the same state both commit,
so the cap breaks: the condition is necessary, not defensive. -/
theorem without_seq_cap_breaks :
    ∃ s, Reachable { tsCaps with maxDocs := 1 } false s ∧ s.docs = 2 := by
  let c : Caps := { tsCaps with maxDocs := 1 }
  let s0 : St := {}
  let s1 := s0.set 0 (.counted 0 0 0 0 0 0)
  let s2 := s1.set 1 (.counted 0 0 0 0 0 0)
  let s3 := afterCommit (s2.set 0 .idle) 1
  let s4 := afterCommit (s3.set 1 .idle) 1
  refine ⟨s4, ?_, rfl⟩
  have r1 : Reachable c false s1 := .step _ _ .init (.read s0 0 0 0 rfl (Nat.le_refl _) (Nat.le_refl _))
  have r2 : Reachable c false s2 := .step _ _ r1 (.read s1 1 0 0 rfl (Nat.le_refl _) (Nat.le_refl _))
  have r3 : Reachable c false s3 := .step _ _ r2
    (Step.commitNew (c := c) (checkSeq := false) s2 0 0 0 0 0 0 0 rfl (fun h => nomatch h)
      (by decide) (by decide) (by decide))
  exact .step _ _ r3
    (Step.commitNew (c := c) (checkSeq := false) s3 1 0 0 0 0 0 0 rfl (fun h => nomatch h)
      (by decide) (by decide) (by decide))

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/admin/upload.ts", "const MAX_DOCUMENTS = 1000;"),
   ("functions/admin/upload.ts", "const MAX_IN_FLIGHT_DOCUMENTS = 10;"),
   ("functions/admin/upload.ts", "process.env.MAX_STORAGE_BYTES ?? \"1073741824\","),
   ("functions/utils.ts", "process.env.MAX_UPLOAD_BYTES ?? \"52428800\","),
   ("functions/admin/upload.ts", "\"attribute_not_exists(uploadSeq) OR uploadSeq = :seen\","),
   ("functions/admin/upload.ts", "ProjectionExpression: \"uploadSeq, recentUploads, storageBytes\",")]

end Proofs.UploadCaps
