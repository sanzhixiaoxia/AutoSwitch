import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { electronSafeStorage } from "../win/dpapi.mjs";
import {
  detectQoder,
  qoderExeNames,
  launchClient,
  terminateProcesses,
} from "../win/paths.mjs";
import { qoderHeaders } from "../risk.mjs";
import { requestJson, isAuthStatus, apiMessage } from "../http.mjs";
import { atomicWrite, cleanMessage, iso, parseTimestamp, sleep } from "../util.mjs";

export const QODER_PROVIDERS = ["qoder", "qoder-cn"];
export const QODER_LABEL = { qoder: "Qoder 国际版", "qoder-cn": "Qoder 国内版" };
const BASE = {
  qoder: "https://openapi.qoder.sh",
  "qoder-cn": "https://openapi.qoder.com.cn",
};
const LOGIN_URL = {
  qoder: "https://qoder.com/device/selectAccounts",
  "qoder-cn": "https://qoder.cn/device/selectAccounts",
};
const CAMPAIGNS = "/sash/api/v1/me/campaigns?clientType=10";
const claimPath = (id) => `/sash/api/v1/me/campaigns/${encodeURIComponent(id)}/claim`;
const USERINFO = "/api/v1/userinfo";
const QUOTA = "/api/v2/quota/usage";

function authFileOf(app) {
  return path.join(app.dataDir, "auth.v1.dat");
}

/** 客户端可能正在重写凭据，读到半截时短暂重试。 */
export function readLiveAuth(provider, { attempts = 3 } = {}) {
  const app = detectQoder(provider);
  if (!app.signedIn) return null;
  const codec = electronSafeStorage(app.dataDir);
  const file = authFileOf(app);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const auth = JSON.parse(codec.decrypt(fs.readFileSync(file)));
      if (!auth?.token || typeof auth.token !== "string") throw new Error("登录信息中没有 token");
      if (!auth?.user?.id) throw new Error("登录信息中没有用户 ID");
      return { app, auth, uid: String(auth.user.id) };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        // 同步小睡：读取凭据发生在启动/定时任务里，不值得为此引入异步重试链。
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
  }
  throw new Error(`${QODER_LABEL[provider]} 登录态读取失败：${lastError?.message || "未知错误"}，请在客户端重新登录`);
}

export function accountInputFromLive(provider, live) {
  const user = live.auth.user || {};
  return {
    provider,
    uid: String(user.id || live.uid),
    name: user.name || user.email || user.phone || `Qoder ${String(user.id).slice(0, 8)}`,
    email: user.email || "",
    phone: user.phone || "",
    token: live.auth.token,
    refreshToken: live.auth.refreshToken || "",
    expiresAt: live.auth.expiresAt || null,
    refreshExpiresAt: live.auth.refreshTokenExpiresAt || null,
    source: "local",
    meta: {
      appDir: live.app.appDir,
      dataDir: live.app.dataDir,
      version: live.app.version,
      liveActive: true,
    },
    snapshot: { kind: "qoder", auth: live.auth },
  };
}

export function importLocal(store) {
  const result = { imported: 0, updated: 0, skipped: [], errors: [] };
  for (const provider of QODER_PROVIDERS) {
    try {
      const live = readLiveAuth(provider);
      if (!live) {
        result.skipped.push({ provider, reason: "客户端未登录" });
        store.markLiveActive(provider, null);
        continue;
      }
      const input = accountInputFromLive(provider, live);
      const existing = store.findByUid(provider, input.uid);
      const { created } = store.upsertAccount(input);
      created ? result.imported++ : result.updated++;
      store.markLiveActive(provider, input.uid);
    } catch (error) {
      result.errors.push({ provider, message: cleanMessage(error.message) });
    }
  }
  return result;
}

/** 定时/手动领取前同步当前客户端账号的最新 token，不新增账号。 */
export function syncActive(store) {
  for (const provider of QODER_PROVIDERS) {
    try {
      const live = readLiveAuth(provider);
      if (!live) {
        store.markLiveActive(provider, null);
        continue;
      }
      const existing = store.findByUid(provider, live.uid);
      if (existing) store.upsertAccount({ ...accountInputFromLive(provider, live), source: existing.source });
      store.markLiveActive(provider, live.uid);
    } catch {
      // 客户端未运行或正在写文件时保持旧 token，不阻断其他平台领取。
    }
  }
}

export function isExpired(account) {
  const ts = parseTimestamp(account.expiresAt);
  return ts !== null && ts <= Date.now() + 5 * 60 * 1000;
}

const isAuthError = (error) => error?.code === "auth";

export function normalizeCampaigns(payload) {
  const campaigns = Array.isArray(payload?.campaigns) ? payload.campaigns.filter((c) => c && typeof c === "object") : [];
  const nowSeconds = Date.now() / 1000;
  const active = campaigns.filter((c) => {
    const start = Number(c.startAt);
    const end = Number(c.endAt);
    if (Number.isFinite(start) && start > nowSeconds) return false;
    if (Number.isFinite(end) && end <= nowSeconds) return false;
    return true;
  });
  const benefits = active.filter((c) => c.actionType === "CLAIM_BENEFIT");
  const claimable = benefits.filter((c) => c.claimStatus === "CLAIMABLE");
  const claimed = benefits.filter((c) => c.claimStatus === "CLAIMED");
  return { campaigns, active, benefits, claimable, claimed };
}

const amountOf = (campaign) => {
  const amount = Number(campaign?.benefit?.amount);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
};
const sumAmounts = (campaigns) => {
  const values = campaigns.map(amountOf).filter((value) => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
};
const campaignLabel = (campaign) => campaign?.campaignKey || campaign?.campaignId || "?";
const maxEndAt = (campaigns) => {
  const values = campaigns.map((c) => Number(c.endAt)).filter(Number.isFinite);
  return values.length ? Math.max(...values) * 1000 : null;
};

async function fetchCampaigns(account, store) {
  const headers = await qoderHeaders(account.provider, account, store);
  let response;
  try {
    response = await requestJson(`${BASE[account.provider]}${CAMPAIGNS}`, { headers });
  } catch (error) {
    throw Object.assign(new Error(`无法连接 ${QODER_LABEL[account.provider]} 活动服务：${error.message}`), {
      code: "network",
    });
  }
  if (isAuthStatus(response.status)) {
    throw Object.assign(new Error("登录凭据已失效，请在客户端重新登录并导入"), { code: "auth" });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`活动服务暂不可用（HTTP ${response.status}）`), { code: "http" });
  }
  if (!response.json || typeof response.json !== "object") {
    throw Object.assign(new Error("活动服务返回了无法解析的数据"), { code: "format" });
  }
  return response.json;
}

async function fetchQuota(account, store) {
  try {
    const headers = await qoderHeaders(account.provider, account, store);
    const response = await requestJson(`${BASE[account.provider]}${QUOTA}`, { headers });
    if (!response.ok || !response.json) return null;
    const data = response.json;
    const now = Date.now();
    const parts = [data.userQuota, data.addOnQuota, ...(Array.isArray(data.dedicatedResourcePackages) ? data.dedicatedResourcePackages : [])]
      .filter((part) => part && Number.isFinite(Number(part.total)))
      .filter((part) => {
        const end = Number(part.expiresAt);
        return !Number.isFinite(end) || end <= 0 || end > now;
      });
    const total = parts.reduce((sum, part) => sum + (Number(part.total) || 0), 0);
    const remaining = parts.reduce((sum, part) => sum + (Number(part.remaining) || 0), 0);
    return {
      total: Math.max(total, remaining),
      remaining: Math.max(remaining, 0),
      used: Math.max(total - remaining, 0),
      plan: typeof data.userType === "string" ? data.userType : "",
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function status(account, store, { withQuota = true } = {}) {
  try {
    if (isExpired(account)) {
      return { status: "expired", amount: null, message: "登录凭据已过期，请重新登录后导入" };
    }
    const payload = await fetchCampaigns(account, store);
    const picked = normalizeCampaigns(payload);
    const quota = withQuota ? await fetchQuota(account, store) : null;
    if (picked.claimable.length) {
      return {
        status: "claimable",
        amount: sumAmounts(picked.claimable),
        message: "有可领取的积分",
        endAt: maxEndAt(picked.claimable),
        quota,
      };
    }
    if (picked.claimed.length) {
      return {
        status: "claimed",
        amount: sumAmounts(picked.claimed),
        message: "本周期已领取",
        endAt: maxEndAt(picked.claimed),
        quota,
      };
    }
    if (picked.benefits.length) {
      return { status: "pending", amount: null, message: "活动存在但当前不可领取", quota };
    }
    return {
      status: "no-activity",
      amount: null,
      message: "当前账号没有可领取的积分活动",
      quota,
      risk: false,
    };
  } catch (error) {
    return {
      status: isAuthError(error) ? "expired" : "failed",
      amount: null,
      message: cleanMessage(error.message),
    };
  }
}

export async function claim(account, store) {
  if (!account.token) {
    return { status: "expired", amount: null, message: "账号没有可用登录凭据" };
  }
  if (isExpired(account)) {
    return { status: "expired", amount: null, message: "登录凭据已过期，请重新登录后导入" };
  }
  let payload;
  try {
    payload = await fetchCampaigns(account, store);
  } catch (error) {
    return {
      status: isAuthError(error) ? "expired" : "failed",
      amount: null,
      message: cleanMessage(error.message),
    };
  }
  const picked = normalizeCampaigns(payload);
  if (!picked.claimable.length) {
    if (picked.claimed.length) {
      return {
        status: "already",
        amount: sumAmounts(picked.claimed),
        message: "本周期已领取",
      };
    }
    if (picked.benefits.length) {
      return { status: "failed", amount: null, message: "活动存在但当前不可领取" };
    }
    return {
      status: "no-activity",
      amount: null,
      message: "当前账号没有可领取的积分活动",
    };
  }

  let total = 0;
  let anyAmount = false;
  const keys = [];
  const failures = [];
  let replayed = false;
  for (const campaign of picked.claimable) {
    const key = campaignLabel(campaign);
    let response;
    try {
      const headers = await qoderHeaders(account.provider, account, store);
      response = await requestJson(`${BASE[account.provider]}${claimPath(campaign.campaignId)}`, {
        method: "POST",
        headers,
        body: {},
      });
    } catch (error) {
      failures.push(`${key}: ${error.message}`);
      continue;
    }
    if (isAuthStatus(response.status)) {
      return {
        status: "expired",
        amount: anyAmount ? total : null,
        message: "领取时登录凭据被拒绝，请重新登录",
      };
    }
    if (!response.ok) {
      failures.push(`${key}: HTTP ${response.status} ${apiMessage(response.text)}`);
      continue;
    }
    const body = response.json || {};
    const code = Number(body.code);
    if (body.code !== undefined && Number.isFinite(code) && ![0, 200].includes(code)) {
      failures.push(`${key}: ${apiMessage(response.text) || `code ${code}`}`);
      continue;
    }
    const data = body.data && typeof body.data === "object" ? body.data : body;
    const serverStatus = String(data.status || body.status || "").toUpperCase();
    const amount = Number(data?.benefit?.amount);
    const campaignAmount = amountOf(campaign);
    const successEnvelope =
      serverStatus === "CLAIMED" ||
      data.replayed === true ||
      (serverStatus === "" && (Number.isFinite(amount) || campaignAmount !== null));
    if (!successEnvelope) {
      failures.push(`${key}: ${serverStatus || apiMessage(response.text) || "未确认领取结果"}`);
      continue;
    }
    if (Number.isFinite(amount)) {
      total += amount;
      anyAmount = true;
    } else if (campaignAmount !== null) {
      total += campaignAmount;
      anyAmount = true;
    }
    if (data.replayed === true) replayed = true;
    keys.push(key);
  }

  if (keys.length) {
    let message = anyAmount ? `成功领取 ${total} Credits` : "领取成功";
    if (keys.length) message += `（${keys.join("、")}）`;
    if (replayed) message += "；服务端判定为重复领取";
    if (failures.length) message += `；部分失败：${failures.join("；")}`;
    return {
      status: "claimed",
      amount: anyAmount ? total : null,
      message: cleanMessage(message, 240),
      replayed,
    };
  }
  return {
    status: "failed",
    amount: null,
    message: cleanMessage(failures.join("；") || "领取未成功"),
  };
}

// ── 浏览器设备码登录（多账号，无需切换客户端） ──

const sessions = new Map();
const SESSION_TTL = 5 * 60 * 1000;
const b64url = (buffer) => buffer.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");

function gcSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expiresAt < now) sessions.delete(id);
}

export function startDeviceLogin(provider) {
  if (!QODER_PROVIDERS.includes(provider)) throw new Error("不支持的登录类型");
  gcSessions();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const nonce = crypto.randomUUID();
  const machineId = crypto.randomUUID();
  const params = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    machine_id: machineId,
    nonce,
  });
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    provider,
    nonce,
    verifier,
    expiresAt: Date.now() + SESSION_TTL,
    busy: false,
  });
  return {
    sessionId,
    provider,
    url: `${LOGIN_URL[provider]}?${params.toString()}`,
    expiresIn: SESSION_TTL / 1000,
    interval: 2,
  };
}

async function fetchUserInfo(provider, token) {
  try {
    const response = await requestJson(`${BASE[provider]}${USERINFO}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "Go-http-client/2.0",
      },
    });
    if (!response.ok || !response.json) return null;
    return response.json;
  } catch {
    return null;
  }
}

export async function pollDeviceLogin(store, sessionId) {
  gcSessions();
  const session = sessions.get(sessionId);
  if (!session) return { status: "expired", message: "登录会话已过期，请重新发起" };
  if (session.busy) return { status: "pending" };
  session.busy = true;
  try {
    const provider = session.provider;
    const url =
      `${BASE[provider]}/api/v1/deviceToken/poll` +
      `?nonce=${encodeURIComponent(session.nonce)}&verifier=${encodeURIComponent(session.verifier)}&challenge_method=S256`;
    let response;
    try {
      response = await requestJson(url, {
        headers: { Accept: "application/json", "User-Agent": "Go-http-client/2.0" },
      });
    } catch (error) {
      return { status: "pending", message: error.message };
    }
    if (response.status === 202 || response.status === 404) return { status: "pending" };
    if (!response.ok) {
      sessions.delete(sessionId);
      return { status: "failed", message: `轮询失败（HTTP ${response.status}）${apiMessage(response.text)}` };
    }
    const body = response.json;
    if (!body?.token) {
      sessions.delete(sessionId);
      return { status: "failed", message: "登录成功响应里没有 token（接口可能已变化）" };
    }
    const info = await fetchUserInfo(provider, body.token);
    const uid = String(body.user_id || info?.id || "").trim();
    if (!uid) {
      sessions.delete(sessionId);
      return { status: "failed", message: "无法确定账号 ID，请改用客户端登录后导入" };
    }
    const expiresAt =
      iso(parseTimestamp(body.expires_at)) ||
      (Number.isFinite(Number(body.expires_in)) ? iso(Date.now() + Number(body.expires_in) * 1000) : null) ||
      iso(Date.now() + 30 * 86400_000);
    const existing = store.findByUid(provider, uid);
    const { account, created } = store.upsertAccount({
      provider,
      uid,
      name: info?.name || info?.username || info?.email || existing?.name || `Qoder ${uid.slice(0, 8)}`,
      email: info?.email || existing?.email || "",
      phone: info?.security_mobile || existing?.phone || "",
      token: body.token,
      refreshToken: body.refresh_token || body.refreshToken || "",
      expiresAt,
      source: "device",
      meta: { liveActive: existing?.meta?.liveActive || false, deviceLogin: true },
      snapshot: existing?.snapshot || null,
    });
    sessions.delete(sessionId);
    return {
      status: "ok",
      created,
      account: store.publicAccount(account),
    };
  } finally {
    session.busy = false;
  }
}

// ── 切换客户端登录 ──

/**
 * 用保存的 auth.v1.dat 快照切换 Qoder/Qoder CN 客户端登录。
 * 运行中的客户端退出时会把旧登录写回文件，因此必须先正常关闭再写。
 */
export async function switchTo(store, account, { force = false } = {}) {
  const provider = account.provider;
  if (!QODER_PROVIDERS.includes(provider)) throw new Error("该账号不是 Qoder 账号");
  if (account.snapshot?.kind !== "qoder" || !account.snapshot?.auth?.token) {
    throw new Error("这个账号没有客户端登录快照，请先在本机客户端登录后导入");
  }
  const app = detectQoder(provider);
  if (!app.installed || !app.exe) throw new Error(`未检测到 ${QODER_LABEL[provider]} 客户端，无法切换`);
  if (!app.dataExists) throw new Error(`${QODER_LABEL[provider]} 客户端数据目录不存在`);

  let live = null;
  try {
    live = readLiveAuth(provider);
  } catch {}
  if (live && live.uid === String(account.uid)) {
    store.markLiveActive(provider, account.uid);
    return { switched: false, alreadyActive: true, restarted: false };
  }

  if (app.running && !force) {
    const error = new Error(`${QODER_LABEL[provider]} 正在运行。切换会关闭客户端并重写登录文件，请确认后重试。`);
    error.code = "client-running";
    throw error;
  }
  const wasRunning = app.running;
  let closed = true;
  if (wasRunning) {
    const result = await terminateProcesses(qoderExeNames(provider));
    closed = result.closed;
    if (!closed) throw new Error(`无法关闭 ${QODER_LABEL[provider]}，请手动退出后重试`);
  }

  // 关闭后再读一次并保存当前登录，避免切换走一个尚未导入的账号。
  let current = null;
  try {
    current = readLiveAuth(provider);
  } catch (error) {
    throw new Error(`无法保存当前 ${QODER_LABEL[provider]} 登录态，切换已取消：${error.message}`);
  }
  if (current && current.uid !== String(account.uid)) {
    try {
      const existing = store.findByUid(provider, current.uid);
      store.upsertAccount({ ...accountInputFromLive(provider, current), source: existing?.source || "local" });
    } catch (error) {
      throw new Error(`无法保存当前 ${QODER_LABEL[provider]} 登录态，切换已取消：${error.message}`);
    }
  }

  const codec = electronSafeStorage(app.dataDir);
  const file = authFileOf(app);
  const ciphertext = codec.encrypt(JSON.stringify(account.snapshot.auth));
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.autoswitch.bak`);
  } catch {}
  atomicWrite(file, ciphertext);
  store.markLiveActive(provider, account.uid);
  if (wasRunning) {
    await sleep(500);
    launchClient(app.exe);
  }
  return {
    switched: true,
    alreadyActive: false,
    restarted: wasRunning,
    message: `已切换到 ${account.name || account.uid}${wasRunning ? "，客户端已重新启动" : ""}`,
  };
}
