import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { detectTrae, traeExeNames, launchClient, terminateProcesses } from "../win/paths.mjs";
import { requestJson, isAuthStatus } from "../http.mjs";
import { cleanMessage, parseTimestamp, sleep } from "../util.mjs";

export const TRAE_PROVIDER = "trae";
export const TRAE_LABEL = "Trae CN";
const API = "https://api.trae.cn";
const STATUS_URL = `${API}/trae/api/v2/ug/checkin_credits/status`;
const CLAIM_URL = `${API}/trae/api/v2/ug/checkin_credits/claim`;
const USAGE_URL = `${API}/trae/api/v2/pay/ide_user_ent_usage`;
const AUTH_KEY = "iCubeAuthInfo://icube.cloudide";
const DC_PREFIX = "iCubeAuthInfo://icube-dc:";
const HEADER = Buffer.from([116, 99, 5, 16, 0, 0]);

// Trae 自研 tc 信封的混淆常量表（与客户端 byteCrypto 对应）。
const WOE = [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37];
const VOE = [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125];
const JOE = [191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209];
const HOE = [246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170];

const sha512 = (buffer) => crypto.createHash("sha512").update(buffer).digest();
const pepper = (a, b) => Buffer.from(a.map((value, index) => value ^ b[index]));

export function tcDecrypt(value) {
  if (typeof value !== "string" || !value) return null;
  const raw = Buffer.from(value.trim(), "base64");
  if (raw.length < 54 || !raw.subarray(0, 6).equals(HEADER)) return null;
  const cipher = raw.subarray(38);
  for (const p of [pepper(WOE, VOE), pepper(JOE, HOE)]) {
    try {
      const key = sha512(Buffer.concat([sha512(raw.subarray(6, 38)), p]));
      const decipher = crypto.createDecipheriv("aes-128-cbc", key.subarray(0, 16), key.subarray(16, 32));
      const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
      if (plain.length <= 64) continue;
      const body = plain.subarray(64);
      if (!sha512(body).equals(plain.subarray(0, 64))) continue;
      return JSON.parse(body.toString("utf8"));
    } catch {}
  }
  return null;
}

export function uidFromJwt(token) {
  const segment = String(token || "").split(".")[1];
  if (!segment) return null;
  try {
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return payload?.data?.id ? String(payload.data.id) : null;
  } catch {
    return null;
  }
}

function storageFile(trae) {
  return path.join(trae.dataDir, "User", "globalStorage", "storage.json");
}

export function readLiveAuth() {
  const trae = detectTrae();
  if (!trae.signedIn) return null;
  let storage;
  try {
    storage = JSON.parse(fs.readFileSync(storageFile(trae), "utf8"));
  } catch (error) {
    throw new Error(`读取 Trae 登录信息失败：${error.message}`);
  }
  const auth = tcDecrypt(storage[AUTH_KEY]);
  if (!auth?.token) throw new Error("Trae 登录信息解密失败，请更新客户端后重新登录");
  const host = String(auth.host || "");
  let isIntl = false;
  try {
    const hostname = new URL(host).hostname;
    isIntl = Boolean(hostname) && !/(^|\.)trae\.cn$/i.test(hostname);
  } catch {}
  let deviceId = null;
  for (const key of Object.keys(storage)) {
    if (!key.startsWith(DC_PREFIX)) continue;
    const value = key.slice(DC_PREFIX.length);
    if (/^\d{8,}$/.test(value)) {
      deviceId = value;
      break;
    }
  }
  return { trae, storage, auth, uid: String(auth.userId || uidFromJwt(auth.token) || ""), deviceId, isIntl, host };
}

export function accountInputFromLive(live) {
  return {
    provider: TRAE_PROVIDER,
    uid: live.uid,
    name: live.auth.account?.username || `Trae ${String(live.uid).slice(0, 6)}`,
    email: live.auth.account?.email || "",
    token: live.auth.token,
    expiresAt: live.auth.expiredAt || null,
    source: "local",
    meta: {
      deviceId: live.deviceId || null,
      host: live.host || null,
      isIntl: live.isIntl || false,
      liveActive: true,
      dataDir: live.trae.dataDir,
      appName: live.trae.name,
    },
    snapshot: { kind: "trae", uid: live.uid },
  };
}

// ── 登录态快照（切换账号需要整份文件，不只是 token） ──

const SLOT_ITEMS = [
  "User/globalStorage/storage.json",
  "User/globalStorage/state.vscdb",
  "User/globalStorage/state.vscdb-wal",
  "User/globalStorage/state.vscdb-shm",
  "User/globalStorage/state.vscdb.backup",
  "machineid",
  "aha",
  "Preferences",
  "Local State",
  "Local Storage/leveldb",
  "Local Storage/config.db",
  "Network",
  "Partitions/trae-webview",
  "Partitions/icube-web-crawler-shared-session-v1.0",
  "Session Storage",
];
const CACHE_NAMES = new Set(["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Shared Dictionary", "blob_storage"]);
const notCache = (source) => !CACHE_NAMES.has(path.basename(source));
const safePart = (value) => String(value).replace(/[^\w.-]/g, "_").slice(0, 120);

export function slotDir(home, uid) {
  return path.join(home, "trae-slots", safePart(uid));
}

export function hasSlot(home, uid) {
  return fs.existsSync(path.join(slotDir(home, uid), "User", "globalStorage", "storage.json"));
}

function copyEntry(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.cpSync(source, destination, { recursive: true, filter: notCache });
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

export function saveSlot(home, trae, uid) {
  const failures = [];
  if (!uid) return { count: 0, failures: ["没有 uid"] };
  const destination = slotDir(home, uid);
  if (fs.existsSync(destination)) {
    fs.rmSync(`${destination}.bak`, { recursive: true, force: true });
    try {
      fs.renameSync(destination, `${destination}.bak`);
    } catch {
      fs.rmSync(destination, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(destination, { recursive: true });
  let count = 0;
  for (const relative of SLOT_ITEMS) {
    const source = path.join(trae.dataDir, ...relative.split("/"));
    if (!fs.existsSync(source)) continue;
    try {
      copyEntry(source, path.join(destination, ...relative.split("/")));
      count++;
    } catch (error) {
      failures.push(`${relative}（${copyReason(error)}）`);
    }
  }
  return { count, failures };
}

function restoreSlot(home, trae, uid) {
  const sourceRoot = slotDir(home, uid);
  const failures = [];
  let count = 0;
  for (const relative of SLOT_ITEMS) {
    const source = path.join(sourceRoot, ...relative.split("/"));
    if (!fs.existsSync(source)) continue;
    try {
      copyEntry(source, path.join(trae.dataDir, ...relative.split("/")));
      count++;
    } catch (error) {
      failures.push(`${relative}（${copyReason(error)}）`);
    }
  }
  return { count, failures };
}

function copyReason(error) {
  if (error?.code) return error.code;
  const text = String(error?.message || "未知错误").split("\n")[0];
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export function importLocal(store) {
  const result = { imported: 0, updated: 0, skipped: [], errors: [] };
  let live;
  try {
    live = readLiveAuth();
  } catch (error) {
    result.errors.push({ provider: TRAE_PROVIDER, message: cleanMessage(error.message) });
    store.markLiveActive(TRAE_PROVIDER, null);
    return result;
  }
  if (!live) {
    result.skipped.push({ provider: TRAE_PROVIDER, reason: "客户端未登录" });
    store.markLiveActive(TRAE_PROVIDER, null);
    return result;
  }
  if (!live.uid) {
    result.errors.push({ provider: TRAE_PROVIDER, message: "Trae 登录信息中没有用户 ID" });
    return result;
  }
  const existing = store.findByUid(TRAE_PROVIDER, live.uid);
  const { account, created } = store.upsertAccount(accountInputFromLive(live));
  try {
    const { count, failures } = saveSlot(store.home, live.trae, live.uid);
    account.meta = {
      ...(account.meta || {}),
      slot: count > 0,
      slotSavedAt: new Date().toISOString(),
    };
    if (failures.length) account.meta.slotError = failures.join("；");
    store.saveAccounts();
  } catch (error) {
    account.meta = { ...(account.meta || {}), slotError: cleanMessage(error.message) };
    store.saveAccounts();
  }
  created ? result.imported++ : result.updated++;
  store.markLiveActive(TRAE_PROVIDER, live.uid);
  return result;
}

export function syncActive(store) {
  try {
    const live = readLiveAuth();
    if (!live) {
      store.markLiveActive(TRAE_PROVIDER, null);
      return;
    }
    const existing = store.findByUid(TRAE_PROVIDER, live.uid);
    if (existing) store.upsertAccount({ ...accountInputFromLive(live), source: existing.source });
    store.markLiveActive(TRAE_PROVIDER, live.uid);
  } catch {}
}

// ── 请求与签到 ──

const isAuthError = (error) => error?.code === "auth";

export function isExpired(account) {
  const ts = parseTimestamp(account.expiresAt);
  return ts !== null && ts <= Date.now() + 5 * 60 * 1000;
}

function seeded(uid, salt, count) {
  const prefix = `${salt}:${uid}`;
  const output = [];
  for (let counter = 0; output.length < count; counter++) {
    output.push(...crypto.createHash("sha256").update(`${prefix}:${counter}`).digest());
  }
  return output.slice(0, count);
}

/**
 * x-device-id 必须是纯数字；按 uid 派生，保证每个账号指纹独立且跨天稳定。
 * 若服务端 9074 拒绝，重试时轮换派生号。
 */
export function deriveDevice(uid, attempt = 0) {
  // 客户端真实 x-device-id 是 16 位纯数字；逐字节取一位十进制数，首位保证非 0。
  const digits = seeded(String(uid), `devid:${attempt}`, 16).map((byte) => String(byte % 10));
  digits[0] = String(1 + Number(digits[0]) % 9);
  const deviceId = digits.join("");
  const market = seeded(String(uid), `market:${attempt}`, 16);
  market[6] = (market[6] & 0x0f) | 0x40;
  market[8] = (market[8] & 0x3f) | 0x80;
  const hex = market.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    deviceId,
    marketUserId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
    sessionId: seeded(String(uid), "sess", 32)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  };
}

function headersFor(account, attempt) {
  const uid = account.uid || uidFromJwt(account.token);
  const device = deriveDevice(uid || "anonymous", attempt);
  // 导入时记下的是客户端真实设备号（机器级），签到接口的风控认它；派生号只作兜底。
  const realDevice = String(account.meta?.deviceId || "");
  const deviceId = /^\d{8,32}$/.test(realDevice) ? realDevice : device.deviceId;
  const token = String(account.token || "");
  return {
    accept: "*/*",
    "accept-language": "zh-CN",
    authorization: /^Cloud-IDE-JWT\s/i.test(token) ? token : `Cloud-IDE-JWT ${token}`,
    "content-type": "application/json",
    "user-agent": "VSCode 1.107.1 (TRAE SOLO CN)",
    "x-market-client-id": "VSCode 1.107.1",
    "x-market-user-id": device.marketUserId,
    "x-user-region": "CN",
    "x-device-id": deviceId,
    "x-lgw-req-sdk-type": "3",
    "package-type": "stable_cn",
    "x-request-id": crypto.randomBytes(16).toString("hex"),
    "x-lscbd-aid": "787976",
    "x-lscbd-platform": process.platform === "win32" ? "windows" : process.platform,
    "app-version": "0.1.45",
    "x-tt-trace-id": `00-${crypto.randomBytes(8).toString("hex")}-01`,
    "vscode-sessionid": device.sessionId,
  };
}

function findField(value, key, depth = 0) {
  if (!value || typeof value !== "object" || depth > 2) return undefined;
  if (key in value) return value[key];
  for (const child of [value.data, value.result, value.Result]) {
    const found = findField(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function post(account, url, body = {}, attempt = 0) {
  let response;
  try {
    response = await requestJson(url, {
      method: "POST",
      headers: headersFor(account, attempt),
      body,
    });
  } catch (error) {
    throw Object.assign(new Error(`无法连接 Trae 签到服务：${error.message}`), { code: "network" });
  }
  if (isAuthStatus(response.status)) {
    throw Object.assign(new Error("Trae 登录凭据已失效，请在客户端重新登录并导入"), { code: "auth" });
  }
  if (!response.json || typeof response.json !== "object") {
    throw Object.assign(new Error(`Trae 接口返回无法解析（HTTP ${response.status}）`), { code: "format" });
  }
  const code = Number(response.json.code);
  if (code === 1001) {
    throw Object.assign(new Error("Trae 登录凭据已被服务端吊销，请重新登录"), { code: "auth" });
  }
  return {
    status: response.status,
    body: response.json,
    code: Number.isFinite(code) ? code : null,
    message: String(response.json.message || ""),
  };
}

const alreadyMessage = (message) => /已经签到|已签到|already.*sign/i.test(String(message || ""));
const withCode = (message, code) => (Number.isFinite(code) && code !== 0 ? `${message}（code ${code}）` : message);

export async function fetchQuota(account) {
  try {
    const response = await post(account, USAGE_URL, { require_usage: true, req_source: 2 });
    if (response.code !== null && response.code !== 0) return null;
    const packs = findField(response.body, "user_entitlement_pack_list");
    let total = 0;
    let used = 0;
    if (Array.isArray(packs)) {
      for (const pack of packs) {
        const limit = Number(pack?.entitlement_base_info?.quota?.credits_limit);
        if (!Number.isFinite(limit) || limit <= 0) continue;
        total += limit;
        used += Number(pack?.usage?.credits_amount) || 0;
      }
    }
    const summary = response.body.usage_summary;
    if (summary && Number(summary.total_amount) > 0) {
      total = Number(summary.total_amount);
      used = Number(summary.consumed_amount) || 0;
    }
    if (total <= 0 && used <= 0) return null;
    return {
      total,
      used,
      remaining: Math.max(total - used, 0),
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function status(account, _store, { withQuota = true } = {}) {
  if (account.meta?.isIntl) {
    return { status: "failed", amount: null, message: "当前只支持 Trae CN 账号（国际版接口不同）" };
  }
  if (isExpired(account)) {
    return { status: "expired", amount: null, message: "Trae 登录凭据已过期，请在客户端重新登录后导入" };
  }
  try {
    const response = await post(account, STATUS_URL, {});
    if (response.code === 1001) {
      return { status: "expired", amount: null, message: "Trae 登录凭据已被服务端吊销" };
    }
    const quota = withQuota ? await fetchQuota(account) : null;
    if (response.code !== 0) {
      if (alreadyMessage(response.message)) {
        return { status: "claimed", amount: null, message: withCode(response.message, response.code), quota };
      }
      return { status: "failed", amount: null, message: withCode(response.message || "签到状态查询失败", response.code), quota };
    }
    const checkedIn = findField(response.body, "checked_in");
    const credits = Number(findField(response.body, "credits") ?? findField(response.body, "extra_credits")) || null;
    if (checkedIn === true || checkedIn === 1) {
      return { status: "claimed", amount: credits, message: "今天已签到", quota };
    }
    if (findField(response.body, "enable") === false) {
      return { status: "no-activity", amount: null, message: "当前账号未开放每日签到", quota };
    }
    return { status: "claimable", amount: credits, message: "今天可签到", quota };
  } catch (error) {
    return {
      status: isAuthError(error) ? "expired" : "failed",
      amount: null,
      message: cleanMessage(error.message),
    };
  }
}

const backoff = [0, 3000, 8000, 15_000];

export async function claim(account) {
  if (account.meta?.isIntl) {
    return { status: "failed", amount: null, message: "当前只支持 Trae CN 账号（国际版接口不同）" };
  }
  if (!account.token) return { status: "expired", amount: null, message: "账号没有 Trae 登录凭据" };
  if (isExpired(account)) {
    return { status: "expired", amount: null, message: "Trae 登录凭据已过期，请在客户端重新登录后导入" };
  }
  let statusResponse;
  try {
    statusResponse = await post(account, STATUS_URL, {});
  } catch (error) {
    return {
      status: isAuthError(error) ? "expired" : "failed",
      amount: null,
      message: cleanMessage(error.message),
    };
  }
  if (statusResponse.code === 1001) {
    return { status: "expired", amount: null, message: "Trae 登录凭据已被服务端吊销" };
  }
  if (statusResponse.code !== 0) {
    if (alreadyMessage(statusResponse.message)) {
      return { status: "already", amount: null, message: "今天已签到" };
    }
    return {
      status: "failed",
      amount: null,
      message: withCode(statusResponse.message || "签到状态查询失败", statusResponse.code),
    };
  }
  const checkedIn = findField(statusResponse.body, "checked_in");
  const expected = Number(findField(statusResponse.body, "credits") ?? findField(statusResponse.body, "extra_credits")) || 100;
  if (checkedIn === true || checkedIn === 1) {
    return { status: "already", amount: expected, message: "今天已签到" };
  }

  let response = null;
  let lastError = null;
  for (let attempt = 0; attempt < backoff.length; attempt++) {
    if (backoff[attempt]) await sleep(backoff[attempt]);
    try {
      response = await post(account, CLAIM_URL, {}, attempt);
      lastError = null;
    } catch (error) {
      lastError = error;
      if (isAuthError(error)) {
        return { status: "expired", amount: null, message: cleanMessage(error.message) };
      }
      break;
    }
    if (response.code !== 9074) break;
  }
  if (!response) {
    return { status: "failed", amount: null, message: cleanMessage(lastError?.message || "签到请求失败") };
  }
  if (response.code === 0) {
    const claimed = Number(findField(response.body, "credits")) || expected;
    return {
      status: "claimed",
      amount: claimed || null,
      message: claimed ? `签到成功，+${claimed} 积分` : "签到成功",
    };
  }
  if (response.code === 9095 || /当前设备今日已经签到/.test(String(response.message || ""))) {
    // 这台设备今天已经签过了，积分不会进这个账号的账，不能算「已领取」。
    return { status: "device-limited", amount: null, message: "本机今日已签到过（Trae 按设备每天一次）" };
  }
  if (alreadyMessage(response.message)) {
    return { status: "already", amount: expected, message: withCode(response.message, response.code) };
  }
  return {
    status: "failed",
    amount: null,
    message: withCode(response.message || "签到失败", response.code),
  };
}

// ── 切换客户端登录 ──

export async function switchTo(store, account, { force = false } = {}) {
  if (account.provider !== TRAE_PROVIDER) throw new Error("该账号不是 Trae 账号");
  const trae = detectTrae();
  if (!trae.dataExists) throw new Error("未检测到 Trae 客户端数据目录");
  if (!hasSlot(store.home, account.uid)) {
    throw new Error("这个账号没有 Trae 客户端快照，请先在本机登录该账号并导入");
  }
  let live = null;
  try {
    live = readLiveAuth();
  } catch {}
  if (live && String(live.uid) === String(account.uid)) {
    store.markLiveActive(TRAE_PROVIDER, account.uid);
    return { switched: false, alreadyActive: true, restarted: false };
  }
  if (trae.running && !force) {
    const error = new Error("Trae 正在运行。切换会关闭客户端并替换登录态，请确认后重试。");
    error.code = "client-running";
    throw error;
  }
  const wasRunning = trae.running;
  if (wasRunning) {
    const result = await terminateProcesses(traeExeNames(trae));
    if (!result.closed) {
      throw new Error(`无法关闭 Trae（${traeExeNames(trae).join("、")} 仍在运行），请手动完全退出客户端后重试`);
    }
  }
  // 关闭后再读一次 storage.json，很容易撞上 Trae 退出时写了一半的文件；
  // 直接沿用杀掉之前读到的登录态当作「当前账号」。
  let current = live;
  if (!current) {
    try {
      current = readLiveAuth();
    } catch (error) {
      throw new Error(`无法保存当前 Trae 登录态，切换已取消：${error.message}`);
    }
  }
  if (current && String(current.uid) !== String(account.uid)) {
    try {
      const { count, failures } = saveSlot(store.home, current.trae, current.uid);
      if (!count) throw new Error(`一个登录文件都没读到${failures.length ? `：${failures.join("；")}` : ""}`);
      const existing = store.findByUid(TRAE_PROVIDER, current.uid);
      store.upsertAccount({ ...accountInputFromLive(current), source: existing?.source || "local" });
    } catch (error) {
      throw new Error(`无法保存当前 Trae 登录态，切换已取消：${error.message}`);
    }
  }
  const restore = restoreSlot(store.home, trae, account.uid);
  if (!restore.count) {
    throw new Error(
      `恢复 Trae 登录态失败：快照里没有可写入的文件${restore.failures.length ? `（${restore.failures.join("；")}）` : ""}`,
    );
  }
  // 只把文件拷回去不等于切成功：读一遍落盘的登录态，确认客户端启动后会看到的就是目标账号。
  let landed = null;
  try {
    landed = readLiveAuth();
  } catch {}
  if (landed && String(landed.uid) !== String(account.uid)) {
    throw new Error(
      `写入后本机登录态仍是 ${landed.uid}，不是目标账号 ${account.uid}；这份快照不可用，请在 Trae 里重新登录该账号后再导入`,
    );
  }
  store.markLiveActive(TRAE_PROVIDER, account.uid);
  if (wasRunning) {
    if (!trae.exe) throw new Error("登录态已切换，但找不到 Trae 可执行文件，请手动启动客户端");
    await sleep(500);
    launchClient(trae.exe);
  }
  const warning = restore.failures.length ? `，但有 ${restore.failures.length} 个文件没写入成功（${restore.failures[0]}）` : "";
  return {
    switched: true,
    alreadyActive: false,
    restarted: wasRunning,
    restored: restore.count,
    message: `已切换到 ${account.name || account.uid}${wasRunning ? "，Trae 已重新启动" : ""}${warning}`,
  };
}

export const __testing = { WOE, VOE, JOE, HOE, HEADER, sha512, pepper, saveSlot, restoreSlot, post, headersFor, STATUS_URL, CLAIM_URL };

