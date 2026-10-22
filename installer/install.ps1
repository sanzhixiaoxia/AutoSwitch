param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\AutoSwitch')
)

$ErrorActionPreference = 'Stop'
$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeSource = Join-Path $Source 'node.exe'
$AppZip = Join-Path $Source 'app.zip'
$IconSource = Join-Path $Source 'AutoSwitch.ico'
$UninstallSource = Join-Path $Source 'uninstall.ps1'
$ReadmeSource = Join-Path $Source 'README.txt'
$LicenseSource = Join-Path $Source 'node-LICENSE.txt'

if (-not (Test-Path $NodeSource)) { throw '安装包缺少 node.exe' }
if (-not (Test-Path $AppZip)) { throw '安装包缺少 app.zip' }

Write-Host "正在安装 AutoSwitch 到 $InstallDir ..."

# 安装前停止旧版/开发版实例，释放 node.exe 与 app 目录。
try {
  $processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'autoswitch\.mjs|creditpilot\.mjs' }
  foreach ($process in $processes) {
    try { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
  if ($processes) { Start-Sleep -Milliseconds 800 }
} catch {}

# 兼容从 CreditPilot 改名前的安装：移除旧开始菜单和旧计划任务，避免两个版本同时启动。
try { Unregister-ScheduledTask -TaskName 'CreditPilot' -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\CreditPilot') -Recurse -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$NodeTarget = Join-Path $InstallDir 'node.exe'
for ($i = 0; $i -lt 10; $i++) {
  try {
    Copy-Item -LiteralPath $NodeSource -Destination $NodeTarget -Force
    break
  } catch {
    if ($i -eq 9) { throw }
    Start-Sleep -Milliseconds 300
  }
}

$AppNew = Join-Path $InstallDir 'app.new'
$AppDir = Join-Path $InstallDir 'app'
if (Test-Path $AppNew) { Remove-Item -Recurse -Force $AppNew }
Expand-Archive -LiteralPath $AppZip -DestinationPath $AppNew -Force
if (Test-Path $AppDir) {
  for ($i = 0; $i -lt 10; $i++) {
    try { Remove-Item -Recurse -Force $AppDir; break } catch { if ($i -eq 9) { throw }; Start-Sleep -Milliseconds 300 }
  }
}
Move-Item -LiteralPath $AppNew -Destination $AppDir -Force

Copy-Item -LiteralPath $UninstallSource -Destination (Join-Path $InstallDir 'uninstall.ps1') -Force
if (Test-Path $ReadmeSource) { Copy-Item -LiteralPath $ReadmeSource -Destination (Join-Path $InstallDir 'README.txt') -Force }
if (Test-Path $LicenseSource) { Copy-Item -LiteralPath $LicenseSource -Destination (Join-Path $InstallDir 'node-LICENSE.txt') -Force }
if (Test-Path $IconSource) { Copy-Item -LiteralPath $IconSource -Destination (Join-Path $InstallDir 'AutoSwitch.ico') -Force }

$NodePath = Join-Path $InstallDir 'node.exe'
$CliPath = Join-Path $AppDir 'bin\autoswitch.mjs'
$command = '"' + $NodePath + '" "' + $CliPath + '" start'
$escaped = $command.Replace('"', '""')
$vbs = "Set sh = CreateObject(""WScript.Shell"")" + "`r`n" + "sh.Run ""$escaped"", 0, False" + "`r`n"
$vbsPath = Join-Path $InstallDir 'AutoSwitch.vbs'
$encoding = New-Object System.Text.UnicodeEncoding($false, $true)
[System.IO.File]::WriteAllText($vbsPath, $vbs, $encoding)

$cmdPath = Join-Path $InstallDir 'Start AutoSwitch.cmd'
$cmdText = "@echo off`r`n`"%~dp0node.exe`" `"%~dp0app\bin\autoswitch.mjs`" start`r`n"
[System.IO.File]::WriteAllText($cmdPath, $cmdText, [System.Text.Encoding]::ASCII)

$stopCmdPath = Join-Path $InstallDir 'Stop AutoSwitch.cmd'
$stopText = "@echo off`r`n`"%~dp0node.exe`" `"%~dp0app\bin\autoswitch.mjs`" stop`r`n pause`r`n"
[System.IO.File]::WriteAllText($stopCmdPath, $stopText, [System.Text.Encoding]::ASCII)

$shell = New-Object -ComObject WScript.Shell
$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AutoSwitch'
New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
$iconPath = Join-Path $InstallDir 'AutoSwitch.ico'
$iconLocation = if (Test-Path $iconPath) { "$iconPath,0" } else { "$NodePath,0" }

$lnk = $shell.CreateShortcut((Join-Path $startMenuDir 'AutoSwitch.lnk'))
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = '"' + $vbsPath + '"'
$lnk.WorkingDirectory = $InstallDir
$lnk.Description = 'AutoSwitch 每日积分领航'
$lnk.IconLocation = $iconLocation
$lnk.Save()

$unlnk = $shell.CreateShortcut((Join-Path $startMenuDir '卸载 AutoSwitch.lnk'))
$unlnk.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$unlnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir 'uninstall.ps1') + '"'
$unlnk.WorkingDirectory = $InstallDir
$unlnk.IconLocation = $iconLocation
$unlnk.Save()

Write-Host ''
Write-Host '安装完成。'
Write-Host '开始菜单 → AutoSwitch 启动。'
Write-Host "数据目录：$env:LOCALAPPDATA\AutoSwitch"
Write-Host "命令行：`"$NodePath`" `"$CliPath`" doctor"
