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

test("Trae 自然日轮次与 Qoder 轮次相互独立", () => {
  const now = Date.UTC(2026, 9, 22, 1, 0, 0); // 北京时间 09:00
  assert.equal(qoderRoundKey(now), "2026-10-21");
  assert.equal(traeRoundKey(now), "2026-10-22");
});
