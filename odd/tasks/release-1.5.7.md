# Portable release v1.5.7

Prepare and publish a verified Windows portable patch release for the completed LAN synchronization, particle-canvas, and FFmpeg pin corrections.
Publication is evidence-gated and remains scoped to this patch.

## Specs

- S1: “Vale, ahora si responde vien ante cambios de resize de ventana, cierra LAN y release”

## Tasks

- [x] T1 — S1 — Align source version and current release references for v1.5.7; draft evidence-backed release notes. Route: inline. Commit: pending. Evidence: package/package-lock and both README files reference v1.5.7.
- [x] T2 — S1 — Build and verify the v1.5.7 Windows portable ZIP, digest, archive contents, and launcher smoke. Route: inline. Commit: pending. Evidence: ZIP SHA-256 `a01f5194581b4b767e17e3aadf9a56869f48469cd0a61735bed090772491ab59`; independent archive verification passed.
- [x] T3 — S1 — Commit the isolated patch, create and push an annotated v1.5.7 tag, then publish the GitHub Release with the verified ZIP. Route: inline. Commit: `9a5d6cb`; release: https://github.com/Dortecx/The-Player/releases/tag/v1.5.7. Evidence: annotated tag `v1.5.7` points to `9a5d6cb1624929e21685fc639f9654bc8e60d7d6`; uploaded ZIP digest matches the independently verified SHA-256.

## Log

- L1 — “Vale, ahora si responde vien ante cambios de resize de ventana, cierra LAN y release”
