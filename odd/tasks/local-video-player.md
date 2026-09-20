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

- [x] LV-010 — Restore by latest selected-file activity
  - Consider per-file progress `updatedAt` together with recent-active records when selecting an initial item.
  - Prefer the most recently active/progressed selected file over stale exact selected-set records.
  - Preserve exact selected-set restore only when it is the newest meaningful activity for the selected files.
  - Evidence: initial restore now builds one recency-sorted candidate set from exact selected-set activity, per-file recent-active records, and meaningful per-file progress records for the current selection; first-unwatched/index 0 remain fallback only when no selected-file activity candidate exists. `node --check public/app.js` passed. `PORT=3139 npm run web` readiness check passed after one transient pre-readiness curl failure. Manual browser subset/progress restore check remains pending.

- [x] LV-011 — Refine dark cinematic UI style
  - Use a near-black but not pure-black background.
  - Add subtle tiny white particle/dust-like background points without making it look dirty.
  - Use thin white borders for panels, controls, video, and playlist cards.
  - Add soft border glow on hover/focus for buttons and interactive playlist rows.
  - Evidence: updated `public/styles.css` with near-black layered background, sparse tiny white particle gradients, thin white borders on panels/controls/video/playlist cards, and consistent hover/focus-visible glow states. Static CSS readback passed. `PORT=3143 npm run web` readiness check passed.

- [x] LV-012 — Switch to black twinkling random particle background
  - Make the page background true black.
  - Replace regular particle pattern with more random-looking tiny white points.
  - Animate points softly so they turn on/off at different timings without distracting from playback.
  - Preserve the existing thin white borders and hover/focus glow style.
  - Evidence: updated `public/styles.css` with true-black page background, irregular tiny white particle points on CSS pseudo-element layers, soft staggered opacity twinkle, and `prefers-reduced-motion: reduce` disabling animation. Static CSS readback passed for syntax plausibility. `PORT=3145 npm run web` readiness check passed after one transient pre-readiness curl failure. Manual visual check remains pending.

- [x] LV-013 — Simplify video selection UI
  - Remove the standalone choose-videos panel.
  - Move only `Select folder` and `Select files` controls into the Playlist header area.
  - Remove visible supported-extensions copy, selected-videos/status copy, and playlist count.
  - Preserve file selection behavior and accessible live status where practical.
  - Evidence: removed the standalone selection panel from `public/index.html`, kept `#folderInput` and `#fileInput` inside the Playlist header with localized `data-i18n` spans, kept `#status` as a visually hidden live status, and hid `#playlistCount` for script compatibility without visible count copy. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3148 npm run web` readiness check passed after one transient pre-readiness curl failure. Static readback/diff confirmed the supported-extensions, visible selected-status, and visible playlist-count copy were removed. Manual browser visual and file-picker checks remain pending.

- [x] LV-014 — Add adaptive playlist actions and clear list
  - When the playlist is empty, center the folder/file selection controls horizontally and vertically inside the Playlist panel.
  - When files are loaded, move those controls to the top Playlist header and show them as icon-only buttons.
  - Add a Clear/Vaciar button that empties the current playlist without deleting saved progress.
  - Keep folder/file picker behavior, playlist restore/progress records, and hidden live status intact.
  - Evidence: added `#playlistPanel` empty/loaded state classes, SVG icons for folder/files/clear actions, `clearPlaylist()` that resets only current in-memory playlist/player/input state, and CSS that centers empty controls then switches loaded controls to icon-only header actions. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3149 npm run web` readiness check passed after transient pre-readiness curl failures. Independent LV-014 verifier passed static behavior/readiness checks with manual browser checks remaining.

- [x] LV-015 — Shorten empty selection labels and keep clear hidden initially
  - Keep the Clear/Vaciar action hidden while the playlist is empty.
  - Keep folder/file selection controls on the same horizontal row in the empty Playlist state.
  - Shorten selection labels to `Folder`/`File` in English and `Carpeta`/`Archivo` in Spanish.
  - Evidence: updated `public/app.js` localized selection labels; `#clearPlaylistButton` remains hidden in initial HTML and gated by `updateControls()` when `state.items.length === 0`; `.playlist-actions` remains flex-row. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3151 npm run web` readiness check passed after transient pre-readiness curl failures.

- [x] LV-016 — Preserve native hidden behavior under button flex styles
  - Ensure `hidden` elements stay visually hidden even when shared button styles set `display: inline-flex`.
  - Keep Clear/Vaciar invisible before files are loaded.
  - Evidence: added explicit `[hidden] { display: none !important; }` before shared button styles in `public/styles.css`. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3152 npm run web` readiness check passed after transient pre-readiness curl failures; response confirmed `#clearPlaylistButton` starts with `hidden`.

- [x] LV-017 — Make full playlist cards selectable
  - Allow selecting/changing videos by clicking anywhere inside a playlist card, not only the filename.
  - Preserve keyboard accessibility with a button covering the full card.
  - Keep existing active/watched/progress metadata display.
  - Evidence: changed playlist rendering so each `<li>` contains a full-width `.playlist-card-button` wrapping the index, title, watched label, and metadata; CSS moved grid/padding onto that button so the full card is clickable/focusable. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3153 npm run web` readiness check passed after transient pre-readiness curl failures. Manual browser click check remains pending.

- [x] LV-018 — Hide native video download control
  - Remove the redundant download option from the browser video controls menu for local playback.
  - Preserve native playback controls otherwise.
  - Evidence: added `controlsList="nodownload"` to `#videoPlayer` in `public/index.html`. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3154 npm run web` readiness check passed after transient pre-readiness curl failures and response included `controlsList="nodownload"`.

- [x] LV-019 — Increase pulsing starfield density
  - Add more tiny white points to the black background.
  - Make the points pulse by appearing and disappearing in staggered layers for a more space-like feel.
  - Keep reduced-motion fallback.
  - Evidence: expanded `body::before` and `body::after` star layers in `public/styles.css` to 37 irregular radial-gradient points and replaced smooth twinkle with stepped `pulse-stars-a`/`pulse-stars-b` opacity pulses. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3155 npm run web` readiness check passed. Manual visual check remains pending.

- [x] LV-020 — Densify starfield further and merge work to main
  - Increase visible pulsing point density because the starfield still looked too sparse.
  - Keep CSS-only star rendering and reduced-motion fallback.
  - Integrate the feature branch back into `main` because RDD is explicitly left pending in `/mnt/c`.
  - Evidence: increased `public/styles.css` star layers to 67 `radial-gradient(circle at ...)` points. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3156 npm run web` readiness check passed after transient pre-readiness curl failures. Merge evidence pending.

- [x] LV-021 — Replace CSS starfield with Canvas 2D particle network
  - Add a fixed background `<canvas>` behind the app UI.
  - Render many monochrome particles with slow movement.
  - Draw very thin low-opacity lines between nearby particles.
  - React subtly to cursor proximity without aggressive motion.
  - Respect `prefers-reduced-motion` with static or stopped animation behavior.
  - Remove or disable the previous CSS radial-gradient starfield to avoid duplicate effects.
  - Evidence: added fixed `#particleCanvas` in `public/index.html`; implemented dependency-free Canvas 2D particles, low-opacity neighbor lines, subtle pointer proximity displacement/brightness, and `prefers-reduced-motion: reduce` static-frame handling in `public/app.js`; replaced the old `body::before`/`body::after` CSS radial-gradient starfield with canvas positioning in `public/styles.css`. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3158 npm run web` readiness check passed after transient pre-readiness curl failures. Static readback/diff confirmed the canvas element/setup, reduced-motion handling, and old radial-gradient pseudo-element removal. Manual browser visual/reduced-motion checks remain pending.

- [x] LV-022 — Increase Canvas particles and cursor links
  - Increase Canvas particle density slightly.
  - Draw subtle connection lines from the cursor to nearby nodes.
  - Keep cursor response monochrome and non-aggressive.
  - Evidence: updated `getParticleCount()` to target 95–210 particles based on viewport area; added cursor-to-node line rendering for nearby influenced particles; increased cursor-proximity point brightness slightly. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3160 npm run web` readiness check passed after transient pre-readiness curl failures.

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
- 2026-09-18: Completed LV-010 latest selected-file activity restore; initial selection now compares exact selected-set, recent-active, and meaningful progress `updatedAt` records by recency before falling back to first-unwatched/index 0.
- 2026-09-18: Completed LV-011 dark cinematic visual refresh using CSS-only near-black background, subtle particle points, thin white borders, and accessible soft hover/focus glows.
- 2026-09-18: Completed LV-012 true-black visual refresh with CSS-only irregular twinkling white particle points and reduced-motion fallback.
- 2026-09-18: Completed LV-013 selection UI simplification by moving folder/file controls into the Playlist header, hiding status/count live compatibility elements, and removing visible choose-videos, supported-extensions, selected-status, and playlist-count copy.
- 2026-09-18: Completed LV-014 adaptive Playlist actions: empty state centers folder/file controls, loaded state switches to icon-only header controls, and Clear/Vaciar empties only the current list/player state without deleting progress.
- 2026-09-18: Completed LV-015 selection label tightening: empty-state buttons remain horizontal, Clear/Vaciar stays hidden until files are loaded, and labels are shortened to Folder/File and Carpeta/Archivo.
- 2026-09-18: Completed LV-016 hidden-attribute CSS fix so Clear/Vaciar remains hidden before files are loaded despite shared `display: inline-flex` button styling.
- 2026-09-18: Completed LV-017 full-card playlist selection by making each playlist row a full-width button instead of limiting selection to the filename text.
- 2026-09-18: Completed LV-018 native video controls cleanup by adding `controlsList="nodownload"` to the local video element.
- 2026-09-18: Completed LV-019 starfield density/pulse refresh with more irregular points and stepped appearing/disappearing layers.
- 2026-09-18: Completed LV-020 additional starfield density increase to 67 CSS points and prepared integration back to `main` because RDD is explicitly pending for this `/mnt/c` worktree.
- 2026-09-20: Completed LV-021 Canvas 2D particle network background, replacing the CSS radial-gradient pseudo-element starfield while keeping the dark monochrome UI and reduced-motion static fallback.
- 2026-09-20: Completed LV-022 Canvas particle density and cursor-link enhancement so nearby nodes visibly connect to the pointer.

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
- `node --check public/app.js` — passed after LV-010 changes.
- `PORT=3140 npm run web` with `curl -fsS http://127.0.0.1:3140/` readiness check — passed after one transient pre-readiness curl failure.
- Parent LV-010 spot check: `node --check server.js`, `node --check public/app.js`, and `PORT=3141 npm run web` readiness check passed.
- Independent LV-010 verifier: `node --check public/app.js` and `PORT=3142 npm run web` readiness check passed; verifier confirmed timestamp-first restore across exact session, recent-active, and meaningful progress; progress with `currentTime === 0` and not watched is ignored; source-less initial restore does not write last-active; skip and mark-watched behavior remains intact. Browser-manual checks remain pending.
- Independent LV-007 verifier: `node --check public/app.js` and `PORT=3132 npm run web` readiness check passed; verifier confirmed the IndexedDB `sessions` store, deterministic selected-set key, remembered-active preference over first-unwatched fallback, and shared `playIndex` active-item persistence. Browser-manual checks remain pending.
- Independent LV-006 verifier: `node --check public/app.js` and `PORT=3129 npm run web` readiness check passed; verifier confirmed `Skip next` disables threshold watched completion, `Mark watched & next` explicitly marks watched, first-unwatched selection exists, and browser-language Spanish detection uses `es`/`es-*`. Browser-manual checks remain pending.
- Independent verifier: syntax checks passed and `PORT=3126 npm run web` readiness check passed; verifier reported implementation evidence for static path safety, playlist IDs, sorting, object URL lifecycle, auto-next/error behavior, and IndexedDB logic. Browser-manual checks remain pending.
- Static readback of `public/styles.css` — passed for CSS syntax plausibility after LV-011 styling changes.
- `PORT=3143 npm run web` with `curl -fsS http://127.0.0.1:3143/` readiness check — passed after LV-011 styling changes.
- Static readback of `public/styles.css` — passed for CSS syntax plausibility after LV-012 styling changes.
- `PORT=3145 npm run web` with `curl -fsS http://127.0.0.1:3145/` readiness check — passed after one transient pre-readiness curl failure; server printed `Local video player available at http://127.0.0.1:3145` and the page responded.
- Parent LV-012 spot check: `node --check server.js`, `node --check public/app.js`, and `PORT=3146 npm run web` readiness check passed.
- Independent LV-012 verifier: `node --check server.js`, `node --check public/app.js`, and `PORT=3147 npm run web` readiness check passed; verifier confirmed true-black body background, CSS-only irregular pseudo-element particle layers, staggered twinkle animation, reduced-motion fallback, and preserved border/glow affordances. Browser-manual visual checks remain pending.
- `node --check server.js` — passed after LV-013 changes.
- `node --check public/app.js` — passed after LV-013 changes.
- `PORT=3148 npm run web` with `curl -fsS http://127.0.0.1:3148/` readiness check — passed after one transient pre-readiness curl failure; response included `#folderInput`, `#fileInput`, and visually hidden `#status`.
- Static readback/diff of `public/index.html`, `public/styles.css`, and `odd/tasks/local-video-player.md` — passed for LV-013 plausibility; confirmed the standalone choose-videos panel and visible supported/status/count copy were removed while script-facing DOM IDs remain present.
- `node --check server.js` — passed after LV-014 changes.
- `node --check public/app.js` — passed after LV-014 changes.
- `PORT=3149 npm run web` with `curl -fsS http://127.0.0.1:3149/` readiness check — passed after transient pre-readiness curl failures; response included `#playlistPanel`, `#folderInput`, `#fileInput`, and `#clearPlaylistButton`.
- Independent LV-014 verifier: `node --check server.js`, `node --check public/app.js`, and `PORT=3150 npm run web` readiness check passed; verifier confirmed empty-state centering classes, loaded icon-only CSS/state toggles, Clear/Vaciar behavior does not delete IndexedDB records, stable folder/file input IDs, and hidden status/count copy. Manual browser checks remain pending.
- `node --check server.js` — passed after LV-015 changes.
- `node --check public/app.js` — passed after LV-015 changes.
- `PORT=3151 npm run web` with `curl -fsS http://127.0.0.1:3151/` readiness check — passed after transient pre-readiness curl failures; response confirmed `#clearPlaylistButton` starts with `hidden` and folder/file controls remain in `.playlist-actions`.
- `node --check server.js` — passed after LV-016 changes.
- `node --check public/app.js` — passed after LV-016 changes.
- `PORT=3152 npm run web` with `curl -fsS http://127.0.0.1:3152/` readiness check — passed after transient pre-readiness curl failures; response confirmed `#clearPlaylistButton` starts with `hidden`, and CSS now explicitly preserves `[hidden]` display behavior.
- `node --check server.js` — passed after LV-017 changes.
- `node --check public/app.js` — passed after LV-017 changes.
- `PORT=3153 npm run web` with `curl -fsS http://127.0.0.1:3153/` readiness check — passed after transient pre-readiness curl failures.
- `node --check server.js` — passed after LV-018 changes.
- `node --check public/app.js` — passed after LV-018 changes.
- `PORT=3154 npm run web` with `curl -fsS http://127.0.0.1:3154/` readiness check — passed after transient pre-readiness curl failures; response included `controlsList="nodownload"`.
- `node --check server.js` — passed after LV-019 changes.
- `node --check public/app.js` — passed after LV-019 changes.
- `PORT=3155 npm run web` with `curl -fsS http://127.0.0.1:3155/` readiness check — passed after LV-019 starfield changes.
- `node --check server.js` — passed after LV-020 changes.
- `node --check public/app.js` — passed after LV-020 changes.
- `PORT=3156 npm run web` with `curl -fsS http://127.0.0.1:3156/` readiness check — passed after transient pre-readiness curl failures; `public/styles.css` now contains 67 `radial-gradient(circle at ...)` star points.
- `node --check server.js` — passed after LV-021 changes.
- `node --check public/app.js` — passed after LV-021 changes.
- `PORT=3158 npm run web` with `curl -fsS http://127.0.0.1:3158/` readiness check — passed after transient pre-readiness curl failures; response included `id="particleCanvas"`.
- Static readback/diff of `public/index.html`, `public/app.js`, and `public/styles.css` — passed for LV-021 plausibility; confirmed fixed `#particleCanvas`, Canvas 2D setup, particle animation loop, thin line drawing, pointer proximity handling, `prefers-reduced-motion: reduce` static-frame behavior, and removal of old CSS `body::before`/`body::after` radial-gradient starfield rules.
- `node --check server.js` — passed after LV-022 changes.
- `node --check public/app.js` — passed after LV-022 changes.
- `PORT=3160 npm run web` with `curl -fsS http://127.0.0.1:3160/` readiness check — passed after transient pre-readiness curl failures; response included `id="particleCanvas"`.

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
- Select `[video1, video2, video3]`, advance to and save progress on `video3`, then select subset `[video2, video3]` and confirm `video3` is selected when its progress/recent activity is newest among the subset.
- Confirm `Skip next` saves current progress but does not mark the item watched, including near the end of a video.
- Confirm `Mark watched & next` marks the current item watched and advances.
- Confirm Spanish browser languages (`es`/`es-*`) show Spanish UI/status/error copy, while other languages show English.
- Visually confirm LV-011 styling in a browser: near-black background is not pure black, particles stay subtle/clean, thin white borders are visible without clutter, and hover/focus glows are soft and accessible.
- Visually confirm LV-012 styling in a browser: background is true black, particle positions feel irregular rather than grid-like, twinkle remains subtle over video, thin borders/glows are preserved, and reduced-motion disables twinkle.
- Visually confirm LV-013 layout in a browser: there is no standalone choose-videos panel, only the Playlist header shows `Select folder` and `Select files`, and no supported-extensions, selected-videos/status, or playlist-count copy is visible.
- Manually confirm LV-013 file picking: `Select folder` and `Select files` still open pickers and populate the playlist.
- Visually confirm LV-014 layout in a browser: empty Playlist panel centers selection controls horizontally/vertically, loaded Playlist header shows folder/files/clear controls as icons, and the icon buttons remain understandable through hover/focus/assistive labels.
- Manually confirm LV-014 Clear/Vaciar empties the visible playlist/player without deleting saved progress; reselecting the same files should still restore prior progress.
- Manually confirm LV-017 playlist interaction: clicking anywhere in a playlist card, including empty space or metadata, selects that video.
- Manually confirm LV-018 browser behavior: the native video controls menu no longer shows a download option in supported browsers.
- Visually confirm LV-019 starfield: more points are visible, the pulse feels like points appearing/disappearing, and it stays subtle over video playback.
- Visually confirm LV-021/LV-022 Canvas background in a browser: monochrome particles are dense enough, motion is slow/smooth, connecting lines stay thin/low-opacity, cursor-to-node links appear near the pointer, and video/player UI behavior remains unchanged.
- Manually confirm LV-021 reduced-motion behavior: with `prefers-reduced-motion: reduce`, the canvas renders a static frame without constant particle movement.

## Next Step
Run the pending manual browser checks with representative local video files, prioritizing the LV-021 Canvas particle visual/reduced-motion review, LV-014 adaptive actions/Clear behavior, LV-010 subset progress restore, LV-009 no-auto-persist, and legacy-exact-vs-newer-recent restore scenarios.
