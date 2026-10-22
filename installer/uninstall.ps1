param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\AutoSwitch'),
  [switch]$KeepData
)

$ErrorActionPreference = 'SilentlyContinue'
$node = Join-Path $InstallDir 'node.exe'
$cli = Join-Path $InstallDir 'app\bin\autoswitch.mjs'
if ((Test-Path $node) -and (Test-Path $cli)) {
  & $node $cli stop | Out-Null
}
try {
  $processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'autoswitch\.mjs' }
  foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}
try { Unregister-ScheduledTask -TaskName 'AutoSwitch' -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AutoSwitch') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'AutoSwitch.lnk') -Force -ErrorAction SilentlyContinue
foreach ($desktop in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Desktop'))) {
  if ($desktop) { Remove-Item (Join-Path $desktop 'AutoSwitch.lnk') -Force -ErrorAction SilentlyContinue }
}
Set-Location $env:TEMP
Start-Sleep -Milliseconds 500
for ($i = 0; $i -lt 10; $i++) {
  try {
    if (-not (Test-Path $InstallDir)) { break }
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction Stop
    break
  } catch { Start-Sleep -Milliseconds 300 }
}
if (-not $KeepData) {
  $answer = Read-Host '是否同时删除账号与领取记录（数据目录）？输入 YES 删除，直接回车保留'
  if ($answer -eq 'YES') {
    Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'AutoSwitch') -Recurse -Force -ErrorAction SilentlyContinue
  }
}
Write-Host 'AutoSwitch 已卸载。'
