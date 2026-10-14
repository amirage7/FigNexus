param([string]$DataRoot, [string]$CodexHome, [switch]$Setup, [switch]$NonInteractive)
$ErrorActionPreference='Stop'
if (-not $DataRoot) { $DataRoot = Join-Path $env:LOCALAPPDATA 'FigmaAIBridge' }
if (-not $CodexHome) { $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' } }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$CodexHome = [IO.Path]::GetFullPath($CodexHome)
$taskNode = Join-Path $PSScriptRoot 'runtime/node.exe'
$taskBootstrap = Join-Path $PSScriptRoot 'scripts/distribution/bootstrap.mjs'
$taskPlanText = & $taskNode $taskBootstrap $PSScriptRoot $CodexHome $DataRoot
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify installation; existing configuration retained.' }
$taskPlan = $taskPlanText | ConvertFrom-Json
$taskInstalledNow = $false
if ($taskPlan.needsInstall) {
 Write-Host '首次使用或升级：接下来预览本机安装配置，确认后继续。'
 $taskInstallArgs = @{CodexHome=$CodexHome; DataRoot=$DataRoot; SkipStart=$true; NonInteractive=[bool]$NonInteractive}
 & (Join-Path $PSScriptRoot 'install.ps1') @taskInstallArgs
 $taskPlanText = & $taskNode $taskBootstrap $PSScriptRoot $CodexHome $DataRoot
 if ($LASTEXITCODE -ne 0) { throw 'Installation could not be verified; service not started.' }
 $taskPlan = $taskPlanText | ConvertFrom-Json
 if ($taskPlan.needsInstall) { Write-Host '安装已取消，下次双击 开始使用 可继续。'; return }
 $taskInstalledNow = $true
}
# Always run the verified installed copy, including when launched from the ZIP folder.
$taskInstalledRoot = $taskPlan.installDir
& (Join-Path $taskInstalledRoot 'connect.ps1') -DataRoot $DataRoot
if($Setup -or -not(Test-Path -LiteralPath (Join-Path $taskInstalledRoot 'plugin/.import-instructions-shown'))){& (Join-Path $taskInstalledRoot 'setup-plugin.ps1') -DataRoot $DataRoot}
if ($taskInstalledNow) { Write-Host '安装完成，请重启 Codex 一次以加载接口。' }
Write-Host '在 Figma 运行 FigNexus，首次点击 配对本机，核对六位码并确认。'
Write-Host '以后：运行 Figma 插件 → 自动在线 → 开启编辑 → 在 Codex 说需求。'