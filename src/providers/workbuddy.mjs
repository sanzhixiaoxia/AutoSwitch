import fs from "node:fs";
import path from "node:path";
import { accountId } from "../store.mjs";
import { electronSafeStorage } from "../win/dpapi.mjs";
import { detectWorkBuddy } from "../win/paths.mjs";
import { requestJson, isAuthStatus, apiMessage } from "../http.mjs";
import { cleanMessage, iso, parseTimestamp } from "../util.mjs";

export const WORKBUDDY_PROVIDER = "workbuddy";
export const WORKBUDDY_LABEL = "WorkBuddy";
const DEFAULT_HOST = "www.codebuddy.cn";
const PROVIDER_LABEL = "WorkBuddy";
const STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const STATUS_FALLBACK_PATH = "/v2/billing/meter/checkin-status";
const CLAIM_PATH = "/v2/billing/meter/daily-checkin";
const QUOTA_PATH = "/billing/meter/get-user-resource-summary";
const QUOTA_LEGACY_PATH = "/v2/billing/meter/get-user-resource";
const USER_AGENT = "CLI/2.108.1 CodeBuddy/2.108.1";
const ALREADY = /已签到|签到过|重复签到|already|repeat/i;

const text = (value, max = 200) =>
  (typeof value === "string" ? value : typeof value === "number" ? String(value) : "").trim().slice(0, max);

export function decodeJwt(token) {
  try {
    const segment = String(token).split(".")[1];
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64 + "=".repeat((4 - (base64.length % 4)) % 4), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function domainOf(session) {
  const raw = text(session?.auth?.domain || session?.account?.domain || "", 200);
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return DEFAULT_HOST;
  }
}

function apiHost(account) {
  const raw = text(account?.meta?.domain || account?.meta?.host || "", 200);
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return DEFAULT_HOST;
  }
}

function expiryOf(auth, token) {
  const direct = parseTimestamp(auth?.expiresAt);
  if (direct) return direct;
  const payload = decodeJwt(token);
  return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
}

export function sessionToAccount(session, { source = "workbuddy-switch", active = false } = {}) {
  const token = session?.auth?.accessToken;
  if (typeof token !== "string" || !token) return null;
  const uid = text(session?.account?.uid || session?.uid, 120);
  if (!uid) return null;
  const account = session.account || {};
  const domain = domainOf(session);
  const expires = expiryOf(session.auth, token);
  const refreshExpires = parseTimestamp(session.auth?.refreshExpiresAt);
  const nickname = typeof account.nickname === "string" ? account.nickname.trim() : "";
  const phone = typeof account.phoneNumber === "string" ? account.phoneNumber.trim() : "";
  const name = nickname || phone || `WorkBuddy ${uid.slice(0, 8)}`;
  return {
    id: accountId(WORKBUDDY_PROVIDER, uid),
    provider: WORKBUDDY_PROVIDER,
    uid,
    name: name.slice(0, 200),
    email: text(account.email, 200),
    phone,
    token,
    refreshToken: text(session.auth?.refreshToken, 8192),
    expiresAt: expires ? iso(expires) : null,
    refreshExpiresAt: refreshExpires ? iso(refreshExpires) : null,
    source,
    meta: {
      domain,
      host: domain,
      liveActive: active,
      accountType: text(account.type, 40),
      importedFrom: source === "workbuddy-switch" ? "WorkBuddy Switch" : undefined,
    },
    snapshot: null,
    addedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function readClientAuth() {
  const app = detectWorkBuddy();
  if (!app.signedIn) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const root = JSON.parse(fs.readFileSync(app.authFile, "utf8"));
      const uid = text(root?.account?.uid, 120);
      return uid ? { uid, root, app } : null;
    } catch {
      if (attempt < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  return null;
}

export function importLocal(store) {
  const result = { imported: 0, updated: 0, skipped: [], errors: [] };
  const client = readClientAuth();
  if (!client) {
    result.skipped.push({ provider: WORKBUDDY_PROVIDER, reason: "WorkBuddy 客户端未登录" });
    store.markLiveActive(WORKBUDDY_PROVIDER, null);
    return result;
  }
  const token = client.root?.auth?.accessToken;
  if (typeof token !== "string" || !token) {
    result.skipped.push({
      provider: WORKBUDDY_PROVIDER,
      reason: "WorkBuddy 客户端凭据已加密，请从 WorkBuddy Switch 导入网页授权账号",
    });
    store.markLiveActive(WORKBUDDY_PROVIDER, client.uid);
    return result;
  }
  const input = sessionToAccount({ ...client.root, auth: { ...client.root.auth, domain: domainOf({ auth: client.root.auth }) } }, { source: "local", active: true });
  if (!input) {
    result.errors.push({ provider: WORKBUDDY_PROVIDER, message: "WorkBuddy 登录信息无法识别" });
    return result;
  }
  const existing = store.findByUid(WORKBUDDY_PROVIDER, input.uid);
  const { created } = store.upsertAccount(input);
  created ? result.imported++ : result.updated++;
  store.markLiveActive(WORKBUDDY_PROVIDER, input.uid);
  return result;
}

export function importFromSwitch(store) {
  const app = detectWorkBuddy();
  if (!app.switchVaultExists) {
    throw new Error("没有找到 WorkBuddy Switch 账号库。请先在 WorkBuddy Switch 中添加并登录账号，再重试。");
  }
  let vault;
  try {
    vault = JSON.parse(fs.readFileSync(app.switchVault, "utf8"));
  } catch (error) {
    throw new Error(`WorkBuddy Switch 账号库无法读取：${error.message}`);
  }
  const records = Array.isArray(vault?.records) ? vault.records : [];
  if (!records.length) throw new Error("WorkBuddy Switch 账号库中没有账号");
  let codec;
  try {
    codec = electronSafeStorage(app.switchDir);
  } catch (error) {
    throw new Error(`无法解密 WorkBuddy Switch 账号库：${error.message}`);
  }
  const activeUid = readClientAuth()?.uid || null;
  const byUid = new Map();
  const errors = [];
  for (const record of records) {
    try {
      const encrypted = record?.apiEncrypted || record?.encrypted;
      if (typeof encrypted !== "string" || !encrypted) continue;
      const session = JSON.parse(codec.decrypt(Buffer.from(encrypted, "base64")));
      const input = sessionToAccount(session, { source: "workbuddy-switch", active: false });
      if (!input) {
        errors.push({ uid: text(record?.profile?.id, 120), message: "该记录没有可用的 API token" });
        continue;
      }
      byUid.set(input.uid, input);
    } catch (error) {
      errors.push({ uid: text(record?.profile?.id, 120), message: cleanMessage(error.message) });
    }
  }
  const result = { imported: 0, updated: 0, errors, activeUid, total: byUid.size };
  for (const input of byUid.values()) {
    const existing = store.findByUid(WORKBUDDY_PROVIDER, input.uid);
    const { created } = store.upsertAccount({ ...input, source: existing?.source || input.source });
    created ? result.imported++ : result.updated++;
  }
  store.markLiveActive(WORKBUDDY_PROVIDER, activeUid);
  if (!result.imported && !result.updated) throw new Error("WorkBuddy Switch 账号库中没有可用的网页授权账号");
  return result;
}

export function syncActive(store) {
  const client = readClientAuth();
  if (!client) {
    store.markLiveActive(WORKBUDDY_PROVIDER, null);
    return;
  }
  const existing = store.findByUid(WORKBUDDY_PROVIDER, client.uid);
  const token = client.root?.auth?.accessToken;
  if (existing && typeof token === "string" && token) {
    const input = sessionToAccount({ ...client.root, auth: { ...client.root.auth, domain: domainOf({ auth: client.root.auth }) } }, { source: existing.source, active: true });
    if (input) store.upsertAccount(input);
  }
  store.markLiveActive(WORKBUDDY_PROVIDER, client.uid);
}

export function isExpired(account) {
  const expires = parseTimestamp(account?.expiresAt);
  return expires !== null && expires <= Date.now() + 5 * 60 * 1000;
}

function authHeaders(account, token) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-User-Id": account.uid,
    "X-Domain": apiHost(account),
    "X-Product": "SaaS",
    "User-Agent": USER_AGENT,
  };
}

function webHeaders(account, token) {
  const host = apiHost(account);
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Client-Platform": "web",
    "X-Domain": host,
    Origin: `https://${host}`,
    Referer: `https://${host}/profile/plans-usage`,
    "User-Agent": "WorkBuddy",
  };
}

function codeOf(json) {
  return json && typeof json === "object" && json.code !== undefined ? Number(json.code) : null;
}
const codeOk = (code) => code === null || [0, 200].includes(code);
const codeIsAuth = (code) => [401, 403, 12153].includes(code);

class WorkBuddyError extends Error {
  constructor(message, { auth = false } = {}) {
    super(message);
    this.auth = auth;
  }
}

async function call(account, token, requestPath, { web = false, body = {} } = {}) {
  let response;
  try {
    response = await requestJson(`https://${apiHost(account)}${requestPath}`, {
      method: "POST",
      headers: web ? webHeaders(account, token) : authHeaders(account, token),
      body,
    });
  } catch (error) {
    throw new WorkBuddyError(`无法连接 WorkBuddy 服务：${error.message}`);
  }
  if (isAuthStatus(response.status)) {
    throw new WorkBuddyError("WorkBuddy 登录凭据已失效，请重新从 WorkBuddy Switch 导入", { auth: true });
  }
  const code = codeOf(response.json);
  if (!response.ok) {
    const message = response.json?.msg || response.json?.message || response.text;
    const detail = `${apiMessage(message) || "WorkBuddy 服务请求失败"}（HTTP ${response.status}）`;
    throw new WorkBuddyError(detail, { auth: codeIsAuth(code) });
  }
  if (!response.json || typeof response.json !== "object") {
    throw new WorkBuddyError("WorkBuddy 服务返回了无法解析的数据");
  }
  if (!codeOk(code)) {
    throw new WorkBuddyError(`${apiMessage(response.json.msg) || "WorkBuddy 服务拒绝请求"}（code ${code}）`, {
      auth: codeIsAuth(code),
    });
  }
  return response.json;
}

function dataOf(json) {
  return json?.data && typeof json.data === "object" ? json.data : null;
}

export function parseActivity(data) {
  if (!data || typeof data !== "object") {
    return { status: "failed", amount: null, message: "签到状态返回了未知格式" };
  }
  if (data.active === false) {
    return { status: "no-activity", amount: null, message: "当前账号未开放每日签到" };
  }
  const checked = data.today_checked_in === true || data.today_checked_in === 1;
  const amount = [data.today_credit, data.daily_credit, data.reward_credit, data.credit]
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value >= 0) ?? null;
  const streak = Number(data.streak_days) || 0;
  if (checked) {
    return {
      status: "claimed",
      amount,
      streakDays: streak,
      message: `今天已签到${streak ? `（连续 ${streak} 天）` : ""}`,
    };
  }
  return {
    status: "claimable",
    amount,
    streakDays: streak,
    message: `今天可签到${amount !== null ? `（+${amount} 积分）` : ""}`,
  };
}

export function parseQuota(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.Packages) || data.TotalCredits !== undefined) {
    const packages = Array.isArray(data.Packages) ? data.Packages : [];
    const total = packages.reduce((sum, item) => sum + (Number(item.CycleTotalCapacity) || 0), 0);
    const remaining = Number(data.TotalCredits);
    const fallbackRemaining = packages.reduce((sum, item) => sum + (Number(item.CycleRemainCapacity) || 0), 0);
    const left = Number.isFinite(remaining) ? remaining : fallbackRemaining;
    if (total > 0 || left > 0) {
      return {
        total: Math.max(total, left),
        remaining: Math.max(left, 0),
        used: Math.max(total - left, 0),
        plan: text(data.SubscriptionPackageName, 80),
        updatedAt: new Date().toISOString(),
      };
    }
  }
  const legacy = data.Response?.Data || data.Data || payload?.Response?.Data;
  const rows = Array.isArray(legacy?.Accounts) ? legacy.Accounts : Array.isArray(legacy?.Packages) ? legacy.Packages : [];
  if (!rows.length) return null;
  let total = 0;
  let remaining = 0;
  for (const row of rows) {
    const rowTotal = Number(row.CycleCapacitySize ?? row.CycleCapacitySizePrecise ?? row.CapacitySizePrecise ?? row.CapacitySize) || 0;
    const rowRemain = Number(row.CycleCapacityRemain ?? row.CycleCapacityRemainPrecise ?? row.CapacityRemainPrecise ?? row.CapacityRemain) || 0;
    const expired = Number(row.DeductionEndTime ?? row.ExpiredTime ?? 0);
    if (Number.isFinite(expired) && expired > 0 && expired < Date.now()) continue;
    total += rowTotal;
    remaining += rowRemain;
  }
  if (total <= 0 && remaining <= 0) return null;
  return {
    total: Math.max(total, remaining),
    remaining: Math.max(remaining, 0),
    used: Math.max(total - remaining, 0),
    plan: text(legacy.SubscriptionPackageName || payload?.data?.SubscriptionPackageName, 80),
    updatedAt: new Date().toISOString(),
  };
}

async function fetchActivity(account) {
  try {
    const json = await call(account, account.token, STATUS_PATH);
    return dataOf(json);
  } catch (error) {
    if (error instanceof WorkBuddyError && !error.auth && /HTTP 404/i.test(error.message)) {
      const json = await call(account, account.token, STATUS_FALLBACK_PATH);
      return dataOf(json);
    }
    throw error;
  }
}

async function fetchQuota(account) {
  try {
    const json = await call(account, account.token, QUOTA_PATH, { web: true, body: { ProductCode: "p_tcaca" } });
    const quota = parseQuota(json);
    if (quota) return quota;
  } catch {}
  try {
    const json = await call(account, account.token, QUOTA_LEGACY_PATH, {
      web: true,
      body: { ProductCode: "p_tcaca", PageNumber: 1, PageSize: 100, Status: [0, 3] },
    });
    return parseQuota(json);
  } catch {
    return null;
  }
}

export async function status(account, _store, { withQuota = true } = {}) {
  if (!account.token) {
    return { status: "expired", amount: null, message: "没有可用的 WorkBuddy API token，请重新从 WorkBuddy Switch 导入" };
  }
  if (isExpired(account)) {
    return { status: "expired", amount: null, message: "WorkBuddy token 已过期，请重新从 WorkBuddy Switch 导入" };
  }
  try {
    const data = await fetchActivity(account);
    const parsed = parseActivity(data);
    const quota = withQuota ? await fetchQuota(account) : null;
    return { ...parsed, quota };
  } catch (error) {
    return {
      status: error.auth ? "expired" : "failed",
      amount: null,
      message: cleanMessage(error.message),
    };
  }
}

export async function claim(account, _store) {
  if (!account.token) {
    return { status: "expired", amount: null, message: "没有可用的 WorkBuddy API token，请重新从 WorkBuddy Switch 导入" };
  }
  if (isExpired(account)) {
    return { status: "expired", amount: null, message: "WorkBuddy token 已过期，请重新从 WorkBuddy Switch 导入" };
  }
  let activity;
  try {
    activity = await fetchActivity(account);
  } catch (error) {
    return {
      status: error.auth ? "expired" : "failed",
      amount: null,
      message: cleanMessage(error.message),
    };
  }
  const parsed = parseActivity(activity);
  if (parsed.status === "claimed") return { status: "already", amount: parsed.amount, message: parsed.message };
  if (parsed.status === "no-activity") return { status: "no-activity", amount: null, message: parsed.message };
  if (parsed.status !== "claimable") return { status: "failed", amount: null, message: parsed.message };
  try {
    const json = await call(account, account.token, CLAIM_PATH, { body: {} });
    const data = dataOf(json) || {};
    const amount = [data.today_credit, data.daily_credit, data.reward_credit, data.rewardCredit, data.credit]
      .map((value) => Number(value))
      .find((value) => Number.isFinite(value) && value >= 0) ?? parsed.amount;
    return {
      status: "claimed",
      amount: amount ?? null,
      message: `签到成功${amount !== null ? `，+${amount} 积分` : ""}${parsed.streakDays ? `（连续 ${parsed.streakDays} 天）` : ""}`,
    };
  } catch (error) {
    if (error.auth) return { status: "expired", amount: null, message: cleanMessage(error.message) };
    if (ALREADY.test(error.message)) return { status: "already", amount: parsed.amount, message: "今天已签到" };
    return { status: "failed", amount: null, message: cleanMessage(error.message) };
  }
}

export async function switchTo() {
  throw new Error("WorkBuddy 账号导入自 WorkBuddy Switch，暂不支持在 AutoSwitch 中切换客户端；请使用 WorkBuddy Switch 切换。");
}

export { PROVIDER_LABEL, apiHost, readClientAuth };
