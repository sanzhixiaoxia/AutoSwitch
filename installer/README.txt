AutoSwitch 每日积分领航
=====================

安装位置：
  %LOCALAPPDATA%\Programs\AutoSwitch
    AutoSwitch.exe            窗口壳（Electron）
    resources\app\            窗口壳加载的应用副本
    node.exe + app\           后台服务与命令行（autoswitch CLI）
    AutoSwitch.vbs            隐藏窗口启动后台服务
  数据目录：%LOCALAPPDATA%\AutoSwitch（账号库、领取记录、Electron 缓存）

安装器默认完成的事：
  1. 桌面与开始菜单快捷方式（指向 AutoSwitch.exe 窗口）
  2. 开机自启：当前用户登录时静默启动后台服务的计划任务 AutoSwitch（不弹窗）
  3. 安装结束立即打开 AutoSwitch 窗口

脚本化安装可以关掉上述任一项：
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -NoLaunch -NoAutoStart -NoDesktopShortcut

启动：
  桌面 / 开始菜单 → AutoSwitch（打开应用窗口）
  Start AutoSwitch.cmd 等同双击桌面图标
  只要后台服务没在跑，窗口会自动把它拉起来

窗口与后台服务：
  AutoSwitch.exe 是窗口壳，后台领取由 node.exe 跑的本地服务承担。
  关闭窗口只是收进系统托盘，领取任务继续；要彻底停服务用下面的停止方式。
  托盘右键：打开 AutoSwitch / 用浏览器打开面板 / 退出 AutoSwitch。

网页面板（同一个界面，也可以用浏览器打开）：
  http://127.0.0.1:47871

停止后台服务：
  Stop AutoSwitch.cmd
  或运行安装目录下的 node.exe app\bin\autoswitch.mjs stop

开机自启管理：
  "node.exe" "app\bin\autoswitch.mjs" task install
  "node.exe" "app\bin\autoswitch.mjs" task status
  "node.exe" "app\bin\autoswitch.mjs" task uninstall
  也可以在软件「设置 → 开机自启」里用开关开启或关闭。
  关闭时会把选择写进 config.json 的 autoStart，之后的版本升级会保持关闭，
  不再自动重新注册；同时清掉「启动」文件夹里的兜底快捷方式。
  计划任务注册失败时，安装器改在「启动」文件夹放 AutoSwitch.lnk 兜底。

卸载：
  开始菜单 → AutoSwitch → 卸载 AutoSwitch
  卸载会移除计划任务、桌面/开始菜单/启动文件夹快捷方式。
  默认保留账号与领取记录，数据目录为 %LOCALAPPDATA%\AutoSwitch

说明：
  账号凭据使用 Windows DPAPI + AES-256-GCM 保存在本机，
  网页面板只监听 127.0.0.1。

装完没有窗口：
  安装器启动 AutoSwitch.exe 前会清掉 ELECTRON_RUN_AS_NODE。
  如果你是自己在别的 Electron 工具的终端里手动起它，带上这个变量时
  exe 会被当成纯 Node 直接退出且不报错；先 unset 再启动，或双击桌面快捷方式。

从旧版 CreditPilot 升级：
  安装器会停止旧进程并移除旧开始菜单/旧计划任务。
  首次启动 AutoSwitch 会自动把 %LOCALAPPDATA%\CreditPilot 复制到
  %LOCALAPPDATA%\AutoSwitch；旧目录保留。
