# 网页入口 + 电脑客户端 + 手机浏览器

## 使用流程

普通记录仍然从原网页进入，不启动服务。同步窗口提供 GitHub Releases 的 Windows 和 Mac 下载按钮。客户端解压双击后，在本机提供网页和同步服务。用户回原网页点击“已启动，连接并继续记录”，随后在本地窗口继续操作。手机只需相机扫描网址二维码，无应用、账号、回码或长配对码。

客户端为标准库 Node.js 主机加原有网页，运行环境一起分发。Windows 使用原生启动器隐藏控制台；Mac 使用 `.app`。本机固定入口 `http://localhost:8787/`，手机使用电脑的局域网 IPv4 地址。无在线同步服务、STUN/TURN、DNS 发现或远程资源依赖。多网卡时自动优先常见物理网络，也允许在折叠区选择其他地址。

## 从原网页带入记录

通过用户点击打开的顶层窗口和 `postMessage` 传递当前记录，不从 HTTPS 页面向 HTTP 本地地址发跨域请求，也不把记录塞入超长 URL。双方核对窗口引用和本次导入标识。桌面保存成功后才确认，原窗口随后切换到本地页面。原网页 localStorage 保留。导入失败、弹窗被拦或客户端未启动时，原记录不删除。

转移包括记录、术式设置、PVI 终点、电极选择；不包括患者信息、报告内容和撤回历史。对不同记录的恢复会清空旧撤回历史，避免撤回到另一台手术。PDF 组件和中文字体只在导出时加载，手机不会下载它们或运行环境。

## 同步与持久保存

- `GET /api/lan/info`：服务版本、固定房间、电脑地址。
- `POST /api/lan/host`：创建新的写入会话；其他操作窗口自动停用，避免覆盖同源本地待发送记录。仅本机回环连接可申请或写入。
- `POST /api/lan/snapshot`：完整快照、会话和客户端递增序号。串行写文件、flush、原子替换后才确认。重复或旧序号不会覆盖新记录。
- `GET /api/lan/state`：最长 10 秒的变化等待。游标含进程启动标识；客户端应用快照后携带已应用版本，桌面据此显示跟随进度。
- `POST /api/lan/shutdown`：本机主动退出，等待当前保存完成。

客户端同时最多一个等待请求、一个写入请求；编辑合并 100 毫秒后上传，失败重试只保留最新完整状态。请求超时 16 秒，重试间隔上限 5 秒。刷新时手机从版本 0 读取最新保存状态。电脑刷新优先读取服务器存档；有尚未确认的本机编辑时先恢复本地待发送状态。房间和写入会话随存档保留，进程重启后旧网页可以继续重连。

启动在绑定固定端口成功后才写初始文件，重复启动不会覆盖活跃进程记录；已运行时启动器直接打开本机网页。端口被其他软件占用时显示启动失败；不换成随机端口让旧二维码失效。存档读取失败时拒绝覆盖原文件。正常保存最大 2 MiB，超限保留现有存档并显示失败。

数据保存在系统应用数据目录（可用 `VICTORYPVI_DATA_DIR` 覆盖以隔离测试），不保存在程序包。端口可用 `VICTORYPVI_PORT` 覆盖用于开发；正式入口固定 8787。

## 边界

电脑需保持运行和联网，休眠期间不会更新。手机浏览器在后台可能被系统暂停，回前台后会重连。更换网络/IP 后重扫二维码；开启设备隔离的访客 Wi-Fi 不能互访，改用允许互访的 Wi-Fi / 热点。二维码中没有在线服务或外网地址。

发布包未商业签名或公证，系统首次打开可能需要允许；Mac 包仅本地 ad-hoc 签名。Mac 支持 13.5+ Intel/Apple Silicon；Windows 包为 10/11 x64。真实 iOS/Android 和 Windows 设备仍需验收，浏览器模拟不能代替系统级测试。

## 构建与发布

Node 固定版本 24.11.1。从 nodejs.org 下载运行环境与 SHASUMS256.txt，先校验 SHA256，把完整 Node LICENSE 保存到 `output/desktop/runtime/Node-LICENSE.txt`。不要把测试存档放入应用或发布包。

```sh
node tests/single-vein-isolation-smoke.mjs
node tests/report-export-smoke.mjs
node tests/sync-client-smoke.mjs
node tests/sync-worker-smoke.mjs
node desktop/build.mjs --platform darwin --runtime /path/to/universal/node
VICTORYPVI_CC=x86_64-w64-mingw32-gcc node desktop/build.mjs --platform win32 --runtime /path/to/node.exe
```

Windows 构建也支持在 Windows 上使用 MinGW GCC；Mac 打包需要 macOS 的 codesign/ditto。Mac 通用 runtime 可用官方 darwin-arm64、darwin-x64 二进制通过 lipo 合并。

产物 `output/desktop/VictoryPVI-macOS.zip`、`VictoryPVI-Windows-x64.zip`；相应 Release 标签为 `desktop-v<版本号>`。发布包附完整应用代码、启动器源码和许可证；更新版本时同步修改网页下载链接。程序不自动联网升级，用户按需从 GitHub 下载新版本。
