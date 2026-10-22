import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { dpapiProtect, dpapiUnprotect, hasDpapi } from "./win/dpapi.mjs";
import { localAppDataDir } from "./win/paths.mjs";
import { atomicWrite, isPlainObject, readJson } from "./util.mjs";

export const STORE_VERSION = 1;

function legacyHome() {
  return process.platform === "win32"
    ? path.join(localAppDataDir(), "CreditPilot")
    : path.join(os.homedir(), ".creditpilot");
}

/** 首次运行 AutoSwitch 时复制旧版 CreditPilot 数据，旧目录保留不动。 */
function migrateLegacyHome(next) {
  const legacy = legacyHome();
  try {
    if (fs.existsSync(next) || !fs.existsSync(legacy)) return;
    const temporary = `${next}.migrating`;
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.cpSync(legacy, temporary, {
      recursive: true,
      filter: (source) => !["server.pid", "start-creditpilot.vbs", "start-autoswitch.vbs"].includes(path.basename(source)),
    });
    fs.renameSync(temporary, next);
  } catch (error) {
    throw new Error(`迁移旧版 CreditPilot 数据到 AutoSwitch 失败：${error.message}`);
  }
}

export function resolveHome() {
  const override = process.env.AUTOSWITCH_HOME || process.env.CREDITPILOT_HOME;
  if (override) return path.resolve(override);
  const next =
    process.platform === "win32"
      ? path.join(localAppDataDir(), "AutoSwitch")
      : path.join(os.homedir(), ".autoswitch");
  migrateLegacyHome(next);
  return next;
}

export const DEFAULT_CONFIG = {
  port: 47871,
  autoClaim: true,
  intervalMinutes: 120,
  claimDelayMs: 900,
  createdAt: null,
  updatedAt: null,
};

function normalizeConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const port = Number(source.port);
  const interval = Number(source.intervalMinutes);
  const delay = Number(source.claimDelayMs);
  return {
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_CONFIG.port,
    autoClaim: source.autoClaim !== false,
    intervalMinutes: Number.isFinite(interval) && interval >= 15 ? Math.round(interval) : DEFAULT_CONFIG.intervalMinutes,
    claimDelayMs: Number.isFinite(delay) && delay >= 0 ? Math.min(Math.round(delay), 10_000) : DEFAULT_CONFIG.claimDelayMs,
    createdAt: typeof source.createdAt === "string" ? source.createdAt : null,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

function testKey() {
  const raw = process.env.AUTOSWITCH_TEST_KEY || process.env.CREDITPILOT_TEST_KEY;
  if (!raw) return null;
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error("AUTOSWITCH_TEST_KEY 必须是 64 位十六进制");
  return Buffer.from(raw, "hex");
}

function allowPlainKey() {
  return process.env.AUTOSWITCH_ALLOW_PLAIN_KEY === "1" || process.env.CREDITPILOT_ALLOW_PLAIN_KEY === "1";
}

function loadOrCreateKey(home) {
  const override = testKey();
  if (override) return override;
  const file = path.join(home, "store.key");
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    const [kind, payload] = text.split(":");
    if (kind === "v1" && payload) return dpapiUnprotect(Buffer.from(payload, "base64"));
    if (kind === "plain" && payload && allowPlainKey()) {
      return Buffer.from(payload, "base64");
    }
    throw new Error("store.key 格式无法识别");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!hasDpapi()) {
    if (!allowPlainKey()) {
      throw new Error(
        "当前系统没有 Windows DPAPI。若确实要在非 Windows 上运行，请设置 AUTOSWITCH_ALLOW_PLAIN_KEY=1（密钥将以明文文件保存，安全性降低）。",
      );
    }
    return crypto.randomBytes(32);
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(home, { recursive: true });
  atomicWrite(file, `v1:${dpapiProtect(key).toString("base64")}\n`);
  return key;
}

function encryptAccounts(key, value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    version: STORE_VERSION,
    iv: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: body.toString("base64"),
  });
}

function decryptAccounts(key, text) {
  const envelope = JSON.parse(text);
  if (envelope?.version !== STORE_VERSION) throw new Error("账号库版本不受支持");
  const nonce = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const data = Buffer.from(envelope.data, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  const parsed = JSON.parse(plain);
  return Array.isArray(parsed?.accounts) ? parsed.accounts : [];
}

const text = (value) => (typeof value === "string" ? value.trim() : "");
const safeIdPart = (value) => String(value).replace(/[^\w.-]/g, "_").slice(0, 120);

export function accountId(provider, uid) {
  return `${provider}:${safeIdPart(uid)}`;
}

export class Store {
  constructor({ home = resolveHome() } = {}) {
    this.home = path.resolve(home);
    this.configFile = path.join(this.home, "config.json");
    this.accountsFile = path.join(this.home, "accounts.enc");
    this.machineIdFile = path.join(this.home, "machine-id");
    this.key = null;
    this.config = normalizeConfig(DEFAULT_CONFIG);
    this.accounts = [];
  }

  init() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.key = loadOrCreateKey(this.home);
    const rawConfig = readJson(this.configFile, null);
    this.config = normalizeConfig(rawConfig);
    if (!this.config.createdAt) {
      this.config.createdAt = new Date().toISOString();
      this.saveConfig();
    }
    if (fs.existsSync(this.accountsFile)) {
      try {
        this.accounts = decryptAccounts(this.key, fs.readFileSync(this.accountsFile, "utf8"));
      } catch (error) {
        throw new Error(`账号库解密失败（store.key 与 ${this.accountsFile} 不匹配？）：${error.message}`);
      }
    }
    return this;
  }

  saveConfig() {
    this.config.updatedAt = new Date().toISOString();
    atomicWrite(this.configFile, `${JSON.stringify(this.config, null, 2)}\n`, 0o600);
  }

  updateConfig(patch) {
    this.config = normalizeConfig({ ...this.config, ...patch });
    this.saveConfig();
    return this.config;
  }

  saveAccounts() {
    atomicWrite(this.accountsFile, encryptAccounts(this.key, { version: STORE_VERSION, accounts: this.accounts }));
  }

  get machineId() {
    try {
      const value = fs.readFileSync(this.machineIdFile, "utf8").trim();
      if (/^[0-9a-f-]{20,}$/i.test(value)) return value;
    } catch {}
    const value = crypto.randomUUID();
    atomicWrite(this.machineIdFile, `${value}\n`);
    return value;
  }

  listAccounts() {
    return [...this.accounts];
  }

  getAccount(id) {
    return this.accounts.find((account) => account.id === id) || null;
  }

  findByUid(provider, uid) {
    return this.accounts.find((account) => account.provider === provider && String(account.uid) === String(uid)) || null;
  }

  activeUids() {
    const active = new Map();
    for (const account of this.accounts) {
      if (account.meta?.liveActive) active.set(account.provider, String(account.uid));
    }
    return active;
  }

  upsertAccount(input) {
    const provider = text(input.provider);
    const uid = text(input.uid);
    if (!provider) throw new Error("账号缺少 provider");
    if (!uid) throw new Error("账号缺少 uid");
    const id = accountId(provider, uid);
    const now = new Date().toISOString();
    let account = this.accounts.find((item) => item.id === id);
    const created = !account;
    if (!account) {
      account = {
        id,
        provider,
        uid,
        addedAt: now,
        createdAt: now,
      };
      this.accounts.push(account);
    }
    const patch = {
      name: text(input.name) || account.name || "",
      email: text(input.email) || account.email || "",
      phone: text(input.phone) || account.phone || "",
      token: text(input.token) || account.token || "",
      refreshToken: text(input.refreshToken) || account.refreshToken || "",
      expiresAt: text(input.expiresAt) || account.expiresAt || null,
      refreshExpiresAt: text(input.refreshExpiresAt) || account.refreshExpiresAt || null,
      source: text(input.source) || account.source || "local",
      meta: { ...(account.meta || {}), ...(isPlainObject(input.meta) ? input.meta : {}) },
      updatedAt: now,
    };
    if (input.snapshot !== undefined) patch.snapshot = input.snapshot;
    else if (!account.snapshot) patch.snapshot = null;
    Object.assign(account, patch);
    this.saveAccounts();
    return { account, created };
  }

  updateAccount(id, patch) {
    const account = this.getAccount(id);
    if (!account) throw new Error("账号不存在");
    Object.assign(account, patch, { updatedAt: new Date().toISOString() });
    this.saveAccounts();
    return account;
  }

  markLiveActive(provider, uid) {
    let changed = false;
    for (const account of this.accounts) {
      if (account.provider !== provider) continue;
      const active = uid !== null && uid !== undefined && String(account.uid) === String(uid);
      if (Boolean(account.meta?.liveActive) !== active) {
        account.meta = { ...(account.meta || {}), liveActive: active };
        changed = true;
      }
    }
    if (changed) this.saveAccounts();
  }

  removeAccount(id) {
    const account = this.getAccount(id);
    if (!account) return null;
    this.accounts = this.accounts.filter((item) => item.id !== id);
    this.saveAccounts();
    if (account.provider === "trae" && account.uid) {
      const slot = path.join(this.home, "trae-slots", safeIdPart(account.uid));
      try {
        fs.rmSync(slot, { recursive: true, force: true });
      } catch {}
    }
    return account;
  }

  publicAccount(account) {
    const expiresAt = account.expiresAt || null;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : null;
    return {
      id: account.id,
      provider: account.provider,
      uid: account.uid,
      name: account.name || account.email || account.phone || account.uid,
      email: account.email || "",
      phoneHint: account.phone ? `${account.phone.slice(0, 3)}****${account.phone.slice(-4)}` : "",
      expiresAt,
      expired: Number.isFinite(expiresMs) ? expiresMs <= Date.now() : false,
      source: account.source || "local",
      isActive: Boolean(account.meta?.liveActive),
      hasSnapshot: Boolean(account.snapshot),
      lastClaim: account.lastClaim || null,
      addedAt: account.addedAt || null,
      updatedAt: account.updatedAt || null,
    };
  }

  publicAccounts() {
    return this.listAccounts().map((account) => this.publicAccount(account));
  }
}
