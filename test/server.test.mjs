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
  const app = createServer({ store, log, engine, scheduler, port: 0, taskStatusFn: () => ({ supported: true, installed: false }) });
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
