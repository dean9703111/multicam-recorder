import { html, render, useEffect, useRef, useState } from '/vendor/preact-htm.js';

const STATE_LABEL = { starting: '準備中', recording: '錄影中', finishing: '傳輸中', ready: '可播放', failed: '失敗' };
const STOP_NOTE = { maxDuration: '・到上限自動停止', error: '・手機端中斷，提早停止' };
const GUIDE_LABEL = { none: '不顯示', '9:16': '9:16 直式', '4:5': '4:5', '1:1': '1:1 方形' };
const GUIDE_RATIO = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1 };

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

const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

// 新專案的預設名稱：2026-10-20，同一天第二個專案是 2026-10-20-2
function newProjectName(state) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  let name = base;
  for (let i = 2; state.projects.some((x) => x.name === name); i++) name = `${base}-${i}`;
  return name;
}

// 「在 Finder 中顯示」的說法依電腦的系統而定
const REVEAL_LABEL = { darwin: '在 Finder 中顯示', win32: '在檔案總管中顯示' };
const revealLabel = (state) => REVEAL_LABEL[state.platform] ?? '打開資料夾';

async function post(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

const isActive = (f) => f.state === 'starting' || f.state === 'recording';
const resolutionOf = (state) => state.resolutions.find((r) => r.id === state.settings.resolution) ?? state.resolutions[0];
const bytesPerTake = (state, r) => (r.bitrate / 8) * state.limits.maxDurationSec;
// 實際尺寸對應到選項名稱，例如 3840×2160 → 4K
const sizeLabel = (state, w, h) => state.resolutions.find((r) => r.width === w && r.height === h)?.label ?? `${w}×${h}`;
// 顯示用的路徑，用伺服器那台電腦的分隔符號（Windows 是 \）
const joinPath = (state, ...parts) => parts.join(state.sep);
// 可以移到垃圾桶的影片：傳完的和失敗的。錄影中、傳輸中的不能刪。
const canTrash = (f) => f.state === 'ready' || f.state === 'failed';
// 段數：同一次按開始錄的算一段
const countTakes = (files) => new Set(files.map((f) => f.takeId)).size;
const sumBytes = (files) => files.reduce((n, f) => n + ((f.state === 'ready' ? f.size : f.receivedBytes) ?? 0), 0);

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

// ---------- 即時畫面 ----------

// 收到的 JPEG 直接換到 <img> 上，不經過 Preact，一秒好幾張也不會整頁重畫
const liveViews = new Map(); // 手機 ID → { img, url, at, onFrame }
let uiSocket = null;

// 告訴伺服器目前畫面上要看哪幾台的即時畫面，沒在看的手機就不用傳
function sendWatchList() {
  if (uiSocket?.readyState === WebSocket.OPEN) uiSocket.send(JSON.stringify({ type: 'watch', deviceIds: [...liveViews.keys()] }));
}

// 格式：1 個位元組的手機 ID 長度、手機 ID、JPEG
function onPreviewFrame(buffer) {
  const bytes = new Uint8Array(buffer);
  const id = new TextDecoder().decode(bytes.subarray(1, 1 + bytes[0]));
  const view = liveViews.get(id);
  if (!view?.img) return;
  const old = view.url;
  view.url = URL.createObjectURL(new Blob([bytes.subarray(1 + bytes[0])], { type: 'image/jpeg' }));
  view.img.src = view.url;
  view.at = Date.now();
  if (old) URL.revokeObjectURL(old);
  view.onFrame();
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
      ws.binaryType = 'arraybuffer';
      uiSocket = ws;
      ws.onopen = () => {
        setConnected(true);
        sendWatchList(); // 重新連上後要再說一次
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return onPreviewFrame(e.data);
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
  const [modal, setModal] = useState(null); // { kind: 'pair' | 'settings' | 'newProject' | 'endProject' | 'removeDevice' | 'trash', … }
  const [menu, setMenu] = useState(null); // 'project' | 'spec'
  const [selection, setSelection] = useState(null); // 選取模式中勾選的影片 ID；null 表示不在選取模式
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
  // 還沒有專案就先請使用者新增
  const start = async (deviceIds) => {
    try {
      const r = await post('/api/record/start', { deviceIds });
      if (r.skipped?.length) notify(r.skipped.join('、'), 'warn');
    } catch (e) {
      if (!e.data?.needProject) return notify(e.message, 'error');
      setModal({ kind: 'newProject' });
      notify('開始錄影前，請先新增專案', 'warn');
    }
  };
  const stop = (deviceIds) => run(() => post('/api/record/stop', { deviceIds }));
  const closeModal = () => setModal(null);
  // 先把正在播放的影片關掉再搬，Windows 上檔案開著時可能搬不動
  const trash = async (ids) => {
    for (const v of document.querySelectorAll('video')) {
      if (!ids.includes(v.dataset.fileId)) continue;
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    const r = await post('/api/files/trash', { fileIds: ids });
    notify(`已把 ${r.trashed} 支影片移到${state.trashName}`);
    setSelection(null);
  };
  const toggleSelected = (id) =>
    setSelection((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // 選單打開時，點其他地方就關掉
  useEffect(() => {
    if (!menu) return;
    const close = (e) => !e.target.closest('.menu-anchor') && setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  // 快捷鍵：R 全部開始、S 全部停止。輸入框打字、或按著 ⌘/Ctrl（例如 ⌘R 重新整理）時不觸發。
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        // 先關對話框和選單，沒有的話才離開選取模式
        if (modal || menu) {
          setMenu(null);
          setModal(null);
        } else setSelection(null);
        return;
      }
      if (modal || menu || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.target.closest?.('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (k === 'r') start();
      if (k === 's') stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, menu]);

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

  if (!state) return html`<div class="boot">正在連線到伺服器…</div>`;

  const t = now + state.clockOffset;
  const online = state.devices.filter((d) => d.online);
  const recording = state.files.some(isActive);
  const canStart = online.some((d) => !state.files.some((f) => f.deviceId === d.id && isActive(f)) && d.status.cameraReady !== false);
  // 手機多時，每台的監看區縮小，播放器點了才打開
  const compact = state.devices.length > 3;
  const toggleMenu = (name) => setMenu(menu === name ? null : name);
  const fromMenu = (fn) => () => {
    setMenu(null);
    fn();
  };
  const pending = state.files.filter((f) => f.state === 'finishing').length;

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
        <${ProjectControl}
          state=${state}
          open=${menu === 'project'}
          recording=${recording}
          onToggle=${() => toggleMenu('project')}
          onNew=${fromMenu(() => setModal({ kind: 'newProject' }))}
          onEnd=${fromMenu(() => setModal({ kind: 'endProject' }))}
          onOpen=${(id) => fromMenu(() => run(() => post(`/api/projects/${id}/open`)))()}
          onShowFolder=${fromMenu(() => run(() => post('/api/open-folder')))}
          onTrashUnmarked=${fromMenu(() =>
            setModal({ kind: 'trash', unmarked: true, ids: state.files.filter((f) => canTrash(f) && !f.marked).map((f) => f.id) }),
          )}
          onSelect=${fromMenu(() => setSelection(new Set()))}
        />
        <div class="readout">
          <span class="label">連線</span>
          <span class="readout-value">${online.length}<small>/ ${state.devices.length} 台</small></span>
        </div>
        <${SpecControl}
          state=${state}
          open=${menu === 'spec'}
          recording=${recording}
          onToggle=${() => toggleMenu('spec')}
          run=${run}
        />
      </div>
      <div class="transport">
        <button class="btn-rec" disabled=${!canStart} onClick=${() => start()}>
          <span class="dot"></span>開始錄影<kbd>R</kbd>
        </button>
        <button class="btn-stop" disabled=${!recording} onClick=${() => stop()}>
          <span class="square"></span>停止<kbd>S</kbd>
        </button>
      </div>
      <div class="tools">
        <button class="btn-ghost" onClick=${() => setModal({ kind: 'pair' })}>配對手機</button>
        <button class="btn-ghost" onClick=${() => setModal({ kind: 'settings' })}>設定</button>
      </div>
    </header>

    <${Alerts}
      state=${state}
      connected=${connected}
      t=${t}
      onSettings=${() => setModal({ kind: 'settings' })}
      onNewProject=${() => setModal({ kind: 'newProject' })}
    />

    <main class=${`bays ${compact ? 'compact' : ''} ${selection ? 'selecting' : ''}`}>
      ${state.devices.length
        ? state.devices.map(
            (d, i) => html`<${Bay}
              key=${d.id}
              state=${state}
              device=${d}
              letter=${String.fromCharCode(65 + i)}
              t=${t}
              compact=${compact}
              onStart=${() => start([d.id])}
              onStop=${() => stop([d.id])}
              onRemove=${() => setModal({ kind: 'removeDevice', device: d })}
              notify=${notify}
              run=${run}
              selection=${selection}
              onToggleSelected=${toggleSelected}
            />`,
          )
        : html`<${Setup} state=${state} onModal=${(kind) => setModal({ kind })} />`}
    </main>

    ${modal?.kind === 'pair' && html`<${PairModal} state=${state} onClose=${closeModal} />`}
    ${modal?.kind === 'settings' && html`<${SettingsModal} state=${state} onClose=${closeModal} notify=${notify} />`}
    ${modal?.kind === 'newProject' && html`<${NewProjectModal} state=${state} onClose=${closeModal} notify=${notify} />`}
    ${modal?.kind === 'endProject' &&
    state.project &&
    html`<${ConfirmModal}
      title="結束專案"
      confirmLabel="結束專案"
      onClose=${closeModal}
      onConfirm=${() => post('/api/projects/end')}
    >
      <p>結束「${state.project.name}」之後，清單會清空。之後可以從「專案」選單再打開它。</p>
      <p class="hint">影片都在 <code>${state.project.dir}</code></p>
      ${pending > 0 &&
      html`<p class="hint warn">還有 ${pending} 支影片沒傳完。結束後還是會繼續傳，傳完會存進這個專案的資料夾。</p>`}
    <//>`}
    ${modal?.kind === 'removeDevice' &&
    html`<${ConfirmModal}
      title="移除手機"
      confirmLabel="移除"
      danger
      onClose=${closeModal}
      onConfirm=${() => post(`/api/devices/${modal.device.id}/remove`)}
    >
      <p>要移除「${modal.device.name}」嗎？</p>
      <p class="hint">手機上的 App 會變成未配對，要再使用的話得重新掃 QR Code。已經傳到電腦的影片不受影響。</p>
      ${state.files.some((f) => f.deviceId === modal.device.id && (f.state === 'finishing' || isActive(f))) &&
      html`<p class="hint warn">這支手機還有影片沒傳完，移除後就傳不過來了，影片會留在手機上。</p>`}
    <//>`}
    ${modal?.kind === 'trash' &&
    html`<${TrashModal} state=${state} ids=${modal.ids} unmarked=${modal.unmarked} onClose=${closeModal} onConfirm=${() => trash(modal.ids)} />`}
    ${selection &&
    html`<${SelectionBar}
      state=${state}
      selection=${selection}
      setSelection=${setSelection}
      onTrash=${(ids) => setModal({ kind: 'trash', unmarked: false, ids })}
    />`}
    ${toast && html`<div class=${`toast ${toast.kind} ${selection ? 'raised' : ''}`} key=${toast.id} role="status">${toast.text}</div>`}
  `;
}

// 選取模式：點影片勾選，再一起移到垃圾桶
function SelectionBar({ state, selection, setSelection, onTrash }) {
  // 清單更新後，已經不在或不能刪的就不算
  const picked = state.files.filter((f) => selection.has(f.id) && canTrash(f));
  const unmarked = state.files.filter((f) => canTrash(f) && !f.marked);
  return html`<div class="selection-bar" role="toolbar" aria-label="選取要刪除的影片">
    <span class="selection-count">
      ${picked.length ? `已選 ${picked.length} 支・${fmtBytes(sumBytes(picked))}` : '點清單上的影片來選取要刪除的'}
    </span>
    <button class="btn-ghost btn-small" disabled=${!unmarked.length} onClick=${() => setSelection(new Set(unmarked.map((f) => f.id)))}>
      選取沒標記的
    </button>
    <button class="btn-ghost btn-small" onClick=${() => setSelection(null)}>取消</button>
    <button class="btn-danger btn-small" disabled=${!picked.length} onClick=${() => onTrash(picked.map((f) => f.id))}>
      移到${state.trashName}…
    </button>
  </div>`;
}

function TrashModal({ state, ids, unmarked, onClose, onConfirm }) {
  const files = state.files.filter((f) => ids.includes(f.id));
  const kept = countTakes(state.files.filter((f) => f.marked));
  const markedPicked = files.filter((f) => f.marked).length;
  const what = unmarked ? `沒標記的 ${countTakes(files)} 段（${files.length} 支影片）` : ` ${files.length} 支影片`;
  return html`<${ConfirmModal}
    title=${`移到${state.trashName}`}
    confirmLabel=${`移到${state.trashName}`}
    danger
    onClose=${onClose}
    onConfirm=${onConfirm}
  >
    <p>要把${what}移到${state.trashName}嗎？共 ${fmtBytes(sumBytes(files))}。</p>
    <ul class="trash-list">
      ${files.slice(0, 8).map((f) => html`<li>${f.name}</li>`)}
      ${files.length > 8 && html`<li class="more">還有 ${files.length - 8} 支</li>`}
    </ul>
    ${unmarked &&
    (kept
      ? html`<p class="hint">標記為好的 ${kept} 段會留下。</p>`
      : html`<p class="hint warn">這個專案還沒有標記任何一段，會把全部的影片都移到${state.trashName}。</p>`)}
    ${!unmarked && markedPicked > 0 && html`<p class="hint warn">其中 ${markedPicked} 支屬於標記為好的段落。</p>`}
    <p class="hint">之後還可以從${state.trashName}救回來。手機上的原檔不受影響。</p>
  <//>`;
}

function ProjectControl({ state, open, recording, onToggle, onNew, onEnd, onOpen, onShowFolder, onTrashUnmarked, onSelect }) {
  const p = state.project;
  const current = p && state.projects.find((x) => x.id === p.id);
  const others = state.projects.filter((x) => x.id !== p?.id);
  const markedTakes = countTakes(state.files.filter((f) => f.marked));
  const unmarkedTakes = countTakes(state.files.filter((f) => canTrash(f) && !f.marked));
  return html`<div class="readout menu-anchor">
    <span class="label">專案</span>
    <button class=${`picker ${p ? '' : 'unset'}`} aria-haspopup="menu" aria-expanded=${open} onClick=${onToggle}>
      <span class="picker-value">${p ? p.name : '尚未建立'}</span>
      <span class="caret" aria-hidden="true"></span>
    </button>
    <span class="readout-note">
      ${!current
        ? '錄影前請先新增專案'
        : current.files
          ? `${current.files} 支影片・${fmtBytes(current.bytes)}${markedTakes ? `・★ ${markedTakes} 段` : ''}`
          : '還沒有影片'}
    </span>
    ${open &&
    html`<div class="menu" role="menu">
      ${recording && html`<div class="menu-hint">錄影中不能切換專案</div>`}
      <button class="menu-item strong" role="menuitem" disabled=${recording} onClick=${onNew}>＋ 新增專案…</button>
      ${p && html`<button class="menu-item" role="menuitem" onClick=${onShowFolder}>打開專案資料夾</button>`}
      ${p &&
      html`<button class="menu-item" role="menuitem" disabled=${!unmarkedTakes} onClick=${onTrashUnmarked}>
        把沒標記的移到${state.trashName}…${unmarkedTakes ? `（${unmarkedTakes} 段）` : ''}
      </button>`}
      ${p &&
      html`<button class="menu-item" role="menuitem" disabled=${!state.files.some(canTrash)} onClick=${onSelect}>
        選取要刪除的影片…
      </button>`}
      ${p && html`<button class="menu-item" role="menuitem" disabled=${recording} onClick=${onEnd}>結束「${p.name}」</button>`}
      ${others.length > 0 && html`<div class="menu-title">之前的專案</div>`}
      ${others.map(
        (x) => html`<button class="menu-item project-item" role="menuitem" disabled=${recording} onClick=${() => onOpen(x.id)}>
          <span>${x.name}</span>
          <small>${fmtDate(x.createdAt)}・${x.files} 支・${fmtBytes(x.bytes)}</small>
        </button>`,
      )}
    </div>`}
  </div>`;
}

function SpecControl({ state, open, recording, onToggle, run }) {
  const r = resolutionOf(state);
  const g = state.settings.guide;
  const max = state.limits.maxDurationSec;
  return html`<div class="readout menu-anchor">
    <span class="label">錄影規格</span>
    <button class="picker" aria-haspopup="menu" aria-expanded=${open} onClick=${onToggle}>
      <span class="picker-value">${r.label}${g !== 'none' && html`<small>${g} 框</small>`}</span>
      <span class="caret" aria-hidden="true"></span>
    </button>
    <span class="readout-note">
      ${recording ? '錄影中只能改輔助框' : `下次開始時套用・${fmtDuration(max)}約 ${fmtBytes(bytesPerTake(state, r))}`}
    </span>
    ${open &&
    html`<div class="menu spec-menu" role="menu">
      <div class="menu-title">解析度${recording ? '（錄影中不能改）' : ''}</div>
      ${state.resolutions.map(
        (x) => html`<button
          class=${`menu-item res ${x.id === r.id ? 'on' : ''}`}
          role="menuitemradio"
          aria-checked=${x.id === r.id}
          disabled=${recording}
          onClick=${() => x.id !== r.id && run(() => post('/api/settings', { resolution: x.id }))}
        >
          <span class="res-label">${x.label}</span>
          <span class="res-dim">${x.width}×${x.height}</span>
          <span class="res-size">${fmtDuration(max)}約 ${fmtBytes(bytesPerTake(state, x))}</span>
        </button>`,
      )}
      <div class="menu-title">構圖輔助框</div>
      <div class="guide-row">
        ${state.guides.map(
          (x) => html`<button
            class=${`guide-chip ${x === g ? 'on' : ''}`}
            role="menuitemradio"
            aria-checked=${x === g}
            onClick=${() => x !== g && run(() => post('/api/settings', { guide: x }))}
          >
            ${GUIDE_LABEL[x]}
          </button>`,
        )}
      </div>
      <p class="menu-hint">照樣錄 16:9，裁切框只疊在手機預覽和這裡的播放器上，方便架機時就照最後要出的比例構圖。</p>
      <p class="menu-hint">手機不支援選的解析度時，會改錄它能錄的最大 16:9，影片清單上會標出來。</p>
    </div>`}
  </div>`;
}

function Alerts({ state, connected, t, onSettings, onNewProject }) {
  const items = [];
  const nameOf = (id) => state.devices.find((d) => d.id === id)?.name ?? '手機';
  if (!connected) items.push(['error', '和伺服器的連線中斷了，正在重新連線…']);

  const s = state.storage;
  if (!s.available) {
    items.push(['error', html`錄影資料夾不能用：${s.error}。<button class="btn-link" onClick=${onSettings}>打開設定</button>`]);
  } else {
    if (s.warning) items.push(['warn', s.warning]);
    // 以目前的解析度、所有配對的手機一起錄來估算，不夠錄兩次完整長度就提醒
    const r = resolutionOf(state);
    const phones = Math.max(1, state.devices.length);
    const minutes = Math.floor(s.freeBytes / ((r.bitrate / 8) * phones) / 60);
    const takeMinutes = state.limits.maxDurationSec / 60;
    if (minutes < takeMinutes * 2) {
      const short = minutes < takeMinutes;
      items.push([
        short ? 'error' : 'warn',
        html`電腦的錄影資料夾剩 ${fmtBytes(s.freeBytes)}，${phones} 台手機一起錄 ${r.label} 大約還能錄 ${minutes} 分鐘${short
          ? `，不夠錄完一次 ${fmtDuration(state.limits.maxDurationSec)}`
          : ''}。<button class="btn-link" onClick=${onSettings}>換一個資料夾</button>`,
      ]);
    }
  }

  // 還沒配對手機時，下方的「開始使用」已經有這一步
  if (!state.project && state.devices.length) {
    items.push([
      'info',
      html`還沒有專案。影片會存進 <code>${joinPath(state, state.settings.storageDir, '專案名稱')}</code>。<button class="btn-link" onClick=${onNewProject}>新增專案</button>`,
    ]);
  }

  for (const d of state.devices) {
    if (!d.online && state.files.some((f) => f.deviceId === d.id && isActive(f))) {
      items.push(['error', `${d.name} 離線了。手機應該還在錄影，連回來之後會自動補傳；如果手機沒電或 App 被關掉了，可以在它的監看區按「移除」。`]);
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

// 還沒配對手機時的「開始使用」：確認錄影資料夾 → 配對手機 → 新增專案
function Setup({ state, onModal }) {
  const s = state.storage;
  const p = state.project;
  const steps = [
    {
      title: '確認錄影資料夾',
      done: s.available,
      desc: s.available
        ? html`<code>${state.settings.storageDir}</code>・剩 ${fmtBytes(s.freeBytes)}`
        : html`<span class="bad">${s.error}</span>`,
      action: html`<button class="btn-ghost btn-small" onClick=${() => onModal('settings')}>變更…</button>`,
    },
    {
      title: '配對手機',
      done: false,
      desc: '手機和電腦連同一個 Wi-Fi，用手機相機掃 QR Code。還沒裝 App 的話，掃完打開的網頁裡有下載連結。',
      action: html`<button class="btn-primary" onClick=${() => onModal('pair')}>顯示配對 QR Code</button>`,
    },
    {
      title: '新增專案',
      done: !!p,
      desc: p ? `目前的專案是「${p.name}」` : '影片會存進錄影資料夾底下，以專案名稱命名的資料夾。',
      action: !p && html`<button class="btn-ghost btn-small" onClick=${() => onModal('newProject')}>新增專案…</button>`,
    },
  ];
  const next = steps.findIndex((x) => !x.done);
  return html`<section class="setup">
    <h2>開始使用</h2>
    <ol class="setup-steps">
      ${steps.map(
        (x, i) => html`<li class=${x.done ? 'done' : i === next ? 'next' : ''}>
          <span class="step-mark" aria-hidden="true">${x.done ? '✓' : i + 1}</span>
          <div>
            <div class="step-title">${x.title}</div>
            <div class="step-desc">${x.desc}</div>
          </div>
          <div>${x.action}</div>
        </li>`,
      )}
    </ol>
  </section>`;
}

function Bay({ state, device, letter, t, compact, onStart, onStop, onRemove, notify, run, selection, onToggleSelected }) {
  const files = state.files.filter((f) => f.deviceId === device.id).sort((a, b) => b.createdAt - a.createdAt);
  const active = files.find(isActive);
  const recording = active?.state === 'recording' && active.startedAt;
  const elapsed = recording ? t - active.startedAt : 0;
  const maxMs = (active?.spec.maxDurationSec ?? state.limits.maxDurationSec) * 1000;
  const warn = recording && maxMs - elapsed <= state.limits.warnBeforeSec * 1000;
  const st = device.status;
  const guide = state.settings.guide;

  // 監看區平常顯示即時畫面。錄完的影片傳完後會自動放上來播放（正在播別支時不打斷，手機多時不自動切換），
  // 按「即時畫面」回去；開始錄影時也會切回即時畫面。
  const [selectedId, setSelectedId] = useState(null); // null 表示看即時畫面
  const videoRef = useRef(null);
  const prevLatest = useRef(undefined); // 第一次載入時不切換，先看即時畫面
  const latestReady = files.find((f) => f.state === 'ready')?.id ?? null;
  const selected = files.find((f) => f.id === selectedId && f.state === 'ready');
  useEffect(() => {
    const idle = videoRef.current?.paused ?? true;
    const fresh = prevLatest.current !== undefined && latestReady && latestReady !== prevLatest.current;
    // 選的影片不在清單上了（例如換了專案）也算沒有選
    if (!compact && fresh && idle && (!selected || selectedId === prevLatest.current)) setSelectedId(latestReady);
    prevLatest.current = latestReady;
  }, [latestReady]);
  useEffect(() => {
    if (active && (videoRef.current?.paused ?? true)) setSelectedId(null);
  }, [active?.id]);

  const tally = recording ? 'on' : device.online && st.cameraReady !== false ? 'ready' : '';
  // 連得上但相機沒開：通常是 App 被切到背景，或還沒允許相機權限
  const conn = !device.online ? ['off', '離線'] : st.cameraReady === false ? ['warn', '相機未就緒'] : ['on', '已連線'];
  const bitrate = resolutionOf(state).bitrate;
  const minutesLeft = st.freeBytes != null ? Math.floor(st.freeBytes / (bitrate / 8) / 60) : null;

  return html`
    <section class=${`bay ${recording ? 'rec' : ''} ${device.online ? '' : 'offline'}`}>
      <div class="bay-head">
        <span class=${`tally ${tally}`} aria-hidden="true"></span>
        <span class="cam">CAM ${letter}</span>
        <${NameEditor} device=${device} notify=${notify} />
        <span class="model">${device.model}</span>
        ${st.audioInput &&
        html`<span class=${`mic ${st.audioInput.startsWith('外接') || st.audioInput.startsWith('耳機孔') ? 'ext' : ''}`} title="這台目前用哪支麥克風收音">${st.audioInput}</span>`}
        <span class=${`conn ${conn[0]}`} title=${conn[0] === 'warn' ? '請把手機上的 App 開在前景，並允許相機和麥克風權限' : undefined}>
          ${conn[1]}
        </span>
      </div>

      <div class="bay-timecode">
        <div class=${`tc ${recording ? 'live' : ''} ${warn ? 'warn' : ''}`} aria-live="off">
          ${active?.state === 'starting' ? '準備中' : fmtClock(elapsed)}
          <small>/ ${fmtClock(maxMs)}</small>
        </div>
        <div class="bay-actions">
          ${active
            ? html`<button class="btn-ghost btn-small" disabled=${!device.online} onClick=${onStop}>單獨停止</button>
                ${!device.online && html`<button class="btn-ghost btn-small" title="移除這支手機的配對" onClick=${onRemove}>移除</button>`}`
            : html`<button class="btn-ghost btn-small" disabled=${!device.online || st.cameraReady === false} onClick=${onStart}>
                  單獨開始
                </button>
                <button class="btn-ghost btn-small" title="移除這支手機的配對" onClick=${onRemove}>移除</button>`}
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
          ? html`<video
              ref=${videoRef}
              key=${selected.id}
              data-file-id=${selected.id}
              src=${`/media/${selected.id}`}
              controls
              preload="metadata"
              playsinline
            ></video>`
          : html`<${LiveView} device=${device} />`}
        ${guide !== 'none' &&
        html`<div class="guide" style=${{ width: `${(GUIDE_RATIO[guide] / (16 / 9)) * 100}%` }}><span>${guide}</span></div>`}
      </div>
      <div class="monitor-caption">
        ${selected
          ? html`<span>${selected.name}</span>
              <button class="btn-link" onClick=${() => run(() => post('/api/open-folder', { fileId: selected.id }))}>
                ${revealLabel(state)}
              </button>
              <button class="btn-link" onClick=${() => setSelectedId(null)}>回到即時畫面</button>`
          : html`<span>即時畫面</span>`}
      </div>
      <${ZoomControl} device=${device} run=${run} />

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
                  selecting=${!!selection}
                  picked=${!!selection?.has(f.id)}
                  onPick=${() => onToggleSelected(f.id)}
                  run=${run}
                />`,
            )
          : html`<li class="clips-empty">${state.project ? '這個專案還沒有錄影' : '新增專案後就可以開始錄影'}</li>`}
      </ul>
    </section>
  `;
}

// 即時畫面：<img> 由 onPreviewFrame 直接換圖。3 秒沒有新畫面就顯示原因。
function LiveView({ device }) {
  const imgRef = useRef(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    const view = { img: imgRef.current, url: null, at: 0, onFrame: () => setFresh(true) };
    liveViews.set(device.id, view);
    sendWatchList();
    const timer = setInterval(() => setFresh(Date.now() - view.at < 3000), 1000);
    return () => {
      clearInterval(timer);
      if (liveViews.get(device.id) === view) liveViews.delete(device.id);
      if (view.url) URL.revokeObjectURL(view.url);
      sendWatchList();
    };
  }, [device.id]);
  let reason = '等待即時畫面…';
  if (!device.online) reason = '手機離線';
  else if (!device.features.includes('preview')) reason = '這支手機的 App 版本太舊，更新後就能看即時畫面';
  else if (device.status.cameraReady === false) reason = '相機未就緒：請把手機上的 App 開在前景';
  return html`<img ref=${imgRef} class="live" alt=${`${device.name} 的即時畫面`} />
    ${fresh ? html`<span class="live-badge">即時</span>` : html`<div class="monitor-empty">${reason}</div>`}`;
}

const roundZoom = (z) => Math.round(z * 10) / 10;
const fmtZoom = (z) => `${Number.isInteger(z) ? z : z.toFixed(1)}×`;

// 變焦：常用倍率的按鈕加上滑桿（對數刻度，放大一倍的距離都一樣）。範圍由手機回報，有廣角鏡頭的手機可以小於 1×。
function ZoomControl({ device, run }) {
  const [dragging, setDragging] = useState(null); // 拖曳中的倍率
  const lastSent = useRef(0);
  const range = device.features.includes('zoom') ? device.status.zoomRange : null;
  if (!range || !(range[1] > range[0])) return null;
  const [min, max] = range;
  const presets = [...new Set([min < 1 ? roundZoom(min) : null, 1, 2, 3, 5, 10])].filter((z) => z && z >= min && z <= max);
  const toPos = (z) => Math.round((Math.log(z / min) / Math.log(max / min)) * 1000);
  const fromPos = (pos) => Math.min(max, Math.max(min, roundZoom(min * Math.pow(max / min, pos / 1000))));
  const send = (z) => run(() => post(`/api/devices/${device.id}/zoom`, { ratio: z }));
  const current = device.zoom ?? 1;
  const shown = dragging ?? current;
  return html`<div class="zoom">
    <span class="label">變焦</span>
    <div class="zoom-presets">
      ${presets.map(
        (z) => html`<button class=${`zoom-chip ${Math.abs(z - current) < 0.05 ? 'on' : ''}`} disabled=${!device.online} onClick=${() => send(z)}>
          ${fmtZoom(z)}
        </button>`,
      )}
    </div>
    <input
      type="range"
      min="0"
      max="1000"
      value=${toPos(shown)}
      disabled=${!device.online}
      aria-label=${`${device.name} 的變焦倍率`}
      onInput=${(e) => {
        const z = fromPos(Number(e.target.value));
        setDragging(z);
        // 拖曳中也送，配合即時畫面邊看邊調；太密的就略過
        if (Date.now() - lastSent.current > 150) {
          lastSent.current = Date.now();
          send(z);
        }
      }}
      onChange=${(e) => {
        setDragging(null);
        send(fromPos(Number(e.target.value)));
      }}
    />
    <span class="zoom-value">${fmtZoom(shown)}</span>
  </div>`;
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

function Clip({ f, state, selected, onPlay, selecting, picked, onPick, run }) {
  const progress = f.size ? Math.min(1, f.receivedBytes / f.size) : null;
  const { rate, idleMs } = useTransferRate(f.receivedBytes);
  const sending = f.state === 'recording' || (f.state === 'finishing' && progress < 1);
  const stalled = sending && idleMs > 8000;
  const speed = sending && !stalled && rate ? `・${fmtRate(rate)}` : '';
  // 手機不支援要求的解析度時會降級，這裡標出實際錄的大小
  const wanted = state.resolutions.find((r) => r.id === f.spec.resolution);
  const actual = f.videoWidth ? sizeLabel(state, f.videoWidth, f.videoHeight) : null;
  const downgraded = wanted && f.videoWidth && (f.videoWidth !== wanted.width || f.videoHeight !== wanted.height);
  let detail;
  if (f.state === 'starting') detail = '等待手機開始';
  else if (f.state === 'recording') detail = `邊錄邊傳，已傳 ${fmtBytes(f.receivedBytes)}${speed}`;
  else if (f.state === 'finishing') detail = progress >= 1 ? '驗證檔案中' : `收尾傳輸 ${Math.floor((progress ?? 0) * 100)}%${speed}`;
  else if (f.state === 'ready') {
    detail = `${fmtClock(f.durationMs ?? 0)}・${fmtBytes(f.size)}${actual ? `・${actual}` : ''}${STOP_NOTE[f.stopReason] ?? ''}`;
  } else detail = f.error || '錄影失敗';

  // 同一次錄影的另一台，顯示開始時間差多少
  const peer = state.files.find((g) => g.takeId === f.takeId && g.deviceId !== f.deviceId && g.startedAt);
  let sync = null;
  if (peer && f.startedAt) {
    const diff = f.startedAt - peer.startedAt;
    const ms = Math.round(Math.abs(diff));
    const peerName = state.devices.find((d) => d.id === peer.deviceId)?.name ?? '另一台';
    sync = ms === 0 ? `和 ${peerName} 同時開始` : `比 ${peerName} ${diff > 0 ? '晚' : '早'} ${ms} ms`;
  }

  // 選取模式：整列都可以點；錄影中、傳輸中的不能選
  const pickable = selecting && canTrash(f);
  const pick = (e) => {
    e.stopPropagation();
    onPick();
  };
  return html`<li class=${`clip ${selected ? 'selected' : ''} ${pickable ? 'pickable' : ''} ${picked ? 'picked' : ''}`} onClick=${pickable ? onPick : undefined}>
    ${selecting
      ? html`<button class="clip-check" role="checkbox" aria-checked=${picked} disabled=${!pickable} onClick=${pick} aria-label=${`選取 ${f.name}`}></button>`
      : html`<button class="clip-play" disabled=${f.state !== 'ready'} onClick=${onPlay} aria-label=${`播放 ${f.name}`}></button>`}
    <div>
      <div class="clip-name" title=${joinPath(state, f.dir, f.name)}>${f.name}</div>
      <div class="clip-meta">
        <span class=${`chip ${f.state}`}>${STATE_LABEL[f.state]}</span>
        <span>${detail}</span>
        ${stalled && html`<span class="clip-warn">傳輸停住了，請檢查這支手機的 Wi-Fi 訊號</span>`}
        ${downgraded && html`<span class="clip-warn">要求 ${wanted.label}，這台只能錄 ${f.videoWidth}×${f.videoHeight}</span>`}
        ${sync && html`<span class="clip-sync">${sync}</span>`}
      </div>
    </div>
    ${f.state !== 'failed' &&
    html`<button
      class=${`clip-mark ${f.marked ? 'on' : ''}`}
      aria-pressed=${!!f.marked}
      title=${f.marked ? '取消標記這一段' : '標記這一段是好的（同一段的每台手機一起標記）'}
      onClick=${(e) => {
        e.stopPropagation();
        run(() => post(`/api/takes/${f.takeId}/mark`, { marked: !f.marked }));
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.5 1.2 6.4L12 17.3l-5.7 3.1 1.2-6.4-4.7-4.5 6.4-.8z" /></svg>
    </button>`}
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

// ---------- 對話框 ----------

function Modal({ title, onClose, children }) {
  return html`<div class="modal-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="modal-head">
        <h2>${title}</h2>
        <button class="btn-ghost btn-small" onClick=${onClose}>關閉</button>
      </div>
      <div class="modal-body">${children}</div>
    </div>
  </div>`;
}

function ConfirmModal({ title, confirmLabel, danger, onConfirm, onClose, children }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return html`<${Modal} title=${title} onClose=${onClose}>
    ${children}
    ${error && html`<p class="hint bad" role="alert">${error}</p>`}
    <div class="modal-foot">
      <button class="btn-ghost" onClick=${onClose}>取消</button>
      <button class=${danger ? 'btn-danger' : 'btn-primary'} disabled=${busy} onClick=${confirm}>${confirmLabel}</button>
    </div>
  <//>`;
}

function NewProjectModal({ state, onClose, notify }) {
  const [name, setName] = useState(() => newProjectName(state));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => inputRef.current?.select(), []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await post('/api/projects', { name });
      notify(`已建立專案「${p.name}」${state.devices.some((d) => d.online) ? '，按 R 就能開始錄影' : ''}`);
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return html`<${Modal} title="新增專案" onClose=${onClose}>
    <div class="field">
      <label class="label" for="project-name">專案名稱</label>
      <input
        id="project-name"
        ref=${inputRef}
        value=${name}
        maxlength="60"
        spellcheck="false"
        onInput=${(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown=${(e) => e.key === 'Enter' && name.trim() && create()}
      />
    </div>
    ${error && html`<p class="hint bad" role="alert">${error}</p>`}
    <p class="hint">影片會存進 <code>${joinPath(state, state.settings.storageDir, name.trim() || '專案名稱')}</code></p>
    ${state.project && html`<p class="hint">目前的專案「${state.project.name}」會自動結束，之後還可以從選單打開。</p>`}
    <div class="modal-foot">
      <button class="btn-ghost" onClick=${onClose}>取消</button>
      <button class="btn-primary" disabled=${busy || !name.trim()} onClick=${create}>建立專案</button>
    </div>
  <//>`;
}

function PairModal({ state, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const now = useNow(1000);
  const load = (renew = false) => {
    setError(null);
    post('/api/pairing', { renew }).then(setData, (e) => setError(e.message));
  };
  useEffect(() => load(), []);
  const left = data ? data.expiresAt - now : 0;
  const { devices } = state;
  const max = state.limits.maxDevices;

  return html`<${Modal} title="配對手機" onClose=${onClose}>
    <div class="pair">
      <div class="qr-frame">
        ${data && left > 0
          ? html`<img src=${data.qr} alt="配對用 QR Code" />`
          : html`<div class="qr-loading">${error || (data ? 'QR Code 已失效' : '產生中…')}</div>`}
      </div>
      <div>
        <ol class="steps">
          <li>手機和電腦連同一個 Wi-Fi（不要用訪客網路）</li>
          <li>用手機相機掃這個 QR Code，點開出現的連結</li>
          <li>在打開的網頁按「打開 App 並配對」。還沒裝 App 的話，網頁上有下載連結</li>
          <li>連上之後，下面會出現手機名稱</li>
        </ol>
        <p class="hint">已經裝好 App 的話，也可以在 App 裡點「掃描 QR Code」直接掃。</p>
        ${data &&
        html`<div class="pair-meta">
          手機會連到 <code>${data.payload.url}</code><br />
          ${left > 0 ? `${fmtClock(left)} 後失效` : '已失效'}・<button class="btn-link" onClick=${() => load(true)}>重新產生</button>
        </div>`}
        <div class="pair-meta">已配對 ${devices.length} / ${max} 支</div>
        ${devices.length >= max && html`<p class="hint warn">已經到上限，要加新手機請先在監看區按「移除」拿掉一支。</p>`}
        <div class="paired">
          ${devices.map((d) => html`<span class=${`paired-chip ${d.online ? 'on' : ''}`}>${d.name}</span>`)}
        </div>
      </div>
    </div>
  <//>`;
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

  // 跳出系統的選擇資料夾視窗（瀏覽器本身拿不到資料夾的完整路徑）
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

  return html`<${Modal} title="設定" onClose=${onClose}>
    <div class="field">
      <label class="label" for="storage-dir">錄影資料夾（這台電腦）</label>
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
    <p class="hint">新增專案時，會在這個資料夾底下建立同名的子資料夾。建議選外接 SSD 上的資料夾，硬碟格式要是 ${state.diskFormats}。</p>
    ${s.available
      ? html`<p class=${`hint ${s.warning ? 'warn' : ''}`}>
          目前資料夾剩 ${fmtBytes(s.freeBytes)}${s.format ? `・${s.format}` : ''}${s.warning ? `。${s.warning}` : ''}
        </p>`
      : html`<p class="hint bad">目前資料夾不能用：${s.error}</p>`}
    <div class="modal-foot">
      <button class="btn-ghost" onClick=${onClose}>取消</button>
      <button class="btn-primary" disabled=${busy} onClick=${save}>儲存</button>
    </div>
  <//>`;
}

render(html`<${App} />`, document.getElementById('app'));
