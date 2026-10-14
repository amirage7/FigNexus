param([string]$DataRoot,[switch]$Setup)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'connect.ps1') -DataRoot $DataRoot
if($Setup -or -not(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'plugin/.local-id-configured'))){& (Join-Path $PSScriptRoot 'setup-plugin.ps1')}
Write-Host '首次设置完成后重启 Codex。Figma 运行 FigNexus，点击 配对本机，核对自动弹出的六位码并确认。'
Write-Host '以后：打开 Figma 插件 → 自动在线 → 勾选编辑权限 → 在 Codex 说需求。'
