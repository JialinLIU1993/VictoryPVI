# Cloudflare 免费层同步服务

该 Worker 使用 Durable Objects 的 SQLite 存储和 WebSocket 连接，为 VictoryPVI 提供配对后的实时状态广播。Cloudflare Workers Free 目前支持 SQLite-backed Durable Objects；免费层的 Worker 请求和 Durable Object 存储/请求有每日额度，适合小规模设备同步。实际额度以 Cloudflare 控制台为准。

页面默认优先使用 WebSocket；如果 iOS 微信内置浏览器限制 WebSocket，客户端会自动切换为 HTTPS 轮询和加密快照推送，不依赖浏览器打印或本地后台服务。

如果用户所在网络访问 Cloudflare 困难，可在 VictoryPVI“设备同步”中选择“本地直连”：两台设备加入同一 Wi‑Fi 或手机热点，通过 WebRTC DataChannel 直接传输，不经过本 Worker。该模式只支持当前浏览器提供 WebRTC 的设备，且页面刷新后需要重新配对。

## 部署

在已安装 Node.js 的设备上执行：

```bash
npx wrangler login
npx wrangler deploy --config cloudflare/wrangler.jsonc
```

部署完成后会得到一个 `https://victorypvi-sync.<账户子域>.workers.dev` 地址。将该地址填入 VictoryPVI 页面“设备同步”中的“Cloudflare Worker 地址”，之后创建配对即可。

## 运行方式

- 操作端创建一个同步空间，浏览器生成随机访问令牌和 256 位房间密钥；
- Worker 只保存密文快照和 revision，不接收房间密钥；
- 配对二维码把 Worker 地址、空间令牌和房间密钥放入应用链接的 `#` 片段，片段不会随 HTTP 请求发送给 Worker；镜像端扫描操作端二维码即可加入，不设置双向扫码；页面摄像头识别失败时仍可展开备用代码；
- 操作端每次状态变化发送一份加密快照，Durable Object 立即广播给所有镜像设备；
- 镜像设备解密后更新本地肺静脉图和消融概览，无需刷新；
- 重连时 Durable Object 返回最后一份快照，保证镜像设备恢复到最新状态；
- WebSocket 不可用时，操作端通过 HTTPS 写入快照，镜像端每 3 秒拉取一次最新状态。

## 安全边界

患者姓名、病案号、PDF 和报告中的其它患者信息不进入同步快照。同步内容在浏览器端使用 AES-GCM 加密，Worker 只负责鉴权、保存和广播密文。二维码或备用配对码应当像密码一样保管，不要在公开聊天中转发。

该 Worker 没有账号系统；随机空间 ID 和访问令牌负责空间隔离。若用于机构环境，建议在 Cloudflare Access 或机构网络层增加访问控制，并配置自己的 Worker 域名。

## 本地测试

```bash
npx wrangler dev --config cloudflare/wrangler.jsonc
```

前端需要把 Worker 地址改为 Wrangler 本地地址，例如 `http://127.0.0.1:8787`。本地开发只用于测试，生产配对码应使用 HTTPS Worker 地址。
