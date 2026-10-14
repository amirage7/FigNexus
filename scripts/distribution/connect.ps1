param([string]$DataRoot)
$ErrorActionPreference = 'Stop'
if (-not $DataRoot) { $DataRoot = Join-Path $env:LOCALAPPDATA 'FigmaAIBridge' }
$data = Join-Path ([IO.Path]::GetFullPath($DataRoot)) 'data'
$env:FIGMA_BRIDGE_DATA_DIR = $data
$env:FIGMA_BRIDGE_TOKEN_FILE = Join-Path $data 'token'
$env:FIGMA_BRIDGE_AUDIT_DIR = Join-Path $data 'audit'
& (Join-Path $PSScriptRoot 'runtime/node.exe') (Join-Path $PSScriptRoot 'apps/pairing-helper/dist/index.js')
if ($LASTEXITCODE -ne 0) { throw 'Connection helper failed; review the message above.' }
