import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const PS = process.platform === "win32" ? "powershell.exe" : null;
const codecCache = new Map();

function runPowerShell(script, input = "") {
  if (!PS) throw new Error("此功能依赖 Windows DPAPI，当前系统不受支持。");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(
    PS,
    ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded],
    {
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw new Error(`无法调用 PowerShell：${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || "").replace(/[^\x20-\x7e\u4e00-\u9fa5]/g, " ").trim();
    throw new Error(`Windows DPAPI 调用失败${detail ? `：${detail.slice(0, 160)}` : ""}`);
  }
  return String(result.stdout || "").trim();
}

/** 用当前 Windows 用户凭据解保护一段二进制（DPAPI CurrentUser）。 */
export function dpapiUnprotect(buffer) {
  const script =
    "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());" +
    "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
  const out = runPowerShell(script, Buffer.from(buffer).toString("base64"));
  if (!out) throw new Error("DPAPI 解密返回空结果");
  return Buffer.from(out, "base64");
}

/** 用当前 Windows 用户凭据保护一段二进制（DPAPI CurrentUser）。 */
export function dpapiProtect(buffer) {
  const script =
    "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());" +
    "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
  const out = runPowerShell(script, Buffer.from(buffer).toString("base64"));
  if (!out) throw new Error("DPAPI 加密返回空结果");
  return Buffer.from(out, "base64");
}

/**
 * 读取某个 Electron 客户端的 safeStorage 编解码器。
 * Windows 格式：v10 + nonce(12) + AES-256-GCM(密文 + tag16)，
 * 密钥来自该客户端 Local State 的 os_crypt.encrypted_key（DPAPI 保护）。
 */
export function electronSafeStorage(userDataDir) {
  const key = path.resolve(userDataDir);
  const cached = codecCache.get(key);
  if (cached) return cached;

  const stateFile = path.join(key, "Local State");
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (error) {
    throw new Error(`读取 ${path.basename(key)} 的 Local State 失败：${error.message}`);
  }
  const encoded = state?.os_crypt?.encrypted_key;
  if (typeof encoded !== "string" || !encoded) throw new Error("Local State 中缺少 os_crypt.encrypted_key");
  const blob = Buffer.from(encoded, "base64");
  if (blob.subarray(0, 5).toString() !== "DPAPI") throw new Error("不支持的 safeStorage 密钥格式");
  const aesKey = dpapiUnprotect(blob.subarray(5));

  const codec = {
    decrypt(data) {
      if (data.subarray(0, 3).toString() !== "v10") throw new Error("未知的 Electron 凭据加密格式");
      if (data.length < 3 + 12 + 16) throw new Error("Electron 凭据文件过短");
      const nonce = data.subarray(3, 15);
      const tag = data.subarray(data.length - 16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(data.subarray(15, data.length - 16)),
        decipher.final(),
      ]).toString("utf8");
    },
    encrypt(text) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, nonce);
      const body = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from("v10"), nonce, body, cipher.getAuthTag()]);
    },
  };
  codecCache.set(key, codec);
  return codec;
}

export function hasDpapi() {
  return Boolean(PS);
}
