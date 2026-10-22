import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.mjs";

process.env.AUTOSWITCH_TEST_KEY = "ab".repeat(32);

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autoswitch-store-"));
}

test("账号库加密落盘且公开信息不含 token", () => {
  const home = tempHome();
  try {
    const store = new Store({ home }).init();
    const { account, created } = store.upsertAccount({
      provider: "qoder",
      uid: "u1",
      name: "测试账号",
      email: "test@example.com",
      phone: "13800138000",
      token: "dt-SECRET-TOKEN",
      refreshToken: "drt-SECRET",
      expiresAt: "2030-01-01T00:00:00.000Z",
      source: "local",
      snapshot: { kind: "qoder", auth: { token: "dt-SECRET-TOKEN" } },
    });
    assert.equal(created, true);
    assert.equal(account.id, "qoder:u1");
    const publicAccount = store.publicAccount(account);
    assert.equal(publicAccount.phoneHint, "138****8000");
    assert.ok(!("token" in publicAccount));
    assert.ok(!("snapshot" in publicAccount));
    assert.ok(!JSON.stringify(publicAccount).includes("SECRET"));

    const encrypted = fs.readFileSync(path.join(home, "accounts.enc"), "utf8");
    assert.ok(!encrypted.includes("SECRET"));

    const reloaded = new Store({ home }).init();
    assert.equal(reloaded.getAccount("qoder:u1").token, "dt-SECRET-TOKEN");
    assert.equal(reloaded.getAccount("qoder:u1").snapshot.kind, "qoder");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("当前登录标记按平台独立更新", () => {
  const home = tempHome();
  try {
    const store = new Store({ home }).init();
    store.upsertAccount({ provider: "qoder", uid: "a", token: "t1" });
    store.upsertAccount({ provider: "qoder-cn", uid: "b", token: "t2" });
    store.markLiveActive("qoder", "a");
    assert.equal(store.getAccount("qoder:a").meta.liveActive, true);
    assert.ok(!store.getAccount("qoder-cn:b").meta.liveActive);
    store.markLiveActive("qoder-cn", "b");
    assert.equal(store.getAccount("qoder:a").meta.liveActive, true);
    assert.equal(store.getAccount("qoder-cn:b").meta.liveActive, true);
    store.markLiveActive("qoder", null);
    assert.equal(store.getAccount("qoder:a").meta.liveActive, false);
    assert.equal(store.getAccount("qoder-cn:b").meta.liveActive, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("重复 upsert 保留 addedAt 并更新 token", () => {
  const home = tempHome();
  try {
    const store = new Store({ home }).init();
    const first = store.upsertAccount({ provider: "trae", uid: "x", token: "old", name: "A" });
    const second = store.upsertAccount({ provider: "trae", uid: "x", token: "new", name: "B" });
    assert.equal(second.created, false);
    assert.equal(second.account.token, "new");
    assert.equal(second.account.name, "B");
    assert.equal(second.account.addedAt, first.account.addedAt);
    assert.equal(store.listAccounts().length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("移除账号删除 Trae 快照目录", () => {
  const home = tempHome();
  try {
    const store = new Store({ home }).init();
    store.upsertAccount({ provider: "trae", uid: "slot-user", token: "t" });
    const slot = path.join(home, "trae-slots", "slot-user");
    fs.mkdirSync(path.join(slot, "User"), { recursive: true });
    store.removeAccount("trae:slot-user");
    assert.equal(store.listAccounts().length, 0);
    assert.equal(fs.existsSync(slot), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
