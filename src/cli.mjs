import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.mjs";
import { LogStore, readPidFile } from "./log.mjs";
import { ClaimEngine } from "./claim.mjs";
import { Scheduler } from "./scheduler.mjs";
import { createServer, openBrowser, VERSION } from "./server.mjs";
import { importAll, PROVIDER_IDS, adapterFor, syncAll } from "./providers/index.mjs";
import { startDeviceLogin, pollDeviceLogin, QODER_LABEL } from "./providers/qoder.mjs";
import { runDoctor } from "./doctor.mjs";
import { createBackup, restoreBackup, exportAccounts, exportClaimsCsv } from "./backup.mjs";
import { installTask, uninstallTask, taskStatus } from "./task.mjs";
import { localTime, sleep } from "./util.mjs";

const ENTRY = fileURLToPath(new URL("../bin/autoswitch.mjs", import.meta.url));

const HELP = `AutoSwitch ${VERSION} — Trae / Qoder / Qoder CN 每日积分自动领取

用法：
  autoswitch start [--port 47871] [--no-open]     启动本地服务与自动领取
  autoswitch stop                                 停止本机服务
  autoswitch claim [--provider <id>] [--account <id>] [--json]
  autoswitch status [--provider <id>] [--json]    只查询状态，不领取
  autoswitch import [--json]                      导入本机客户端当前登录的账号
  autoswitch accounts [--json]                    列出已保存账号
  autoswitch switch <账号ID> [--force]            切换客户端登录（会关闭客户端）
  autoswitch login <qoder|qoder-cn>               浏览器设备码登录 Qoder
  autoswitch doctor [--network] [--json]          检查登录态、风控与接口
  autoswitch logs [--limit 100]                   查看领取记录
  autoswitch backup <file> --password <p>         创建密码加密备份
  autoswitch restore <file> --password <p> --yes  恢复备份（需先停止服务）
  autoswitch export accounts|claims [--out <file>] 导出账号清单 / 领取记录 CSV
  autoswitch config [get|set <key> <value>]
  autoswitch task install|uninstall|status        开机自启计划任务

平台 ID：trae、qoder-cn、qoder
数据目录：默认 %LOCALAPPDATA%\\AutoSwitch，可用 AUTOSWITCH_HOME 覆盖
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=");
      if (inline !== undefined) args[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function init() {
  const store = new Store().init();
  const log = new LogStore(store.home);
  const engine = new ClaimEngine({ store, log });
  return { store, log, engine };
}

function printRows(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[index] ?? "").length)),
  );
  const line = (row) => row.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ");
  console.log(line(headers));
  console.log(widths.map((width) => "─".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
}

function statusText(status) {
  return (
    {
      claimed: "已领取",
      already: "已领取",
      claimable: "可领取",
      "no-activity": "暂无活动",
      expired: "凭据失效",
      failed: "失败",
      "device-limited": "本机名额已用",
      pending: "待检查",
      ok: "完成",
      partial: "部分失败",
      error: "失败",
    }[status] || status
  );
}

function printClaimResult(result) {
  if (!result.results?.length) {
    console.log(result.summary?.message || "没有可领取的账号");
    return;
  }
  printRows(
    ["平台", "账号", "结果", "积分", "说明"],
    result.results.map((row) => [
      row.provider,
      row.accountName,
      statusText(row.status),
      row.amount ?? "-",
      row.message || "",
    ]),
  );
  console.log("");
  console.log(result.summary.message);
}

async function commandStart(args) {
  const { store, log, engine } = init();
  if (args.port) store.config.port = Number(args.port);
  const port = store.config.port;
  const url = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (health.ok) {
      const body = await health.json().catch(() => null);
      if (body?.app === "autoswitch") {
        console.log(`AutoSwitch 已在运行：${url}`);
        if (!args["no-open"]) openBrowser(url);
        return;
      }
    }
  } catch {}

  syncAll(store);
  const scheduler = new Scheduler({ store, engine, log });
  const app = createServer({ store, log, engine, scheduler, port });
  try {
    await app.start();
  } catch (error) {
    if (error.code === "EADDRINUSE") throw new Error(`端口 ${port} 已被占用，请用 --port 换一个端口`);
    throw error;
  }
  scheduler.start();
  console.log(`AutoSwitch ${VERSION} 已启动：${url}`);
  console.log(`数据目录：${store.home}`);
  console.log(`自动领取：${store.config.autoClaim ? `开启（每 ${store.config.intervalMinutes} 分钟检查一次）` : "关闭"}`);
  console.log("按 Ctrl+C 停止。");
  if (!args["no-open"]) openBrowser(url);

  const shutdown = async () => {
    console.log("\n正在停止…");
    scheduler.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function commandStop() {
  const { store } = init();
  const port = store.config.port;
  const pidFile = path.join(store.home, "server.pid");
  const pid = readPidFile(store.home);
  if (!pid) throw new Error("没有找到运行中的 AutoSwitch 服务");
  let commandLine = "";
  try {
    commandLine = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    ).trim();
  } catch {}
  if (!commandLine) {
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {}
    throw new Error("没有运行中的 AutoSwitch 服务（已清理过期 pid 文件）");
  }
  if (!/autoswitch\.mjs/i.test(commandLine)) {
    throw new Error(`server.pid 指向的进程不是 AutoSwitch（${commandLine.slice(0, 120)}），未执行停止操作`);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(600) });
      if (!response.ok) break;
    } catch {
      break;
    }
  }
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {}
  console.log("AutoSwitch 服务已停止");
}

async function commandClaim(args) {  const { store, engine } = init();
  if (args.import) importAll(store);
  if (store.listAccounts().length === 0) {
    throw new Error("还没有账号，请先运行 autoswitch import 导入本机客户端当前登录的账号");
  }
  const provider = args.provider && PROVIDER_IDS.includes(args.provider) ? args.provider : undefined;
  if (args.provider && !provider) throw new Error(`未知平台：${args.provider}`);
  const accountIds = args.account ? String(args.account).split(",").map((id) => id.trim()).filter(Boolean) : undefined;
  const result = await engine.claimAll({ provider, accountIds, trigger: "cli" });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printClaimResult(result);
  process.exitCode = result.summary.failed ? 1 : 0;
}

async function commandStatus(args) {
  const { store, engine } = init();
  if (store.listAccounts().length === 0) throw new Error("还没有账号，请先运行 autoswitch import");
  if (args.provider && !PROVIDER_IDS.includes(args.provider)) throw new Error(`未知平台：${args.provider}`);
  const provider = args.provider || undefined;
  const result = await engine.refreshStatuses({ provider });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printRows(
    ["平台", "账号", "状态", "本轮积分", "剩余额度", "说明"],
    result.results.map((row) => [
      row.provider,
      row.name,
      statusText(row.status),
      row.amount ?? "-",
      row.quota?.remaining ?? "-",
      row.message || "",
    ]),
  );
}

async function commandImport(args) {
  const { store } = init();
  const result = importAll(store);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`导入完成：新增 ${result.imported} 个，更新 ${result.updated} 个`);
  if (result.skipped.length) {
    for (const row of result.skipped) console.log(`跳过 ${row.provider}：${row.reason}`);
  }
  if (result.errors.length) {
    for (const row of result.errors) console.log(`失败 ${row.provider}：${row.message}`);
    process.exitCode = 1;
  }
  const rows = store.listAccounts().map((account) => [
    account.id,
    account.name || account.email || account.uid,
    localTime(account.updatedAt),
  ]);
  if (rows.length) printRows(["账号 ID", "名称", "更新时间"], rows);
}

async function commandAccounts(args) {
  const { store, log } = init();
  const accounts = store.publicAccounts();
  if (args.json) {
    console.log(JSON.stringify(accounts, null, 2));
    return;
  }
  if (!accounts.length) {
    console.log("还没有账号。运行 autoswitch import 导入本机客户端当前登录账号。");
    return;
  }
  const summary = log.summary(store.listAccounts());
  const today = new Map(summary.accounts.map((row) => [row.accountId, row]));
  printRows(
    ["账号 ID", "平台", "名称", "当前登录", "本轮状态", "凭据到期"],
    accounts.map((account) => [
      account.id,
      account.provider,
      account.name,
      account.isActive ? "是" : "",
      statusText(today.get(account.id)?.status || "pending"),
      account.expiresAt ? localTime(account.expiresAt) : "-",
    ]),
  );
}

async function commandSwitch(args) {
  const id = args._[0];
  if (!id) throw new Error("用法：autoswitch switch <账号ID> [--force]");
  const { store } = init();
  const account =
    store.getAccount(id) ||
    store.listAccounts().find((item) => item.uid === id || item.name === id || item.email === id);
  if (!account) {
    const rows = store.listAccounts().map((item) => [item.id, item.provider, item.name || ""]);
    if (rows.length) printRows(["账号 ID", "平台", "名称"], rows);
    throw new Error("找不到账号");
  }
  const adapter = adapterFor(account);
  try {
    const result = await adapter.switchTo(store, account, { force: args.force === true });
    console.log(result.message || (result.alreadyActive ? "已经是当前登录账号" : "切换完成"));
    if (args.json) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error.code === "client-running") {
      console.log(error.message);
      console.log("确认要关闭客户端后重新运行：autoswitch switch <账号ID> --force");
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

async function commandLogin(args) {
  const provider = args._[0];
  if (!["qoder", "qoder-cn"].includes(provider)) {
    throw new Error("用法：autoswitch login qoder|qoder-cn");
  }
  const { store, log } = init();
  const session = startDeviceLogin(provider);
  console.log(`请在浏览器完成 ${QODER_LABEL[provider]} 授权：`);
  console.log(session.url);
  console.log("（5 分钟内有效）");
  openBrowser(session.url);
  const deadline = Date.now() + session.expiresIn * 1000;
  let lastMessage = "";
  while (Date.now() < deadline) {
    await sleep(session.interval * 1000);
    const result = await pollDeviceLogin(store, session.sessionId);
    if (result.status === "pending") continue;
    if (result.status === "ok") {
      log.append({
        type: "event",
        at: new Date().toISOString(),
        provider,
        accountId: result.account.id,
        accountName: result.account.name,
        status: "login",
        message: `浏览器登录成功：${result.account.name}`,
      });
      console.log(`登录成功：${result.account.name}（${result.account.id}）`);
      return;
    }
    if (result.status === "expired") throw new Error("登录会话已过期，请重新发起");
    if (result.message && result.message !== lastMessage) {
      lastMessage = result.message;
      console.log(result.message);
    }
  }
  throw new Error("登录超时，请重新发起");
}

async function commandDoctor(args) {
  const { store } = init();
  const result = await runDoctor(store, { network: args.network === true });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const check of result.checks) {
      console.log(`${check.ok ? "✓" : check.optional ? "○" : "✗"} ${check.name}：${check.detail}`);
    }
    console.log("");
    console.log(result.ok ? "检查通过。" : "存在问题，请按上面的提示处理。");
  }
  process.exitCode = result.ok ? 0 : 1;
}

function backupPassword(args) {
  const password = args.password || process.env.AUTOSWITCH_BACKUP_PASSWORD;
  if (!password) throw new Error("请用 --password 或 AUTOSWITCH_BACKUP_PASSWORD 提供备份密码（至少 8 位）");
  return String(password);
}

async function commandBackup(args) {
  const { store } = init();
  const result = createBackup(store, backupPassword(args), VERSION);
  const target = path.resolve(args._[0] || result.filename);
  fs.writeFileSync(target, result.buffer, { mode: 0o600 });
  console.log(`备份已写入 ${target}（${result.buffer.length} 字节，${result.accounts} 个账号）`);
  console.log("备份包含账号与设置，不含领取记录和 Trae 文件快照；请妥善保管密码与文件。");
}

async function commandRestore(args) {
  const file = args._[0];
  if (!file) throw new Error("用法：autoswitch restore <file> --password <p> --yes");
  if (args.yes !== true) throw new Error("恢复会覆盖当前账号与设置，请加 --yes 确认");
  const { store, log } = init();
  try {
    const response = await fetch(`http://127.0.0.1:${store.config.port}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (response.ok) throw new Error("服务正在运行，请先运行 autoswitch stop 再恢复备份");
  } catch (error) {
    if (error.message.includes("服务正在运行")) throw error;
  }
  const data = fs.readFileSync(path.resolve(file));
  const result = restoreBackup(store, data, backupPassword(args), { syncAll });
  log.append({
    type: "event",
    at: new Date().toISOString(),
    provider: "system",
    status: "restore",
    message: `已从备份恢复 ${result.accounts} 个账号`,
    detail: { accounts: result.accounts, backupCreatedAt: result.backupCreatedAt, rollbackDir: result.rollbackDir },
  });
  console.log(`已恢复 ${result.accounts} 个账号`);
  console.log(`恢复前回滚副本：${result.rollbackDir}`);
  console.log("请重新启动 AutoSwitch 服务。");
}

async function commandExport(args) {
  const type = args._[0];
  const { store, log } = init();
  let result;
  if (type === "accounts") result = exportAccounts(store, VERSION);
  else if (type === "claims") result = exportClaimsCsv(log);
  else throw new Error("用法：autoswitch export accounts|claims [--out <file>]");
  const target = path.resolve(args.out || result.filename);
  fs.writeFileSync(target, result.content, { encoding: "utf8", mode: 0o600 });
  console.log(`已导出 ${target}（${Buffer.byteLength(result.content)} 字节）`);
}

async function commandLogs(args) {
  const { log } = init();
  const entries = log.read(Number(args.limit) || 100);
  if (args.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (!entries.length) {
    console.log("暂无记录。");
    return;
  }
  printRows(
    ["时间", "类型", "平台", "账号", "状态", "积分", "说明"],
    entries.map((entry) => [
      entry.local || localTime(entry.at),
      entry.type || "claim",
      entry.provider === "system" || entry.provider === "all" ? "系统" : entry.provider || "",
      entry.accountName || "",
      entry.label || statusText(entry.status),
      entry.amount ?? "",
      entry.message || "",
    ]),
  );
}

async function commandConfig(args) {
  const { store } = init();
  const action = args._[0] || "get";
  if (action === "get") {
    console.log(JSON.stringify(store.config, null, 2));
    return;
  }
  if (action !== "set" || !args._[1]) throw new Error("用法：autoswitch config set <key> <value>");
  const key = args._[1];
  let value = args._[2];
  if (["autoClaim"].includes(key)) {
    if (!["true", "false"].includes(value)) throw new Error(`${key} 只能是 true/false`);
    value = value === "true";
  } else if (["intervalMinutes", "claimDelayMs", "port"].includes(key)) {
    value = Number(value);
    if (!Number.isFinite(value)) throw new Error(`${key} 必须是数字`);
  } else {
    throw new Error("可设置的键：autoClaim、intervalMinutes、claimDelayMs、port");
  }
  const config = store.updateConfig({ [key]: value });
  console.log(JSON.stringify(config, null, 2));
}

async function commandTask(args) {
  const action = args._[0] || "status";
  const { store } = init();
  if (action === "install") {
    const result = installTask({ home: store.home, entry: ENTRY });
    console.log(`已安装开机自启：${result.task}`);
    console.log(`启动器：${result.launcher}`);
    console.log(`Node：${result.node}`);
    return;
  }
  if (action === "uninstall") {
    uninstallTask();
    console.log("已移除开机自启计划任务。");
    return;
  }
  if (action === "status") {
    console.log(JSON.stringify(taskStatus(), null, 2));
    return;
  }
  throw new Error("用法：autoswitch task install|uninstall|status");
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._.shift() || "help";
  if (["help", "--help", "-h"].includes(command)) {
    console.log(HELP);
    return;
  }
  if (["version", "--version", "-v"].includes(command)) {
    console.log(VERSION);
    return;
  }
  switch (command) {
    case "start":
      return commandStart(args);
    case "stop":
      return commandStop();
    case "claim":
      return commandClaim(args);
    case "status":
      return commandStatus(args);
    case "import":
      return commandImport(args);
    case "accounts":
      return commandAccounts(args);
    case "switch":
      return commandSwitch(args);
    case "login":
      return commandLogin(args);
    case "backup":
      return commandBackup(args);
    case "restore":
      return commandRestore(args);
    case "export":
      return commandExport(args);
    case "doctor":
      return commandDoctor(args);
    case "logs":
      return commandLogs(args);
    case "config":
      return commandConfig(args);
    case "task":
      return commandTask(args);
    default:
      console.log(HELP);
      throw new Error(`未知命令：${command}`);
  }
}

export { HELP };
