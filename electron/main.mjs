import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, Tray, shell, nativeImage, dialog } from "electron";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const FALLBACK_PORT = 47871;

let mainWindow = null;
let tray = null;
let daemonSpawned = false;
let quitting = false;

// 面板永远是本机回环地址：Chromium 默认继承系统代理，代理在场时连 127.0.0.1 都会被转走。
app.commandLine.appendSwitch("no-proxy-server");

const HOME =
  process.env.AUTOSWITCH_HOME ||
  (process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "AutoSwitch")
    : path.join(app.getPath("home"), ".autoswitch"));

// Electron 自己的缓存/崩溃数据也放进 AutoSwitch 数据目录，别在 Roaming 下另起一个目录。
app.setPath("userData", path.join(HOME, "electron"));

function panelUrl() {
  return `http://127.0.0.1:${port()}`;
}

function fail(title, message) {
  console.error(`[AutoSwitch] ${title}: ${message}`);
  dialog.showErrorBox(title, message);
}

function port() {
  try {
    const value = Number(JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8")).port);
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  } catch {}
  return FALLBACK_PORT;
}

async function isHealthy(timeoutMs) {
  try {
    const response = await fetch(`${panelUrl()}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    return (await response.json()).app === "autoswitch";
  } catch {
    return false;
  }
}

function nodeRuntime() {
  const candidates = [
    process.env.AUTOSWITCH_NODE,
    path.join(APP_ROOT, "node.exe"),
    path.resolve(APP_ROOT, "..", "..", "node.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return { exe: candidate, args: [] };
  return { exe: process.execPath, args: [], runAsNode: true };
}

async function ensureDaemon() {
  if (await isHealthy(1500)) return true;
  const entry = path.join(APP_ROOT, "bin", "autoswitch.mjs");
  if (!fs.existsSync(entry)) {
    fail("AutoSwitch 启动失败", `找不到服务入口：\n${entry}`);
    return false;
  }
  const runtime = nodeRuntime();
  const child = spawn(runtime.exe, [...runtime.args, entry, "start", "--no-open"], {
    cwd: APP_ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: runtime.runAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env,
  });
  child.unref();
  daemonSpawned = true;
  for (let i = 0; i < 40; i++) {
    if (await isHealthy(1200)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function isInternal(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === String(port());
  } catch {
    return false;
  }
}

function createWindow() {
  const icon = path.join(APP_ROOT, "assets", "icon.ico");
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: "AutoSwitch",
    backgroundColor: "#f4f6f9",
    autoHideMenuBar: true,
    icon: fs.existsSync(icon) ? icon : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden")) mainWindow.show();
  });
  mainWindow.on("close", (event) => {
    if (!quitting && tray && !tray.isDestroyed()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isInternal(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    fail("AutoSwitch 界面已停止", `渲染进程退出（${details.reason}），请重新打开窗口。`);
  });

  mainWindow.loadURL(panelUrl());
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function appIcon() {
  const icon = path.join(APP_ROOT, "assets", "icon.ico");
  return fs.existsSync(icon) ? nativeImage.createFromPath(icon) : nativeImage.createEmpty();
}

function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip("AutoSwitch · 每日积分领航");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 AutoSwitch", click: showWindow },
      { label: "用浏览器打开面板", click: () => shell.openExternal(panelUrl()) },
      { type: "separator" },
      {
        label: "退出 AutoSwitch",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
}

function applyMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "窗口",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "minimize" },
          { role: "close" },
        ],
      },
    ]),
  );
}

async function bootstrap() {
  applyMenu();
  createTray();
  if (!(await ensureDaemon())) {
    fail(
      "AutoSwitch 无法连接本地服务",
      `已尝试启动后台服务，但 ${panelUrl()} 没有响应。\n可以在命令行运行 “node bin\\autoswitch.mjs start” 查看具体报错。`,
    );
    app.quit();
    return;
  }
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });
  app.whenReady().then(bootstrap);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) showWindow();
  });
  app.on("window-all-closed", () => {
    if (!tray || tray.isDestroyed()) app.quit();
  });
  app.on("before-quit", () => {
    quitting = true;
    if (tray && !tray.isDestroyed()) tray.destroy();
  });
}
