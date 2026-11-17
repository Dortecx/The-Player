# FFmpeg Windows runtime notice

The Windows portable build downloads the BtbN FFmpeg-Builds `ffmpeg-master-latest-win64-gpl.zip` asset at build time and verifies its SHA-256 before packaging it. This is the 64-bit GPL build; it includes the GPL `libx264` encoder used to produce browser-compatible H.264 HLS video, and supplies the packaged `ffmpeg.exe` and `ffprobe.exe` binaries.

- Asset: <https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip>
- Required SHA-256 (current user-approved build-script pin): `339ea3c11b8a0665a790a8b91ad11e099ae2421e8a9343b78f14942565eb4fbd`

This notice describes the archive the current build script is approved to fetch. It does not claim that an earlier digest identifies the mutable `latest` asset; a rebuild must verify the pin above and fails on any mismatch.
- FFmpeg source: <https://github.com/FFmpeg/FFmpeg>
- BtbN build scripts and source correspondence: <https://github.com/BtbN/FFmpeg-Builds>
- x264 source: <https://code.videolan.org/videolan/x264>

The portable build also copies the license/notices found in that verified archive to `third_party/ffmpeg/` in the release ZIP. Those files govern the distributed binaries; this notice does not replace them.
