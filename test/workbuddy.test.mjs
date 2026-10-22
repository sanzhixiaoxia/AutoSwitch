import test from "node:test";
import assert from "node:assert/strict";
import { parseActivity, parseQuota, sessionToAccount } from "../src/providers/workbuddy.mjs";

test("WorkBuddy 会话转换为账号，加密 token 不导入", () => {
  const session = {
    account: { uid: "wb-user", nickname: "测试账号", phoneNumber: "13800138000" },
    auth: {
      accessToken: "wb-access-token",
      refreshToken: "wb-refresh-token",
      domain: "www.codebuddy.cn",
      expiresAt: Date.now() + 86_400_000,
    },
  };
  const account = sessionToAccount(session, { source: "workbuddy-switch", active: true });
  assert.equal(account.id, "workbuddy:wb-user");
  assert.equal(account.provider, "workbuddy");
  assert.equal(account.name, "测试账号");
  assert.equal(account.token, "wb-access-token");
  assert.equal(account.meta.domain, "www.codebuddy.cn");
  assert.equal(account.meta.liveActive, true);
  assert.equal(account.snapshot, null);
  assert.equal(
    sessionToAccount({ account: { uid: "x" }, auth: { accessToken: { $wbEncrypted: 1 } } }),
    null,
  );
});

test("WorkBuddy 签到状态解析", () => {
  assert.equal(parseActivity(null).status, "failed");
  assert.equal(parseActivity({ active: false }).status, "no-activity");
  const claimed = parseActivity({ active: true, today_checked_in: true, today_credit: 100, daily_credit: 100, streak_days: 20 });
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.amount, 100);
  assert.match(claimed.message, /连续 20 天/);
  const claimable = parseActivity({ active: true, today_checked_in: false, daily_credit: 100 });
  assert.equal(claimable.status, "claimable");
  assert.equal(claimable.amount, 100);
});

test("WorkBuddy 额度解析兼容 summary 与 legacy 格式", () => {
  const summary = parseQuota({
    data: {
      Packages: [{ CycleTotalCapacity: "1000", CycleRemainCapacity: "750" }],
      TotalCredits: "750",
      SubscriptionPackageName: "体验版",
    },
  });
  assert.equal(summary.total, 1000);
  assert.equal(summary.remaining, 750);
  assert.equal(summary.used, 250);
  assert.equal(summary.plan, "体验版");

  const legacy = parseQuota({
    data: {
      Response: {
        Data: {
          Accounts: [
            { CycleCapacitySizePrecise: "100", CycleCapacityRemainPrecise: "40", DeductionEndTime: Date.now() + 86_400_000 },
            { CycleCapacitySizePrecise: "50", CycleCapacityRemainPrecise: "10", DeductionEndTime: Date.now() - 86_400_000 },
          ],
        },
      },
    },
  });
  assert.equal(legacy.total, 100);
  assert.equal(legacy.remaining, 40);
  assert.equal(legacy.used, 60);
});
