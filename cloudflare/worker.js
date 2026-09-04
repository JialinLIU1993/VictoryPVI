import { DurableObject } from "cloudflare:workers";

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MESSAGE_BYTES = 1_500_000;
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const textEncoder = new TextEncoder();

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

function isUpgradeRequest(request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function decodeMessage(message) {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  return new TextDecoder().decode(message);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeDeviceName(value) {
  return String(value || "未命名设备").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80) || "未命名设备";
}

function normalizeDeviceId(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "unknown";
}

function snapshotIsValid(message) {
  if (!message || message.type !== "snapshot") return false;
  if (!Number.isInteger(message.revision) || message.revision < 1) return false;
  if (typeof message.updatedAt !== "string") return false;
  if (!/^[A-Za-z0-9_-]+$/.test(message.iv || "")) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(message.ciphertext || "")) return false;
  const encodedSize = String(message.ciphertext).length;
  return encodedSize > 0 && encodedSize <= MAX_MESSAGE_BYTES * 2;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "victorypvi-sync", protocol: 1 });
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse("请求内容不是有效 JSON");
      }
      const roomId = String(body?.roomId || "");
      const tokenHash = String(body?.tokenHash || "");
      if (!ROOM_ID_PATTERN.test(roomId) || !TOKEN_HASH_PATTERN.test(tokenHash)) {
        return errorResponse("同步空间参数无效");
      }
      const id = env.SYNC_ROOM.idFromName(roomId);
      const stub = env.SYNC_ROOM.get(id);
      const response = await stub.fetch("https://sync-room.internal/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId, tokenHash }),
      });
      return new Response(response.body, {
        status: response.status,
        headers: { ...corsHeaders(), "content-type": "application/json; charset=utf-8" },
      });
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{16,80})(?:\/(ws|snapshot))?$/);
    if (!roomMatch) return errorResponse("找不到同步接口", 404);
    const roomId = roomMatch[1];
    const action = roomMatch[2] || "snapshot";
    const token = url.searchParams.get("token") || "";
    if (!token) return errorResponse("缺少同步访问令牌", 401);

    const id = env.SYNC_ROOM.idFromName(roomId);
    const stub = env.SYNC_ROOM.get(id);
    if (action === "ws" && isUpgradeRequest(request)) {
      return stub.fetch(new Request(`https://sync-room.internal/ws?${url.searchParams.toString()}`, request));
    }
    if (request.method === "GET" && action === "snapshot") {
      const response = await stub.fetch(`https://sync-room.internal/snapshot?token=${encodeURIComponent(token)}`);
      return new Response(response.body, {
        status: response.status,
        headers: { ...corsHeaders(), "content-type": "application/json; charset=utf-8" },
      });
    }
    if (request.method === "DELETE" && action === "snapshot") {
      const response = await stub.fetch(`https://sync-room.internal/delete?token=${encodeURIComponent(token)}`, { method: "DELETE" });
      return new Response(response.body, {
        status: response.status,
        headers: { ...corsHeaders(), "content-type": "application/json; charset=utf-8" },
      });
    }
    return errorResponse("不支持的同步请求", 405);
  },
};

export class SyncRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async getMeta() {
    return (await this.ctx.storage.get("meta")) || null;
  }

  async authenticate(token) {
    const meta = await this.getMeta();
    if (!meta || meta.expiresAt <= Date.now()) return null;
    const tokenHash = await sha256Hex(token);
    return meta.tokenHash === tokenHash ? meta : null;
  }

  connectedDevices() {
    return this.ctx.getWebSockets().map((socket) => socket.deserializeAttachment() || {});
  }

  broadcast(message) {
    const serialized = JSON.stringify(message);
    this.ctx.getWebSockets().forEach((socket) => {
      try {
        socket.send(serialized);
      } catch {
        try {
          socket.close(1011, "broadcast failed");
        } catch {
          // The socket is already closed.
        }
      }
    });
  }

  broadcastPresence() {
    const peers = this.connectedDevices().map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      role: device.role,
    }));
    this.broadcast({ type: "presence", peers });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/create" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "请求内容不是有效 JSON" }, 400);
      }
      const roomId = String(body?.roomId || "");
      const tokenHash = String(body?.tokenHash || "");
      if (!ROOM_ID_PATTERN.test(roomId) || !TOKEN_HASH_PATTERN.test(tokenHash)) {
        return jsonResponse({ error: "同步空间参数无效" }, 400);
      }
      const current = await this.getMeta();
      if (current && current.expiresAt > Date.now() && current.tokenHash !== tokenHash) {
        return jsonResponse({ error: "同步空间已存在" }, 409);
      }
      if (current && current.expiresAt <= Date.now()) {
        await this.ctx.storage.deleteAll();
      }
      const meta = {
        roomId,
        tokenHash,
        createdAt: current?.createdAt || new Date().toISOString(),
        expiresAt: Date.now() + ROOM_TTL_MS,
      };
      await this.ctx.storage.put("meta", meta);
      await this.ctx.storage.setAlarm(meta.expiresAt);
      return jsonResponse({ ok: true, roomId, expiresAt: meta.expiresAt });
    }

    const token = url.searchParams.get("token") || "";
    const meta = await this.authenticate(token);
    if (!meta) return jsonResponse({ error: "同步空间不存在、已过期或令牌无效" }, 401);

    if (url.pathname === "/snapshot" && request.method === "GET") {
      const snapshot = await this.ctx.storage.get("snapshot");
      return jsonResponse({
        ok: true,
        snapshot: snapshot || null,
        peers: this.connectedDevices().map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          role: device.role,
        })),
      });
    }

    if (url.pathname === "/delete" && request.method === "DELETE") {
      await this.ctx.storage.deleteAll();
      this.ctx.getWebSockets().forEach((socket) => {
        try {
          socket.close(1000, "sync room deleted");
        } catch {
          // The socket is already closed.
        }
      });
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/ws" && request.method === "GET" && isUpgradeRequest(request)) {
      const role = url.searchParams.get("role") === "host" ? "host" : "mirror";
      const deviceId = normalizeDeviceId(url.searchParams.get("device"));
      const deviceName = normalizeDeviceName(url.searchParams.get("name"));
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [role, deviceId]);
      server.serializeAttachment({ role, deviceId, deviceName });
      const snapshot = await this.ctx.storage.get("snapshot");
      server.send(JSON.stringify({ type: "ready", peers: this.connectedDevices() }));
      if (snapshot) server.send(JSON.stringify({ type: "snapshot", ...snapshot }));
      this.broadcastPresence();
      return new Response(null, { status: 101, webSocket: client });
    }

    return jsonResponse({ error: "不支持的同步请求" }, 405);
  }

  async webSocketMessage(webSocket, message) {
    const attachment = webSocket.deserializeAttachment() || {};
    let parsed;
    try {
      parsed = JSON.parse(decodeMessage(message));
    } catch {
      webSocket.send(JSON.stringify({ type: "error", error: "同步消息格式无效" }));
      return;
    }

    if (parsed.type === "hello") {
      const snapshot = await this.ctx.storage.get("snapshot");
      webSocket.send(JSON.stringify({ type: "ready", peers: this.connectedDevices() }));
      if (snapshot) webSocket.send(JSON.stringify({ type: "snapshot", ...snapshot }));
      return;
    }

    if (parsed.type !== "snapshot") return;
    if (attachment.role !== "host") {
      webSocket.send(JSON.stringify({ type: "error", error: "配对设备为只读镜像" }));
      return;
    }
    if (!snapshotIsValid(parsed)) {
      webSocket.send(JSON.stringify({ type: "error", error: "同步快照无效或过大" }));
      return;
    }
    const current = await this.ctx.storage.get("snapshot");
    if (current && parsed.revision <= current.revision) {
      webSocket.send(JSON.stringify({ type: "ack", revision: current.revision, peerCount: this.ctx.getWebSockets().length - 1 }));
      return;
    }
    const snapshot = {
      revision: parsed.revision,
      updatedAt: parsed.updatedAt,
      iv: parsed.iv,
      ciphertext: parsed.ciphertext,
      sourceDeviceId: attachment.deviceId,
    };
    await this.ctx.storage.put("snapshot", snapshot);
    const meta = await this.getMeta();
    if (meta) {
      const nextMeta = { ...meta, expiresAt: Date.now() + ROOM_TTL_MS };
      await this.ctx.storage.put("meta", nextMeta);
      await this.ctx.storage.setAlarm(nextMeta.expiresAt);
    }
    this.broadcast({ type: "snapshot", ...snapshot });
    webSocket.send(JSON.stringify({
      type: "ack",
      revision: snapshot.revision,
      peerCount: Math.max(0, this.ctx.getWebSockets().length - 1),
    }));
  }

  webSocketClose() {
    this.broadcastPresence();
  }

  webSocketError() {
    this.broadcastPresence();
  }

  async alarm() {
    const meta = await this.getMeta();
    if (!meta || meta.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      this.ctx.getWebSockets().forEach((socket) => {
        try {
          socket.close(1000, "sync room expired");
        } catch {
          // The socket is already closed.
        }
      });
      return;
    }
    await this.ctx.storage.setAlarm(meta.expiresAt);
  }
}
