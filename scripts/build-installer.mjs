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
const PORTABLE_ROOT = path.join(DIST, "portable");
const PORTABLE_DIR = path.join(PORTABLE_ROOT, "AutoSwitch");
const PORTABLE_ZIP = path.join(DIST, `AutoSwitch-Portable-${VERSION}.zip`);
const ICON_ICO = path.join(ROOT, "assets", "icon.ico");

const rm = (target) => fs.rmSync(target, { recursive: true, force: true });
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

function zipDirectoryContents(sourceDir, destinationZip) {
  rm(destinationZip);
  const ps =
    `Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' ` +
    `-DestinationPath '${destinationZip.replace(/'/g, "''")}' -Force`;
  runPowerShell(ps, "创建 ZIP");
  if (!fs.existsSync(destinationZip)) throw new Error("ZIP 未生成");
}

function zipFolder(sourceDir, destinationZip) {
  rm(destinationZip);
  const ps =
    `Compress-Archive -LiteralPath '${sourceDir.replace(/'/g, "''")}' ` +
    `-DestinationPath '${destinationZip.replace(/'/g, "''")}' -Force`;
  runPowerShell(ps, "创建便携版 ZIP");
  if (!fs.existsSync(destinationZip)) throw new Error("便携版 ZIP 未生成");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function buildStage() {
  rm(STAGE);
  mkdir(APP_STAGE);

  for (const directory of ["bin", "src", "public", "docs"]) {
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

function buildSetup(stage) {
  rm(SETUP);
  const files = [
    "node.exe",
    "node-LICENSE.txt",
    "app.zip",
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
  rm(PORTABLE_ROOT);
  mkdir(path.join(PORTABLE_DIR, "app"));
  fs.copyFileSync(path.join(stage, "node.exe"), path.join(PORTABLE_DIR, "node.exe"));
  fs.copyFileSync(path.join(stage, "node-LICENSE.txt"), path.join(PORTABLE_DIR, "node-LICENSE.txt"));
  if (fs.existsSync(ICON_ICO)) fs.copyFileSync(ICON_ICO, path.join(PORTABLE_DIR, "AutoSwitch.ico"));
  copy(path.join(stage, "app"), path.join(PORTABLE_DIR, "app"));
  fs.copyFileSync(path.join(ROOT, "installer", "portable-start.vbs"), path.join(PORTABLE_DIR, "Start AutoSwitch.vbs"));
  fs.copyFileSync(path.join(ROOT, "installer", "portable-start.cmd"), path.join(PORTABLE_DIR, "Start AutoSwitch.cmd"));
  fs.copyFileSync(path.join(ROOT, "installer", "portable-stop.cmd"), path.join(PORTABLE_DIR, "Stop AutoSwitch.cmd"));
  fs.copyFileSync(path.join(ROOT, "installer", "portable-README.txt"), path.join(PORTABLE_DIR, "README.txt"));
  zipFolder(PORTABLE_DIR, PORTABLE_ZIP);
  return PORTABLE_ZIP;
}

function main() {
  if (process.platform !== "win32") throw new Error("安装包只能在 Windows 上构建");
  mkdir(DIST);
  console.log(`构建 AutoSwitch ${VERSION} ...`);
  const stage = buildStage();
  console.log("1/3 应用文件与 Node 运行时已准备");
  const setup = buildSetup(stage);
  console.log(`2/3 安装包：${setup}`);
  const portable = buildPortable(stage);
  console.log(`3/3 便携版：${portable}`);

  const artifacts = [setup, portable].map((file) => {
    const hash = sha256(file);
    fs.writeFileSync(`${file}.sha256`, `${hash}  ${path.basename(file)}\n`, "utf8");
    return { file, size: fs.statSync(file).size, sha256: hash };
  });
  console.log(JSON.stringify({ version: VERSION, artifacts }, null, 2));
}

main();
