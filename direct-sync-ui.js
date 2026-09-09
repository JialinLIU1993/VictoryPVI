/* Phone-first sync UI. Desktop connection is an optional, collapsed path. */
(function (global) {
  const loading = new Map();
  const load = src => loading.get(src) || loading.set(src, new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = src;
    script.onload = resolve; script.onerror = () => { loading.delete(src); script.remove(); reject(new Error('连接组件未加载，请联网打开网页一次后重试。')); };
    document.head.append(script);
  })).get(src);
  class VictoryPVIDirectUI {
    constructor(options) {
      this.options = options; this.role = 'local'; this.state = 'local'; this.peers = 0; this.code = ''; this.busy = false;
      this.dialog = document.createElement('dialog');
      this.dialog.className = 'settings-dialog sync-dialog'; this.dialog.id = 'direct-dialog';
      this.dialog.setAttribute('aria-labelledby', 'direct-title');
      this.dialog.innerHTML = `<div class="settings-card">
        <header class="settings-header"><div><p class="dialog-kicker">设备同步</p><h2 id="direct-title" tabindex="-1">手机互联</h2><p class="settings-header-help">先将手机连接同一 Wi-Fi 或热点</p></div><button class="dialog-close" id="direct-close" type="button" aria-label="关闭手机互联">×</button></header>
        <div class="settings-body">
          <div class="direct-connection direct-stage" id="direct-connection" hidden>
            <span class="direct-connection-icon" aria-hidden="true">✓</span><h3 id="direct-connection-title"></h3>
          </div>
          <p class="sync-detail" id="direct-status" aria-live="polite"></p>
          <div class="direct-choices direct-stage" id="direct-choices">
            <button class="direct-choice direct-choice-primary" id="direct-create" type="button">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M10 12h4m-2-2v4M11 19h2"/></svg>
              <span><strong id="direct-create-label">本机操作</strong><small id="direct-create-help">让其他手机跟随本机记录</small></span><span class="direct-choice-arrow" aria-hidden="true">›</span>
            </button>
            <button class="direct-choice" id="direct-join" type="button">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 12h18"/></svg>
              <span><strong id="direct-join-label">扫码跟随</strong><small>扫描操作手机上的邀请二维码</small></span><span class="direct-choice-arrow" aria-hidden="true">›</span>
            </button>
          </div>
          <ol class="direct-steps" id="direct-steps" aria-label="配对进度" hidden><li id="direct-step-one"><span>1</span><b id="direct-step-one-label"></b></li><li id="direct-step-two"><span>2</span><b id="direct-step-two-label"></b></li></ol>
          <p class="direct-loading" id="direct-loading" role="status" hidden>正在准备连接…</p>
          <section id="direct-pairing" class="direct-pairing direct-stage" hidden>
            <h3 id="direct-next"></h3><p class="settings-help" id="direct-help"></p>
            <div class="sync-qr-frame"><div class="sync-qr" id="direct-qr"></div><span class="sync-qr-caption" id="direct-caption"></span></div>
            <button class="button primary" id="direct-scan-answer" type="button">对方已扫码，扫描回码</button>
          </section>
          <section id="direct-camera" class="direct-camera direct-stage" hidden>
            <h3 id="direct-camera-title"></h3><div class="direct-viewfinder"><video id="direct-video" playsinline muted autoplay></video><span aria-hidden="true"></span></div>
            <p class="settings-help" id="direct-camera-status" role="status"></p><button class="button" id="direct-stop-camera" type="button">取消扫码</button>
          </section>
          <p class="sync-error" id="direct-error" role="alert" hidden></p>
          <details class="direct-secondary" id="direct-manual"><summary>无法扫码？</summary>
            <button class="button" id="direct-retry" type="button">重新生成邀请</button>
            <p class="settings-help">可复制并发送连接信息给对方，再粘贴到这里，无需手动输入。</p>
            <div id="direct-manual-code">
            <textarea class="sync-code" id="direct-code" aria-label="本机连接信息" readonly rows="3"></textarea>
            <button class="button" id="direct-copy" type="button">复制本机连接信息</button><button class="button" id="direct-compatible" type="button">生成兼容连接信息</button>
            </div>
            <label class="field full" for="direct-input">粘贴对方邀请或回码</label><textarea class="sync-code" id="direct-input" rows="3"></textarea><button class="button" id="direct-apply" type="button">使用对方连接信息</button>
          </details>
          <p class="direct-note" id="direct-note">无需安装，一台操作，多台跟随。</p>
          <details class="direct-secondary direct-desktop" id="direct-desktop"><summary>使用电脑连接与保存<span>可选</span></summary><div id="direct-desktop-content"></div></details>
        </div>
        <footer class="settings-footer"><button class="direct-text-button" id="direct-leave" type="button" hidden>结束互联</button><button class="button" id="direct-done" type="button">返回记录</button></footer>
      </div>`;
      document.body.append(this.dialog);
      this.get = id => this.dialog.querySelector(`#direct-${id}`);
      if (options.desktopContent) this.get('desktop-content').append(options.desktopContent);
      else this.get('desktop').hidden = true;
      if (options.errorContent) this.get('error').before(options.errorContent);
      this.canvas = document.createElement('canvas'); this.context = this.canvas.getContext('2d', { willReadFrequently: true });
      this.get('create').onclick = () => this.create();
      this.get('join').onclick = () => this.scan('offer');
      this.get('scan-answer').onclick = () => this.scan('answer');
      this.get('retry').onclick = () => this.role === 'host' ? this.create() : this.scan('offer');
      this.get('stop-camera').onclick = () => { const target = this.scanTarget; this.stopCamera(); this.get(target === 'answer' ? 'scan-answer' : 'join').focus(); };
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
      if (this.state === 'offline') return '记录已保留。短暂中断会尝试恢复；刷新后请重新扫码。';
      if (this.peers) return this.role === 'host' ? `本机操作，${this.peers} 台手机已连接。` : '本机只读跟随，操作手机的记录会自动同步。';
      return this.role === 'host' ? '等待其他手机加入。' : this.role === 'mirror' ? '等待操作手机完成连接。' : '本机可以操作，也可以扫码跟随另一台手机。';
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
    error(error) { this.get('error').hidden = false; this.get('error').textContent = error.message || String(error); this.render(); }
    render() {
      const scanning = Boolean(this.scanTarget), pairing = Boolean(this.code), active = this.role !== 'local';
      const occupied = scanning || pairing || this.busy;
      const connected = this.peers > 0 && this.state !== 'offline';
      const phase = scanning ? 'camera' : this.busy ? 'loading' : pairing ? 'pairing' : active ? 'connection' : 'choose';
      if (this.dialog.dataset.phase !== phase) {
        this.dialog.dataset.phase = phase;
        this.dialog.querySelector('.settings-body').scrollTop = 0;
      }
      this.get('status').textContent = this.detail();
      this.get('status').hidden = !active || occupied;
      this.get('connection').hidden = !active || occupied;
      this.get('connection-title').textContent = connected ? (this.role === 'host' ? '手机已连接' : '已连接操作手机') : this.state === 'offline' ? '重新连接手机' : '等待连接';
      this.get('connection').dataset.connected = String(connected);
      this.get('connection').querySelector('.direct-connection-icon').textContent = connected ? '✓' : '↻';
      this.get('choices').hidden = occupied || (connected && this.role === 'mirror');
      this.get('pairing').hidden = !pairing || scanning || this.busy;
      this.get('camera').hidden = !scanning;
      this.get('loading').hidden = !this.busy || scanning;
      this.get('code').value = this.code;
      this.get('create').hidden = this.role === 'mirror';
      this.get('create-label').textContent = this.role === 'host' ? connected ? '添加手机' : '重新生成邀请' : '本机操作';
      this.get('create-help').textContent = connected ? '已连接的手机会继续跟随' : '让其他手机跟随本机记录';
      this.get('join').hidden = this.role === 'host';
      this.get('join-label').textContent = this.role === 'mirror' ? '重新扫码连接' : '扫码跟随';
      this.get('scan-answer').hidden = this.role !== 'host';
      this.get('caption').textContent = this.role === 'host' ? '邀请二维码' : '回码 · 扫描后自动连接';
      this.get('next').textContent = this.role === 'host' ? '让另一台手机扫描' : '把回码展示给操作手机';
      this.get('help').textContent = this.role === 'host' ? '对方打开网页，点“设备同步 → 扫码跟随”。' : '操作手机点击“扫描回码”，扫一下即可完成。';
      this.get('camera-title').textContent = this.scanTarget === 'answer' ? '扫描对方的回码' : '扫描操作手机的邀请';
      this.get('steps').hidden = !pairing && !scanning;
      const hostFlow = this.role === 'host' || this.scanTarget === 'answer';
      const secondStep = hostFlow ? this.scanTarget === 'answer' : pairing;
      this.get('step-one-label').textContent = hostFlow ? '出示邀请' : '扫描邀请';
      this.get('step-two-label').textContent = hostFlow ? '扫描回码' : '出示回码';
      this.get('step-one').setAttribute('aria-current', secondStep ? 'false' : 'step');
      this.get('step-two').setAttribute('aria-current', secondStep ? 'step' : 'false');
      this.get('manual').hidden = scanning || this.busy || (connected && !pairing) || (!active && this.get('error').hidden);
      this.get('manual-code').hidden = !pairing;
      this.get('retry').hidden = !active;
      this.get('retry').textContent = this.role === 'host' ? '重新生成邀请' : '重新扫描邀请';
      this.get('desktop').hidden = active || occupied || !this.options.desktopContent;
      this.get('leave').hidden = !active || scanning || this.busy;
      this.get('note').hidden = scanning || this.busy;
      this.get('note').textContent = active ? '保持网页打开；刷新后需重新扫码。' : '无需安装，一台操作，多台跟随。';
      this.get('done').classList.toggle('primary', connected && !occupied);
      this.get('done').textContent = connected && !occupied ? this.role === 'host' ? '继续记录' : '查看记录' : '返回记录';
      if (this.code && this.renderedCode !== this.code) {
        this.options.renderQr(this.get('qr'), this.code, this.role === 'host' ? '手机邀请二维码' : '手机回码');
        this.renderedCode = this.code;
      }
      for (const name of ['create', 'join', 'scan-answer', 'apply', 'retry', 'leave']) this.get(name).disabled = this.busy || Boolean(this.options.isHandoffPending?.());
    }
    async prepare() { await this.ensureClient(); if (!global.jsQR) await load("./vendor/jsqr.js"); }
    async open() { this.render(); if (!this.dialog.open) { this.dialog.showModal(); this.get('title').focus({ preventScroll: true }); } try { await this.prepare(); } catch (error) { this.error(error); } }
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
      finally { this.busy = false; this.render(); if (this.dialog.open && this.code) this.get('scan-answer').focus({ preventScroll: true }); }
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
      this.scanTarget = null;
      this.get('video').srcObject = null; this.render();
    }
    async scan(target) {
      this.stopCamera(); const generation = this.scanGeneration;
      this.scanTarget = target; this.get('error').hidden = true;
      this.get('camera-status').textContent = '正在打开摄像头…'; this.render();
      this.get('stop-camera').focus({ preventScroll: true });
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
      } catch (error) { if (generation !== this.scanGeneration) return; this.stopCamera(); this.error(error); }
    }
    leave() {
      this.stopCamera(); this.client?.disconnect({ silent: true });
      this.role = 'local'; this.state = 'local'; this.code = ''; this.peers = 0; this.persist();
      this.get('error').hidden = true; this.get('manual').open = false; this.get('input').value = '';
      this.options.onRole('local'); this.options.onStatus({ state: 'local', peerCount: 0 }); this.close();
    }
  }
  global.VictoryPVIDirectUI = VictoryPVIDirectUI;
})(window);
