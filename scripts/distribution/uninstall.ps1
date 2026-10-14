param([string]$CodexHome, [string]$DataRoot, [switch]$NonInteractive)
$ErrorActionPreference = 'Stop'
if (-not $DataRoot) { $DataRoot = Join-Path $env:LOCALAPPDATA 'FigmaAIBridge' }
if (-not $CodexHome) {
    $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    if (-not $NonInteractive) {
        $answer = Read-Host "Codex config directory (Enter = $CodexHome)"
        if ($answer) { $CodexHome = $answer }
    }
}
$CodexHome = [IO.Path]::GetFullPath($CodexHome)
& (Join-Path $PSScriptRoot 'runtime/node.exe') (Join-Path $PSScriptRoot 'scripts/distribution/configure.mjs') uninstall $PSScriptRoot $CodexHome (Join-Path ([IO.Path]::GetFullPath($DataRoot)) 'data')
if ($LASTEXITCODE -ne 0) { throw 'Identity check failed. Configuration and user data preserved.' }
Write-Host 'Codex entry removed. Programs, tokens, logs and design data retained. Restart Codex.'
