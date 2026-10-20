import { html, render, useEffect, useRef, useState } from '/vendor/preact-htm.js';

const STATE_LABEL = { starting: '準備中', recording: '錄影中', finishing: '傳輸中', ready: '可播放', failed: '失敗' };
const STOP_NOTE = { maxDuration: '・到上限自動停止', error: '・手機端中斷，提早停止' };
const RESOLUTIONS = [
  ['2160p', '4K'],
  ['1080p', '1080p'],
  ['720p', '720p'],
];

// ---------- 小工具 ----------

function fmtBytes(n) {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h ? `${h}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

const fmtRate = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`);

// 1800 → 「30 分鐘」；不是整分鐘時用秒
const fmtDuration = (sec) => (sec % 60 === 0 ? `${sec / 60} 分鐘` : `${sec} 秒`);

async function post(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const isActive = (f) => f.state === 'starting' || f.state === 'recording';

// 把資料夾或檔案拖進瀏覽器時，Chrome 會直接打開它、蓋掉控制台，所以一律攔下來
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());

// 剩 3 分鐘的提示音。瀏覽器規定要先有使用者操作才能出聲，所以第一次按鍵或點擊時才建立。
let audio;
for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(type, () => {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
  });
}

function beep() {
  if (!audio) return;
  const t0 = audio.currentTime;
  for (let i = 0; i < 3; i++) {
    const at = t0 + i * 0.32;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.2);
  }
}

// ---------- 資料 ----------

function useServerState() {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws;
    let timer;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws/ui`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'state') setState({ ...m, clockOffset: m.serverTime - Date.now() });
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);
  return [state, connected];
}

function useNow(interval) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

// ---------- 主畫面 ----------

function App() {
  const [state, connected] = useServerState();
  const now = useNow(250);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const warnedTakes = useRef(new Set());

  const notify = (text, kind = 'info') => setToast({ text, kind, id: Date.now() });
  const run = async (fn) => {
    try {
      const r = await fn();
      if (r?.skipped?.length) notify(r.skipped.join('、'), 'warn');
    } catch (e) {
      notify(e.message, 'error');
    }
  };
  const start = (deviceIds) => run(() => post('/api/record/start', { deviceIds }));
  const stop = (deviceIds) => run(() => post('/api/record/stop', { deviceIds }));

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // 快捷鍵：R 全部開始、S 全部停止。輸入框打字、或按著 ⌘/Ctrl（例如 ⌘R 重新整理）時不觸發。
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') return setModal(null);
      if (modal || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.target.closest?.('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (k === 'r') start();
      if (k === 's') stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  // 同一次錄影只響一次
  useEffect(() => {
    if (!state) return;
    const t = now + state.clockOffset;
    for (const f of state.files) {
      if (f.state !== 'recording' || !f.startedAt) continue;
      const left = f.spec.maxDurationSec * 1000 - (t - f.startedAt);
      if (left <= state.limits.warnBeforeSec * 1000 && !warnedTakes.current.has(f.takeId)) {
        warnedTakes.current.add(f.takeId);
        beep();
      }
    }
  }, [state, now]);

  if (!state) return html`<div class="boot">正在連線到 Mac 伺服器…</div>`;

  const t = now + state.clockOffset;
  const online = state.devices.filter((d) => d.online);
  const canStart = online.some((d) => !state.files.some((f) => f.deviceId === d.id && isActive(f)) && d.status.cameraReady !== false);
  const canStop = state.files.some(isActive);

  return html`
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <div>
          <div class="brand-name">多機錄影控制台</div>
          <div class="brand-sub">MULTICAM RECORDER</div>
        </div>
      </div>
      <div class="readouts">
        <div class="readout">
          <span class="label">連線</span>
          <span class="readout-value">${online.length}<small>/ ${state.devices.length} 台</small></span>
        </div>
        <div class="readout">
          <span class="label" id="resolution-label">錄影解析度</span>
          <div class="segmented" role="radiogroup" aria-labelledby="resolution-label">
            ${RESOLUTIONS.map(
              ([value, label]) => html`<button
                role="radio"
                aria-checked=${value === state.settings.resolution}
                class=${value === state.settings.resolution ? 'on' : ''}
                disabled=${canStop}
                onClick=${() => value !== state.settings.resolution && run(() => post('/api/settings', { resolution: value }))}
              >
                ${label}
              </button>`,
            )}
          </div>
          <span class="readout-note">
            ${canStop
              ? '錄影中不能改，停止後再調整'
              : `所有手機下次開始時套用・${fmtDuration(state.limits.maxDurationSec)}約 ${fmtBytes(
                  (state.recordingBitrate / 8) * state.limits.maxDurationSec,
                )}`}
          </span>
        </div>
      </div>
      <div class="transport">
        <button class="btn-rec" disabled=${!canStart} onClick=${() => start()}>
          <span class="dot"></span>開始錄影<kbd>R</kbd>
        </button>
        <button class="btn-stop" disabled=${!canStop} onClick=${() => stop()}>
          <span class="square"></span>停止<kbd>S</kbd>
        </button>
      </div>
      <div class="tools">
        <button class="btn-ghost" onClick=${() => setModal('pair')}>配對手機</button>
        <button class="btn-ghost" onClick=${() => setModal('settings')}>設定</button>
      </div>
    </header>

    <${Alerts} state=${state} connected=${connected} t=${t} />

    <main class="bays">
      ${state.devices.length
        ? state.devices.map(
            (d, i) => html`<${Bay}
              key=${d.id}
              state=${state}
              device=${d}
              letter=${String.fromCharCode(65 + i)}
              t=${t}
              onStart=${() => start([d.id])}
              onStop=${() => stop([d.id])}
              notify=${notify}
            />`,
          )
        : html`<div class="empty">
            <h2>還沒有配對手機</h2>
            <p>手機和 Mac 連同一個 Wi-Fi，打開手機上的錄影 App 掃描 QR Code。</p>
            <button class="btn-primary" onClick=${() => setModal('pair')}>顯示配對 QR Code</button>
          </div>`}
    </main>

    ${modal === 'pair' && html`<${PairModal} devices=${state.devices} onClose=${() => setModal(null)} />`}
    ${modal === 'settings' &&
    html`<${SettingsModal} state=${state} onClose=${() => setModal(null)} notify=${notify} />`}
    ${toast && html`<div class=${`toast ${toast.kind}`} key=${toast.id} role="status">${toast.text}</div>`}
  `;
}

function Alerts({ state, connected, t }) {
  const items = [];
  const nameOf = (id) => state.devices.find((d) => d.id === id)?.name ?? '手機';
  if (!connected) items.push(['error', '和 Mac 伺服器的連線中斷了，正在重新連線…']);

  const s = state.storage;
  if (!s.available) items.push(['error', `錄影資料夾不能用：${s.error}。請到「設定」確認。`]);
  else {
    if (s.warning) items.push(['warn', s.warning]);
    if (s.freeBytes < 25e9) {
      items.push(['warn', `錄影資料夾只剩 ${fmtBytes(s.freeBytes)}。4K 每台手機錄 30 分鐘大約需要 9 GB。`]);
    }
  }

  for (const d of state.devices) {
    if (!d.online && state.files.some((f) => f.deviceId === d.id && isActive(f))) {
      items.push(['error', `${d.name} 離線了。手機應該還在錄影，連回來之後會自動補傳。`]);
    }
  }

  // 剩 3 分鐘：同一次錄影的手機合成一則
  const takes = new Map();
  for (const f of state.files) {
    if (f.state !== 'recording' || !f.startedAt) continue;
    const left = f.spec.maxDurationSec * 1000 - (t - f.startedAt);
    if (left > state.limits.warnBeforeSec * 1000) continue;
    const take = takes.get(f.takeId) ?? { left, names: [] };
    take.left = Math.min(take.left, left);
    take.names.push(nameOf(f.deviceId));
    takes.set(f.takeId, take);
  }
  for (const take of takes.values()) {
    items.push([
      'countdown',
      html`再 <b>${fmtClock(take.left)}</b> 就到 ${fmtDuration(state.limits.maxDurationSec)}上限，會自動停止（${take.names.join('、')}）`,
    ]);
  }

  if (!items.length) return null;
  return html`<div class="alerts">${items.map(([kind, text]) => html`<div class=${`alert ${kind}`}>${text}</div>`)}</div>`;
}

function Bay({ state, device, letter, t, onStart, onStop, notify }) {
  const files = state.files.filter((f) => f.deviceId === device.id).sort((a, b) => b.createdAt - a.createdAt);
  const active = files.find(isActive);
  const recording = active?.state === 'recording' && active.startedAt;
  const elapsed = recording ? t - active.startedAt : 0;
  const maxMs = (active?.spec.maxDurationSec ?? state.limits.maxDurationSec) * 1000;
  const warn = recording && maxMs - elapsed <= state.limits.warnBeforeSec * 1000;
  const st = device.status;

  // 播放器：有新影片傳完就自動放上去（正在播別支、或選了別支時不打斷）
  const [selectedId, setSelectedId] = useState(null);
  const videoRef = useRef(null);
  const prevLatest = useRef(null);
  const latestReady = files.find((f) => f.state === 'ready')?.id ?? null;
  useEffect(() => {
    const idle = videoRef.current?.paused ?? true;
    if (latestReady && idle && (!selectedId || selectedId === prevLatest.current)) setSelectedId(latestReady);
    prevLatest.current = latestReady;
  }, [latestReady]);
  const selected = files.find((f) => f.id === selectedId && f.state === 'ready');

  const tally = recording ? 'on' : device.online && st.cameraReady !== false ? 'ready' : '';
  const minutesLeft = st.freeBytes != null ? Math.floor(st.freeBytes / (state.recordingBitrate / 8) / 60) : null;

  return html`
    <section class=${`bay ${recording ? 'rec' : ''} ${device.online ? '' : 'offline'}`}>
      <div class="bay-head">
        <span class=${`tally ${tally}`} aria-hidden="true"></span>
        <span class="cam">CAM ${letter}</span>
        <${NameEditor} device=${device} notify=${notify} />
        <span class="model">${device.model}</span>
        ${st.audioInput && html`<span class=${`mic ${st.audioInput.startsWith('外接') ? 'ext' : ''}`} title="這台目前用哪支麥克風收音">${st.audioInput}</span>`}
        <span class=${`conn ${device.online ? 'on' : 'off'}`}>${device.online ? '已連線' : '離線'}</span>
      </div>

      <div class="bay-timecode">
        <div class=${`tc ${recording ? 'live' : ''} ${warn ? 'warn' : ''}`} aria-live="off">
          ${active?.state === 'starting' ? '準備中' : fmtClock(elapsed)}
          <small>/ ${fmtClock(maxMs)}</small>
        </div>
        <div class="bay-actions">
          ${active
            ? html`<button class="btn-ghost btn-small" disabled=${!device.online} onClick=${onStop}>單獨停止</button>`
            : html`<button
                class="btn-ghost btn-small"
                disabled=${!device.online || st.cameraReady === false}
                onClick=${onStart}
              >
                單獨開始
              </button>`}
        </div>
      </div>

      <div class="meters">
        <${Meter} label="電量" value=${st.battery != null ? `${st.battery}%${st.charging ? ' ⚡' : ''}` : '—'} level=${st.battery != null && st.battery <= 15 && !st.charging ? 'bad' : st.battery <= 30 && !st.charging ? 'warn' : ''} />
        <${Meter} label="溫度" value=${st.temperatureC != null ? `${st.temperatureC.toFixed(0)}°C` : '—'} level=${st.temperatureC >= 48 ? 'bad' : st.temperatureC >= 42 ? 'warn' : ''} />
        <${Meter} label="手機空間" value=${st.freeBytes != null ? fmtBytes(st.freeBytes) : '—'} level=${minutesLeft != null && minutesLeft < 35 ? 'warn' : ''} />
        <${Meter} label="還能錄" value=${minutesLeft != null ? `${minutesLeft} 分` : '—'} level=${minutesLeft != null && minutesLeft < 35 ? 'warn' : ''} />
      </div>

      <div class="monitor">
        ${selected
          ? html`<video ref=${videoRef} key=${selected.id} src=${`/media/${selected.id}`} controls preload="metadata" playsinline></video>`
          : html`<div class="monitor-empty">錄完的影片傳到 Mac 之後，會出現在這裡</div>`}
      </div>
      ${selected && html`<div class="monitor-caption">${selected.name}</div>`}

      <ul class="clips">
        ${files.length
          ? files.map(
              (f) =>
                html`<${Clip}
                  key=${f.id}
                  f=${f}
                  state=${state}
                  selected=${f.id === selected?.id}
                  onPlay=${() => setSelectedId(f.id)}
                />`,
            )
          : html`<li class="clips-empty">還沒有錄影</li>`}
      </ul>
    </section>
  `;
}

function Meter({ label, value, level }) {
  return html`<div class="meter">
    <div class="label">${label}</div>
    <div class=${`meter-value ${level || ''}`}>${value}</div>
  </div>`;
}

// 傳輸速度：用最近 5 秒收到的量估算；停住多久沒有新資料
function useTransferRate(bytes) {
  const samples = useRef([]);
  const now = Date.now();
  const list = samples.current;
  if (!list.length || list[list.length - 1].bytes !== bytes) list.push({ at: now, bytes });
  while (list.length > 2 && now - list[0].at > 5000) list.shift();
  const first = list[0];
  const last = list[list.length - 1];
  const rate = last.at > first.at ? ((last.bytes - first.bytes) / (last.at - first.at)) * 1000 : null;
  return { rate, idleMs: now - last.at };
}

function Clip({ f, state, selected, onPlay }) {
  const progress = f.size ? Math.min(1, f.receivedBytes / f.size) : null;
  const { rate, idleMs } = useTransferRate(f.receivedBytes);
  const sending = f.state === 'recording' || (f.state === 'finishing' && progress < 1);
  const stalled = sending && idleMs > 8000;
  const speed = sending && !stalled && rate ? `・${fmtRate(rate)}` : '';
  let detail;
  if (f.state === 'starting') detail = '等待手機開始';
  else if (f.state === 'recording') detail = `邊錄邊傳，已傳 ${fmtBytes(f.receivedBytes)}${speed}`;
  else if (f.state === 'finishing') detail = progress >= 1 ? '驗證檔案中' : `收尾傳輸 ${Math.floor((progress ?? 0) * 100)}%${speed}`;
  else if (f.state === 'ready') detail = `${fmtClock(f.durationMs ?? 0)}・${fmtBytes(f.size)}${STOP_NOTE[f.stopReason] ?? ''}`;
  else detail = f.error || '錄影失敗';

  // 同一次錄影的另一台，顯示開始時間差多少
  const peer = state.files.find((g) => g.takeId === f.takeId && g.deviceId !== f.deviceId && g.startedAt);
  let sync = null;
  if (peer && f.startedAt) {
    const diff = f.startedAt - peer.startedAt;
    const ms = Math.round(Math.abs(diff));
    const peerName = state.devices.find((d) => d.id === peer.deviceId)?.name ?? '另一台';
    sync = ms === 0 ? `和 ${peerName} 同時開始` : `比 ${peerName} ${diff > 0 ? '晚' : '早'} ${ms} ms`;
  }

  return html`<li class=${`clip ${selected ? 'selected' : ''}`}>
    <button class="clip-play" disabled=${f.state !== 'ready'} onClick=${onPlay} aria-label=${`播放 ${f.name}`}></button>
    <div>
      <div class="clip-name" title=${`${f.dir}/${f.name}`}>${f.name}</div>
      <div class="clip-meta">
        <span class=${`chip ${f.state}`}>${STATE_LABEL[f.state]}</span>
        <span>${detail}</span>
        ${stalled && html`<span class="clip-stalled">傳輸停住了，請檢查這支手機的 Wi-Fi 訊號</span>`}
        ${sync && html`<span class="clip-sync">${sync}</span>`}
      </div>
    </div>
    ${f.state === 'recording' && html`<div class="clip-progress"><span class="streaming"></span></div>`}
    ${f.state === 'finishing' && html`<div class="clip-progress"><span style=${{ width: `${(progress ?? 0) * 100}%` }}></span></div>`}
  </li>`;
}

function NameEditor({ device, notify }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(device.name);
  const inputRef = useRef(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    if (!editing) return;
    setEditing(false);
    const name = value.trim();
    if (!name || name === device.name) return;
    try {
      await post(`/api/devices/${device.id}/rename`, { name });
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  if (!editing) {
    return html`<button
      class="name"
      title="點一下改名稱（之後的檔名也會用這個名稱）"
      onClick=${() => {
        setValue(device.name);
        setEditing(true);
      }}
    >
      ${device.name}
    </button>`;
  }
  return html`<input
    ref=${inputRef}
    class="name-input"
    value=${value}
    maxlength="40"
    aria-label="手機名稱"
    onInput=${(e) => setValue(e.target.value)}
    onBlur=${commit}
    onKeyDown=${(e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') {
        e.stopPropagation();
        setEditing(false);
      }
    }}
  />`;
}

function PairModal({ devices, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const now = useNow(1000);
  const load = (renew = false) => {
    setError(null);
    post('/api/pairing', { renew }).then(setData, (e) => setError(e.message));
  };
  useEffect(() => load(), []);
  const left = data ? data.expiresAt - now : 0;

  return html`<div class="modal-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true" aria-label="配對手機">
      <div class="modal-head">
        <h2>配對手機</h2>
        <button class="btn-ghost btn-small" onClick=${onClose}>關閉</button>
      </div>
      <div class="modal-body">
        <div class="pair">
          <div class="qr-frame">
            ${data && left > 0
              ? html`<img src=${data.qr} alt="配對用 QR Code" />`
              : html`<div class="qr-loading">${error || (data ? 'QR Code 已失效' : '產生中…')}</div>`}
          </div>
          <div>
            <ol class="steps">
              <li>手機和 Mac 連同一個 Wi-Fi（不要用訪客網路）</li>
              <li>用手機相機掃這個 QR Code，點開連結後按「打開 App 並配對」；也可以在 App 裡點「掃描 QR Code」</li>
              <li>連上之後，下面會出現手機名稱</li>
            </ol>
            ${data &&
            html`<div class="pair-meta">
              手機會連到 <code>${data.payload.url}</code><br />
              ${left > 0 ? `${fmtClock(left)} 後失效` : '已失效'}・<button class="btn-link" onClick=${() => load(true)}>重新產生</button>
            </div>`}
            <div class="paired">
              ${devices.map((d) => html`<span class=${`paired-chip ${d.online ? 'on' : ''}`}>${d.name}</span>`)}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function SettingsModal({ state, onClose, notify }) {
  const [dir, setDir] = useState(state.settings.storageDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const s = state.storage;

  // 儲存時伺服器會檢查資料夾存在而且可以寫入，不會自動建立
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/settings', { storageDir: dir });
      notify('已更新錄影資料夾');
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // 跳出 macOS 的「選擇檔案夾」視窗（瀏覽器本身拿不到資料夾的完整路徑）
  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/api/choose-folder');
      if (r.path) setDir(r.path);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return html`<div class="modal-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true" aria-label="設定">
      <div class="modal-head">
        <h2>設定</h2>
        <button class="btn-ghost btn-small" onClick=${onClose}>關閉</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="label" for="storage-dir">錄影資料夾（Mac）</label>
          <div class="field-row" onDrop=${() => setError('瀏覽器拿不到拖進來的資料夾完整路徑，請按「選擇資料夾…」挑選，或直接貼上路徑')}>
            <input
              id="storage-dir"
              value=${dir}
              spellcheck="false"
              onInput=${(e) => {
                setDir(e.target.value);
                setError(null);
              }}
              onKeyDown=${(e) => e.key === 'Enter' && save()}
            />
            <button class="btn-ghost" disabled=${busy} onClick=${choose}>選擇資料夾…</button>
          </div>
        </div>
        ${error && html`<p class="hint bad" role="alert">${error}</p>`}
        <p class="hint">
          建議選外接 SSD 上的資料夾，硬碟格式要是 APFS 或 exFAT。在選擇視窗裡可以按「新增檔案夾」建立新的資料夾。
        </p>
        ${s.available
          ? html`<p class=${`hint ${s.warning ? 'warn' : ''}`}>
              目前資料夾剩 ${fmtBytes(s.freeBytes)}${s.warning ? `。${s.warning}` : ''}
            </p>`
          : html`<p class="hint bad">目前資料夾不能用：${s.error}</p>`}
        <div class="modal-foot">
          <button class="btn-ghost" onClick=${onClose}>取消</button>
          <button class="btn-primary" disabled=${busy} onClick=${save}>儲存</button>
        </div>
      </div>
    </div>
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
