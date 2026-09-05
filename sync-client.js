/* Local HTTP transport. The desktop process owns durable state; browsers retry latest state. */
(function (global) {
  'use strict';
  class VictoryPVISyncClient {
    constructor(options = {}) {
      this.options = options;
      this.fetch = options.fetch || global.fetch.bind(global);
      this.sessionId = global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      this.controllers = new Set();
      this.generation = 0;
      this.appliedRevision = 0;
      this.cursor = '';
      this.pending = null;
    }
    async request(endpoint, body, timeout = 16000) {
      const controller = new AbortController();
      this.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await this.fetch(`/api/lan/${endpoint}`, { signal: controller.signal, cache: 'no-store',
          ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.error || '连接未完成'), { status: response.status });
        return result;
      } finally { clearTimeout(timer); this.controllers.delete(controller); }
    }
    status(state, details = {}) { this.options.onStatus?.(state === 'connected' && this.uploadError ? { ...details, state: 'offline', error: this.uploadError } : { state, ...details }); }
    async connect({ role, deviceId, roomId, onRestore, initialSnapshot }) {
      this.disconnect();
      const generation = this.generation;
      this.role = role; this.deviceId = deviceId; this.roomId = roomId;
      this.status('connecting');
      const info = await this.request('info');
      if (generation !== this.generation) return;
      if (info.service !== 'VictoryPVI-LAN-1') throw new Error('请启动 VictoryPVI 电脑客户端。');
      if (roomId && roomId !== info.roomId) throw new Error('连接对应另一台电脑，请重新扫码。');
      this.roomId = info.roomId;
      if (role === 'host') {
        const claim = await this.request('host', { deviceId });
        if (generation !== this.generation) return;
        this.writerId = claim.writerId;
        if (!initialSnapshot && claim.snapshot) {
          if (await onRestore?.(claim.snapshot.payload, claim.snapshot) === false) throw new Error('无法恢复电脑记录，请更新网页和客户端。');
          this.appliedRevision = claim.snapshot.revision;
        }
        this.active = true;
        if (initialSnapshot || !claim.snapshot) this.sendSnapshot(initialSnapshot || this.options.getSnapshot(), 1);
      } else this.active = true;
      this.status('connected', { roomId: this.roomId, urls: info.urls });
      void this.poll(generation);
      return info;
    }
    async pause(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }
    async poll(generation) {
      let backoff = 300;
      while (this.active && generation === this.generation) {
        try {
          const query = new URLSearchParams({ roomId: this.roomId, deviceId: this.deviceId, sessionId: this.sessionId,
            role: this.role, writerId: this.writerId || '', appliedRevision: this.appliedRevision, cursor: this.cursor });
          const data = await this.request(`state?${query}`);
          if (generation !== this.generation) return;
          if (data.superseded && this.role === 'host') {
            this.role = 'mirror'; this.disconnect();
            this.options.onSuperseded?.(); return;
          }
          if (this.role === 'mirror' && data.snapshot) {
            if (await this.options.onSnapshot?.(data.snapshot.payload, data.snapshot) === false) throw new Error('收到的记录无法应用，请更新客户端。');
            if (generation !== this.generation) return;
            this.appliedRevision = data.snapshot.revision;
          }
          this.cursor = data.cursor;
          this.options.onPresence?.(data.peers);
          this.status('connected', data);
          backoff = 300;
        } catch (error) {
          if (generation !== this.generation) return;
          this.status('offline', { error: error.message });
          await this.pause(backoff);
          backoff = Math.min(backoff * 2, 5000);
        }
      }
    }
    sendSnapshot(payload, clientRevision) {
      if (this.role !== 'host') return;
      if (this.pending && clientRevision <= this.pending.clientRevision) return;
      this.pending = { payload, clientRevision };
      if (this.active && !this.uploading) void this.upload(this.generation);
    }
    async upload(generation) {
      this.uploading = true;
      let backoff = 300;
      try {
        while (this.pending && this.active && this.role === 'host' && generation === this.generation) {
          const pending = this.pending;
          try {
            const ack = await this.request('snapshot', { ...pending, writerId: this.writerId });
            if (generation !== this.generation) return;
            this.uploadError = null;
            this.appliedRevision = ack.revision;
            if (this.pending === pending) this.pending = null;
            this.options.onSaved?.(ack, !this.pending);
            backoff = 300;
          } catch (error) {
            if (generation !== this.generation) return;
            if (error.status === 409) {
              this.role = 'mirror'; this.disconnect(); this.options.onSuperseded?.(); break;
            }
            this.uploadError = error.status ? error.message : '正在重新连接，未发送的操作保留在本机。';
            this.status('offline', { error: this.uploadError });
            await this.pause(backoff);
            backoff = Math.min(backoff * 2, 5000);
          }
        }
      } finally { if (generation === this.generation) this.uploading = false; }
    }
    disconnect() {
      this.generation++; this.active = false;
      for (const controller of this.controllers) controller.abort();
      this.controllers.clear(); this.pending = null; this.uploading = false;
      this.appliedRevision = 0; this.cursor = ''; this.writerId = ''; this.uploadError = null;
    }
  }
  global.VictoryPVISyncClient = VictoryPVISyncClient;
})(window);
