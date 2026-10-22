import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const CN_TZ = "Asia/Shanghai";
export const QODER_RESET_HOUR = 10;

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CN_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const localFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: CN_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const shortFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: CN_TZ,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 以北京时间计算日期（Qoder 的积分轮次是 10:00 到次日 10:00）。 */
export function dayKey(now = Date.now()) {
  return dayFormatter.format(now);
}

/** Qoder 轮次：10:00 之前仍属于前一天的轮次。 */
export function qoderRoundKey(now = Date.now()) {
  return dayKey(now - QODER_RESET_HOUR * 3600_000);
}

/** Trae 按自然日刷新。 */
export function traeRoundKey(now = Date.now()) {
  return dayKey(now);
}

export function roundKey(provider, now = Date.now()) {
  return provider === "trae" ? traeRoundKey(now) : qoderRoundKey(now);
}

export function localTime(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? localFormatter.format(date) : "";
}

export function shortTime(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? shortFormatter.format(date) : "";
}

export function iso(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return parseTimestamp(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function maskMiddle(value, head = 3, tail = 4) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= head + tail) return `${text[0] || ""}***`;
  return `${text.slice(0, head)}****${text.slice(-tail)}`;
}

export function redact(text) {
  let out = String(text ?? "");
  out = out.replace(/\b(dt|drt|pt|jt)-[A-Za-z0-9._-]{8,}/g, "$1-[已隐藏]");
  out = out.replace(/Cloud-IDE-JWT\s+[A-Za-z0-9._-]+/gi, "Cloud-IDE-JWT [已隐藏]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [已隐藏]");
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[JWT 已隐藏]");
  return out.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 400);
}

export function cleanMessage(value, limit = 200) {
  return redact(value).replace(/\s+/g, " ").trim().slice(0, limit);
}

export async function readJsonBody(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw Object.assign(new Error("请求体不是有效 JSON"), { status: 400 });
  }
}

export function atomicWrite(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw error;
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

