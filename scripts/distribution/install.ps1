param([string]$CodexHome, [string]$DataRoot, [switch]$NonInteractive, [switch]$SkipStart)
$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
if (-not $DataRoot) { $DataRoot = Join-Path $env:LOCALAPPDATA 'FigmaAIBridge' }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
if (-not $CodexHome) {
    $defaultHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $CodexHome = $defaultHome
}
$CodexHome = [IO.Path]::GetFullPath($CodexHome)
$manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'distribution.json') -Raw | ConvertFrom-Json
if ($manifest.bundleId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$') { throw 'Invalid release identity.' }
$destination = [IO.Path]::GetFullPath((Join-Path $DataRoot ('releases/' + $manifest.bundleId)))
$containedPrefix = $DataRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $destination.StartsWith($containedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installation destination escapes the selected data directory.' }
$data = Join-Path $DataRoot 'data'
$node = Join-Path $packageRoot 'runtime/node.exe'
$configure = Join-Path $packageRoot 'scripts/distribution/configure.mjs'
& $node $configure preview $destination $CodexHome $data
if ($LASTEXITCODE -ne 0) { throw 'Configuration conflict or invalid TOML. Nothing installed.' }
if (-not $NonInteractive) {
    if ((Read-Host 'Install this configuration? Type YES') -cne 'YES') { return }
}
New-Item -ItemType Directory -Force -Path $data | Out-Null
if (-not (Test-Path -LiteralPath $destination)) {
    $stage = [IO.Path]::GetFullPath(($destination + '.stage-' + [guid]::NewGuid().ToString('N')))
    if (-not $stage.StartsWith($containedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installation staging path escapes the selected data directory.' }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Get-ChildItem -LiteralPath $packageRoot -Force | Copy-Item -Destination $stage -Recurse
    Move-Item -LiteralPath $stage -Destination $destination
}
& (Join-Path $destination 'runtime/node.exe') (Join-Path $destination 'scripts/distribution/configure.mjs') install $destination $CodexHome $data
if ($LASTEXITCODE -ne 0) { throw 'Configuration update failed; review the reported backup.' }
Write-Host 'Installed. Restart Codex once. User data stays in:' $data

if(-not $NonInteractive -and -not $SkipStart){ & (Join-Path $destination 'start.ps1') -DataRoot $DataRoot -CodexHome $CodexHome }
