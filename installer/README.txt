AutoSwitch 每日积分领航
=====================

安装位置：
  %LOCALAPPDATA%\Programs\AutoSwitch

安装器默认完成的事：
  1. 桌面与开始菜单快捷方式
  2. 开机自启：当前用户登录时静默启动的计划任务 AutoSwitch（不弹浏览器）
  3. 安装结束立即启动 AutoSwitch，并打开面板 http://127.0.0.1:47871

脚本化安装可以关掉上述任一项：
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -NoLaunch -NoAutoStart -NoDesktopShortcut

启动：
  桌面 / 开始菜单 → AutoSwitch
  或运行安装目录下的 AutoSwitch.vbs（隐藏窗口，自动打开浏览器）
  控制台模式：Start AutoSwitch.cmd

网页面板：
  http://127.0.0.1:47871

停止：
  Stop AutoSwitch.cmd
  或运行安装目录下的 node.exe app\bin\autoswitch.mjs stop

开机自启管理：
  "node.exe" "app\bin\autoswitch.mjs" task install
  "node.exe" "app\bin\autoswitch.mjs" task status
  "node.exe" "app\bin\autoswitch.mjs" task uninstall
  也可以在网页面板「设置」中点击「安装开机自启」。
  计划任务注册失败时，安装器改在「启动」文件夹放 AutoSwitch.lnk 兜底。

卸载：
  开始菜单 → AutoSwitch → 卸载 AutoSwitch
  卸载会移除计划任务、桌面/开始菜单/启动文件夹快捷方式。
  默认保留账号与领取记录，数据目录为 %LOCALAPPDATA%\AutoSwitch

说明：
  账号凭据使用 Windows DPAPI + AES-256-GCM 保存在本机，
  网页面板只监听 127.0.0.1。

从旧版 CreditPilot 升级：
  安装器会停止旧进程并移除旧开始菜单/旧计划任务。
  首次启动 AutoSwitch 会自动把 %LOCALAPPDATA%\CreditPilot 复制到
  %LOCALAPPDATA%\AutoSwitch；旧目录保留。
