import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVICE = 'VictoryPVI-LAN-1';
export const DEFAULT_PORT = 8787;
const LIMIT = 2 * 1024 * 1024;
const loopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
export function defaultDataDir() {
  return process.env.VICTORYPVI_DATA_DIR || path.join(process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share'), 'VictoryPVI');
}
export function lanUrls(port, roomId) {
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => entries
    .filter(e => e.family === 'IPv4' && !e.internal && !e.address.startsWith('169.254.'))
    .map(e => ({ name, address: e.address, priority: /^(en\d|eth|wlan|Wi-Fi|Ethernet)/i.test(name) ? 0 : 1 })))
    .sort((a, b) => a.priority - b.priority)
    .map(e => ({ name: e.name, url: `http://${e.address}:${port}/?join=${roomId}` }));
}
async function readBody(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > LIMIT) throw failure('记录过大，未覆盖已保存记录。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw failure('请求内容无效。'); }
}
function cleanPayload(payload) {
  if (!payload || Array.isArray(payload) || !Number.isInteger(payload.schemaVersion)
    || payload.schemaVersion < 1 || payload.schemaVersion > 7 || !payload.counts || typeof payload.counts !== 'object') {
    throw failure('记录格式或版本不兼容，请更新客户端。');
  }
  // Only the record model is saved. Report/patient fields never enter the LAN snapshot.
  return Object.fromEntries(['schemaVersion', 'counts', 'applications', 'ridgeApplications', 'sequenceEvents',
    'endpoints', 'settings', 'electrodeSelection', 'lastOperation'].filter(k => k in payload).map(k => [k, payload[k]]));
}

export async function createLanServer({ root = ROOT, dataDir = defaultDataDir(), port = DEFAULT_PORT,
  bind = '0.0.0.0', pollMs = 10000, leaseMs = 35000 } = {}) {
  await fs.mkdir(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, 'record.json');
  let state;
  try {
    state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (state.service !== SERVICE || !state.roomId || !Number.isInteger(state.revision)) throw new Error('Invalid saved state');
    if (state.snapshot) cleanPayload(state.snapshot.payload);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取已保存记录，文件已保留：${stateFile}。${error.message}`);
    state = { service: SERVICE, roomId: randomUUID().slice(0, 8), revision: 0, writerId: '', clientRevision: 0, snapshot: null };
  }
  async function persist(next) {
    const temp = `${stateFile}.tmp`;
    const file = await fs.open(temp, 'w');
    try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temp, stateFile);
    state = next;
  }
  let ready;
  let queue = Promise.resolve();
  const mutate = task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
  const boot = randomUUID();
  let sequence = 0, actualPort = port;
  const peers = new Map(), waiting = new Set();
  const cursor = () => `${boot}:${sequence}`;
  const notify = () => { sequence++; for (const complete of [...waiting]) complete(); };
  const json = (res, value, status = 200) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  function view(query) {
    const writer = query.get('writerId');
    const host = query.get('role') === 'host' && writer === state.writerId;
    return { cursor: cursor(), roomId: state.roomId, revision: state.revision,
      superseded: query.get('role') === 'host' && !host,
      snapshot: Number(query.get('appliedRevision')) === state.revision ? null : state.snapshot,
      hostOnline: [...peers.values()].some(p => p.writerId === state.writerId && p.role === 'host'),
      peers: [...peers.values()].filter(p => p.role === 'mirror' || p.writerId === state.writerId)
        .map(({ deviceId, role, appliedRevision }) => ({ deviceId, role, appliedRevision })),
      urls: host ? lanUrls(actualPort, state.roomId) : [] };
  }
  const timer = setInterval(() => {
    let changed = false;
    for (const [id, peer] of peers) if (Date.now() - peer.lastSeen > leaseMs) { peers.delete(id); changed = true; }
    if (changed) notify();
  }, Math.min(5000, leaseMs));
  timer.unref();
  const release = JSON.parse(await fs.readFile(path.join(root, 'release.json'), 'utf8'));
  const server = http.createServer(async (req, res) => {
    try {
      await ready;
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/lan/info' && req.method === 'GET') {
        return json(res, { service: SERVICE, version: release.version, roomId: state.roomId,
          hostAllowed: loopback(req), urls: lanUrls(actualPort, state.roomId) });
      }
      if (url.pathname === '/api/lan/host' && req.method === 'POST') {
        if (!loopback(req)) throw failure('请在主机电脑上操作，手机只读跟随。', 403);
        const body = await readBody(req);
        if (!body.deviceId) throw failure('设备信息缺失。');
        return await mutate(async () => {
          await persist({ ...state, writerId: randomUUID(), clientRevision: 0 });
          notify();
          json(res, { writerId: state.writerId, roomId: state.roomId, snapshot: state.snapshot });
        });
      }
      if (url.pathname === '/api/lan/snapshot' && req.method === 'POST') {
        if (!loopback(req)) throw failure('请在主机电脑上操作。', 403);
        const body = await readBody(req);
        return await mutate(async () => {
          if (!body.writerId || body.writerId !== state.writerId) throw failure('已在另一个窗口继续操作，本窗口转为只读。', 409);
          if (!Number.isSafeInteger(body.clientRevision) || body.clientRevision < 1) throw failure('记录序号无效。');
          if (body.clientRevision > state.clientRevision) {
            const revision = state.revision + 1;
            const snapshot = { revision, updatedAt: new Date().toISOString(), payload: cleanPayload(body.payload) };
            await persist({ ...state, revision, clientRevision: body.clientRevision, snapshot });
            notify();
          }
          json(res, { revision: state.revision, clientRevision: state.clientRevision, updatedAt: state.snapshot.updatedAt });
        });
      }
      if (url.pathname === '/api/lan/state' && req.method === 'GET') {
        const q = url.searchParams;
        if (q.get('roomId') !== state.roomId) throw failure('这是另一台电脑的连接，请扫描当前电脑上的二维码。', 404);
        const id = q.get('sessionId');
        if (!id || !q.get('deviceId')) throw failure('设备信息缺失。');
        const previous = peers.get(id);
        const peer = { deviceId: q.get('deviceId'), role: q.get('role') === 'host' ? 'host' : 'mirror',
          writerId: q.get('writerId'), appliedRevision: Number(q.get('appliedRevision')) || 0, lastSeen: Date.now() };
        peers.set(id, peer);
        if (!previous || previous.appliedRevision !== peer.appliedRevision || previous.role !== peer.role) notify();
        if (q.get('cursor') !== cursor()) return json(res, view(q));
        let timeout;
        const finish = () => { clearTimeout(timeout); waiting.delete(finish); json(res, view(q)); };
        waiting.add(finish);
        timeout = setTimeout(finish, pollMs);
        res.on('close', () => { clearTimeout(timeout); waiting.delete(finish); });
        return;
      }
      if (url.pathname === '/api/lan/shutdown' && req.method === 'POST') {
        if (!loopback(req)) throw failure('请在主机电脑上退出。', 403);
        await queue;
        json(res, { ok: true });
        setTimeout(() => { clearInterval(timer); server.close(); server.closeAllConnections(); }, 100);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw failure('不支持此操作。', 405);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      // Serve the distributed application only; never the data directory or development files.
      if (!['index.html', 'sync-client.js', 'release.json', 'LICENSE', 'NOTICE', 'PRIVACY.md', 'ADDITIONAL_TERMS.md', 'TRADEMARKS.md']
        .includes(relative) && !/^vendor\/[\w.-]+$/.test(relative)) throw failure('页面不存在。', 404);
      let content = await fs.readFile(path.join(root, relative));
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
      if (relative === 'index.html') content = Buffer.from(content.toString().replace('<head>',
        `<head><script>window.VICTORYPVI_DESKTOP={hostAllowed:${loopback(req)}};</script>`));
      res.writeHead(200, { 'Content-Type': `${types[path.extname(relative)] || 'text/plain'}; charset=utf-8`,
        'Cache-Control': 'no-cache', 'Content-Length': content.length });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { json(res, { error: error.code === 'ENOENT' ? '页面不存在。' : error.message }, error.status || (error.code === 'ENOENT' ? 404 : 500)); }
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); }); }
  catch (error) { clearInterval(timer); throw error; }
  ready = persist(state);
  try { await ready; } catch (error) { clearInterval(timer); server.close(); throw error; }
  actualPort = server.address().port;
  server.on('close', () => clearInterval(timer));
  return { server, port: actualPort, roomId: state.roomId, dataDir,
    close: async () => { await queue; clearInterval(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url],
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); child.unref();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.VICTORYPVI_PORT) || DEFAULT_PORT;
  const address = `http://localhost:${port}/?host=1`;
  try {
    // Check before touching the state file: duplicate launches must not overwrite live writes.
    const existing = await fetch(`http://localhost:${port}/api/lan/info`, { signal: AbortSignal.timeout(1000) }).then(r => r.json()).catch(() => null);
    if (existing?.service === SERVICE) { if (process.argv.includes('--open')) openBrowser(address); }
    else {
      const app = await createLanServer({ port });
      console.log(`VictoryPVI: ${address}\nRecords: ${app.dataDir}`);
      if (process.argv.includes('--open')) openBrowser(address);
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close(); });
    }
  } catch (error) {
    const message = error.code === 'EADDRINUSE' ? `端口 ${port} 被其他程序占用，请关闭占用程序后重试。` : error.message;
    console.error(message);
    await fs.mkdir(defaultDataDir(), { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(defaultDataDir(), 'startup-error.txt'), message).catch(() => {});
    process.exitCode = 1;
  }
}
