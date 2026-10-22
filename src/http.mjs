import { cleanMessage } from "./util.mjs";

export class HttpError extends Error {
  constructor(message, { status = 0, code = "http", body = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: response.status, ok: response.ok, text, json };
  } catch (error) {
    const reason = error?.name === "AbortError" ? "请求超时" : "网络请求失败";
    throw new HttpError(`${reason}：${cleanMessage(error?.message || "", 120)}`, { code: "network" });
  } finally {
    clearTimeout(timer);
  }
}

export function apiMessage(text) {
  return cleanMessage(text, 180);
}

export function isAuthStatus(status) {
  return status === 401 || status === 403;
}
