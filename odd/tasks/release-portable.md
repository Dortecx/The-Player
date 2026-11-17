# Portable release
Prepare a verified Windows portable release without mixing unrelated source changes.
Publication remains a distinct, evidence-gated delivery action.

## Specs
- S1: “Vale, comienza”
- S2: “Si recuerdas como debe ser la descripción de la release?”

## Tasks
- [x] T1 — S1 — Audit version, Git state, existing release policy, and artifact provenance; define isolated release work units. Route: explore. Evidence: source is 1.5.5; main is synchronized at 5963845; 7,687-line unstaged implementation/doc diff plus generated/untracked artifacts require classification and isolated work-unit commits; no v1.5.5 tag. Commit: pending.
- [ ] T2 — S1-S2 — Prepare evidence-backed release notes in the repository convention. Route: inline. Commit: pending.
- [ ] T3 — S1 — Build and verify the final versioned portable ZIP, its digest, archive contents, and clean-launch evidence. Route: inline. Commit: pending.
- [ ] T4 — S1 — Create the release commits, annotated tag, push, and GitHub Release only after all exact publication gates are verified. Route: inline. Commit: pending.

## Log
- L1 — Vale, comienza
- L2 — Adelante
- L3 — Aceptar y re-pinnear
- L4 — Reparar el entorno primero
