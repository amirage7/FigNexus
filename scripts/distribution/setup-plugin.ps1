param([string]$GeneratedManifest, [string]$DataRoot)
$ErrorActionPreference='Stop'
if (-not $DataRoot) { $DataRoot = Join-Path $env:LOCALAPPDATA 'FigmaAIBridge' }
$installedManifest=Join-Path $PSScriptRoot 'plugin/manifest.json'
$taskPrepare = Join-Path $PSScriptRoot 'scripts/distribution/plugin-prepare.mjs'
$taskNode = Join-Path $PSScriptRoot 'runtime/node.exe'
$taskData = Join-Path $DataRoot 'data'
# Validate optional legacy identity and saved/current identity together before writing.
if ($GeneratedManifest) {
 & $taskNode $taskPrepare $PSScriptRoot $taskData --reuse-manifest $GeneratedManifest
} else {
 & $taskNode $taskPrepare $PSScriptRoot $taskData
}
if($LASTEXITCODE -ne 0){throw 'Plugin setup failed; original manifest and identity retained.'}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'plugin/.import-instructions-shown'),'1')
Write-Host ''
Write-Host '在 Figma 桌面端选择 Plugins → Development → Import plugin from manifest：'
Write-Host $installedManifest
Write-Host '直接导入这个文件，然后运行 FigNexus。不需要创建空白插件或获取 ID。'
Write-Host '在文件选择窗口的“文件名”栏粘贴完整路径即可。'