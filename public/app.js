const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const app = {
  state: null,
  logs: [],
  route: "overview",
  busy: false,
  logType: "all",
  logProvider: "",
  loginTimer: null,
  online: true,
  update: null,
  updateError: null,
};

const PROJECT_URL = "https://github.com/sanzhixiaoxia/AutoSwitch";

const PROVIDER_META = {
  trae: { label: "Trae CN", short: "Trae", avatar: "TR", color: "#2f6fed" },
  workbuddy: { label: "WorkBuddy", short: "WorkBuddy", avatar: "WB", color: "#0d9488" },
  "qoder-cn": { label: "Qoder 国内版", short: "Qoder CN", avatar: "CN", color: "#0f9d76" },
  qoder: { label: "Qoder 国际版", short: "Qoder", avatar: "QO", color: "#7c5cff" },
};

const STATUS = {
  claimed: { label: "已领取", cls: "ok" },
  already: { label: "已领取", cls: "ok" },
  claimable: { label: "可领取", cls: "info" },
  "no-activity": { label: "暂无活动", cls: "idle" },
  expired: { label: "凭据失效", cls: "bad" },
  failed: { label: "失败", cls: "bad" },
  "device-limited": { label: "本机名额已用", cls: "warn" },
  pending: { label: "待检查", cls: "idle" },
  ok: { label: "完成", cls: "ok" },
  partial: { label: "部分失败", cls: "warn" },
  error: { label: "失败", cls: "bad" },
  import: { label: "导入", cls: "info" },
  switch: { label: "切换", cls: "violet" },
  "switch-failed": { label: "切换失败", cls: "bad" },
  login: { label: "登录", cls: "info" },
  remove: { label: "移除", cls: "idle" },
  task: { label: "任务", cls: "info" },
  auto: { label: "自动领取", cls: "info" },
};

const TRIGGER_LABEL = {
  auto: "自动",
  manual: "手动",
  cli: "命令行",
  startup: "启动",
  import: "导入",
  status: "刷新状态",
  "": "",
};

const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const icon = (name, cls = "") => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const safeColor = (value) => (/^#[0-9a-f]{3,8}$/i.test(String(value || "")) ? value : "#3157d5");
const metaOf = (provider) => PROVIDER_META[provider] || { label: provider, short: provider, avatar: "?", color: "#6d7686" };

function fmtLocal(value, seconds = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hour12: false,
  });
}

function fmtShort(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtNext(value) {
  if (!value) return "已关闭";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86_400_000).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return `今天 ${time}`;
  if (tomorrow) return `明天 ${time}`;
  return fmtShort(value);
}

function fmtAmount(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function isDone(status) {
  return status === "claimed" || status === "already";
}

function badge(status, label) {
  const info = STATUS[status] || { label: status || "未知", cls: "idle" };
  return `<span class="badge ${info.cls}">${esc(label || info.label)}</span>`;
}

function providerStyle(provider) {
  return `--provider-color:${safeColor(metaOf(provider).color)}`;
}

function expiryInfo(account) {
  if (!account.expiresAt) return { text: "长期有效", cls: "" };
  const date = new Date(account.expiresAt);
  if (!Number.isFinite(date.getTime())) return { text: "未知", cls: "" };
  if (date.getTime() <= Date.now()) return { text: "已过期", cls: "text-bad" };
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  return {
    text: `${date.toLocaleDateString("zh-CN")}${days <= 3 ? `（剩 ${days} 天）` : ""}`,
    cls: days <= 3 ? "text-warn" : "",
  };
}

async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (method !== "GET") {
    headers["x-autoswitch"] = "1";
    headers["content-type"] = "application/json";
  }
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw Object.assign(new Error("无法连接本机服务，请确认 AutoSwitch 仍在运行"), { network: true });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function setOnline(online) {
  app.online = online;
  const pill = $("#livePill");
  if (!pill) return;
  pill.classList.toggle("offline", !online);
  pill.innerHTML = `<i></i>${online ? "本机服务" : "连接中断"}`;
}

function toast(message, tone = "ok", detail = "") {
  const root = $("#toastRoot");
  if (!root) return;
  const node = document.createElement("div");
  node.className = `toast ${tone}`;
  const iconName = tone === "bad" ? "alert" : tone === "warn" ? "info" : "check";
  node.innerHTML = `${icon(iconName)}<div>${esc(message)}${detail ? `<div class="tiny muted">${esc(detail)}</div>` : ""}</div>`;
  root.appendChild(node);
  setTimeout(() => node.remove(), 5000);
}

function setBusy(on, text = "正在处理…") {
  app.busy = on;
  $("#busyBar")?.classList.toggle("hidden", !on);
  if ($("#busyText")) $("#busyText").textContent = text;
  $$("#content button, #refreshBtn").forEach((button) => {
    if (on) {
      if (button.dataset.cpWasDisabled === undefined) {
        button.dataset.cpWasDisabled = button.disabled ? "1" : "0";
      }
      button.disabled = true;
    } else if (button.dataset.cpWasDisabled !== undefined) {
      button.disabled = button.dataset.cpWasDisabled === "1";
      delete button.dataset.cpWasDisabled;
    }
  });
}

async function refreshData({ logs = true, silent = false } = {}) {
  try {
    const tasks = [api("/api/state")];
    if (logs) tasks.push(api("/api/logs?limit=300"));
    const [state, logData] = await Promise.all(tasks);
    app.state = state;
    if (logs) app.logs = logData?.entries || [];
    setOnline(true);
    render();
    return true;
  } catch (error) {
    setOnline(false);
    if (!silent) toast(error.message, "bad");
    if (!app.state) renderError(error.message);
    return false;
  }
}

async function loadCachedUpdate() {
  try {
    const data = await api("/api/update");
    if (data.checked) {
      app.update = data;
      app.updateError = null;
      if (app.route === "settings") render();
    }
  } catch {}
}

async function runUpdateCheck() {
  if (app.busy) return;
  setBusy(true, "正在检查 GitHub Releases…");
  try {
    const data = await api("/api/update/check", { method: "POST" });
    app.update = data.update;
    app.updateError = null;
    const update = app.update;
    toast(
      update?.hasUpdate ? `发现新版本 v${update.latest}` : update?.hasRelease ? `已是最新版本 v${update.latest}` : "项目还没有发布版本",
      update?.hasUpdate ? "warn" : "ok",
    );
  } catch (error) {
    app.updateError = error.message;
    toast(error.message, "bad");
  } finally {
    setBusy(false);
    render();
  }
}

function renderError(message) {
  const content = $("#content");
  if (!content) return;
  content.innerHTML = `<div class="empty">
    <div class="empty-icon">${icon("alert")}</div>
    <h3>无法读取本机服务</h3>
    <p>${esc(message || "请确认 AutoSwitch 守护进程仍在运行，然后重试。")}</p>
    <div class="actions"><button class="btn primary" data-action="retry-state">${icon("refresh")}重试</button></div>
  </div>`;
}

function render() {
  if (!app.state) return;
  const { accounts, summary, scheduler } = app.state;
  const titles = {
    overview: ["总览", `${accounts.length} 个账号 · Qoder 轮次 ${summary.round.qoder} · Trae ${summary.round.trae}`],
    records: ["记录", "领取、切换与系统事件都保存在本机"],
    settings: ["设置", "自动领取、开机自启与数据安全"],
  };
  const page = titles[app.route] || titles.overview;
  $("#pageTitle").textContent = page[0];
  $("#pageSubtitle").textContent = page[1];
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.route === app.route));
  $("#versionText").textContent = `v${app.state.app.version}`;
  const projectLink = $("#projectLink");
  if (projectLink) projectLink.href = app.state.app.repoUrl || PROJECT_URL;
  const autoMini = $("#autoMini");
  autoMini.classList.toggle("on", Boolean(scheduler.autoClaim && scheduler.running));
  const autoText = autoMini.querySelector("strong");
  if (autoText) autoText.textContent = !scheduler.autoClaim ? "关闭" : scheduler.running ? "开启" : "未运行";

  const content = $("#content");
  if (app.route === "records") content.innerHTML = renderRecords();
  else if (app.route === "settings") content.innerHTML = renderSettings();
  else content.innerHTML = renderOverview();
  if (app.busy) setBusy(true, $("#busyText")?.textContent || "正在处理…");
}

function renderHero(accounts) {
  const { summary, scheduler } = app.state;
  const total = summary.total;
  const done = summary.done;
  const pending = summary.pending;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const headline = total === 0 ? "还没有账号" : pending === 0 ? "今天的积分已全部领取" : `还有 ${pending} 个账号等待领取`;
  const sub =
    total === 0
      ? "从本机已登录的 Trae / Qoder 客户端导入账号，或使用浏览器登录 Qoder。"
      : `Qoder 轮次 ${summary.round.qoder} · Trae ${summary.round.trae} · 领取结果以官方接口为准。`;
  return `<section class="hero">
    <div class="hero-main">
      <div class="hero-kicker">${icon("gift")}今日领取进度</div>
      <div class="hero-number"><strong>${done}</strong><span>/ ${total || 0} 个账号</span></div>
      <p class="hero-copy">${esc(headline)}。${esc(sub)}</p>
      <div class="progress" aria-label="领取进度"><span style="width:${percent}%"></span></div>
      <div class="hero-actions">
        <button class="btn primary" data-action="claim-all" ${total === 0 || app.busy ? "disabled" : ""}>${icon("play")}立即领取全部</button>
        <button class="btn" data-action="refresh-status" ${total === 0 || app.busy ? "disabled" : ""}>${icon("refresh")}刷新状态</button>
        <button class="btn ghost" data-action="add-account" ${app.busy ? "disabled" : ""}>${icon("plus")}添加账号</button>
        <button class="btn ghost" data-action="import" ${app.busy ? "disabled" : ""}>${icon("download")}导入本机账号</button>
      </div>
    </div>
    <aside class="hero-side">
      <div class="mini-stat">${icon("clock")}<div><span>下次自动检查</span><strong>${esc(fmtNext(scheduler.nextRunAt))}${scheduler.autoRunning ? " · 正在执行" : ""}</strong></div></div>
      <div class="mini-stat">${icon("power")}<div><span>自动领取</span><strong>${scheduler.autoClaim ? `开启 · 每 ${scheduler.intervalMinutes} 分钟` : "关闭"}</strong></div></div>
      <div class="mini-stat">${icon("list")}<div><span>上次运行</span><strong>${scheduler.lastRun ? `${esc(scheduler.lastRun.local || fmtLocal(scheduler.lastRun.at))} · ${esc(scheduler.lastRun.message || "")}` : "尚未运行"}</strong></div></div>
      ${scheduler.lastError ? `<div class="mini-stat"><span class="text-bad">${esc(scheduler.lastError)}</span></div>` : ""}
    </aside>
  </section>`;
}

function accountTags(account) {
  const sourceLabel = { "workbuddy-switch": "WorkBuddy Switch", device: "浏览器登录", browser: "浏览器登录", local: "客户端导入" }[account.source] || "客户端导入";
  const tags = [account.isActive ? `<span class="tag active">当前登录</span>` : "", `<span class="tag">${esc(sourceLabel)}</span>`];
  if (account.provider === "workbuddy") tags.push(`<span class="tag">用 Switch 切换</span>`);
  else if (account.hasSnapshot) tags.push(account.isActive ? "" : `<span class="tag">可切换</span>`);
  else tags.push(`<span class="tag">无切号快照</span>`);
  if (account.expired) tags.push(`<span class="tag" style="color:var(--red);border-color:var(--red)">凭据过期</span>`);
  return tags.filter(Boolean).join("");
}

function renderAccountRow(account) {
  const meta = metaOf(account.provider);
  const status = account.today?.status || "pending";
  const expiry = expiryInfo(account);
  const quota = Number(account.quota?.remaining);
  const switchTitle = account.isActive
    ? "已经是当前登录账号"
    : account.hasSnapshot
      ? "关闭并重启客户端以切换登录"
      : account.provider === "workbuddy"
        ? "WorkBuddy 请使用 WorkBuddy Switch 切换"
        : "浏览器登录的账号没有客户端快照";
  return `<div class="data-row" style="${providerStyle(account.provider)}">
    <div class="row-account">
      <div class="account-avatar">${esc(meta.avatar)}</div>
      <div class="row-account-text">
        <strong>${esc(account.name || account.uid || "未命名账号")}</strong>
        <span>${esc(account.email || account.phoneHint || account.uid || "")}</span>
        <div class="account-tags">${accountTags(account)}</div>
      </div>
    </div>
    <div class="row-cell"><span class="row-label">今日状态</span>${badge(status)}</div>
    <div class="row-cell"><span class="row-label">剩余额度</span><strong class="${Number.isFinite(quota) ? "big" : ""}">${Number.isFinite(quota) ? esc(fmtAmount(quota)) : "—"}</strong></div>
    <div class="row-cell"><span class="row-label">最近领取</span>${account.today?.at ? esc(fmtShort(account.today.at)) : "—"}</div>
    <div class="row-cell"><span class="row-label">凭据到期</span><span class="${expiry.cls}">${esc(expiry.text)}</span></div>
    <div class="row-actions">
      <button class="btn small primary" data-action="claim-account" data-id="${esc(account.id)}" ${app.busy ? "disabled" : ""}>${icon("play")}领取</button>
      <button class="btn small" data-action="switch-account" data-id="${esc(account.id)}" ${!account.hasSnapshot || account.isActive || app.busy ? "disabled" : ""} title="${esc(switchTitle)}">${icon("switch")}切换</button>
      <button class="btn small danger icon-only" data-action="delete-account" data-id="${esc(account.id)}" title="移除账号" ${app.busy ? "disabled" : ""}>${icon("trash")}</button>
    </div>
  </div>`;
}

function renderProviderGroup(provider, accounts, client) {
  const meta = metaOf(provider);
  const clientText = client ? (client.installed ? `客户端${client.running ? "运行中" : "未运行"}${client.signedIn ? " · 已登录" : " · 未登录"}` : "未安装客户端") : "";
  const hint = provider === "workbuddy" ? "token 由 WorkBuddy Switch 保管" : provider === "trae" ? "登录态取自本机客户端" : "支持浏览器设备码登录";
  const done = accounts.filter((account) => isDone(account.today?.status)).length;
  return `<div class="group-row" style="${providerStyle(provider)}">
    <span class="group-logo">${esc(meta.avatar)}</span>
    <strong>${esc(meta.label)}</strong>
    <em>${esc([clientText, accounts.length ? `已保存 ${accounts.length} 个 · 今日 ${done}/${accounts.length}` : "还没有账号", hint].filter(Boolean).join(" · "))}</em>
    <span class="group-actions">
      ${
        accounts.length
          ? `<button class="btn small" data-action="claim-provider" data-provider="${esc(provider)}" ${app.busy ? "disabled" : ""}>${icon("play")}领取全部</button>`
          : provider === "workbuddy"
            ? `<button class="btn small primary" data-action="import-workbuddy" ${app.busy ? "disabled" : ""}>${icon("download")}从 Switch 导入</button>`
            : `<button class="btn small primary" data-action="import" ${app.busy ? "disabled" : ""}>${icon("download")}导入本机</button>${provider === "qoder" || provider === "qoder-cn" ? `<button class="btn small" data-action="login" data-provider="${esc(provider)}" ${app.busy ? "disabled" : ""}>${icon("plus")}浏览器登录</button>` : ""}`
      }
    </span>
  </div>`;
}

function renderOverview() {
  const { accounts, clients } = app.state;
  const grouped = Object.fromEntries(Object.keys(PROVIDER_META).map((provider) => [provider, []]));
  for (const account of accounts) (grouped[account.provider] ||= []).push(account);
  const rows = [];
  for (const provider of Object.keys(PROVIDER_META)) {
    const list = grouped[provider] || [];
    rows.push(renderProviderGroup(provider, list, clients.find((row) => row.provider === provider)));
    for (const account of list) rows.push(renderAccountRow(account));
  }
  const recent = app.logs.filter((entry) => entry.type === "claim").slice(0, 8);
  const feed = recent.length
    ? recent
        .map((entry) => {
          const tone = isDone(entry.status) ? "" : entry.status === "failed" || entry.status === "expired" ? "bad" : "idle";
          return `<div class="feed-row">
            <span class="feed-dot ${tone}"></span>
            <div class="feed-copy"><strong>${esc(entry.accountName || "系统")} · ${esc(entry.label || STATUS[entry.status]?.label || entry.status)}</strong><span>${esc(entry.providerLabel || metaOf(entry.provider).label)} · ${esc(entry.message || "")}</span></div>
            <span class="feed-time">${esc(fmtShort(entry.at))}</span>
          </div>`;
        })
        .join("")
    : `<div class="feed-row"><span class="feed-dot idle"></span><div class="feed-copy"><strong>还没有领取记录</strong><span>点击「立即领取全部」开始第一次领取。</span></div></div>`;
  const clientRows = clients
    .map((client) => {
      const tone = client.installed && client.signedIn ? "" : client.installed ? "warn" : "idle";
      const detail = client.installed
        ? `${client.running ? "运行中" : "未运行"} · ${client.signedIn ? "已登录" : "未登录"}${client.version ? ` · v${client.version}` : ""}${client.switchVault ? " · 有 Switch 账号库" : ""}`
        : "未安装客户端";
      return `<div class="feed-row">
        <span class="feed-dot ${tone}"></span>
        <div class="feed-copy"><strong>${esc(metaOf(client.provider).label)}</strong><span>${esc(detail)}</span></div>
        <span class="feed-time">${esc(client.name || "")}</span>
      </div>`;
    })
    .join("");

  return `${renderHero(accounts)}
    <section class="data-list">
      <div class="data-list-head">
        <span>账号</span><span>今日状态</span><span>剩余额度</span><span>最近领取</span><span>凭据到期</span><span>操作</span>
      </div>
      ${rows.join("")}
    </section>
    <div class="info-box" style="margin-top:14px">${icon("info")}<div><strong>多账号说明</strong><br />领取用已保存的 token 走官方接口，不需要切换客户端；「切换」只用于把桌面客户端登录换成该账号。Qoder 可用「浏览器登录」直接加账号；Trae 需要先在客户端登录另一个账号再导入。每台设备每天限领：Qoder 国际版一个账号、Trae CN 一个账号，超出的账号显示「本机名额已用」。WorkBuddy 的 token 由 WorkBuddy Switch 保管，过期后请在 Switch 里重新登录再导入。</div></div>
    <div class="section-title">
      <div><h2>最近领取与本机客户端</h2><p>状态按官方接口查询结果和本应用领取记录汇总</p></div>
      <button class="btn small ghost" data-action="go-records">查看全部${icon("chevron")}</button>
    </div>
    <div class="lower-grid">
      <section class="panel">
        <div class="panel-head"><div class="panel-title">${icon("list")}<h2>最近领取</h2></div><span class="tiny faint">${recent.length} 条</span></div>
        <div class="feed">${feed}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><div class="panel-title">${icon("monitor")}<h2>本机客户端</h2></div><span class="tiny faint">${clients.filter((row) => row.installed).length}/${clients.length} 已安装</span></div>
        <div class="feed">${clientRows}</div>
      </section>
    </div>
    ${accounts.length === 0 ? renderEmptyAccounts() : ""}`;
}

function renderEmptyAccounts() {
  return `<div class="empty" style="margin-top:18px">
    <div class="empty-icon">${icon("users")}</div>
    <h3>还没有保存任何账号</h3>
    <p>AutoSwitch 会读取本机已登录的 Trae CN、Qoder 国内版、Qoder 国际版客户端。先在客户端登录，再点击导入；也可以直接用浏览器登录 Qoder 添加独立账号。</p>
    <div class="actions">
      <button class="btn primary" data-action="import">${icon("download")}导入本机账号</button>
      <button class="btn" data-action="add-account">${icon("plus")}浏览器登录 Qoder</button>
    </div>
  </div>`;
}

function renderRecords() {
  const types = app.logType === "all" ? null : app.logType === "system" ? ["event", "run"] : ["claim"];
  const rows = app.logs.filter((entry) => {
    if (entry.type === "event" && entry.status === "auto" && entry.provider === "system") return false;
    if (types && !types.includes(entry.type)) return false;
    if (app.logProvider && entry.provider !== app.logProvider) return false;
    return true;
  });
  const body = rows.length
    ? rows
        .map((entry) => {
          const status = entry.type === "run" ? entry.status : entry.status;
          const tone = isDone(entry.status) ? "ok" : entry.status === "failed" || entry.status === "expired" || entry.status === "error" ? "bad" : entry.status === "partial" ? "warn" : "idle";
          return `<tr>
            <td class="time-cell">${esc(entry.local || fmtLocal(entry.at))}</td>
            <td>${esc(entry.provider === "system" || entry.provider === "all" ? "系统" : metaOf(entry.provider).label)}</td>
            <td>${esc(entry.accountName || "—")}</td>
            <td>${esc(TRIGGER_LABEL[entry.trigger] || entry.trigger || "—")}</td>
            <td><span class="badge ${tone}">${esc(entry.label || STATUS[entry.status]?.label || status)}</span></td>
            <td class="amount-cell">${entry.amount ? `+${esc(fmtAmount(entry.amount))}` : "—"}</td>
            <td class="message-cell">${esc(entry.message || "")}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7"><div class="empty" style="border:0;min-height:160px"><div class="empty-icon">${icon("list")}</div><h3>没有符合条件的记录</h3><p>领取、切换和自动任务事件都会出现在这里。</p></div></td></tr>`;
  return `<div class="filters">
      <div class="segmented">
        <button class="${app.logType === "all" ? "active" : ""}" data-action="filter-type" data-type="all">全部</button>
        <button class="${app.logType === "claim" ? "active" : ""}" data-action="filter-type" data-type="claim">领取</button>
        <button class="${app.logType === "system" ? "active" : ""}" data-action="filter-type" data-type="system">系统</button>
      </div>
      <select class="select" id="logProvider">
        <option value="">全部平台</option>
        ${Object.keys(PROVIDER_META).map((provider) => `<option value="${esc(provider)}" ${app.logProvider === provider ? "selected" : ""}>${esc(metaOf(provider).label)}</option>`).join("")}
      </select>
      <button class="btn small" data-action="refresh-logs">${icon("refresh")}刷新</button>
      <span class="tiny faint" style="margin-left:auto">${rows.length} 条 · 时间均为本机时区</span>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>时间</th><th>平台</th><th>账号</th><th>触发</th><th>结果</th><th>积分</th><th>说明</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function filenameFromDisposition(value, fallback) {
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(String(value || ""));
  if (!match) return fallback;
  try {
    return decodeURIComponent(match[1].replaceAll('"', "").trim());
  } catch {
    return fallback;
  }
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunk = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function openBackupModal() {
  showModal({
    title: "创建加密备份",
    subtitle: "账号与设置会使用密码加密；恢复时需要同一密码。",
    iconName: "download",
    body: `<div class="field stack">
        <div class="field-label"><strong>备份密码</strong><span>至少 8 位，请妥善保存</span></div>
        <input class="input" id="backupPassword" type="password" autocomplete="new-password" placeholder="至少 8 位" style="width:100%;margin-top:8px" />
      </div>
      <div class="info-box" style="margin-top:12px">${icon("info")}<div>备份包含账号与设置，不包含领取记录和 Trae 文件快照。备份文件含 token，请像密码一样保管。</div></div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn primary" data-backup-do>创建并下载</button>`,
    onMount: (modal, close) => {
      const input = modal.querySelector("#backupPassword");
      const button = modal.querySelector("[data-backup-do]");
      input.focus();
      button.addEventListener("click", async () => {
        const password = input.value;
        if (password.length < 8) return toast("备份密码至少 8 位", "warn");
        button.disabled = true;
        button.textContent = "正在创建…";
        try {
          const response = await fetch("/api/backup", {
            method: "POST",
            headers: { "x-autoswitch": "1", "content-type": "application/json" },
            body: JSON.stringify({ password }),
          });
          if (!response.ok) {
            const error = await response.json().catch(() => null);
            throw new Error(error?.error || `创建备份失败（HTTP ${response.status}）`);
          }
          const blob = await response.blob();
          const filename = filenameFromDisposition(response.headers.get("content-disposition"), "AutoSwitch-backup.asbackup");
          downloadBlob(blob, filename);
          toast(`备份已下载：${filename}`, "ok");
          close();
        } catch (error) {
          toast(error.message, "bad");
          button.disabled = false;
          button.textContent = "创建并下载";
        }
      });
    },
  });
}

function openRestoreModal() {
  showModal({
    title: "恢复备份",
    subtitle: "恢复会替换当前账号与设置；本地领取记录保留，并自动创建回滚副本。",
    iconName: "alert",
    tone: "warn",
    body: `<div class="field stack">
        <div class="field-label"><strong>备份文件</strong><span>.asbackup</span></div>
        <input class="input" id="restoreFile" type="file" accept=".asbackup,.json" style="width:100%;height:auto;margin-top:8px;padding:7px" />
      </div>
      <div class="field stack" style="margin-top:12px">
        <div class="field-label"><strong>备份密码</strong></div>
        <input class="input" id="restorePassword" type="password" autocomplete="current-password" style="width:100%;margin-top:8px" />
      </div>
      <div class="info-box warn" style="margin-top:12px">${icon("alert")}<div>Trae 客户端切换快照不会随备份恢复；恢复后需要在客户端重新登录并导入，才能切换 Trae 账号。</div></div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn danger" data-restore-do>确认覆盖并恢复</button>`,
    onMount: (modal, close) => {
      const fileInput = modal.querySelector("#restoreFile");
      const passwordInput = modal.querySelector("#restorePassword");
      const button = modal.querySelector("[data-restore-do]");
      button.addEventListener("click", async () => {
        const file = fileInput.files?.[0];
        const password = passwordInput.value;
        if (!file) return toast("请选择备份文件", "warn");
        if (password.length < 8) return toast("请输入备份密码", "warn");
        button.disabled = true;
        button.textContent = "正在恢复…";
        try {
          const data = toBase64(await file.arrayBuffer());
          const response = await fetch("/api/restore", {
            method: "POST",
            headers: { "x-autoswitch": "1", "content-type": "application/json" },
            body: JSON.stringify({ password, data }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) throw new Error(payload?.error || `恢复失败（HTTP ${response.status}）`);
          close();
          toast(`已恢复 ${payload.result.accounts} 个账号`, "ok");
          app.state = payload.state;
          await refreshData({ silent: true });
        } catch (error) {
          toast(error.message, "bad");
          button.disabled = false;
          button.textContent = "确认覆盖并恢复";
        }
      });
    },
  });
}

function renderUpdateCard(info) {  const update = app.update;
  const state = app.updateError
    ? { cls: "bad", label: "检查失败" }
    : !update?.checked
      ? { cls: "idle", label: "未检查" }
      : update.hasUpdate
        ? { cls: "info", label: "有新版本" }
        : update.hasRelease
          ? { cls: "ok", label: "已是最新" }
          : { cls: "idle", label: "暂无发布" };
  const latest = update?.latest ? `v${update.latest}` : "—";
  const checked = update?.checkedAt ? fmtLocal(update.checkedAt) : "—";
  let body;
  if (app.updateError) {
    body = `<div class="info-box warn">${icon("alert")}<div><strong>检查失败</strong><br />${esc(app.updateError)}</div></div>`;
  } else if (update?.hasUpdate) {
    const setup = update.downloads?.setup;
    const portable = update.downloads?.portable;
    body = `<div class="info-box">${icon("gift")}<div><strong>发现新版本 v${esc(update.latest)}</strong>${update.notes ? `<div class="update-notes">${esc(update.notes)}</div>` : ""}<div class="release-links">
      ${setup ? `<a class="btn small primary" href="${esc(setup.url)}" target="_blank" rel="noopener noreferrer">${icon("download")}Windows 安装包</a>` : ""}
      ${portable ? `<a class="btn small" href="${esc(portable.url)}" target="_blank" rel="noopener noreferrer">${icon("download")}便携版</a>` : ""}
      <a class="btn small ghost" href="${esc(update.releaseUrl)}" target="_blank" rel="noopener noreferrer">${icon("external")}Release</a>
    </div></div></div>`;
  } else if (update?.checked && update.hasRelease) {
    body = `<div class="info-box">${icon("check")}<div>已是最新版本（v${esc(update.latest)}）${update.releaseUrl ? ` · <a href="${esc(update.releaseUrl)}" target="_blank" rel="noopener noreferrer">查看 Release</a>` : ""}</div></div>`;
  } else if (update?.checked) {
    body = `<div class="info-box">${icon("info")}<div>项目还没有发布版本。打 <span class="code-path">v*</span> 标签后 GitHub Actions 会自动构建并发布 Windows 安装包。</div></div>`;
  } else {
    body = `<div class="info-box">${icon("info")}<div>点击「检查更新」从 GitHub Releases 获取最新版本；只检查，不自动安装。</div></div>`;
  }
  const repoUrl = info.repoUrl || PROJECT_URL;
  return `<section class="setting-card">
    <div class="panel-head"><div class="panel-title">${icon("refresh")}<h2>关于与更新</h2></div><span class="badge ${state.cls}">${esc(state.label)}</span></div>
    <div class="panel-body">
      <div class="kv-list">
        <div class="kv"><span>当前版本</span><strong>v${esc(info.version)}</strong></div>
        <div class="kv"><span>项目地址</span><strong><a href="${esc(repoUrl)}" target="_blank" rel="noopener noreferrer">sanzhixiaoxia/AutoSwitch</a></strong></div>
        <div class="kv"><span>最新版本</span><strong>${esc(latest)}</strong></div>
        <div class="kv"><span>上次检查</span><strong>${esc(checked)}</strong></div>
      </div>
      ${body}
      <div class="actions" style="display:flex;gap:8px">
        <button class="btn primary" data-action="check-update" ${app.busy ? "disabled" : ""}>${icon("refresh")}检查更新</button>
        <a class="btn" href="${esc(update?.releaseUrl || `${repoUrl}/releases`)}" target="_blank" rel="noopener noreferrer">${icon("external")}Releases</a>
      </div>
    </div>
  </section>`;
}

function renderSettings() {
  const { config, scheduler, task, app: info, accounts } = app.state;
  const taskInstalled = Boolean(task?.installed);
  return `<div class="settings-grid">
    <section class="setting-card">
      <div class="panel-head"><div class="panel-title">${icon("clock")}<h2>自动领取</h2></div>${badge(config.autoClaim ? "ok" : "idle", config.autoClaim ? "已开启" : "已关闭")}</div>
      <div class="panel-body">
        <div class="field">
          <div class="field-label"><strong>每日自动领取</strong><span>应用运行且电脑未休眠时生效，已领取的账号不会重复领取。</span></div>
          <button class="switch ${config.autoClaim ? "on" : ""}" data-action="toggle-auto" aria-label="切换自动领取" ${app.busy ? "disabled" : ""}></button>
        </div>
        <div class="field">
          <div class="field-label"><strong>检查间隔</strong><span>每次检查会先查官方状态，未领取才领取。建议 120 分钟。</span></div>
          <div style="display:flex;gap:6px;align-items:center"><input class="input" id="intervalInput" type="number" min="15" max="1440" value="${esc(config.intervalMinutes)}" style="width:84px" /> <span class="tiny muted">分钟</span><button class="btn small" data-action="save-interval" ${app.busy ? "disabled" : ""}>保存</button></div>
        </div>
        <div class="field">
          <div class="field-label"><strong>账号间隔</strong><span>多个账号依次领取时的等待时间，避免请求过快。</span></div>
          <div style="display:flex;gap:6px;align-items:center"><input class="input" id="delayInput" type="number" min="0" max="10000" step="100" value="${esc(config.claimDelayMs)}" style="width:84px" /> <span class="tiny muted">毫秒</span><button class="btn small" data-action="save-delay" ${app.busy ? "disabled" : ""}>保存</button></div>
        </div>
        <div class="info-box">${icon("info")}<div>下次自动检查：<strong>${esc(fmtNext(scheduler.nextRunAt))}</strong>${scheduler.lastRun ? `；上次运行：${esc(scheduler.lastRun.local || fmtLocal(scheduler.lastRun.at))}` : ""}。</div></div>
      </div>
    </section>

    <section class="setting-card">
      <div class="panel-head"><div class="panel-title">${icon("power")}<h2>开机自启</h2></div>${badge(taskInstalled ? "ok" : "idle", taskInstalled ? "已安装" : "未安装")}</div>
      <div class="panel-body">
        <p class="modal-copy" style="margin:0">安装后会在当前 Windows 用户登录时静默启动本机服务，不需要打开浏览器。计划任务只运行本项目的 Node 进程，不申请管理员权限。</p>
        <div class="kv-list">
          <div class="kv"><span>任务名称</span><strong>AutoSwitch</strong></div>
          <div class="kv"><span>当前状态</span><strong>${esc(task?.state || (taskInstalled ? "已注册" : "未注册"))}</strong></div>
          <div class="kv"><span>上次运行</span><strong>${esc(task?.lastRun || "—")}</strong></div>
        </div>
        <div class="actions" style="display:flex;gap:8px">
          ${taskInstalled
            ? `<button class="btn danger" data-action="uninstall-task" ${app.busy ? "disabled" : ""}>${icon("trash")}移除自启</button>`
            : `<button class="btn primary" data-action="install-task" ${app.busy ? "disabled" : ""}>${icon("power")}安装开机自启</button>`}
          <button class="btn" data-action="doctor" ${app.busy ? "disabled" : ""}>${icon("shield")}运行诊断</button>
        </div>
        <div class="info-box warn">${icon("info")}<div>如果你的系统策略禁止注册计划任务，可以手动运行 <span class="code-path">autoswitch start --no-open</span>，或用任务计划程序指向同样的命令。</div></div>
      </div>
    </section>

    <section class="setting-card">
      <div class="panel-head"><div class="panel-title">${icon("database")}<h2>数据与安全</h2></div><span class="tiny faint">${accounts.length} 个账号</span></div>
      <div class="panel-body">
        <div class="kv-list">
          <div class="kv"><span>数据目录</span><strong><span class="code-path">${esc(info.home)}</span></strong></div>
          <div class="kv"><span>账号库加密</span><strong>Windows DPAPI + AES-256-GCM</strong></div>
          <div class="kv"><span>网络监听</span><strong>仅 127.0.0.1:${esc(info.port)}</strong></div>
          <div class="kv"><span>应用版本</span><strong>v${esc(info.version)}</strong></div>
        </div>
        <div class="info-box">${icon("shield")}<div>账号 token 只在本机进程中读取，不会发送到网页或第三方服务。领取记录不包含 token。停止本服务后不会继续执行任何任务（浏览器页面只是控制台）。</div></div>
        <div class="actions" style="display:flex;gap:8px">
          <button class="btn" data-action="import" ${app.busy ? "disabled" : ""}>${icon("download")}重新导入本机账号</button>
          <button class="btn" data-action="doctor" ${app.busy ? "disabled" : ""}>${icon("shield")}诊断</button>
        </div>
      </div>
    </section>

    <section class="setting-card">
      <div class="panel-head"><div class="panel-title">${icon("download")}<h2>备份与导出</h2></div><span class="tiny faint">密码加密</span></div>
      <div class="panel-body">
        <div class="info-box">${icon("shield")}<div>备份包含账号与设置，使用密码加密；不包含领取记录和 Trae 文件快照。备份文件含 token，请像密码一样保管。</div></div>
        <div class="actions" style="display:flex;flex-wrap:wrap;gap:8px">
          <button class="btn primary" data-action="create-backup" ${app.busy ? "disabled" : ""}>${icon("download")}创建加密备份</button>
          <button class="btn" data-action="restore-backup" ${app.busy ? "disabled" : ""}>${icon("refresh")}恢复备份</button>
        </div>
        <div class="divider"></div>
        <div class="actions" style="display:flex;flex-wrap:wrap;gap:8px">
          <a class="btn" href="/api/export/accounts.json" download>${icon("external")}导出账号清单 JSON</a>
          <a class="btn" href="/api/export/claims.csv" download>${icon("external")}导出领取记录 CSV</a>
        </div>
        <div class="tiny faint">导出文件不含 token，可安全查看或分享。恢复会覆盖账号与设置，本地领取记录保留。</div>
      </div>
    </section>

    ${renderUpdateCard(info)}

    <section class="setting-card">
      <div class="panel-head"><div class="panel-title">${icon("gift")}<h2>领取规则</h2></div><span class="tiny faint">官方活动</span></div>
      <div class="panel-body">
        <div class="kv-list">
          <div class="kv"><span>Qoder / Qoder CN</span><strong>每天 10:00（UTC+8）刷新，100 Credits</strong></div>
          <div class="kv"><span>Trae CN</span><strong>每日签到，积分以接口返回为准</strong></div>
          <div class="kv"><span>WorkBuddy</span><strong>每日签到，积分/连签以接口返回为准</strong></div>
          <div class="kv"><span>Qoder 国际版</span><strong>每台设备每天限领一个账号</strong></div>
          <div class="kv"><span>补领</span><strong>过期不补，凭据失效需重新登录</strong></div>
        </div>
        <div class="info-box warn">${icon("alert")}<div>本工具依赖官方客户端接口，官方更新后可能失效。请保持客户端已登录，并在「账号」页重新导入以同步最新 token。工具与 Trae / Qoder 官方没有隶属关系。</div></div>
      </div>
    </section>
  </div>`;
}

/* ── Modals ── */
function showModal({ title, subtitle = "", iconName = "info", tone = "", body = "", footer = "", wide = false, onMount, onClose }) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal-overlay">
    <div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <div class="modal-icon ${tone}">${icon(iconName)}</div>
        <div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div>
        <button class="modal-close" data-close aria-label="关闭">${icon("x")}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ""}
    </div>
  </div>`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    root.innerHTML = "";
    app.modalClose = null;
    onClose?.();
  };
  app.modalClose = close;
  root.querySelector(".modal-overlay").addEventListener("mousedown", (event) => {
    if (event.target === event.currentTarget) close();
  });
  $$("[data-close]", root).forEach((button) => button.addEventListener("click", close));
  onMount?.(root.querySelector(".modal"), close);
  return close;
}

function confirmAction({ title, message, confirmText = "确认", tone = "warn", iconName = "alert" }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    showModal({
      title,
      iconName,
      tone,
      body: `<p class="modal-copy">${message}</p>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn ${tone === "bad" ? "danger" : "primary"}" data-confirm>${esc(confirmText)}</button>`,
      onClose: () => finish(false),
      onMount: (modal, closeModal) => {
        modal.querySelector("[data-confirm]").addEventListener("click", () => {
          finish(true);
          closeModal();
        });
      },
    });
  });
}

function openLoginChooser() {
  const row = (provider, description, attribute) => {
    const meta = metaOf(provider);
    return `<button class="feed-row chooser-row" ${attribute}>
      <span class="feed-dot" style="background:${esc(meta.color)}"></span>
      <div class="feed-copy"><strong>${esc(meta.label)}</strong><span>${esc(description)}</span></div>
      ${icon("chevron")}
    </button>`;
  };
  showModal({
    title: "添加账号",
    subtitle: "Qoder 支持浏览器设备码登录；Trae CN 与 WorkBuddy 只能从本机已登录的客户端导入。",
    iconName: "plus",
    body: `<div class="feed">
      <div class="chooser-group">浏览器登录（生成独立 token，不动客户端当前登录）</div>
      ${row("qoder", "qoder.com · 每台设备每天限领一个国际版账号", 'data-login-provider="qoder"')}
      ${row("qoder-cn", "qoder.cn · 不受国际版设备名额限制", 'data-login-provider="qoder-cn"')}
      <div class="chooser-group">从本机导入</div>
      ${row("workbuddy", "读取 WorkBuddy Switch 本机账号库，可一次导入多个账号", "data-import-workbuddy")}
      ${row("trae", "导入本机 Trae CN 客户端当前登录，需先在客户端登录", "data-import-local")}
    </div>
    <div class="info-box" style="margin-top:12px">${icon("info")}<div>Trae CN 和 WorkBuddy 没有可独立保存的浏览器登录：Trae 的登录态只在本机客户端里，WorkBuddy 的 token 由 WorkBuddy Switch 加密保管。浏览器登录 token 约 30 天有效，过期后重新登录即可。</div></div>`,
    onMount: (modal, closeModal) => {
      modal.querySelector("[data-import-workbuddy]")?.addEventListener("click", () => {
        closeModal();
        importWorkBuddy();
      });
      modal.querySelector("[data-import-local]")?.addEventListener("click", () => {
        closeModal();
        runImport();
      });
      $$("[data-login-provider]", modal).forEach((button) =>
        button.addEventListener("click", () => {
          closeModal();
          startLogin(button.dataset.loginProvider);
        }),
      );
    },
  });
}

async function startLogin(provider) {
  if (app.busy) return;
  setBusy(true, "正在创建登录会话…");
  try {
    const data = await api("/api/login/start", { method: "POST", body: { provider } });
    setBusy(false);
    const session = data.session;
    const meta = metaOf(provider);
    let timer = null;
    let finished = false;
    showModal({
      title: `登录 ${meta.label}`,
      subtitle: "在浏览器完成授权后，这里会自动保存账号。",
      iconName: "external",
      body: `<div class="login-url"><a href="${esc(session.url)}" target="_blank" rel="noopener noreferrer">${esc(session.url)}</a><button class="btn small" data-copy>${icon("copy")}复制</button></div>
        <div class="login-state" id="loginState"><span class="spinner"></span><span>等待浏览器授权…（5 分钟内有效）</span></div>
        <div class="tiny faint" style="margin-top:10px">点击下方「打开授权页」在浏览器完成授权，然后不要关闭本窗口。</div>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn primary" data-open>${icon("external")}打开授权页</button>`,
      onClose: () => {
        finished = true;
        if (timer) clearInterval(timer);
      },
      onMount: (modal, closeModal) => {
        modal.querySelector("[data-open]").addEventListener("click", () => window.open(session.url, "_blank", "noopener"));
        modal.querySelector("[data-copy]").addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(session.url);
            toast("授权链接已复制");
          } catch {
            window.prompt("复制授权链接", session.url);
          }
        });
        timer = setInterval(async () => {
          if (finished) return;
          try {
            const result = await api(`/api/login/poll?sessionId=${encodeURIComponent(session.sessionId)}`);
            if (result.status === "ok") {
              finished = true;
              clearInterval(timer);
              app.state = result.state;
              await refreshData({ silent: true });
              closeModal();
              toast(`已添加账号：${result.account?.name || result.account?.uid}`);
            } else if (result.status === "failed" || result.status === "expired") {
              finished = true;
              if (timer) clearInterval(timer);
              timer = null;
              const stateBox = $("#loginState");
              if (stateBox) {
                stateBox.className = "login-state bad";
                stateBox.innerHTML = `${icon("alert")}<span>${esc(result.message || "登录失败，请重新发起")}</span>`;
              }
            }
          } catch (error) {
            const stateBox = $("#loginState");
            if (stateBox) {
              stateBox.className = "login-state bad";
              stateBox.innerHTML = `${icon("alert")}<span>${esc(error.message)}</span>`;
            }
          }
        }, 2000);
      },
    });
  } catch (error) {
    setBusy(false);
    toast(error.message, "bad");
  }
}

/* ── Actions ── */
async function runClaim({ provider, accountId } = {}) {
  if (app.busy) return;
  const label = accountId ? "正在领取该账号…" : provider ? `正在领取 ${metaOf(provider).label}…` : "正在领取全部账号…";
  setBusy(true, label);
  try {
    const body = {};
    if (provider) body.provider = provider;
    if (accountId) body.accountIds = [accountId];
    const data = await api("/api/claim", { method: "POST", body });
    app.state = data.state;
    await refreshData({ silent: true });
    const summary = data.result?.summary;
    if (summary?.failed) toast(summary.message || "部分账号领取失败", "warn");
    else toast(summary?.message || "领取完成", "ok");
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    setBusy(false);
    render();
  }
}

async function runStatusRefresh({ provider } = {}) {
  if (app.busy) return;
  setBusy(true, "正在查询官方状态…");
  try {
    const data = await api("/api/status", { method: "POST", body: provider ? { provider } : {} });
    app.state = data.state;
    const results = data.result?.results || [];
    const failed = results.filter((row) => ["failed", "expired"].includes(row.status)).length;
    toast(
      failed ? `已刷新 ${results.length} 个账号，${failed} 个需要处理` : `已刷新 ${results.length} 个账号`,
      failed ? "warn" : "ok",
    );
    await refreshData({ silent: true });
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    setBusy(false);
    render();
  }
}

async function importWorkBuddy() {
  if (app.busy) return;
  setBusy(true, "正在读取 WorkBuddy Switch 账号库…");
  try {
    const data = await api("/api/workbuddy/import", { method: "POST" });
    const result = data.result || {};
    app.state = data.state;
    await refreshData({ silent: true });
    toast(
      `WorkBuddy 导入：新增 ${result.imported || 0} 个，更新 ${result.updated || 0} 个`,
      result.errors?.length ? "warn" : "ok",
    );
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    setBusy(false);
    render();
  }
}

async function runImport() {
  if (app.busy) return;
  setBusy(true, "正在读取本机客户端登录态…");
  try {
    const data = await api("/api/import", { method: "POST" });
    const result = data.result || {};
    app.state = data.state;
    await refreshData({ silent: true });
    const skippedDetail = result.skipped?.map((row) => `${row.provider}: ${row.reason}`).join("；") || "";
    toast(
      `导入完成：新增 ${result.imported || 0} 个，更新 ${result.updated || 0} 个`,
      result.errors?.length || result.skipped?.length ? "warn" : "ok",
      skippedDetail,
    );
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    setBusy(false);
    render();
  }
}

async function switchAccount(id) {
  const account = app.state?.accounts.find((item) => item.id === id);
  if (!account) return;
  if (!account.hasSnapshot) {
    toast("这个账号没有客户端登录快照，无法切换", "warn");
    return;
  }
  const message = `切换会关闭 ${account.providerLabel} 客户端、写入目标账号的登录态并重新启动。当前正在编辑的内容请先保存。<br><br>目标账号：<strong>${esc(account.name)}</strong>`;
  const confirmed = await confirmAction({
    title: `切换到 ${account.name}？`,
    message,
    confirmText: "关闭客户端并切换",
    iconName: "switch",
  });
  if (!confirmed || app.busy) return;
  setBusy(true, "正在关闭客户端并切换登录…");
  try {
    const data = await api("/api/switch", { method: "POST", body: { accountId: id, force: true } });
    app.state = data.state;
    await refreshData({ silent: true });
    toast(data.result?.message || "切换完成", "ok");
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    setBusy(false);
    render();
  }
}

async function removeAccount(id) {
  const account = app.state?.accounts.find((item) => item.id === id);
  if (!account) return;
  const confirmed = await confirmAction({
    title: "移除这个账号？",
    message: `将从本机账号库移除 <strong>${esc(account.name)}</strong> 及其 Trae 登录快照。桌面客户端当前的登录状态不会被改变。`,
    confirmText: "移除账号",
    tone: "bad",
    iconName: "trash",
  });
  if (!confirmed || app.busy) return;
  setBusy(true, "正在移除账号…");
  try {
    const data = await api(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    app.state = data.state;
    await refreshData({ silent: true });
    toast("账号已移除", "ok");
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    setBusy(false);
    render();
  }
}

async function updateConfig(patch, successText) {
  if (app.busy) return;
  setBusy(true, "正在保存设置…");
  try {
    const data = await api("/api/config", { method: "PUT", body: patch });
    app.state = data.state;
    render();
    toast(successText || "设置已保存", "ok");
    if (data.restartRequired) toast("端口修改将在下次启动时生效", "warn");
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    setBusy(false);
    render();
  }
}

async function showDoctor() {
  if (app.busy) return;
  setBusy(true, "正在检查本机环境…");
  try {
    const data = await api("/api/doctor", { method: "POST" });
    const checks = data.result?.checks || [];
    const rows = checks
      .map((check) => {
        const tone = check.ok ? "" : check.optional ? "skip" : "fail";
        return `<div class="doctor-row ${tone}">${icon(check.ok ? "check" : check.optional ? "info" : "alert")}<div><strong>${esc(check.name)}</strong><span>${esc(check.detail)}</span></div></div>`;
      })
      .join("");
    showModal({
      title: "本机诊断",
      subtitle: data.result?.ok ? "所有必需检查均通过" : "发现问题，请按提示处理",
      iconName: data.result?.ok ? "check" : "alert",
      tone: data.result?.ok ? "" : "warn",
      wide: true,
      body: `<div class="doctor-list">${rows}</div>`,
      footer: `<button class="btn" data-close>关闭</button>`,
    });
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    setBusy(false);
  }
}

async function installTask() {
  const confirmed = await confirmAction({
    title: "安装开机自启？",
    message: "会在当前 Windows 用户下注册名为 <strong>AutoSwitch</strong> 的登录时计划任务，静默运行本机服务。以后可在同一位置移除。",
    confirmText: "安装",
    iconName: "power",
  });
  if (!confirmed || app.busy) return;
  setBusy(true, "正在注册计划任务…");
  try {
    const data = await api("/api/task/install", { method: "POST" });
    app.state = data.state;
    await refreshData({ silent: true });
    toast("已安装开机自启", "ok");
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    setBusy(false);
    render();
  }
}

async function uninstallTask() {
  const confirmed = await confirmAction({
    title: "移除开机自启？",
    message: "只会删除计划任务，不会删除账号库或领取记录。",
    confirmText: "移除",
    tone: "bad",
    iconName: "trash",
  });
  if (!confirmed || app.busy) return;
  setBusy(true, "正在移除计划任务…");
  try {
    const data = await api("/api/task/uninstall", { method: "POST" });
    app.state = data.state;
    await refreshData({ silent: true });
    toast("已移除开机自启", "ok");
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    setBusy(false);
    render();
  }
}

/* ── Theme ── */
function applyTheme(mode) {
  const resolved = mode === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;
  const button = $("#themeBtn");
  if (button) button.innerHTML = icon(resolved === "dark" ? "sun" : "moon");
  localStorage.setItem("autoswitch-theme", mode);
}

function initTheme() {
  const saved = localStorage.getItem("autoswitch-theme") || localStorage.getItem("creditpilot-theme");
  applyTheme(saved || "system");
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((localStorage.getItem("autoswitch-theme") || "system") === "system") applyTheme("system");
  });
  $("#themeBtn")?.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;
    applyTheme(current === "dark" ? "light" : "dark");
  });
}

/* ── Routing / events ── */
const ROUTES = new Set(["overview", "records", "settings"]);

// 「账号」页已并入「总览」，旧链接与收藏仍然可用。
function normalizeRoute(route) {
  if (route === "accounts") return "overview";
  return ROUTES.has(route) ? route : "overview";
}

function setRoute(route) {
  route = normalizeRoute(route);
  const target = `#/${route}`;
  if (location.hash === target) {
    app.route = route;
    render();
    return;
  }
  location.hash = target;
}

function bindEvents() {
  $("#nav")?.addEventListener("click", (event) => {
    const button = event.target.closest(".nav-item");
    if (button) setRoute(button.dataset.route);
  });
  window.addEventListener("hashchange", () => {
    const route = normalizeRoute(location.hash.replace(/^#\/?/, ""));
    if (route !== app.route) {
      app.route = route;
      render();
    }
  });
  $("#refreshBtn")?.addEventListener("click", async () => {
    if (app.busy) return;
    $("#refreshBtn").innerHTML = icon("refresh");
    $("#refreshBtn").style.opacity = "0.6";
    await refreshData({ silent: false });
    $("#refreshBtn").style.opacity = "";
  });

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "retry-state") return refreshData();
    if (action === "go-records") return setRoute("records");
    if (action === "go-settings") return setRoute("settings");
    if (action === "claim-all") return runClaim({});
    if (action === "claim-provider") return runClaim({ provider: target.dataset.provider });
    if (action === "claim-account") return runClaim({ accountId: target.dataset.id });
    if (action === "refresh-status") return runStatusRefresh();
    if (action === "refresh-logs") return refreshData({ logs: true });
    if (action === "import") return runImport();
    if (action === "import-workbuddy") return importWorkBuddy();
    if (action === "add-account") return openLoginChooser();
    if (action === "login") return startLogin(target.dataset.provider);
    if (action === "switch-account") return switchAccount(target.dataset.id);
    if (action === "delete-account") return removeAccount(target.dataset.id);
    if (action === "toggle-auto") return updateConfig({ autoClaim: !app.state?.config.autoClaim }, app.state?.config.autoClaim ? "已关闭自动领取" : "已开启自动领取");
    if (action === "save-interval") {
      const value = Number($("#intervalInput")?.value);
      if (!Number.isFinite(value) || value < 15) return toast("检查间隔至少 15 分钟", "warn");
      return updateConfig({ intervalMinutes: Math.round(value) }, "检查间隔已保存");
    }
    if (action === "save-delay") {
      const value = Number($("#delayInput")?.value);
      if (!Number.isFinite(value) || value < 0) return toast("账号间隔不能小于 0", "warn");
      return updateConfig({ claimDelayMs: Math.round(value) }, "账号间隔已保存");
    }
    if (action === "install-task") return installTask();
    if (action === "uninstall-task") return uninstallTask();
    if (action === "doctor") return showDoctor();
    if (action === "check-update") return runUpdateCheck();
    if (action === "create-backup") return openBackupModal();
    if (action === "restore-backup") return openRestoreModal();
    if (action === "filter-type") {
      app.logType = target.dataset.type;
      return render();
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target?.id === "logProvider") {
      app.logProvider = event.target.value;
      render();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("#modalRoot")?.children.length) {
      app.modalClose?.();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
      event.preventDefault();
      if (!app.busy) refreshData();
    }
  });
}

function startPolling() {
  setInterval(() => {
    if (document.hidden || app.busy || $("#modalRoot")?.children.length) return;
    refreshData({ silent: true });
  }, 20_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !app.busy) refreshData({ silent: true });
  });
}

function init() {
  initTheme();
  bindEvents();
  const hash = location.hash.replace(/^#\/?/, "");
  app.route = normalizeRoute(hash);
  refreshData().then((ok) => {
    if (ok) loadCachedUpdate();
    startPolling();
  });
}

init();
