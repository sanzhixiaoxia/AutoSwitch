import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWrite } from "./util.mjs";

export const TASK_NAME = process.env.AUTOSWITCH_TASK_NAME || process.env.CREDITPILOT_TASK_NAME || "AutoSwitch";

function runPowerShell(script) {
  if (process.platform !== "win32") throw new Error("开机自启任务仅支持 Windows");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error) throw new Error(`无法调用 PowerShell：${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || "").replace(/[^\x20-\x7e\u4e00-\u9fa5]/g, " ").trim();
    throw new Error(`计划任务操作失败${detail ? `：${detail.slice(0, 240)}` : `（退出码 ${result.status}）`}`);
  }
  return String(result.stdout || "").trim();
}

const psQuote = (value) => String(value).replace(/'/g, "''");

export function launcherPath(home) {
  return path.join(home, "start-autoswitch.vbs");
}

function writeLauncher(home, entry) {
  const command = `"${process.execPath}" "${entry}" start --no-open`;
  const escaped = command.replace(/"/g, '""');
  const vbs =
    'Set sh = CreateObject("WScript.Shell")\r\n' +
    `sh.Run "${escaped}", 0, False\r\n`;
  // WSH 默认按 ANSI 读取 .vbs；带 BOM 的 UTF-16LE 才能正确处理中文/空格路径。
  const payload = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, "utf16le")]);
  atomicWrite(launcherPath(home), payload, 0o600);
  return launcherPath(home);
}

export function installTask({ home, entry }) {
  if (!entry || !fs.existsSync(entry)) throw new Error("找不到 CLI 入口文件，无法安装开机自启");
  const vbs = writeLauncher(home, entry);
  const script =
    "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" +
    `$name='${TASK_NAME}';` +
    `$action=New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\wscript.exe' -Argument '\"${psQuote(vbs)}\"';` +
    `$trigger=New-ScheduledTaskTrigger -AtLogOn -User \"$env:USERDOMAIN\\$env:USERNAME\";` +
    "$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries " +
    "-StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5);" +
    `Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'AutoSwitch local daily credit daemon' -Force | Out-Null;` +
    "Write-Output 'ok'";
  runPowerShell(script);
  removeStartupShortcut();
  return { installed: true, task: TASK_NAME, launcher: vbs, entry, node: process.execPath };
}

// 安装器在计划任务注册失败时会退到「启动」文件夹快捷方式；只注销任务不够，
// 得把那条也清掉，否则用户在设置里关了自启，下次登录仍会被拉起来。
const FALLBACK_LNK_SCRIPT =
  "$ErrorActionPreference='SilentlyContinue';" +
  "$lnk=Join-Path ([Environment]::GetFolderPath('Startup')) 'AutoSwitch.lnk';" +
  "if (Test-Path $lnk) {" +
  " $sh=New-Object -ComObject WScript.Shell; $sc=$sh.CreateShortcut($lnk);" +
  " if ($sc.Arguments -match 'AutoSwitch-silent\\.vbs|autoswitch\\.mjs|start-autoswitch\\.vbs') { Remove-Item $lnk -Force; Write-Output 'removed' }" +
  "}";

export function removeStartupShortcut() {
  if (process.platform !== "win32") return false;
  try {
    return runPowerShell(FALLBACK_LNK_SCRIPT).includes("removed");
  } catch {
    return false;
  }
}

export function uninstallTask() {
  const script =
    "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" +
    `$t=Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue;` +
    `if ($t) { Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false };` +
    "Write-Output 'ok'";
  runPowerShell(script);
  removeStartupShortcut();
  return { installed: false, task: TASK_NAME };
}

export function taskStatus() {
  if (process.platform !== "win32") return { supported: false, installed: false };
  const script =
    "$ProgressPreference='SilentlyContinue';" +
    "$startup=$false;" +
    "$lnk=Join-Path ([Environment]::GetFolderPath('Startup')) 'AutoSwitch.lnk';" +
    "if (Test-Path $lnk) {" +
    " $sh=New-Object -ComObject WScript.Shell; $sc=$sh.CreateShortcut($lnk);" +
    " if ($sc.Arguments -match 'AutoSwitch-silent\\.vbs|autoswitch\\.mjs|start-autoswitch\\.vbs') { $startup=$true } };" +
    `$t=Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue;` +
    "if (-not $t) { [pscustomobject]@{installed=$startup} | ConvertTo-Json -Compress } else {" +
    ` $i=Get-ScheduledTaskInfo -TaskName '${TASK_NAME}';` +
    " [pscustomobject]@{installed=$true;state=[string]$t.State;lastRun=[string]$i.LastRunTime;" +
    " lastResult=$i.LastTaskResult;nextRun=[string]$i.NextRunTime} | ConvertTo-Json -Compress" +
    "}";
  try {
    const out = runPowerShell(script);
    const value = JSON.parse(out || '{"installed":false}');
    if (value.lastRun && /(1999|0001)/.test(String(value.lastRun))) value.lastRun = null;
    if (value.lastResult === 267011 || value.lastResult === 267009) value.lastResult = null;
    if (!value.nextRun) value.nextRun = null;
    return value;
  } catch (error) {
    return { supported: true, installed: false, error: error.message };
  }
}
