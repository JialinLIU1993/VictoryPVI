# 电脑辅助同步与纯手机互联

## 使用流程

普通记录仍然从原网页进入，不启动服务。同步窗口提供 GitHub Releases 的 Windows 和 Mac 下载按钮。客户端解压双击后，在本机提供网页和同步服务。用户回原网页点击“已启动，连接并继续记录”，随后在本地窗口继续操作。手机只需相机扫描网址二维码，无应用、账号、回码或长配对码。

客户端为标准库 Node.js 主机加原有网页，运行环境一起分发。Windows 使用原生启动器隐藏控制台；Mac 使用 `.app`。本机固定入口 `http://localhost:8787/`，手机使用电脑的局域网 IPv4 地址。无在线同步服务、STUN/TURN、DNS 发现或远程资源依赖。多网卡时自动优先常见物理网络，也允许在折叠区选择其他地址。

## 纯手机互联

独立网页保留 `direct-sync-client.js` 的 WebRTC DataChannel 实现，`iceServers: []`，不调用 HTTP 同步 API、WebSocket、STUN 或 TURN。`direct-sync-ui.js` 提供手机邀请/回码、摄像头扫码及折叠的手动输入备用入口。一个手机操作、多台手机跟随；完整快照分块、应用后确认、心跳及最新状态补发。

独立手机网页预加载直连和扫码组件；其他场景进入手机互联时加载。电脑提供的 LAN 页面不加载扫码库或直连协议。两种模式互相独立，纯手机模式不依赖电脑进程；刷新后保留本地记录和只读角色，并提示重新配对，不宣称能无信令自动重建连接。

## 从原网页带入记录

通过用户点击打开的顶层窗口和 `postMessage` 传递当前记录，不从 HTTPS 页面向 HTTP 本地地址发跨域请求，也不把记录塞入超长 URL。双方核对窗口引用和本次导入标识。桌面保存成功后才确认，原窗口随后切换到本地页面。原网页 localStorage 保留。导入失败、弹窗被拦或客户端未启动时，原记录不删除。

转移包括记录、术式设置、PVI 终点、电极选择；不包括患者信息、报告内容和撤回历史。对不同记录的恢复会清空旧撤回历史，避免撤回到另一台手术。PDF 组件和中文字体只在导出时加载，不导出报告时手机不会下载它们；手机始终不下载运行环境。

## 同步与持久保存

- `GET /api/lan/info`：服务版本、固定房间、电脑地址。
- `POST /api/lan/host`：创建新的写入会话；手机和电脑均可申请写入会话。其他操作窗口持续作为镜像跟随。刷新只恢复仍有效的会话，不自动接管其他设备。
- `POST /api/lan/snapshot`：完整快照、会话和客户端递增序号。串行写文件、flush、原子替换后才确认。重复或旧序号不会覆盖新记录。
- `GET /api/lan/state`：最长 10 秒的变化等待。游标含进程启动标识；客户端应用快照后携带已应用版本，桌面据此显示跟随进度。
- `POST /api/lan/shutdown`：本机主动退出，等待当前保存完成。

操作会话持久保存设备、浏览器标签页会话、写入凭据和操作权版本。显式切换使用期望版本和幂等 claimId，晚到的旧请求不能反向抢回。已切换的写入请求返回 409，客户端停止写入并从版本 0 跟随。

浏览器将刷新凭据保存在 sessionStorage；待发送快照按 writerId 单独保存，镜像不会覆盖它。只有相同写入会话恢复成功且客户端序号高于已保存序号才重发；已确认的重复快照不再上传。新的操作会话清理旧撤回历史，刷新同一会话保留撤回能力。进程退出仍只能由本机电脑发起。

客户端同时最多一个等待请求、一个写入请求；编辑合并 100 毫秒后上传，失败重试只保留最新完整状态。请求超时 16 秒，重试间隔上限 5 秒。刷新时手机从版本 0 读取最新保存状态。电脑刷新优先读取服务器存档；有尚未确认的本机编辑时先恢复本地待发送状态。房间和写入会话随存档保留，进程重启后旧网页可以继续重连。

启动在绑定固定端口成功后才写初始文件，重复启动不会覆盖活跃进程记录；同版已运行时启动器直接打开本机网页；显式运行更高版本时，等待旧版保存退出后启动新版，避免下载新版却仍打开旧服务。端口被其他软件占用时显示启动失败；不换成随机端口让旧二维码失效。存档读取失败时拒绝覆盖原文件。正常保存最大 2 MiB，超限保留现有存档并显示失败。

数据保存在系统应用数据目录（可用 `VICTORYPVI_DATA_DIR` 覆盖以隔离测试），不保存在程序包。端口可用 `VICTORYPVI_PORT` 覆盖用于开发；正式入口固定 8787。

## 边界

电脑模式下电脑需保持运行和联网，休眠期间不会更新；纯手机模式不需要电脑。手机浏览器在后台可能被系统暂停，回前台后会重连。更换网络/IP 后重扫二维码；开启设备隔离的访客 Wi-Fi 不能互访，改用允许互访的 Wi-Fi / 热点。二维码中没有在线服务或外网地址。

发布包未商业签名或公证，系统首次打开可能需要允许；Mac 包仅本地 ad-hoc 签名。Mac 支持 13.5+ Intel/Apple Silicon；Windows 包为 10/11 x64。真实 iOS/Android 和 Windows 设备仍需验收，浏览器模拟不能代替系统级测试。

## 构建与发布

Node 固定版本 24.11.1。从 nodejs.org 下载运行环境与 SHASUMS256.txt，先校验 SHA256，把完整 Node LICENSE 保存到 `output/desktop/runtime/Node-LICENSE.txt`。不要把测试存档放入应用或发布包。

```sh
node tests/single-vein-isolation-smoke.mjs
node tests/report-export-smoke.mjs
node tests/sync-client-smoke.mjs
node tests/sync-worker-smoke.mjs
node tests/mobile-operator-smoke.mjs
node tests/direct-sync-smoke.mjs
node desktop/build.mjs --platform darwin --runtime /path/to/universal/node
VICTORYPVI_CC=x86_64-w64-mingw32-gcc node desktop/build.mjs --platform win32 --runtime /path/to/node.exe
```

Windows 构建也支持在 Windows 上使用 MinGW GCC；Mac 打包需要 macOS 的 codesign/ditto。Mac 通用 runtime 可用官方 darwin-arm64、darwin-x64 二进制通过 lipo 合并。

产物 `output/desktop/VictoryPVI-macOS.zip`、`VictoryPVI-Windows-x64.zip`；相应 Release 标签为 `desktop-v<版本号>`。发布包附完整应用代码、启动器源码和许可证；更新版本时同步修改网页下载链接。程序不自动联网升级，用户按需从 GitHub 下载新版本。
