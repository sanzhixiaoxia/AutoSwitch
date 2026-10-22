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

function quotaTotal(accounts) {
  const values = accounts.map((account) => Number(account.quota?.remaining)).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
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

function aggregate(accounts) {
  if (!accounts.length) return { status: "pending", label: "未导入" };
  const statuses = accounts.map((account) => account.today?.status || "pending");
  if (statuses.every(isDone)) return { status: "claimed", label: "今日已完成" };
  if (statuses.some((status) => ["failed", "expired"].includes(status))) return { status: "failed", label: "需要处理" };
  if (statuses.some((status) => status === "claimable")) return { status: "claimable", label: "可领取" };
  if (statuses.some((status) => status === "device-limited")) return { status: "device-limited", label: "本机名额已用" };
  return { status: "pending", label: "待检查" };
}

function render() {
  if (!app.state) return;
  const { accounts, summary, scheduler } = app.state;
  const titles = {
    overview: ["总览", `Qoder 轮次 ${summary.round.qoder} · Trae ${summary.round.trae}`],
    accounts: ["账号", `${accounts.length} 个账号 · 每个平台可保存多个客户端登录`],
    records: ["记录", "领取、切换与系统事件都保存在本机"],
    settings: ["设置", "自动领取、开机自启与数据安全"],
  };
  $("#pageTitle").textContent = titles[app.route][0];
  $("#pageSubtitle").textContent = titles[app.route][1];
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.route === app.route));
  $("#navAccounts").textContent = accounts.length || "";
  $("#versionText").textContent = `v${app.state.app.version}`;
  const projectLink = $("#projectLink");
  if (projectLink) projectLink.href = app.state.app.repoUrl || PROJECT_URL;
  const autoMini = $("#autoMini");
  autoMini.classList.toggle("on", Boolean(scheduler.autoClaim && scheduler.running));
  const autoText = autoMini.querySelector("strong");
  if (autoText) autoText.textContent = !scheduler.autoClaim ? "关闭" : scheduler.running ? "开启" : "未运行";

  const content = $("#content");
  if (app.route === "accounts") content.innerHTML = renderAccounts();
  else if (app.route === "records") content.innerHTML = renderRecords();
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

function renderPlatformCard(provider, accounts) {
  const meta = metaOf(provider);
  const agg = aggregate(accounts);
  const done = accounts.filter((account) => isDone(account.today?.status)).length;
  const quota = quotaTotal(accounts);
  const latest = accounts
    .map((account) => account.today?.at)
    .filter(Boolean)
    .sort()
    .at(-1);
  const primary = accounts.find((account) => account.isActive) || accounts[0];
  const title = accounts.length === 1 ? primary.name : `${meta.label} · ${accounts.length} 个账号`;
  const sub = accounts.length === 1 ? primary.email || primary.phoneHint || primary.uid : "多账号已保存";
  return `<article class="platform-card" style="${providerStyle(provider)}">
    <div class="platform-head">
      <div class="platform-id">
        <div class="platform-logo">${esc(meta.avatar)}</div>
        <div><h3>${esc(title)}</h3><p>${esc(sub)}</p></div>
      </div>
      ${badge(agg.status, agg.label)}
    </div>
    <div class="platform-body">
      <div class="metric-row"><span>今日进度</span><strong>${done} / ${accounts.length}</strong></div>
      <div class="metric-row"><span>剩余额度</span><strong class="big">${quota === null ? "—" : esc(fmtAmount(quota))}</strong></div>
      <div class="metric-row"><span>最近领取</span><strong>${latest ? esc(fmtShort(latest)) : "—"}</strong></div>
      <div class="platform-actions">
        ${
          accounts.length
            ? `<button class="btn small primary" data-action="claim-provider" data-provider="${esc(provider)}" ${app.busy ? "disabled" : ""}>${icon("play")}领取</button>
               <button class="btn small" data-action="go-accounts">管理</button>`
            : `<button class="btn small" data-action="import">${icon("download")}导入</button>
               <button class="btn small" data-action="add-account">${icon("plus")}添加</button>`
        }
      </div>
    </div>
  </article>`;
}

function renderOverview() {
  const { accounts } = app.state;
  const grouped = Object.fromEntries(Object.keys(PROVIDER_META).map((provider) => [provider, []]));
  for (const account of accounts) (grouped[account.provider] ||= []).push(account);
  const recent = app.logs.filter((entry) => entry.type === "claim").slice(0, 6);
  const roundRows = accounts
    .slice()
    .sort((a, b) => (STATUS[a.today?.status] ? 0 : 1) - (STATUS[b.today?.status] ? 0 : 1))
    .map((account) => {
      const status = account.today?.status || "pending";
      const tone = isDone(status) ? "" : status === "failed" || status === "expired" ? "bad" : status === "pending" ? "idle" : "warn";
      return `<div class="feed-row">
        <span class="feed-dot ${tone}"></span>
        <div class="feed-copy"><strong>${esc(account.name)}</strong><span>${esc(account.providerLabel)} · ${esc(STATUS[status]?.label || status)}${account.today?.message ? ` · ${esc(account.today.message)}` : ""}</span></div>
        <span class="feed-time">${account.today?.amount ? `+${esc(fmtAmount(account.today.amount))}` : ""}</span>
      </div>`;
    })
    .join("");
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

  return `${renderHero(accounts)}
    <div class="platform-grid">
      ${Object.keys(PROVIDER_META).map((provider) => renderPlatformCard(provider, grouped[provider] || [])).join("")}
    </div>
    <div class="section-title">
      <div><h2>本轮与最近记录</h2><p>状态按官方接口查询结果和本应用领取记录汇总</p></div>
      <button class="btn small ghost" data-action="go-records">查看全部${icon("chevron")}</button>
    </div>
    <div class="lower-grid">
      <section class="panel">
        <div class="panel-head"><div class="panel-title">${icon("list")}<h2>最近领取</h2></div><span class="tiny faint">${recent.length} 条</span></div>
        <div class="feed">${feed}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><div class="panel-title">${icon("users")}<h2>本轮账号</h2></div><span class="tiny faint">${app.state.summary.done}/${app.state.summary.total}</span></div>
        <div class="feed">${roundRows || `<div class="feed-row"><span class="feed-dot idle"></span><div class="feed-copy"><strong>暂无账号</strong><span>先导入本机客户端账号。</span></div></div>`}</div>
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

function renderAccountCard(account) {
  const meta = metaOf(account.provider);
  const expiry = expiryInfo(account);
  const status = account.today?.status || "pending";
  const tags = [
    account.isActive ? `<span class="tag active">当前登录</span>` : "",
    `<span class="tag">${account.source === "device" ? "浏览器登录" : "客户端导入"}</span>`,
    account.hasSnapshot ? (account.isActive ? "" : `<span class="tag">可切换</span>`) : `<span class="tag">无切号快照</span>`,
    account.expired ? `<span class="tag" style="color:var(--red);border-color:var(--red)">凭据过期</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  return `<div class="account-card" style="${providerStyle(account.provider)}">
    <div class="account-main">
      <div class="account-avatar">${esc(meta.avatar)}</div>
      <div class="account-title">
        <strong>${esc(account.name)}</strong>
        <span>${esc(account.uid)}</span>
        <div class="account-tags">${tags}</div>
      </div>
    </div>
    <div class="account-meta">
      <div><span>本轮状态</span><strong>${badge(status)}</strong></div>
      <div><span>剩余额度</span><strong>${account.quota?.remaining !== undefined ? esc(fmtAmount(account.quota.remaining)) : "—"}</strong></div>
      <div><span>凭据到期</span><strong class="${expiry.cls}">${esc(expiry.text)}</strong></div>
      <div><span>最近领取</span><strong>${account.today?.at ? esc(fmtShort(account.today.at)) : "—"}</strong></div>
    </div>
    <div class="account-actions">
      <button class="btn small primary" data-action="claim-account" data-id="${esc(account.id)}" ${app.busy ? "disabled" : ""}>${icon("play")}领取</button>
      <button class="btn small" data-action="switch-account" data-id="${esc(account.id)}" ${!account.hasSnapshot || account.isActive || app.busy ? "disabled" : ""} title="${account.isActive ? "已经是当前登录账号" : account.hasSnapshot ? "关闭并重启客户端以切换登录" : "浏览器登录的账号没有客户端快照"}">${icon("switch")}切换</button>
      <button class="btn small danger icon-only" data-action="delete-account" data-id="${esc(account.id)}" title="移除账号" ${app.busy ? "disabled" : ""}>${icon("trash")}</button>
    </div>
  </div>`;
}

function renderAccounts() {
  const { accounts, clients } = app.state;
  const grouped = Object.fromEntries(Object.keys(PROVIDER_META).map((provider) => [provider, []]));
  for (const account of accounts) (grouped[account.provider] ||= []).push(account);
  const blocks = Object.keys(PROVIDER_META)
    .map((provider) => {
      const meta = metaOf(provider);
      const list = grouped[provider] || [];
      const client = clients.find((row) => row.provider === provider);
      const clientText = client
        ? client.installed
          ? `客户端${client.running ? "运行中" : "未运行"}${client.signedIn ? " · 已登录" : " · 未登录"}`
          : "未安装客户端"
        : "";
      return `<section class="provider-block" style="${providerStyle(provider)}">
        <div class="provider-block-head"><span class="swatch"></span>${esc(meta.label)}<em>${esc(clientText)}${list.length ? ` · ${list.length} 个账号` : ""}</em></div>
        ${
          list.length
            ? list.map(renderAccountCard).join("")
            : `<div class="empty" style="min-height:120px;align-items:flex-start;text-align:left;padding:18px">
                <div class="empty-icon" style="width:40px;height:40px;border-radius:12px">${icon("users")}</div>
                <div><h3>${esc(meta.label)} 还没有账号</h3><p>在客户端登录后导入${provider === "trae" ? "。" : "，或使用浏览器登录 Qoder。"}</p></div>
                <div class="actions">
                  <button class="btn small" data-action="import">${icon("download")}导入本机</button>
                  ${provider === "trae" ? "" : `<button class="btn small" data-action="login" data-provider="${esc(provider)}">${icon("plus")}浏览器登录</button>`}
                </div>
              </div>`
        }
      </section>`;
    })
    .join("");

  return `<div class="page-actions">
      <div class="left">
        <button class="btn primary" data-action="import" ${app.busy ? "disabled" : ""}>${icon("download")}导入本机账号</button>
        <button class="btn" data-action="add-account" ${app.busy ? "disabled" : ""}>${icon("plus")}添加账号</button>
        <button class="btn" data-action="refresh-status" ${!accounts.length || app.busy ? "disabled" : ""}>${icon("refresh")}刷新状态</button>
      </div>
      <div class="right"><span class="tiny faint">账号凭据只保存在本机，界面不会显示 token</span></div>
    </div>
    ${blocks}
    <div class="info-box" style="margin-top:16px">${icon("info")}<div><strong>多账号说明</strong><br />领取通过官方接口使用已保存的 token 完成，不需要切换客户端；「切换」只用于把桌面客户端登录换成该账号。Qoder 多账号可以直接用「浏览器登录」添加；Trae 多账号需要先在客户端登录另一个账号并导入，再使用切换。浏览器登录的 Qoder 账号没有客户端快照，不能切换。Qoder 国际版每台设备每天只能领取一个账号，其余账号会显示「本机名额已用」。Trae 切换需要重启客户端，应用会先保存当前登录再写入目标账号。</div></div>`;
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

function renderUpdateCard(info) {
  const update = app.update;
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

    ${renderUpdateCard(info)}

    <section class="setting-card">
      <div class="panel-head"><div class="panel-title">${icon("gift")}<h2>领取规则</h2></div><span class="tiny faint">官方活动</span></div>
      <div class="panel-body">
        <div class="kv-list">
          <div class="kv"><span>Qoder / Qoder CN</span><strong>每天 10:00（UTC+8）刷新，100 Credits</strong></div>
          <div class="kv"><span>Trae CN</span><strong>每日签到，积分以接口返回为准</strong></div>
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
  showModal({
    title: "添加 Qoder 账号",
    subtitle: "浏览器设备码登录会生成独立 token，不改变桌面客户端当前登录。",
    iconName: "plus",
    body: `<div class="feed">
      <button class="feed-row" style="border:0;background:transparent;cursor:pointer;width:100%;text-align:left" data-login-provider="qoder">
        <span class="feed-dot" style="background:#7c5cff"></span>
        <div class="feed-copy"><strong>Qoder 国际版</strong><span>qoder.com · 每台设备每天限领一个国际版账号</span></div>
        ${icon("chevron")}
      </button>
      <button class="feed-row" style="border:0;background:transparent;cursor:pointer;width:100%;text-align:left" data-login-provider="qoder-cn">
        <span class="feed-dot" style="background:#0f9d76"></span>
        <div class="feed-copy"><strong>Qoder 国内版</strong><span>qoder.cn · 不受国际版设备名额限制</span></div>
        ${icon("chevron")}
      </button>
    </div>
    <div class="info-box" style="margin-top:12px">${icon("info")}<div>浏览器登录 token 约 30 天有效，过期后重新登录即可。也可以直接在客户端登录后使用「导入本机账号」。</div></div>`,
    onMount: (modal, closeModal) => {
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

async function runImport() {
  if (app.busy) return;
  setBusy(true, "正在读取本机客户端登录态…");
  try {
    const data = await api("/api/import", { method: "POST" });
    const result = data.result || {};
    app.state = data.state;
    await refreshData({ silent: true });
    const skipped = result.skipped?.length ? `，跳过 ${result.skipped.length} 个未登录客户端` : "";
    toast(`导入完成：新增 ${result.imported || 0} 个，更新 ${result.updated || 0} 个${skipped}`, result.errors?.length ? "warn" : "ok");
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
function setRoute(route) {
  if (!["overview", "accounts", "records", "settings"].includes(route)) route = "overview";
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
    const route = location.hash.replace(/^#\/?/, "");
    if (["overview", "accounts", "records", "settings"].includes(route) && route !== app.route) {
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
    if (action === "go-accounts") return setRoute("accounts");
    if (action === "go-records") return setRoute("records");
    if (action === "go-settings") return setRoute("settings");
    if (action === "claim-all") return runClaim({});
    if (action === "claim-provider") return runClaim({ provider: target.dataset.provider });
    if (action === "claim-account") return runClaim({ accountId: target.dataset.id });
    if (action === "refresh-status") return runStatusRefresh();
    if (action === "refresh-logs") return refreshData({ logs: true });
    if (action === "import") return runImport();
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
  app.route = ["overview", "accounts", "records", "settings"].includes(hash) ? hash : "overview";
  refreshData().then((ok) => {
    if (ok) loadCachedUpdate();
    startPolling();
  });
}

init();
