import fs from "node:fs";
import path from "node:path";
import { atomicWrite, cleanMessage, iso, localTime, roundKey, shortTime } from "./util.mjs";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_READ = 5000;

export class LogStore {
  constructor(home) {
    this.file = path.join(home, "claims.jsonl");
  }

  rotateIfNeeded() {
    try {
      const stat = fs.statSync(this.file);
      if (stat.size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
    } catch {}
  }

  append(record) {
    this.rotateIfNeeded();
    const at = record.at || new Date().toISOString();
    const entry = {
      type: "claim",
      at,
      local: localTime(at),
      short: shortTime(at),
      ...record,
      at,
    };
    if (entry.type === "claim" && !entry.roundKey) {
      entry.roundKey = roundKey(entry.provider, Date.parse(at));
    }
    if (entry.message) entry.message = cleanMessage(entry.message, 300);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  read(limit = 200) {
    let lines = [];
    try {
      lines = fs.readFileSync(this.file, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
    const cap = Math.max(1, Math.min(Number(limit) || 200, MAX_READ));
    return lines
      .slice(-cap)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  }

  latestClaim(accountId, provider, now = Date.now()) {
    const currentRound = roundKey(provider, now);
    let failure = null;
    for (const entry of this.read(MAX_READ)) {
      if (entry.type !== "claim") continue;
      if (entry.accountId !== accountId) continue;
      if (entry.roundKey !== currentRound) continue;
      if (["claimed", "already"].includes(entry.status)) return entry;
      failure ??= entry;
    }
    // 本轮没有成功记录时，用最近一次失败/过期说明状态，别让界面显示成「待检查」。
    return failure;
  }

  lastRun() {
    return this.read(200).find((entry) => entry.type === "run") || null;
  }

  summary(accounts, now = Date.now()) {
    const rows = accounts.map((account) => {
      const hit = this.latestClaim(account.id, account.provider, now);
      return {
        accountId: account.id,
        provider: account.provider,
        status: hit ? hit.status : "pending",
        amount: hit?.amount ?? null,
        message: hit?.message || "",
        at: hit?.at || null,
        local: hit?.local || null,
      };
    });
    const done = rows.filter((row) => ["claimed", "already"].includes(row.status));
    return {
      round: {
        qoder: roundKey("qoder", now),
        trae: roundKey("trae", now),
      },
      total: rows.length,
      done: done.length,
      pending: rows.length - done.length,
      accounts: rows,
    };
  }
}

export function recordSystemEvent(log, event) {
  return log.append({
    type: "event",
    at: iso(),
    local: localTime(),
    provider: "system",
    ...event,
  });
}

export function writePidFile(home, pid) {
  atomicWrite(path.join(home, "server.pid"), `${pid}\n`);
}

export function readPidFile(home) {
  try {
    return Number(fs.readFileSync(path.join(home, "server.pid"), "utf8").trim()) || null;
  } catch {
    return null;
  }
}
