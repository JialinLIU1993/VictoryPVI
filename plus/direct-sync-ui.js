/* Two-step QR code sync UI (host & mirror). */
(function (global) {
  const allowedScripts = new Set(['./direct-sync-client.js', './vendor/jsqr.js']);
  const ttPolicy = global.trustedTypes?.createPolicy?.('victorypvi-direct-ui', {
    createHTML: html => html,
    createScriptURL: src => {
      if (!allowedScripts.has(src)) throw new TypeError(`Blocked untrusted script URL: ${src}`);
      return src;
    },
  });
  const isOutsideDialogContentBox = (dialog, event) => {
    if (!dialog.open || event.detail === 0) return false;
    const rect = dialog.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };
  const loading = new Map();
  const load = src => loading.get(src) || loading.set(src, new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ttPolicy ? ttPolicy.createScriptURL(src) : src;
    script.onload = resolve;
    script.onerror = () => {
      loading.delete(src);
      script.remove();
      reject(new Error('同步组件未加载，请联网打开网页一次后重试。'));
    };
    document.head.append(script);
  })).get(src);

  class VictoryPVIDirectUI {
    constructor(options) {
      this.options = options;
      this.role = 'local';
      this.state = 'local';
      this.peers = 0;
      this.code = '';
      this.renderedCode = '';
      this.busy = false;
      this.loadingText = '';
      this.scanTarget = null;
      this.dialog = document.createElement('dialog');
      this.dialog.className = 'settings-dialog sync-dialog';
      this.dialog.id = 'direct-dialog';
      this.dialog.setAttribute('closedby', 'any');
      this.dialog.setAttribute('aria-labelledby', 'direct-title');
      const dialogHtml = `<div class="settings-card">
        <header class="settings-header">
          <div>
            <p class="dialog-kicker">多端同步</p>
            <h2 id="direct-title" tabindex="-1">双端扫码同步</h2>
            <p class="settings-header-help">两台设备连接同一 Wi-Fi 或手机热点，分两步互扫二维码即可实时同步</p>
          </div>
          <button class="dialog-close" id="direct-close" type="button" aria-label="关闭双端扫码同步">×</button>
        </header>
        <div class="settings-body">
          <div class="direct-connection direct-stage" id="direct-connection" hidden>
            <span class="direct-connection-icon" aria-hidden="true">✓</span><h3 id="direct-connection-title"></h3>
          </div>
          <p class="sync-detail" id="direct-status" aria-live="polite"></p>
          <div class="direct-choices direct-stage" id="direct-choices">
            <button class="direct-choice direct-choice-primary" id="direct-create" type="button">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M10 12h4m-2-2v4M11 19h2"/></svg>
              <span><strong id="direct-create-label">本机作为操作端</strong><small id="direct-create-help">在本机记录消融 · 第 1 步出示邀请码，第 2 步扫对方回码</small></span><span class="direct-choice-arrow" aria-hidden="true">›</span>
            </button>
            <button class="direct-choice" id="direct-join" type="button">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 12h18"/></svg>
              <span><strong id="direct-join-label">本机作为跟随端</strong><small id="direct-join-help">只读同步画面 · 第 1 步扫操作端邀请码，第 2 步出示回码</small></span><span class="direct-choice-arrow" aria-hidden="true">›</span>
            </button>
          </div>
          <ol class="direct-steps" id="direct-steps" aria-label="双端扫码步骤" hidden>
            <li id="direct-step-one"><span>1</span><b id="direct-step-one-label"></b></li>
            <li id="direct-step-two"><span>2</span><b id="direct-step-two-label"></b></li>
          </ol>
          <p class="direct-loading" id="direct-loading" role="status" hidden>正在处理，请稍候…</p>
          <section id="direct-pairing" class="direct-pairing direct-stage" hidden>
            <h3 id="direct-next"></h3>
            <p class="settings-help" id="direct-help"></p>
            <div class="sync-qr-frame"><div class="sync-qr" id="direct-qr"></div><span class="sync-qr-caption" id="direct-caption"></span></div>
            <button class="button primary" id="direct-scan-answer" type="button">对方已出回码，开始扫描（第 2 步）</button>
            <button class="button" id="direct-cancel-step" type="button"></button>
          </section>
          <section id="direct-camera" class="direct-camera direct-stage" hidden>
            <h3 id="direct-camera-title"></h3>
            <div class="direct-viewfinder"><video id="direct-video" playsinline muted autoplay></video><span aria-hidden="true"></span></div>
            <p class="settings-help" id="direct-camera-status" role="status"></p>
            <button class="button" id="direct-stop-camera" type="button">返回上一步</button>
          </section>
          <p class="sync-error" id="direct-error" role="alert" hidden></p>
          <p class="direct-note" id="direct-note">先在主控设备选“本机作为操作端”，再在另一台设备选“本机作为跟随端”。</p>
        </div>
        <footer class="settings-footer"><button class="direct-text-button" id="direct-leave" type="button" hidden>结束同步</button><button class="button" id="direct-done" type="button">返回记录</button></footer>
      </div>`;
      this.dialog.innerHTML = ttPolicy ? ttPolicy.createHTML(dialogHtml) : dialogHtml;
      document.body.append(this.dialog);
      this.get = id => this.dialog.querySelector(`#direct-${id}`);
      if (options.errorContent) this.get('error').before(options.errorContent);
      this.canvas = document.createElement('canvas');
      this.context = this.canvas.getContext('2d', { willReadFrequently: true });
      this.get('create').onclick = () => this.create();
      this.get('join').onclick = () => this.scan('offer');
      this.get('scan-answer').onclick = () => this.scan('answer');
      this.get('cancel-step').onclick = () => this.cancelStep();
      this.get('stop-camera').onclick = () => {
        const target = this.scanTarget;
        this.stopCamera();
        const focusId = target === 'answer' ? 'scan-answer' : (this.code ? 'cancel-step' : 'join');
        this.get(focusId)?.focus();
      };
      this.get('leave').onclick = () => this.leave();
      this.get('close').onclick = this.get('done').onclick = () => this.close();
      this.dialog.addEventListener('close', () => this.stopCamera());
      this.dialog.addEventListener('cancel', () => this.stopCamera());
      if (!('closedBy' in HTMLDialogElement.prototype)) {
        this.dialog.addEventListener('click', event => {
          if (isOutsideDialogContentBox(this.dialog, event)) this.close();
        });
      }
      this.restore();
    }

    persist() {
      try { localStorage.setItem('vpvi-direct-role', this.role); } catch {}
    }

    restore() {
      try {
        const role = localStorage.getItem('vpvi-direct-role');
        if (['host', 'mirror'].includes(role)) {
          this.role = role;
          this.state = 'offline';
          this.options.onRole(role);
          this.options.onStatus({ state: 'offline', peerCount: 0 });
        }
      } catch {}
    }

    pendingHostState() {
      if (this.role !== 'host' || this.state === 'offline') return '';
      const pc = this.client?.pendingPeer?.pc;
      if (!pc?.remoteDescription) return '';
      return ['failed', 'disconnected', 'closed'].includes(pc.connectionState) ? 'failed' : 'handshaking';
    }

    detail() {
      if (this.peers > 0 && this.state !== 'offline') {
        return this.role === 'host'
          ? `已连接 ${this.peers} 台跟随端，本机消融记录会实时同步至对方。`
          : '本机当前为只读跟随模式，操作端的消融记录将自动实时更新。';
      }
      const pending = this.pendingHostState();
      if (pending === 'failed') {
        return '未能建立直连，请确认两台设备在同一 Wi-Fi 或手机热点下（未开启访客隔离），然后重新生成邀请码并互扫。';
      }
      if (pending === 'handshaking') {
        return '已扫描对方回码，正在完成本地直连，通常只需 1～2 秒，请稍候…';
      }
      if (this.state === 'offline') {
        return '本机已同步的记录已保留。如需继续同步，请重新进行双端扫码。';
      }
      if (this.role === 'host') return '请出示邀请码并扫描跟随端回码以完成连接。';
      if (this.role === 'mirror') return '请扫描操作端邀请码并出示回码以完成连接。';
      return '';
    }

    async ensureClient() {
      if (!global.VictoryPVIDirectClient) await load('./direct-sync-client.js');
      if (!this.client) {
        this.client = new global.VictoryPVIDirectClient({
          onSnapshot: (payload, envelope) => this.options.onSnapshot(payload, envelope),
          onPresence: peers => this.options.onPresence?.(peers),
          onStatus: details => {
            this.state = details.state === 'synced' ? 'connected' : details.state;
            this.peers = details.peerCount ?? this.peers;
            if (this.peers && !this.client.pendingPeer) this.code = '';
            this.options.onStatus({ ...details, state: this.state });
            this.render();
          },
          onError: error => this.error(error),
        });
      }
    }

    error(error) {
      this.get('error').hidden = false;
      this.get('error').textContent = error?.message || String(error);
      this.render();
    }

    formatCameraError(error) {
      const name = error?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        return '未获得摄像头权限，请在浏览器地址栏或系统设置中允许访问摄像头后重试。';
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return '未检测到可用摄像头，请确认设备摄像头正常后重试。';
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        return '摄像头正被其他应用占用，请关闭其他使用相机的应用后重试。';
      }
      return error?.message || String(error);
    }

    render() {
      const scanning = Boolean(this.scanTarget);
      const pairing = Boolean(this.code);
      const active = this.role !== 'local';
      const occupied = scanning || pairing || this.busy;
      const connected = this.peers > 0 && this.state !== 'offline';
      const phase = scanning ? 'camera' : this.busy ? 'loading' : pairing ? 'pairing' : active ? 'connection' : 'choose';
      if (this.dialog.dataset.phase !== phase) {
        this.dialog.dataset.phase = phase;
        this.dialog.querySelector('.settings-body').scrollTop = 0;
      }

      const pending = this.pendingHostState();
      this.get('status').textContent = this.detail();
      this.get('status').hidden = !active || occupied;
      this.get('connection').hidden = !active || occupied;
      this.get('connection').dataset.connected = String(connected);
      this.get('connection').querySelector('.direct-connection-icon').textContent = connected ? '✓' : '↻';
      this.get('connection-title').textContent = connected
        ? (this.role === 'host' ? '同步已连接 · 本机为操作端' : '同步已连接 · 本机为跟随端')
        : pending === 'failed'
          ? '同步连接未建立'
          : pending === 'handshaking'
            ? '正在建立同步连接…'
            : this.state === 'offline'
              ? '同步连接已中断'
              : '等待完成扫码连接';

      this.get('choices').hidden = occupied || (connected && this.role === 'mirror');
      this.get('pairing').hidden = !pairing || scanning || this.busy;
      this.get('camera').hidden = !scanning;
      this.get('loading').hidden = !this.busy || scanning;
      this.get('loading').textContent = this.loadingText || '正在处理，请稍候…';

      this.get('create').hidden = this.role === 'mirror';
      this.get('create-label').textContent = this.role === 'host'
        ? (connected ? '继续添加跟随设备' : '重新生成邀请码')
        : '本机作为操作端';
      this.get('create-help').textContent = this.role === 'host' && connected
        ? '再生成一次邀请码，已连接的设备不会断开'
        : '在本机记录消融 · 第 1 步出示邀请码，第 2 步扫对方回码';

      this.get('join').hidden = this.role === 'host';
      this.get('join-label').textContent = this.role === 'mirror' ? '重新扫码连接' : '本机作为跟随端';
      this.get('join-help').textContent = this.role === 'mirror'
        ? '第 1 步扫操作端邀请码，第 2 步出示回码'
        : '只读同步画面 · 第 1 步扫操作端邀请码，第 2 步出示回码';

      const isHostPairing = this.role === 'host';
      this.get('scan-answer').hidden = !isHostPairing;
      this.get('cancel-step').hidden = !pairing;
      this.get('cancel-step').textContent = isHostPairing
        ? (this.peers > 0 ? '取消添加设备' : '返回重选角色')
        : '重新扫描邀请码';

      this.get('caption').textContent = isHostPairing
        ? '第 1 步 · 操作端邀请码'
        : '第 2 步 · 跟随端回码（等待操作端扫描）';
      this.get('next').textContent = isHostPairing
        ? '第 1 步：请用跟随端扫描下方邀请码'
        : '第 2 步：请用操作端扫描下方回码';
      this.get('help').textContent = isHostPairing
        ? '在另一台设备打开“设备同步 → 本机作为跟随端”扫描此码。待对方屏幕出现“回码”后，点击下方按钮进入第 2 步。'
        : (this.client?.pendingPeer?.pc?.connectionState === 'failed'
          ? '连接未能建立，请确认双端连接同一 Wi-Fi 或热点后，点击下方“重新扫描邀请码”。'
          : '请保持此二维码开启。在操作端点击“对方已出回码，开始扫描”，用操作端扫描此码后即自动完成连接。');

      this.get('camera-title').textContent = this.scanTarget === 'answer'
        ? '第 2 步：请扫描跟随端屏幕上的回码'
        : '第 1 步：请扫描操作端屏幕上的邀请码';
      this.get('stop-camera').textContent = this.scanTarget === 'answer'
        ? '返回查看邀请码（第 1 步）'
        : '返回上一步';

      this.get('steps').hidden = !pairing && !scanning;
      const hostFlow = this.role === 'host' || this.scanTarget === 'answer';
      const secondStep = hostFlow ? this.scanTarget === 'answer' : pairing;
      this.get('step-one-label').textContent = hostFlow ? '出示邀请码' : '扫描邀请码';
      this.get('step-two-label').textContent = hostFlow ? '扫描对方回码' : '出示回码';
      const stepOne = this.get('step-one');
      const stepTwo = this.get('step-two');
      stepOne.setAttribute('aria-current', secondStep ? 'false' : 'step');
      stepOne.dataset.done = String(secondStep);
      stepOne.querySelector('span').textContent = secondStep ? '✓' : '1';
      stepTwo.setAttribute('aria-current', secondStep ? 'step' : 'false');
      stepTwo.dataset.done = 'false';
      stepTwo.querySelector('span').textContent = '2';

      this.get('leave').hidden = !active || scanning || this.busy;
      this.get('note').hidden = scanning || this.busy;
      this.get('note').textContent = active
        ? '请保持双端网页处于打开状态；如刷新网页需重新扫码连接。'
        : '先在主控设备选“本机作为操作端”，再在另一台设备选“本机作为跟随端”。';

      this.get('done').classList.toggle('primary', connected && !occupied);
      this.get('done').textContent = connected && !occupied
        ? (this.role === 'host' ? '继续记录' : '查看记录')
        : '返回记录';

      if (this.code && this.renderedCode !== this.code) {
        this.options.renderQr(this.get('qr'), this.code, this.role === 'host' ? '操作端邀请码二维码' : '跟随端回码二维码');
        this.renderedCode = this.code;
      } else if (!this.code && this.renderedCode) {
        this.get('qr').replaceChildren();
        delete this.get('qr').dataset.qrValue;
        this.renderedCode = '';
      }

      for (const name of ['create', 'join', 'scan-answer', 'cancel-step', 'leave']) {
        this.get(name).disabled = this.busy || Boolean(this.options.isHandoffPending?.());
      }
    }

    async prepare() {
      await this.ensureClient();
      if (!global.jsQR) await load('./vendor/jsqr.js');
    }

    async open() {
      this.get('error').hidden = true;
      this.render();
      if (!this.dialog.open) {
        this.dialog.showModal();
        this.get('title').focus({ preventScroll: true });
      }
      try {
        await this.prepare();
      } catch (error) {
        this.error(error);
      }
    }

    close() {
      this.stopCamera();
      this.dialog.close();
    }

    async create() {
      if (this.busy) return;
      this.stopCamera();
      this.busy = true;
      this.loadingText = '正在生成第 1 步邀请码，请稍候…';
      this.get('error').hidden = true;
      this.render();
      const wasLocal = this.role === 'local';
      try {
        await this.ensureClient();
        const details = await this.client.createLocalOffer({ deviceId: this.options.deviceId, deviceName: '操作手机' });
        this.role = 'host';
        this.state = 'connecting';
        this.options.onRole('host');
        this.persist();
        this.code = details.offerCode;
        this.renderedCode = '';
        this.options.sendCurrent();
      } catch (error) {
        if (wasLocal) {
          this.client?.disconnect({ silent: true });
          this.state = 'local';
          this.options.onStatus({ state: 'local', peerCount: 0 });
        }
        this.error(error);
      } finally {
        this.busy = false;
        this.loadingText = '';
        this.render();
        if (this.dialog.open && this.code) this.get('scan-answer').focus({ preventScroll: true });
      }
    }

    async accept(value, target) {
      if (!value || this.busy) return;
      this.stopCamera();
      this.busy = true;
      this.loadingText = target === 'answer'
        ? '已识别回码，正在建立双端同步连接…'
        : '已识别邀请码，正在生成第 2 步回码…';
      this.get('error').hidden = true;
      this.render();
      try {
        await this.ensureClient();
        if (target === 'answer') {
          await this.client.applyLocalAnswer(value);
          this.code = '';
          this.renderedCode = '';
          this.options.sendCurrent();
        } else {
          await global.VictoryPVIDirectClient.parseLocalPairingCode(value, 'offer');
          const details = await this.client.joinLocalOffer(value, { deviceId: this.options.deviceId, deviceName: '跟随手机' });
          this.role = 'mirror';
          this.state = 'connecting';
          this.options.onRole('mirror');
          this.persist();
          this.code = details.answerCode;
          this.renderedCode = '';
        }
      } catch (error) {
        if (target === 'offer' && this.role === 'local') {
          this.client?.disconnect({ silent: true });
          this.state = 'local';
          this.options.onStatus({ state: 'local', peerCount: 0 });
        }
        this.error(error);
      } finally {
        this.busy = false;
        this.loadingText = '';
        this.render();
      }
    }

    cancelStep() {
      if (this.busy) return;
      if (this.role === 'mirror') {
        void this.scan('offer');
        return;
      }
      if (this.role === 'host') {
        if (this.peers > 0) {
          if (this.client?.pendingPeer && !this.client.pendingPeer.deviceId) {
            this.client.dropPeer(this.client.pendingPeer);
          }
          this.code = '';
          this.renderedCode = '';
          this.get('error').hidden = true;
          this.render();
        } else {
          this.resetToChoose();
        }
      }
    }

    sendSnapshot(payload, revision) {
      this.client?.sendSnapshot(payload, revision);
    }

    stopCamera() {
      this.scanGeneration = (this.scanGeneration || 0) + 1;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = null;
      this.stream?.getTracks().forEach(track => track.stop());
      this.stream = null;
      this.scanTarget = null;
      this.get('video').srcObject = null;
      this.render();
    }

    async scan(target) {
      this.stopCamera();
      const generation = this.scanGeneration;
      this.scanTarget = target;
      this.get('error').hidden = true;
      this.get('camera-status').textContent = '正在打开摄像头，请允许浏览器访问相机…';
      this.render();
      this.get('stop-camera').focus({ preventScroll: true });
      try {
        // The decoder is preloaded for standalone phones and when opening this flow.
        await this.ensureClient();
        if (!global.jsQR) await load('./vendor/jsqr.js');
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('当前浏览器环境无法调用摄像头，请使用系统自带浏览器（Safari 或 Chrome）通过 HTTPS 打开网页后扫码。');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        });
        if (generation !== this.scanGeneration) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        this.stream = stream;
        const video = this.get('video');
        video.srcObject = stream;
        await video.play();
        if (generation !== this.scanGeneration) return;
        this.get('camera-status').textContent = target === 'answer'
          ? '请将取景框对准跟随端显示的“第 2 步 · 跟随端回码”，识别后自动完成连接'
          : '请先在操作端选择“本机作为操作端”，再将取景框对准其“邀请码”二维码';
        const tick = () => {
          if (generation !== this.scanGeneration || !this.stream) return;
          if (video.readyState >= 2 && video.videoWidth && this.context) {
            this.canvas.width = Math.min(960, video.videoWidth);
            this.canvas.height = Math.round(video.videoHeight * this.canvas.width / video.videoWidth);
            this.context.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
            const frame = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
            const decoded = global.jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
            if (decoded?.data) {
              void this.accept(decoded.data, target);
              return;
            }
          }
          this.frame = requestAnimationFrame(tick);
        };
        tick();
      } catch (error) {
        if (generation !== this.scanGeneration) return;
        this.stopCamera();
        this.error(this.formatCameraError(error));
      }
    }

    resetToChoose() {
      this.stopCamera();
      this.client?.disconnect({ silent: true });
      this.role = 'local';
      this.state = 'local';
      this.code = '';
      this.renderedCode = '';
      this.peers = 0;
      this.loadingText = '';
      this.persist();
      this.get('error').hidden = true;
      this.options.onRole('local');
      this.options.onStatus({ state: 'local', peerCount: 0 });
      this.render();
    }

    leave() {
      this.resetToChoose();
      this.close();
    }
  }

  global.VictoryPVIDirectUI = VictoryPVIDirectUI;
})(window);
