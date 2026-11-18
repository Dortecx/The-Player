# Portable release v1.5.7

Prepare and publish a verified Windows portable patch release for the completed LAN synchronization, particle-canvas, and FFmpeg pin corrections.
Publication is evidence-gated and remains scoped to this patch.

## Specs

- S1: “Vale, ahora si responde vien ante cambios de resize de ventana, cierra LAN y release”

## Tasks

- [x] T1 — S1 — Align source version and current release references for v1.5.7; draft evidence-backed release notes. Route: inline. Commit: pending. Evidence: package/package-lock and both README files reference v1.5.7.
- [x] T2 — S1 — Build and verify the v1.5.7 Windows portable ZIP, digest, archive contents, and launcher smoke. Route: inline. Commit: pending. Evidence: ZIP SHA-256 `a01f5194581b4b767e17e3aadf9a56869f48469cd0a61735bed090772491ab59`; independent archive verification passed.
- [ ] T3 — S1 — Commit the isolated patch, create and push an annotated v1.5.7 tag, then publish the GitHub Release with the verified ZIP. Route: inline. Commit: pending.

## Log

- L1 — “Vale, ahora si responde vien ante cambios de resize de ventana, cierra LAN y release”
