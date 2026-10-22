# 安全说明

AutoSwitch 的假设是：**单用户 Windows 电脑、只在本机使用、操作的是你自己的账号。** 它不是多租户服务，也没有为「同一台电脑上的其他本地用户」提供额外隔离。

## 凭据从哪里来

| 平台 | 来源 | 解密方式 |
| --- | --- | --- |
| Qoder / Qoder CN | `%APPDATA%\com.qoder(.cn).app.stable\auth.v1.dat` | Electron `safeStorage`：客户端 `Local State` 的 DPAPI 密钥 + AES-256-GCM |
| Trae CN | `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json` | 客户端 `tc` 信封（公开常量表派生密钥 + AES-128-CBC），并校验 SHA-512 |
| Qoder 设备风控 | 客户端自带 `resources/umid/runtime-info.exe` | 子进程输出 `Cosy-MachineToken/Code/Type`，不落盘 |

读取凭据只发生在：启动时的当前账号同步、导入、领取、切换、`doctor`。领取本身使用内存中的 token，不通过客户端 UI。

## 落盘加密

- 账号库 `accounts.enc`：AES-256-GCM；每次写入随机 12 字节 nonce，包含认证 tag；原子写（临时文件 + rename）。
- 密钥 `store.key`：32 字节随机密钥，用 Windows DPAPI `CurrentUser` 保护。换 Windows 用户、重装系统或换机后无法解密，需要重新导入。
- `claims.jsonl`：领取/切换/系统事件，消息经过脱敏（Bearer、`dt-`、JWT 等模式），**不含 token**。
- `trae-slots/<uid>/`：Trae 整份登录态快照，用于切换客户端。为能完整恢复登录，它包含 `storage.json`、`state.vscdb`、`Network`、`Local Storage` 等客户端数据（不含 Chromium 缓存目录）。这些文件由客户端自己加密/管理，但目录本身不是整体加密的，请保护 `%LOCALAPPDATA%\AutoSwitch` 的访问权限。

## 从 CreditPilot 迁移

AutoSwitch 原名 CreditPilot。首次运行 AutoSwitch 时，如果 `%LOCALAPPDATA%\AutoSwitch` 不存在而 `%LOCALAPPDATA%\CreditPilot` 存在，程序会把旧目录复制到新目录（排除 `server.pid` 和旧启动器），旧目录保留不动。账号库和 DPAPI 密钥是同一 Windows 用户保护的，可以直接复用；迁移失败会中止启动并提示，不会创建空账号库。

安装版升级时会停止旧版进程、移除旧版开始菜单和 `CreditPilot` 计划任务；旧程序目录不会自动删除，可运行旧版卸载器处理。旧数据目录也不会自动删除；确认新版本可用后可手动清理。

安装版默认写的是**当前用户**范围内的东西：`%LOCALAPPDATA%\Programs\AutoSwitch`、桌面与开始菜单快捷方式、`HKCU` 登录时计划任务，安装结束还会拉起本机服务。全部不需要管理员权限，也不写机器级（`HKLM`）配置；不想接受时可用 `install.ps1 -NoLaunch -NoAutoStart -NoDesktopShortcut`，卸载会移除计划任务与三处快捷方式。开机自启用的是 `wscript.exe` 静默启动器 `%LOCALAPPDATA%\AutoSwitch\start-autoswitch.vbs`，内容只有本机 Node 与 CLI 路径，`--no-open` 不弹浏览器。

## 网络边界

- 服务只绑定 `127.0.0.1`，不会监听局域网地址。
- 每个请求校验 `Host` 必须是 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`，防止 DNS 重绑定。
- 所有写操作（POST/PUT/DELETE）要求自定义请求头 `x-autoswitch: 1`；跨站表单无法携带自定义头，跨站 fetch 会触发预检，而服务不返回 CORS 头。
- 页面启用 CSP：只允许同源脚本/样式、禁止 frame 嵌入、禁止 form 提交。
- API 不返回 token、refreshToken、auth 快照；账号库只有服务进程能解密。
- 外部请求只访问：
  - `https://openapi.qoder.sh`、`https://openapi.qoder.com.cn`、`https://qoder.com`、`https://qoder.cn`
  - `https://api.trae.cn`
  - `https://www.codebuddy.cn` / `https://www.workbuddy.cn`（WorkBuddy 签到与额度）
  - `https://api.github.com/repos/sanzhixiaoxia/AutoSwitch/releases/latest`（仅在手动/启动后读取缓存时检查更新）
- 没有遥测、广告、远程配置或第三方上传。

## 备份与导出

- 备份使用用户密码派生密钥（scrypt，随机 salt）和 AES-256-GCM 加密，密码不落盘；备份文件包含账号 token，必须与密码分开保管。
- 备份只包含账号与设置，不包含领取记录和 Trae 文件快照。恢复会用备份账号替换当前账号，保留本地领取记录，并把恢复前的账号库/配置/日志复制到 `backups/rollback-*`。
- 账号清单 JSON 与领取 CSV 来自脱敏数据，不含 token；CSV 对公式前缀做了转义。
- 备份/恢复/导出都由本机服务处理，不上传第三方。

## 检查更新

「设置 → 关于与更新」会读取 GitHub Releases 的公开 API。请求由本机服务发出，不携带账号 token、cookie 或使用数据；结果缓存在数据目录的 `update.json` 中 6 小时，点击「检查更新」会强制刷新。更新检查只显示版本和下载链接，不会自动下载或执行安装包。Windows 上优先使用系统 `curl.exe`（系统证书/代理），失败时回退 Node `fetch`。

## WorkBuddy 账号来源

WorkBuddy 客户端自身把 accessToken 封装为 `$wbEncrypted`，本项目不提取其密钥。WorkBuddy 账号只在你点击「从 WorkBuddy Switch 导入」或运行 `autoswitch workbuddy-import` 时，读取 `%APPDATA%\WorkBuddy Switch\vault.json` 中由 WorkBuddy Switch 官方网页登录保存的会话，并使用 WorkBuddy Switch 的 Electron safeStorage 解密。

- 只读导入，不修改 WorkBuddy Switch 的账号库或客户端登录。
- 导入的 token 存入 AutoSwitch 自己的加密账号库，并随加密备份保存。
- 不自动刷新 WorkBuddy token，避免轮换 refreshToken 导致 WorkBuddy Switch 会话失效；过期后重新导入。
- 暂不支持在 AutoSwitch 中切换 WorkBuddy 客户端，也不访问成长中心扩展活动。

## 本地面板的边界

面板没有登录密码。任何能访问 `127.0.0.1:47871` 的本机进程/用户，都可以调用领取、切换、删除等接口。这是为了「双击即用」做的取舍：

- 单用户电脑：可接受。
- 共享电脑、远程桌面多人共用、或你在本机运行不可信程序：不要保持守护进程常驻，或只在使用时启动。

如需更强隔离，可以自行在前面加一层带认证的反向代理，但本项目不会在服务端实现多用户权限。

## 切换客户端登录的风险

- 切换会**关闭并重新启动** Trae / Qoder 客户端；未保存的编辑内容可能丢失，网页端会二次确认。
- Qoder 切换只重写 `auth.v1.dat`，并保留原文件为 `.autoswitch.bak`。
- Trae 切换会先保存当前账号快照，再覆盖白名单内的登录态文件。如果目标账号从未在本机导入过快照，切换会被拒绝。
- Trae 的 token 刷新会轮换 refreshToken 并使 IDE 掉线，所以本项目刻意不自动刷新 Trae token；过期后请在客户端重新登录并导入。

## 已知限制

- 官方接口是逆向得到的，没有稳定性承诺；接口变更可能导致领取失败。
- Qoder 国际版每台设备每天只能领取一个账号，这是服务端规则，不是本项目的限制。
- 同一 Windows 用户下的恶意程序可以读取 DPAPI 保护的数据或注入进程；DPAPI 防的是其他用户，不防当前用户。
- Trae 的 `tc` 信封是混淆而非强加密；客户端登录态本身的安全性由 Trae 负责。
- 本项目不提供防封号、绕过风控或批量注册能力，只读取你已登录的账号。

## 删除数据

```powershell
# 先移除非计划任务（如果安装过）
autoswitch task uninstall

# 删除本应用数据（不会退出客户端登录）
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\AutoSwitch"
```

删除前建议先确认没有需要保留的领取记录。

## 报告问题

请勿在公开 issue 中粘贴 token、auth.v1.dat、含账号信息的截图。描述问题时使用 `autoswitch doctor` 的脱敏输出即可。
