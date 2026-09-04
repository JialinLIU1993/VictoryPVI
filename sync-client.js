/*
 * VictoryPVI real-time sync client.
 *
 * The browser owns the room key. The Cloudflare Worker only receives the
 * access token and already-encrypted snapshots, so the sync service never
 * needs to parse the clinical record payload.
 */
(function installVictoryPVISyncClient(global) {
  "use strict";

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const CLIENT_FORMAT = "victorypvi-sync-link";
  const CLIENT_VERSION = 1;
  const SNAPSHOT_MAX_BYTES = 1_500_000;
  const HTTPS_POLL_INTERVAL_MS = 3_000;

  function requireCrypto() {
    if (!global.crypto?.subtle || typeof global.crypto.getRandomValues !== "function") {
      throw new Error("当前设备不支持加密同步，请使用 HTTPS 或现代浏览器");
    }
    return global.crypto;
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return global.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }

  function base64UrlToBytes(value) {
    const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = global.atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    requireCrypto().getRandomValues(bytes);
    return bytes;
  }

  function randomId() {
    if (typeof global.crypto?.randomUUID === "function") return global.crypto.randomUUID();
    return bytesToBase64Url(randomBytes(16));
  }

  function normalizeWorkerUrl(value) {
    const raw = String(value || "").trim().replace(/\/+$/, "");
    if (!raw) throw new Error("请先填写 Cloudflare Worker 地址");
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("Worker 地址格式不正确");
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error("Worker 地址必须使用 HTTPS");
    }
    return parsed.toString().replace(/\/+$/, "");
  }

  function toWebSocketUrl(workerUrl) {
    return normalizeWorkerUrl(workerUrl).replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  }

  async function sha256Hex(value) {
    const digest = await requireCrypto().subtle.digest("SHA-256", textEncoder.encode(String(value)));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function importRoomKey(roomKey) {
    const keyBytes = base64UrlToBytes(roomKey);
    if (keyBytes.length !== 32) throw new Error("同步密钥无效");
    return requireCrypto().subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async function encryptJson(roomKey, value) {
    const iv = randomBytes(12);
    const plaintext = textEncoder.encode(JSON.stringify(value));
    const ciphertext = await requireCrypto().subtle.encrypt(
      { name: "AES-GCM", iv },
      roomKey,
      plaintext,
    );
    if (ciphertext.byteLength > SNAPSHOT_MAX_BYTES) {
      throw new Error("同步记录过大，请先清理不必要的历史数据");
    }
    return {
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    };
  }

  async function decryptJson(roomKey, iv, ciphertext) {
    const plaintext = await requireCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(iv) },
      roomKey,
      base64UrlToBytes(ciphertext),
    );
    return JSON.parse(textDecoder.decode(plaintext));
  }

  function encodePairingPayload(payload) {
    return `VPVI1.${bytesToBase64Url(textEncoder.encode(JSON.stringify(payload)))}`;
  }

  function decodePairingPayload(value) {
    let raw = String(value || "").trim();
    if (!raw) throw new Error("请输入配对码");
    if (raw.includes("#")) {
      try {
        raw = new URL(raw).hash.replace(/^#/, "");
      } catch {
        raw = raw.slice(raw.indexOf("#") + 1);
      }
    }
    raw = decodeURIComponent(raw).replace(/^sync=/, "");
    if (!raw.startsWith("VPVI1.")) throw new Error("配对码格式不正确");
    let payload;
    try {
      payload = JSON.parse(textDecoder.decode(base64UrlToBytes(raw.slice("VPVI1.".length))));
    } catch {
      throw new Error("配对码无法解析或已损坏");
    }
    if (
      payload?.format !== CLIENT_FORMAT ||
      payload.version !== CLIENT_VERSION ||
      typeof payload.workerUrl !== "string" ||
      typeof payload.roomId !== "string" ||
      typeof payload.accessToken !== "string" ||
      typeof payload.roomKey !== "string"
    ) {
      throw new Error("配对码版本不兼容");
    }
    normalizeWorkerUrl(payload.workerUrl);
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(payload.roomId)) throw new Error("配对码中的同步空间无效");
    if (base64UrlToBytes(payload.accessToken).length !== 32) throw new Error("配对码中的访问令牌无效");
    if (base64UrlToBytes(payload.roomKey).length !== 32) throw new Error("配对码中的同步密钥无效");
    return {
      format: CLIENT_FORMAT,
      version: CLIENT_VERSION,
      workerUrl: normalizeWorkerUrl(payload.workerUrl),
      roomId: payload.roomId,
      accessToken: payload.accessToken,
      roomKey: payload.roomKey,
    };
  }

  class VictoryPVISyncClient {
    constructor({ onSnapshot, onStatus, onError, onPresence } = {}) {
      this.onSnapshot = typeof onSnapshot === "function" ? onSnapshot : () => {};
      this.onStatus = typeof onStatus === "function" ? onStatus : () => {};
      this.onError = typeof onError === "function" ? onError : () => {};
      this.onPresence = typeof onPresence === "function" ? onPresence : () => {};
      this.socket = null;
      this.connection = null;
      this.roomKey = null;
      this.pendingSnapshot = null;
      this.sendQueue = Promise.resolve();
      this.reconnectTimer = null;
      this.reconnectAttempts = 0;
      this.manualDisconnect = false;
      this.transport = "websocket";
      this.pollTimer = null;
      this.pollInFlight = false;
      this.pollErrorShown = false;
      this.lastReceivedRevision = 0;
    }

    static parsePairingCode(value) {
      return decodePairingPayload(value);
    }

    static makePairingCode(details) {
      return encodePairingPayload({
        format: CLIENT_FORMAT,
        version: CLIENT_VERSION,
        workerUrl: normalizeWorkerUrl(details.workerUrl),
        roomId: details.roomId,
        accessToken: details.accessToken,
        roomKey: details.roomKey,
      });
    }

    static makePairingLink(code, pageUrl = global.location?.href || "") {
      try {
        const url = new URL(pageUrl);
        url.hash = `sync=${code}`;
        return url.toString();
      } catch {
        return code;
      }
    }

    get isConnected() {
      if (this.transport === "poll") return Boolean(this.connection) && !this.manualDisconnect;
      return this.socket?.readyState === global.WebSocket?.OPEN;
    }

    get pairingCode() {
      if (!this.connection) return "";
      return encodePairingPayload({
        format: CLIENT_FORMAT,
        version: CLIENT_VERSION,
        workerUrl: this.connection.workerUrl,
        roomId: this.connection.roomId,
        accessToken: this.connection.accessToken,
        roomKey: this.connection.roomKey,
      });
    }

    async createRoom(workerUrl) {
      const normalizedWorkerUrl = normalizeWorkerUrl(workerUrl);
      const roomId = randomId();
      const accessToken = bytesToBase64Url(randomBytes(32));
      const roomKey = bytesToBase64Url(randomBytes(32));
      const response = await fetch(`${normalizedWorkerUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId, tokenHash: await sha256Hex(accessToken) }),
      });
      if (!response.ok) {
        let message = "无法创建同步空间";
        try {
          message = (await response.json()).error || message;
        } catch {
          // Keep the safe generic message.
        }
        throw new Error(message);
      }
      const details = { workerUrl: normalizedWorkerUrl, roomId, accessToken, roomKey };
      await this.connect({ ...details, role: "host" });
      return details;
    }

    async connect({ workerUrl, roomId, accessToken, roomKey, role = "mirror", deviceId = randomId(), deviceName = "未命名设备" }) {
      this.stopPolling();
      this.disconnect({ silent: true });
      const normalizedWorkerUrl = normalizeWorkerUrl(workerUrl);
      const normalizedRoomId = String(roomId || "");
      if (!/^[A-Za-z0-9_-]{16,80}$/.test(normalizedRoomId)) throw new Error("同步空间无效");
      if (base64UrlToBytes(accessToken).length !== 32) throw new Error("访问令牌无效");
      const normalizedRoomKey = String(roomKey || "");
      this.roomKey = await importRoomKey(normalizedRoomKey);
      this.connection = {
        workerUrl: normalizedWorkerUrl,
        roomId: normalizedRoomId,
        accessToken,
        roomKey: normalizedRoomKey,
        role: role === "host" ? "host" : "mirror",
        deviceId: String(deviceId || randomId()).slice(0, 80),
        deviceName: String(deviceName || "未命名设备").slice(0, 80),
      };
      this.manualDisconnect = false;
      this.reconnectAttempts = 0;
      this.transport = "websocket";
      this.lastReceivedRevision = 0;
      try {
        return await this.openSocket();
      } catch (error) {
        if (!this.connection || this.manualDisconnect) throw error;
        const failedSocket = this.socket;
        this.socket = null;
        try {
          if (failedSocket && failedSocket.readyState < global.WebSocket.CLOSING) failedSocket.close(1000, "use https fallback");
        } catch {
          // The socket may not have completed its handshake.
        }
        await this.startPolling();
      }
    }

    openSocket() {
      if (!this.connection) throw new Error("尚未配置同步空间");
      this.transport = "websocket";
      this.onStatus({ state: "connecting", role: this.connection.role, transport: "websocket" });
      const { workerUrl, roomId, accessToken, role, deviceId, deviceName } = this.connection;
      const endpoint = `${toWebSocketUrl(workerUrl)}/api/rooms/${encodeURIComponent(roomId)}/ws?token=${encodeURIComponent(accessToken)}&role=${encodeURIComponent(role)}&device=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(deviceName)}`;
      const socket = new WebSocket(endpoint);
      this.socket = socket;
      return new Promise((resolve, reject) => {
        let settled = false;
        socket.addEventListener("open", () => {
          settled = true;
          this.reconnectAttempts = 0;
          this.onStatus({ state: "connected", role: this.connection?.role, transport: "websocket" });
          socket.send(JSON.stringify({ type: "hello", cursor: 0 }));
          this.flushSnapshot();
          resolve();
        }, { once: true });
        socket.addEventListener("message", (event) => this.handleMessage(event.data));
        socket.addEventListener("error", () => {
          if (!settled) {
            settled = true;
            reject(new Error("无法连接 Cloudflare 同步服务"));
          }
          this.onStatus({ state: "error", role: this.connection?.role, transport: "websocket" });
        });
        socket.addEventListener("close", (event) => {
          if (!settled) {
            settled = true;
            reject(new Error(event.reason || "同步连接被关闭"));
          }
          this.socket = null;
          if (!this.manualDisconnect && this.connection && this.transport === "websocket") {
            this.onStatus({ state: "offline", role: this.connection.role, transport: "websocket" });
            this.scheduleReconnect();
          }
        });
      });
    }

    snapshotEndpoint() {
      if (!this.connection) throw new Error("尚未配置同步空间");
      const { workerUrl, roomId, accessToken, role, deviceId, deviceName } = this.connection;
      return `${workerUrl}/api/rooms/${encodeURIComponent(roomId)}/snapshot?token=${encodeURIComponent(accessToken)}&role=${encodeURIComponent(role)}&device=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(deviceName)}`;
    }

    async startPolling() {
      if (!this.connection) throw new Error("尚未配置同步空间");
      if (this.reconnectTimer) {
        global.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.transport = "poll";
      this.reconnectAttempts = 0;
      this.pollErrorShown = false;
      this.onStatus({ state: "connecting", role: this.connection.role, transport: "https-poll" });
      await this.pollSnapshot({ reportError: true });
      if (!this.manualDisconnect && this.connection && !this.pollTimer) {
        this.onStatus({ state: "connected", role: this.connection.role, transport: "https-poll" });
        this.pollTimer = global.setInterval(() => this.pollSnapshot(), HTTPS_POLL_INTERVAL_MS);
        this.flushSnapshot();
      }
    }

    stopPolling() {
      if (this.pollTimer) {
        global.clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.pollInFlight = false;
    }

    async pollSnapshot({ reportError = false } = {}) {
      if (!this.connection || this.manualDisconnect || this.pollInFlight) return;
      this.pollInFlight = true;
      try {
        const response = await fetch(this.snapshotEndpoint(), {
          method: "GET",
          cache: "no-store",
        });
        if (!response.ok) {
          let message = "无法通过 HTTPS 访问 Cloudflare 同步服务";
          try {
            message = (await response.json()).error || message;
          } catch {
            // Keep the safe generic message.
          }
          throw new Error(message);
        }
        const body = await response.json();
        this.onPresence(body.peers || []);
        if (body.snapshot && Number(body.snapshot.revision) > this.lastReceivedRevision) {
          await this.handleSnapshotEnvelope({ type: "snapshot", ...body.snapshot });
        }
        this.pollErrorShown = false;
        this.onStatus({
          state: "connected",
          role: this.connection?.role,
          transport: "https-poll",
          peerCount: Array.isArray(body.peers) ? body.peers.length : 0,
        });
        if (this.connection?.role === "host" && this.pendingSnapshot) this.flushSnapshot();
      } catch (error) {
        this.onStatus({ state: "offline", role: this.connection?.role, transport: "https-poll" });
        if (reportError || !this.pollErrorShown) {
          this.pollErrorShown = true;
          this.onError(error);
        }
      } finally {
        this.pollInFlight = false;
      }
    }

    async handleMessage(rawMessage) {
      let message;
      try {
        message = JSON.parse(typeof rawMessage === "string" ? rawMessage : textDecoder.decode(rawMessage));
      } catch {
        this.onError(new Error("同步服务返回了无法识别的消息"));
        return;
      }
      if (message.type === "ready") {
        this.onPresence(message.peers || []);
        return;
      }
      if (message.type === "presence") {
        this.onPresence(message.peers || []);
        return;
      }
      if (message.type === "ack") {
        this.onStatus({ state: "synced", role: this.connection?.role, revision: message.revision, peerCount: message.peerCount });
        return;
      }
      if (message.type === "error") {
        this.onError(new Error(message.error || "同步服务处理失败"));
        return;
      }
      if (message.type !== "snapshot" || !this.roomKey) return;
      await this.handleSnapshotEnvelope(message);
    }

    async handleSnapshotEnvelope(message) {
      const revision = Number(message.revision) || 0;
      if (revision && revision <= this.lastReceivedRevision) return;
      try {
        const payload = await decryptJson(this.roomKey, message.iv, message.ciphertext);
        this.lastReceivedRevision = Math.max(this.lastReceivedRevision, revision);
        this.onSnapshot(payload, message);
      } catch {
        this.onError(new Error("同步数据解密失败，请重新配对"));
      }
    }

    sendSnapshot(payload, revision) {
      if (!this.connection || this.connection.role !== "host") return;
      this.pendingSnapshot = {
        payload,
        revision: Math.max(1, Number(revision) || 1),
      };
      this.flushSnapshot();
    }

    flushSnapshot() {
      if (!this.pendingSnapshot || !this.connection || this.connection.role !== "host") return;
      if (this.transport === "poll") {
        this.flushHttpSnapshot();
        return;
      }
      if (!this.isConnected) return;
      this.sendQueue = this.sendQueue.then(async () => {
        if (!this.pendingSnapshot || !this.isConnected || !this.connection) return;
        const next = this.pendingSnapshot;
        this.pendingSnapshot = null;
        const encrypted = await encryptJson(this.roomKey, next.payload);
        if (!this.isConnected) {
          this.pendingSnapshot = next;
          return;
        }
        this.socket.send(JSON.stringify({
          type: "snapshot",
          revision: next.revision,
          updatedAt: new Date().toISOString(),
          ...encrypted,
        }));
      }).catch((error) => this.onError(error));
    }

    flushHttpSnapshot() {
      if (!this.pendingSnapshot || !this.isConnected || !this.connection || this.connection.role !== "host") return;
      this.sendQueue = this.sendQueue.then(async () => {
        if (!this.pendingSnapshot || !this.isConnected || !this.connection || this.transport !== "poll") return;
        const next = this.pendingSnapshot;
        this.pendingSnapshot = null;
        try {
          const encrypted = await encryptJson(this.roomKey, next.payload);
          const response = await fetch(this.snapshotEndpoint(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({
              type: "snapshot",
              revision: next.revision,
              updatedAt: new Date().toISOString(),
              ...encrypted,
            }),
          });
          if (!response.ok) {
            let message = "无法通过 HTTPS 发送同步状态";
            try {
              message = (await response.json()).error || message;
            } catch {
              // Keep the safe generic message.
            }
            throw new Error(message);
          }
          const ack = await response.json();
          this.onStatus({
            state: "synced",
            role: this.connection?.role,
            revision: ack.revision,
            peerCount: ack.peerCount,
            transport: "https-poll",
          });
        } catch (error) {
          if (!this.pendingSnapshot || this.pendingSnapshot.revision < next.revision) {
            this.pendingSnapshot = next;
          }
          this.onError(error);
        }
      }).catch((error) => this.onError(error));
    }

    scheduleReconnect() {
      if (this.reconnectTimer || !this.connection || this.manualDisconnect || this.transport !== "websocket") return;
      const delay = Math.min(30_000, 1_000 * (2 ** Math.min(this.reconnectAttempts, 5)));
      this.reconnectAttempts += 1;
      this.reconnectTimer = global.setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.connection || this.manualDisconnect) return;
        this.openSocket().catch(() => {
          // If the WebSocket path is unavailable, keep the session alive over HTTPS.
          if (this.connection && !this.manualDisconnect && this.transport === "websocket") this.startPolling();
        });
      }, delay);
    }

    disconnect({ silent = false } = {}) {
      this.manualDisconnect = true;
      this.stopPolling();
      if (this.reconnectTimer) {
        global.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const socket = this.socket;
      this.socket = null;
      if (socket && socket.readyState < global.WebSocket.CLOSING) socket.close(1000, "client disconnect");
      if (!silent) this.onStatus({ state: "disconnected", role: this.connection?.role, transport: this.transport });
    }
  }

  global.VictoryPVISyncClient = VictoryPVISyncClient;
})(window);
