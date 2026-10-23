import { adapterFor, providerMeta, syncAll } from "./providers/index.mjs";
import { cleanMessage, roundKey, sleep } from "./util.mjs";

const STATUS_LABEL = {
  claimed: "已领取",
  already: "已领取",
  claimable: "可领取",
  "no-activity": "暂无活动",
  expired: "凭据失效",
  failed: "失败",
  "device-limited": "本机名额已用",
  pending: "待检查",
};

const DONE = new Set(["claimed", "already"]);

function sortAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    const oa = providerMeta(a.provider)?.order ?? 9;
    const ob = providerMeta(b.provider)?.order ?? 9;
    if (oa !== ob) return oa - ob;
    return String(a.addedAt || "").localeCompare(String(b.addedAt || ""));
  });
}

export class ClaimEngine {
  constructor({ store, log }) {
    this.store = store;
    this.log = log;
    this.active = null;
  }

  get busy() {
    return Boolean(this.active);
  }

  select({ accountIds, provider } = {}) {
    const ids = Array.isArray(accountIds) && accountIds.length ? new Set(accountIds.map(String)) : null;
    return sortAccounts(
      this.store.listAccounts().filter((account) => {
        if (ids && !ids.has(account.id)) return false;
        if (provider && account.provider !== provider) return false;
        return true;
      }),
    );
  }

  async withLock(fn) {
    if (this.active) {
      const error = new Error("已有领取任务正在执行，请稍后再试");
      error.code = "busy";
      throw error;
    }
    let release;
    this.active = new Promise((resolve) => (release = resolve));
    try {
      return await fn();
    } finally {
      this.active = null;
      release?.();
    }
  }

  recordStatus(account, result, trigger) {
    const at = new Date().toISOString();
    const round = roundKey(account.provider, Date.now());
    const amount = Number.isFinite(Number(result.amount)) ? Number(result.amount) : null;
    const message = cleanMessage(result.message || "");
    account.lastClaim = { at, status: result.status, amount, message, roundKey: round };
    this.store.saveAccounts();
    this.log.append({
      type: "claim",
      at,
      provider: account.provider,
      providerLabel: providerMeta(account.provider)?.label || account.provider,
      accountId: account.id,
      accountName: account.name || account.uid,
      trigger,
      status: result.status,
      label: STATUS_LABEL[result.status] || result.status,
      amount,
      message,
      roundKey: round,
      durationMs: null,
    });
    return { at, round, amount, message };
  }

  async refreshStatuses({ accountIds, provider } = {}) {
    return this.withLock(async () => {
      syncAll(this.store);
      const accounts = this.select({ accountIds, provider });
      const results = [];
      for (const account of accounts) {
        const adapter = adapterFor(account);
        if (!adapter) {
          results.push({ accountId: account.id, provider: account.provider, status: "failed", message: "不支持的平台" });
          continue;
        }
        const result = await adapter.status(account, this.store, { withQuota: true });
        if (result.quota) {
          account.meta = { ...(account.meta || {}), quota: result.quota };
          this.store.saveAccounts();
        }
        // 刷新状态也要落到本轮记录，否则重新导入凭据后界面还挂着上一次的失败。
        const recorded = this.recordStatus(account, result, "status");
        results.push({
          accountId: account.id,
          provider: account.provider,
          name: account.name || account.uid,
          status: result.status,
          label: STATUS_LABEL[result.status] || result.status,
          amount: result.amount ?? null,
          message: cleanMessage(result.message || ""),
          endAt: result.endAt || null,
          quota: result.quota || account.meta?.quota || null,
          at: recorded.at,
          checkedAt: new Date().toISOString(),
        });
        if (accounts.length > 1) await sleep(250);
      }
      return { ok: true, checkedAt: new Date().toISOString(), results };
    });
  }

  async claimAll({ accountIds, provider, trigger = "manual" } = {}) {
    return this.withLock(async () => {
      const started = Date.now();
      const startedAt = new Date(started).toISOString();
      syncAll(this.store);
      const accounts = this.select({ accountIds, provider });

      // 国际版每台设备每日只能领一个账号。若本机今天已经有账号成功领取，
      // 其余国际版账号直接标记跳过，避免无意义的服务端拒绝。
      let intlDeviceUsed = false;
      if (accounts.some((account) => account.provider === "qoder")) {
        const qoderAccounts = this.store.listAccounts().filter((account) => account.provider === "qoder");
        const summary = this.log.summary(qoderAccounts, started);
        intlDeviceUsed = summary.accounts.some((row) => DONE.has(row.status));
      }

      const results = [];
      for (const account of accounts) {
        const adapter = adapterFor(account);
        const base = {
          accountId: account.id,
          provider: account.provider,
          accountName: account.name || account.uid,
        };
        if (!adapter) {
          const result = { ...base, status: "failed", amount: null, message: "不支持的平台" };
          results.push(result);
          continue;
        }

        let result;
        if (account.provider === "qoder" && intlDeviceUsed) {
          const current = await adapter.status(account, this.store, { withQuota: false });
          if (current.status === "claimed") {
            result = { status: "already", amount: current.amount, message: current.message || "今天已领取" };
          } else if (current.status === "claimable") {
            result = {
              status: "device-limited",
              amount: null,
              message: "本机今日的国际版名额已被其他账号使用（每台设备每天限领一个国际版账号）",
            };
          } else {
            result = current;
          }
        } else {
          result = await adapter.claim(account, this.store);
        }

        if (result.status === "claimed" || result.status === "already") {
          if (account.provider === "qoder") intlDeviceUsed = true;
        }

        const recorded = this.recordStatus(account, result, trigger);
        const enriched = {
          ...base,
          status: result.status,
          label: STATUS_LABEL[result.status] || result.status,
          amount: recorded.amount,
          message: recorded.message,
          at: recorded.at,
        };
        results.push(enriched);
        if (accounts.length > 1) await sleep(this.store.config.claimDelayMs);
      }

      const counts = {};
      for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
      const done = results.filter((result) => DONE.has(result.status)).length;
      const failed = counts.failed || 0;
      const durationMs = Date.now() - started;
      const message =
        results.length === 0
          ? "没有可领取的账号"
          : `本次完成 ${done}/${results.length} 个账号${failed ? `，${failed} 个失败` : ""}`;
      const run = this.log.append({
        type: "run",
        at: new Date().toISOString(),
        provider: provider || "all",
        trigger,
        status: failed ? "partial" : "ok",
        counts,
        done,
        total: results.length,
        durationMs,
        message,
      });
      return {
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs,
        results,
        summary: { total: results.length, done, failed, counts, message },
        run,
      };
    });
  }
}

