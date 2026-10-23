# AutoSwitch

**Trae CN / WorkBuddy / Qoder / Qoder CN 每日积分自动领取。** 本机 Node 守护进程 + Electron 桌面窗口，多账号、加密存储、可切换客户端登录。

> 仓库：<https://github.com/sanzhixiaoxia/AutoSwitch> · 原名 CreditPilot

[![Windows Build](https://github.com/sanzhixiaoxia/AutoSwitch/actions/workflows/windows-build.yml/badge.svg)](https://github.com/sanzhixiaoxia/AutoSwitch/actions/workflows/windows-build.yml)
[![GitHub release](https://img.shields.io/github/v/release/sanzhixiaoxia/AutoSwitch?label=release)](https://github.com/sanzhixiaoxia/AutoSwitch/releases/latest)

> 领取服务只用 Node 内置模块，运行时零 npm 依赖；界面壳是 Electron，只在构建时作为 devDependency 出现。装完就是一个 `AutoSwitch.exe` 窗口 + 一个后台服务，同一套界面也可以用浏览器打开。所有账号凭据留在本机，不上传。

---

## 功能

| | |
| --- | --- |
| **四平台领取** | Trae CN、WorkBuddy 每日签到，Qoder 国内版 / 国际版每日 100 Credits |
| **多账号** | 每个平台可保存多个账号；领取直接走官方接口，不需要来回切客户端 |
| **自动任务** | 默认开启，每 120 分钟检查一次；先查官方状态，只领没领的，幂等安全 |
| **客户端切换** | 可选把 Trae / Qoder 客户端登录切到任意已保存账号，切前自动保存当前登录 |
| **浏览器登录** | Qoder / Qoder CN 支持设备码登录，生成独立账号，不改变客户端当前登录 |
| **桌面窗口** | Electron 窗口 + 系统托盘，关窗只是收进后台、领取继续；同一界面也能用浏览器打开 |
| **本地面板** | 总览、账号、记录、设置；总览按平台一行一个，列出今日进度、剩余额度、最近领取与状态；浅色/深色 |
| **开机自启** | 安装版默认注册 Windows 登录时计划任务，静默启动后台服务；也可一条命令安装/移除 |
| **安全存储** | Windows DPAPI 保护密钥 + AES-256-GCM 加密账号库；网页接口不返回 token |
| **项目与更新** | 界面内置 GitHub 项目入口；从 GitHub Releases 检查更新，显示新版本与安装包下载 |
| **备份与导出** | 密码加密的账号/设置备份与恢复；导出账号清单 JSON、领取记录 CSV（不含 token） |

---

## 环境要求

- Windows 10 / 11（当前版本依赖 Windows DPAPI、客户端的 Electron `safeStorage`）
- Node.js **22.16+**
> 从旧版 CreditPilot 升级：首次运行 AutoSwitch 时，如果 `%LOCALAPPDATA%\AutoSwitch` 不存在，会自动把 `%LOCALAPPDATA%\CreditPilot` 复制到新目录，旧目录保留。安装版会停止旧进程并清理旧的开始菜单和计划任务；旧程序目录可用旧卸载器移除。

- 已安装并登录对应客户端：
  - Trae CN（`TRAE SOLO CN` 等变体）
  - Qoder 国际版（`Qoder`）
  - Qoder 国内版（`Qoder CN`）
  - WorkBuddy（账号从已登录的 WorkBuddy Switch 本机账号库导入；WorkBuddy 客户端自身的 token 是加密封装，不直接读取）

---

## 快速开始

```bash
git clone https://github.com/sanzhixiaoxia/AutoSwitch.git
cd AutoSwitch

# 无需 npm install，直接运行
node bin/autoswitch.mjs start
```

浏览器打开 <http://127.0.0.1:47871>，点击 **导入本机账号**。三个客户端都登录过的话，会一次导入三个账号。

也可以链接成全局命令：

```bash
npm link
autoswitch start
```

首次启动默认开启自动领取，6 秒后检查一次；已经领过的账号只会记录「已领取」，不会重复领。

### 安装开机自启

安装版已经在安装时注册好，需要手动管理时用：

```bash
autoswitch task install
```

会在当前 Windows 用户下注册名为 `AutoSwitch` 的登录时计划任务，用 `wscript.exe` 静默拉起 Node 守护进程。移除：

```bash
autoswitch task uninstall
```

---

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `autoswitch start [--port 47871] [--no-open]` | 启动守护进程和网页面板 |
| `autoswitch stop` | 停止本机服务（开机自启仍保留，下次登录会再启动） |
| `autoswitch import` | 导入本机客户端当前登录的账号 |
| `autoswitch status` | 只查询官方状态，不领取 |
| `autoswitch claim` | 立即领取全部账号 |
| `autoswitch claim --provider qoder-cn` | 只领取某个平台 |
| `autoswitch claim --account "qoder:<uid>"` | 只领取某个账号 |
| `autoswitch accounts` | 列出已保存账号与当前登录标记 |
| `autoswitch switch "<账号ID>" --force` | 关闭客户端、切换登录、重新启动 |
| `autoswitch login qoder` / `qoder-cn` | 浏览器设备码登录，添加独立账号 |
| `autoswitch doctor [--network]` | 检查客户端、凭据、风控与接口 |
| `autoswitch logs --limit 100` | 查看领取记录 |
| `autoswitch config set intervalMinutes 120` | 修改检查间隔 |
| `autoswitch task install` / `uninstall` / `status` | 开机自启管理 |
| `autoswitch backup <file> --password <p>` | 创建密码加密备份 |
| `autoswitch restore <file> --password <p> --yes` | 恢复备份（需先停止服务） |
| `autoswitch export accounts --out <file>` | 导出账号清单 JSON |
| `autoswitch export claims --out <file>` | 导出领取记录 CSV |

加 `--json` 可获得机器可读输出（`claim` / `status` / `import` / `accounts` / `doctor` / `logs`）。

---

## 打包与安装（Windows）

```bash
npm install    # 拉取构建期依赖 Electron（会下载 Electron 运行时）
npm run dist
```

产物在 `dist/`：

| 文件 | 说明 |
| --- | --- |
| `AutoSwitch-Setup-<version>.exe` | 安装版，内置 Node.js 与 Electron 运行时（体积因此从 ~27MB 涨到 ~200MB），按当前用户安装到 `%LOCALAPPDATA%\Programs\AutoSwitch`，不需要管理员权限 |
| `AutoSwitch-Portable-<version>.zip` | 便携版，解压后双击 `AutoSwitch.exe`（后台服务没跑时窗口会自动拉起），数据目录与安装版共用 |
| `*.sha256` | 对应产物的 SHA-256 |

安装版默认三件事：创建**桌面**和开始菜单快捷方式（指向 `AutoSwitch.exe`）、注册当前用户登录时静默启动后台服务的**开机自启计划任务**、安装结束**立即打开窗口**。安装过程会停止正在运行的旧版/开发版 AutoSwitch，账号库和领取记录保留在 `%LOCALAPPDATA%\AutoSwitch`。卸载默认保留数据，但会移除计划任务和桌面/开始菜单/启动文件夹快捷方式；只有输入 `YES` 才会删除账号与记录。

不想接受默认行为时，用脚本方式安装并带上开关：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -NoLaunch -NoAutoStart -NoDesktopShortcut
```

计划任务注册失败时，安装器会在「启动」文件夹放一个 `AutoSwitch.lnk` 兜底实现开机自启；随时可以用面板「设置」或 `node.exe app\bin\autoswitch.mjs task install|status|uninstall` 管理。

安装包没有代码签名，首次运行可能触发 SmartScreen 提示；安装包本身使用 Windows 自带的 IExpress 制作。安装器结束时会弹出一个确认框，点击确定即可（IExpress 没有可选勾选框，所以「启动软件」就是默认行为）。

### GitHub Actions 自动打包

[`.github/workflows/windows-build.yml`](.github/workflows/windows-build.yml) 在 Windows runner 上运行：

- push 到 `main` / Pull Request / 手动触发：运行 26 个测试，构建 Setup 和便携版 ZIP，上传 Actions Artifacts。
- push `v*` 标签：额外创建 GitHub Release，并上传 Setup、便携版 ZIP 和 `.sha256`。

发布新版本时先更新 `package.json` 的版本号，再打同名标签：

```bash
git tag v0.4.0
git push origin v0.4.0
```

### 检查更新

面板「设置 → 关于与更新」可以检查 GitHub Releases；侧边栏也有项目地址入口。

- 只查询最新 Release，不自动下载、不自动安装；发现新版本时提供 Setup / 便携版下载链接和 Release 页面。
- 结果缓存 6 小时；点击「检查更新」会强制刷新。
- 本机 Node 可能不信任系统代理的根证书，更新检查优先使用 Windows 自带 `curl.exe`（系统证书/代理），失败时回退 Node `fetch`。
- 检查只访问 `https://api.github.com/repos/sanzhixiaoxia/AutoSwitch/releases/latest`，不发送账号、token 或使用数据。

## 备份与导出

设置页「备份与导出」提供：

- **创建加密备份**：把账号与设置打包，使用你设置的密码（scrypt + AES-256-GCM）加密，下载 `.asbackup` 文件。
- **恢复备份**：选择备份文件和密码；恢复会替换当前账号与设置，保留本地领取记录，并在数据目录 `backups/rollback-*` 自动生成回滚副本。网页端恢复会自动处理运行中的服务；CLI 恢复需先运行 `autoswitch stop`。
- **导出账号清单 JSON**：账号 ID、平台、名称、到期时间、额度等，不含 token。
- **导出领取记录 CSV**：时间、平台、账号、触发、结果、积分和说明，不含 token；CSV 已做公式注入转义，可直接用 Excel 打开。

备份不包含领取记录和 Trae 文件快照。Qoder 的客户端登录快照在账号库里，会一起备份；Trae 切换需要重新在客户端登录并导入。备份文件包含账号 token，请像密码一样保管；密码不会保存在本机。

CLI：

```bash
export AUTOSWITCH_BACKUP_PASSWORD='your-password'
autoswitch backup ./AutoSwitch-backup.asbackup
autoswitch stop
autoswitch restore ./AutoSwitch-backup.asbackup --yes
autoswitch start
autoswitch export accounts --out ./accounts.json
autoswitch export claims --out ./claims.csv
```

## 账号从哪里来

| 平台 | 本机导入 | 浏览器登录 | 说明 |
| --- | --- | --- | --- |
| Trae CN | ✅ 解密 `storage.json` | — | token 约 6 天有效，客户端刷新后重新导入 |
| WorkBuddy | ✅ 从 WorkBuddy Switch 账号库导入 | — | 读取网页授权 token；客户端凭据加密，不直接读取 |
| Qoder 国际版 | ✅ 解密 `auth.v1.dat` | ✅ 设备码 | 每台设备每天限领一个国际版账号 |
| Qoder 国内版 | ✅ 解密 `auth.v1.dat` | ✅ 设备码 | 不受国际版设备名额限制 |

点击「导入本机账号」会保存凭据的加密快照；Qoder 的客户端登录切换只需要 `auth.v1.dat`，Trae 的切换需要整份登录态快照（`trae-slots/<uid>/`，不含缓存目录）。切换前会自动保存当前客户端登录（即使你还没有手动导入），避免丢掉正在使用的账号。

Qoder 多账号可以直接用「浏览器登录」添加；Trae 多账号需要先在客户端登录另一个账号，导入后再切换。浏览器登录的 Qoder 账号没有客户端登录快照，只能领取，不能切换客户端。

> Trae 的 refresh 会轮转 refreshToken 并让正在运行的 IDE 掉线，因此本项目**不做 Trae 自动续期**，只在到期前提示重新登录并导入。

---

## WorkBuddy 支持

WorkBuddy 5.x 客户端把 accessToken 封装成 `$wbEncrypted`，AutoSwitch **不提取客户端密钥**。WorkBuddy 账号来自本机已登录的 **WorkBuddy Switch** 账号库（`%APPDATA%\WorkBuddy Switch\vault.json`）：

- 在界面「添加账号 → WorkBuddy」或运行 `autoswitch workbuddy-import`，读取 WorkBuddy Switch 里通过官方网页授权保存的账号；只读，不修改 WorkBuddy Switch。
- 导入后使用独立 token 自动领取 WorkBuddy 每日签到、查询积分和连签天数，并自动把当前客户端登录的账号标记为「当前登录」。
- **不自动刷新 token**：刷新会轮换 refreshToken，可能让 WorkBuddy Switch 手里的同一会话失效；token 过期后重新从 WorkBuddy Switch 导入即可（WorkBuddy Switch 会刷新）。
- 暂不支持在 AutoSwitch 内切换 WorkBuddy 客户端登录（请使用 WorkBuddy Switch）；成长中心旅行/盲盒等扩展奖励也不在本版本范围内。
- 备份包含 WorkBuddy 账号 token（密码加密），恢复后可直接继续领取；导出文件不含 token。

## 自动领取规则

- Qoder / Qoder CN 的每日 100 Credits 按 **UTC+8 每天 10:00** 刷新，领取后 30 天有效，过期不补。
- Trae 与 WorkBuddy 按自然日签到，积分与连签天数以接口返回为准。
- 每次检查先查活动/签到状态，只有可领取才调用领取接口；重复调用不会多领。
- Qoder 国际版有一台设备每天一个账号的限制：本机当天已经有一个国际版账号领到后，其余国际版账号会显示「本机名额已用」，不会再请求领取。
- 手动领取成功后，下一次自动检查会顺延一个检查周期。
- 守护进程没运行、电脑睡眠或客户端凭据过期时不会自动领取。

---

## 数据与安全

默认数据目录：`%LOCALAPPDATA%\AutoSwitch`（可用 `AUTOSWITCH_HOME` 覆盖）。

| 文件 | 内容 |
| --- | --- |
| `accounts.enc` | 账号、token、Qoder auth 快照（AES-256-GCM） |
| `store.key` | 加密密钥（Windows DPAPI 保护，仅当前用户可解） |
| `claims.jsonl` | 领取与系统事件记录（不含 token） |
| `config.json` | 自动领取、间隔、端口等 |
| `trae-slots/` | Trae 整份登录态快照（切换用，包含客户端 Cookie 等，请保护数据目录） |
| `start-autoswitch.vbs` | 开机自启的静默启动器 |

- 网页服务只监听 `127.0.0.1`，校验 Host 头，写操作要求自定义 CSRF 头；不返回 token。
- 账号库密钥由 Windows DPAPI 保护；换 Windows 用户或迁移到另一台电脑后无法直接解密，需要重新登录/导入。
- 没有遥测、广告或第三方上传。网络请求只发往 `openapi.qoder.sh`、`openapi.qoder.com.cn`、`qoder.com(.cn)`、`api.trae.cn`、`www.codebuddy.cn` / `www.workbuddy.cn`，以及检查更新时的 `api.github.com`。
- 详细威胁模型见 [docs/SECURITY.md](docs/SECURITY.md)。

---

## 常见问题

**Qoder 国际版查不到活动 / 没有可领取？**
确认本机 Qoder 客户端安装完整（`resources/umid/runtime-info.exe` 存在），并运行 `autoswitch doctor`。国际版还需要在客户端登录过；设备风控身份由客户端组件生成。

**Trae 返回 `code 9074` / 「当前参与用户太多」？**
服务端对设备与账号的匹配有风控。程序会换设备号重试 3 次；仍失败会在下一轮再试。多账号场景建议每个账号单独导入并保持客户端登录过。

**token 过期了怎么办？**
在对应客户端重新登录，然后点击「导入本机账号」（或 `autoswitch import`）。Qoder 也可以用「浏览器登录」重新授权。非当前登录的账号不会自动续期。

**切换失败？**
切换会关闭客户端。请先保存工作，确认后使用 `--force`（网页端会弹确认框）。Trae 必须先导入过一次该账号，才有可恢复的登录态快照。

**端口被占用？**
`autoswitch start --port 47872`，或修改 `autoswitch config set port 47872` 后重启。

---

## 开发

```bash
node --test                 # 26 个单元测试
node bin/autoswitch.mjs doctor --network
```

项目结构与协议说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，协议来源与致谢见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 声明

本项目是非官方社区工具，与 Trae、Qoder 官方没有隶属关系。领取依赖官方客户端接口，官方更新后可能失效；请自行评估账号风险并遵守服务条款。请只操作你自己拥有并已登录的账号。
