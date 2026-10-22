import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { detectQoder } from "./win/paths.mjs";

const TTL_MS = 50 * 60 * 1000;
const cache = new Map();

function machineOs() {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${arch}_${process.platform}`;
}

function cleanHostname() {
  const raw = String(os.hostname() || "").trim();
  if (!raw) return undefined;
  const clean = raw.replace(/[^\x21-\x7e]/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return (clean || "unknown").slice(0, 96);
}

/**
 * Qoder 客户端自带的 runtime-info 会根据账号生成设备风控身份。
 * 国际版服务端只有在携带 Cosy-MachineToken/Code/Type 时才下发每日积分活动。
 */
function runRuntimeInfo(exe, env, account) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [String(env), "--account-stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: path.dirname(exe),
    });
    let output = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("设备身份生成超时")), 25_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 1024 * 1024) return finish(new Error("设备身份输出异常"));
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        const json = JSON.parse(output.slice(0, newline));
        const pick = (key) => {
          const value = typeof json[key] === "string" ? json[key].trim() : "";
          if (!value || value.length > 4096) throw new Error(`设备身份缺少 ${key}`);
          return value;
        };
        finish(null, {
          machineToken: pick("machineToken"),
          machineCode: pick("machineCode"),
          machineType: pick("machineType"),
        });
      } catch (error) {
        finish(error);
      }
    });
    child.stderr.on("data", () => {});
    child.once("error", (error) => finish(new Error(`无法运行 runtime-info：${error.message}`)));
    child.once("close", () => finish(new Error("runtime-info 未返回设备身份")));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ account }) + "\n");
  });
}

function pickRuntime(provider) {
  const primary = detectQoder(provider);
  if (primary.runtimeInfo) return primary;
  const other = detectQoder(provider === "qoder" ? "qoder-cn" : "qoder");
  return other.runtimeInfo ? other : null;
}

export async function getRiskIdentity(provider, uid, store) {
  if (!uid) return null;
  const key = `${provider}:${uid}`;
  const hit = cache.get(key);
  if (hit?.value && Date.now() - hit.at < TTL_MS) return hit.value;
  if (hit?.promise) return hit.promise;

  const app = pickRuntime(provider);
  if (!app?.runtimeInfo) return null;

  const promise = runRuntimeInfo(app.runtimeInfo, app.riskEnv, uid)
    .then((value) => {
      cache.set(key, { value, at: Date.now() });
      return value;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, { promise });
  return promise;
}

/** 所有 Qoder 请求共用的客户端头；国际版风控头缺失时活动列表可能为空。 */
export async function qoderHeaders(provider, account, store) {
  const app = detectQoder(provider);
  const headers = {
    Accept: "application/json",
    "User-Agent": "Qoder/claim",
    "Cosy-ClientType": "10",
    "Cosy-Version": app.version || "0.4.8",
    "Cosy-MachineOS": machineOs(),
    "Cosy-MachineId": readMachineIdFromClient(provider) || store.machineId,
  };
  const host = cleanHostname();
  if (host) headers["Cosy-MachineHostname"] = host;
  try {
    const risk = await getRiskIdentity(provider, account.uid, store);
    if (risk) {
      headers["Cosy-MachineToken"] = risk.machineToken;
      headers["Cosy-MachineCode"] = risk.machineCode;
      headers["Cosy-MachineType"] = risk.machineType;
    }
  } catch {
    // 风控身份失败不阻断国内版；国际版由调用方根据返回结果提示。
  }
  headers.Authorization = `Bearer ${account.token}`;
  return headers;
}

export function riskAvailable(provider) {
  return Boolean(pickRuntime(provider)?.runtimeInfo);
}

export function readMachineIdFromClient(provider) {
  try {
    const app = detectQoder(provider);
    return fs.readFileSync(path.join(app.dataDir, "auth.machine-id"), "utf8").trim() || null;
  } catch {
    return null;
  }
}
