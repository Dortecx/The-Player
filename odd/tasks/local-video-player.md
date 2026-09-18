# Local Video Player — ODD Tasks

## Objective
Build a phase 1 portable-friendly local web video player that runs with Node during development via `npm run web`, lets the user select a folder or multiple video files, plays them sequentially, and persists playback progress/watched state in IndexedDB.

## Problem
The user currently opens each episode/video manually in the browser, then closes/switches tabs for the next file. The app should provide one local playlist session and automatically continue to the next video.

## Why
A simple local web app solves the immediate workflow without requiring FFmpeg, transcodification, or a full media library. Portable packaging will come later only after `npm run web` works correctly.

## Scope
- Node local static server for development.
- Browser UI with folder/file selection.
- Playlist sorted by relative path/name.
- HTML video playback with automatic next item.
- IndexedDB persistence for progress and watched state.
- Basic unsupported-format/error handling.
- Initial formats: `.mp4`, `.mkv` best-effort, `.webm`, `.m4v`, `.mov`.

## Non-goals
- Windows portable ZIP/build scripts in this first work unit.
- FFmpeg, remuxing, transcoding, or embedded MKV subtitle extraction.
- User accounts, remote streaming, or media-library indexing outside the selected local files.
- Work-unit commits unless the user explicitly authorizes commits.

## Constraints
- Conversation is Spanish; technical artifacts and UI copy default to English.
- Final portable target should not require the end user to run `npm install`; however, this task only validates development runtime.
- `npm run web` must be the primary local verification command.
- No native review/commit/push unless explicitly requested by the user.

## TDD / Checks
- TDD mode: not configured/unknown.
- Runner: none yet; create lightweight testable modules where useful.
- Required checks for this work unit:
  - `npm run web` starts the local server.
  - Static app loads from `http://localhost:3000` or configured port.
  - If tests are added, run the relevant npm test command.

## Tasks
- [x] LV-001 — Scaffold Node web project
  - Create package metadata and a minimal Node static server.
  - Add `npm run web`.
  - Serve `public/index.html`, CSS, and JS.
  - Evidence: `PORT=3123 npm run web` started the server and `curl http://127.0.0.1:3123/` returned the page.

- [x] LV-002 — Implement playlist selection and ordering
  - Add folder and multi-file inputs.
  - Filter accepted video extensions.
  - Build stable item IDs from relative path/name + size + lastModified.
  - Sort items naturally by relative path/name.
  - Evidence: implemented in `public/index.html` and `public/app.js`; browser selection behavior still needs a manual check with local sample files.

- [x] LV-003 — Implement playback flow
  - Load selected videos with object URLs.
  - Play selected item in `<video>`.
  - On `ended`, mark watched and move to next playable item.
  - Surface playback errors and allow skipping.
  - Evidence: implemented in `public/app.js`; `node --check public/app.js` passed. Browser playback still needs a manual check with supported and unsupported sample files.

- [x] LV-004 — Persist progress in IndexedDB
  - Store currentTime, duration, watched, and updatedAt per item.
  - Save periodically and on pause/ended.
  - Restore progress when the same file is selected again.
  - Evidence: implemented in `public/app.js`; browser IndexedDB restore still needs a manual reload/reselect check.

- [x] LV-005 — Polish phase 1 UX and docs
  - Add simple status messages and controls.
  - Document development usage and phase 1 limitations.
  - Evidence: `README.md` documents `npm run web`, supported formats, and MKV/browser-codec limitations.

- [x] LV-006 — Add explicit watched controls and browser-language UI
  - Keep `Skip next` as a non-completing skip that saves current progress.
  - Add an explicit current-video action to mark watched and move next.
  - Pick the initial video from the first unwatched item, falling back to the first item.
  - Detect browser/system Spanish and show Spanish UI copy; otherwise use English.
  - Evidence: implemented localized static/dynamic UI copy in `public/index.html` and `public/app.js`; added `Mark watched & next`; changed `Skip next` to save progress without threshold-watched completion; `node --check public/app.js` passed; `PORT=3127 npm run web` readiness check passed; browser language/progress behavior still needs manual verification with local sample files.

- [x] LV-007 — Remember last active video on reload/reselect
  - Persist the last active video from the selected set when a user plays/selects/skips to an item.
  - When the same files are selected again, prefer the last active item over the first unwatched fallback.
  - Preserve first-unwatched fallback when no matching last active item exists.
  - Evidence: implemented an IndexedDB `sessions` store keyed by the selected item IDs; `playIndex` records the active item for initial selection, playlist clicks, previous/skip navigation, explicit watched-next, and ended auto-next; `handleFiles` prefers the remembered active item and otherwise falls back to first-unwatched/index 0. `node --check public/app.js` passed. `PORT=3130 npm run web` readiness check passed.

- [x] LV-008 — Restore last active video across selected subsets
  - Persist a recent active item signal that is not tied only to the exact selected-set key.
  - When a different subset of known files is selected, prefer the most recent active item that still exists in the new selection.
  - Keep exact selected-set restore as the first preference, then subset/global active restore, then first-unwatched/index 0 fallback.
  - Evidence: added an IndexedDB `recentActive` store updated by `playIndex` alongside exact selected-set sessions; `handleFiles` reads the exact selected-set active item first, then the most recent active item among the current selection; `getInitialIndex` now applies exact active, recent active, first-unwatched, then index 0 priority. `node --check public/app.js` passed. `PORT=3133 npm run web` readiness check passed after one transient pre-readiness curl failure. Manual browser subset restore check remains pending.

- [x] LV-009 — Do not persist automatic initial selection as user activity
  - Prevent initial auto-selection during file loading from overwriting last-active restore state.
  - Persist last-active only for user/navigation intent: playlist click, previous/skip, mark-watched-next, ended auto-next, or actual playback transitions.
  - Add source metadata where useful so future restore can distinguish intentional activity from legacy/automatic selections.
  - Evidence: `playIndex` now writes selected-set/recent-active records only when called with an intentional `source`; `handleFiles` initial restore calls `playIndex` without a source, so it does not persist automatic initial selection. New session/recent-active records include `source`; legacy exact selected-set records without `source` yield to a newer selected-file recent-active record. `node --check public/app.js` passed. `PORT=3136 npm run web` readiness check passed after one transient pre-readiness curl failure. Manual browser checks remain pending.

## Acceptance Criteria
- Running `npm run web` starts a local server without requiring a framework dev server.
- The browser app can select a folder or multiple files.
- Videos are listed in a deterministic, human-friendly order.
- Selecting/playing one video works for browser-supported files.
- Ended playback advances to the next item.
- Progress and watched state persist in IndexedDB across reload/reselect.
- Unsupported playback errors are visible and do not crash the app.
- Portable packaging remains deferred.

## Progress
- 2026-09-18: Feature document created before source implementation.
- 2026-09-18: Implemented phase 1 Node static server, browser playlist/player UI, object URL playback flow, IndexedDB progress/watched persistence, and README usage/limitations docs.
- 2026-09-18: Completed LV-006 explicit watched controls and browser-language UI localization; README now documents first-unwatched selection, skip-vs-watched behavior, and Spanish/browser-language fallback.
- 2026-09-18: Completed LV-007 last-active video restoration for reselected file sets; README now documents last-active precedence before first-unwatched fallback.
- 2026-09-18: Completed LV-008 subset-aware last-active restoration; README now documents exact selected-set restore, cross-subset recent-active restore, first-unwatched fallback, and IndexedDB recent-active storage.
- 2026-09-18: Completed LV-009 source-aware last-active persistence; automatic initial selection no longer rewrites selected-set or recent-active restore records, and newer recent-active records can beat legacy source-less exact selected-set records.

## Verification Evidence
- `node --check server.js` — passed in worker and parent verification.
- `node --check public/app.js` — passed in worker and parent verification.
- `node --check public/app.js` — passed after LV-006 changes.
- `PORT=3123 npm run web` with `curl -fsS http://127.0.0.1:3123/` readiness check — passed; server printed `Local video player available at http://127.0.0.1:3123` and the page responded.
- Parent spot check: `PORT=3125 npm run web` with `curl -fsS http://127.0.0.1:3125/` readiness check — passed after transient pre-readiness curl failures.
- `PORT=3127 npm run web` with `curl -fsS http://127.0.0.1:3127/` readiness check — passed after one transient pre-readiness curl failure.
- Parent LV-006 spot check: `node --check public/app.js` and `PORT=3128 npm run web` readiness check passed.
- `node --check public/app.js` — passed after LV-007 changes.
- `PORT=3130 npm run web` with `curl -fsS http://127.0.0.1:3130/` readiness check — passed after one transient pre-readiness curl failure.
- Parent LV-007 spot check: `node --check public/app.js` and `PORT=3131 npm run web` readiness check passed.
- `node --check public/app.js` — passed after LV-008 changes.
- `PORT=3133 npm run web` with `curl -fsS http://127.0.0.1:3133/` readiness check — passed after one transient pre-readiness curl failure.
- Parent LV-008 spot check: `node --check public/app.js` and `PORT=3134 npm run web` readiness check passed.
- Independent LV-008 verifier: `node --check public/app.js` and `PORT=3135 npm run web` readiness check passed; verifier confirmed DB version/store migration for `recentActive`, exact selected-set priority, subset-aware recent-active fallback among currently selected item IDs, and preserved skip/mark-watched behavior. Browser-manual checks remain pending.
- `node --check public/app.js` — passed after LV-009 changes.
- `PORT=3136 npm run web` with `curl -fsS http://127.0.0.1:3136/` readiness check — passed after one transient pre-readiness curl failure.
- Parent LV-009 spot check: `node --check server.js`, `node --check public/app.js`, and `PORT=3137 npm run web` readiness check passed.
- Independent LV-009 verifier: `node --check public/app.js` and `PORT=3138 npm run web` readiness check passed; verifier confirmed source-less initial restore does not persist last-active, intentional navigation callsites pass source metadata, legacy source-less exact records can yield to newer recent-active records, and skip/mark-watched behavior remains intact. Browser-manual checks remain pending.
- Independent LV-007 verifier: `node --check public/app.js` and `PORT=3132 npm run web` readiness check passed; verifier confirmed the IndexedDB `sessions` store, deterministic selected-set key, remembered-active preference over first-unwatched fallback, and shared `playIndex` active-item persistence. Browser-manual checks remain pending.
- Independent LV-006 verifier: `node --check public/app.js` and `PORT=3129 npm run web` readiness check passed; verifier confirmed `Skip next` disables threshold watched completion, `Mark watched & next` explicitly marks watched, first-unwatched selection exists, and browser-language Spanish detection uses `es`/`es-*`. Browser-manual checks remain pending.
- Independent verifier: syntax checks passed and `PORT=3126 npm run web` readiness check passed; verifier reported implementation evidence for static path safety, playlist IDs, sorting, object URL lifecycle, auto-next/error behavior, and IndexedDB logic. Browser-manual checks remain pending.

## Pending Manual Checks
- Select a folder and confirm playlist ordering with nested relative paths.
- Select multiple files and confirm filtering of supported/unsupported extensions.
- Play browser-supported files, verify manual previous/next skip and automatic next on ended.
- Trigger an unsupported codec/container error and confirm the visible error message.
- Pause/reload/reselect the same file and confirm IndexedDB progress/watched restoration.
- With saved watched progress on earlier items and no remembered active item for the selection, reselect the same files and confirm the first unwatched item is selected without autoplay.
- Select three videos, click/play the second, reload, reselect the same three files, and confirm the second video is selected again even if the first has progress but is not watched.
- Select three videos, click/play the second, reload, reselect only the first two files, and confirm the second video is selected through recent-active subset restore.
- Select `[video1, video2]` in a fresh/cleared browser profile and confirm initial auto-selection of `video1` does not create selected-set or recent-active last-active records before user navigation.
- With a legacy source-less exact selected-set record for `[video1, video2]` pointing to `video1` and a newer recent-active record for `video2`, reselect `[video1, video2]` and confirm `video2` is selected.
- Confirm `Skip next` saves current progress but does not mark the item watched, including near the end of a video.
- Confirm `Mark watched & next` marks the current item watched and advances.
- Confirm Spanish browser languages (`es`/`es-*`) show Spanish UI/status/error copy, while other languages show English.

## Next Step
Run the pending manual browser checks with representative local video files, prioritizing the LV-009 no-auto-persist and legacy-exact-vs-newer-recent restore scenarios.
