import { importAll } from "./providers/index.mjs";
import { recordSystemEvent } from "./log.mjs";
import { localTime } from "./util.mjs";

const START_DELAY_MS = 6_000;
const MIN_GAP_MS = 5_000;

export class Scheduler {
  constructor({ store, engine, log }) {
    this.store = store;
    this.engine = engine;
    this.log = log;
    this.timer = null;
    this.nextRunAt = null;
    this.started = false;
    this.lastError = null;
    this.autoRunning = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (this.store.config.autoClaim) {
      if (this.store.listAccounts().length === 0) {
        const result = importAll(this.store);
        recordSystemEvent(this.log, {
          status: "import",
          message: `首次启动自动导入：新增 ${result.imported} 个，更新 ${result.updated} 个`,
          detail: result,
        });
      }
      this.scheduleFromLastRun();
    }
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  applyConfig() {
    if (!this.started) return;
    if (!this.store.config.autoClaim) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.nextRunAt = null;
      return;
    }
    this.scheduleFromLastRun();
  }

  scheduleFromLastRun() {
    const interval = this.store.config.intervalMinutes * 60_000;
    const last = this.log.lastRun();
    const lastAt = last ? Date.parse(last.at) : 0;
    const due = Number.isFinite(lastAt) ? lastAt + interval : 0;
    const delay = Math.max(due - Date.now(), START_DELAY_MS);
    this.schedule(delay);
  }

  schedule(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(delayMs, MIN_GAP_MS);
    this.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => this.runAuto(), delay);
    this.timer.unref?.();
  }

  rescheduleAfterRun() {
    if (!this.started || !this.store.config.autoClaim) {
      this.nextRunAt = null;
      return;
    }
    this.schedule(this.store.config.intervalMinutes * 60_000);
  }

  /** 手动领取成功后，把下一次自动任务推后一个周期，避免刚领完又跑。 */
  defer() {
    if (!this.started || !this.store.config.autoClaim) return;
    this.rescheduleAfterRun();
  }

  async runAuto() {
    if (!this.started || this.autoRunning) return null;
    if (!this.store.config.autoClaim) {
      this.nextRunAt = null;
      return null;
    }
    if (this.engine.busy) {
      this.rescheduleAfterRun();
      return null;
    }
    this.autoRunning = true;
    try {
      const result = await this.engine.claimAll({ trigger: "auto" });
      this.lastError = null;
      return result;
    } catch (error) {
      this.lastError = error.message;
      recordSystemEvent(this.log, { status: "error", message: `自动领取失败：${error.message}` });
      return null;
    } finally {
      this.autoRunning = false;
      this.rescheduleAfterRun();
    }
  }

  state() {
    const lastRun = this.log.lastRun();
    return {
      autoClaim: this.store.config.autoClaim,
      intervalMinutes: this.store.config.intervalMinutes,
      running: Boolean(this.started),
      autoRunning: this.autoRunning,
      busy: this.engine.busy,
      lastRun: lastRun
        ? {
            at: lastRun.at,
            local: lastRun.local,
            message: lastRun.message,
            status: lastRun.status,
            counts: lastRun.counts || null,
            durationMs: lastRun.durationMs || null,
          }
        : null,
      nextRunAt: this.nextRunAt,
      nextRunLocal: this.nextRunAt ? localTime(this.nextRunAt) : null,
      lastError: this.lastError,
    };
  }
}
