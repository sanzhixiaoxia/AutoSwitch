# 架构与协议

## 总览

```text
Trae 客户端 ─┐                       ┌─ 本机面板 (public/) ◀── Electron 窗口壳 (electron/main.mjs)
WorkBuddy Switch 账号库 ─┤                │       │ fetch JSON
Qoder 客户端 ─┼─ 读取/解密登录态 ──▶  │       ▼
Qoder CN ────┘       │               │  HTTP API (src/server.mjs, 127.0.0.1)
                     ▼               │       │
              accounts.enc           │       ▼
            (DPAPI + AES-GCM)        │  ClaimEngine (src/claim.mjs)
                     │               │   ├─ Qoder adapter
                     └──────────────▶│   ├─ Trae adapter
                                      │   └─ Store / LogStore
Scheduler (每 N 分钟) ───────────────▶│
                                      │
                     ┌────────────────┘
                     ▼
          openapi.qoder.sh / .com.cn
          api.trae.cn
```

领取服务没有运行时 npm 依赖；前端是原生 HTML/CSS/JS，由同一个 Node 进程静态托管。`AutoSwitch.exe` 只是这套界面的窗口壳：启动时先探测 `127.0.0.1:<port>/api/health`，已经在跑就直接 attach，没跑就用内置 `node.exe` 拉起 `autoswitch start --no-open` 再加载页面；关窗收进托盘，后台服务不受影响。

## 目录

```text
bin/autoswitch.mjs        CLI 入口
src/cli.mjs                命令解析与终端输出
src/server.mjs             本地 HTTP 服务、静态资源、API
src/claim.mjs              批量领取引擎（互斥、国际版设备名额）
src/scheduler.mjs          自动任务定时器
src/store.mjs              配置 + 加密账号库
src/log.mjs                claims.jsonl 与轮次汇总
src/task.mjs               Windows 计划任务安装/移除/查询
src/doctor.mjs             本机诊断
src/update.mjs             检查 GitHub Releases（缓存 + 下载链接）
src/backup.mjs             密码加密备份/恢复、账号与记录导出
src/risk.mjs               Qoder 设备风控请求头
src/win/dpapi.mjs          DPAPI + Electron safeStorage 编解码
src/win/paths.mjs          客户端探测、进程控制、启动
src/providers/qoder.mjs    Qoder / Qoder CN 适配器
src/providers/trae.mjs     Trae CN 适配器
src/providers/workbuddy.mjs WorkBuddy 适配器（从 WorkBuddy Switch 导入）
src/providers/index.mjs    适配器注册与汇总
public/                    本地单页面板
electron/main.mjs          Electron 窗口壳（单实例、托盘、attach/拉起后台服务）
test/                      node:test 单元测试
```

## 数据目录迁移

默认数据目录为 `%LOCALAPPDATA%\AutoSwitch`。旧版本名为 CreditPilot，数据在 `%LOCALAPPDATA%\CreditPilot`。`resolveHome()` 在首次启动时检测旧目录：如果新目录不存在，就复制旧目录到 `<new>.migrating` 后原子改名，排除 `server.pid` 与旧启动器；旧目录保留。也可用 `AUTOSWITCH_HOME`（兼容 `CREDITPILOT_HOME`）显式指定数据目录。

## 账号模型

账号 ID 固定为 `<provider>:<uid>`，`provider` 为 `trae`、`workbuddy`、`qoder`、`qoder-cn`。

账号记录（加密保存）：

```js
{
  id, provider, uid, name, email, phone,
  token, refreshToken, expiresAt,
  meta: { liveActive, quota, slot, deviceId, ... },
  snapshot: { kind: "qoder", auth } | { kind: "trae", uid },
  lastClaim: { at, status, amount, message, roundKey }
}
```

`Store.publicAccount()` 会剥离 token、refreshToken、snapshot、phone 全量，只向网页返回 `phoneHint` 等信息。

## 领取流程

1. `syncAll(store)` 读取当前客户端登录态，更新已保存账号的 token（不自动新增账号）。
2. 按 `provider` order + `addedAt` 排序账号。
3. 对每个账号调用 `adapter.claim(account, store)`：
   - Qoder：先 `GET campaigns`，只对 `actionType=CLAIM_BENEFIT` 且 `claimStatus=CLAIMABLE` 的活动 `POST claim`。
   - Trae：先 `POST checkin_credits/status`，未签才 `POST checkin_credits/claim`。
4. 写入 `account.lastClaim` 与 `claims.jsonl`（`type=claim`）。
5. 整轮写一条 `type=run` 记录，`Scheduler` 用它计算下次时间。

领取是幂等的；已领取会记录为 `already`，不会当作失败。

### Qoder 国际版设备名额

服务端限制「每台设备每天一个国际版账号」。引擎在每轮开始时检查当天已有 `claimed/already` 的 Qoder 国际版账号；如果有，则其他国际版账号先查状态，若为 `claimable` 直接标记 `device-limited`，不再发领取请求。国内版不适用。

### 轮次

- Qoder：UTC+8 每天 10:00 到次日 10:00 为一轮。`roundKey = dayKey(now - 10h)`。
- Trae / WorkBuddy：自然日。`roundKey = dayKey(now)`。
- 记录汇总按各自轮次计算，避免把 Trae 的「今天」和 Qoder 的「本轮」混在一起。

## Qoder 协议

### 客户端与登录态

- 国际版：安装 `Qoder`，数据目录 `%APPDATA%\com.qoder.app.stable`
- 国内版：安装 `Qoder CN`，数据目录 `%APPDATA%\com.qodercn.app.stable`
- 登录文件：`auth.v1.dat`，内容为 Electron `safeStorage` 密文
- 解密：`Local State` → `os_crypt.encrypted_key`（base64，前缀 `DPAPI`）→ DPAPI `CurrentUser` → 32 字节 AES 密钥；`v10 + nonce(12) + AES-256-GCM(密文 + tag)`
- 0.3+ 客户端把实际版本放在 `.qoder-versions/<version>/resources`；探测时优先选带 `umid/runtime-info.exe` 的版本。

### 接口

```text
GET  {base}/sash/api/v1/me/campaigns?clientType=10
POST {base}/sash/api/v1/me/campaigns/{campaignId}/claim
GET  {base}/api/v1/userinfo
GET  {base}/api/v2/quota/usage
GET  {base}/api/v1/deviceToken/poll?nonce=&verifier=&challenge_method=S256
```

- 国际版 base：`https://openapi.qoder.sh`
- 国内版 base：`https://openapi.qoder.com.cn`
- 国内版登录页：`https://qoder.cn/device/selectAccounts`
- 国际版登录页：`https://qoder.com/device/selectAccounts`

活动请求头：

```text
Authorization: Bearer <token>
Cosy-ClientType: 10
Cosy-Version: <客户端版本，如 0.4.8>
Cosy-MachineOS: x86_64_win32
Cosy-MachineHostname: <清洗后的主机名>
Cosy-MachineId: <客户端 auth.machine-id>
Cosy-MachineToken / Cosy-MachineCode / Cosy-MachineType  ← runtime-info 生成
Accept: application/json
User-Agent: Qoder/claim
```

国际版缺少风控头时服务端可能不下发每日活动。风控身份由：

```text
runtime-info.exe 3 --account-stdin
stdin: {"account":"<uid>"}
stdout: {"machineToken":..., "machineCode":..., "machineType":...}
```

生成，缓存 50 分钟。国际版用 env `3`，国内版用 env `0`；找不到对应版本时互相兜底。

### 设备码登录（多账号）

1. 生成 32 字节 PKCE verifier、S256 challenge、nonce、machine_id。
2. 打开 `https://qoder.com(.cn)/device/selectAccounts?challenge=...&challenge_method=S256&machine_id=...&nonce=...`。
3. 轮询 `deviceToken/poll`，`202/404` 表示等待，`200` 返回 `token`、`refresh_token`、`expires_at`、`user_id`。
4. 用 token 调 `userinfo` 补全名称/邮箱。
5. token 约 30 天有效；上游 refresh 对设备码流程不可用，过期重新授权。

### 客户端切换

1. 读取当前登录；如果就是目标 uid，直接返回。
2. 客户端运行中时必须先正常关闭（`taskkill` 不带 `/F`，超时再强制）。
3. 关闭后再读一次当前登录，把最新 token 写回它对应的账号；如果该账号尚未保存，会自动新增，避免丢号。
4. 用目标账号的 `auth` 快照重新加密写入 `auth.v1.dat`，原文件备份为 `auth.v1.dat.autoswitch.bak`。
5. 如果切换前客户端在运行，则重新启动。

## Trae 协议

### 客户端与登录态

- 探测顺序：`Trae CN`、`Trae`、`TRAE SOLO CN`、`TRAE SOLO`
- 数据目录：`%APPDATA%\<客户端名>\`
- 登录键：`User/globalStorage/storage.json` 的 `iCubeAuthInfo://icube.cloudide`
- 设备号：`iCubeAuthInfo://icube-dc:<纯数字>` 键名后缀
- `tc` 信封：`tc` 头 6 字节 + 32 字节随机 + SHA-512 派生的 AES-128-CBC 密文；明文前 64 字节是正文 SHA-512 校验。常量表随客户端版本变化，升级后需要重新提取。
- `storage.json` 中还有 `host` 与 `userRegion`；非 `*.trae.cn` 视为国际版，当前不参与领取。

### 接口与请求头

```text
POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status  {}
POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim   {}
POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage     {"require_usage":true,"req_source":2}
```

```text
authorization: Cloud-IDE-JWT <jwt>
user-agent: VSCode 1.107.1 (TRAE SOLO CN)
x-market-client-id: VSCode 1.107.1
x-market-user-id: <按 uid 派生的 UUID>
x-user-region: CN
x-device-id: <客户端真实设备号（导入时记录），兜底按 uid 派生 16 位数字>
package-type: stable_cn
app-version: 0.1.45
...其余 IDE 指纹头
```

`x-device-id` 必须是**形如客户端的 16 位纯数字**。早期版本按字节拼 ASCII 数字，产出 30 位的畸形值，签到接口一律回 `code 9074 当前参与用户太多`（状态接口却不拦，很容易误判成服务端限流）。现在优先用导入时从客户端读到的真实设备号（机器级，`iCubeAuthInfo://icube-dc:<数字>`），读不到时才用按 `uid` 确定性派生的 16 位数字；`9074` 仍会等待 3/8/15 秒轮换派生号重试。

**Trae CN 的每日签到按设备限一次，不按账号。** 同一台机器当天已签到时，其它账号会返回 `code 9095 当前设备今日已经签到，请明日再来哦～`，本项目归为 `device-limited`（界面显示「本机名额已用」），不计入已领取，也不会反复重试。所以多账号 Trae 无法在同一天各自领取，这是服务端规则，不是本项目的限制。

响应统一为 `{ code, message, ... }`；`checked_in=true` 表示已签。某些失败会用「已经签到」文案返回，归为 `already`。

### 登录快照与切换

Trae 的登录态不只有 token；只写 token 会导致客户端显示未登录。快照白名单：

```text
User/globalStorage/storage.json
User/globalStorage/state.vscdb[.wal|.shm|.backup]
machineid
aha
Preferences
Local State
Local Storage/leveldb
Local Storage/config.db
Network
Partitions/trae-webview
Partitions/icube-web-crawler-shared-session-v1.0
Session Storage
```

`Cache`、`Code Cache`、`GPUCache`、`Dawn*` 等缓存目录不复制。切换时先关闭客户端，保存当前账号快照（未导入的账号会自动新增），再恢复目标快照并重新启动。

**不做 Trae 自动续期**：refresh 会轮换 refreshToken，使正在运行的 IDE 掉线。token 过期后在客户端重新登录并导入。

## WorkBuddy

WorkBuddy 5.x 客户端的 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` 中 `auth.accessToken` 是 `$wbEncrypted` 封装，本项目不提取客户端密钥，因此不做客户端 token 直读。账号来源改为 WorkBuddy Switch 的本地账号库：

```text
%APPDATA%\WorkBuddy Switch\vault.json
  records[].apiEncrypted / encrypted  → Electron safeStorage 解密
  session.account.{uid,nickname,phoneNumber}
  session.auth.{accessToken,refreshToken,domain,expiresAt}
```

`apiEncrypted` 是 WorkBuddy Switch 通过官方网页登录保存的独立 API 会话；解密后取明文 token。导入只读，不修改 Switch。当前 WorkBuddy 客户端的 `account.uid` 从客户端 auth 文件明文读取，用于标记「当前登录」；客户端 token 本身仍是加密的。

接口（host 取 `auth.domain`，通常 `www.codebuddy.cn`）：

```text
POST /v2/billing/meter/checkin-activity-status   {}  今日是否签到/连签/每日积分
POST /v2/billing/meter/checkin-status            {}  旧版签到状态
POST /v2/billing/meter/daily-checkin             {}  签到
POST /billing/meter/get-user-resource-summary    {ProductCode:"p_tcaca"}  额度汇总
POST /v2/billing/meter/get-user-resource         {...} 旧版额度包
```

签到请求带 `Authorization: Bearer`、`X-User-Id`、`X-Domain`、`X-Product: SaaS`、`User-Agent: CLI/2.108.1 CodeBuddy/2.108.1`；额度接口带 web 身份头。状态数据 `active/today_checked_in/streak_days/daily_credit`；额度 summary 的 `TotalCredits` 为剩余，`Packages[].CycleTotalCapacity` 求和为总额。

**不自动刷新 token**：刷新会轮换 refreshToken，可能使 WorkBuddy Switch 持有的同一会话失效；过期后重新导入。暂不支持在 AutoSwitch 切换 WorkBuddy 客户端，也不包含成长中心旅行/盲盒。

## 调度

- 默认开启，间隔 120 分钟；首次启动如果从未运行过，6 秒后检查一次。
- 每次从 `claims.jsonl` 的最后一条 `type=run` 计算 `nextRunAt = lastRun + interval`。
- 手动领取成功后会顺延下一次自动检查。
- 只运行一个领取任务；手动/自动并发时返回 `409 busy`。
- 电脑睡眠时定时器不执行；唤醒后到期任务会补跑一次。

## HTTP API

所有写操作要求 `x-autoswitch: 1` 请求头。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/state` | 账号（脱敏）、轮次汇总、调度、客户端、配置、任务状态 |
| POST | `/api/import` | 导入本机当前登录 |
| POST | `/api/claim` | `{ accountIds?, provider? }`，省略则全部 |
| POST | `/api/status` | 只查状态与额度 |
| POST | `/api/switch` | `{ accountId, force }` |
| DELETE | `/api/accounts/:id` | 移除账号与 Trae 快照 |
| POST | `/api/login/start` | `{ provider: "qoder"|"qoder-cn" }` |
| GET | `/api/login/poll?sessionId=` | 轮询设备码登录 |
| GET | `/api/logs?limit=&types=` | 记录 |
| PUT | `/api/config` | `autoClaim`、`autoStart`、`intervalMinutes`、`claimDelayMs`、`port` |
| POST | `/api/task/install` / `uninstall` | 开机自启，同时写 `config.autoStart`；安装器升级时读到 `false` 就保持关闭 |
| GET | `/api/update` | 读取缓存的更新检查结果 |
| POST | `/api/update/check` | 强制检查 GitHub 最新 Release |
| POST | `/api/backup` | 创建密码加密备份（返回 `.asbackup` 下载） |
| POST | `/api/workbuddy/import` | 从 WorkBuddy Switch 账号库导入网页授权账号 |
| POST | `/api/restore` | 恢复备份（替换账号与设置，自动回滚副本） |
| GET | `/api/export/accounts.json` | 导出脱敏账号清单 |
| GET | `/api/export/claims.csv` | 导出领取记录 CSV |
| POST | `/api/doctor` | 本机诊断 |

## 检查更新与 CI

- `src/update.mjs` 请求 `https://api.github.com/repos/sanzhixiaoxia/AutoSwitch/releases/latest`，把结果写入数据目录的 `update.json`，缓存 6 小时；`POST /api/update/check` 强制刷新。
- 版本比较只取 major.minor.patch；Release 的 asset 只接受 `github.com` 的 HTTPS 下载地址，并从中筛选 Setup `.exe` 与便携版 `.zip`。
- Windows 上优先调用系统 `curl.exe`（Schannel 使用系统证书和代理），失败再回退 Node `fetch`；不发送 token 或账号数据。
- `.github/workflows/windows-build.yml` 在 Windows runner 上运行测试和 `npm run dist`，上传 Actions Artifacts；`v*` 标签额外创建 GitHub Release 并上传 Setup、便携版与 SHA-256。
- 应用内只检查并展示下载链接，不自动安装。

## 备份格式

`.asbackup` 是 JSON 信封：`format=autoswitch-backup`、`version=1`、`kdf=scrypt(N=32768,r=8,p=1)`、`cipher=aes-256-gcm`、salt/iv/tag 和 base64 密文。明文包含账号完整内部记录（含 token 与 Qoder auth 快照）和 `autoClaim/intervalMinutes/claimDelayMs`，不包含领取记录和 Trae 文件快照。账本仍以本机 DPAPI 密钥重新加密写入 `accounts.enc`，因此备份可跨机器恢复；恢复前会复制当前 `accounts.enc/config.json/claims.jsonl` 到 `backups/rollback-*`。

导出接口不读取 token：账号清单来自 `Store.publicAccount()`，CSV 来自脱敏后的日志，并对以 `= + - @` 开头的单元格加前缀，避免 Excel 公式注入。

## 扩展新平台

适配器需要提供：

```js
{
  importLocal(store),
  syncActive(store),
  status(account, store, { withQuota }),
  claim(account, store),
  switchTo(store, account, { force }),
  isExpired(account),
}
```

然后在 `src/providers/index.mjs` 注册 provider，在 `src/util.mjs` 的 `roundKey` 中定义轮次，在 `public/app.js` 的 `PROVIDER_META` 中添加显示信息。

## 测试

```bash
node --test
```

覆盖：Qoder 活动筛选、轮次边界、Trae tc 解密、设备号派生、Trae 快照保存/恢复、WorkBuddy 会话/签到/额度解析、DPAPI/safeStorage 编解码、加密账号库、日志汇总、更新版本比较/Release 摘要、加密备份/恢复、CSV 转义、HTTP Host/CSRF/CSP 防护、token 不出 API。

## 协议来源与致谢

协议细节来自社区项目实测与逆向：

- [koi128bit/WorkBuddy-Switch](https://github.com/koi128bit/WorkBuddy-Switch)（MIT）：本项目的产品形态与本地面板思路参考
- [techysy/CreditDaddy](https://github.com/techysy/CreditDaddy)（MIT）：Qoder/Trae 登录态读取、风控身份、Trae 快照与设备号策略
- [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)（MIT）：Qoder CN 活动接口与运行时设备标识
- [decolua/10router](https://github.com/decolua/10router)（MIT）：Qoder 设备码登录流程
- [BlueChonk/trae-daily-checkin](https://github.com/BlueChonk/trae-daily-checkin)：Trae 客户端结构参考

这些接口没有官方文档，随客户端更新可能变化。请遵守各平台服务条款。
