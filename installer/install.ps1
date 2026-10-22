param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\AutoSwitch'),
  [switch]$NoLaunch,
  [switch]$NoDesktopShortcut,
  [switch]$NoAutoStart
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
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$launchTarget = '"' + $vbsPath + '"'

function New-AppShortcut {
  param([string]$Path, [string]$Target, [string]$Arguments, [string]$Description)
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.Description = $Description
  $shortcut.IconLocation = $iconLocation
  $shortcut.Save()
}

New-AppShortcut -Path (Join-Path $startMenuDir 'AutoSwitch.lnk') -Target $wscript `
  -Arguments $launchTarget -Description 'AutoSwitch 每日积分领航'
New-AppShortcut -Path (Join-Path $startMenuDir '卸载 AutoSwitch.lnk') `
  -Target (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') `
  -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir 'uninstall.ps1') + '"') `
  -Description '卸载 AutoSwitch'

if (-not $NoDesktopShortcut) {
  $desktops = @()
  foreach ($candidate in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Desktop'))) {
    if (-not $candidate) { continue }
    try { $desktop = (New-Item -ItemType Directory -Force -Path $candidate).FullName } catch { continue }
    if ($desktops -contains $desktop) { continue }
    $desktops += $desktop
    New-AppShortcut -Path (Join-Path $desktop 'AutoSwitch.lnk') -Target $wscript `
      -Arguments $launchTarget -Description 'AutoSwitch 每日积分领航'
  }
  foreach ($desktop in $desktops) { Write-Host "桌面快捷方式：$(Join-Path $desktop 'AutoSwitch.lnk')" }
}

$startupDir = [Environment]::GetFolderPath('Startup')
if (-not $NoAutoStart) {
  $taskFailed = $true
  try {
    $taskOutput = (& $NodePath $CliPath task install 2>&1 | Out-String)
    $taskFailed = ($LASTEXITCODE -ne 0)
  } catch {
    $taskFailed = $true
  }
  if ($taskFailed) {
    Write-Host '计划任务注册失败，改用「启动」文件夹快捷方式实现开机自启。'
    $silentVbs = Join-Path $InstallDir 'AutoSwitch-silent.vbs'
    $silentCommand = '"' + $NodePath + '" "' + $CliPath + '" start --no-open'
    $silentEscaped = $silentCommand.Replace('"', '""')
    $silentText = "Set sh = CreateObject(""WScript.Shell"")" + "`r`n" + "sh.Run ""$silentEscaped"", 0, False" + "`r`n"
    [System.IO.File]::WriteAllText($silentVbs, $silentText, $encoding)
    New-AppShortcut -Path (Join-Path $startupDir 'AutoSwitch.lnk') -Target $wscript `
      -Arguments ('"' + $silentVbs + '"') -Description 'AutoSwitch 开机自启'
  } else {
    Remove-Item (Join-Path $startupDir 'AutoSwitch.lnk') -Force -ErrorAction SilentlyContinue
    Write-Host '开机自启：计划任务 AutoSwitch（登录时静默启动，不弹浏览器）。'
  }
}

if (-not $NoLaunch) {
  try {
    Start-Process -FilePath $wscript -ArgumentList $launchTarget -WorkingDirectory $InstallDir
    Write-Host '已自动启动 AutoSwitch，面板地址 http://127.0.0.1:47871'
  } catch {
    Write-Host '自动启动失败，请双击桌面或开始菜单的 AutoSwitch。'
  }
}

Write-Host ''
Write-Host '安装完成。'
Write-Host '桌面 / 开始菜单 → AutoSwitch 启动。'
Write-Host "数据目录：$env:LOCALAPPDATA\AutoSwitch"
Write-Host "命令行：`"$NodePath`" `"$CliPath`" doctor"
