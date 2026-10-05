/-!
`truncateUtf8` in functions/embed/index.ts cuts a chunk's text to the S3 Vectors
metadata budget, backing off continuation bytes so the cut lands on a character start.
-/
namespace Proofs.Truncate

/-- A UTF-8 continuation byte has the bit pattern 10xxxxxx. -/
def isCont (b : UInt8) : Bool := (b &&& 0xC0) == 0x80

/-- The `while (end > 0 && continuation(bytes[end])) end -= 1` loop. -/
def backOff (bs : List UInt8) : Nat → Nat
  | 0 => 0
  | n + 1 => if isCont (bs.getD (n + 1) 0) then backOff bs n else n + 1

/-- Where the cut lands: the whole text when it fits, else the backed-off index. -/
def cutPoint (bs : List UInt8) (maxBytes : Nat) : Nat :=
  if bs.length ≤ maxBytes then bs.length else backOff bs maxBytes

def truncate (bs : List UInt8) (maxBytes : Nat) : List UInt8 :=
  bs.take (cutPoint bs maxBytes)

theorem backOff_le (bs : List UInt8) : ∀ n, backOff bs n ≤ n
  | 0 => by simp [backOff]
  | n + 1 => by
    unfold backOff
    split
    · have := backOff_le bs n; omega
    · omega

/-- The loop stops at 0 or on a byte that starts a character. -/
theorem backOff_boundary (bs : List UInt8) :
    ∀ n, backOff bs n = 0 ∨ isCont (bs.getD (backOff bs n) 0) = false
  | 0 => by simp [backOff]
  | n + 1 => by
    unfold backOff
    split
    · exact backOff_boundary bs n
    · rename_i h; right; simpa using h

/-- Every byte the loop stepped over is a continuation byte, so the cut is the last
character start at or before maxBytes. -/
theorem backOff_maximal (bs : List UInt8) :
    ∀ n i, backOff bs n < i → i ≤ n → isCont (bs.getD i 0) = true
  | 0, i, h1, h2 => by simp [backOff] at h1; omega
  | n + 1, i, h1, h2 => by
    unfold backOff at h1
    split at h1
    · rename_i hc
      by_cases hi : i = n + 1
      · subst hi; exact hc
      · exact backOff_maximal bs n i h1 (by omega)
    · omega

theorem truncate_length_le (bs : List UInt8) (maxBytes : Nat) :
    (truncate bs maxBytes).length ≤ maxBytes := by
  unfold truncate cutPoint
  split
  · simp; omega
  · have := backOff_le bs maxBytes; simp; omega

theorem truncate_prefix (bs : List UInt8) (maxBytes : Nat) :
    truncate bs maxBytes <+: bs :=
  List.take_prefix _ _

theorem truncate_of_fits (bs : List UInt8) (maxBytes : Nat) (h : bs.length ≤ maxBytes) :
    truncate bs maxBytes = bs := by
  simp [truncate, cutPoint, h]

/-- The cut is the end of the text, its start, or a character start. -/
theorem truncate_at_boundary (bs : List UInt8) (maxBytes : Nat) :
    let e := cutPoint bs maxBytes
    e = bs.length ∨ e = 0 ∨ isCont (bs.getD e 0) = false := by
  simp only [cutPoint]
  split
  · exact Or.inl rfl
  · rcases backOff_boundary bs maxBytes with h | h
    · exact Or.inr (Or.inl h)
    · exact Or.inr (Or.inr h)

/-- Valid UTF-8 never has four continuation bytes in a row. -/
def NoLongContRun (bs : List UInt8) : Prop :=
  ∀ i, ¬ (isCont (bs.getD i 0) = true ∧ isCont (bs.getD (i + 1) 0) = true ∧
    isCont (bs.getD (i + 2) 0) = true ∧ isCont (bs.getD (i + 3) 0) = true)

/-- On valid UTF-8 the cut drops at most three bytes of the budget: one partial character. -/
theorem truncate_loses_at_most_three (bs : List UInt8) (maxBytes : Nat)
    (hv : NoLongContRun bs) (hlong : maxBytes < bs.length) :
    maxBytes ≤ cutPoint bs maxBytes + 3 := by
  simp only [cutPoint, show ¬ bs.length ≤ maxBytes by omega, ite_false]
  have hm := backOff_maximal bs maxBytes
  generalize backOff bs maxBytes = e at hm ⊢
  refine Nat.le_of_not_lt fun hc => ?_
  exact hv (e + 1) ⟨hm (e + 1) (by omega) (by omega), hm (e + 2) (by omega) (by omega),
    hm (e + 3) (by omega) (by omega), hm (e + 4) (by omega) (by omega)⟩

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/embed/index.ts", "while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;"),
   ("functions/embed/index.ts", "const MAX_VECTOR_TEXT_BYTES = 32 * 1024;")]

end Proofs.Truncate
