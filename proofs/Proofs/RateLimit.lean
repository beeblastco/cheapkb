/-!
`checkRateLimit` in functions/utils.ts: a token bucket per user and operation. A request
reads (tokens, lastRefill), refills by the hours since lastRefill, spends one token, and
writes back only if the row is unchanged since its read. Requests race freely.

TS refills `hours × refillPerHour` tokens, a fraction. Measured in millisecond ticks and in
units of 1/3,600,000 token, that is `ms × refillPerHour` units and a request costs
`unit = 3,600,000`, all whole numbers, so this model is exact; TS adds float rounding.
Assumption: DynamoDB conditional writes are atomic; clocks never run backwards.
-/
namespace Proofs.RateLimit

structure Bucket where
  tokens : Nat
  last : Nat
  deriving DecidableEq

structure St where
  bucket : Bucket
  /-- Requests allowed so far (a ghost counter). -/
  allowed : Nat := 0
  procs : Nat → Option (Bucket × Nat) := fun _ => none

/-- After this change the write is conditioned on the whole row it read. Before, it was
conditioned on lastRefill alone, which two writes in the same millisecond share. -/
structure Variant where
  wholeRow : Bool

def refilled (max refill : Nat) (b : Bucket) (now : Nat) : Nat :=
  min max (b.tokens + (now - b.last) * refill)

def St.set (s : St) (p : Nat) (x : Option (Bucket × Nat)) : St :=
  { s with procs := fun q => if q = p then x else s.procs q }

def rowMatches (v : Variant) (cur seen : Bucket) : Bool :=
  if v.wholeRow then cur == seen else cur.last == seen.last

/-- The conditional write: one token spent from the refilled bucket the request read. -/
def spent (max refill unit : Nat) (s : St) (b : Bucket) (now : Nat) : St :=
  { s with bucket := ⟨refilled max refill b now - unit, now⟩, allowed := s.allowed + 1 }

inductive Step (v : Variant) (max refill unit : Nat) : St → St → Prop
  /-- A request reads the row at time `now`, which is never before lastRefill. -/
  | read (s : St) (p now : Nat) (hidle : s.procs p = none) (hnow : s.bucket.last ≤ now) :
      Step v max refill unit s (s.set p (some (s.bucket, now)))
  /-- It spends a token computed from what it read, if the row still matches. -/
  | spend (s : St) (p : Nat) (b : Bucket) (now : Nat) (hp : s.procs p = some (b, now))
      (hm : rowMatches v s.bucket b = true) (hok : unit ≤ refilled max refill b now) :
      Step v max refill unit s (spent max refill unit (s.set p none) b now)
  /-- A refused, denied or failed request returns. -/
  | done (s : St) (p : Nat) : Step v max refill unit s (s.set p none)

inductive Reachable (v : Variant) (max refill unit : Nat) (t0 : Nat) : St → Prop
  | init (tokens : Nat) (h : tokens ≤ max) : Reachable v max refill unit t0 { bucket := ⟨tokens, t0⟩ }
  | step (s t : St) : Reachable v max refill unit t0 s → Step v max refill unit s t →
      Reachable v max refill unit t0 t

structure Inv (max refill unit t0 : Nat) (s : St) : Prop where
  budget : s.allowed * unit + s.bucket.tokens ≤ max + (s.bucket.last - t0) * refill
  tokensLe : s.bucket.tokens ≤ max
  lastGe : t0 ≤ s.bucket.last
  procs : ∀ p b now, s.procs p = some (b, now) → b.last ≤ now

theorem inv_step (max refill unit t0 : Nat) (s t : St) (hi : Inv max refill unit t0 s)
    (h : Step ⟨true⟩ max refill unit s t) : Inv max refill unit t0 t := by
  obtain ⟨h1, h2, h3, h4⟩ := hi
  cases h with
  | read p now hidle hnow =>
    refine ⟨h1, h2, h3, fun q b n hq => ?_⟩
    simp only [St.set] at hq; split at hq
    · cases hq; exact hnow
    · exact h4 q b n hq
  | spend p b now hp hm hok =>
    simp only [rowMatches, ite_true, beq_iff_eq] at hm
    subst hm
    have hn := h4 p _ _ hp
    have hmin : refilled max refill s.bucket now ≤ s.bucket.tokens + (now - s.bucket.last) * refill :=
      Nat.min_le_right _ _
    have hmax : refilled max refill s.bucket now ≤ max := Nat.min_le_left _ _
    have hsplit : (now - t0) * refill = (s.bucket.last - t0) * refill + (now - s.bucket.last) * refill := by
      rw [← Nat.add_mul]; congr 1; omega
    refine ⟨?_, ?_, ?_, fun q b' n hq => ?_⟩
    · show (s.allowed + 1) * unit + (refilled max refill s.bucket now - unit) ≤ max + (now - t0) * refill
      rw [Nat.succ_mul]; omega
    · show refilled max refill s.bucket now - unit ≤ max; omega
    · show t0 ≤ now; omega
    · simp only [spent, St.set] at hq; split at hq
      · cases hq
      · exact h4 q b' n hq
  | done p =>
    refine ⟨h1, h2, h3, fun q b n hq => ?_⟩
    simp only [St.set] at hq; split at hq
    · cases hq
    · exact h4 q b n hq

theorem inv_reachable (max refill unit t0 : Nat) (s : St) (h : Reachable ⟨true⟩ max refill unit t0 s) :
    Inv max refill unit t0 s := by
  induction h with
  | init tokens ht => exact ⟨by simp; omega, ht, Nat.le_refl _, fun _ _ _ h => nomatch h⟩
  | step s t _ hst ih => exact inv_step max refill unit t0 s t ih hst

/-- However requests interleave, the bucket admits at most its size plus what it refilled
since it was created: no token is spent twice. With max = 50 tokens and refillPerHour = 50,
that is at most 50 + 50 per hour requests. -/
theorem allowed_le_budget (max refill unit t0 : Nat) (s : St)
    (h : Reachable ⟨true⟩ max refill unit t0 s) :
    s.allowed * unit ≤ max + (s.bucket.last - t0) * refill := by
  have := (inv_reachable max refill unit t0 s h).budget; omega

/-- Before: two requests that read the row in the same millisecond as the last write could
both pass the lastRefill check and spend the same token. -/
theorem old_check_double_spends :
    ∃ s, Reachable ⟨false⟩ 1 0 1 0 s ∧ s.allowed = 2 := by
  let s0 : St := { bucket := ⟨1, 0⟩ }
  let s1 := s0.set 0 (some (⟨1, 0⟩, 0))
  let s2 := s1.set 1 (some (⟨1, 0⟩, 0))
  let s3 := spent 1 0 1 (s2.set 0 none) ⟨1, 0⟩ 0
  let s4 := spent 1 0 1 (s3.set 1 none) ⟨1, 0⟩ 0
  refine ⟨s4, ?_, rfl⟩
  have r0 : Reachable ⟨false⟩ 1 0 1 0 s0 := .init 1 (Nat.le_refl _)
  have r1 : Reachable ⟨false⟩ 1 0 1 0 s1 := .step _ _ r0 (.read s0 0 0 rfl (Nat.le_refl _))
  have r2 : Reachable ⟨false⟩ 1 0 1 0 s2 := .step _ _ r1 (.read s1 1 0 rfl (Nat.le_refl _))
  have r3 : Reachable ⟨false⟩ 1 0 1 0 s3 := .step _ _ r2 (.spend s2 0 ⟨1, 0⟩ 0 rfl rfl (by decide))
  exact .step _ _ r3 (.spend s3 1 ⟨1, 0⟩ 0 rfl rfl (by decide))

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/utils.ts", "ConditionExpression: \"lastRefill = :oldLr AND tokens = :oldTokens\",")]

end Proofs.RateLimit
