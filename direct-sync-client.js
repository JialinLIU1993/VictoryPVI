/* VictoryPVI offline browser sync: no server, fetch, WebSocket, STUN or TURN. */
(function installVictoryPVIDirectClient(global) {
  'use strict';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const MAX_SNAPSHOT_BYTES = 1500000;
  const CHUNK_CHARS = 12000;
  const id = () => global.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  function base64(bytes) {
    let value = '';
    for (const byte of bytes) value += String.fromCharCode(byte);
    return global.btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }
  function unbase64(value) {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    return Uint8Array.from(global.atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), (char) => char.charCodeAt(0));
  }
  async function transform(bytes, Stream) {
    const reader = new Blob([bytes]).stream().pipeThrough(new Stream('deflate')).getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 100000) { await reader.cancel(); throw new Error('连接信息过大，请重新生成'); }
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  async function encodePairing(details) {
    const bytes = encoder.encode(JSON.stringify(details));
    // Plain JSON remains available on browsers without compression streams.
    if (global.CompressionStream && global.DecompressionStream) {
      try { return `VPVI2.z.${base64(await transform(bytes, global.CompressionStream))}`; }
      catch { /* Plain format also works if this browser cannot compress. */ }
    }
    return `VPVI2.j.${base64(bytes)}`;
  }
  async function parsePairing(value, type = '') {
    let raw = String(value || '').trim();
    if (raw.includes('#')) raw = raw.slice(raw.indexOf('#') + 1);
    try { raw = decodeURIComponent(raw).replace(/^local=/, ''); } catch { throw new Error('连接码无法识别'); }
    const match = raw.match(/^VPVI2\.([jz])\.([A-Za-z0-9_-]+)$/);
    if (!match) throw new Error('请扫描新版本地连接二维码，或粘贴完整连接码');
    if (raw.length > 140000) throw new Error('连接码过长');
    let bytes = unbase64(match[2]);
    if (match[1] === 'z') {
      if (!global.DecompressionStream) throw new Error('此浏览器不支持压缩连接码，请让对方选择“兼容连接码”');
      bytes = await transform(bytes, global.DecompressionStream);
    }
    let data;
    try { data = JSON.parse(decoder.decode(bytes)); } catch { throw new Error('连接码已损坏，请重新扫描'); }
    if (!data || !['offer', 'answer'].includes(data.type) || (type && data.type !== type) || typeof data.sdp !== 'string' || !data.sdp.startsWith('v=0') || !data.roomId || !data.pairId || !data.deviceId) throw new Error('连接码类型不匹配，请扫描对方当前显示的二维码');
    return data;
  }
  function gatherIce(pc) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error) => {
        global.clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        pc.removeEventListener('signalingstatechange', check);
        if (error) reject(error); else resolve();
      };
      const check = () => {
        if (pc.signalingState === 'closed') finish(new Error('连接已取消'));
        else if (pc.iceGatheringState === 'complete') finish();
      };
      timer = global.setTimeout(() => finish(new Error('收集本地网络信息超时，请确认 Wi-Fi 已连接后重试')), 12000);
      pc.addEventListener('icegatheringstatechange', check);
      pc.addEventListener('signalingstatechange', check);
      check();
    });
  }

  class VictoryPVIDirectClient {
    constructor({ onSnapshot, onStatus, onError, onPresence } = {}) {
      this.onSnapshot = onSnapshot || (() => {});
      this.onStatus = onStatus || (() => {});
      this.onError = onError || (() => {});
      this.onPresence = onPresence || (() => {});
      this.peers = new Map();
      this.connection = null;
      this.latestSnapshot = null;
      this.pendingPeer = null;
      this.manualDisconnect = true;
      this.generation = 0;
      this.receivedRevision = 0;
      this.pairingData = null;
      this.localPairingCode = '';
      this.timer = null;
      this.wake = () => {
        if (!this.manualDisconnect && global.document?.visibilityState !== 'hidden') {
          for (const peer of this.peers.values()) this.send(peer, { type: 'hello', deviceId: this.connection.deviceId, deviceName: this.connection.deviceName, revision: this.receivedRevision });
          this.tick();
        }
      };
      global.addEventListener?.('online', this.wake);
      global.addEventListener?.('pageshow', this.wake);
      global.document?.addEventListener('visibilitychange', this.wake);
    }
    static parseLocalPairingCode(value, type) { return parsePairing(value, type); }
    static makeLocalPairingLink(code, pageUrl) {
      try { const url = new URL(pageUrl); url.hash = `local=${code}`; return url.toString(); }
      catch { return code; }
    }
    get pairingCode() { return this.localPairingCode; }
    get isConnected() { return this.connectedPeers().length > 0; }
    connectedPeers() { return [...this.peers.values()].filter((peer) => peer.channel?.readyState === 'open' && Date.now() - peer.lastSeen < 20000); }
    async compatiblePairingCode() {
      return this.pairingData ? `VPVI2.j.${base64(encoder.encode(JSON.stringify(this.pairingData)))}` : '';
    }
    start(role, roomId, deviceId, deviceName) {
      this.disconnect({ silent: true });
      this.manualDisconnect = false;
      this.connection = { mode: 'local', role, roomId, deviceId, deviceName };
      this.receivedRevision = 0;
      this.latestSnapshot = null;
      this.tick();
    }
    status() {
      if (this.manualDisconnect) return;
      const live = this.connectedPeers();
      const known = [...this.peers.values()].filter((peer) => peer.deviceId);
      const syncedCount = live.filter((peer) => peer.ackedRevision >= (this.latestSnapshot?.revision || Infinity)).length;
      const disconnectedCount = known.filter((peer) => !live.includes(peer)).length;
      this.onPresence(known.map((peer) => ({ deviceId: peer.deviceId, deviceName: peer.deviceName || '设备', role: this.connection.role === 'host' ? 'mirror' : 'host', connected: live.includes(peer), revision: peer.ackedRevision || 0 })));
      this.onStatus({ state: live.length ? 'connected' : known.length && !this.pendingPeer ? 'offline' : 'connecting', transport: 'webrtc-local', peerCount: live.length, disconnectedCount, syncedCount, pending: Boolean(this.latestSnapshot && syncedCount < live.length), pairing: Boolean(this.pendingPeer) });
    }
    makePeer(pairId) {
      const PC = global.RTCPeerConnection || global.webkitRTCPeerConnection;
      if (!PC) throw new Error('此浏览器不支持本地直连，请用 Safari、Chrome 或 Edge 打开网页');
      const pc = new PC({ iceServers: [] });
      const peer = { pc, pairId, channel: null, deviceId: '', deviceName: '', lastSeen: Date.now(), ackedRevision: 0, sentAt: 0, transfer: null, incoming: null, receiveQueue: Promise.resolve() };
      this.peers.set(pairId, peer);
      pc.addEventListener('datachannel', ({ channel }) => { if (this.active(peer)) this.attachChannel(peer, channel); });
      pc.addEventListener('connectionstatechange', () => {
        if (!this.active(peer)) return;
        if (pc.connectionState === 'connected') { peer.sentAt = 0; this.flushPeer(peer); }
        this.status();
      });
      return peer;
    }
    active(peer) { return !this.manualDisconnect && this.peers.get(peer.pairId) === peer; }
    async createLocalOffer({ deviceId = id(), deviceName = '操作设备' } = {}) {
      if (this.connection?.role !== 'host' || this.manualDisconnect) this.start('host', id(), deviceId, deviceName);
      // Replacing an unused invitation never closes already paired devices.
      if (this.pendingPeer && !this.pendingPeer.deviceId) this.dropPeer(this.pendingPeer);
      const peer = this.makePeer(id());
      this.pendingPeer = peer;
      this.pairingData = null;
      this.localPairingCode = '';
      this.attachChannel(peer, peer.pc.createDataChannel('victorypvi-sync', { ordered: true }));
      try {
        await peer.pc.setLocalDescription(await peer.pc.createOffer());
        await gatherIce(peer.pc);
        if (!this.active(peer)) throw new Error('连接已取消');
        const data = { ...this.connection, type: 'offer', pairId: peer.pairId, sdp: peer.pc.localDescription.sdp };
        const code = await encodePairing(data);
        if (!this.active(peer)) throw new Error('连接已取消');
        this.pairingData = data;
        this.localPairingCode = code;
        this.status();
        return { roomId: this.connection.roomId, offerCode: code };
      } catch (error) { if (this.active(peer)) { this.dropPeer(peer); this.pendingPeer = null; this.status(); } throw error; }
    }
    async joinLocalOffer(value, { deviceId = id(), deviceName = '跟随设备' } = {}) {
      const offer = await parsePairing(value, 'offer');
      this.start('mirror', offer.roomId, deviceId, deviceName);
      const peer = this.makePeer(offer.pairId);
      peer.deviceId = offer.deviceId;
      peer.deviceName = offer.deviceName;
      this.pendingPeer = peer;
      try {
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        await gatherIce(peer.pc);
        if (!this.active(peer)) throw new Error('连接已取消');
        const data = { ...this.connection, type: 'answer', pairId: offer.pairId, sdp: peer.pc.localDescription.sdp };
        const code = await encodePairing(data);
        if (!this.active(peer)) throw new Error('连接已取消');
        this.pairingData = data;
        this.localPairingCode = code;
        this.status();
        return { roomId: offer.roomId, answerCode: code };
      } catch (error) { if (this.active(peer)) this.dropPeer(peer); throw error; }
    }
    async applyLocalAnswer(value) {
      const answer = await parsePairing(value, 'answer');
      const peer = this.pendingPeer;
      if (!peer || this.connection?.role !== 'host' || answer.roomId !== this.connection.roomId || answer.pairId !== peer.pairId) throw new Error('回码与当前邀请不匹配，请扫描这次连接生成的回码');
      if (!this.active(peer)) throw new Error('此邀请已关闭，请重新添加设备');
      if (peer.pc.remoteDescription) return true;
      peer.deviceId = answer.deviceId;
      peer.deviceName = answer.deviceName;
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      // Re-pairing the same device replaces its stale channel only after the answer is accepted.
      for (const other of [...this.peers.values()]) if (other !== peer && other.deviceId === peer.deviceId) this.dropPeer(other);
      this.status();
      return true;
    }
    attachChannel(peer, channel) {
      peer.channel = channel;
      channel.bufferedAmountLowThreshold = 64000;
      channel.addEventListener('bufferedamountlow', () => this.pump(peer));
      channel.addEventListener('open', () => {
        if (!this.active(peer)) return;
        peer.lastSeen = Date.now();
        if (this.pendingPeer === peer) this.pendingPeer = null;
        this.send(peer, { type: 'hello', deviceId: this.connection.deviceId, deviceName: this.connection.deviceName, revision: this.receivedRevision });
        this.flushPeer(peer);
        this.status();
      });
      channel.addEventListener('message', ({ data }) => {
        if (!this.active(peer)) return;
        peer.lastSeen = Date.now();
        peer.receiveQueue = peer.receiveQueue.then(() => this.receive(peer, data)).catch((error) => { if (this.active(peer)) this.onError(error); });
      });
      const offline = () => { if (this.active(peer)) { peer.transfer = null; this.status(); } };
      channel.addEventListener('close', offline);
      channel.addEventListener('error', offline);
    }
    send(peer, message) {
      if (!this.active(peer) || peer.channel?.readyState !== 'open') return false;
      try { peer.channel.send(JSON.stringify(message)); return true; }
      catch { return false; }
    }
    sendSnapshot(payload, revision) {
      if (this.connection?.role !== 'host' || this.manualDisconnect) return;
      const value = JSON.stringify(payload);
      if (encoder.encode(value).byteLength > MAX_SNAPSHOT_BYTES) { this.onError(new Error('记录过大，无法同步；本机记录仍已保留')); return; }
      revision = Math.max(1, Number(revision) || 1);
      if (revision < (this.latestSnapshot?.revision || 0)) return;
      this.latestSnapshot = { value, revision, updatedAt: new Date().toISOString() };
      for (const peer of this.peers.values()) this.flushPeer(peer, true);
      this.status();
    }
    flushPeer(peer, force = false) {
      const next = this.latestSnapshot;
      if (!this.active(peer) || !next || peer.channel?.readyState !== 'open' || peer.ackedRevision >= next.revision && !force) return;
      if (peer.transfer?.revision === next.revision) { this.pump(peer); return; }
      if (!force && Date.now() - peer.sentAt < 3000) return;
      const transferId = id();
      const chunks = [];
      for (let i = 0; i < next.value.length; i += CHUNK_CHARS) chunks.push(next.value.slice(i, i + CHUNK_CHARS));
      peer.transfer = { revision: next.revision, messages: [{ type: 'begin', id: transferId, revision: next.revision, updatedAt: next.updatedAt, count: chunks.length }, ...chunks.map((data, index) => ({ type: 'chunk', id: transferId, index, data })), { type: 'end', id: transferId }], index: 0 };
      peer.sentAt = Date.now();
      this.pump(peer);
    }
    pump(peer) {
      if (!this.active(peer)) return;
      const transfer = peer.transfer;
      if (!transfer) return;
      while (transfer.index < transfer.messages.length && peer.channel?.readyState === 'open' && peer.channel.bufferedAmount < 128000) {
        if (!this.send(peer, transfer.messages[transfer.index])) return;
        transfer.index += 1;
      }
      if (transfer.index === transfer.messages.length) peer.transfer = null;
    }
    async receive(peer, raw) {
      if (!this.active(peer)) return;
      let message;
      try { message = JSON.parse(raw); } catch { throw new Error('收到无法识别的同步消息'); }
      if (message.type === 'hello') {
        peer.deviceId = message.deviceId || peer.deviceId;
        peer.deviceName = message.deviceName || peer.deviceName;
        if (this.connection.role === 'host') {
          peer.ackedRevision = Number(message.revision) || 0;
          peer.sentAt = 0;
          this.flushPeer(peer);
        }
        this.send(peer, { type: 'pong' });
        this.status();
      } else if (message.type === 'ping') this.send(peer, { type: 'pong' });
      else if (message.type === 'ack' && this.connection.role === 'host') {
        peer.ackedRevision = Math.max(peer.ackedRevision, Number(message.revision) || 0);
        this.status();
      } else if (message.type === 'begin' && this.connection.role === 'mirror') {
        if (!Number.isInteger(message.count) || message.count < 1 || message.count > 200 || !Number.isSafeInteger(message.revision) || message.revision < 1) return;
        peer.incoming = { ...message, chunks: [], size: 0, startedAt: Date.now() };
      } else if (message.type === 'chunk' && this.connection.role === 'mirror') {
        const incoming = peer.incoming;
        if (!incoming || incoming.id !== message.id || message.index !== incoming.chunks.length || typeof message.data !== 'string') return;
        incoming.size += encoder.encode(message.data).byteLength;
        if (incoming.size > MAX_SNAPSHOT_BYTES + 1200 || incoming.chunks.length >= incoming.count) { peer.incoming = null; return; }
        incoming.chunks.push(message.data);
      } else if (message.type === 'end' && this.connection.role === 'mirror') {
        const incoming = peer.incoming;
        peer.incoming = null;
        if (!incoming || incoming.id !== message.id || incoming.chunks.length !== incoming.count) return;
        if (incoming.revision > this.receivedRevision) {
          const result = await this.onSnapshot(JSON.parse(incoming.chunks.join('')), incoming);
          if (!this.active(peer) || result === false) return;
          this.receivedRevision = incoming.revision;
          this.onStatus({ state: 'synced', transport: 'webrtc-local', revision: incoming.revision, peerCount: 1 });
        }
        this.send(peer, { type: 'ack', revision: this.receivedRevision });
      }
    }
    tick() {
      global.clearTimeout(this.timer);
      if (this.manualDisconnect) return;
      for (const peer of this.peers.values()) {
        if (peer.channel?.readyState === 'open') {
          this.send(peer, { type: 'ping' });
          this.flushPeer(peer);
        }
        if (peer.incoming && Date.now() - peer.incoming.startedAt > 20000) peer.incoming = null;
      }
      this.status();
      this.timer = global.setTimeout(() => this.tick(), 3000);
    }
    dropPeer(peer) {
      this.peers.delete(peer.pairId);
      if (this.pendingPeer === peer) this.pendingPeer = null;
      try { peer.channel?.close(); peer.pc.close(); } catch { /* Already closed. */ }
    }
    disconnect({ silent = false } = {}) {
      this.manualDisconnect = true;
      this.generation += 1;
      global.clearTimeout(this.timer);
      for (const peer of [...this.peers.values()]) this.dropPeer(peer);
      this.pendingPeer = null;
      this.latestSnapshot = null;
      this.pairingData = null;
      this.localPairingCode = '';
      if (!silent) this.onStatus({ state: 'disconnected', transport: 'webrtc-local' });
    }
  }
  global.VictoryPVIDirectClient = VictoryPVIDirectClient;
})(window);
