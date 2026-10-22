import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROVIDERS, providerMeta, detectClients, importAll, adapterFor, syncAll } from "./providers/index.mjs";
import { startDeviceLogin, pollDeviceLogin } from "./providers/qoder.mjs";
import { importFromSwitch as importWorkBuddyFromSwitch } from "./providers/workbuddy.mjs";
import { taskStatus, installTask, uninstallTask } from "./task.mjs";
import { runDoctor } from "./doctor.mjs";
import { PROJECT_URL, checkForUpdate, readCachedUpdate } from "./update.mjs";
import { createBackup, restoreBackup, exportAccounts, exportClaimsCsv } from "./backup.mjs";
import { readJsonBody, cleanMessage, localTime } from "./util.mjs";
import { recordSystemEvent, writePidFile } from "./log.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, "..", "public");
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(HERE, "..", "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

function sendText(response, status, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function sendDownload(response, buffer, contentType, filename) {
  const safeName = String(filename || "download.bin").replace(/[^A-Za-z0-9._-]/g, "_");
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    "Content-Disposition": `attachment; filename="${safeName}"`,
    "Cache-Control": "no-store",
  });
  response.end(buffer);
}

function publicConfig(config) {
  return {
    port: config.port,
    autoClaim: config.autoClaim,
    intervalMinutes: config.intervalMinutes,
    claimDelayMs: config.claimDelayMs,
  };
}

function sortedAccounts(store) {
  return [...store.listAccounts()].sort((a, b) => {
    const oa = providerMeta(a.provider)?.order ?? 9;
    const ob = providerMeta(b.provider)?.order ?? 9;
    if (oa !== ob) return oa - ob;
    return String(a.addedAt || "").localeCompare(String(b.addedAt || ""));
  });
}

function buildState(store, log, scheduler, port, task) {
  const summary = log.summary(store.listAccounts());
  const summaryById = new Map(summary.accounts.map((row) => [row.accountId, row]));
  const accounts = sortedAccounts(store).map((internal) => {
    const pub = store.publicAccount(internal);
    const meta = providerMeta(internal.provider);
    const today = summaryById.get(internal.id) || { status: "pending" };
    return {
      ...pub,
      providerLabel: meta?.label || internal.provider,
      providerShort: meta?.short || internal.provider,
      color: meta?.color || "#888",
      quota: internal.meta?.quota || null,
      hasSlot: Boolean(internal.meta?.slot || internal.snapshot),
      hasSnapshot:
        internal.provider === "trae" ? Boolean(internal.meta?.slot) : Boolean(internal.snapshot),
      today: {
        status: today.status,
        amount: today.amount ?? null,
        at: today.at || null,
        local: today.local || null,
        message: today.message || "",
      },
    };
  });
  const done = accounts.filter((account) => ["claimed", "already"].includes(account.today.status)).length;
  return {
    app: {
      name: "AutoSwitch",
      version: VERSION,
      home: store.home,
      port,
      now: new Date().toISOString(),
      nowLocal: localTime(),
      repoUrl: PROJECT_URL,
    },
    accounts,
    summary: {
      total: accounts.length,
      done,
      pending: accounts.length - done,
      round: summary.round,
    },
    scheduler: scheduler.state(),
    clients: detectClients(),
    providers: PROVIDERS,
    config: publicConfig(store.config),
    task,
  };
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } else {
      const command = process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(command, [url], { detached: true, stdio: "ignore" });
      child.unref();
    }
    return true;
  } catch {
    return false;
  }
}

function routeAccountId(pathname) {
  const match = pathname.match(/^\/api\/accounts\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function createServer({ store, log, engine, scheduler, port, taskStatusFn = taskStatus, syncAllFn = syncAll }) {
  const taskCache = { at: 0, value: { supported: true, installed: false } };
  const refreshTask = (force = false) => {
    if (!force && Date.now() - taskCache.at < 60_000) return taskCache.value;
    taskCache.at = Date.now();
    taskCache.value = taskStatusFn();
    return taskCache.value;
  };
  refreshTask(true);

  const server = http.createServer(async (request, response) => {
    const host = String(request.headers.host || "");
    const actualPort = server.address()?.port || port;
    const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
    if (!allowedHosts.has(host)) {
      return sendJson(response, 403, { error: "Host 不被允许" });
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url || "/", `http://${host}`).pathname);
    } catch {
      return sendJson(response, 400, { error: "请求路径无效" });
    }
    const url = new URL(request.url || "/", `http://${host}`);
    const method = request.method || "GET";

    if (pathname.startsWith("/api/")) {
      if (!["GET", "HEAD"].includes(method)) {
        if (request.headers["x-autoswitch"] !== "1") {
          return sendJson(response, 403, { error: "缺少请求校验头", code: "csrf" });
        }
        const contentType = String(request.headers["content-type"] || "");
        if (request.headers["content-length"] !== "0" && request.headers["content-length"] && !contentType.includes("application/json")) {
          return sendJson(response, 415, { error: "只接受 application/json" });
        }
      }

      try {
        if (pathname === "/api/health" && method === "GET") {
          return sendJson(response, 200, { ok: true, app: "autoswitch", version: VERSION });
        }

        if (pathname === "/api/state" && method === "GET") {
          return sendJson(response, 200, buildState(store, log, scheduler, port, refreshTask()));
        }

        if (pathname === "/api/update" && method === "GET") {
          return sendJson(response, 200, { ok: true, ...readCachedUpdate(store.home, VERSION) });
        }

        if (pathname === "/api/update/check" && method === "POST") {
          try {
            const update = await checkForUpdate(store.home, VERSION, { force: true });
            return sendJson(response, 200, { ok: true, update });
          } catch (error) {
            error.status = 502;
            throw error;
          }
        }

        if (pathname === "/api/backup" && method === "POST") {
          const body = await readJsonBody(request);
          try {
            const result = createBackup(store, String(body.password || ""), VERSION);
            return sendDownload(response, result.buffer, "application/octet-stream", result.filename);
          } catch (error) {
            error.status = 400;
            throw error;
          }
        }

        if (pathname === "/api/restore" && method === "POST") {
          if (engine.busy) return sendJson(response, 409, { error: "领取任务正在执行，请稍后再恢复", code: "busy" });
          const body = await readJsonBody(request, 12 * 1024 * 1024);
          let result;
          try {
            const data = Buffer.from(String(body.data || ""), "base64");
            result = restoreBackup(store, data, String(body.password || ""), { syncAll: syncAllFn });
          } catch (error) {
            error.status = 400;
            throw error;
          }
          scheduler.applyConfig();
          recordSystemEvent(log, {
            status: "restore",
            message: `已从备份恢复 ${result.accounts} 个账号`,
            detail: { accounts: result.accounts, backupCreatedAt: result.backupCreatedAt, rollbackDir: result.rollbackDir },
          });
          return sendJson(response, 200, {
            ok: true,
            result,
            state: buildState(store, log, scheduler, port, refreshTask()),
          });
        }

        if (pathname === "/api/export/accounts.json" && method === "GET") {
          const result = exportAccounts(store, VERSION);
          return sendDownload(response, Buffer.from(result.content, "utf8"), "application/json; charset=utf-8", result.filename);
        }

        if (pathname === "/api/export/claims.csv" && method === "GET") {
          const result = exportClaimsCsv(log);
          return sendDownload(response, Buffer.from(result.content, "utf8"), "text/csv; charset=utf-8", result.filename);
        }

        if (pathname === "/api/import" && method === "POST") {
          if (engine.busy) return sendJson(response, 409, { error: "领取任务正在执行，请稍后再导入", code: "busy" });
          const result = importAll(store);
          recordSystemEvent(log, {
            status: "import",
            message: `手动导入：新增 ${result.imported} 个，更新 ${result.updated} 个`,
            detail: result,
          });
          return sendJson(response, 200, { ok: true, result, state: buildState(store, log, scheduler, port, refreshTask()) });
        }

        if (pathname === "/api/workbuddy/import" && method === "POST") {
          if (engine.busy) return sendJson(response, 409, { error: "领取任务正在执行，请稍后再导入", code: "busy" });
          let result;
          try {
            result = importWorkBuddyFromSwitch(store);
          } catch (error) {
            error.status = 400;
            throw error;
          }
          recordSystemEvent(log, {
            status: "import",
            provider: "workbuddy",
            message: `WorkBuddy Switch 导入：新增 ${result.imported} 个，更新 ${result.updated} 个`,
            detail: result,
          });
          return sendJson(response, 200, {
            ok: true,
            result,
            state: buildState(store, log, scheduler, port, refreshTask()),
          });
        }

        if (pathname === "/api/claim" && method === "POST") {
          const body = await readJsonBody(request);
          if (body.provider !== undefined && body.provider !== null && body.provider !== "" && !PROVIDERS.some((item) => item.id === body.provider)) {
            return sendJson(response, 400, { error: "未知平台" });
          }
          const accountIds = Array.isArray(body.accountIds) ? body.accountIds.map(String).slice(0, 100) : undefined;
          const provider = PROVIDERS.some((item) => item.id === body.provider) ? body.provider : undefined;
          const result = await engine.claimAll({ accountIds, provider, trigger: "manual" });
          scheduler.defer();
          return sendJson(response, 200, {
            ok: true,
            result,
            state: buildState(store, log, scheduler, port, refreshTask()),
          });
        }

        if (pathname === "/api/status" && method === "POST") {
          const body = await readJsonBody(request);
          if (body.provider !== undefined && body.provider !== null && body.provider !== "" && !PROVIDERS.some((item) => item.id === body.provider)) {
            return sendJson(response, 400, { error: "未知平台" });
          }
          const accountIds = Array.isArray(body.accountIds) ? body.accountIds.map(String).slice(0, 100) : undefined;
          const provider = PROVIDERS.some((item) => item.id === body.provider) ? body.provider : undefined;
          const result = await engine.refreshStatuses({ accountIds, provider });
          return sendJson(response, 200, {
            ok: true,
            result,
            state: buildState(store, log, scheduler, port, refreshTask()),
          });
        }

        if (pathname === "/api/switch" && method === "POST") {
          if (engine.busy) return sendJson(response, 409, { error: "领取任务正在执行，请稍后再切换", code: "busy" });
          const body = await readJsonBody(request);
          const account = store.getAccount(String(body.accountId || ""));
          if (!account) return sendJson(response, 404, { error: "账号不存在" });
          const adapter = adapterFor(account);
          if (!adapter) return sendJson(response, 400, { error: "不支持的平台" });
          try {
            const result = await adapter.switchTo(store, account, { force: body.force === true });
            if (!result.alreadyActive) {
              recordSystemEvent(log, {
                status: "switch",
                provider: account.provider,
                accountId: account.id,
                accountName: account.name,
                message: result.message || `已切换到 ${account.name || account.uid}`,
              });
            }
            return sendJson(response, 200, {
              ok: true,
              result,
              state: buildState(store, log, scheduler, port, refreshTask()),
            });
          } catch (error) {
            if (error.code === "client-running") {
              return sendJson(response, 409, {
                error: error.message,
                code: "client-running",
                requiresConfirmation: true,
              });
            }
            throw error;
          }
        }

        if (pathname.startsWith("/api/accounts/") && method === "DELETE") {
          if (engine.busy) return sendJson(response, 409, { error: "领取任务正在执行，请稍后再移除", code: "busy" });
          const id = routeAccountId(pathname);
          const account = id ? store.getAccount(id) : null;
          if (!account) return sendJson(response, 404, { error: "账号不存在" });
          store.removeAccount(id);
          recordSystemEvent(log, {
            status: "remove",
            provider: account.provider,
            accountId: account.id,
            accountName: account.name,
            message: `已移除账号 ${account.name || account.uid}`,
          });
          return sendJson(response, 200, { ok: true, state: buildState(store, log, scheduler, port, refreshTask()) });
        }

        if (pathname === "/api/login/start" && method === "POST") {
          const body = await readJsonBody(request);
          const provider = PROVIDERS.some((item) => item.id === body.provider) ? body.provider : "";
          if (!["qoder", "qoder-cn"].includes(provider)) {
            return sendJson(response, 400, { error: "只支持 Qoder / Qoder CN 浏览器登录" });
          }
          const session = startDeviceLogin(provider);
          return sendJson(response, 200, { ok: true, session });
        }

        if (pathname === "/api/login/poll" && method === "GET") {
          const sessionId = url.searchParams.get("sessionId") || "";
          const result = await pollDeviceLogin(store, sessionId);
          if (result.status === "ok") {
            recordSystemEvent(log, {
              status: "login",
              provider: result.account?.provider || "qoder",
              accountId: result.account?.id,
              accountName: result.account?.name,
              message: `浏览器登录成功：${result.account?.name || result.account?.uid}`,
            });
            return sendJson(response, 200, {
              ok: true,
              ...result,
              state: buildState(store, log, scheduler, port, refreshTask()),
            });
          }
          return sendJson(response, 200, { ok: true, ...result });
        }

        if (pathname === "/api/logs" && method === "GET") {
          const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 200, 1000));
          const types = (url.searchParams.get("types") || "").split(",").filter(Boolean);
          const entries = log.read(Math.max(limit * 2, 200));
          const filtered = types.length ? entries.filter((entry) => types.includes(entry.type)) : entries;
          return sendJson(response, 200, { ok: true, entries: filtered.slice(0, limit) });
        }

        if (pathname === "/api/config" && method === "PUT") {
          const body = await readJsonBody(request);
          const patch = {};
          if (typeof body.autoClaim === "boolean") patch.autoClaim = body.autoClaim;
          if (Number.isFinite(Number(body.intervalMinutes))) patch.intervalMinutes = Number(body.intervalMinutes);
          if (Number.isFinite(Number(body.claimDelayMs))) patch.claimDelayMs = Number(body.claimDelayMs);
          if (Number.isFinite(Number(body.port))) patch.port = Number(body.port);
          const restartRequired = patch.port !== undefined && patch.port !== port;
          const next = store.updateConfig(patch);
          scheduler.applyConfig();
          return sendJson(response, 200, {
            ok: true,
            restartRequired,
            state: buildState(store, log, scheduler, port, refreshTask()),
            config: publicConfig(next),
          });
        }

        if (pathname === "/api/task/install" && method === "POST") {
          const entry = path.resolve(HERE, "..", "bin", "autoswitch.mjs");
          const result = installTask({ home: store.home, entry });
          taskCache.at = 0;
          const task = refreshTask(true);
          recordSystemEvent(log, { status: "task", message: "已安装开机自启计划任务" });
          return sendJson(response, 200, { ok: true, result, task, state: buildState(store, log, scheduler, port, task) });
        }

        if (pathname === "/api/task/uninstall" && method === "POST") {
          const result = uninstallTask();
          taskCache.at = 0;
          const task = refreshTask(true);
          recordSystemEvent(log, { status: "task", message: "已移除开机自启计划任务" });
          return sendJson(response, 200, { ok: true, result, task, state: buildState(store, log, scheduler, port, task) });
        }

        if (pathname === "/api/doctor" && method === "POST") {
          const result = await runDoctor(store, { network: false });
          return sendJson(response, 200, { ok: true, result });
        }

        return sendJson(response, 404, { error: "接口不存在" });
      } catch (error) {
        const status = error.code === "busy" ? 409 : error.status || 500;
        if (status >= 500) console.error("[autoswitch]", cleanMessage(error.stack || error.message, 500));
        return sendJson(response, status, {
          error: cleanMessage(error.message || "服务器内部错误", 300),
          code: error.code || "error",
        });
      }
    }

    if (!["GET", "HEAD"].includes(method)) return sendText(response, 405, "Method Not Allowed");
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(PUBLIC_DIR, relative);
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, "index.html")) {
      return sendText(response, 403, "Forbidden");
    }
    let content;
    try {
      content = fs.readFileSync(file);
    } catch {
      return sendText(response, 404, "Not Found");
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": type,
      "Content-Length": content.length,
      "Cache-Control": "no-cache",
    });
    if (method === "HEAD") response.end();
    else response.end(content);
  });

  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      port = server.address()?.port || port;
      writePidFile(store.home, process.pid);
      return { port, url: `http://127.0.0.1:${port}` };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        fs.rmSync(path.join(store.home, "server.pid"), { force: true });
      } catch {}
    },
  };
}

export { openBrowser, VERSION };
