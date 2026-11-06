# Internal MKV tracks

Plan support for selectable embedded MKV audio and subtitle tracks. Begin with discovery and do not alter playback until the delivery approach is evidenced.

## Specs

- S1: “La interna”

## Tasks

- [x] T1 — S1 — Map the current media pipeline and identify the smallest viable server/browser delivery approach for embedded audio and subtitles. Route: inline read-only mapping after explorer cancellation. Commit: n/a. Evidence: raw MKV byte-range streaming has no track metadata or selection; use FFprobe for inspection and FFmpeg-generated HLS audio renditions/WebVTT subtitle tracks for browser-compatible selection.
- [x] T2 — S1 — Add server-side media-track inspection with test fixtures and API coverage after the approach is accepted. Route: delegated implementation, independently verified after bounded correction. Commit: `4cc0bee feat: inspect embedded media tracks`. Risk: item 2 (the server invokes a local media-probe executable on host-uploaded input); contained with fixed argv, `shell: false`, output/time bounds, and non-sensitive failure fallback. Implemented result: uploaded media is probed after streaming through an injected, bounded FFprobe runner, and protected media responses expose only normalized audio/subtitle metadata or `{ "status": "unavailable" }` while raw playback remains usable.
- T3 — S1 — Add a browser track-selection UI and compatible media delivery after the supported formats and fallback behavior are decided. Route: pending. Commit: pending.
- T4 — S1 — Package pinned 64-bit LGPL FFmpeg/FFprobe binaries in the Windows portable ZIP, include applicable notices, document codec/subtitle limits, and validate portable and LAN behavior. Route: pending. Commit: pending.

## Log

- L1 — “Vale, vamos paso a paso... con que comenzaríamos?”
- L2 — “La interna”
- L3 — Explorer was cancelled after it remained on CodeGraph initialization; T1 was completed with bounded inline repository mapping instead.
- L4 — “En el zip, debe ser lo más portatil posible sin necesidad de que el usuario final tenga que instalar nada”
- L5 — Architecture decision: package a pinned 64-bit LGPL FFmpeg/FFprobe build with license notices; do not require a system installation.
- L6 — T2 evidence (covered S1): `node --test test/server.test.js` passed 26/26. The added coverage verifies normalized embedded audio/subtitle metadata through token-protected upload/library responses, rejects anonymous library access, and confirms a failed probe reports the non-sensitive unavailable status while byte-range raw playback still returns `206` with the expected bytes.
- L7 — Independent verification found that an unhandled `child.stdout` error in `createFfprobeRunner` could crash the server; T2 remains open for a bounded correction and runner-event coverage.
- L8 — T2 correction evidence (covered S1): added a focused injected spawned-process test for `child.stdout` errors. It verifies the runner settles once, upload returns the non-sensitive unavailable fallback, and raw range playback remains `206`; `node --test test/server.test.js` passed 27/27 and `git diff --check` passed. `createFfprobeRunner` now listens for stdout errors and rejects safely.
