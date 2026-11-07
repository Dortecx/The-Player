#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$OutputDirectory = "portable-win"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ffmpegAssetUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip"
$ffmpegAssetSha256 = "a3f90ca921a5793a696c4c06a1f9c4c55685cf2b54f069c98174a011eda2b415"

function Invoke-BundledFfmpeg {
    param(
        [Parameter(Mandatory = $true)][string]$Ffmpeg,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo.FileName = $Ffmpeg
    $process.StartInfo.Arguments = (($Arguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ }
    }) -join ' ')
    $process.StartInfo.UseShellExecute = $false
    [void]$process.Start()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $process.Dispose()
    if ($exitCode -ne 0) { throw $FailureMessage }
}

function Test-BundledHlsSubtitleFixture {
    param(
        [Parameter(Mandatory = $true)][string]$Ffmpeg,
        [Parameter(Mandatory = $true)][string]$Ffprobe,
        [Parameter(Mandatory = $true)][string]$FixtureRoot
    )

    New-Item -ItemType Directory -Force -Path $FixtureRoot | Out-Null
    $subtitlePath = Join-Path $FixtureRoot "fixture.srt"
    $sourcePath = Join-Path $FixtureRoot "fixture.mkv"
    $hlsRoot = Join-Path $FixtureRoot "hls"
    Set-Content -LiteralPath $subtitlePath -Encoding ASCII -NoNewline -Value "1`r`n00:00:00,000 --> 00:00:00,750`r`nPortable subtitle fixture`r`n"

    Invoke-BundledFfmpeg -Ffmpeg $Ffmpeg -Arguments @('-hide_banner', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-i', $subtitlePath, '-map', '0:v:0', '-map', '1:a:0', '-map', '2:0', '-t', '1', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt', $sourcePath) -FailureMessage 'Bundled FFmpeg could not create the MKV subtitle fixture.'

    $ffprobeProcess = [System.Diagnostics.Process]::new()
    $ffprobeProcess.StartInfo.FileName = $Ffprobe
    $ffprobeProcess.StartInfo.Arguments = "-v error -show_streams -of json `"$sourcePath`""
    $ffprobeProcess.StartInfo.UseShellExecute = $false
    $ffprobeProcess.StartInfo.RedirectStandardOutput = $true
    $ffprobeProcess.StartInfo.RedirectStandardError = $true
    [void]$ffprobeProcess.Start()
    $probeOutput = $ffprobeProcess.StandardOutput.ReadToEnd()
    $probeErrors = $ffprobeProcess.StandardError.ReadToEnd()
    $ffprobeProcess.WaitForExit()
    $ffprobeExitCode = $ffprobeProcess.ExitCode
    $ffprobeProcess.Dispose()
    if ($ffprobeExitCode -ne 0) { throw "Bundled FFprobe could not inspect the MKV subtitle fixture: $probeErrors" }
    $probe = $probeOutput | ConvertFrom-Json
    if (-not ($probe.streams | Where-Object { $_.codec_type -eq "subtitle" })) {
        throw "Bundled FFprobe did not find the embedded text subtitle fixture."
    }

    New-Item -ItemType Directory -Force -Path $hlsRoot | Out-Null
    Invoke-BundledFfmpeg -Ffmpeg $Ffmpeg -Arguments @('-hide_banner', '-y', '-v', 'error', '-i', $sourcePath, '-map', '0:v:0', '-map', '0:1', '-map', '0:2', '-c:v', 'copy', '-c:a', 'aac', '-c:s', 'webvtt', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_filename', (Join-Path $hlsRoot 'segment_%v_%05d.ts'), '-master_pl_name', 'master.m3u8', '-var_stream_map', 'v:0,a:0,s:0,sgroup:subs', (Join-Path $hlsRoot 'media_%v.m3u8')) -FailureMessage 'Bundled FFmpeg could not generate the HLS subtitle fixture.'

    $masterPath = Join-Path $hlsRoot "master.m3u8"
    $master = Get-Content -LiteralPath $masterPath -Raw
    $subtitleMatch = [regex]::Match($master, '(?m)^#EXT-X-MEDIA:(?=.*TYPE=SUBTITLES).*URI="([^"]+)"')
    if (-not $subtitleMatch.Success) { throw "HLS master playlist has no EXT-X-MEDIA subtitle rendition." }
    $subtitlePlaylist = Join-Path $hlsRoot $subtitleMatch.Groups[1].Value
    if (-not (Test-Path -LiteralPath $subtitlePlaylist -PathType Leaf)) { throw "HLS subtitle rendition is not retrievable from the generated artifact." }
    $vttUri = Get-Content -LiteralPath $subtitlePlaylist | Where-Object { $_ -match '^\s*[^#\s]+\.vtt\s*$' } | Select-Object -First 1
    if (-not $vttUri) { throw "HLS subtitle rendition has no WebVTT artifact." }
    $vttPath = Join-Path $hlsRoot $vttUri.Trim()
    if (-not (Test-Path -LiteralPath $vttPath -PathType Leaf)) { throw "HLS WebVTT artifact is not retrievable from the generated artifact." }
    if (-not (Get-Content -LiteralPath $vttPath -Raw).StartsWith("WEBVTT")) { throw "HLS WebVTT artifact is invalid." }
}

$isWindowsPlatform = ($PSVersionTable.PSEdition -eq "Desktop") -or ((Get-Variable -Name IsWindows -ValueOnly -ErrorAction SilentlyContinue) -eq $true)
if (-not $isWindowsPlatform) {
    throw "Windows portable packaging must be built on Windows so the packaged runtime is a Windows node.exe."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packageJsonPath = Join-Path $repoRoot "package.json"
$package = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$releaseName = "The-Player-$($package.version)-windows"
$outputRoot = Join-Path $repoRoot $OutputDirectory
$archivePath = Join-Path $outputRoot "$releaseName.zip"
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$stageRoot = Join-Path $tempRoot "the-player-$($package.version)-$PID"
$packageRoot = Join-Path $stageRoot $releaseName
$appRoot = Join-Path $packageRoot "app"
$runtimeRoot = Join-Path $packageRoot "runtime"

$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
$nodeVersionText = (& $nodeCommand.Source -p "process.versions.node").Trim()
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion.Major -lt 18) {
    throw "Node >=18 is required to build the portable package. Found $nodeVersionText at $($nodeCommand.Source)."
}

if ((Split-Path -Leaf $nodeCommand.Source).ToLowerInvariant() -ne "node.exe") {
    throw "The resolved Node runtime is not node.exe: $($nodeCommand.Source)"
}

if (Test-Path -LiteralPath $archivePath) {
    throw "Refusing to overwrite existing portable ZIP: $archivePath"
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$stageCreated = $false
try {
    if (Test-Path -LiteralPath $stageRoot) {
        throw "Temporary staging directory already exists: $stageRoot"
    }
    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    $stageCreated = $true
    New-Item -ItemType Directory -Force -Path $appRoot, $runtimeRoot | Out-Null

    Copy-Item -LiteralPath $packageJsonPath -Destination $appRoot
    Copy-Item -LiteralPath (Join-Path $repoRoot "server.js") -Destination $appRoot
    Copy-Item -LiteralPath (Join-Path $repoRoot "README.md") -Destination $appRoot
    Copy-Item -LiteralPath (Join-Path $repoRoot "public") -Destination $appRoot -Recurse
    Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $runtimeRoot "node.exe")

    $ffmpegArchive = Join-Path $stageRoot "ffmpeg-master-latest-win64-lgpl.zip"
    $ffmpegExtractRoot = Join-Path $stageRoot "ffmpeg-extract"
    Invoke-WebRequest -Uri $ffmpegAssetUrl -OutFile $ffmpegArchive
    $actualFfmpegSha256 = (Get-FileHash -LiteralPath $ffmpegArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualFfmpegSha256 -ne $ffmpegAssetSha256) {
        throw "FFmpeg archive SHA-256 mismatch. Expected $ffmpegAssetSha256 but got $actualFfmpegSha256."
    }
    Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtractRoot
    $ffmpegExe = Get-ChildItem -LiteralPath $ffmpegExtractRoot -Recurse -File -Filter "ffmpeg.exe" | Select-Object -First 1
    $ffprobeExe = Get-ChildItem -LiteralPath $ffmpegExtractRoot -Recurse -File -Filter "ffprobe.exe" | Select-Object -First 1
    if (-not $ffmpegExe -or -not $ffprobeExe) { throw "Verified BtbN archive did not contain ffmpeg.exe and ffprobe.exe." }
    $thirdPartyRoot = Join-Path $packageRoot "third_party"
    $ffmpegNoticeRoot = Join-Path $thirdPartyRoot "ffmpeg"
    New-Item -ItemType Directory -Force -Path $ffmpegNoticeRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "third_party\FFmpeg-LGPL-NOTICE.md") -Destination $thirdPartyRoot
    $archiveNotices = Get-ChildItem -LiteralPath $ffmpegExtractRoot -Recurse -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|NOTICE)(\..+)?$' }
    if (-not $archiveNotices) { throw "Verified BtbN archive did not contain a license or notice file." }
    foreach ($notice in $archiveNotices) {
        Copy-Item -LiteralPath $notice.FullName -Destination (Join-Path $ffmpegNoticeRoot ("btbn-" + $notice.Name))
    }

    $fixtureRoot = Join-Path $stageRoot "hls-subtitle-fixture"
    Test-BundledHlsSubtitleFixture -Ffmpeg $ffmpegExe.FullName -Ffprobe $ffprobeExe.FullName -FixtureRoot $fixtureRoot
    Copy-Item -LiteralPath $ffmpegExe.FullName -Destination (Join-Path $runtimeRoot "ffmpeg.exe")
    Copy-Item -LiteralPath $ffprobeExe.FullName -Destination (Join-Path $runtimeRoot "ffprobe.exe")

    $launcherTemplates = @{
        "start.cmd" = "start.cmd.template"
        "LAN.cmd" = "LAN.cmd.template"
    }
    foreach ($launcher in $launcherTemplates.GetEnumerator()) {
        $template = Join-Path $PSScriptRoot $launcher.Value
        $destination = Join-Path $packageRoot $launcher.Key
        Get-Content -LiteralPath $template -Raw | Set-Content -LiteralPath $destination -Encoding ASCII -NoNewline
    }

    $forbiddenPathNames = @("node_modules", ".git", ".atl", "test", "tests", "backup", "backups", ".config", "log", "logs", "profile", "profiles", "token", "tokens", "credential", "credentials")
    $forbiddenStagedPaths = Get-ChildItem -LiteralPath $packageRoot -Recurse -Force | Where-Object {
        $relativePath = $_.FullName.Substring($packageRoot.Length).TrimStart([char[]]@('\', '/'))
        ($relativePath -split '[\\/]') | Where-Object { $forbiddenPathNames -icontains $_ }
    }
    if ($forbiddenStagedPaths) {
        $paths = $forbiddenStagedPaths | ForEach-Object { $_.FullName.Substring($packageRoot.Length).TrimStart([char[]]@('\', '/')) }
        throw "Forbidden path(s) found in staged package: $($paths -join ', ')"
    }

    Compress-Archive -LiteralPath $packageRoot -DestinationPath $archivePath -CompressionLevel Optimal
    $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $archiveEntries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('/', '\') })
        foreach ($requiredEntry in @(
            "$releaseName\runtime\node.exe",
            "$releaseName\runtime\ffmpeg.exe",
            "$releaseName\runtime\ffprobe.exe",
            "$releaseName\third_party\FFmpeg-LGPL-NOTICE.md"
        )) {
            if ($archiveEntries -notcontains $requiredEntry) { throw "Portable ZIP is missing required entry: $requiredEntry" }
        }
        if (-not ($archiveEntries | Where-Object { $_ -like "$releaseName\third_party\ffmpeg\btbn-*" })) {
            throw "Portable ZIP is missing the license/notices extracted from the verified BtbN archive."
        }
    }
    finally {
        $archive.Dispose()
    }
}
finally {
    if ($stageCreated -and (Test-Path -LiteralPath $stageRoot) -and ((Split-Path -Parent $stageRoot) -eq $tempRoot)) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}

Write-Host "Portable Windows package created: $archivePath"
Write-Host "Included app files under $releaseName\app, Node runtime under $releaseName\runtime, and launchers $releaseName\start.cmd (local-only) and $releaseName\LAN.cmd (LAN shared mode)."
