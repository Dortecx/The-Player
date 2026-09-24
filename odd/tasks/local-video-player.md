# Local Video Player — ODD Tasks

## Objective
Build a portable-friendly local web video player that runs with Node during development via `npm run web`, lets the user select a folder or multiple video files, plays them sequentially, and persists playback progress/watched state in IndexedDB.

## Problem
The user currently opens each episode/video manually in the browser, then closes/switches tabs for the next file. The app should provide one local playlist session and automatically continue to the next video.

## Why
A simple local web app solves the immediate workflow without requiring FFmpeg, transcodification, or a full media library. Portable packaging now provides a Windows ZIP path while preserving the development runtime.

## Scope
- Node local static server for development.
- Browser UI with folder/file selection.
- Playlist sorted by relative path/name.
- HTML video playback with automatic next item.
- IndexedDB persistence for progress and watched state.
- Basic unsupported-format/error handling.
- Initial formats: `.mp4`, `.mkv` best-effort, `.webm`, `.m4v`, `.mov`.

## Non-goals
- Additional portable targets beyond the current Windows ZIP/build script.
- FFmpeg, remuxing, transcoding, or embedded MKV subtitle extraction.
- User accounts, remote streaming, or media-library indexing outside the selected local files.
- Work-unit commits unless the user explicitly authorizes commits.

## Constraints
- Conversation is Spanish; technical artifacts and UI copy default to English.
- The Windows portable target should not require the end user to run `npm install`; development validation still uses the local Node runtime.
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

- [x] LV-023 — Boost particle network visibility
  - Increase particle density further.
  - Increase node-to-node connection distance and line opacity.
  - Increase cursor-to-node connection distance and line opacity.
  - Keep the effect monochrome, technical, and not neon.
  - Evidence: updated Canvas parameters to target 130–280 particles, 165px node-link distance, 240px cursor-link distance, thicker/brighter strokes, stronger cursor influence, and brighter influenced nodes. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3161 npm run web` readiness check passed after transient pre-readiness curl failures.

- [x] LV-024 — Add dormant cursor-activated particles
  - Reduce passive network line density and opacity when the cursor is not nearby.
  - Add hidden/dormant particles that activate visually only near the cursor.
  - Increase local node/line activation around the cursor.
  - Keep the effect monochrome and readable over the player UI.
  - Evidence: updated Canvas particle generation to target 170–360 particles with 38% dormant nodes; dormant nodes stay nearly invisible until pointer influence exceeds threshold; node-to-node connection range/opacity now scales with cursor activity; cursor-to-node links use only visible/activated nodes. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3162 npm run web` readiness check passed after transient pre-readiness curl failures.

- [x] LV-025 — Refine passive particle activity and playlist action morphs
  - Connect passive background nodes to up to two nearby nodes very subtly.
  - Increase node and link intensity around the active cursor area.
  - Wake dormant nodes near the cursor.
  - Morph playlist action buttons from compact icon-only controls to text labels on hover/focus/focus-within.
  - Evidence: parent updated `public/app.js` Canvas behavior so passive node-to-node links remain subtle, cursor-proximate nodes/links intensify, and dormant nodes wake near the pointer; this update changed `public/styles.css` so folder/file/clear playlist action buttons default to compact icon-only controls, expand on hover/focus/focus-within, hide the icon while showing the text label, and preserve native `[hidden]` behavior for Clear/Vaciar. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3163 npm run web` readiness check passed after transient pre-readiness curl failures. Static readback/diff confirmed `.playlist-action-button` morph CSS and this task log entry.

- [x] LV-026 — Apply morph controls to transport and lift passive links
  - Make Previous, Skip next, and Mark watched & next compact icon-only transport buttons by default.
  - Expand transport buttons on hover/focus/focus-within, hide the SVG icon, and reveal localized text without letting static i18n overwrite the button structure.
  - Keep accessible compact-state labels through `data-i18n-aria-label` on the button roots.
  - Increase passive Canvas node-link opacity slightly while keeping links monochrome and subtle.
  - Evidence: added SVG/icon-plus-`.button-text` transport button structure in `public/index.html`; moved transport text i18n onto inner spans and aria labels onto button roots; extended morph CSS in `public/styles.css` to `.transport-action-button`; adjusted passive background line opacity in `public/app.js`. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3165 npm run web` readiness check passed after one transient pre-readiness curl failure. Static diff/readback confirmed compact transport morph CSS, inner localized text spans, aria-label i18n on button roots, and passive link alpha increase.

- [x] LV-027 — Lift passive Canvas links and animate Clear empty transition
  - Increase passive distant Canvas node-to-node link alpha moderately while keeping the network monochrome and behind the foreground UI.
  - Make Clear/Vaciar transition from populated Playlist header to centered empty selection controls feel animated instead of snapping.
  - Keep `clearPlaylist()` limited to current in-memory playlist/player/input state and do not delete progress/session/recentActive records.
  - Evidence: increased passive link alpha in `public/app.js` from `0.012 + proximity * 0.035` to `0.018 + proximity * 0.047`; added a deterministic transient `is-clearing` class for Clear/Vaciar; added CSS transitions/settle animation for `.playlist-panel`, `.playlist-header`, `.playlist-actions`, and `.playlist` with reduced-motion fallback. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3167 npm run web` readiness check passed. Static diff/readback confirmed the alpha boost and empty/has-items transition styling/class behavior. Manual visual checks remain pending.

- [x] LV-028 — Bound Canvas particle placement with jittered cells
  - Replace purely random initial Canvas particle positions with viewport-scaled cell placement plus randomized jitter.
  - Keep particle count, dormant nodes, cursor activation, movement/wrapping, passive links, and reduced-motion static-frame behavior intact.
  - Avoid a visible regular grid by jittering each particle within its cell instead of centering it.
  - Evidence: `createParticles()` now derives rows/columns from viewport aspect ratio and particle count, places one particle per occupied cell with 16%–84% random jitter, and passes those positions into the existing particle factory while preserving velocity/alpha/radius/dormant randomness. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3169 npm run web` readiness check passed after one transient pre-readiness curl failure. Static diff/readback confirmed Canvas initialization now uses jittered cell distribution instead of `Math.random() * width/height`. Manual visual check remains pending.

- [x] LV-029 — Add Windows portable packaging
  - Add a Windows PowerShell build that stages a portable ZIP under `portable-win/`.
  - Package only `package.json`, `server.js`, `public/`, `README.md`, a Windows `runtime/node.exe`, and rendered `start.cmd` from `scripts/start.cmd.template`.
  - Refuse to overwrite an existing ZIP and require Node >=18 on the build machine.
  - Add `npm run build:portable:win`, ignore generated `portable-win/`, and document portable build/use without `npm install`.
  - Evidence: added `scripts/build-portable-win.ps1`, package script, README portable section, and `.gitignore` entry. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3171 npm run web` readiness check passed after one transient pre-readiness curl failure. PowerShell parser check was not available in this Linux/WSL environment because neither `pwsh` nor `powershell.exe` was found. Static readback/diff confirmed the script copies only explicit app/runtime assets, refuses an existing ZIP, requires Node >=18, and leaves Windows build execution/manual launcher checks pending.

- [x] LV-030 — Align Windows portable packaging with versioned release layout
  - Derive release name from `package.json` as `The-Player-<version>-windows`.
  - Keep default output directory `portable-win/` and write `portable-win/The-Player-<version>-windows.zip`.
  - Stage under Windows `%TEMP%` with a version/PID-specific directory and make the ZIP root folder match the release name.
  - Clean up only the version/PID-specific temp stage root in `finally` while preserving the explicit asset copy list, bundled `runtime/node.exe`, no end-user `npm install`, and no packaged `node_modules`.
  - Evidence: updated `scripts/build-portable-win.ps1` and README portable packaging docs. `node --check server.js` passed. `node --check public/app.js` passed. PowerShell parser check was not available in this Linux/WSL environment because neither `pwsh` nor `powershell.exe` was found. Static readback/diff confirmed versioned release name/ZIP/root folder, `%TEMP%` staging as `the-player-<version>-$PID`, output root creation before compression, explicit asset copy list, bundled `runtime/node.exe`, and scoped `finally` cleanup. Windows build execution/manual launcher checks remain pending.

- [x] LV-031 — Set Windows portable release version to 1.0.0
  - Set `package.json` version to `1.0.0` so the derived release name is `The-Player-1.0.0-windows`.
  - Document the concrete `portable-win/The-Player-1.0.0-windows.zip` path and `The-Player-1.0.0-windows/` release root in README.
  - Keep Windows manual checks pending for ZIP creation, overwrite refusal, ZIP contents, and launcher behavior on a Windows host.
  - Evidence: updated `package.json`, README release examples, and this task log. `node --check server.js` passed. `node --check public/app.js` passed. PowerShell parser check was not available in this Linux/WSL environment because neither `pwsh` nor `powershell.exe` was found. Static readback/diff confirmed version `1.0.0`, derived release name usage in `scripts/build-portable-win.ps1`, concrete README 1.0.0 ZIP/root examples, `%TEMP%` version/PID staging, scoped cleanup, explicit asset copy list, bundled `runtime/node.exe`, and no `node_modules` packaging.

- [x] LV-032 — Align README structure with El Exportador style and add Spanish README
  - Rewrite `README.md` to mirror the El Exportador README structure while fitting The Player.
  - Add `README.es.md` with the same structure in Spanish and reciprocal language links.
  - Lead with the downloadable Windows release ZIP path, preserve source/build paths, document local File API/object URL/IndexedDB flow with Mermaid, and clarify codec/MKV/license limitations.
  - Evidence: `README.md` and `README.es.md` now include title, language link, product description, features, requirements, setup choices, Windows portable download/build/run, Windows source checkout, WSL/Linux source checkout, Mermaid how-it-works, usage, platform support, and license-not-declared text because no LICENSE file exists. `node --check server.js` passed. `node --check public/app.js` passed. Static readback/diff confirmed README structure and Spanish counterpart.

- [x] LV-033 — Add MIT license, favicon, and keyboard shortcuts
  - Add a project MIT license with Dortecx as copyright holder.
  - Add a self-contained monochrome SVG favicon and link it from the main page.
  - Add global keyboard shortcuts for play/pause, seek, previous/skip/watched-next, fullscreen, and volume while preserving typing/native control behavior and preventing page scroll for handled keys.
  - Document the MIT license and shortcuts in English and Spanish READMEs.
  - Evidence: added `LICENSE`, `public/favicon.svg`, favicon link in `public/index.html`, shortcut handler/fullscreen helpers in `public/app.js`, and bilingual README updates. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3175 npm run web` readiness check passed after one transient pre-readiness curl failure. Static readback/diff confirmed favicon link, shortcut code, and README MIT/license text. Manual browser shortcut testing remains pending.

- [x] LV-034 — Prepare release version 1.1.0
  - Set `package.json` version to `1.1.0` so generated release names derive as `The-Player-1.1.0-windows`.
  - Update current English and Spanish README release references to the v1.1.0 tag, ZIP, ZIP root folder, build output path, and Windows platform support text.
  - Preserve historical ODD evidence for the prior v1.0.0 preparation without rewriting old evidence.
  - Evidence: updated `package.json`, `README.md`, `README.es.md`, and this task log. `node --check server.js` passed. `node --check public/app.js` passed. Static grep/readback confirmed current docs and package metadata reference v1.1.0/`The-Player-1.1.0-windows` and no current README/package v1.0.0 release references remain.


- [x] LV-034 — Prepare v1.1.0 release
  - Bump package version to `1.1.0` for the release containing MIT license, favicon, and keyboard shortcuts.
  - Update current README download/build references from `v1.0.0` / `The-Player-1.0.0-windows.zip` to `v1.1.0` / `The-Player-1.1.0-windows.zip`.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. Static readback confirmed current README release URLs and portable ZIP/root examples point at `v1.1.0`.

- [x] LV-035 — Add Wake Lock and playlist search filter
  - Keep supported screens awake during active video playback and release the lock on pause/end/clear/page hide/unload.
  - Add a compact localized Playlist search field that filters only the rendered list without changing saved state, active index, order, or previous/next behavior.
  - Evidence: added localized `#playlistSearch` UI and empty-state copy, render-only relative-path filtering, search reset on new load/clear, and Screen Wake Lock acquire/release handling in `public/app.js`. `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3179 npm run web` readiness check passed after one transient pre-readiness curl failure. Static grep/readback confirmed search input/copy/styles, wake lock functions/listeners, and README updates. Manual browser checks remain pending.


- [x] LV-036 — Prepare v1.2.0 release
  - Bump `package.json` and `package-lock.json` to `1.2.0` and align package lock license metadata with MIT.
  - Update current README download/build references from `v1.1.0` / `The-Player-1.1.0-windows.zip` to `v1.2.0` / `The-Player-1.2.0-windows.zip`.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. Static readback confirmed package and README release references point at `v1.2.0`.

- [x] LV-037 — Bound playlist, video-only fullscreen, and custom controls
  - Keep loaded playlists inside a bounded panel with internal scrolling while preserving the empty centered picker state and search-only filtering.
  - Replace native video controls with custom dark controls for play/pause, time, seeking, mute/volume, and fullscreen.
  - Target fullscreen at the dedicated video frame so page headings, transport controls, and playlist are excluded; keep video `object-fit: contain`.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `PORT=3181 npm run web` readiness check passed after one transient pre-readiness curl failure. Static grep/readback confirmed no native `<video controls>` dependency, `#videoFrame` fullscreen target, custom control IDs/classes, and playlist internal scroll CSS. Manual browser controls/fullscreen/large-playlist checks remain pending.

- [x] LV-038 — Fit empty player layout to real 1080p viewport
  - Keep the 2K width improvement while capping the video/player height against the actual browser viewport instead of theoretical screen height.
  - Restore empty Playlist panel alignment so its heading and picker actions center vertically/horizontally and the panel stretches with the player.
  - Refine custom video controls into a slimmer monochrome bottom bar and keep fullscreen disabled until a video is loaded.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static readback confirmed viewport-capped video frame, stretched empty Playlist panel, slim custom control bar, and fullscreen disabled until a video exists.

- [x] LV-039 — Use single-screen player layout and auto-hide playback controls
  - Treat the app as a useful viewport-height layout so the page itself does not need vertical scrolling in normal 1080p browser windows.
  - Keep empty Playlist content centered and loaded Playlist cards compact with internal list scrolling.
  - Move video controls into an overlay bottom bar that hides during playback and reappears on pointer movement or control focus, not on keyboard shortcuts alone.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static readback confirmed `100svh` app/layout sizing, compact playlist list alignment, overlay video controls, and pointer-driven controls visibility.

- [x] LV-040 — Center playlist rows and expanded action labels
  - Vertically center loaded playlist row content inside compact cards.
  - Remove the apparent left offset from expanding icon-to-label action buttons by letting expanded label text occupy the center after the icon collapses.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static CSS readback confirmed centered playlist card alignment and expanded action labels centered after icon collapse.

- [x] LV-041 — Show fullscreen volume feedback
  - Display a temporary, readable numeric volume indicator in the upper-right video corner whenever volume changes during fullscreen playback.
  - Keep playback controls hidden; the indicator expires independently and does not change control visibility.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static readback confirmed fullscreen-gated temporary output with a 1400ms timeout and no controls-visibility mutation.

- [x] LV-042 — Preserve a cinematic video frame on 2K displays
  - Limit the player frame to a 16:9 cinematic proportion so surplus viewport height cannot turn the player into a visually square container.
  - Add moderate extra side margin while retaining a fluid large-monitor layout.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static CSS readback confirmed 16:9 player geometry, viewport cap, and `87vw` maximum shell width.

- [x] LV-043 — Prepare and publish v1.3.0 portable release
  - Bump package metadata and current bilingual README download/build references to v1.3.0.
  - Build and verify the Windows portable ZIP, then create the tag and public GitHub Release with evidence-based release notes.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. Windows PowerShell created `portable-win/The-Player-1.3.0-windows.zip`; archive contents include `start.cmd`, `app/package.json`, `app/server.js`, `app/README.md`, `app/public/*`, and `runtime/node.exe`, with no `node_modules` or repository metadata. A repeat build refused overwrite. Extracted `start.cmd` launched the bundled runtime and returned HTTP 200 at `127.0.0.1:3000`; temporary smoke staging was cleaned. SHA-256: `79A333F3171DA89B0A1CA426A6F5F96AA1B1A2F1DBF4E12C69262619EA906465`.

- [x] LV-044 — Experiment with cinematic volume feedback and integrated controls
  - Refine the custom control bar to match the monochrome particle-network environment without sacrificing contrast or keyboard/focus usability.
  - Replace abrupt fullscreen volume percentage visibility with an isolated local 3D block reveal/conceal animation; honor reduced-motion preferences.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static readback confirmed generated local volume blocks, separate reveal/conceal timers, 3D CSS transforms, and a reduced-motion fallback without blocks. Manual browser acceptance remains pending.

- [x] LV-045 — Slow and foreground the volume block transition
  - Remove the static indicator-card reading so blocks, not a permanent rectangle, are the dominant fullscreen feedback form.
  - Increase block count/scale/depth and delay numeric reveal until the block tunnel disperses; extend reveal/conceal timings for perceptibility.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static readback confirmed 12 large/deep blocks, 1080ms reveal, delayed numeric reveal, 720ms conceal, a 1850ms hold, and reduced-motion opacity fallback. Manual browser acceptance remains pending.

- [x] LV-046 — Assemble/disperse volume blocks and float controls
  - Model the volume feedback as explicit scatter-in, assemble, value-visible, value-hidden, collapse, scatter-out, and hidden phases matching the user diagram.
  - Make the custom video control bar a slim floating dock over the video rather than a full-width bottom strip.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static readback confirmed explicit phase timers and class transitions for scatter/assemble/value/collapse/disperse plus a floating `28rem` maximum-width control dock. Manual browser acceptance remains pending.

- [x] LV-047 — Prevent playback toggle races and progress repaint churn
  - Serialize play/pause toggles so a second action cannot interrupt an unresolved `video.play()` request.
  - Replace full control-state updates on every `timeupdate` with a lightweight seek/time display update.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static readback confirmed pending-toggle gating around `video.play()` and `timeupdate` calling only `updateVideoProgress()`. Manual browser playback acceptance remains pending.

- [x] LV-048 — Remove fullscreen compositing pressure and make volume phases visible
  - Avoid costly blurred/composited control styling while the video frame is fullscreen.
  - Use a normal indicator container and visibly stage initial volume blocks so the phase flow can render reliably.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static readback confirmed fullscreen dock blur removal, normal status container markup, visible scatter transform, and a request-animation-frame phase start. Manual fullscreen playback and indicator acceptance remain pending.

- [x] LV-049 — Refine volume frame and update visible values in place
  - Arrange smaller blocks as a readable irregular frame around, not over, the numeric value.
  - When the value is already visible, update it and extend visibility without replaying block phases.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static readback confirmed compact perimeter block blueprints, value-above-block layering, and visible-phase updates extending only the exit timer. Manual fullscreen indicator acceptance remains pending.

- [x] LV-050 — Converge volume blocks into a continuous modular contour
  - Let block growth/arrival vary independently while mapping every final block to an exact shared-cell position in an irregular continuous frame.
  - Prevent final overlap and disconnected floating pieces around the numeric value.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`. Static readback confirmed shared-cell final coordinates, non-overlapping unit modules, independent delays/scales/durations, and a common continuous contour target. Manual fullscreen visual acceptance remains pending.

- [x] LV-051 — Fill the volume indicator with a modular background
  - Animate independently growing square modules into a filled, irregular background behind the volume value, rather than a perimeter-only frame.
  - Preserve in-place number updates while the indicator remains visible.
  - Evidence: replaced the perimeter blueprint with 43 contiguous square modules across six uneven rows, forming one filled irregular silhouette behind the value; each module receives deterministic independent scatter, scale, delay, and duration values. The existing visible-phase path still updates only the number and reschedules exit. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` started successfully and `curl -fsS http://127.0.0.1:3181/` passed on the first attempt. Manual fullscreen visual acceptance remains pending.

- [x] LV-052 — Build a seamless variable-module volume plate
  - Cover the complete volume value background with varied module sizes rather than a uniform grid.
  - Hide internal seams so only the outer silhouette reads as a contour.
  - Evidence: replaced the uniform square grid with 17 independently timed rectangular modules that tile a 10×7 plate behind the value; modules have no internal borders, while a single subtle outer contour defines the silhouette. The visible-phase path remains unchanged, so the number updates in place while active. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`.

- [x] LV-053 — Add an organic modular silhouette around the volume plate
  - Preserve a fully filled rectangular core behind the number.
  - Add varied exterior modules around its edges so the final outer contour remains irregular without internal gaps.
  - Evidence: replaced the tiled plate with one solid 6.8rem × 4.76rem rectangular core behind the value and 12 varied rectangular exterior modules, each joined only to a core edge. The modules retain deterministic independent scatter, start-scale, delay, and duration values; the former inner rectangular outline is replaced with a subtle composite-only outer drop shadow, leaving no internal seams or borders. The visible-phase update path and fullscreen guard remain unchanged. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/`.

- [x] LV-054 — Remove interior seams from the organic volume plate
  - Overlap exterior modules with the filled core enough to avoid fractional-pixel seams at their joins.
  - Retain only the external silhouette definition.
  - Evidence: shifted the three top and three bottom exterior-module final coordinates 0.12rem inward, creating a deliberate ~0.1rem overlap with the unchanged 6.8rem × 4.76rem core on every attached edge; existing left/right modules retain their 0.1rem overlap. The composite-only outer drop shadow remains the sole visible definition. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/` after one initial connection-refused probe.

- [x] LV-055 — Fully cover core edges with attached exterior modules
  - Cover every core edge continuously with exterior modules that overlap the core, eliminating real gaps and rasterization seams.
  - Keep irregular protrusions outside that continuous attachment layer.
  - Evidence: added four continuous attachment modules around the unchanged 6.8rem × 4.76rem core; each overlaps the corresponding edge by about 0.1rem and together covers every edge and corner. Repositioned the varied exterior modules beyond that layer, retaining the jagged silhouette. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` started successfully and `curl -fsS http://127.0.0.1:3181/` returned the page.

- [x] LV-056 — Refine the floating playback dock and seek affordance
  - Replace the text-only volume affordance with a speaker SVG and improve vertical rhythm in the floating controls.
  - Render played seek progress and a clear scrubber thumb inside a thicker, visually integrated track.
  - Evidence: replaced the `VOL` text with an inline monochrome speaker SVG while retaining the JS mute/unmute aria-label updates; rebuilt the floating dock as a padded two-tier control surface with an integrated seek row and action row. `updateVideoProgress()` now writes `--seek-progress`, which styles elapsed/remaining track states and a circular thumb in WebKit and Firefox while retaining the native range element. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/` after one initial connection-refused probe.

- [x] LV-057 — Compact volume control and use SVG playback icons
  - Keep volume compact until its speaker control is hovered or focused, then reveal the range with a button-like transition.
  - Replace typographic play/pause glyphs with semantic inline SVG icons.
  - Evidence: wrapped the existing speaker button and volume range in a focusable-within volume control that keeps only the speaker visible by default, then smoothly expands the range on hover or keyboard focus while retaining pointer interactivity. Replaced the typographic play/pause update with inline monochrome SVG paths; `updateVideoControls()` now synchronizes the `is-playing` icon state and the Play/Pause accessible label. The small-screen expansion remains bounded. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/` after one initial connection-refused probe.

- [x] LV-058 — Render revealed volume range and preserve intentional audio state
  - Style the expanded volume range's track and thumb so it is visibly interactive.
  - Carry only explicit user mute intent across source changes; prevent stale media-element mute state from silently suppressing audio.
  - Evidence: added dark monochrome WebKit and Firefox tracks, visible progress treatment, compact thumbs, and range focus styling. `userMuted` and `userVolume` now record only intentional mute/volume actions; each `playIndex()` synchronizes the source to that intent, preserving positive volume by default, intentional mute, and intentional zero volume. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/` after one initial connection-refused probe. Manual browser audio/visual checks remain pending.

- [x] LV-059 — Optically center the expanded volume slider
  - Normalize native range box metrics so its track/thumb center aligns with the speaker icon.
  - Evidence: normalized the range as a centered block with zero margin/padding, a capsule-height box, and middle vertical alignment; shifted the native slider optical center up 1px and corrected the WebKit thumb offset while preserving the existing width/opacity transition, track, focus styling, and Firefox rendering. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/` after one initial connection-refused probe.

- [x] LV-061 — Balance expanded volume control edge padding
  - Give the revealed range/thumb the same breathing room from the right capsule edge as the speaker has from the left edge.
  - Evidence: reserved a `0.7rem` right edge inset for the revealed range and reduced its animated width by that same amount, preserving the combined capsule width, existing expansion behavior, vertical alignment, and visible track/thumb. `git diff --check` passed. `PORT=3181 npm run web` started successfully and `curl -fsS http://127.0.0.1:3181/` passed after one initial connection-refused readiness probe.

- [x] LV-062 — Replace final volume modules with one seamless silhouette
  - Use individual modules only during assembly, then transition to one opaque final plate with the organic outer contour.
  - Eliminate every interior seam while preserving the outer silhouette definition and numeric foreground.
  - Evidence: added a single opaque inline SVG silhouette plate with the existing core-and-jagged-edge contour. Blocks now scatter and assemble for up to 1040ms, then cross-fade beneath the plate before the numeric value appears; exit keeps the plate through number concealment, then restores blocks only for collapse/dispersal. Reduced motion skips directly to the plate/value without rendering blocks. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` readiness check passed with `curl -fsS http://127.0.0.1:3181/` after one initial connection-refused probe. Manual fullscreen visual acceptance remains pending.

- [x] LV-063 — Prepare v1.4.0 release source metadata and portable artifact
  - Update package metadata and current bilingual release/tag/download/archive documentation to v1.4.0.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. Windows PowerShell built `portable-win/The-Player-1.4.0-windows.zip`; archive allowlist contains only `start.cmd`, `app/package.json`, `app/server.js`, `app/README.md`, `app/public/*`, and `runtime/node.exe`. A second build refused overwrite. An extracted `start.cmd` launch with `THE_PLAYER_NO_OPEN=1` returned HTTP 200 from `127.0.0.1:3000`. SHA-256: `faf484ff563a12ecdfd396ab01d4afaa679309e721ad380fd7681e812d8d6542`. Product commit `2c00b5861863c199f42a24a7312f53a0621965f2` was tagged with annotated `v1.4.0`, pushed on `release/v1.4.0`, and published at `https://github.com/Dortecx/The-Player/releases/tag/v1.4.0` with the verified ZIP asset.

- [x] LV-064 — Make volume block assembly visibly progressive
  - Separate scattered-block reveal, independent block travel/assembly, and final silhouette handoff into distinct painted phases.
  - Prevent the final plate cross-fade from obscuring the block movement.
  - Evidence: added `phase-blocks-assembling` and double `requestAnimationFrame` separation so scattered blocks paint before independent travel/growth begins. Blocks stay visible for a 1020ms assembly window, exceeding the longest configured delay-plus-duration, before the SVG plate cross-fades in; the numeric value remains delayed until after handoff. Reduced motion goes directly to the plate/value fallback, while visible number-only updates, exit/dispersal, and the fullscreen guard remain unchanged. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` started and `curl -fsS http://127.0.0.1:3181/` readiness passed.

- [x] LV-065 — Match seamless volume plate to assembled module silhouette
  - Derive the final seamless silhouette from the actual final module geometry rather than a separate rigid approximation.
  - Cross-fade before seams dominate so the organic assembled shape transitions without a visible jump.
  - Evidence: centralized the final module rectangles in `VOLUME_BLOCK_BLUEPRINTS`; the same data now creates each animated block and traces its exposed union edges into one opaque SVG path, sized to the exact 10.86rem × 8.18rem module bounds with no internal seams. Added a `phase-plate-handoff` at 560ms, while modules are still moving, so the matching plate completes its 460ms cross-fade at the 1020ms assembled state; numeric reveal remains 180ms later. Reduced motion still goes straight to the plate/value and the existing exit/dispersal/fullscreen behavior remains intact. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` started and `curl -fsS http://127.0.0.1:3181/` readiness passed after one initial connection-refused probe. Manual fullscreen visual acceptance remains pending.

- [x] LV-066 — Prevent empty final plate before volume value
  - Keep the final SVG plate invisible until the module assembly visibly covers its shape.
  - Retain a short seamless handoff that avoids both blank-plate flashes and exposed module seams.
  - Evidence: delayed `phase-plate-handoff` from 560ms to 840ms, after the slowest 982ms module motion is visibly near its final position, and shortened the matching plate/block cross-fade to 180ms so it completes at the 1020ms assembled state. The shared geometry, reduced-motion direct plate/value fallback, visible numeric updates, and exit/dispersal behavior remain unchanged. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` started and `curl -fsS http://127.0.0.1:3181/` readiness passed after one initial connection-refused probe. Manual fullscreen visual acceptance remains pending.

- [x] LV-067 — Carry organic modular material through the full volume plate
  - Tessellate the core as varied modules, not one uniform rectangle, while preserving complete text coverage.
  - Render the final seamless SVG with matching subtle module variation across its full body, without interior seams or stroke lines.
  - Evidence: replaced the single 6.8rem × 4.76rem core with ten edge-aligned, varied modules that fully cover the numeric field while retaining the existing organic exterior modules. The final SVG now traces the same shared module union once, then clips low-opacity monochrome rectangle fills from that exact blueprint inside the seamless base path; the texture has no strokes or separate outline. Progressive scatter/assembly, late handoff, numeric reveal, reduced-motion plate/value fallback, exit/dispersal, and fullscreen guard remain unchanged. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` started and `curl -fsS http://127.0.0.1:3181/` readiness passed after one initial connection-refused probe. Manual fullscreen visual acceptance remains pending.

- [x] LV-068 — Prepare v1.4.1 release metadata
  - Bump package metadata and current bilingual release/tag/download/archive documentation from v1.4.0 to v1.4.1.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. Windows PowerShell built `portable-win/The-Player-1.4.1-windows.zip`; archive allowlist contains only `start.cmd`, `app/package.json`, `app/server.js`, `app/README.md`, `app/public/*`, and `runtime/node.exe`. An extracted `start.cmd` launch with `THE_PLAYER_NO_OPEN=1` returned HTTP 200 from `127.0.0.1:3000`. A second build refused overwrite. SHA-256: `6d919e3c279b9006201b1d2a32da8fab48d15dd8728945753d1031558cccb5af`. Product commit `f8a3d9ce6ad254fe10c895ed8228405487df14e1` was tagged with annotated `v1.4.1`, pushed on `main`, and published at `https://github.com/Dortecx/The-Player/releases/tag/v1.4.1` with the verified ZIP asset.

- [x] LV-069 — Bound large playlists and remove assembly overlap seams
  - Constrain only the desktop two-column layout to the viewport: the app shell, layout grid, player panel, and Playlist panel can shrink within the available row, while the Playlist panel fills it and only `.playlist` scrolls. Narrow stacked layouts retain normal document scrolling.
  - Make assembling modules use the opaque shared plate material and a minimal unblurred shared-color spread, removing fractional intersection/gap seams without exposing the final SVG plate early or changing its texture.
  - Evidence: `git diff --check` passed. `node --check public/app.js` passed. `PORT=3181 npm run web` started successfully and `curl -fsS http://127.0.0.1:3181/` readiness passed after one initial connection-refused probe. Manual desktop large-playlist and fullscreen volume-animation visual checks remain pending.

- [x] LV-070 — Keep playlist natural-sized and assembly modules fully opaque
  - Bound the desktop playlist with a maximum height without forcing an empty panel to player height.
  - Remove residual assembly opacity that reveals module joins.
  - Evidence: desktop `.playlist-panel` now top-aligns at natural height with `max-height: 100%` inside the viewport-bounded grid row, while the existing flexed `.playlist { overflow: auto; }` remains the scroll owner for overflow. Assembly blocks now use opacity `1` and no seam-covering shadow; motion, late plate handoff, and final texture remain unchanged. `git diff --check` passed. `node --check public/app.js` passed. `PORT=3181 npm run web` started successfully and `curl -fsS http://127.0.0.1:3181/` readiness passed after one initial connection-refused probe. Manual desktop short/large-playlist and fullscreen volume-animation visual checks remain pending.

- [x] LV-071 — Align playlist panel height and reveal value at plate handoff
  - Match the desktop playlist panel height to the player-determined layout row while retaining internal scrolling for large lists.
  - Remove the blank final-plate frame by beginning numeric value reveal with the plate handoff.
  - Evidence: restored desktop `.playlist-panel` stretch/`height: 100%` alignment within the existing finite grid row; `.playlist` remains the only scrolling element for large lists and mobile rules are unchanged. The numeric value now begins its existing opacity/scale transition in `phase-plate-handoff` with the final plate while `phase-value-visible`, reduced motion, exit, and in-place updates retain their prior behavior. `git diff --check` passed. `node --check public/app.js` passed. `PORT=3181 npm run web` started successfully and `curl -fsS http://127.0.0.1:3181/` readiness passed after one initial connection-refused probe. Manual desktop and fullscreen volume-animation visual checks remain pending.

- [x] LV-072 — Center empty playlist composition and make volume value monotonic
  - Keep the empty playlist panel aligned to player height while centering its useful heading/actions in the available space.
  - Remove the handoff state that hides an already-revealed volume value before final visibility.
  - Evidence: the empty `.playlist` no longer flexes into the panel's free space, allowing the existing auto-margined empty header/actions to remain centered while the desktop panel retains its full player-row height; populated-list scroll behavior is unchanged. Removed `phase-frame-assembled`; the value remains visible from `phase-plate-handoff` through `phase-value-visible` and exits through the existing conceal/collapse/disperse sequence. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` started successfully and `curl -fsS http://127.0.0.1:3181/` readiness passed on attempt 2 after one initial connection-refused probe. Manual desktop empty-state and fullscreen volume-animation checks remain pending.

- [x] LV-073 — Anchor player transport to the shared panel baseline
  - Use the player panel's flexible vertical space above transport so its controls sit at the same bottom inset as the corresponding playlist panel.
  - Preserve video frame geometry and internal playlist scrolling.
  - Evidence: desktop `.player-panel .transport` now uses `margin-top: auto`, consuming only the flexible space above the existing row so the controls retain the panel's normal bottom padding. The video frame, overlay controls, paired desktop panel heights, playlist scrolling, and mobile flow remain unchanged. `git diff --check` passed. `node --check public/app.js` passed. `PORT=3181 npm run web` started successfully and `curl -fsS http://127.0.0.1:3181/` readiness passed after one initial connection-refused probe. Manual desktop visual verification remains pending.

- [x] LV-074 — Sync desktop playlist height to the natural player panel
  - Remove artificial viewport-row height that creates dead space inside the player panel.
  - Measure and share the natural player panel height with playlist so columns align and large lists retain internal scroll.
  - Evidence: desktop layout now top-aligns natural-height panels without a viewport-sized grid row or transport bottom anchor. A `ResizeObserver` schedules player/layout measurements and shares `--player-panel-height` only at `min-width: 861px`; the property is cleared below that breakpoint. The populated playlist remains a fixed-height flex panel with `.playlist { overflow: auto; }`, while mobile keeps normal stacked flow. `node --check public/app.js` passed. `git diff --check` passed. `PORT=3181 npm run web` started successfully and `curl -fsS http://127.0.0.1:3181/` readiness passed after one initial connection-refused probe. Manual desktop paired-height/overflow and mobile stacked-flow verification remain pending.

- [x] LV-075 — Prepare v1.4.2 release metadata
  - Bump package metadata and current bilingual release/tag/download/archive/support documentation from v1.4.1 to v1.4.2.
  - Evidence: `node --check server.js` passed. `node --check public/app.js` passed. `git diff --check` passed. Windows PowerShell built `portable-win/The-Player-1.4.2-windows.zip`; archive allowlist contains only `start.cmd`, `app/package.json`, `app/server.js`, `app/README.md`, `app/public/*`, and `runtime/node.exe`. An extracted `start.cmd` launch with `THE_PLAYER_NO_OPEN=1` returned HTTP 200 from `127.0.0.1:3000`. A second build refused overwrite. SHA-256: `0a4cc07dbcdf046ad21ba4488889b8203d77e2b5246cd1fae04d6238a4ba6620`. Commit, tag, push, and publication remain pending.

## Acceptance Criteria
- Running `npm run web` starts a local server without requiring a framework dev server.
- The browser app can select a folder or multiple files.
- Videos are listed in a deterministic, human-friendly order.
- Selecting/playing one video works for browser-supported files.
- Ended playback advances to the next item.
- Progress and watched state persist in IndexedDB across reload/reselect.
- Unsupported playback errors are visible and do not crash the app.
- Windows portable packaging exists and still needs Windows manual validation.

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
- 2026-09-20: Completed LV-023 Canvas particle network visibility boost with more particles, longer connection distances, and brighter monochrome lines.
- 2026-09-20: Completed LV-024 dormant cursor-activated particle behavior so the passive background is quieter while nearby hidden nodes/links wake up around the cursor.
- 2026-09-20: Completed LV-025 passive particle/activity evidence and playlist action button morphs: parent `public/app.js` changes keep passive node-to-node network connects subtle, intensify the active cursor area, and wake dormant nodes near the cursor; CSS now makes playlist action buttons compact icon-only by default and text-only while expanded on hover/focus.
- 2026-09-20: Completed LV-026 transport action morphs and passive link visibility refinement: Previous, Skip next, and Mark watched & next now share the playlist compact-icon-to-expanded-text interaction without root `data-i18n`, and passive Canvas links are slightly more visible while remaining subtle.
- 2026-09-20: Completed LV-027 passive Canvas/clear-transition refinement: distant passive links are moderately more visible, and Clear/Vaciar now applies a short deterministic empty-state transition instead of snapping header controls directly to center.
- 2026-09-21: Completed LV-035 Wake Lock and playlist search: playback now requests Screen Wake Lock when supported and releases it on pause/end/clear/page hide/unload; Playlist now has a localized render-only search filter that resets on new selection/clear.
- 2026-09-21: Completed LV-028 jittered cell placement for Canvas particles so initial distribution covers the viewport more evenly while retaining randomized movement, dormant nodes, cursor activation, passive links, and reduced-motion behavior.
- 2026-09-21: Completed LV-029 Windows portable packaging script/docs so a Windows build machine can create a no-`npm install` ZIP with bundled `node.exe`, explicit app assets, and a double-click `start.cmd` launcher while generated artifacts stay ignored.
- 2026-09-21: Completed LV-030 Windows portable packaging alignment with the prior versioned release style: release name and ZIP derive from `package.json`, staging uses `%TEMP%` plus version/PID, the ZIP root matches the release name, and cleanup is limited to that temp stage root in `finally`.
- 2026-09-21: Completed LV-031 release version alignment by setting `package.json` to `1.0.0` and documenting the concrete `portable-win/The-Player-1.0.0-windows.zip` and `The-Player-1.0.0-windows/` portable release layout.
- 2026-09-21: Completed LV-032 README style alignment with the El Exportador structure and added `README.es.md` with reciprocal language links, release download/build/source setup paths, Mermaid flow, usage, platform support, and license-not-declared wording.
- 2026-09-21: Completed LV-033 MIT license, monochrome favicon, keyboard shortcuts, and bilingual documentation updates.
- 2026-09-21: Completed LV-034 release 1.1.0 preparation by bumping `package.json` to `1.1.0`, updating current bilingual README release/ZIP/root references to v1.1.0, and preserving historical v1.0.0 ODD evidence intact.
- 2026-09-21: Prepared v1.1.0 release metadata/docs for the MIT license, favicon, and keyboard shortcut release.
- 2026-09-21: Prepared v1.2.0 release metadata/docs for Wake Lock and playlist search, including package-lock version/license alignment.

- 2026-09-22: Completed LV-037 playlist bounds, video-frame fullscreen, and custom dark video controls; native `<video controls>` is no longer used for the main UI while `controlsList="nodownload"` remains.
- 2026-09-22: Completed LV-038 real-viewport layout correction so the empty player view fits better on 1080p browser windows, the empty Playlist panel stretches/centers with the player panel, custom controls are slimmer, and fullscreen is disabled until a video exists.
- 2026-09-22: Completed LV-039 single-screen layout correction: app shell/layout now use useful viewport height, Playlist empty/content states are centered/compact, video controls are overlayed and auto-hide during playback unless the pointer moves or controls receive focus.
- 2026-09-22: Completed LV-040 visual alignment polish for loaded Playlist rows and expanding action labels.
- 2026-09-22: Completed LV-041 fullscreen numeric volume feedback indicator.
- 2026-09-22: Completed LV-042 2K cinematic frame sizing and increased side margin.
- 2026-09-22: Prepared v1.3.0 portable ZIP with verified bundled Windows runtime, launcher readiness, archive allowlist, overwrite refusal, and SHA-256 digest.
- 2026-09-22: Completed LV-044 experimental cinematic volume indicator blocks and integrated custom control-bar treatment; manual visual acceptance remains pending.
- 2026-09-22: Completed LV-045 stronger, slower volume block transition with delayed numeric reveal and no fixed indicator card; manual visual acceptance remains pending.
- 2026-09-22: Completed LV-046 explicit volume block phase sequence and slim floating control dock; manual visual acceptance remains pending.
- 2026-09-22: Completed LV-047 playback race guard and lightweight timeupdate progress rendering.
- 2026-09-22: Completed LV-048 fullscreen compositing simplification and volume phase paint staging; manual fullscreen playback acceptance remains pending.
- 2026-09-22: Completed LV-049 compact irregular volume frame and in-place visible value updates; manual visual acceptance remains pending.
- 2026-09-22: Completed LV-050 shared-cell modular volume contour with independent growth/arrival timing; manual visual acceptance remains pending.
- 2026-09-22: Completed LV-052 seamless variable-module volume plate: independently timed rectangular modules now tile the complete value background without internal borders, with one subtle outer contour; manual fullscreen visual acceptance remains pending.
- 2026-09-22: Completed LV-053 organic volume silhouette: one solid rectangular core fully covers the value, while varied exterior-only modules make the monochrome outer contour jagged without internal seams; manual fullscreen visual acceptance remains pending.
- 2026-09-22: Completed LV-058 visible volume range styling and explicit audio intent synchronization across source loads; manual browser audio/visual acceptance remains pending.
- 2026-09-22: Completed LV-059 optical volume-slider alignment by normalizing native range metrics and correcting the visible slider center against the speaker icon; manual browser visual acceptance remains pending.

## Verification Evidence
- `node --check server.js` — passed after LV-034 release preparation.
- `node --check public/app.js` — passed after LV-034 release preparation.
- Static grep/readback of `package.json`, `README.md`, and `README.es.md` — passed after LV-034; confirmed version `1.1.0`, current release tag/download links use v1.1.0, ZIP/root examples use `The-Player-1.1.0-windows`, build output uses `portable-win\\The-Player-1.1.0-windows.zip`, and current README/package files have no v1.0.0 release references.
- `node --check server.js` — passed after LV-033 changes.
- `node --check public/app.js` — passed after LV-033 changes.
- `PORT=3175 npm run web` with `curl -fsS http://127.0.0.1:3175/` readiness check — passed after one transient pre-readiness curl failure.
- Static readback/diff after LV-033 — confirmed `public/index.html` favicon link, `public/app.js` shortcut/fullscreen code, README/README.es MIT license text and keyboard shortcut sections, and `LICENSE` MIT text.
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
- `node --check server.js` — passed after LV-023 changes.
- `node --check public/app.js` — passed after LV-023 changes.
- `PORT=3161 npm run web` with `curl -fsS http://127.0.0.1:3161/` readiness check — passed after transient pre-readiness curl failures; response included `id="particleCanvas"`.
- `node --check server.js` — passed after LV-024 changes.
- `node --check public/app.js` — passed after LV-024 changes.
- `PORT=3162 npm run web` with `curl -fsS http://127.0.0.1:3162/` readiness check — passed after transient pre-readiness curl failures; response included `id="particleCanvas"`.
- `node --check server.js` — passed after LV-025 CSS/task-log update.
- `node --check public/app.js` — passed after LV-025 CSS/task-log update and parent `public/app.js` particle changes.
- `PORT=3163 npm run web` with `curl -fsS http://127.0.0.1:3163/` readiness check — passed after transient pre-readiness curl failures; response included `id="particleCanvas"`.
- Static readback/diff of `public/styles.css` and `odd/tasks/local-video-player.md` — passed for LV-025 plausibility; confirmed `.playlist-action-button` compact icon-only default, hover/focus/focus-within expansion, icon fade/width collapse, text reveal, and LV-025 task/progress/evidence entries.
- `node --check server.js` — passed after LV-026 changes.
- `node --check public/app.js` — passed after LV-026 changes.
- `PORT=3165 npm run web` with `curl -fsS http://127.0.0.1:3165/` readiness check — passed after one transient pre-readiness curl failure; response included `id="particleCanvas"`.
- Static diff/readback of `public/index.html`, `public/app.js`, `public/styles.css`, and `odd/tasks/local-video-player.md` — passed for LV-026 plausibility; confirmed transport button roots no longer use `data-i18n`, inner `.button-text` spans carry localized copy, button roots carry `data-i18n-aria-label`, `.transport-action-button` shares the compact-to-expanded morph, icons collapse while text reveals, and passive Canvas link alpha increased from `0.008 + proximity * 0.025` to `0.012 + proximity * 0.035`.
- `node --check server.js` — passed after LV-027 changes.
- `node --check public/app.js` — passed after LV-027 changes.
- `PORT=3167 npm run web` with `curl -fsS http://127.0.0.1:3167/` readiness check — passed after one transient pre-readiness curl failure; response included `id="particleCanvas"`.
- Static diff/readback of `public/app.js`, `public/styles.css`, and `odd/tasks/local-video-player.md` — passed for LV-027 plausibility; confirmed passive Canvas link alpha increased from `0.012 + proximity * 0.035` to `0.018 + proximity * 0.047`, `clearPlaylist()` still resets only in-memory playlist/player/input state, and `.playlist-panel`/`.playlist-header`/`.playlist-actions`/`.playlist` transition or animate empty-state movement with a reduced-motion fallback.
- `node --check server.js` — passed after LV-028 changes.
- `node --check public/app.js` — passed after LV-028 changes.
- `PORT=3169 npm run web` with `curl -fsS http://127.0.0.1:3169/` readiness check — passed after one transient pre-readiness curl failure; response included `id="particleCanvas"`.
- Static diff/readback of `public/app.js` and `odd/tasks/local-video-player.md` — passed for LV-028 plausibility; confirmed particle initialization now computes viewport-ratio rows/columns, derives cell width/height, applies randomized 16%–84% per-cell jitter, and calls `createParticle(x, y)` instead of assigning fully random `x`/`y` inside the particle factory.
- `node --check server.js` — passed after LV-029 portable packaging changes.
- `node --check public/app.js` — passed after LV-029 portable packaging changes.
- PowerShell parser check — not available in this Linux/WSL environment; neither `pwsh` nor `powershell.exe` was found on `PATH`.
- `PORT=3171 npm run web` with `curl -fsS http://127.0.0.1:3171/` readiness check — passed after one transient pre-readiness curl failure; response returned the app HTML.
- Static readback/diff of `scripts/build-portable-win.ps1`, `README.md`, `.gitignore`, `package.json`, and `odd/tasks/local-video-player.md` — passed for LV-029 plausibility; confirmed explicit asset copy list, bundled `runtime/node.exe`, rendered `start.cmd`, Node >=18 check, existing ZIP refusal, `portable-win/` ignore, and no-`npm install` README instructions.
- `node --check server.js` — passed after LV-030 packaging alignment.
- `node --check public/app.js` — passed after LV-030 packaging alignment.
- PowerShell parser check — not available in this Linux/WSL environment; neither `pwsh` nor `powershell.exe` was found on `PATH`.
- Static readback/diff of `scripts/build-portable-win.ps1`, `README.md`, and `odd/tasks/local-video-player.md` — passed for LV-030 plausibility; confirmed release name `The-Player-<version>-windows`, ZIP path under `portable-win/`, release-named ZIP root, `%TEMP%` version/PID staging, scoped `finally` cleanup, explicit asset copy list, bundled `runtime/node.exe`, and no-`node_modules`/no-end-user-`npm install` packaging docs.
- `node --check server.js` — passed after LV-031 version alignment.
- `node --check public/app.js` — passed after LV-031 version alignment.
- PowerShell parser check — not available in this Linux/WSL environment; neither `pwsh` nor `powershell.exe` was found on `PATH`.
- Static readback/diff of `package.json`, `scripts/build-portable-win.ps1`, `README.md`, and `odd/tasks/local-video-player.md` — passed for LV-031 plausibility; confirmed package version `1.0.0`, release name `The-Player-$($package.version)-windows`, ZIP path from `$releaseName`, `%TEMP%` stage root `the-player-$($package.version)-$PID`, scoped cleanup, concrete README `1.0.0` paths, and remaining Windows manual checks.
- `node --check server.js` — passed after LV-032 README changes.
- `node --check public/app.js` — passed after LV-032 README changes.
- Static readback/diff of `README.md`, `README.es.md`, and `odd/tasks/local-video-player.md` — passed for LV-032 plausibility; confirmed El Exportador-style section order, reciprocal language links, downloadable v1.0.0 release ZIP path, build-from-source portable path, bundled `runtime\\node.exe` note, source checkout paths, File API/object URL/IndexedDB Mermaid flow, supported formats with MKV/browser codec limitation, platform support, and license-not-declared wording because no LICENSE file exists.

- `node --check server.js` — passed after LV-037 changes.
- `node --check public/app.js` — passed after LV-037 changes.
- `PORT=3181 npm run web` with `curl -fsS http://127.0.0.1:3181/` readiness check — passed after one transient pre-readiness curl failure; response included `id="videoFrame"` and `class="video-controls"`.
- Static grep/readback — passed for LV-037; confirmed no native `<video controls>` attribute, fullscreen requests `elements.videoFrame`, custom control IDs/classes exist, and `.playlist-panel.has-items` plus `.playlist { overflow: auto; }` bound playlist scrolling.

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
- Visually confirm LV-021/LV-022/LV-023/LV-024 Canvas background in a browser: passive network is quieter away from the cursor, dormant nodes wake up near the pointer, nearby lines get stronger around the cursor, and video/player UI behavior remains unchanged.
- Visually confirm LV-026 transport/background refinement in a browser: Previous, Skip next, and Mark watched & next are compact icon-only by default, expand to readable English/Spanish text on hover/focus/focus-within, preserve accessible compact labels, and passive background links are slightly easier to see without becoming foreground/neon.
- Visually confirm LV-027 background/clear refinement in a browser: distant passive Canvas links are more visible but still second-plane/monochrome, and Clear/Vaciar visibly moves folder/file controls from header to centered empty state without a snap.
- Visually confirm LV-028 Canvas distribution in a browser: particle coverage no longer leaves large empty zones, still feels organic/random, and does not reveal a regular grid at common viewport sizes.
- Manually confirm LV-021/LV-027/LV-028 reduced-motion behavior: with `prefers-reduced-motion: reduce`, the canvas renders a static evenly distributed frame without constant particle movement and the Clear/Vaciar empty-state transition does not animate.
- Completed from WSL through Windows PowerShell: `scripts/build-portable-win.ps1` created `portable-win/The-Player-1.0.0-windows.zip` with only `The-Player-1.0.0-windows/start.cmd`, `The-Player-1.0.0-windows/runtime/node.exe`, and the explicit `The-Player-1.0.0-windows/app` files.
- Completed from WSL through Windows PowerShell: rerunning the build with `portable-win/The-Player-1.0.0-windows.zip` still present refused to overwrite it.
- Completed from WSL through Windows PowerShell/cmd: extracted ZIP launcher started with bundled `runtime\node.exe`, created `logs\server.log`, listened on port 3000, and returned HTTP 200 from `http://127.0.0.1:3000/` without `npm install`. The WSL wrapper needed manual process cleanup because the Windows background process kept inherited handles open; double-click launcher behavior remains the intended user path.

- Manually confirm LV-037 custom controls in a browser: play/pause, seek, time display, mute/volume, fullscreen button, and global keyboard shortcuts all work without native controls.
- Manually confirm LV-037 fullscreen in a browser: only the video frame and custom controls enter fullscreen, with no heading/now-playing/transport/playlist panel, and video is contained without cropping.
- Manually confirm LV-037 large playlists in a browser: the loaded Playlist panel stays bounded, search remains visible, and the list scrolls internally while the empty centered folder/file state is preserved after Clear/Vaciar.

## Next Step
Run the pending manual browser checks with representative local video files, prioritizing the LV-021 Canvas particle visual/reduced-motion review, LV-014 adaptive actions/Clear behavior, LV-010 subset progress restore, LV-009 no-auto-persist, and legacy-exact-vs-newer-recent restore scenarios.
