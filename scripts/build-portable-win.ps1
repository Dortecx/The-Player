#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$OutputDirectory = "portable-win"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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
}
finally {
    if ($stageCreated -and (Test-Path -LiteralPath $stageRoot) -and ((Split-Path -Parent $stageRoot) -eq $tempRoot)) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}

Write-Host "Portable Windows package created: $archivePath"
Write-Host "Included app files under $releaseName\app, Node runtime under $releaseName\runtime, and launchers $releaseName\start.cmd (local-only) and $releaseName\LAN.cmd (LAN shared mode)."
