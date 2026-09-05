/* Optional phone-to-phone UI. Networking and camera decoder load only when requested. */
(function (global) {
  const load = src => new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = src;
    script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('连接组件未加载，请联网打开网页一次后重试。')); };
    document.head.append(script);
  });
  class VictoryPVIDirectUI {
    constructor(options) {
      this.options = options; this.role = 'local'; this.state = 'local'; this.peers = 0; this.code = ''; this.busy = false;
      this.dialog = document.createElement('dialog');
      this.dialog.className = 'settings-dialog sync-dialog'; this.dialog.id = 'direct-dialog';
      this.dialog.setAttribute('aria-labelledby', 'direct-title');
      this.dialog.innerHTML = `<div class="settings-card">
        <header class="settings-header"><div><p class="dialog-kicker">无需电脑</p><h2 id="direct-title">手机之间连接</h2><p class="settings-header-help">同一 Wi-Fi / 热点 · 一台手机操作，多台手机跟随</p></div><button class="dialog-close" id="direct-close" type="button" aria-label="关闭手机互联">×</button></header>
        <div class="settings-body">
          <p class="sync-detail" id="direct-status" aria-live="polite"></p>
          <div class="sync-action-row"><button class="button primary" id="direct-create" type="button">本机操作，连接其他手机</button><button class="button" id="direct-join" type="button">扫码跟随另一台手机</button></div>
          <section id="direct-pairing" class="sync-section" hidden>
            <div class="sync-qr-layout"><div class="sync-qr-frame"><div class="sync-qr" id="direct-qr"></div><span class="sync-qr-caption" id="direct-caption"></span></div><div class="sync-qr-copy"><strong id="direct-next"></strong><p id="direct-help"></p><button class="button primary" id="direct-scan-answer" type="button">扫描对方回码</button></div></div>
          </section>
          <section id="direct-camera" class="sync-section" hidden><video id="direct-video" playsinline muted autoplay style="width:100%;max-height:320px;background:#172033;border-radius:12px"></video><p class="settings-help" id="direct-camera-status"></p><button class="button" id="direct-stop-camera" type="button">取消扫码</button></section>
          <details id="direct-manual"><summary>摄像头不可用时：复制连接信息</summary>
            <textarea class="sync-code" id="direct-code" aria-label="本机连接信息" readonly rows="3"></textarea>
            <button class="button" id="direct-copy" type="button">复制本机连接信息</button><button class="button" id="direct-compatible" type="button">生成兼容连接信息</button>
            <label class="field full" for="direct-input">粘贴对方邀请或回码</label><textarea class="sync-code" id="direct-input" rows="3"></textarea><button class="button" id="direct-apply" type="button">使用对方连接信息</button>
          </details>
          <p class="sync-error" id="direct-error" hidden></p>
          <p class="sync-privacy-note">此方式由手机直接传输和保存，不需要电脑或在线同步服务。请保持网页打开；短暂中断会自动补发，刷新或关闭网页后需要重新扫码。若扫码组件尚未加载，请在使用前联网打开一次扫码功能。</p>
        </div>
        <footer class="settings-footer"><div class="settings-footer-actions"><button class="button" id="direct-leave" type="button">结束手机互联</button><button class="button" id="direct-done" type="button">返回记录</button></div></footer>
      </div>`;
      document.body.append(this.dialog);
      this.get = id => this.dialog.querySelector(`#direct-${id}`);
      this.canvas = document.createElement('canvas'); this.context = this.canvas.getContext('2d', { willReadFrequently: true });
      this.get('create').onclick = () => this.create();
      this.get('join').onclick = () => this.scan('offer');
      this.get('scan-answer').onclick = () => this.scan('answer');
      this.get('stop-camera').onclick = () => this.stopCamera();
      this.get('apply').onclick = () => this.accept(this.get('input').value.trim(), this.role === 'host' && this.code ? 'answer' : 'offer');
      this.get('copy').onclick = async () => { try { await navigator.clipboard.writeText(this.code); } catch { this.get('code').focus(); this.get('code').select(); } };
      this.get('compatible').onclick = async () => { if (this.client?.pairingData) { this.code = await this.client.compatiblePairingCode(); this.render(); } };
      this.get('leave').onclick = () => this.leave();
      this.get('close').onclick = this.get('done').onclick = () => this.close();
      this.dialog.addEventListener('close', () => this.stopCamera());
      this.dialog.addEventListener('cancel', () => this.stopCamera());
      this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.close(); });
      this.restore();
    }
    persist() { try { localStorage.setItem('vpvi-direct-role', this.role); } catch {} }
    restore() {
      try { const role = localStorage.getItem('vpvi-direct-role'); if (['host', 'mirror'].includes(role)) {
        this.role = role; this.state = 'offline'; this.options.onRole(role); this.options.onStatus({ state: 'offline', peerCount: 0 });
      } } catch {}
    }
    detail() {
      if (this.state === 'offline') return '手机直连已中断，记录保留。刷新后请重新扫码；短暂网络中断会尝试恢复。';
      if (this.peers) return this.role === 'host' ? `本机操作，${this.peers} 台手机已连接。` : '正在跟随操作手机，记录直接在手机间传输。';
      return this.role === 'host' ? '让其他手机扫邀请，再用本机扫对方回码。' : this.role === 'mirror' ? '将回码展示给操作手机扫描，即可开始跟随。' : '本机可以操作，也可以扫码跟随另一台手机。';
    }
    async ensureClient() {
      if (!global.VictoryPVIDirectClient) await load('./direct-sync-client.js');
      if (!this.client) this.client = new global.VictoryPVIDirectClient({
        onSnapshot: (payload, envelope) => this.options.onSnapshot(payload, envelope),
        onPresence: peers => this.options.onPresence?.(peers),
        onStatus: details => {
          this.state = details.state === 'synced' ? 'connected' : details.state;
          this.peers = details.peerCount ?? this.peers;
          if (this.peers && !this.client.pendingPeer) this.code = '';
          this.options.onStatus({ ...details, state: this.state }); this.render();
        },
        onError: error => this.error(error),
      });
    }
    error(error) { this.get('error').hidden = false; this.get('error').textContent = error.message || String(error); }
    render() {
      this.get('status').textContent = this.detail();
      this.get('pairing').hidden = !this.code;
      this.get('code').value = this.code;
      this.get('create').hidden = this.role === 'mirror';
      this.get('create').textContent = this.role === 'host' ? '添加 / 重连手机' : '本机操作，连接其他手机';
      this.get('join').hidden = this.role === 'host';
      this.get('join').textContent = this.role === 'mirror' ? '重新扫码连接' : '扫码跟随另一台手机';
      this.get('scan-answer').hidden = this.role !== 'host';
      this.get('caption').textContent = this.role === 'host' ? '手机邀请' : '手机回码';
      this.get('next').textContent = this.role === 'host' ? '对方扫码后，再扫一次回码' : '让操作手机扫描此回码';
      this.get('help').textContent = this.role === 'host' ? '另一台手机打开同一网页，选择“手机之间连接 → 扫码跟随”。' : '操作手机点击“扫描对方回码”，完成后记录会自动同步。';
      if (this.code) this.options.renderQr(this.get('qr'), this.code, this.role === 'host' ? '手机邀请二维码' : '手机回码');
      for (const name of ['create', 'join', 'scan-answer', 'apply', 'leave']) this.get(name).disabled = this.busy;
    }
    async prepare() { await this.ensureClient(); if (!global.jsQR) await load("./vendor/jsqr.js"); }
    async open() { this.render(); if (!this.dialog.open) this.dialog.showModal(); try { await this.prepare(); } catch (error) { this.error(error); } }
    close() { this.stopCamera(); this.dialog.close(); }
    async create() {
      if (this.busy) return;
      this.stopCamera(); this.busy = true; this.get('error').hidden = true; this.render();
      try {
        await this.ensureClient(); this.role = 'host'; this.state = 'connecting'; this.options.onRole('host'); this.persist();
        const details = await this.client.createLocalOffer({ deviceId: this.options.deviceId, deviceName: '操作手机' });
        this.code = details.offerCode;
        this.options.sendCurrent();
      } catch (error) { this.error(error); }
      finally { this.busy = false; this.render(); }
    }
    async accept(value, target) {
      if (!value || this.busy) return;
      this.stopCamera(); this.busy = true; this.get('error').hidden = true; this.render();
      try {
        await this.ensureClient();
        if (target === 'answer') { await this.client.applyLocalAnswer(value); this.options.sendCurrent(); }
        else {
          await global.VictoryPVIDirectClient.parseLocalPairingCode(value, 'offer');
          this.role = 'mirror'; this.options.onRole('mirror'); this.persist();
          const details = await this.client.joinLocalOffer(value, { deviceId: this.options.deviceId, deviceName: '跟随手机' });
          this.code = details.answerCode;
        }
      } catch (error) { this.error(error); }
      finally { this.busy = false; this.render(); }
    }
    sendSnapshot(payload, revision) { this.client?.sendSnapshot(payload, revision); }
    stopCamera() {
      this.scanGeneration = (this.scanGeneration || 0) + 1;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
      this.get('video').srcObject = null; this.get('camera').hidden = true;
    }
    async scan(target) {
      this.stopCamera(); const generation = this.scanGeneration;
      this.get('camera').hidden = false; this.get('camera-status').textContent = '正在打开摄像头…';
      this.get('camera').scrollIntoView({ block: 'nearest' });
      try {
        // The decoder is preloaded for standalone phones and when opening this flow.
        await this.ensureClient();
        if (!global.jsQR) await load('./vendor/jsqr.js');
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('请用 Safari 或 Chrome 打开 HTTPS 网页后扫码，也可使用下方连接信息。');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } });
        if (generation !== this.scanGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
        this.stream = stream; const video = this.get('video'); video.srcObject = stream; await video.play();
        if (generation !== this.scanGeneration) return;
        this.get('camera-status').textContent = target === 'answer' ? '对准对方手机的回码' : '对准操作手机的邀请二维码';
        const tick = () => {
          if (generation !== this.scanGeneration || !this.stream) return;
          if (video.readyState >= 2 && video.videoWidth && this.context) {
            this.canvas.width = Math.min(960, video.videoWidth); this.canvas.height = Math.round(video.videoHeight * this.canvas.width / video.videoWidth);
            this.context.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
            const frame = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
            const decoded = global.jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
            if (decoded?.data) { void this.accept(decoded.data, target); return; }
          }
          this.frame = requestAnimationFrame(tick);
        };
        tick();
      } catch (error) { this.stopCamera(); this.error(error); }
    }
    leave() {
      this.stopCamera(); this.client?.disconnect({ silent: true });
      this.role = 'local'; this.state = 'local'; this.code = ''; this.peers = 0; this.persist();
      this.options.onRole('local'); this.options.onStatus({ state: 'local', peerCount: 0 }); this.close();
    }
  }
  global.VictoryPVIDirectUI = VictoryPVIDirectUI;
})(window);
