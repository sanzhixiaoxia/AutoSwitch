import { detectQoder, detectTrae } from "./win/paths.mjs";
import { hasDpapi } from "./win/dpapi.mjs";
import { getRiskIdentity, riskAvailable } from "./risk.mjs";
import { readLiveAuth as readQoderLive, QODER_LABEL } from "./providers/qoder.mjs";
import { readLiveAuth as readTraeLive } from "./providers/trae.mjs";
import { taskStatus } from "./task.mjs";

const push = (checks, name, ok, detail, optional = false) =>
  checks.push({ name, ok: Boolean(ok), detail: String(detail ?? ""), optional });

export async function runDoctor(store, { network = false } = {}) {
  const checks = [];
  push(checks, "DPAPI", hasDpapi(), hasDpapi() ? "当前 Windows 用户可用" : "不可用（仅 Windows 支持加密存储）");
  push(
    checks,
    "账号库",
    true,
    `${store.listAccounts().length} 个账号；数据目录 ${store.home}`,
  );

  for (const provider of ["qoder", "qoder-cn"]) {
    const expected = store.listAccounts().some((account) => account.provider === provider);
    const app = detectQoder(provider);
    push(
      checks,
      `${QODER_LABEL[provider]} 客户端`,
      app.installed && app.signedIn,
      app.installed
        ? `${app.version || "版本未知"}${app.signedIn ? "，已登录" : "，未登录"}${app.runtimeInfo ? "，设备身份组件可用" : "，缺少 runtime-info"}`
        : "未检测到安装",
      !expected,
    );
    try {
      const live = readQoderLive(provider);
      if (live) {
        const expires = live.auth.expiresAt ? new Date(live.auth.expiresAt) : null;
        push(
          checks,
          `${QODER_LABEL[provider]} 登录态`,
          !expires || expires.getTime() > Date.now(),
          `${live.auth.user?.name || live.auth.user?.email || live.uid}${expires ? `，有效期至 ${expires.toLocaleString("zh-CN")}` : ""}`,
          !expected,
        );
      }
    } catch (error) {
      push(checks, `${QODER_LABEL[provider]} 登录态`, false, error.message, !expected);
    }
  }

  const traeExpected = store.listAccounts().some((account) => account.provider === "trae");
  const trae = detectTrae();
  push(
    checks,
    "Trae 客户端",
    trae.signedIn,
    trae.signedIn ? `${trae.name}，已登录` : trae.exe || trae.dataExists ? "已安装但未登录" : "未检测到安装",
    !traeExpected,
  );
  try {
    const live = readTraeLive();
    if (live) {
      const expires = live.auth.expiredAt ? new Date(live.auth.expiredAt) : null;
      push(
        checks,
        "Trae 登录态",
        !expires || expires.getTime() > Date.now(),
        `${live.auth.account?.username || live.uid}${expires ? `，有效期至 ${expires.toLocaleString("zh-CN")}` : ""}${live.isIntl ? "（国际版，暂不支持领取）" : ""}`,
        !traeExpected,
      );
    }
  } catch (error) {
    push(checks, "Trae 登录态", false, error.message, !traeExpected);
  }

  const qoderExpected = store.listAccounts().some((account) => account.provider === "qoder");
  push(checks, "Qoder 设备风控", riskAvailable("qoder"), riskAvailable("qoder") ? "runtime-info 可用" : "缺少组件，国际版可能查不到活动", !qoderExpected);
  try {
    const live = readQoderLive("qoder");
    if (live) {
      const risk = await getRiskIdentity("qoder", live.uid, store);
      push(checks, "Qoder 国际版设备身份", Boolean(risk), risk ? "生成成功" : "生成失败", !qoderExpected);
    }
  } catch (error) {
    push(checks, "Qoder 国际版设备身份", false, error.message, !qoderExpected);
  }

  const task = taskStatus();
  push(checks, "开机自启", task.installed, task.installed ? `计划任务 ${task.state || "已注册"}` : "未安装（可选）", true);

  if (network) {
    const { ClaimEngine } = await import("./claim.mjs");
    const engine = new ClaimEngine({ store, log: { summary: () => ({ accounts: [] }), append: () => ({}) } });
    // network 模式只查状态，不领取。
    try {
      const result = await engine.refreshStatuses({});
      for (const row of result.results) {
        push(checks, `${row.name} 状态查询`, row.status !== "failed", `${row.status}${row.message ? `：${row.message}` : ""}`);
      }
    } catch (error) {
      push(checks, "状态查询", false, error.message);
    }
  }

  return { ok: checks.every((check) => check.ok || check.optional), checks, home: store.home };
}
