/-!
Billing in functions/utils.ts: `currentCycle` picks the account's billing cycle,
`updateStorageBytes` accrues storage cost piece by piece as the stored bytes change,
`recordUsage` adds an operation's cost once per operation id, and `getUsageSummary`
pauses the account when the cycle's spend reaches its allowance.
-/
namespace Proofs.Billing

/-! ### Cycles -/

/-- Days in a month of the proleptic Gregorian calendar (month 0 is January). -/
def isLeap (y : Nat) : Bool := y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)

def monthDays (y m : Nat) : Nat :=
  match m with
  | 1 => if isLeap y then 29 else 28
  | 3 | 5 | 8 | 10 => 30
  | _ => 31

theorem monthDays_pos (y m : Nat) : 0 < monthDays y m := by
  unfold monthDays; split <;> (try split) <;> decide

/-- `monthAnchor`: the anchor day clamped to the month's last day, as a day number on any
calendar where each month starts right after the previous one ends. -/
structure Calendar where
  start : Nat → Nat
  len : Nat → Nat
  len_pos : ∀ k, 0 < len k
  contiguous : ∀ k, start (k + 1) = start k + len k

def anchor (c : Calendar) (day : Nat) (k : Nat) : Nat := c.start k + (min day (c.len k) - 1)

/-- Anchors of consecutive months strictly increase, so cycles tile time without gaps or
overlaps, for any anchor day from 1 to 31 and month lengths from 28 to 31. -/
theorem anchor_lt_succ (c : Calendar) (day k : Nat) (hd : 1 ≤ day) :
    anchor c day k < anchor c day (k + 1) := by
  unfold anchor; rw [c.contiguous]
  have := c.len_pos k; have := c.len_pos (k + 1)
  have : min day (c.len k) ≤ c.len k := Nat.min_le_right _ _
  omega

theorem anchor_mono (c : Calendar) (day : Nat) (hd : 1 ≤ day) :
    ∀ j k, j < k → anchor c day j < anchor c day k
  | j, 0, h => absurd h (Nat.not_lt_zero _)
  | j, k + 1, h => by
    rcases Nat.lt_succ_iff_lt_or_eq.1 h with h | rfl
    · exact Nat.lt_trans (anchor_mono c day hd j k h) (anchor_lt_succ c day k hd)
    · exact anchor_lt_succ c day j hd

theorem anchor_ge (c : Calendar) (day : Nat) (hd : 1 ≤ day) : ∀ k, anchor c day 0 + k ≤ anchor c day k
  | 0 => Nat.le_refl _
  | k + 1 => by have := anchor_ge c day hd k; have := anchor_lt_succ c day k hd; omega

/-- currentCycle's `while (monthAnchor(index + 1) <= now) index += 1`, with enough fuel. -/
def cycleIndex (a : Nat → Nat) (now : Nat) : Nat → Nat → Nat
  | k, 0 => k
  | k, fuel + 1 => if a (k + 1) ≤ now then cycleIndex a now (k + 1) fuel else k

theorem cycleIndex_spec (a : Nat → Nat) (now : Nat) (hmono : ∀ k, a k < a (k + 1)) :
    ∀ fuel k, a k ≤ now → now < a k + fuel + 1 →
      a (cycleIndex a now k fuel) ≤ now ∧ now < a (cycleIndex a now k fuel + 1)
  | 0, k, h1, h2 => by
    simp only [cycleIndex]; refine ⟨h1, ?_⟩; have := hmono k; omega
  | fuel + 1, k, h1, h2 => by
    simp only [cycleIndex]; split
    · rename_i h; exact cycleIndex_spec a now hmono fuel (k + 1) h (by have := hmono k; omega)
    · rename_i h; exact ⟨h1, by omega⟩

/-- The cycle currentCycle returns contains `now`: start ≤ now < end, from the account's
creation on. Each instant therefore falls in exactly one cycle. -/
theorem cycle_contains_now (c : Calendar) (day now : Nat) (hd : 1 ≤ day)
    (hnow : anchor c day 0 ≤ now) :
    let k := cycleIndex (anchor c day) now 0 (now + 1)
    anchor c day k ≤ now ∧ now < anchor c day (k + 1) :=
  cycleIndex_spec _ now (fun k => anchor_lt_succ c day k hd) (now + 1) 0 hnow (by omega)

/-! ### Storage cost accrual -/

/-- Exact accrued cost of `bytes` held for `ms` milliseconds, in nano USD times `den`. TS passes
milliseconds / 1000 as seconds, so whole milliseconds model it exactly, up to float rounding;
`den` is 1000 × 2,592,000 × 2^30 for the shipped price. -/
def exactScaled (price bytes ms : Nat) : Nat := price * bytes * ms

/-- storageCostNanoUsd rounds each piece to the nearest nano USD. -/
def piece (den price bytes ms : Nat) : Nat := (exactScaled price bytes ms + den / 2) / den

/-- The pieces updateStorageBytes adds up for a sequence of (bytes, milliseconds) holdings. -/
def accrued (den price : Nat) (pieces : List (Nat × Nat)) : Nat :=
  (pieces.map fun p => piece den price p.1 p.2).sum

def exactTotal (price : Nat) (pieces : List (Nat × Nat)) : Nat :=
  (pieces.map fun p => exactScaled price p.1 p.2).sum

/-- Accruing storage piece by piece costs at most one nano USD per piece more or less than
the exact charge, so changing stored bytes often cannot drift a bill. -/
theorem accrued_close (den price : Nat) (hden : 0 < den) (pieces : List (Nat × Nat)) :
    accrued den price pieces * den ≤ exactTotal price pieces + pieces.length * den ∧
      exactTotal price pieces ≤ accrued den price pieces * den + pieces.length * den := by
  induction pieces with
  | nil => simp [accrued, exactTotal]
  | cons p ps ih =>
    simp only [accrued, exactTotal, List.map_cons, List.sum_cons, List.length_cons] at ih ⊢
    have h1 : piece den price p.1 p.2 * den ≤ exactScaled price p.1 p.2 + den / 2 :=
      Nat.div_mul_le_self _ den
    have h2 : exactScaled price p.1 p.2 + den / 2 < piece den price p.1 p.2 * den + den :=
      Nat.lt_div_mul_add hden
    have h3 : den / 2 ≤ den := Nat.div_le_self _ _
    rw [Nat.add_mul, Nat.succ_mul]
    constructor <;> omega

/-! ### Usage -/

/-- recordUsage with an operation id: the daily counter and the USAGEEVENT marker are
written in one transaction, and the marker's put fails if the id was seen. -/
structure Usage where
  cost : Nat := 0
  seen : List Nat := []

def recordOnce (u : Usage) (op cost : Nat) : Usage :=
  if op ∈ u.seen then u else { cost := u.cost + cost, seen := op :: u.seen }

/-- Replaying a delivery is a no-op: an operation is billed once however often it repeats. -/
theorem recordOnce_idem (u : Usage) (op cost : Nat) :
    recordOnce (recordOnce u op cost) op cost = recordOnce u op cost := by
  unfold recordOnce; split <;> simp_all

/-- Any delivery order of any duplicates bills each distinct operation exactly once: the
billed operations are the distinct ids delivered, and the cost is the sum of theirs. -/
theorem billed_once (costOf : Nat → Nat) :
    ∀ (ops : List Nat) (u : Usage), u.seen.Nodup → u.cost = (u.seen.map costOf).sum →
      let r := ops.foldl (fun u op => recordOnce u op (costOf op)) u
      r.seen.Nodup ∧ r.cost = (r.seen.map costOf).sum ∧ (∀ op, op ∈ r.seen ↔ op ∈ u.seen ∨ op ∈ ops)
  | [], u, hn, hc => ⟨hn, hc, fun op => by simp⟩
  | op :: ops, u, hn, hc => by
    simp only [List.foldl_cons]
    have step : (recordOnce u op (costOf op)).seen.Nodup ∧
        (recordOnce u op (costOf op)).cost = ((recordOnce u op (costOf op)).seen.map costOf).sum ∧
        ∀ x, x ∈ (recordOnce u op (costOf op)).seen ↔ x ∈ u.seen ∨ x = op := by
      unfold recordOnce; split
      · rename_i h; exact ⟨hn, hc, fun x => ⟨Or.inl, fun hx => hx.elim id (fun e => e ▸ h)⟩⟩
      · rename_i h
        refine ⟨List.nodup_cons.2 ⟨h, hn⟩, by simp [hc]; omega, fun x => ?_⟩
        simp only [List.mem_cons]; exact ⟨fun hx => hx.elim Or.inr Or.inl, fun hx => hx.elim Or.inr Or.inl⟩
    obtain ⟨h1, h2, h3⟩ := billed_once costOf ops _ step.1 step.2.1
    refine ⟨h1, h2, fun x => ?_⟩
    rw [h3, step.2.2]; simp only [List.mem_cons]
    constructor
    · rintro ((h | h) | h)
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · exact Or.inr (Or.inr h)
    · rintro (h | h | h)
      · exact Or.inl (Or.inl h)
      · exact Or.inl (Or.inr h)
      · exact Or.inr h

/-- Spend only grows within a cycle: usage rows add and storage cost accrues, so once the
allowance is reached the account stays paused until the cycle resets. -/
theorem paused_monotone (allowance spent extra : Nat) (h : allowance ≤ spent) :
    allowance ≤ spent + extra := Nat.le_add_right_of_le h

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/utils.ts", "while (monthAnchor(year, month + index + 1, anchorDay) <= nowMs) index += 1;"),
   ("functions/utils.ts", "return Date.UTC(year, monthIndex, Math.min(day, lastDay));"),
   ("functions/utils.ts", "return Math.round(prorated * PRICING.storagePerGbMonth);"),
   ("functions/utils.ts", "Item: { pk: pk, sk: `USAGEEVENT#${operationId}`, ttl: ttl },"),
   ("functions/utils.ts", "paused: totalSpentNano >= allowanceNano,")]

end Proofs.Billing
