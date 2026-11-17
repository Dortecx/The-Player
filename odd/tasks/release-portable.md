# Portable release
Prepare a verified Windows portable release without mixing unrelated source changes.
Publication remains a distinct, evidence-gated delivery action.

## Specs
- S1: “Vale, comienza”
- S2: “Si recuerdas como debe ser la descripción de la release?”

## Tasks
- [x] T1 — S1 — Audit version, Git state, existing release policy, and artifact provenance; define isolated release work units. Route: explore. Evidence: source is 1.5.5; main is synchronized at 5963845; 7,687-line unstaged implementation/doc diff plus generated/untracked artifacts require classification and isolated work-unit commits; no v1.5.5 tag. Commit: pending.
- [x] T2 — S1-S2 — Prepare evidence-backed release notes in the repository convention and align the English/Spanish user documentation with the integrated v1.5.5 navigation, LAN subtitle, port-fallback, and portable-build behavior; keep the README scannable and link bilingual detail guides for deeper behavior. Route: inline. Evidence: GitHub body prepared from commits `efcfd09`, `8bc4b49`, and `74e0905`; artifact digest and validation evidence recorded in T3; bilingual README/detail-guide redesign in `8e7ffcc`. Commit: post-completion record pending.
- [x] T3 — S1 — Build and verify the final versioned portable ZIP, its digest, archive contents, and clean-launch evidence. Route: inline. Evidence: `The-Player-1.5.5-windows.zip`, SHA-256 `36612b0792c1ab5d46acb2a23bc8aca9ade1663745174c8c6ce79e842aa46321`, 167,814,595 bytes; ZIP integrity and required runtime entries passed; isolated `start.cmd` smoke returned HTTP 200. Commit: pending.
- [x] T4 — S1 — Create the release commits, annotated tag, push, and GitHub Release only after all exact publication gates are verified. Route: inline. Evidence: `v1.5.5` is annotated at `e47dea7ab342fd1117c0bc275a474917c6a8b21a`, `main` and tag pushed to origin, and GitHub Release published at `https://github.com/Dortecx/The-Player/releases/tag/v1.5.5` with the verified ZIP digest. Commit: post-release documentation pending.

## Log
- L1 — Vale, comienza
- L2 — Adelante
- L3 — Aceptar y re-pinnear
- L4 — Reparar el entorno primero
- L5 — Dale
- L6 — Vale y con las funcionalidades, no solo que apunten, sino que su documentación este actualizada a lo que se integró
- L7 — Vale o si es demaciado pero se puede condensar en un mermaid vertical, adelante. Y para más detalles un doc enlasado, siempre en español/eng
