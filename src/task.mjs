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
  return { installed: true, task: TASK_NAME, launcher: vbs, entry, node: process.execPath };
}

export function uninstallTask() {
  const script =
    "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" +
    `$t=Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue;` +
    `if ($t) { Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false };` +
    "Write-Output 'ok'";
  runPowerShell(script);
  return { installed: false, task: TASK_NAME };
}

export function taskStatus() {
  if (process.platform !== "win32") return { supported: false, installed: false };
  const script =
    "$ProgressPreference='SilentlyContinue';" +
    `$t=Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue;` +
    "if (-not $t) { '{\"installed\":false}' } else {" +
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
