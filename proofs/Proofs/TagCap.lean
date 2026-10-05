/-!
The per-user tag cap in functions/tags/create.ts under any interleaving of concurrent
creates and deletes. A create reads the user's `TAGSEQ`, counts the user's tags with a
consistent query, and writes the tag and the next `TAGSEQ` in one transaction that commits
only while `TAGSEQ` still holds the value it read.
Assumption: DynamoDB transactions are atomic and the consistent count sees every tag.
-/
namespace Proofs.TagCap

inductive Pc
  | idle
  | counted (seen count : Nat)

structure St where
  seq : Nat := 0
  tags : Nat := 0
  procs : Nat → Pc := fun _ => .idle

def St.set (s : St) (p : Nat) (pc : Pc) : St :=
  { s with procs := fun q => if q = p then pc else s.procs q }

inductive Step (cap : Nat) : St → St → Prop
  | read (s : St) (p : Nat) (h : s.procs p = .idle) :
      Step cap s (s.set p (.counted s.seq s.tags))
  | commit (s : St) (p seen n : Nat) (h : s.procs p = .counted seen n) (hseq : seen = s.seq)
      (hn : n < cap) : Step cap s { (s.set p .idle) with seq := s.seq + 1, tags := s.tags + 1 }
  | giveUp (s : St) (p : Nat) : Step cap s (s.set p .idle)
  /-- DELETE /tags/{name} and account reset remove tags without touching TAGSEQ. -/
  | delete (s : St) : Step cap s { s with tags := s.tags - 1 }

inductive Reachable (cap : Nat) : St → Prop
  | init : Reachable cap {}
  | step (s t : St) : Reachable cap s → Step cap s t → Reachable cap t

structure Inv (cap : Nat) (s : St) : Prop where
  tags : s.tags ≤ cap
  procs : ∀ p seen n, s.procs p = .counted seen n → seen ≤ s.seq ∧ (seen = s.seq → s.tags ≤ n)

theorem inv_step (cap : Nat) (s t : St) (hi : Inv cap s) (h : Step cap s t) : Inv cap t := by
  obtain ⟨h1, h2⟩ := hi
  cases h with
  | read p hp =>
    refine ⟨h1, fun q seen n hq => ?_⟩
    simp only [St.set] at hq; split at hq
    · cases hq; exact ⟨Nat.le_refl _, fun _ => Nat.le_refl _⟩
    · exact h2 q seen n hq
  | commit p seen n hp hseq hn =>
    have := (h2 p seen n hp).2 hseq
    refine ⟨by simp only; omega, fun q seen' n' hq => ?_⟩
    simp only [St.set] at hq; split at hq
    · cases hq
    · have := (h2 q seen' n' hq).1; exact ⟨by simp only; omega, fun he => by simp only at he; omega⟩
  | giveUp p =>
    refine ⟨h1, fun q seen n hq => ?_⟩
    simp only [St.set] at hq; split at hq
    · cases hq
    · exact h2 q seen n hq
  | delete =>
    exact ⟨by simp only; omega, fun q seen n hq => by
      have := h2 q seen n hq; exact ⟨this.1, fun he => by have := this.2 he; simp only; omega⟩⟩

/-- No interleaving of creates takes a user past the tag cap. -/
theorem tags_le_cap (cap : Nat) (s : St) (h : Reachable cap s) : s.tags ≤ cap := by
  suffices Inv cap s from this.tags
  induction h with
  | init => exact ⟨Nat.zero_le _, fun _ _ _ h => nomatch h⟩
  | step s t _ hst ih => exact inv_step cap s t ih hst

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/tags/create.ts", "const MAX_TAGS_PER_USER = 200;"),
   ("functions/tags/create.ts", "ConditionExpression: \"attribute_not_exists(seq) OR seq = :seen\","),
   ("functions/tags/create.ts", "if ((countRes.Count ?? 0) >= MAX_TAGS_PER_USER) {")]

end Proofs.TagCap
