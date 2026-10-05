/-!
The upload caps in functions/admin/upload.ts under any interleaving of concurrent
uploads. Each upload reads the account's `uploadSeq` and storage, counts the account's
documents (GSI2 plus `recentUploads`), and commits only while `uploadSeq` still holds the
value it read, moving it on. Pipeline progress, deletes, expiry, reindex and overwrites
through a still-valid upload form run in between.

Assumptions, each a DynamoDB or timing fact rather than code:
* the commit transaction is atomic and its `uploadSeq = :seen` condition linearizable;
* the count sees every committed document (GSI2 lag stays under RECENT_UPLOAD_WINDOW_MS),
  so a count may only over-count, which is the 30 s deleted-document gap;
* a committed upload's file is charged without the cap only while `isDocumentInFlight`
  still counts it for this invocation's full 60 s; the ingest adapter holds a later one to
  the cap. A replacement counts until its late grace ends and is reverted a minute before.
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
  /-- Committed uploads whose first file S3 has not reported yet. -/
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

/-- The shipped protocol checks uploadSeq at commit and holds overwrites to the cap; the
variants without either check show each one is needed. -/
structure Variant where
  checkSeq : Bool
  capOverwrite : Bool

def fixed : Variant := ⟨true, true⟩

/-- One step of any upload request or background process. -/
inductive Step (c : Caps) (var : Variant) : St → St → Prop
  /-- Read uploadSeq, storage and the counts in one consistent read; counts may be high. -/
  | read (s : St) (p docs inFlight : Nat) (h : s.procs p = .idle)
      (hd : s.docs ≤ docs) (hf : s.inFlight ≤ inFlight) :
      Step c var s (s.set p (.counted s.seq docs inFlight s.reindexes s.storage s.pending))
  | commitNew (s : St) (p seen d f r v pr : Nat) (h : s.procs p = .counted seen d f r v pr)
      (hseq : var.checkSeq = true → seen = s.seq) (hd : d < c.maxDocs) (hf : f < c.maxInFlight)
      (hv : v < c.maxStorage) :
      Step c var s (afterCommit (s.set p .idle) 1)
  | commitReplace (s : St) (p seen d f r v pr : Nat) (h : s.procs p = .counted seen d f r v pr)
      (hseq : var.checkSeq = true → seen = s.seq) (hf : f < c.maxInFlight) (hv : v < c.maxStorage)
      (hsettled : s.inFlight < s.docs) :
      Step c var s (afterCommit (s.set p .idle) 0)
  /-- A refused or busy request returns; a busy one may read again. -/
  | giveUp (s : St) (p : Nat) : Step c var s (s.set p .idle)
  /-- The first file of a committed upload lands and is charged. -/
  | ingest (s : St) (b : Nat) (hp : 0 < s.pending) (hb : b ≤ c.maxUpload) :
      Step c var s { s with pending := s.pending - 1, storage := s.storage + b }
  | expire (s : St) (hp : 0 < s.pending) :
      Step c var s { s with pending := s.pending - 1, inFlight := s.inFlight - 1 }
  /-- A still-valid form overwrites a counted source with a larger file; the recount
  charges it only while the total stays within the cap, and removes it otherwise. -/
  | overwrite (s : St) (x : Nat) (h : var.capOverwrite = true → s.storage + x ≤ c.maxStorage) :
      Step c var s { s with storage := s.storage + x }
  /-- A first file that lands after its upload stopped counting in flight (a POST started
  just before its form expired) is charged under the same cap as an overwrite. -/
  | lateFirstFile (s : St) (b : Nat) (h : var.capOverwrite = true → s.storage + b ≤ c.maxStorage) :
      Step c var s { s with storage := s.storage + b }
  /-- A smaller overwrite, a delete's refund or a reset lowers storage. -/
  | shrink (s : St) (x : Nat) : Step c var s { s with storage := s.storage - x }
  | settle (s : St) (h : s.pending < s.inFlight) :
      Step c var s { s with inFlight := s.inFlight - 1 }
  | deleteSettled (s : St) (x : Nat) (h : s.inFlight < s.docs) :
      Step c var s { s with docs := s.docs - 1, storage := s.storage - x }
  | deleteInFlight (s : St) (x : Nat) (h : s.pending < s.inFlight) :
      Step c var s (removeInFlight s x)
  /-- Reindex makes a settled document busy again without taking the in-flight cap. A stuck
  document it restarts is already in flight, so that changes no count. -/
  | reindex (s : St) (h : s.inFlight < s.docs) :
      Step c var s { s with inFlight := s.inFlight + 1, reindexes := s.reindexes + 1 }

inductive Reachable (c : Caps) (var : Variant) : St → Prop
  | init : Reachable c var {}
  | step (s t : St) : Reachable c var s → Step c var s t → Reachable c var t

/-- What a request's read still guarantees while uploadSeq has not moved. Storage is
tracked as its excess over the cap, which only first files of pending uploads create. -/
def ProcInv (c : Caps) (s : St) : Pc → Prop
  | .idle => True
  | .counted seen d f r v pr => seen ≤ s.seq ∧ r ≤ s.reindexes ∧ pr ≤ f ∧
      (seen = s.seq → s.docs ≤ d ∧ s.inFlight + r ≤ f + s.reindexes ∧ s.pending ≤ pr ∧
        (v < c.maxStorage → (s.storage - c.maxStorage) + c.maxUpload * s.pending ≤ c.maxUpload * pr))

structure Inv (c : Caps) (s : St) : Prop where
  docs : s.docs ≤ c.maxDocs
  inFlightDocs : s.inFlight ≤ s.docs
  pendingInFlight : s.pending ≤ s.inFlight
  pendingLe : s.pending ≤ c.maxInFlight
  inFlight : s.inFlight ≤ c.maxInFlight + s.reindexes
  storage : (s.storage - c.maxStorage) + c.maxUpload * s.pending ≤ c.maxUpload * c.maxInFlight
  procs : ∀ p, ProcInv c s (s.procs p)

theorem set_procs (s : St) (p q : Nat) (pc : Pc) :
    (s.set p pc).procs q = if q = p then pc else s.procs q := rfl

@[simp] theorem set_seq (s : St) p pc : (s.set p pc).seq = s.seq := rfl
@[simp] theorem set_docs (s : St) p pc : (s.set p pc).docs = s.docs := rfl
@[simp] theorem set_inFlight (s : St) p pc : (s.set p pc).inFlight = s.inFlight := rfl
@[simp] theorem set_pending (s : St) p pc : (s.set p pc).pending = s.pending := rfl
@[simp] theorem set_storage (s : St) p pc : (s.set p pc).storage = s.storage := rfl
@[simp] theorem set_reindexes (s : St) p pc : (s.set p pc).reindexes = s.reindexes := rfl

theorem mul_pred (u n : Nat) (h : 0 < n) : u * n = u * (n - 1) + u := by
  rw [← Nat.mul_succ]; congr 1; omega

/-- Another request's read survives a step that keeps uploadSeq, moves storage within the
excess bound and only lowers the documents, in-flight count and pending uploads. -/
theorem procInv_keep (c : Caps) (s t : St) (pc : Pc) (h : ProcInv c s pc)
    (hseq : t.seq = s.seq) (hdocs : t.docs ≤ s.docs) (hrei : s.reindexes ≤ t.reindexes)
    (hfl : t.inFlight + s.reindexes ≤ s.inFlight + t.reindexes) (hpend : t.pending ≤ s.pending)
    (hstor : (t.storage - c.maxStorage) + c.maxUpload * t.pending ≤
      (s.storage - c.maxStorage) + c.maxUpload * s.pending) :
    ProcInv c t pc := by
  cases pc with
  | idle => trivial
  | counted seen d f r v pr =>
    obtain ⟨h1, h2, h3, h4⟩ := h
    refine ⟨by omega, by omega, h3, fun he => ?_⟩
    obtain ⟨g1, g2, g3, g4⟩ := h4 (by omega)
    exact ⟨by omega, by omega, by omega, fun hv => by have := g4 hv; omega⟩

theorem inv_step (c : Caps) (s t : St) (hi : Inv c s)
    (hstep : Step c fixed s t) : Inv c t := by
  obtain ⟨h1, h2, h3, h3', h4, h5, h6⟩ := hi
  cases hstep with
  | read p d f hp hd hf =>
    refine ⟨h1, h2, h3, h3', h4, h5, fun q => ?_⟩
    simp only [set_procs]; split
    · simp only [ProcInv, set_seq, set_docs, set_inFlight, set_pending, set_storage, set_reindexes]
      refine ⟨Nat.le_refl _, Nat.le_refl _, by omega, fun _ => ⟨hd, by omega, Nat.le_refl _, fun hv => ?_⟩⟩
      omega
    · exact h6 q
  | commitNew p seen d f r v pr hp hseq hd hf hv =>
    have hpi := h6 p; rw [hp] at hpi; simp only [ProcInv] at hpi
    obtain ⟨_, _, hpr, hcur⟩ := hpi; obtain ⟨hcd, hcf, hcp, hcs⟩ := hcur (hseq rfl)
    have hcs := hcs hv
    have hU : c.maxUpload * pr + c.maxUpload ≤ c.maxUpload * c.maxInFlight := by
      rw [← Nat.mul_succ]; exact Nat.mul_le_mul_left _ (by omega)
    refine ⟨by simp [afterCommit]; omega, by simp [afterCommit]; omega, by simp [afterCommit]; omega,
      by simp [afterCommit]; omega, by simp [afterCommit]; omega, ?_, fun q => ?_⟩
    · simp only [afterCommit, set_storage, set_pending, Nat.mul_succ]; omega
    · simp only [afterCommit, set_procs]; split
      · trivial
      · have hq := h6 q
        revert hq; cases s.procs q with
        | idle => intro; trivial
        | counted seen' d' f' r' v' pr' =>
          simp only [ProcInv, set_seq, set_docs, set_inFlight, set_pending, set_storage, set_reindexes]
          intro hq; exact ⟨by omega, hq.2.1, hq.2.2.1, fun h => by omega⟩
  | commitReplace p seen d f r v pr hp hseq hf hv hset =>
    have hpi := h6 p; rw [hp] at hpi; simp only [ProcInv] at hpi
    obtain ⟨_, _, hpr, hcur⟩ := hpi; obtain ⟨_, hcf, hcp, hcs⟩ := hcur (hseq rfl)
    have hcs := hcs hv
    have hU : c.maxUpload * pr + c.maxUpload ≤ c.maxUpload * c.maxInFlight := by
      rw [← Nat.mul_succ]; exact Nat.mul_le_mul_left _ (by omega)
    refine ⟨by simp [afterCommit]; omega, by simp [afterCommit]; omega, by simp [afterCommit]; omega,
      by simp [afterCommit]; omega, by simp [afterCommit]; omega, ?_, fun q => ?_⟩
    · simp only [afterCommit, set_storage, set_pending, Nat.mul_succ]; omega
    · simp only [afterCommit, set_procs]; split
      · trivial
      · have hq := h6 q
        revert hq; cases s.procs q with
        | idle => intro; trivial
        | counted seen' d' f' r' v' pr' =>
          simp only [ProcInv, set_seq, set_docs, set_inFlight, set_pending, set_storage, set_reindexes]
          intro hq; exact ⟨by omega, hq.2.1, hq.2.2.1, fun h => by omega⟩
  | giveUp p =>
    refine ⟨h1, h2, h3, h3', h4, h5, fun q => ?_⟩
    simp only [set_procs]; split
    · trivial
    · exact h6 q
  | ingest b hp hb =>
    have hmul := mul_pred c.maxUpload s.pending hp
    have hb' : b ≤ c.maxUpload := hb
    have hstor : (s.storage + b - c.maxStorage) + c.maxUpload * (s.pending - 1) ≤
        (s.storage - c.maxStorage) + c.maxUpload * s.pending := by omega
    refine ⟨h1, h2, by simp; omega, by simp; omega, h4, by simp only; omega, fun q => ?_⟩
    exact procInv_keep c s _ _ (h6 q) rfl (Nat.le_refl _) (Nat.le_refl _) (by simp)
      (by simp only; omega) hstor
  | expire hp =>
    have hmul := mul_pred c.maxUpload s.pending hp
    refine ⟨h1, by simp; omega, by simp; omega, by simp; omega, by simp; omega, by simp only; omega,
      fun q => procInv_keep c s _ _ (h6 q) rfl (Nat.le_refl _) (Nat.le_refl _) (by simp only; omega)
        (by simp only; omega) (by simp only; omega)⟩
  | overwrite x hx =>
    have hx := hx rfl
    refine ⟨h1, h2, h3, h3', h4, by simp only; omega, fun q => procInv_keep c s _ _ (h6 q) rfl
      (Nat.le_refl _) (Nat.le_refl _) (by simp) (Nat.le_refl _) (by simp only; omega)⟩
  | lateFirstFile b hb =>
    have hb := hb rfl
    refine ⟨h1, h2, h3, h3', h4, by simp only; omega, fun q => procInv_keep c s _ _ (h6 q) rfl
      (Nat.le_refl _) (Nat.le_refl _) (by simp) (Nat.le_refl _) (by simp only; omega)⟩
  | shrink x =>
    refine ⟨h1, h2, h3, h3', h4, by simp only; omega, fun q => procInv_keep c s _ _ (h6 q) rfl
      (Nat.le_refl _) (Nat.le_refl _) (by simp) (Nat.le_refl _) (by simp only; omega)⟩
  | settle h =>
    refine ⟨h1, by simp; omega, by simp; omega, h3', by simp; omega, h5, fun q => procInv_keep c s _ _
      (h6 q) rfl (Nat.le_refl _) (Nat.le_refl _) (by simp only; omega) (Nat.le_refl _) (Nat.le_refl _)⟩
  | deleteSettled x h =>
    refine ⟨by simp; omega, by simp; omega, h3, h3', h4, by simp only; omega, fun q => procInv_keep c s _ _
      (h6 q) rfl (by simp only; omega) (Nat.le_refl _) (by simp) (Nat.le_refl _) (by simp only; omega)⟩
  | deleteInFlight x h =>
    refine ⟨by simp [removeInFlight]; omega, by simp [removeInFlight]; omega,
      by simp [removeInFlight]; omega, h3', by simp [removeInFlight]; omega,
      by simp only [removeInFlight]; omega, fun q => procInv_keep c s _ _ (h6 q) rfl
      (by simp only [removeInFlight]; omega) (Nat.le_refl _) (by simp only [removeInFlight]; omega)
      (Nat.le_refl _) (by simp only [removeInFlight]; omega)⟩
  | reindex h =>
    refine ⟨h1, by simp; omega, by simp; omega, h3', by simp; omega, h5, fun q => procInv_keep c s _ _
      (h6 q) rfl (Nat.le_refl _) (by simp) (by simp only; omega) (Nat.le_refl _) (Nat.le_refl _)⟩

theorem inv_reachable (c : Caps) (s : St) (h : Reachable c fixed s) : Inv c s := by
  induction h with
  | init => exact ⟨by simp, by simp, by simp, by simp, by simp, by simp, fun _ => trivial⟩
  | step s t _ hst ih => exact inv_step c s t ih hst

/-- No interleaving of uploads takes an account past the document cap. -/
theorem docs_le_cap (c : Caps) (s : St) (h : Reachable c fixed s) : s.docs ≤ c.maxDocs :=
  (inv_reachable c s h).docs

/-- Uploads never take the account past the in-flight cap; only reindexes, which the
cap does not cover by design, add documents beyond it. -/
theorem inFlight_le_cap (c : Caps) (s : St) (h : Reachable c fixed s) :
    s.inFlight ≤ c.maxInFlight + s.reindexes :=
  (inv_reachable c s h).inFlight

/-- Storage is checked when the form is issued and counted when the file lands, so it
can overshoot, but only by first files of in-flight uploads: at most maxInFlight ×
maxUpload, however often still-valid forms are re-posted. -/
theorem storage_overshoot (c : Caps) (s : St) (h : Reachable c fixed s) :
    s.storage ≤ c.maxStorage + c.maxUpload * c.maxInFlight := by
  have := (inv_reachable c s h).storage; omega

/-- With the shipped constants: at most 1,000 documents, and storage at most 1.5 GiB. -/
theorem ts_caps (s : St) (h : Reachable tsCaps fixed s) :
    s.docs ≤ 1000 ∧ s.inFlight ≤ 10 + s.reindexes ∧ s.storage ≤ 1073741824 + 524288000 :=
  ⟨docs_le_cap tsCaps s h, inFlight_le_cap tsCaps s h, storage_overshoot tsCaps s h⟩

/-- Without the uploadSeq condition two uploads that counted the same state both commit,
so the cap breaks: the condition is necessary, not defensive. -/
theorem without_seq_cap_breaks :
    ∃ s, Reachable { tsCaps with maxDocs := 1 } ⟨false, true⟩ s ∧ s.docs = 2 := by
  let c : Caps := { tsCaps with maxDocs := 1 }
  let s0 : St := {}
  let s1 := s0.set 0 (.counted 0 0 0 0 0 0)
  let s2 := s1.set 1 (.counted 0 0 0 0 0 0)
  let s3 := afterCommit (s2.set 0 .idle) 1
  let s4 := afterCommit (s3.set 1 .idle) 1
  refine ⟨s4, ?_, rfl⟩
  have r1 : Reachable c ⟨false, true⟩ s1 := .step _ _ .init (.read s0 0 0 0 rfl (Nat.le_refl _) (Nat.le_refl _))
  have r2 : Reachable c ⟨false, true⟩ s2 := .step _ _ r1 (.read s1 1 0 0 rfl (Nat.le_refl _) (Nat.le_refl _))
  have r3 : Reachable c ⟨false, true⟩ s3 := .step _ _ r2
    (Step.commitNew (c := c) (var := ⟨false, true⟩) s2 0 0 0 0 0 0 0 rfl (fun h => nomatch h)
      (by decide) (by decide) (by decide))
  exact .step _ _ r3
    (Step.commitNew (c := c) (var := ⟨false, true⟩) s3 1 0 0 0 0 0 0 rfl (fun h => nomatch h)
      (by decide) (by decide) (by decide))

/-- Without the recount's cap check, a settled document's still-valid form can be re-posted
with a larger file and every byte is charged, so storage passes the proved bound. -/
theorem uncapped_overwrite_breaks :
    ∃ s, Reachable ⟨1, 1, 1, 1⟩ ⟨true, false⟩ s ∧ 1 + 1 * 1 < s.storage :=
  ⟨_, .step _ _ .init (.overwrite {} 3 (fun h => nomatch h)), by decide⟩

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/admin/upload.ts", "const MAX_DOCUMENTS = 1000;"),
   ("functions/admin/upload.ts", "const MAX_IN_FLIGHT_DOCUMENTS = 10;"),
   ("functions/utils.ts", "process.env.MAX_STORAGE_BYTES ?? \"1073741824\","),
   ("functions/admin/upload.ts", "if (storageBytes >= MAX_STORAGE_BYTES) {"),
   ("functions/s3/ingest-adapter.ts", "capped ? MAX_STORAGE_BYTES : undefined,"),
   ("functions/s3/ingest-adapter.ts", "late ? MAX_STORAGE_BYTES : undefined,"),
   ("functions/s3/ingest-adapter.ts", "const late = !isDocumentInFlight(doc, Date.parse(now) + INVOCATION_MS);"),
   ("functions/s3/ingest-adapter.ts", "const INVOCATION_MS = 60 * 1000;"),
   ("functions/s3/ingest-adapter.ts", "if (expiresAt + LATE_REPLACEMENT_GRACE_MS < Date.parse(now) + INVOCATION_MS) {"),
   ("functions/utils.ts", "LATE_REPLACEMENT_GRACE_MS;\n  if (replacementEnd > nowMs) return true;"),
   ("functions/s3/ingest-adapter.ts", "await recountStorage(documentId, doc, key, eventId, true);"),
   ("functions/utils.ts", "storageBytes + deltaBytes > capBytes"),
   ("functions/admin/upload.ts", "Math.floor((Date.parse(now) + REPLACEMENT_TTL_MS - Date.now()) / 1000)"),
   ("functions/utils.ts", "process.env.MAX_UPLOAD_BYTES ?? \"52428800\","),
   ("functions/admin/upload.ts", "\"attribute_not_exists(uploadSeq) OR uploadSeq = :seen\","),
   ("functions/admin/upload.ts", "ProjectionExpression: \"uploadSeq, recentUploads, storageBytes\",")]

end Proofs.UploadCaps
