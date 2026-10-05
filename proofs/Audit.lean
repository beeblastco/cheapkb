import Proofs
import Lean

/-!
Fails the build when any declaration from the `Proofs` modules, in any namespace, depends
on an axiom beyond the three Lean itself is built on. That catches `sorry`,
`native_decide` and `decide +native` (`Lean.ofReduceBool`) and any added `axiom`.
-/

open Lean Elab Command in
elab "#audit_proofs" : command => do
  let allowed := #[``propext, ``Classical.choice, ``Quot.sound]
  let env ← getEnv
  let fromProofs := fun (name : Name) =>
    match env.getModuleIdxFor? name with
    | some idx => (`Proofs).isPrefixOf (env.header.moduleNames[idx.toNat]!)
    | none => false
  let names := env.constants.fold (init := #[]) fun acc name _ =>
    if fromProofs name then acc.push name else acc
  let mut theorems : Nat := 0
  for name in names do
    for ax in ← Lean.collectAxioms name do
      unless allowed.contains ax do
        throwError "{name} depends on the axiom {ax}"
    if (env.find? name).any (·.isTheorem) then theorems := theorems + 1
  if theorems < 50 then throwError "only {theorems} theorems found under Proofs"
  logInfo m!"{names.size} declarations, {theorems} of them theorems, use only propext, Classical.choice and Quot.sound"

#audit_proofs
