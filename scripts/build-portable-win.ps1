#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$OutputDirectory = "portable-win",
    [string]$ArchiveName = "ThePlayer-portable-win.zip"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$isWindowsPlatform = ($PSVersionTable.PSEdition -eq "Desktop") -or ((Get-Variable -Name IsWindows -ValueOnly -ErrorAction SilentlyContinue) -eq $true)
if (-not $isWindowsPlatform) {
    throw "Windows portable packaging must be built on Windows so the packaged runtime is a Windows node.exe."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputRoot = Join-Path $repoRoot $OutputDirectory
$archivePath = Join-Path $outputRoot $ArchiveName
$stageRoot = Join-Path $outputRoot "stage"
$packageRoot = Join-Path $stageRoot "ThePlayer"
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
if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $appRoot, $runtimeRoot | Out-Null

Copy-Item -LiteralPath (Join-Path $repoRoot "package.json") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $repoRoot "server.js") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $repoRoot "README.md") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $repoRoot "public") -Destination $appRoot -Recurse
Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $runtimeRoot "node.exe")

$startTemplate = Join-Path $PSScriptRoot "start.cmd.template"
$startDestination = Join-Path $packageRoot "start.cmd"
Get-Content -LiteralPath $startTemplate -Raw | Set-Content -LiteralPath $startDestination -Encoding ASCII -NoNewline

Compress-Archive -LiteralPath $packageRoot -DestinationPath $archivePath -CompressionLevel Optimal
Remove-Item -LiteralPath $stageRoot -Recurse -Force

Write-Host "Portable Windows package created: $archivePath"
Write-Host "Included app files under ThePlayer\app, Node runtime under ThePlayer\runtime, and double-click launcher ThePlayer\start.cmd."
