import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.mjs";
import { LogStore } from "../src/log.mjs";
import { createBackup, exportAccounts, exportClaimsCsv, restoreBackup } from "../src/backup.mjs";

process.env.AUTOSWITCH_TEST_KEY = "12".repeat(32);
const PASSWORD = "correct horse battery";
const TOKEN = "dt-SECRET-BACKUP-TOKEN";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autoswitch-backup-"));
}

test("加密备份不含明文 token，恢复后保留账号与 Qoder 快照", () => {
  const sourceHome = tempHome();
  const targetHome = tempHome();
  try {
    const source = new Store({ home: sourceHome }).init();
    source.upsertAccount({
      provider: "qoder",
      uid: "q1",
      name: "备份账号",
      token: TOKEN,
      refreshToken: "drt-SECRET",
      expiresAt: "2030-01-01T00:00:00.000Z",
      snapshot: { kind: "qoder", auth: { token: TOKEN, user: { id: "q1" } } },
    });
    source.upsertAccount({
      provider: "trae",
      uid: "t1",
      name: "Trae 账号",
      token: "Cloud-IDE-JWT-SECRET",
      meta: { slot: true, slotSavedAt: "2026-01-01T00:00:00Z", deviceId: "1234567890" },
      snapshot: { kind: "trae", uid: "t1" },
    });
    source.updateConfig({ autoClaim: false, intervalMinutes: 240, claimDelayMs: 0 });

    const backup = createBackup(source, PASSWORD, "0.3.0");
    assert.match(backup.filename, /^AutoSwitch-backup-\d{8}-\d{6}\.asbackup$/);
    assert.equal(backup.accounts, 2);
    assert.ok(!backup.buffer.toString("utf8").includes(TOKEN));
    assert.ok(!backup.buffer.toString("utf8").includes("Cloud-IDE-JWT-SECRET"));
    assert.ok(!backup.buffer.toString("utf8").includes("备份账号"));

    const target = new Store({ home: targetHome }).init();
    const result = restoreBackup(target, backup.buffer, PASSWORD);
    assert.equal(result.accounts, 2);
    assert.ok(fs.existsSync(result.rollbackDir));
    const qoder = target.getAccount("qoder:q1");
    assert.equal(qoder.token, TOKEN);
    assert.equal(qoder.snapshot.kind, "qoder");
    assert.equal(qoder.snapshot.auth.token, TOKEN);
    const trae = target.getAccount("trae:t1");
    assert.equal(trae.token, "Cloud-IDE-JWT-SECRET");
    assert.equal(trae.snapshot.kind, "trae");
    assert.ok(!trae.meta.slot);
    assert.ok(!trae.meta.slotSavedAt);
    assert.equal(trae.meta.deviceId, "1234567890");
    assert.equal(target.config.autoClaim, false);
    assert.equal(target.config.intervalMinutes, 240);
    assert.equal(target.config.claimDelayMs, 0);

    assert.throws(() => restoreBackup(target, backup.buffer, "wrong password"), /密码错误|损坏/);
  } finally {
    fs.rmSync(sourceHome, { recursive: true, force: true });
    fs.rmSync(targetHome, { recursive: true, force: true });
  }
});

test("账号清单导出不含 token，领取 CSV 正确转义", () => {
  const home = tempHome();
  try {
    const store = new Store({ home }).init();
    store.upsertAccount({ provider: "qoder", uid: "q2", name: "导出账号", token: TOKEN, email: "x@example.com" });
    const log = new LogStore(home);
    log.append({
      type: "claim",
      at: "2026-10-22T10:00:00.000Z",
      provider: "qoder",
      accountId: "qoder:q2",
      accountName: '账号, "测试"',
      trigger: "manual",
      status: "claimed",
      label: "已领取",
      amount: 100,
      message: '=SUM(1),"quoted"\nnext',
      roundKey: "2026-10-22",
    });

    const accounts = exportAccounts(store, "0.3.0");
    assert.ok(accounts.content.includes("导出账号"));
    assert.ok(!accounts.content.includes(TOKEN));
    assert.equal(JSON.parse(accounts.content).format, "autoswitch-accounts-export");

    const claims = exportClaimsCsv(log);
    assert.ok(claims.content.startsWith("\uFEFF"));
    assert.ok(claims.content.includes('"时间","类型","平台"'));
    assert.ok(claims.content.includes("'=SUM(1)"));
    assert.ok(claims.content.includes('""quoted""'));
    assert.ok(!claims.content.includes(TOKEN));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
