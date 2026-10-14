param([string]$GeneratedManifest)
$ErrorActionPreference='Stop'
$installedManifest=Join-Path $PSScriptRoot 'plugin/manifest.json'
if(-not $GeneratedManifest){
 Add-Type -AssemblyName System.Windows.Forms
 [System.Windows.Forms.MessageBox]::Show('请先在 Figma 桌面端 Plugins → Development → New plugin 创建自己的开发插件。接下来选择 Figma 生成目录中的 manifest.json；无需修改源码或构建。','FigNexus 首次设置') | Out-Null
 $picker=New-Object System.Windows.Forms.OpenFileDialog
 $picker.Title='选择 Figma 刚生成的 manifest.json';$picker.Filter='Figma manifest (manifest.json)|manifest.json';$picker.CheckFileExists=$true
 if($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK){Write-Host '设置已跳过，稍后双击 开始使用.cmd 可继续。';return}
 $GeneratedManifest=$picker.FileName
}
& (Join-Path $PSScriptRoot 'runtime/node.exe') (Join-Path $PSScriptRoot 'scripts/distribution/plugin-configure.mjs') $installedManifest $GeneratedManifest
if($LASTEXITCODE -ne 0){throw 'Figma plugin setup failed; original manifest retained.'}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'plugin/.local-id-configured'),(Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json).id)
Write-Host 'Figma → Plugins → Development → Import plugin from manifest，选择：' $installedManifest
