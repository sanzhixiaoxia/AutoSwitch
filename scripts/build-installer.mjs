import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = PKG.version;
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "stage");
const APP_STAGE = path.join(STAGE, "app");
const SETUP = path.join(DIST, `AutoSwitch-Setup-${VERSION}.exe`);
const PORTABLE_ZIP = path.join(DIST, `AutoSwitch-Portable-${VERSION}.zip`);
const ICON_ICO = path.join(ROOT, "assets", "icon.ico");
const ELECTRON_DIST = path.join(ROOT, "node_modules", "electron", "dist");
const ELECTRON_ZIP = path.join(STAGE, "electron.zip");

// 刚复制出来的 Electron 大文件常被实时扫描占用，删除会 EPERM/EBUSY，重试即可。
function rm(target) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!fs.existsSync(target)) return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
    }
    spawnSync("ping", ["-n", "3", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
  }
  throw new Error(`无法删除旧构建产物：${target}`);
}
const mkdir = (target) => fs.mkdirSync(target, { recursive: true });
const copy = (source, destination) => {
  if (!fs.existsSync(source)) return false;
  fs.cpSync(source, destination, { recursive: true, force: true });
  return true;
};

function runPowerShell(script, label) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw new Error(`${label} 调用失败：${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${label} 失败${detail ? `：${detail.slice(0, 500)}` : `（退出码 ${result.status}）`}`);
  }
  return String(result.stdout || "").trim();
}

function walkFiles(root, { prefix = "", rename = {} } = {}) {
  const base = path.resolve(root);
  const entries = [];
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) {
        stack.push(abs);
        continue;
      }
      let rel = path.relative(base, abs).split(path.sep).join("/");
      rel = rename[rel] ?? rel;
      entries.push({ abs, name: prefix ? `${prefix}/${rel}` : rel });
    }
  }
  return entries;
}

// 按清单逐项写入 ZIP：不需要先把 350MB 运行时复制到中转目录，
// 也避开 Compress-Archive 在大目录上「退出 0 却不产出 zip」的坑。
function buildZip(destinationZip, entries, label = "创建 ZIP") {
  if (fs.existsSync(destinationZip)) rm(destinationZip);
  const manifest = path.join(DIST, `zip-manifest-${path.basename(destinationZip)}.json`);
  fs.writeFileSync(manifest, JSON.stringify(entries.map((entry) => [entry.abs, entry.name])), "utf8");
  const quote = (value) => value.replace(/'/g, "''");
  const script =
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.IO.Compression;" +
    "Add-Type -AssemblyName System.IO.Compression.FileSystem;" +
    `$items = Get-Content -Raw -LiteralPath '${quote(manifest)}' | ConvertFrom-Json;` +
    `$zip = [System.IO.Compression.ZipFile]::Open('${quote(destinationZip)}', [System.IO.Compression.ZipArchiveMode]::Create);` +
    "try { foreach ($item in $items) {" +
    "[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $item[0], $item[1], " +
    "[System.IO.Compression.CompressionLevel]::Optimal) | Out-Null } } finally { $zip.Dispose() };" +
    "Write-Output 'ok'";
  try {
    runPowerShell(script, label);
  } finally {
    fs.rmSync(manifest, { force: true });
  }
  if (!fs.existsSync(destinationZip)) throw new Error(`${label}：没有产出 ${path.basename(destinationZip)}`);
}

function zipDirectoryContents(sourceDir, destinationZip) {
  buildZip(destinationZip, walkFiles(sourceDir));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function buildStage() {
  rm(STAGE);
  mkdir(APP_STAGE);

  for (const directory of ["bin", "src", "public", "docs", "electron", "assets"]) {
    const source = path.join(ROOT, directory);
    if (!copy(source, path.join(APP_STAGE, directory))) throw new Error(`缺少目录：${directory}`);
  }
  for (const file of ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    const source = path.join(ROOT, file);
    if (!fs.existsSync(source)) throw new Error(`缺少文件：${file}`);
    fs.copyFileSync(source, path.join(APP_STAGE, file));
  }

  const nodeExe = process.execPath;
  if (path.basename(nodeExe).toLowerCase() !== "node.exe") {
    throw new Error(`当前进程不是 Node.js（${nodeExe}），无法打包内置运行时`);
  }
  fs.copyFileSync(nodeExe, path.join(STAGE, "node.exe"));
  const nodeLicense = path.join(path.dirname(nodeExe), "LICENSE");
  const bundledLicense = path.join(ROOT, "installer", "node-LICENSE.txt");
  if (fs.existsSync(nodeLicense)) {
    fs.copyFileSync(nodeLicense, path.join(STAGE, "node-LICENSE.txt"));
  } else if (fs.existsSync(bundledLicense)) {
    fs.copyFileSync(bundledLicense, path.join(STAGE, "node-LICENSE.txt"));
  } else {
    fs.writeFileSync(
      path.join(STAGE, "node-LICENSE.txt"),
      "Node.js is distributed under the MIT license. See https://github.com/nodejs/node/blob/main/LICENSE for the bundled version's license.\r\n",
    );
  }
  if (fs.existsSync(ICON_ICO)) fs.copyFileSync(ICON_ICO, path.join(STAGE, "AutoSwitch.ico"));

  zipDirectoryContents(APP_STAGE, path.join(STAGE, "app.zip"));

  for (const file of ["install.ps1", "install.cmd", "uninstall.ps1", "README.txt"]) {
    fs.copyFileSync(path.join(ROOT, "installer", file), path.join(STAGE, file));
  }
  return STAGE;
}

function ensureElectronRuntime() {
  const exe = path.join(ELECTRON_DIST, "electron.exe");
  if (fs.existsSync(exe)) return;
  // electron@45 没有 postinstall：二进制由 require('electron') 懒下载，构建时自己补齐。
  const installer = path.join(ROOT, "node_modules", "electron", "install.js");
  if (!fs.existsSync(installer)) {
    throw new Error(`缺少 Electron 运行时与安装脚本：${exe}\n请先 npm install。`);
  }
  console.log("  Electron 运行时未下载，执行 node_modules/electron/install.js ...");
  const result = spawnSync(process.execPath, [installer], { cwd: ROOT, stdio: "inherit", windowsHide: true, timeout: 1_800_000 });
  if (result.status !== 0 || !fs.existsSync(exe)) {
    throw new Error(
      `Electron 运行时下载失败：${exe}\n` +
        "代理环境下可用 curl 取官方 zip、按 node_modules/electron/checksums.json 校验后解压到 node_modules/electron/dist。",
    );
  }
}

function buildElectronZip(stage) {
  ensureElectronRuntime();
  const entries = [
    ...walkFiles(ELECTRON_DIST, { rename: { "electron.exe": "AutoSwitch.exe" } }),
    ...walkFiles(path.join(stage, "app"), { prefix: "resources/app" }),
  ];
  buildZip(ELECTRON_ZIP, entries, "打包 Electron 运行时");
  return ELECTRON_ZIP;
}

function buildSetup(stage) {
  rm(SETUP);
  const files = [
    "node.exe",
    "node-LICENSE.txt",
    "app.zip",
    "electron.zip",
    "install.cmd",
    "install.ps1",
    "uninstall.ps1",
    "README.txt",
  ];
  if (fs.existsSync(ICON_ICO)) files.push("AutoSwitch.ico");

  const strings = files.map((file, index) => `FILE${index}="${file}"`).join("\r\n");
  const sourceEntries = files.map((_, index) => `%FILE${index}%=`).join("\r\n");
  const sed = [
    "[Version]",
    "Class=IEXPRESS",
    "SEDVersion=3",
    "[Options]",
    "PackagePurpose=InstallApp",
    "ShowInstallProgramWindow=1",
    "HideExtractAnimation=0",
    "UseLongFileName=1",
    "InsideCompressed=0",
    "CAB_FixedSize=0",
    "CAB_ResvCodeSigning=0",
    "RebootMode=N",
    "InstallPrompt=",
    "DisplayLicense=",
    "FinishMessage=AutoSwitch has been installed. Desktop shortcut, logon auto-start and app launch are enabled by default. Panel: http://127.0.0.1:47871",
    `TargetName=${SETUP}`,
    "FriendlyName=AutoSwitch Setup",
    "AppLaunched=install.cmd",
    "PostInstallCmd=<None>",
    "AdminQuietInstCmd=",
    "UserQuietInstCmd=",
    "SourceFiles=SourceFiles",
    "[Strings]",
    strings,
    "[SourceFiles]",
    `SourceFiles0=${stage}\\`,
    "[SourceFiles0]",
    sourceEntries,
    "",
  ].join("\r\n");

  const sedFile = path.join(stage, "setup.sed");
  fs.writeFileSync(sedFile, sed, "latin1");

  const iexpress = path.join(process.env.WINDIR || "C:\\Windows", "System32", "iexpress.exe");
  const result = spawnSync(iexpress, ["/N", "/Q", sedFile], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`IExpress 调用失败：${result.error.message}`);
  if (!fs.existsSync(SETUP)) {
    throw new Error(`IExpress 未生成安装包：${String(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  return SETUP;
}

function buildPortable(stage) {
  ensureElectronRuntime();
  const single = (abs, name) => ({ abs, name });
  const appEntries = walkFiles(path.join(stage, "app"));
  const entries = [
    ...walkFiles(ELECTRON_DIST, { prefix: "AutoSwitch", rename: { "electron.exe": "AutoSwitch.exe" } }),
    ...appEntries.map((entry) => single(entry.abs, `AutoSwitch/resources/app/${entry.name}`)),
    ...appEntries.map((entry) => single(entry.abs, `AutoSwitch/app/${entry.name}`)),
    single(path.join(stage, "node.exe"), "AutoSwitch/node.exe"),
    single(path.join(stage, "node-LICENSE.txt"), "AutoSwitch/node-LICENSE.txt"),
    single(path.join(ROOT, "installer", "portable-start.vbs"), "AutoSwitch/Start AutoSwitch.vbs"),
    single(path.join(ROOT, "installer", "portable-start.cmd"), "AutoSwitch/Start AutoSwitch.cmd"),
    single(path.join(ROOT, "installer", "portable-stop.cmd"), "AutoSwitch/Stop AutoSwitch.cmd"),
    single(path.join(ROOT, "installer", "portable-README.txt"), "AutoSwitch/README.txt"),
  ];
  if (fs.existsSync(ICON_ICO)) entries.push(single(ICON_ICO, "AutoSwitch/AutoSwitch.ico"));
  buildZip(PORTABLE_ZIP, entries, "打包便携版");
  return PORTABLE_ZIP;
}

function main() {
  if (process.platform !== "win32") throw new Error("安装包只能在 Windows 上构建");
  const mb = (file) => (fs.statSync(file).size / 1048576).toFixed(1);
  mkdir(DIST);
  console.log(`构建 AutoSwitch ${VERSION} ...`);
  const stage = buildStage();
  console.log("1/4 应用文件与 Node 运行时已准备");
  buildElectronZip(stage);
  console.log(`2/4 Electron 窗口运行时：electron.zip ${mb(ELECTRON_ZIP)} MB`);
  const setup = buildSetup(stage);
  console.log(`3/4 安装包：${setup} ${mb(SETUP)} MB`);
  const portable = buildPortable(stage);
  console.log(`4/4 便携版：${portable} ${mb(PORTABLE_ZIP)} MB`);

  const artifacts = [setup, portable].map((file) => {
    const hash = sha256(file);
    fs.writeFileSync(`${file}.sha256`, `${hash}  ${path.basename(file)}\n`, "utf8");
    return { file, size: fs.statSync(file).size, sha256: hash };
  });
  console.log(JSON.stringify({ version: VERSION, artifacts }, null, 2));
}

main();
