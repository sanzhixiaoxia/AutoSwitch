import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { accountId } from "./store.mjs";
import { isPlainObject } from "./util.mjs";

export const BACKUP_FORMAT = "autoswitch-backup";
export const BACKUP_VERSION = 1;
const KDF = { name: "scrypt", N: 32768, r: 8, p: 1 };
const MAX_BACKUP_BYTES = 12 * 1024 * 1024;
const PROVIDERS = new Set(["qoder", "qoder-cn", "trae", "workbuddy"]);
const PROVIDER_LABEL = { qoder: "Qoder 国际版", "qoder-cn": "Qoder 国内版", trae: "Trae CN", workbuddy: "WorkBuddy" };

const text = (value, max = 200) =>
  (typeof value === "string" ? value : typeof value === "number" ? String(value) : "").trim().slice(0, max);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function validatePassword(password) {
  const value = typeof password === "string" ? password : "";
  if (value.length < 8) throw new Error("备份密码至少 8 位");
  if (value.length > 256) throw new Error("备份密码过长");
  return value;
}

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, 32, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 128 * 1024 * 1024,
  });
}

export function createBackup(store, password, appVersion) {
  const secret = validatePassword(password);
  const createdAt = new Date().toISOString();
  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    appVersion,
    includesTraeSlots: false,
    includesClaims: false,
    accounts: store.listAccounts(),
    config: {
      autoClaim: store.config.autoClaim,
      intervalMinutes: store.config.intervalMinutes,
      claimDelayMs: store.config.claimDelayMs,
    },
  };
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(secret, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const envelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    appVersion,
    kdf: { name: KDF.name, salt: salt.toString("base64"), N: KDF.N, r: KDF.r, p: KDF.p },
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    payload: ciphertext.toString("base64"),
  };
  return {
    buffer: Buffer.from(JSON.stringify(envelope, null, 2), "utf8"),
    filename: `AutoSwitch-backup-${stamp()}.asbackup`,
    createdAt,
    accounts: payload.accounts.length,
  };
}

export function decryptBackup(data, password) {
  const secret = validatePassword(password);
  if (!Buffer.isBuffer(data) || data.length < 100 || data.length > MAX_BACKUP_BYTES) {
    throw new Error("备份文件格式或大小不正确");
  }
  let envelope;
  try {
    envelope = JSON.parse(data.toString("utf8"));
  } catch {
    throw new Error("备份文件不是有效的 JSON");
  }
  if (
    envelope?.format !== BACKUP_FORMAT ||
    envelope?.version !== BACKUP_VERSION ||
    envelope?.kdf?.name !== KDF.name ||
    envelope?.kdf?.N !== KDF.N ||
    envelope?.kdf?.r !== KDF.r ||
    envelope?.kdf?.p !== KDF.p ||
    envelope?.cipher !== "aes-256-gcm"
  ) {
    throw new Error("不支持的备份格式或版本");
  }
  let salt, iv, tag, payload;
  try {
    salt = Buffer.from(envelope.kdf.salt, "base64");
    iv = Buffer.from(envelope.iv, "base64");
    tag = Buffer.from(envelope.tag, "base64");
    payload = Buffer.from(envelope.payload, "base64");
  } catch {
    throw new Error("备份文件字段损坏");
  }
  try {
    const key = deriveKey(secret, salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
    const result = JSON.parse(plain);
    if (result?.format !== BACKUP_FORMAT || result?.version !== BACKUP_VERSION) {
      throw new Error("format");
    }
    return result;
  } catch {
    throw new Error("密码错误或备份已损坏");
  }
}

function sanitizeSnapshot(provider, snapshot) {
  if (!isPlainObject(snapshot)) return null;
  if (provider === "trae") return { kind: "trae", uid: text(snapshot.uid, 120) };
  if (snapshot.kind === "qoder" && isPlainObject(snapshot.auth) && typeof snapshot.auth.token === "string") {
    return { kind: "qoder", auth: snapshot.auth };
  }
  return null;
}

function sanitizeAccount(raw) {
  if (!isPlainObject(raw)) return null;
  const provider = text(raw.provider, 20);
  const uid = text(raw.uid, 120);
  if (!PROVIDERS.has(provider) || !uid) return null;
  const now = new Date().toISOString();
  const meta = isPlainObject(raw.meta) ? { ...raw.meta } : {};
  delete meta.liveActive;
  delete meta.slot;
  delete meta.slotSavedAt;
  delete meta.slotError;
  return {
    id: accountId(provider, uid),
    provider,
    uid,
    name: text(raw.name, 200),
    email: text(raw.email, 200),
    phone: text(raw.phone, 40),
    token: text(raw.token, 8192),
    refreshToken: text(raw.refreshToken, 8192),
    expiresAt: text(raw.expiresAt, 80) || null,
    refreshExpiresAt: text(raw.refreshExpiresAt, 80) || null,
    source: ["device", "browser", "workbuddy-switch"].includes(raw.source) ? raw.source : "local",
    meta,
    snapshot: sanitizeSnapshot(provider, raw.snapshot),
    lastClaim: isPlainObject(raw.lastClaim) ? raw.lastClaim : null,
    addedAt: text(raw.addedAt, 80) || now,
    createdAt: text(raw.createdAt, 80) || now,
    updatedAt: text(raw.updatedAt, 80) || now,
  };
}

function sanitizeAccounts(value) {
  if (!Array.isArray(value)) throw new Error("备份中没有账号数据");
  const byId = new Map();
  for (const raw of value.slice(0, 200)) {
    const account = sanitizeAccount(raw);
    if (account) byId.set(account.id, account);
  }
  return [...byId.values()];
}

function makeRollback(store) {
  const directory = path.join(store.home, "backups", `rollback-${stamp()}-${crypto.randomBytes(2).toString("hex")}`);
  fs.mkdirSync(directory, { recursive: true });
  for (const file of ["accounts.enc", "config.json", "claims.jsonl"]) {
    const source = path.join(store.home, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(directory, file));
  }
  fs.writeFileSync(
    path.join(directory, "README.txt"),
    "这是 AutoSwitch 恢复备份前的自动回滚副本。\r\n停止服务后，把 accounts.enc、config.json 复制回数据目录即可恢复；claims.jsonl 为当时的领取记录。\r\n",
    "utf8",
  );
  return directory;
}

export function restoreBackup(store, data, password, { syncAll } = {}) {
  const payload = decryptBackup(data, password);
  const accounts = sanitizeAccounts(payload.accounts);
  if (accounts.length === 0) throw new Error("备份中没有有效账号");
  const rollbackDir = makeRollback(store);
  store.replaceAccounts(accounts);
  const config = isPlainObject(payload.config) ? payload.config : {};
  const interval = Number(config.intervalMinutes);
  const delay = Number(config.claimDelayMs);
  store.updateConfig({
    autoClaim: config.autoClaim !== false,
    ...(Number.isFinite(interval) && interval >= 15 ? { intervalMinutes: Math.round(interval) } : {}),
    ...(Number.isFinite(delay) && delay >= 0 ? { claimDelayMs: Math.round(delay) } : {}),
  });
  syncAll?.(store);
  return {
    accounts: store.listAccounts().length,
    rollbackDir,
    backupCreatedAt: payload.createdAt || null,
    backupAppVersion: payload.appVersion || null,
  };
}

export function exportAccounts(store, appVersion) {
  const accounts = store.publicAccounts().map((account) => ({
    ...account,
    providerLabel: PROVIDER_LABEL[account.provider] || account.provider,
    quota: store.getAccount(account.id)?.meta?.quota || null,
  }));
  const content = JSON.stringify(
    {
      format: "autoswitch-accounts-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion,
      accounts,
    },
    null,
    2,
  );
  return { content, filename: `AutoSwitch-accounts-${stamp()}.json` };
}

function csvCell(value) {
  let textValue = String(value ?? "");
  if (/^[=+\-@]/.test(textValue)) textValue = `'${textValue}`;
  return `"${textValue.replaceAll('"', '""')}"`;
}

export function exportClaimsCsv(log) {
  const entries = log.read(5000).reverse();
  const header = ["时间", "类型", "平台", "账号", "触发", "结果", "积分", "说明"];
  const typeLabel = { claim: "领取", run: "运行", event: "系统" };
  const lines = [header.map(csvCell).join(",")];
  for (const entry of entries) {
    lines.push(
      [
        entry.local || entry.at,
        typeLabel[entry.type] || entry.type || "",
        PROVIDER_LABEL[entry.provider] || entry.provider || "",
        entry.accountName || "",
        entry.trigger || "",
        entry.label || entry.status || "",
        entry.amount ?? "",
        entry.message || "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return {
    content: `\uFEFF${lines.join("\r\n")}\r\n`,
    filename: `AutoSwitch-claims-${stamp()}.csv`,
  };
}
