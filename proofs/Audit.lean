import Proofs
import Lean

/-!
Fails the build when any declaration under `Proofs` depends on an axiom beyond the three
Lean itself is built on. That catches `sorry`, `native_decide` (`Lean.ofReduceBool`) and
any added `axiom`, however they are spelled.
-/

open Lean Elab Command in
elab "#audit_proofs" : command => do
  let allowed := #[``propext, ``Classical.choice, ``Quot.sound]
  let env ← getEnv
  let names := env.constants.fold (init := #[]) fun acc name _ =>
    if (`Proofs).isPrefixOf name && !name.isInternal then acc.push name else acc
  let mut theorems := 0
  for name in names do
    for ax in ← Lean.collectAxioms name do
      unless allowed.contains ax do
        throwError "{name} depends on the axiom {ax}"
    if (env.find? name).any (·.isTheorem) then theorems := theorems + 1
  if theorems < 50 then throwError "only {theorems} theorems found under Proofs"
  logInfo m!"{theorems} theorems and {names.size - theorems} definitions use only propext, Classical.choice and Quot.sound"

#audit_proofs
