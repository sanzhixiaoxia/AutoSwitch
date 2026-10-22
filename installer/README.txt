﻿AutoSwitch 0.1.0
=================

安装位置：
  %LOCALAPPDATA%\Programs\AutoSwitch

启动：
  开始菜单 → AutoSwitch
  或运行安装目录下的 AutoSwitch.vbs（隐藏窗口，自动打开浏览器）
  控制台模式：Start AutoSwitch.cmd

网页面板：
  http://127.0.0.1:47871

停止：
  Stop AutoSwitch.cmd
  或运行安装目录下的 node.exe app\bin\autoswitch.mjs stop

卸载：
  开始菜单 → AutoSwitch → 卸载 AutoSwitch
  默认保留账号与领取记录，数据目录为 %LOCALAPPDATA%\AutoSwitch

开机自启：
  在网页面板「设置」中点击「安装开机自启」，
  或运行：
  "node.exe" "app\bin\autoswitch.mjs" task install

说明：
  账号凭据使用 Windows DPAPI + AES-256-GCM 保存在本机，
  网页面板只监听 127.0.0.1。

从旧版 CreditPilot 升级：
  安装器会停止旧进程并移除旧开始菜单/旧计划任务。
  首次启动 AutoSwitch 会自动把 %LOCALAPPDATA%\CreditPilot 复制到
  %LOCALAPPDATA%\AutoSwitch；旧目录保留。
