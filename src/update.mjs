import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWrite, cleanMessage, readJson } from "./util.mjs";

export const PROJECT_URL = "https://github.com/sanzhixiaoxia/AutoSwitch";
export const REPO = "sanzhixiaoxia/AutoSwitch";
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_TTL_MS = 6 * 3600_000;
const CACHE_FILE = "update.json";
const execFileAsync = promisify(execFile);
const STATUS_MARKER = "\n__AUTOSWITCH_STATUS__";

async function requestWithCurl(url) {
  const executable = path.join(process.env.WINDIR || "C:\\Windows", "System32", "curl.exe");
  const curl = fs.existsSync(executable) ? executable : "curl.exe";
  const { stdout } = await execFileAsync(
    curl,
    [
      "--silent",
      "--show-error",
      "--location",
      "--max-time",
      "15",
      "--user-agent",
      "AutoSwitch-UpdateChecker",
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      "X-GitHub-Api-Version: 2022-11-28",
      "--write-out",
      `${STATUS_MARKER}%{http_code}`,
      url,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
  );
  const index = stdout.lastIndexOf(STATUS_MARKER);
  if (index < 0) throw new Error("curl 未返回 HTTP 状态码");
  return {
    status: Number(stdout.slice(index + STATUS_MARKER.length).trim()) || 0,
    text: stdout.slice(0, index),
  };
}

/**
 * 本机 Node 可能不信任系统代理的根证书，优先用 Windows 自带 curl（Schannel +
 * 系统代理），失败再回退 Node fetch。只访问固定的 GitHub API。
 */
async function requestRelease() {
  if (process.platform === "win32") {
    try {
      const result = await requestWithCurl(RELEASE_API);
      if (result.status) return result;
    } catch {}
  }
  const response = await fetch(RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "AutoSwitch-UpdateChecker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, text: await response.text() };
}

function parseVersion(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
}

/** 只比较 major.minor.patch；预发布后缀按 0 处理。 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function trustedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["github.com", "www.github.com"].includes(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function pickDownload(assets, pattern) {
  const asset = assets.find((item) => pattern.test(String(item?.name || "")));
  if (!asset) return null;
  const url = trustedUrl(asset.browser_download_url);
  if (!url) return null;
  return {
    name: String(asset.name || "").slice(0, 120),
    url,
    size: Number(asset.size) || 0,
  };
}

export function summarizeRelease(release, current) {
  const latest = String(release?.tag_name || "").replace(/^v/i, "").trim() || null;
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return {
    checkedAt: new Date().toISOString(),
    current,
    latest,
    hasRelease: true,
    hasUpdate: Boolean(latest) && compareVersions(latest, current) > 0,
    releaseUrl: trustedUrl(release?.html_url) || `${PROJECT_URL}/releases`,
    releaseName: typeof release?.name === "string" ? release.name.slice(0, 160) : latest,
    publishedAt: typeof release?.published_at === "string" ? release.published_at : null,
    notes: cleanMessage(release?.body || "", 600),
    downloads: {
      setup: pickDownload(assets, /setup.*\.exe$/i),
      portable: pickDownload(assets, /portable.*\.zip$/i),
    },
  };
}

function cachePath(home) {
  return path.join(home, CACHE_FILE);
}

export function readCachedUpdate(home, current) {
  const cached = readJson(cachePath(home), null);
  if (!cached || typeof cached.checkedAt !== "string") {
    return { checked: false, current, projectUrl: PROJECT_URL };
  }
  return {
    ...cached,
    checked: true,
    cached: true,
    current,
    hasUpdate: cached.latest ? compareVersions(cached.latest, current) > 0 : false,
    projectUrl: PROJECT_URL,
  };
}

export async function checkForUpdate(home, current, { force = false } = {}) {
  const cached = readJson(cachePath(home), null);
  if (!force && cached?.checkedAt && Date.now() - Date.parse(cached.checkedAt) < CACHE_TTL_MS) {
    return readCachedUpdate(home, current);
  }

  let response;
  try {
    response = await requestRelease();
  } catch (error) {
    throw new Error(`无法连接 GitHub 检查更新：${cleanMessage(error.message, 120)}`);
  }

  if (response.status === 404) {
    const result = {
      checkedAt: new Date().toISOString(),
      current,
      latest: null,
      hasRelease: false,
      hasUpdate: false,
      releaseUrl: `${PROJECT_URL}/releases`,
      releaseName: "",
      publishedAt: null,
      notes: "",
      downloads: { setup: null, portable: null },
    };
    atomicWrite(cachePath(home), `${JSON.stringify(result, null, 2)}\n`);
    return { ...result, checked: true, cached: false, projectUrl: PROJECT_URL };
  }
  if (response.status < 200 || response.status >= 300) {
    const hint = response.status === 403 ? "（可能触发 GitHub 未登录 API 限流）" : "";
    throw new Error(`GitHub 返回 HTTP ${response.status}${hint}`);
  }

  let release;
  try {
    release = JSON.parse(response.text);
  } catch {
    throw new Error("GitHub 返回了无法解析的数据");
  }
  const result = summarizeRelease(release, current);
  atomicWrite(cachePath(home), `${JSON.stringify(result, null, 2)}\n`);
  return { ...result, checked: true, cached: false, projectUrl: PROJECT_URL };
}
