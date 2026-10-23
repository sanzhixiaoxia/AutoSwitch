import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LogStore } from "../src/log.mjs";
import { qoderRoundKey, traeRoundKey } from "../src/util.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autoswitch-log-"));
}

test("领取记录按轮次汇总，失败不覆盖成功", () => {
  const home = tempHome();
  try {
    const log = new LogStore(home);
    const now = Date.now();
    const round = qoderRoundKey(now);
    log.append({ type: "claim", at: new Date(now).toISOString(), provider: "qoder", accountId: "qoder:a", accountName: "A", status: "claimed", amount: 100, message: "ok", roundKey: round });
    log.append({ type: "claim", at: new Date(now + 1000).toISOString(), provider: "qoder", accountId: "qoder:a", accountName: "A", status: "failed", amount: null, message: "later fail", roundKey: round });
    log.append({ type: "claim", at: new Date(now - 86_400_000).toISOString(), provider: "qoder", accountId: "qoder:b", accountName: "B", status: "claimed", amount: 100, message: "old", roundKey: "1970-01-01" });

    const accounts = [
      { id: "qoder:a", provider: "qoder" },
      { id: "qoder:b", provider: "qoder" },
    ];
    const summary = log.summary(accounts, now);
    assert.equal(summary.done, 1);
    assert.equal(summary.accounts.find((row) => row.accountId === "qoder:a").status, "claimed");
    assert.equal(summary.accounts.find((row) => row.accountId === "qoder:b").status, "pending");
    assert.equal(log.latestClaim("qoder:a", "qoder", now).amount, 100);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("本轮只有失败/过期记录时，汇总回落到最近一次失败", () => {
  const home = tempHome();
  try {
    const log = new LogStore(home);
    const now = Date.now();
    const round = traeRoundKey(now);
    log.append({ type: "claim", at: new Date(now - 2000).toISOString(), provider: "trae", accountId: "trae:c", accountName: "C", status: "failed", message: "第一次失败", roundKey: round });
    log.append({ type: "claim", at: new Date(now).toISOString(), provider: "trae", accountId: "trae:c", accountName: "C", status: "failed", amount: null, message: "当前参与用户太多（code 9074）", roundKey: round });
    log.append({ type: "claim", at: new Date(now).toISOString(), provider: "trae", accountId: "trae:d", accountName: "D", status: "expired", message: "登录凭据已失效", roundKey: round });
    log.append({ type: "claim", at: new Date(now).toISOString(), provider: "trae", accountId: "trae:e", accountName: "E", status: "pending", message: "", roundKey: round });

    const summary = log.summary([{ id: "trae:c", provider: "trae" }, { id: "trae:d", provider: "trae" }, { id: "trae:e", provider: "trae" }], now);
    const rowC = summary.accounts.find((row) => row.accountId === "trae:c");
    assert.equal(rowC.status, "failed");
    assert.match(rowC.message, /9074/);
    assert.equal(summary.accounts.find((row) => row.accountId === "trae:d").status, "expired");
    assert.equal(summary.accounts.find((row) => row.accountId === "trae:e").status, "pending");
    assert.equal(summary.done, 0);
    assert.equal(summary.pending, 3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("本轮权威状态取最近一条：名额已用可覆盖早先误记的已领取", () => {
  const home = tempHome();
  try {
    const log = new LogStore(home);
    const now = Date.now();
    const round = traeRoundKey(now);
    log.append({ type: "claim", at: new Date(now - 4000).toISOString(), provider: "trae", accountId: "trae:f", accountName: "F", status: "already", amount: 100, message: "旧包误记", roundKey: round });
    log.append({ type: "claim", at: new Date(now).toISOString(), provider: "trae", accountId: "trae:f", accountName: "F", status: "device-limited", amount: null, message: "本机今日已签到过", roundKey: round });
    log.append({ type: "claim", at: new Date(now - 2000).toISOString(), provider: "trae", accountId: "trae:g", accountName: "G", status: "device-limited", amount: null, message: "先名额已用", roundKey: round });
    log.append({ type: "claim", at: new Date(now - 1000).toISOString(), provider: "trae", accountId: "trae:g", accountName: "G", status: "claimed", amount: 100, message: "后领到了", roundKey: round });

    const summary = log.summary([{ id: "trae:f", provider: "trae" }, { id: "trae:g", provider: "trae" }], now);
    assert.equal(summary.accounts.find((row) => row.accountId === "trae:f").status, "device-limited");
    assert.equal(summary.accounts.find((row) => row.accountId === "trae:g").status, "claimed");
    assert.equal(summary.done, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Trae 自然日轮次与 Qoder 轮次相互独立", () => {
  const now = Date.UTC(2026, 9, 22, 1, 0, 0); // 北京时间 09:00
  assert.equal(qoderRoundKey(now), "2026-10-21");
  assert.equal(traeRoundKey(now), "2026-10-22");
});
