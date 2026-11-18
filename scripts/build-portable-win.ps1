#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$OutputDirectory = "portable-win",
    [ValidateSet(115, 180, 600, 900, 1800)][int]$FfmpegDownloadTimeoutSeconds = 115
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 does not always preload this assembly.
Add-Type -AssemblyName System.IO.Compression.FileSystem

$ffmpegAssetUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
$ffmpegAssetSha256 = "ac1364304fa755c892a968a4c5bc5473d3ea94fb4978d4351a392191804657b5"

function Write-StageMarker {
    param(
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][ValidateSet('start', 'complete')][string]$Status
    )

    Write-Host "stage=$Stage status=$Status"
}

function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    $terminator = [System.Diagnostics.Process]::new()
    try {
        $terminator.StartInfo.FileName = 'taskkill.exe'
        $terminator.StartInfo.Arguments = "/PID $ProcessId /T /F"
        $terminator.StartInfo.UseShellExecute = $false
        [void]$terminator.Start()
        if (-not $terminator.WaitForExit(5000)) {
            $terminator.Kill()
            [void]$terminator.WaitForExit(5000)
        }
    }
    finally {
        $terminator.Dispose()
    }
}

function Invoke-BundledProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage,
        [ValidateRange(1, 905)][int]$TimeoutSeconds = 60,
        [string]$WorkingDirectory,
        [switch]$CaptureOutput
    )

    $process = [System.Diagnostics.Process]::new()
    try {
        $process.StartInfo.FileName = $Executable
        $process.StartInfo.Arguments = (($Arguments | ForEach-Object {
            if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ }
        }) -join ' ')
        $process.StartInfo.UseShellExecute = $false
        if ($WorkingDirectory) { $process.StartInfo.WorkingDirectory = $WorkingDirectory }
        $process.StartInfo.RedirectStandardOutput = $CaptureOutput
        $process.StartInfo.RedirectStandardError = $CaptureOutput
        [void]$process.Start()
        if ($CaptureOutput) {
            $outputTask = $process.StandardOutput.ReadToEndAsync()
            $errorTask = $process.StandardError.ReadToEndAsync()
        }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            Stop-ProcessTree -ProcessId $process.Id
            [void]$process.WaitForExit(5000)
            throw "$FailureMessage Timed out after $TimeoutSeconds seconds; terminated the process tree."
        }
        if ($CaptureOutput) {
            $output = $outputTask.GetAwaiter().GetResult()
            [void]$errorTask.GetAwaiter().GetResult()
        }
        if ($process.ExitCode -ne 0) { throw $FailureMessage }
        if ($CaptureOutput) { return $output }
    }
    finally {
        $process.Dispose()
    }
}

$DownloadMaximumBytes = 220200960
$downloadMetadataSchemaVersion = 1

function Test-SafeDownloadStateDirectory {
    param([Parameter(Mandatory = $true)][string]$StateRoot)

    New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
    $item = Get-Item -LiteralPath $StateRoot -Force
    if ($item -isnot [System.IO.DirectoryInfo] -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The controlled FFmpeg download state directory is not a safe directory.'
    }
}

function Test-SafeDownloadPartial {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][long]$MaximumBytes
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    return $item -is [System.IO.FileInfo] -and -not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and $item.Length -ge 0 -and $item.Length -le $MaximumBytes
}

function Clear-DownloadState {
    param(
        [Parameter(Mandatory = $true)][string]$StateRoot,
        [Parameter(Mandatory = $true)][string]$PartialPath,
        [Parameter(Mandatory = $true)][string]$MetadataPath
    )

    Test-SafeDownloadStateDirectory -StateRoot $StateRoot
    foreach ($path in @($PartialPath, $MetadataPath)) {
        if (Test-Path -LiteralPath $path) { [System.IO.File]::Delete($path) }
    }
}

function Write-DownloadPartialMetadata {
    param(
        [Parameter(Mandatory = $true)][string]$MetadataPath,
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Sha256,
        [Parameter(Mandatory = $true)][string]$PartialPath
    )

    $metadata = [ordered]@{ schemaVersion = $downloadMetadataSchemaVersion; url = $Url; sha256 = $Sha256; partialBytes = (Get-Item -LiteralPath $PartialPath -Force).Length }
    [System.IO.File]::WriteAllText($MetadataPath, (($metadata | ConvertTo-Json -Compress) + "`n"), [System.Text.Encoding]::UTF8)
}

function Test-DownloadPartialIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$MetadataPath,
        [Parameter(Mandatory = $true)][string]$PartialPath,
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Sha256
    )

    if (-not (Test-SafeDownloadPartial -Path $PartialPath -MaximumBytes $DownloadMaximumBytes) -or -not (Test-SafeDownloadPartial -Path $MetadataPath -MaximumBytes 4096)) { return $false }
    try { $metadata = Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json } catch { return $false }
    $partialBytes = (Get-Item -LiteralPath $PartialPath -Force).Length
    return $metadata.schemaVersion -eq $downloadMetadataSchemaVersion -and $metadata.url -ceq $Url -and $metadata.sha256 -ceq $Sha256 -and $metadata.partialBytes -eq $partialBytes
}

function Invoke-ResumableFfmpegDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Curl,
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Sha256,
        [Parameter(Mandatory = $true)][string]$StageArchive,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$StateRoot
    )

    Test-SafeDownloadStateDirectory -StateRoot $StateRoot
    $partialArchive = Join-Path $StateRoot 'ffmpeg-master-latest-win64-gpl.zip.partial'
    $downloadMetadata = Join-Path $StateRoot 'download-metadata.json'
    $downloadLock = Join-Path $StateRoot 'download.lock'
    $lockStream = $null
    try {
        try { $lockStream = [System.IO.File]::Open($downloadLock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
        catch { throw 'Another portable build is using the controlled FFmpeg download state.' }

        $resume = Test-DownloadPartialIdentity -MetadataPath $downloadMetadata -PartialPath $partialArchive -Url $Url -Sha256 $Sha256
        if (-not $resume) { Clear-DownloadState -StateRoot $StateRoot -PartialPath $partialArchive -MetadataPath $downloadMetadata }
        if (-not (Test-Path -LiteralPath $partialArchive)) { [System.IO.File]::WriteAllBytes($partialArchive, [byte[]]@()) }
        if (-not (Test-SafeDownloadPartial -Path $partialArchive -MaximumBytes $DownloadMaximumBytes)) {
            Clear-DownloadState -StateRoot $StateRoot -PartialPath $partialArchive -MetadataPath $downloadMetadata
            throw 'FFmpeg download partial path is unsafe or exceeds the 210 MiB limit.'
        }
        Write-DownloadPartialMetadata -MetadataPath $downloadMetadata -Url $Url -Sha256 $Sha256 -PartialPath $partialArchive

        $arguments = @('--fail', '--location', '--connect-timeout', '30', '--max-time', [string]$TimeoutSeconds, '--output', $partialArchive)
        if ($resume) { $arguments += @('--continue-at', '-') }
        $arguments += $Url
        $process = [System.Diagnostics.Process]::new()
        try {
            $process.StartInfo.FileName = $Curl
            $process.StartInfo.Arguments = (($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ } }) -join ' ')
            $process.StartInfo.UseShellExecute = $false
            [void]$process.Start()
            $timedOut = -not $process.WaitForExit(($TimeoutSeconds + 5) * 1000)
            if ($timedOut) { Stop-ProcessTree -ProcessId $process.Id; [void]$process.WaitForExit(5000) }
            $result = [pscustomobject]@{ TimedOut = $timedOut; ExitCode = if ($timedOut) { -1 } else { $process.ExitCode } }
        }
        finally { $process.Dispose() }

        $transientCurlExitCodes = @(5, 6, 7, 18, 28, 35, 52, 55, 56)
        if ($result.TimedOut -or $transientCurlExitCodes -contains $result.ExitCode) {
            if (Test-SafeDownloadPartial -Path $partialArchive -MaximumBytes $DownloadMaximumBytes) {
                Write-DownloadPartialMetadata -MetadataPath $downloadMetadata -Url $Url -Sha256 $Sha256 -PartialPath $partialArchive
            }
            else { Clear-DownloadState -StateRoot $StateRoot -PartialPath $partialArchive -MetadataPath $downloadMetadata }
            throw "FFmpeg asset download was interrupted; a bounded partial was retained for exact-identity resume."
        }
        if ($result.ExitCode -ne 0 -or -not (Test-SafeDownloadPartial -Path $partialArchive -MaximumBytes $DownloadMaximumBytes)) {
            Clear-DownloadState -StateRoot $StateRoot -PartialPath $partialArchive -MetadataPath $downloadMetadata
            throw 'FFmpeg asset download failed; retained state was removed.'
        }
        $actualFfmpegSha256 = (Get-FileHash -LiteralPath $partialArchive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualFfmpegSha256 -ne $Sha256) {
            Clear-DownloadState -StateRoot $StateRoot -PartialPath $partialArchive -MetadataPath $downloadMetadata
            throw "FFmpeg archive SHA-256 mismatch. Expected $Sha256 but got $actualFfmpegSha256."
        }
        Copy-Item -LiteralPath $partialArchive -Destination $StageArchive
        Clear-DownloadState -StateRoot $StateRoot -PartialPath $partialArchive -MetadataPath $downloadMetadata
    }
    finally {
        if ($lockStream) { $lockStream.Dispose(); [System.IO.File]::Delete($downloadLock) }
    }
}

function ConvertTo-PowerShellSingleQuotedLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)

    return "'" + $Value.Replace("'", "''") + "'"
}

function Invoke-BundledFfmpeg {
    param(
        [Parameter(Mandatory = $true)][string]$Ffmpeg,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage,
        [ValidateRange(1, 300)][int]$TimeoutSeconds = 60,
        [string]$WorkingDirectory
    )

    Invoke-BundledProcess -Executable $Ffmpeg -Arguments $Arguments -FailureMessage $FailureMessage -TimeoutSeconds $TimeoutSeconds -WorkingDirectory $WorkingDirectory
}

function Get-HlsPlaylistArtifactUri {
    param(
        [Parameter(Mandatory = $true)][string]$Playlist,
        [string]$Tag,
        [string]$Extension
    )

    $lines = @($Playlist -split "`r?`n")
    if ($Tag) {
        $line = $lines | Where-Object { $_ -match ("^\s*#" + [regex]::Escape($Tag) + ":") } | Select-Object -First 1
        $match = if ($line) { [regex]::Match($line, 'URI\s*=\s*["''](?<uri>[^"'']+)["'']', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) } else { $null }
        $uri = if ($match -and $match.Success) { $match.Groups['uri'].Value } else { $null }
    }
    elseif ($Extension) {
        $uri = $lines | Where-Object { $_ -match ("^\s*[^#\s]+\." + [regex]::Escape($Extension) + "\s*$") } | ForEach-Object { $_.Trim() } | Select-Object -First 1
    }
    else {
        throw 'An HLS playlist tag or artifact extension is required.'
    }

    $expectedExtension = if ($Extension) { $Extension } else { 'mp4' }
    $artifactDescription = if ($Tag) { $Tag } else { $Extension }
    if (-not $uri -or $uri -notmatch ("^[A-Za-z0-9][A-Za-z0-9._%\-]*\." + [regex]::Escape($expectedExtension) + "$")) {
        throw "HLS playlist has no safe $artifactDescription artifact reference."
    }
    return $uri
}

function Write-HlsFixtureFailureDiagnostic {
    param(
        [Parameter(Mandatory = $true)][string]$Playlist,
        [Parameter(Mandatory = $true)][string]$HlsRoot
    )

    Write-Host 'fixture-hls-diagnostic=video-playlist'
    foreach ($line in ($Playlist -split "`r?`n")) {
        $trimmed = $line.Trim()
        if (-not $trimmed) { continue }
        if ($trimmed -match '^#[A-Za-z0-9:,.=_"'' -]+$' -or $trimmed -match '^[A-Za-z0-9][A-Za-z0-9._%\-]*\.(m3u8|m4s|mp4|vtt)$') {
            Write-Host "fixture-video-playlist: $trimmed"
        }
        else {
            Write-Host 'fixture-video-playlist: [unsafe line omitted]'
        }
    }
    foreach ($artifact in (Get-ChildItem -LiteralPath $HlsRoot -File | Sort-Object Name)) {
        if ($artifact.Name -match '^[A-Za-z0-9][A-Za-z0-9._%\-]*\.(m3u8|m4s|mp4|vtt)$') {
            Write-Host "fixture-hls-file: $($artifact.Name)"
        }
    }
}

function Test-BundledMuxedFmp4Artifacts {
    param(
        [Parameter(Mandatory = $true)][string]$Ffprobe,
        [Parameter(Mandatory = $true)][string]$InitPath,
        [Parameter(Mandatory = $true)][string]$MediaPath
    )

    if (-not (Test-Path -LiteralPath $InitPath -PathType Leaf) -or -not (Test-Path -LiteralPath $MediaPath -PathType Leaf)) {
        throw 'Muxed fMP4 HLS init or media artifact is missing.'
    }
    $combinedPath = "$MediaPath.fixture.mp4"
    $combined = [System.IO.MemoryStream]::new()
    try {
        $initBytes = [System.IO.File]::ReadAllBytes($InitPath)
        $mediaBytes = [System.IO.File]::ReadAllBytes($MediaPath)
        $combined.Write($initBytes, 0, $initBytes.Length)
        $combined.Write($mediaBytes, 0, $mediaBytes.Length)
        [System.IO.File]::WriteAllBytes($combinedPath, $combined.ToArray())
        $probeOutput = Invoke-BundledProcess -Executable $Ffprobe -Arguments @('-v', 'error', '-show_streams', '-of', 'json', $combinedPath) -FailureMessage "Bundled FFprobe could not inspect the muxed fMP4 init/media artifacts." -TimeoutSeconds 30 -CaptureOutput
    }
    finally {
        $combined.Dispose()
        Remove-Item -LiteralPath $combinedPath -Force -ErrorAction SilentlyContinue
    }
    $probe = $probeOutput | ConvertFrom-Json
    if (-not ($probe.streams | Where-Object { $_.codec_type -eq "video" -and $_.codec_name -eq "h264" })) {
        throw "Muxed fMP4 HLS artifacts have no H.264 video stream."
    }
    if (-not ($probe.streams | Where-Object { $_.codec_type -eq "audio" -and $_.codec_name -eq "aac" })) {
        throw "Muxed fMP4 HLS artifacts have no AAC audio stream."
    }
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

    Write-StageMarker -Stage 'fixture-create' -Status 'start'
    Invoke-BundledFfmpeg -Ffmpeg $Ffmpeg -Arguments @('-hide_banner', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-i', $subtitlePath, '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-map', '3:0', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt', $sourcePath) -FailureMessage 'Bundled GPL FFmpeg could not create the x264 MKV subtitle fixture.'
    Write-StageMarker -Stage 'fixture-create' -Status 'complete'

    Write-StageMarker -Stage 'fixture-ffprobe-validation' -Status 'start'
    $probeOutput = Invoke-BundledProcess -Executable $Ffprobe -Arguments @('-v', 'error', '-show_streams', '-of', 'json', $sourcePath) -FailureMessage 'Bundled FFprobe could not inspect the MKV subtitle fixture.' -TimeoutSeconds 30 -CaptureOutput
    Write-StageMarker -Stage 'fixture-ffprobe-validation' -Status 'complete'
    $probe = $probeOutput | ConvertFrom-Json
    if (-not ($probe.streams | Where-Object { $_.codec_type -eq "subtitle" })) {
        throw "Bundled FFprobe did not find the embedded text subtitle fixture."
    }

    New-Item -ItemType Directory -Force -Path $hlsRoot | Out-Null
    Invoke-BundledFfmpeg -Ffmpeg $Ffmpeg -Arguments @('-hide_banner', '-y', '-v', 'error', '-i', $sourcePath, '-t', '1', '-map', '0:v:0', '-map', '0:1', '-map', '0:3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'webvtt', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_flags', 'temp_file', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', (Join-Path $hlsRoot 'segment_%v_%05d.m4s'), '-master_pl_name', 'master.m3u8', '-var_stream_map', 'v:0,a:0,s:0,sgroup:subs', (Join-Path $hlsRoot 'media_%v.m3u8')) -FailureMessage 'Bundled GPL FFmpeg could not generate the selected-track muxed x264 fMP4 HLS subtitle fixture.' -WorkingDirectory $hlsRoot

    $masterPath = Join-Path $hlsRoot "master.m3u8"
    $master = Get-Content -LiteralPath $masterPath -Raw
    if ($master -match '(?m)^#EXT-X-MEDIA:TYPE=AUDIO,') { throw "Selected-track HLS master must not declare alternate audio renditions." }
    $subtitleMatch = [regex]::Match($master, '(?m)^#EXT-X-MEDIA:(?=.*TYPE=SUBTITLES).*URI="([^"]+)"')
    if (-not $subtitleMatch.Success) { throw "HLS master playlist has no EXT-X-MEDIA subtitle rendition." }
    $videoVariant = [regex]::Match($master, '(?m)^#EXT-X-STREAM-INF:.*SUBTITLES="subs".*$')
    if (-not $videoVariant.Success) { throw "Muxed HLS video variant is not attached to the subtitle group." }
    $masterLines = $master -split "`r?`n"
    $videoVariantIndex = [array]::IndexOf($masterLines, $videoVariant.Value)
    $videoPlaylistUri = $masterLines[$videoVariantIndex + 1].Trim()
    if ($videoPlaylistUri -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.m3u8$') { throw "Muxed HLS master has no safe video playlist reference." }
    $videoPlaylist = Get-Content -LiteralPath (Join-Path $hlsRoot $videoPlaylistUri) -Raw
    try {
        $initUri = Get-HlsPlaylistArtifactUri -Playlist $videoPlaylist -Tag 'EXT-X-MAP'
        $videoSegmentUri = Get-HlsPlaylistArtifactUri -Playlist $videoPlaylist -Extension 'm4s'
        Test-BundledMuxedFmp4Artifacts -Ffprobe $Ffprobe -InitPath (Join-Path $hlsRoot $initUri) -MediaPath (Join-Path $hlsRoot $videoSegmentUri)
    }
    catch {
        Write-HlsFixtureFailureDiagnostic -Playlist $videoPlaylist -HlsRoot $hlsRoot
        throw
    }
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
$nodeVersionText = (Invoke-BundledProcess -Executable $nodeCommand.Source -Arguments @('-p', 'process.versions.node') -FailureMessage 'Node version check failed.' -TimeoutSeconds 30 -CaptureOutput).Trim()
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

    $ffmpegArchive = Join-Path $stageRoot "ffmpeg-master-latest-win64-gpl.zip"
    $ffmpegExtractRoot = Join-Path $stageRoot "ffmpeg-extract"
    $curlCommand = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $curlCommand) {
        throw 'Windows curl.exe is required to download the pinned FFmpeg asset, but was not found.'
    }
    $downloadStateRoot = Join-Path $tempRoot 'the-player-ffmpeg-download-v1'
    Write-StageMarker -Stage 'download' -Status 'start'
    Invoke-ResumableFfmpegDownload -Curl $curlCommand.Source -Url $ffmpegAssetUrl -Sha256 $ffmpegAssetSha256 -StageArchive $ffmpegArchive -TimeoutSeconds $FfmpegDownloadTimeoutSeconds -StateRoot $downloadStateRoot
    Write-StageMarker -Stage 'download' -Status 'complete'
    Write-StageMarker -Stage 'extract' -Status 'start'
    $extractCommand = "Expand-Archive -LiteralPath $(ConvertTo-PowerShellSingleQuotedLiteral $ffmpegArchive) -DestinationPath $(ConvertTo-PowerShellSingleQuotedLiteral $ffmpegExtractRoot) -ErrorAction Stop"
    Invoke-BundledProcess -Executable 'powershell.exe' -Arguments @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', $extractCommand) -FailureMessage 'Verified FFmpeg archive extraction failed.' -TimeoutSeconds 120
    Write-StageMarker -Stage 'extract' -Status 'complete'
    $ffmpegExe = Get-ChildItem -LiteralPath $ffmpegExtractRoot -Recurse -File -Filter "ffmpeg.exe" | Select-Object -First 1
    $ffprobeExe = Get-ChildItem -LiteralPath $ffmpegExtractRoot -Recurse -File -Filter "ffprobe.exe" | Select-Object -First 1
    if (-not $ffmpegExe -or -not $ffprobeExe) { throw "Verified BtbN GPL archive did not contain ffmpeg.exe and ffprobe.exe." }
    $thirdPartyRoot = Join-Path $packageRoot "third_party"
    $ffmpegNoticeRoot = Join-Path $thirdPartyRoot "ffmpeg"
    New-Item -ItemType Directory -Force -Path $ffmpegNoticeRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "third_party\FFmpeg-GPL-NOTICE.md") -Destination $thirdPartyRoot
    $archiveNotices = Get-ChildItem -LiteralPath $ffmpegExtractRoot -Recurse -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|NOTICE)(\..+)?$' }
    if (-not $archiveNotices) { throw "Verified BtbN GPL archive did not contain a license or notice file." }
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
        $content = [System.Text.RegularExpressions.Regex]::Replace((Get-Content -LiteralPath $template -Raw), "\r?\n", "`r`n")
        [System.IO.File]::WriteAllText($destination, $content, [System.Text.Encoding]::ASCII)
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

    Write-StageMarker -Stage 'archive-create' -Status 'start'
    $archiveCommand = "Compress-Archive -LiteralPath $(ConvertTo-PowerShellSingleQuotedLiteral $packageRoot) -DestinationPath $(ConvertTo-PowerShellSingleQuotedLiteral $archivePath) -CompressionLevel Optimal -ErrorAction Stop"
    Invoke-BundledProcess -Executable 'powershell.exe' -Arguments @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', $archiveCommand) -FailureMessage 'Portable ZIP creation failed.' -TimeoutSeconds 120
    Write-StageMarker -Stage 'archive-create' -Status 'complete'
    $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $archiveEntries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('/', '\') })
        foreach ($requiredEntry in @(
            "$releaseName\runtime\node.exe",
            "$releaseName\runtime\ffmpeg.exe",
            "$releaseName\runtime\ffprobe.exe",
            "$releaseName\third_party\FFmpeg-GPL-NOTICE.md",
            "$releaseName\app\public\vendor\hls.js\hls.min.js",
            "$releaseName\app\public\vendor\hls.js\LICENSE"
        )) {
            if ($archiveEntries -notcontains $requiredEntry) { throw "Portable ZIP is missing required entry: $requiredEntry" }
        }
        if (-not ($archiveEntries | Where-Object { $_ -like "$releaseName\third_party\ffmpeg\btbn-*" })) {
            throw "Portable ZIP is missing the license/notices extracted from the verified BtbN GPL archive."
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
