# Local Video Player

The Player is a small browser-based local video player served by Node. It lets you choose a folder or multiple local video files, builds a playlist, plays videos in order, and stores progress/watched state in IndexedDB. The interface uses the browser/system language when it is Spanish (`es` or `es-*`); otherwise it falls back to English.

## Development usage

```bash
npm run web
```

Open the printed URL, usually <http://127.0.0.1:3000>.

The server binds to localhost by default and uses port `3000`. Override the port when needed:

```bash
PORT=3001 npm run web
```

## Windows portable package

The Windows portable build includes the app files and a Windows Node runtime. End users do not run `npm install`.

Build it on Windows with Node 18 or newer available on `PATH`:

```powershell
npm run build:portable:win
```

The build creates `portable-win/ThePlayer-portable-win.zip` and refuses to overwrite an existing ZIP. Unzip it, then double-click `ThePlayer\start.cmd`. The launcher starts the local server with the packaged `runtime\node.exe`, writes logs beside the launcher in `logs\server.log`, waits for readiness, and opens <http://127.0.0.1:3000/>.

The portable ZIP intentionally contains only:

- `ThePlayer\start.cmd`
- `ThePlayer\runtime\node.exe`
- `ThePlayer\app\package.json`
- `ThePlayer\app\server.js`
- `ThePlayer\app\public\`
- `ThePlayer\app\README.md`

It does not include `node_modules`, Git metadata, local Pi runtime state, tests, backups, or secrets.

## Supported formats

The picker accepts files ending in:

- `.mp4`
- `.webm`
- `.m4v`
- `.mov`
- `.mkv` best-effort

Actual playback depends on the browser's built-in codec support. MKV support is limited in many browsers; the app does not remux, transcode, or extract subtitles.

## Current limitations

- Files stay local in the browser and are not uploaded to the Node server.
- The playlist exists only for the currently selected folder/files.
- When files are loaded, the initial video is chosen from the newest meaningful activity among the current selection: exact selected-set activity, per-file recent-active activity, and per-file saved progress. A newer selected-file progress or recent-active record can beat an older exact selected-set record. Initial auto-selection during file loading does not overwrite last-active state. If there is no meaningful activity for the selected files, the app starts from the first unwatched item, then the first item.
- `Skip next` saves current progress without marking the item watched. Use `Mark watched & next` to explicitly complete the current item and move forward.
- Progress, watched state, exact selected-set last active video, and per-file recent active signals are saved in the browser's IndexedDB. New last-active records include a source for future restore decisions. File progress is keyed by relative path/name, file size, and last modified timestamp, and its `updatedAt` participates in initial restore priority when the saved progress is meaningful.
- FFmpeg integration, media-library indexing, and subtitle extraction are intentionally deferred.
