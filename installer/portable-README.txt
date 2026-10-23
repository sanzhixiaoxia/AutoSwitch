AutoSwitch 便携版
================

无需安装，解压后双击 AutoSwitch.exe（或 Start AutoSwitch.vbs）打开窗口。
窗口只是界面：后台服务没在跑时会自动拉起，关窗只是收进系统托盘，领取继续。

只想要后台服务、不要窗口：
  node.exe app\bin\autoswitch.mjs start --no-open
停止后台服务：Stop AutoSwitch.cmd
面板也可以用浏览器打开：http://127.0.0.1:47871

数据目录仍为 %LOCALAPPDATA%\AutoSwitch，与安装版共用账号库。
如果要在另一台电脑使用，请先在该电脑登录 Trae / Qoder 客户端，再导入账号。

从旧版 CreditPilot 升级：首次启动会自动把 %LOCALAPPDATA%\CreditPilot
复制到 %LOCALAPPDATA%\AutoSwitch，旧目录保留。
