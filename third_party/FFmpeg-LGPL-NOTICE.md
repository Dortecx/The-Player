# FFmpeg Windows runtime notice

The Windows portable build downloads the BtbN FFmpeg-Builds `ffmpeg-master-latest-win64-lgpl.zip` asset at build time and verifies its SHA-256 before packaging it. The archive is the 64-bit LGPL build and supplies the packaged `ffmpeg.exe` and `ffprobe.exe` binaries.

- Asset: <https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip>
- Required SHA-256: `a3f90ca921a5793a696c4c06a1f9c4c55685cf2b54f069c98174a011eda2b415`
- FFmpeg source: <https://github.com/FFmpeg/FFmpeg>
- BtbN build scripts and source correspondence: <https://github.com/BtbN/FFmpeg-Builds>

The portable build also copies the license/notices found in that verified archive to `third_party/ffmpeg/` in the release ZIP. Those files govern the distributed binaries; this notice does not replace them.
