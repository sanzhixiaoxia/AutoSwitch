import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Store } from "../src/store.mjs";
import { LogStore } from "../src/log.mjs";
import { createServer } from "../src/server.mjs";

process.env.AUTOSWITCH_TEST_KEY = "cd".repeat(32);

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autoswitch-server-"));
}

function rawRequest(port, { method = "GET", path: requestPath = "/", host = `127.0.0.1:${port}`, body = "", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: requestPath, method, headers: { Host: host, ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("本地 API：防 DNS 重绑定、CSRF 校验、状态不含 token", async () => {
  const home = tempHome();
  const store = new Store({ home }).init();
  store.upsertAccount({
    provider: "qoder",
    uid: "server-user",
    name: "本地账号",
    email: "a@example.com",
    token: "dt-SUPER-SECRET-TOKEN",
    expiresAt: "2030-01-01T00:00:00.000Z",
    snapshot: { kind: "qoder", auth: { token: "dt-SUPER-SECRET-TOKEN" } },
    meta: { liveActive: true },
  });
  const log = new LogStore(home);
  const scheduler = {
    state: () => ({ autoClaim: true, intervalMinutes: 120, running: true, autoRunning: false, busy: false, lastRun: null, nextRunAt: null, nextRunAtLocal: null, lastError: null }),
    defer() {},
    applyConfig() {},
  };
  const engine = {
    busy: false,
    async claimAll() {
      return { ok: true, summary: { total: 1, done: 1, failed: 0, message: "ok" }, results: [] };
    },
    async refreshStatuses() {
      return { ok: true, results: [{ accountId: "qoder:server-user", status: "claimed", name: "本地账号", message: "已领取" }] };
    },
  };
  const app = createServer({
    store,
    log,
    engine,
    scheduler,
    port: 0,
    taskStatusFn: () => ({ supported: true, installed: false }),
    syncAllFn: () => {},
  });
  let port;
  try {
    const started = await app.start();
    port = started.port;
    assert.ok(port > 0);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).app, "autoswitch");

    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(stateResponse.status, 200);
    const stateText = await stateResponse.text();
    assert.ok(!stateText.includes("SUPER-SECRET"));
    const state = JSON.parse(stateText);
    assert.equal(state.accounts.length, 1);
    assert.equal(state.accounts[0].name, "本地账号");
    assert.equal(state.summary.total, 1);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(await page.text(), /AutoSwitch/);

    const noCsrf = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoClaim: false }),
    });
    assert.equal(noCsrf.status, 403);

    const withCsrf = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-autoswitch": "1" },
      body: JSON.stringify({ autoClaim: false }),
    });
    assert.equal(withCsrf.status, 200);
    const configBody = await withCsrf.json();
    assert.equal(configBody.state.config.autoClaim, false);

    const missing = await fetch(`http://127.0.0.1:${port}/api/accounts/nope`, {
      method: "DELETE",
      headers: { "x-autoswitch": "1" },
    });
    assert.equal(missing.status, 404);

    const update = await fetch(`http://127.0.0.1:${port}/api/update`);
    assert.equal(update.status, 200);
    const updateBody = await update.json();
    assert.equal(updateBody.checked, false);
    assert.equal(updateBody.projectUrl, "https://github.com/sanzhixiaoxia/AutoSwitch");

    const backupResponse = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-autoswitch": "1" },
      body: JSON.stringify({ password: "backup-password" }),
    });
    assert.equal(backupResponse.status, 200);
    assert.match(backupResponse.headers.get("content-type"), /octet-stream/);
    assert.match(backupResponse.headers.get("content-disposition"), /AutoSwitch-backup-.*\.asbackup/);
    const backupBuffer = Buffer.from(await backupResponse.arrayBuffer());
    assert.ok(backupBuffer.toString("utf8").includes("autoswitch-backup"));
    assert.ok(!backupBuffer.toString("utf8").includes("SUPER-SECRET"));

    const restoreResponse = await fetch(`http://127.0.0.1:${port}/api/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-autoswitch": "1" },
      body: JSON.stringify({ password: "backup-password", data: backupBuffer.toString("base64") }),
    });
    assert.equal(restoreResponse.status, 200);
    const restoreBody = await restoreResponse.json();
    assert.equal(restoreBody.result.accounts, 1);
    assert.equal(restoreBody.state.accounts.length, 1);
    assert.ok(!JSON.stringify(restoreBody.state).includes("SUPER-SECRET"));

    const accountsExport = await fetch(`http://127.0.0.1:${port}/api/export/accounts.json`);
    assert.equal(accountsExport.status, 200);
    const accountsText = await accountsExport.text();
    assert.ok(!accountsText.includes("SUPER-SECRET"));
    assert.equal(JSON.parse(accountsText).format, "autoswitch-accounts-export");

    const claimsExport = await fetch(`http://127.0.0.1:${port}/api/export/claims.csv`);
    assert.equal(claimsExport.status, 200);
    const claimsBuffer = Buffer.from(await claimsExport.arrayBuffer());
    assert.deepEqual([...claimsBuffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const claimsText = claimsBuffer.toString("utf8").replace(/^\uFEFF/, "");
    assert.ok(claimsText.includes('"时间","类型","平台"'));

    const badHost = await rawRequest(port, { path: "/api/state", host: "evil.example" });
    assert.equal(badHost.status, 403);

    const status = await fetch(`http://127.0.0.1:${port}/api/status`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-autoswitch": "1" },
      body: "{}",
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).result.results[0].status, "claimed");
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Trae 可切换性以磁盘快照为准，不依赖 meta.slot 标记", async () => {
  const home = tempHome();
  const store = new Store({ home }).init();
  store.upsertAccount({
    provider: "trae",
    uid: "9000000000000001",
    name: "Trae 快照账号",
    token: "Cloud-IDE-JWT abc",
    meta: {},
  });
  const scheduler = {
    state: () => ({ autoClaim: false, intervalMinutes: 120, running: false, autoRunning: false, busy: false, lastRun: null, nextRunAt: null, nextRunAtLocal: null, lastError: null }),
    defer() {},
    applyConfig() {},
  };
  const engine = { busy: false, async claimAll() { return { ok: true, summary: {}, results: [] }; }, async refreshStatuses() { return { ok: true, results: [] }; } };
  const app = createServer({
    store,
    log: new LogStore(home),
    engine,
    scheduler,
    port: 0,
    taskStatusFn: () => ({ supported: true, installed: false }),
    syncAllFn: () => {},
  });
  try {
    const { port } = await app.start();
    const state = async () => (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).accounts[0];
    assert.equal((await state()).hasSnapshot, false, "没有快照时不该可切换");
    const slot = path.join(home, "trae-slots", "9000000000000001", "User", "globalStorage");
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(path.join(slot, "storage.json"), "{}");
    const after = await state();
    assert.equal(after.hasSnapshot, true, "磁盘已有快照就该可切换，哪怕 meta.slot 缺失");
    assert.equal(after.hasSlot, true);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("切换失败要写进记录，不能只弹一下就没了", async () => {
  const home = tempHome();
  const store = new Store({ home }).init();
  store.upsertAccount({ provider: "workbuddy", uid: "wb-1", name: "切不动的账号", token: "wb-token" });
  const log = new LogStore(home);
  const scheduler = {
    state: () => ({ autoClaim: false, intervalMinutes: 120, running: false, autoRunning: false, busy: false, lastRun: null, nextRunAt: null, nextRunAtLocal: null, lastError: null }),
    defer() {},
    applyConfig() {},
  };
  const engine = { busy: false, async claimAll() { return { ok: true, summary: {}, results: [] }; }, async refreshStatuses() { return { ok: true, results: [] }; } };
  const app = createServer({
    store,
    log,
    engine,
    scheduler,
    port: 0,
    taskStatusFn: () => ({ supported: true, installed: false }),
    syncAllFn: () => {},
  });
  try {
    const { port } = await app.start();
    const response = await fetch(`http://127.0.0.1:${port}/api/switch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-autoswitch": "1" },
      body: JSON.stringify({ accountId: "workbuddy:wb-1", force: true }),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error, /WorkBuddy Switch/);
    const entry = log.read(20).find((item) => item.status === "switch-failed");
    assert.ok(entry, "记录里应有一条切换失败");
    assert.equal(entry.provider, "workbuddy");
    assert.equal(entry.accountName, "切不动的账号");
    assert.match(entry.message, /^切换失败：/);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
