# Selected-track playback details

[Español](selected-track-playback.es.md) · [Quick start](../README.md)

Use this guide when you need embedded MKV audio or text subtitles. The README covers the normal path; this page explains the compatibility, conversion, cache, and navigation behavior behind it.

## Choose tracks

| Mode | Who chooses | Result |
| --- | --- | --- |
| Local `start.cmd` | The local viewer, after **Use local embedded tracks** | A token-protected loopback-only, non-shareable session. Direct raw playback remains the default. |
| Shared `LAN.cmd` | The localhost host in **Embedded tracks** | One authoritative audio/text-subtitle choice; guests see it read-only. |

Until a choice is applied, protected raw playback remains available. Applying or changing a choice reloads the selected source and resumes as closely as browser metadata allows; it is not a seamless track switch.

## Preparation and compatibility

1. The server inspects embedded tracks.
2. It builds one muxed CMAF/fMP4 HLS VOD for the selected audio and optional text subtitle.
3. It waits for FFmpeg to finish and validates every manifest reference, artifact, and `#EXT-X-ENDLIST` before playback starts.
4. It promotes a valid completed rendition to the persistent cache when available.

No partial HLS is played. If preparation fails or is cancelled, use the explicit original-video recovery action. That path still requires browser support for the original container **and codecs**.

### Audio and video routing

Compatible H.264 8-bit progressive `yuv420p` video and AAC-LC mono/stereo audio are remuxed first. If only one stream is incompatible, only that stream is converted; otherwise both are converted to H.264/AAC. There are no alternate-audio HLS groups and no browser audio-track switching.

When video conversion is required, FFmpeg checks NVENC, then QSV, then AMF; it uses the first working encoder or `libx264`. Copy and audio-only routes do not probe a GPU. A GPU encode failure retries once with fresh `libx264` output and quarantines the failed backend for the rest of that process only after a successful retry. Set `REPRODUCTOR_FORCE_CPU_ENCODER=1` for deterministic CPU troubleshooting. Decoding remains software-only.

### Text subtitles

Selectable text subtitle codecs are ASS/SSA, SRT/SubRip, WebVTT, MOV text, text, and TTML. Image/bitmap subtitles are unavailable.

Text conversion is independent: it never forces audio/video conversion. The player renders selected subtitles from a complete protected aggregate WebVTT document, rather than native or hls.js segmented TextTrack events. This keeps cue timing, late cues, and safe italic rendering stable across segment boundaries.

## Cache and privacy

Completed compatible renditions live in the marked `hls-cache` folder beside the portable launcher. The cache has no automatic eviction by default; delete only that marked folder, with The Player stopped, to reclaim space. Normal library Clear and shutdown preserve it.

Cache entries are admitted only after complete validation. Cache keys contain source-content SHA-256, selected track indexes, and safe encoder/topology identities; they never contain source paths or room tokens. The same source bytes and track choice can reuse a completed rendition immediately without FFmpeg.

## Resume and the next item

Each playlist item keeps its own content-bound browser checkpoint. A destination selection may offer that checkpoint as a resume candidate only when the room has no positive position for the same content.

After the foreground selected stream is ready, the server may prepare exactly the immediate next item. It matches the intended audio/subtitle by normalized language plus title/disposition when available, then by unambiguous language only. Ambiguous matches ask the host to choose instead of guessing.

- Selecting a still-preparing item keeps the foreground item and its checkpoint unchanged.
- Backward navigation can retain a later one-ahead preparation.
- A ready session can be re-admitted without re-encoding.
- Only the next card shows preparing, ready, unavailable, or choice-required state.
- Changing tracks, clearing the library, or shutdown cancels speculative work.

## Progress and limits

The player shows preparation first as indeterminate. Once FFmpeg reports output time for a known source duration, it can show percentage, elapsed time, and an ETA only when that estimate is stable. Shared room state contains normalized progress only; it never exposes FFmpeg output, paths, commands, tokens, raw errors, or driver details.

A VOD job has a duration-aware deadline: at least 30 minutes and at most 12 hours. Reaching it produces `job-timeout` and no playable partial output.

For shared-room security, uploads, firewall rules, and two-browser checks, see [LAN shared playback details](lan-shared-playback.md).
