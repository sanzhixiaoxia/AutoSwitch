import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { sleep } from "../util.mjs";

const IS_WIN = process.platform === "win32";

export function appDataDir() {
  if (IS_WIN) return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

export function localAppDataDir() {
  if (IS_WIN) return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return appDataDir();
}

export const QODER_VARIANTS = [
  { provider: "qoder", label: "Qoder 国际版", installName: "Qoder", appId: "com.qoder.app", riskEnv: 3 },
  { provider: "qoder-cn", label: "Qoder 国内版", installName: "Qoder CN", appId: "com.qodercn.app", riskEnv: 0 },
];

export const TRAE_VARIANTS = ["Trae CN", "Trae", "TRAE SOLO CN", "TRAE SOLO"];

const exists = (file) => {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
};
const isDir = (file) => {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
};

function compareVersionDesc(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] || 0) - (x[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Qoder 0.3+ 把实际版本放在 .qoder-versions/<ver>/ 下，顶层 resources 可能是旧残留。 */
function qoderResourceDirs(appDir) {
  const dirs = [];
  const versionsRoot = path.join(appDir, ".qoder-versions");
  let versions = [];
  try {
    versions = fs
      .readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+(\.\d+)*$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersionDesc);
  } catch {}
  for (const version of versions) {
    dirs.push({
      resources: path.join(versionsRoot, version, "resources"),
      exeDir: path.join(versionsRoot, version),
      version,
    });
  }
  dirs.push({ resources: path.join(appDir, "resources"), exeDir: appDir, version: null });
  return dirs;
}

function readVersion(resourcesDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(resourcesDir, "build-manifest.json"), "utf8"));
    return typeof manifest.productVersion === "string" ? manifest.productVersion : null;
  } catch {
    return null;
  }
}

export function detectQoder(provider) {
  const variant = QODER_VARIANTS.find((item) => item.provider === provider);
  if (!variant) throw new Error(`未知的 Qoder 版本：${provider}`);
  const local = localAppDataDir();
  const envDir =
    provider === "qoder"
      ? process.env.QODER_APP_DIR || process.env.AUTOSWITCH_QODER_DIR
      : process.env.QODER_CN_APP_DIR || process.env.AUTOSWITCH_QODER_CN_DIR;
  const appDirs = [
    envDir,
    path.join(local, "Programs", variant.installName),
    path.join(process.env.ProgramFiles || "C:\\Program Files", variant.installName),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", variant.installName),
  ].filter(Boolean);

  const dataCandidates = [
    path.join(appDataDir(), `${variant.appId}.stable`),
    path.join(appDataDir(), variant.appId),
  ];
  const dataDir =
    dataCandidates.find((dir) => exists(path.join(dir, "auth.v1.dat"))) ||
    dataCandidates.find(isDir) ||
    dataCandidates[0];
  const authFile = path.join(dataDir, "auth.v1.dat");
  let chosen = null;
  for (const appDir of appDirs) {
    if (!isDir(appDir)) continue;
    for (const candidate of qoderResourceDirs(appDir)) {
      if (!isDir(candidate.resources)) continue;
      const exe = path.join(candidate.exeDir, `${variant.installName}.exe`);
      const runtimeInfo = path.join(candidate.resources, "umid", IS_WIN ? "runtime-info.exe" : "runtime-info");
      const version = candidate.version || readVersion(candidate.resources);
      const item = {
        appDir,
        resources: candidate.resources,
        exe: exists(exe) ? exe : null,
        runtimeInfo: exists(runtimeInfo) ? runtimeInfo : null,
        version,
      };
      if (!chosen) chosen = item;
      // 带 runtime-info 的版本优先，其次才是目录里最新的版本。
      if (item.runtimeInfo) {
        chosen = item;
        break;
      }
    }
    if (chosen?.runtimeInfo) break;
  }

  return {
    provider,
    label: variant.label,
    riskEnv: variant.riskEnv,
    installed: Boolean(chosen),
    appDir: chosen?.appDir || null,
    resources: chosen?.resources || null,
    exe: chosen?.exe || null,
    runtimeInfo: chosen?.runtimeInfo || null,
    version: chosen?.version || null,
    dataDir,
    dataExists: isDir(dataDir),
    signedIn: exists(authFile),
    running: isRunning([`${variant.installName}.exe`]),
  };
}

export function detectTrae() {
  const dataRoot = appDataDir();
  const local = localAppDataDir();
  let fallback = null;
  for (const name of TRAE_VARIANTS) {
    const dataDir = path.join(dataRoot, name);
    const storage = path.join(dataDir, "User", "globalStorage", "storage.json");
    const exeCandidates = [
      path.join(local, "Programs", name, `${name}.exe`),
      path.join(process.env.ProgramFiles || "C:\\Program Files", name, `${name}.exe`),
    ];
    const exe = exeCandidates.find(exists) || null;
    const item = {
      name,
      dataDir,
      exe,
      dataExists: isDir(dataDir),
      signedIn: exists(storage),
      running: isRunning([`${name}.exe`]),
    };
    if (item.signedIn) return item;
    if (!fallback && (item.exe || item.dataExists)) fallback = item;
  }
  return (
    fallback || {
      name: "Trae CN",
      dataDir: path.join(dataRoot, "Trae CN"),
      exe: null,
      dataExists: false,
      signedIn: false,
      running: false,
    }
  );
}

let processCache = { at: 0, names: new Set() };

/** 一次 tasklist 读取全部进程名，避免反复调用。 */
export function listImageNames({ maxAgeMs = 1500 } = {}) {
  if (!IS_WIN) return new Set();
  if (Date.now() - processCache.at < maxAgeMs) return processCache.names;
  let names = new Set();
  try {
    const out = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of out.split(/\r?\n/)) {
      const match = line.match(/^"([^"]+)"/);
      if (match) names.add(match[1].toLowerCase());
    }
  } catch {
    names = new Set();
  }
  processCache = { at: Date.now(), names };
  return names;
}

export function isRunning(exeNames) {
  const names = listImageNames();
  return exeNames.some((name) => names.has(String(name).toLowerCase()));
}

/**
 * 正常结束客户端（taskkill 不带 /F 先给应用落盘机会），超时再强制结束。
 * 切换登录态必须先关闭客户端，否则退出时会把内存里的旧登录写回文件。
 */
export async function terminateProcesses(exeNames, { timeoutMs = 12_000 } = {}) {
  if (!IS_WIN) return { closed: false, supported: false };
  const running = exeNames.filter((name) => isRunning([name]));
  if (running.length === 0) return { closed: true, supported: true, alreadyStopped: true };
  const resetCache = () => {
    processCache = { at: 0, names: new Set() };
  };
  const kill = (force) => {
    for (const name of exeNames) {
      try {
        execFileSync("taskkill.exe", force ? ["/IM", name, "/T", "/F"] : ["/IM", name, "/T"], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 20_000,
        });
      } catch {}
    }
    resetCache();
  };
  kill(false);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(exeNames)) {
      resetCache();
      return { closed: true, supported: true, forced: false };
    }
    await sleep(250);
  }
  kill(true);
  const hardDeadline = Date.now() + 5000;
  while (Date.now() < hardDeadline) {
    if (!isRunning(exeNames)) {
      resetCache();
      return { closed: true, supported: true, forced: true };
    }
    await sleep(250);
  }
  resetCache();
  return { closed: !isRunning(exeNames), supported: true, forced: true };
}

export function launchClient(exe) {
  if (!exe || !exists(exe)) throw new Error(`找不到客户端可执行文件：${exe || "未检测到"}`);
  const child = spawn(exe, [], {
    detached: true,
    stdio: "ignore",
    cwd: path.dirname(exe),
    windowsHide: false,
  });
  child.unref();
  return { launched: true, exe };
}

export function qoderExeNames(provider) {
  const variant = QODER_VARIANTS.find((item) => item.provider === provider);
  return variant ? [`${variant.installName}.exe`] : [];
}

export function traeExeNames(trae = detectTrae()) {
  return [`${trae.name}.exe`];
}
