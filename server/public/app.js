import { html, render, useEffect, useRef, useState } from '/vendor/preact-htm.js';
import { getLang, listJoin, resolveLang, setLang, tr } from '/i18n.js';

// 介面文字都在 i18n.js；這裡的 tr(key) 依目前的語言取字
const stateLabel = (s) => tr(`state.${s}`);
const stopNote = (reason) => (reason === 'maxDuration' || reason === 'error' ? tr(`stop.${reason}`) : '');
const guideLabel = (g) => tr(`guide.${g}`);
const GUIDE_RATIO = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1 };
const orientationLabel = (o) => tr(`orientation.${o}`);

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
const fmtDuration = (sec) => (sec % 60 === 0 ? tr('unit.min', { n: sec / 60 }) : tr('unit.sec', { n: sec }));

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
const revealLabel = (state) => tr(state.platform === 'darwin' || state.platform === 'win32' ? `reveal.${state.platform}` : 'reveal.other');

// 收音來源：新版 App 回報種類和麥克風名稱，由這裡依語言顯示；舊版 App 直接送中文說明
function micLabel(st) {
  const source = st.audioSource;
  if (source === 'builtin') return tr('mic.builtin');
  if (source === 'usb' || source === 'wired' || source === 'other') return tr(`mic.${source}`, { name: st.audioName || '?' });
  return st.audioInput;
}
const externalMic = (st) =>
  st.audioSource ? st.audioSource === 'usb' || st.audioSource === 'wired' : /^(外接|耳機孔)/.test(st.audioInput ?? '');

// X-Lang：伺服器的錯誤訊息用和控制台一樣的語言
async function post(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lang': getLang() },
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
// 構圖輔助框的大小：比畫面窄的框貼齊上下、比畫面寬的貼齊左右，和畫面同比例就不用畫
function guideStyle(guide, frameRatio) {
  const r = GUIDE_RATIO[guide];
  if (!r || Math.abs(r - frameRatio) < 0.01) return null;
  return r < frameRatio ? { width: `${(r / frameRatio) * 100}%` } : { height: `${(frameRatio / r) * 100}%` };
}
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

// 換語言：伺服器會用新的語言重送一次狀態（錯誤訊息、硬碟格式這些伺服器給的文字）
function switchLang(lang) {
  setLang(lang);
  if (uiSocket?.readyState === WebSocket.OPEN) uiSocket.send(JSON.stringify({ type: 'lang', lang }));
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
      ws = new WebSocket(`ws://${location.host}/ws/ui?lang=${getLang()}`);
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
      if (r?.skipped?.length) notify(listJoin(r.skipped), 'warn');
    } catch (e) {
      notify(e.message, 'error');
    }
  };
  // 還沒有專案就先請使用者新增
  const start = async (deviceIds) => {
    try {
      const r = await post('/api/record/start', { deviceIds });
      if (r.skipped?.length) notify(listJoin(r.skipped), 'warn');
    } catch (e) {
      if (!e.data?.needProject) return notify(e.message, 'error');
      setModal({ kind: 'newProject' });
      notify(tr('toast.needProject'), 'warn');
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
    notify(tr('toast.trashed', { n: r.trashed, trash: state.trashName }));
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

  if (!state) return html`<div class="boot">${tr('boot')}</div>`;

  // 語言照設定，自動時跟著瀏覽器
  const lang = resolveLang(state.settings.language);
  if (lang !== getLang()) switchLang(lang);

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
          <div class="brand-name">${tr('brand.name')}</div>
          <div class="brand-sub">${tr('brand.sub')}</div>
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
          <span class="label">${tr('top.phones')}</span>
          <span class="readout-value">${online.length}<small>/ ${state.devices.length}${tr('top.phonesUnit')}</small></span>
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
          <span class="dot"></span>${tr('top.record')}<kbd>R</kbd>
        </button>
        <button class="btn-stop" disabled=${!recording} onClick=${() => stop()}>
          <span class="square"></span>${tr('top.stop')}<kbd>S</kbd>
        </button>
      </div>
      <div class="tools">
        <button class="btn-ghost" onClick=${() => setModal({ kind: 'pair' })}>${tr('top.pair')}</button>
        <button class="btn-ghost" onClick=${() => setModal({ kind: 'settings' })}>${tr('top.settings')}</button>
        <button
          class="btn-ghost btn-lang"
          lang=${lang === 'en' ? 'zh-Hant-TW' : 'en'}
          title=${tr('top.switchLangTitle')}
          onClick=${() => run(() => post('/api/settings', { language: lang === 'en' ? 'zh-TW' : 'en' }))}
        >
          ${tr('top.switchLang')}
        </button>
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
              onTrashTake=${(takeId) =>
                setModal({ kind: 'trash', take: true, ids: state.files.filter((f) => f.takeId === takeId && canTrash(f)).map((f) => f.id) })}
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
      title=${tr('endProject.title')}
      confirmLabel=${tr('endProject.title')}
      onClose=${closeModal}
      onConfirm=${() => post('/api/projects/end')}
    >
      <p>${tr('endProject.body', { name: state.project.name })}</p>
      <p class="hint">${tr('endProject.dir', { dir: state.project.dir })}</p>
      ${pending > 0 && html`<p class="hint warn">${tr('endProject.pending', { n: pending })}</p>`}
    <//>`}
    ${modal?.kind === 'removeDevice' &&
    html`<${ConfirmModal}
      title=${tr('removeDevice.title')}
      confirmLabel=${tr('removeDevice.confirm')}
      danger
      onClose=${closeModal}
      onConfirm=${() => post(`/api/devices/${modal.device.id}/remove`)}
    >
      <p>${tr('removeDevice.body', { name: modal.device.name })}</p>
      <p class="hint">${tr('removeDevice.hint')}</p>
      ${state.files.some((f) => f.deviceId === modal.device.id && (f.state === 'finishing' || isActive(f))) &&
      html`<p class="hint warn">${tr('removeDevice.pending')}</p>`}
    <//>`}
    ${modal?.kind === 'trash' &&
    html`<${TrashModal}
      state=${state}
      ids=${modal.ids}
      unmarked=${modal.unmarked}
      take=${modal.take}
      onClose=${closeModal}
      onConfirm=${() => trash(modal.ids)}
    />`}
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
  return html`<div class="selection-bar" role="toolbar" aria-label=${tr('selection.aria')}>
    <span class="selection-count">
      ${picked.length ? tr('selection.count', { n: picked.length, size: fmtBytes(sumBytes(picked)) }) : tr('selection.prompt')}
    </span>
    <button class="btn-ghost btn-small" disabled=${!unmarked.length} onClick=${() => setSelection(new Set(unmarked.map((f) => f.id)))}>
      ${tr('selection.unmarked')}
    </button>
    <button class="btn-ghost btn-small" onClick=${() => setSelection(null)}>${tr('common.cancel')}</button>
    <button class="btn-danger btn-small" disabled=${!picked.length} onClick=${() => onTrash(picked.map((f) => f.id))}>
      ${tr('selection.move', { trash: state.trashName })}
    </button>
  </div>`;
}

// unmarked：清掉沒標記的；take：清單上的垃圾桶按鈕，同一段的每台手機一起刪
function TrashModal({ state, ids, unmarked, take, onClose, onConfirm }) {
  const files = state.files.filter((f) => ids.includes(f.id));
  const kept = countTakes(state.files.filter((f) => f.marked));
  const markedPicked = files.filter((f) => f.marked).length;
  const trash = state.trashName;
  let what = tr('trash.whatClips', { n: files.length });
  if (unmarked) what = tr('trash.whatUnmarked', { takes: countTakes(files), n: files.length });
  else if (take) what = files.length > 1 ? tr('trash.whatTake', { n: files.length }) : tr('trash.whatOne');
  return html`<${ConfirmModal}
    title=${tr('trash.title', { trash })}
    confirmLabel=${tr('trash.title', { trash })}
    danger
    onClose=${onClose}
    onConfirm=${onConfirm}
  >
    <p>${tr('trash.question', { what, trash, size: fmtBytes(sumBytes(files)) })}</p>
    <ul class="trash-list">
      ${files.slice(0, 8).map((f) => html`<li>${f.name}</li>`)}
      ${files.length > 8 && html`<li class="more">${tr('trash.more', { n: files.length - 8 })}</li>`}
    </ul>
    ${unmarked &&
    (kept
      ? html`<p class="hint">${tr('trash.kept', { n: kept })}</p>`
      : html`<p class="hint warn">${tr('trash.allUnmarked', { trash })}</p>`)}
    ${!unmarked &&
    markedPicked > 0 &&
    html`<p class="hint warn">${take ? tr('trash.takeStarred') : tr('trash.someStarred', { n: markedPicked })}</p>`}
    ${take && files.length > 1 && html`<p class="hint">${tr('trash.onlyOne')}</p>`}
    <p class="hint">${tr('trash.recover', { trash })}</p>
  <//>`;
}

function ProjectControl({ state, open, recording, onToggle, onNew, onEnd, onOpen, onShowFolder, onTrashUnmarked, onSelect }) {
  const p = state.project;
  const current = p && state.projects.find((x) => x.id === p.id);
  const others = state.projects.filter((x) => x.id !== p?.id);
  const markedTakes = countTakes(state.files.filter((f) => f.marked));
  const unmarkedTakes = countTakes(state.files.filter((f) => canTrash(f) && !f.marked));
  return html`<div class="readout menu-anchor">
    <span class="label">${tr('project.label')}</span>
    <button class=${`picker ${p ? '' : 'unset'}`} aria-haspopup="menu" aria-expanded=${open} onClick=${onToggle}>
      <span class="picker-value">${p ? p.name : tr('project.none')}</span>
      <span class="caret" aria-hidden="true"></span>
    </button>
    <span class="readout-note">
      ${!current
        ? tr('project.needOne')
        : current.files
          ? tr('project.stats', { n: current.files, size: fmtBytes(current.bytes) }) + (markedTakes ? tr('project.starred', { n: markedTakes }) : '')
          : tr('project.empty')}
    </span>
    ${open &&
    html`<div class="menu" role="menu">
      ${recording && html`<div class="menu-hint">${tr('project.lockedWhileRecording')}</div>`}
      <button class="menu-item strong" role="menuitem" disabled=${recording} onClick=${onNew}>${tr('project.new')}</button>
      ${p && html`<button class="menu-item" role="menuitem" onClick=${onShowFolder}>${tr('project.openFolder')}</button>`}
      ${p &&
      html`<button class="menu-item" role="menuitem" disabled=${!unmarkedTakes} onClick=${onTrashUnmarked}>
        ${tr('project.trashUnmarked', { trash: state.trashName, n: unmarkedTakes })}
      </button>`}
      ${p &&
      html`<button class="menu-item" role="menuitem" disabled=${!state.files.some(canTrash)} onClick=${onSelect}>
        ${tr('project.select')}
      </button>`}
      ${p && html`<button class="menu-item" role="menuitem" disabled=${recording} onClick=${onEnd}>${tr('project.end', { name: p.name })}</button>`}
      ${others.length > 0 && html`<div class="menu-title">${tr('project.previous')}</div>`}
      ${others.map(
        (x) => html`<button class="menu-item project-item" role="menuitem" disabled=${recording} onClick=${() => onOpen(x.id)}>
          <span>${x.name}</span>
          <small>${tr('project.itemMeta', { date: fmtDate(x.createdAt), n: x.files, size: fmtBytes(x.bytes) })}</small>
        </button>`,
      )}
    </div>`}
  </div>`;
}

const PORTRAIT_OPTIONS = ['facePriority', 'lockExposure'];

// 開著的人像設定有哪幾台做不到。手機會略過做不到的項目，照常錄影。
function portraitNotes(state) {
  const s = state.settings;
  const notes = [];
  for (const d of state.devices.filter((x) => x.online)) {
    const c = d.camera;
    if (!c) {
      notes.push(tr('portrait.oldApp', { name: d.name }));
      continue;
    }
    if (s.facePriority && !c.facePriority) notes.push(tr('portrait.noFace', { name: d.name }));
    if (s.lockExposure && !c.lockExposure) notes.push(tr('portrait.noLock', { name: d.name }));
  }
  return notes;
}

function SpecControl({ state, open, recording, onToggle, run }) {
  const r = resolutionOf(state);
  const s = state.settings;
  const g = s.guide;
  const max = state.limits.maxDurationSec;
  return html`<div class="readout menu-anchor">
    <span class="label">${tr('spec.label')}</span>
    <button class="picker" aria-haspopup="menu" aria-expanded=${open} onClick=${onToggle}>
      <span class="picker-value">${r.label}${g !== 'none' && html`<small>${tr('spec.guideTag', { guide: g })}</small>`}${s.lockExposure && html`<small>${tr('spec.lockTag')}</small>`}</span>
      <span class="caret" aria-hidden="true"></span>
    </button>
    <span class="readout-note">
      ${recording ? tr('spec.noteRecording') : tr('spec.noteNext', { dur: fmtDuration(max), size: fmtBytes(bytesPerTake(state, r)) })}
    </span>
    ${open &&
    html`<div class="menu spec-menu" role="menu">
      <div class="menu-title">${tr('spec.resolution')}${recording ? tr('spec.locked') : ''}</div>
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
          <span class="res-size">${tr('spec.perTake', { dur: fmtDuration(max), size: fmtBytes(bytesPerTake(state, x)) })}</span>
        </button>`,
      )}
      <div class="menu-title">${tr('spec.guide')}</div>
      <div class="guide-row">
        ${state.guides.map(
          (x) => html`<button
            class=${`guide-chip ${x === g ? 'on' : ''}`}
            role="menuitemradio"
            aria-checked=${x === g}
            onClick=${() => x !== g && run(() => post('/api/settings', { guide: x }))}
          >
            ${guideLabel(x)}
          </button>`,
        )}
      </div>
      <p class="menu-hint">${tr('spec.hintOrientation')}</p>
      <p class="menu-hint">${tr('spec.hintDowngrade')}</p>
      <div class="menu-title">${tr('spec.portrait')}${recording ? tr('spec.locked') : ''}</div>
      ${PORTRAIT_OPTIONS.map(
        (key) => html`<button
          class=${`menu-item toggle ${s[key] ? 'on' : ''}`}
          role="menuitemcheckbox"
          aria-checked=${s[key]}
          disabled=${recording}
          onClick=${() => run(() => post('/api/settings', { [key]: !s[key] }))}
        >
          <span>${tr(`portrait.${key}`)}</span>
          <small class="toggle-note">${tr(`portrait.${key}Note`)}</small>
        </button>`,
      )}
      ${portraitNotes(state).map((n) => html`<p class="menu-hint warn">${n}</p>`)}
    </div>`}
  </div>`;
}

function Alerts({ state, connected, t, onSettings, onNewProject }) {
  const items = [];
  const nameOf = (id) => state.devices.find((d) => d.id === id)?.name ?? tr('alerts.phone');
  if (!connected) items.push(['error', tr('alerts.disconnected')]);

  const s = state.storage;
  if (!s.available) {
    const action = html`<button class="btn-link" onClick=${onSettings}>${tr('alerts.openSettings')}</button>`;
    items.push(['error', tr('alerts.storageBad', { error: s.error, action })]);
  } else {
    if (s.warning) items.push(['warn', s.warning]);
    // 以目前的解析度、所有配對的手機一起錄來估算，不夠錄兩次完整長度就提醒
    const r = resolutionOf(state);
    const phones = Math.max(1, state.devices.length);
    const minutes = Math.floor(s.freeBytes / ((r.bitrate / 8) * phones) / 60);
    const takeMinutes = state.limits.maxDurationSec / 60;
    if (minutes < takeMinutes * 2) {
      const short = minutes < takeMinutes;
      const action = html`<button class="btn-link" onClick=${onSettings}>${tr('alerts.changeFolder')}</button>`;
      items.push([
        short ? 'error' : 'warn',
        tr('alerts.lowSpace', {
          free: fmtBytes(s.freeBytes),
          phones,
          res: r.label,
          minutes,
          short,
          max: fmtDuration(state.limits.maxDurationSec),
          action,
        }),
      ]);
    }
  }

  // 還沒配對手機時，下方的「開始使用」已經有這一步
  if (!state.project && state.devices.length) {
    const action = html`<button class="btn-link" onClick=${onNewProject}>${tr('alerts.newProject')}</button>`;
    items.push(['info', tr('alerts.noProject', { path: joinPath(state, state.settings.storageDir, tr('alerts.projectName')), action })]);
  }

  for (const d of state.devices) {
    if (!d.online && state.files.some((f) => f.deviceId === d.id && isActive(f))) {
      items.push(['error', tr('alerts.offlineRecording', { name: d.name })]);
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
      tr('alerts.countdown', { left: fmtClock(take.left), max: fmtDuration(state.limits.maxDurationSec), names: listJoin(take.names) }),
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
      title: tr('setup.folder'),
      done: s.available,
      desc: s.available
        ? tr('setup.folderInfo', { dir: state.settings.storageDir, free: fmtBytes(s.freeBytes) })
        : html`<span class="bad">${s.error}</span>`,
      action: html`<button class="btn-ghost btn-small" onClick=${() => onModal('settings')}>${tr('setup.change')}</button>`,
    },
    {
      title: tr('setup.pair'),
      done: false,
      desc: tr('setup.pairDesc'),
      action: html`<button class="btn-primary" onClick=${() => onModal('pair')}>${tr('setup.showQr')}</button>`,
    },
    {
      title: tr('setup.project'),
      done: !!p,
      desc: p ? tr('setup.projectCurrent', { name: p.name }) : tr('setup.projectDesc'),
      action: !p && html`<button class="btn-ghost btn-small" onClick=${() => onModal('newProject')}>${tr('setup.newProject')}</button>`,
    },
  ];
  const next = steps.findIndex((x) => !x.done);
  return html`<section class="setup">
    <h2>${tr('setup.title')}</h2>
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

function Bay({ state, device, letter, t, compact, onStart, onStop, onRemove, notify, run, selection, onToggleSelected, onTrashTake }) {
  const files = state.files.filter((f) => f.deviceId === device.id).sort((a, b) => b.createdAt - a.createdAt);
  const active = files.find(isActive);
  const recording = active?.state === 'recording' && active.startedAt;
  const elapsed = recording ? t - active.startedAt : 0;
  const maxMs = (active?.spec.maxDurationSec ?? state.limits.maxDurationSec) * 1000;
  const warn = recording && maxMs - elapsed <= state.limits.warnBeforeSec * 1000;
  const st = device.status;

  // 監看區平常顯示即時畫面。錄完的影片傳完後會自動放上來播放（錄影中、正在播別支時不打斷，手機多時不自動切換），
  // 按「回到即時畫面」回去。按下開始錄影就一律切回即時畫面，正在播的影片也會停掉，才看得到現在拍到什麼。
  const [selectedId, setSelectedId] = useState(null); // null 表示看即時畫面
  const videoRef = useRef(null);
  const prevLatest = useRef(undefined); // 第一次載入時不切換，先看即時畫面
  const latestReady = files.find((f) => f.state === 'ready' && !f.trimmedFrom)?.id ?? null; // 裁剪出來的不算，不會自動切過去
  const selected = files.find((f) => f.id === selectedId && f.state === 'ready');
  // 監看區的方向：播影片時照那支影片，看即時畫面時照手機現在怎麼拿（舊版 App 沒有回報，當成橫的）
  const portrait = (selected ? selected.orientation : device.status.orientation) === 'portrait';
  const guideBox = guideStyle(state.settings.guide, portrait ? 9 / 16 : 16 / 9);
  useEffect(() => {
    const idle = videoRef.current?.paused ?? true;
    const fresh = prevLatest.current !== undefined && latestReady && latestReady !== prevLatest.current;
    // 選的影片不在清單上了（例如換了專案）也算沒有選
    if (!compact && !active && fresh && idle && (!selected || selectedId === prevLatest.current)) setSelectedId(latestReady);
    prevLatest.current = latestReady;
  }, [latestReady]);
  useEffect(() => {
    if (active) setSelectedId(null);
  }, [active?.id]);
  const [trimming, setTrimming] = useState(false);
  useEffect(() => setTrimming(false), [selected?.id]);

  const tally = recording ? 'on' : device.online && st.cameraReady !== false ? 'ready' : '';
  // 連得上但相機沒開：通常是 App 被切到背景，或還沒允許相機權限
  const conn = !device.online
    ? ['off', tr('bay.offline')]
    : st.cameraReady === false
      ? ['warn', tr('bay.cameraNotReady')]
      : ['on', tr('bay.connected')];
  const mic = micLabel(st);
  const bitrate = resolutionOf(state).bitrate;
  const minutesLeft = st.freeBytes != null ? Math.floor(st.freeBytes / (bitrate / 8) / 60) : null;
  const locked = recording && active.spec.lockExposure && device.camera?.lockExposure;

  return html`
    <section class=${`bay ${recording ? 'rec' : ''} ${device.online ? '' : 'offline'}`}>
      <div class="bay-head">
        <span class=${`tally ${tally}`} aria-hidden="true"></span>
        <span class="cam">CAM ${letter}</span>
        <${NameEditor} device=${device} notify=${notify} />
        <span class="model">${device.model}</span>
        ${mic && html`<span class=${`mic ${externalMic(st) ? 'ext' : ''}`} title=${tr('mic.title')}>${mic}</span>`}
        <span class=${`conn ${conn[0]}`} title=${conn[0] === 'warn' ? tr('bay.cameraHint') : undefined}>
          ${conn[1]}
        </span>
      </div>

      <div class="bay-timecode">
        <div class=${`tc ${recording ? 'live' : ''} ${warn ? 'warn' : ''}`} aria-live="off">
          ${active?.state === 'starting' ? stateLabel('starting') : fmtClock(elapsed)}
          <small>/ ${fmtClock(maxMs)}</small>
        </div>
        <div class="bay-actions">
          ${active
            ? html`<button class="btn-ghost btn-small" disabled=${!device.online} onClick=${onStop}>${tr('bay.stopOne')}</button>
                ${!device.online &&
                html`<button class="btn-ghost btn-small" title=${tr('bay.removeTitle')} onClick=${onRemove}>${tr('bay.remove')}</button>`}`
            : html`<button class="btn-ghost btn-small" disabled=${!device.online || st.cameraReady === false} onClick=${onStart}>
                  ${tr('bay.startOne')}
                </button>
                <button class="btn-ghost btn-small" title=${tr('bay.removeTitle')} onClick=${onRemove}>${tr('bay.remove')}</button>`}
        </div>
      </div>

      <div class="meters">
        <${Meter} label=${tr('meter.battery')} value=${st.battery != null ? `${st.battery}%${st.charging ? ' ⚡' : ''}` : '—'} level=${st.battery != null && st.battery <= 15 && !st.charging ? 'bad' : st.battery <= 30 && !st.charging ? 'warn' : ''} />
        <${Meter} label=${tr('meter.temperature')} value=${st.temperatureC != null ? `${st.temperatureC.toFixed(0)}°C` : '—'} level=${st.temperatureC >= 48 ? 'bad' : st.temperatureC >= 42 ? 'warn' : ''} />
        <${Meter} label=${tr('meter.storage')} value=${st.freeBytes != null ? fmtBytes(st.freeBytes) : '—'} level=${minutesLeft != null && minutesLeft < 35 ? 'warn' : ''} />
        <${Meter} label=${tr('meter.timeLeft')} value=${minutesLeft != null ? tr('unit.minShort', { n: minutesLeft }) : '—'} level=${minutesLeft != null && minutesLeft < 35 ? 'warn' : ''} />
      </div>

      <div class=${`monitor ${portrait ? 'portrait' : ''}`}>
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
        ${guideBox &&
        html`<div class=${`guide ${guideBox.height ? 'wide' : ''}`} style=${guideBox}><span>${state.settings.guide}</span></div>`}
      </div>
      <div class="monitor-caption">
        ${selected
          ? html`<span>${selected.name}</span>
              ${!trimming && html`<button class="btn-link" onClick=${() => setTrimming(true)}>${tr('bay.trim')}</button>`}
              <button class="btn-link" onClick=${() => run(() => post('/api/open-folder', { fileId: selected.id }))}>
                ${revealLabel(state)}
              </button>
              <button class="btn-link" onClick=${() => setSelectedId(null)}>${tr('bay.backToLive')}</button>`
          : html`<span>
              ${tr('bay.live')}${st.orientation ? tr('sep') + orientationLabel(st.orientation) : ''}${locked ? tr('bay.locked') : ''}
            </span>`}
      </div>
      ${selected &&
      trimming &&
      html`<${TrimBar}
        state=${state}
        file=${selected}
        videoRef=${videoRef}
        onClose=${() => setTrimming(false)}
        onDone=${(id) => (id ? setSelectedId(id) : setTrimming(false))}
        notify=${notify}
      />`}
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
                  onTrash=${() => onTrashTake(f.takeId)}
                  selecting=${!!selection}
                  picked=${!!selection?.has(f.id)}
                  onPick=${() => onToggleSelected(f.id)}
                  run=${run}
                />`,
            )
          : html`<li class="clips-empty">${state.project ? tr('bay.noClips') : tr('bay.noProject')}</li>`}
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
  let reason = tr('live.waiting');
  if (!device.online) reason = tr('live.offline');
  else if (!device.features.includes('preview')) reason = tr('live.oldApp');
  else if (device.status.cameraReady === false) reason = tr('live.cameraNotReady');
  return html`<img ref=${imgRef} class="live" alt=${tr('live.alt', { name: device.name })} />
    ${fresh ? html`<span class="live-badge">${tr('live.badge')}</span>` : html`<div class="monitor-empty">${reason}</div>`}`;
}

// 裁剪：在監看區播放時，拖時間軸上的兩個把手設定開頭和結尾。同一段的每台手機一起裁，另存成檔名加 _1 的新檔，原本的不動。
// 用 ffmpeg 串流複製、不重新壓縮，所以開頭只能從關鍵影格開始（手機大多每 1 秒一個）。
const fmtSec = (s) => `${fmtClock(s * 1000)}.${Math.floor((s % 1) * 10)}`;
const THUMBS = 10;

// 時間軸上的縮圖：用一個看不到的 video 依序跳到幾個位置，畫成小圖。抓不到就只顯示時間軸。
function useThumbnails(fileId) {
  const [thumbs, setThumbs] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = `/media/${fileId}`;
    const wait = (event) =>
      Promise.race([new Promise((resolve) => v.addEventListener(event, resolve, { once: true })), new Promise((resolve) => setTimeout(resolve, 4000))]);
    (async () => {
      await wait('loadedmetadata');
      if (!v.videoWidth) return;
      const canvas = document.createElement('canvas');
      canvas.height = 72;
      canvas.width = Math.round((72 * v.videoWidth) / v.videoHeight);
      const out = [];
      for (let i = 0; i < THUMBS && !cancelled; i++) {
        v.currentTime = ((i + 0.5) / THUMBS) * v.duration;
        await wait('seeked');
        canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
        out.push(canvas.toDataURL('image/jpeg', 0.7));
        if (!cancelled) setThumbs([...out]);
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
      v.removeAttribute('src');
      v.load();
    };
  }, [fileId]);
  return thumbs;
}

function TrimBar({ state, file, videoRef, onClose, onDone, notify }) {
  const duration = Math.max(1, (file.durationMs ?? 0) / 1000);
  const [[start, end], setRange] = useState([0, duration]);
  const range = useRef([0, duration]); // 連續拖拉、按鍵時畫面還沒更新，從這裡拿最新的範圍
  const [now, setNow] = useState(0); // 播放頭
  const [busy, setBusy] = useState(false);
  const track = useRef(null);
  const drag = useRef(null); // 正在拖的：'start'、'end'，或在時間軸上拖播放頭 'seek'
  const stopAt = useRef(null); // 「播放這段」播到結尾就停
  const thumbs = useThumbnails(file.id);
  const angles = state.files.filter((g) => g.takeId === file.takeId && g.state === 'ready').length;
  const pct = (s) => `${(Math.min(duration, Math.max(0, s)) / duration) * 100}%`;

  // 播放頭跟著影片走，播放中每一格都更新；暫停時數值沒變就不會重畫
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const v = videoRef.current;
      if (v) {
        setNow(v.currentTime);
        if (stopAt.current != null && v.currentTime >= stopAt.current) {
          v.pause();
          stopAt.current = null;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 拖把手時監看區跟著跳到那一格，看得到從哪裡開始、到哪裡結束
  const seekTo = (s) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    stopAt.current = null;
    v.currentTime = s;
  };
  const move = (which, s) => {
    const [from, to] = range.current;
    if (which === 'start') {
      s = Math.max(0, Math.min(s, to - 1));
      range.current = [s, to];
    } else if (which === 'end') {
      s = Math.min(duration, Math.max(s, from + 1));
      range.current = [from, s];
    }
    setRange(range.current);
    seekTo(s);
  };
  const timeAt = (x) => {
    const r = track.current.getBoundingClientRect();
    return ((x - r.left) / r.width) * duration;
  };
  const onDown = (e) => {
    if (busy) return;
    drag.current = e.target.closest('[data-handle]')?.dataset.handle ?? 'seek';
    track.current.setPointerCapture(e.pointerId);
    move(drag.current, timeAt(e.clientX));
  };
  const onMove = (e) => drag.current && move(drag.current, timeAt(e.clientX));
  const onUp = () => (drag.current = null);
  // 鍵盤：方向鍵每次 0.1 秒，按著 Shift 每次 1 秒
  const onKey = (which) => (e) => {
    const step = e.shiftKey ? 1 : 0.1;
    const cur = range.current[which === 'start' ? 0 : 1];
    const next = { ArrowLeft: cur - step, ArrowRight: cur + step, Home: 0, End: duration }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    move(which, next);
  };
  const playRange = () => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = start;
    stopAt.current = end;
    v.play();
  };
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post(`/api/takes/${file.takeId}/trim`, { fileId: file.id, start, end });
      notify(tr('trim.done', { names: listJoin(r.files.map((x) => x.name)), skipped: r.skipped.length ? listJoin(r.skipped) : '' }));
      onDone(r.files.find((x) => x.from === file.id)?.id);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!state.ffmpeg) {
    return html`<div class="trim">
      <p class="hint warn">${tr('trim.needFfmpeg')}</p>
      <div class="trim-actions"><button class="btn-ghost btn-small" onClick=${onClose}>${tr('common.close')}</button></div>
    </div>`;
  }
  return html`<div class="trim" role="group" aria-label=${tr('trim.aria')}>
    <div class="trim-head">
      <button class="btn-ghost btn-small" disabled=${busy} onClick=${playRange} title=${tr('trim.playTitle')}>${tr('trim.play')}</button>
      <span class="trim-readout">${tr('trim.readout', { start: fmtSec(start), end: fmtSec(end), len: fmtSec(end - start) })}</span>
    </div>
    <div class="trim-track" ref=${track} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp}>
      <div class="trim-strip">
        ${Array.from({ length: THUMBS }, (_, i) => html`<span style=${thumbs[i] ? { backgroundImage: `url(${thumbs[i]})` } : undefined}></span>`)}
      </div>
      <div class="trim-shade" style=${{ left: 0, width: pct(start) }}></div>
      <div class="trim-shade" style=${{ left: pct(end), right: 0 }}></div>
      <div class="trim-window" style=${{ left: pct(start), width: pct(end - start) }}></div>
      <div class="trim-playhead" style=${{ left: pct(now) }}></div>
      ${[
        ['start', tr('trim.in'), start],
        ['end', tr('trim.out'), end],
      ].map(
        ([which, label, s]) => html`<div
          class=${`trim-handle ${which}`}
          data-handle=${which}
          style=${{ left: pct(s) }}
          role="slider"
          tabindex="0"
          aria-label=${label}
          aria-valuemin="0"
          aria-valuemax=${duration.toFixed(1)}
          aria-valuenow=${s.toFixed(1)}
          aria-valuetext=${fmtSec(s)}
          onKeyDown=${onKey(which)}
        ></div>`,
      )}
    </div>
    <p class="hint">${tr('trim.hint', { angles })}</p>
    <div class="trim-actions">
      <button class="btn-ghost btn-small" disabled=${busy} onClick=${onClose}>${tr('common.cancel')}</button>
      <button class="btn-primary btn-small" disabled=${busy || end - start < 1} onClick=${submit}>${busy ? tr('trim.busy') : tr('trim.submit')}</button>
    </div>
  </div>`;
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
  // 手機會把倍率限制在它能用的範圍內，顯示的是手機實際用的倍率
  const current = Math.min(max, Math.max(min, device.zoom ?? 1));
  const shown = dragging ?? current;
  return html`<div class="zoom">
    <span class="label">${tr('zoom.label')}</span>
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
      aria-label=${tr('zoom.aria', { name: device.name })}
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

function Clip({ f, state, selected, onPlay, onTrash, selecting, picked, onPick, run }) {
  const progress = f.size ? Math.min(1, f.receivedBytes / f.size) : null;
  const { rate, idleMs } = useTransferRate(f.receivedBytes);
  const sending = f.state === 'recording' || (f.state === 'finishing' && progress < 1);
  const stalled = sending && idleMs > 8000;
  const speed = sending && !stalled && rate ? tr('sep') + fmtRate(rate) : '';
  // 手機不支援要求的解析度時會降級，這裡標出實際錄的大小
  const wanted = state.resolutions.find((r) => r.id === f.spec.resolution);
  const actual = f.videoWidth ? sizeLabel(state, f.videoWidth, f.videoHeight) : null;
  const downgraded = wanted && f.videoWidth && (f.videoWidth !== wanted.width || f.videoHeight !== wanted.height);
  let detail;
  const sep = tr('sep');
  if (f.state === 'starting') detail = tr('clip.waiting');
  else if (f.state === 'recording') detail = tr('clip.uploading', { size: fmtBytes(f.receivedBytes), speed });
  else if (f.state === 'finishing') detail = progress >= 1 ? tr('clip.verifying') : tr('clip.finishing', { pct: Math.floor((progress ?? 0) * 100), speed });
  else if (f.state === 'ready') {
    detail =
      fmtClock(f.durationMs ?? 0) +
      sep +
      fmtBytes(f.size) +
      (actual ? sep + actual : '') +
      (f.orientation === 'portrait' ? tr('clip.portrait') : '') +
      (f.trimmedFrom ? tr('clip.trimmed') : '') +
      stopNote(f.stopReason);
  } else detail = f.error || tr('clip.failed');

  // 同一次錄影的另一台，顯示開始時間差多少
  const peer = state.files.find((g) => g.takeId === f.takeId && g.deviceId !== f.deviceId && g.startedAt);
  let sync = null;
  if (peer && f.startedAt) {
    const diff = f.startedAt - peer.startedAt;
    const ms = Math.round(Math.abs(diff));
    const name = state.devices.find((d) => d.id === peer.deviceId)?.name ?? tr('clip.otherPhone');
    sync = ms === 0 ? tr('clip.syncSame', { name }) : tr(diff > 0 ? 'clip.syncLater' : 'clip.syncEarlier', { name, ms });
  }

  // 平常整列都可以點，點了就在監看區播放；選取模式中點整列是勾選，錄影中、傳輸中的不能選
  const pickable = selecting && canTrash(f);
  const playable = !selecting && f.state === 'ready';
  const pick = (e) => {
    e.stopPropagation();
    onPick();
  };
  const info = html`<span class="clip-name" title=${joinPath(state, f.dir, f.name)}>${f.name}</span>
    <span class="clip-meta">
      <span class=${`chip ${f.state}`}>${stateLabel(f.state)}</span>
      <span>${detail}</span>
      ${stalled && html`<span class="clip-warn">${tr('clip.stalled')}</span>`}
      ${downgraded && html`<span class="clip-warn">${tr('clip.downgraded', { wanted: wanted.label, w: f.videoWidth, h: f.videoHeight })}</span>`}
      ${sync && html`<span class="clip-sync">${sync}</span>`}
    </span>`;
  const peers = state.files.filter((g) => g.takeId === f.takeId && canTrash(g)).length;
  return html`<li
    class=${`clip ${selecting ? 'selecting' : ''} ${selected ? 'selected' : ''} ${playable ? 'playable' : ''} ${pickable ? 'pickable' : ''} ${picked ? 'picked' : ''}`}
    onClick=${pickable ? onPick : undefined}
  >
    ${selecting
      ? html`<button class="clip-check" role="checkbox" aria-checked=${picked} disabled=${!pickable} onClick=${pick} aria-label=${tr('clip.pick', { name: f.name })}></button>
          <div class="clip-info">${info}</div>`
      : html`<button class="clip-info clip-open" disabled=${!playable} onClick=${onPlay} title=${playable ? tr('clip.playTitle') : undefined}>
          ${info}
        </button>`}
    ${f.state !== 'failed' &&
    html`<button
      class=${`clip-mark ${f.marked ? 'on' : ''}`}
      aria-pressed=${!!f.marked}
      title=${f.marked ? tr('clip.unmark') : tr('clip.mark')}
      onClick=${(e) => {
        e.stopPropagation();
        run(() => post(`/api/takes/${f.takeId}/mark`, { marked: !f.marked }));
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.5 1.2 6.4L12 17.3l-5.7 3.1 1.2-6.4-4.7-4.5 6.4-.8z" /></svg>
    </button>`}
    ${!selecting &&
    canTrash(f) &&
    html`<button
      class="clip-trash"
      title=${peers > 1 ? tr('clip.trashTake', { trash: state.trashName }) : tr('clip.trashOne', { trash: state.trashName })}
      aria-label=${tr('clip.trashAria', { name: f.name, take: peers > 1, trash: state.trashName })}
      onClick=${(e) => {
        e.stopPropagation();
        onTrash();
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4L18 7M10 11v6M14 11v6" /></svg>
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
      title=${tr('name.title')}
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
    aria-label=${tr('name.aria')}
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
        <button class="btn-ghost btn-small" onClick=${onClose}>${tr('common.close')}</button>
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
      <button class="btn-ghost" onClick=${onClose}>${tr('common.cancel')}</button>
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
      notify(tr('newProject.created', { name: p.name, ready: state.devices.some((d) => d.online) }));
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return html`<${Modal} title=${tr('newProject.title')} onClose=${onClose}>
    <div class="field">
      <label class="label" for="project-name">${tr('newProject.name')}</label>
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
    <p class="hint">${tr('newProject.path', { path: joinPath(state, state.settings.storageDir, name.trim() || tr('alerts.projectName')) })}</p>
    ${state.project && html`<p class="hint">${tr('newProject.endsCurrent', { name: state.project.name })}</p>`}
    <div class="modal-foot">
      <button class="btn-ghost" onClick=${onClose}>${tr('common.cancel')}</button>
      <button class="btn-primary" disabled=${busy || !name.trim()} onClick=${create}>${tr('newProject.create')}</button>
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

  return html`<${Modal} title=${tr('pair.title')} onClose=${onClose}>
    <div class="pair">
      <div class="qr-frame">
        ${data && left > 0
          ? html`<img src=${data.qr} alt=${tr('pair.qrAlt')} />`
          : html`<div class="qr-loading">${error || (data ? tr('pair.expired') : tr('pair.generating'))}</div>`}
      </div>
      <div>
        <ol class="steps">
          <li>${tr('pair.step1')}</li>
          <li>${tr('pair.step2')}</li>
          <li>${tr('pair.step3')}</li>
          <li>${tr('pair.step4')}</li>
        </ol>
        <p class="hint">${tr('pair.inApp')}</p>
        ${data &&
        html`<div class="pair-meta">
          ${tr('pair.connectsTo', { url: data.payload.url })}<br />
          ${left > 0 ? tr('pair.expiresIn', { time: fmtClock(left) }) : tr('pair.expiredShort')}${tr('sep')}<button
            class="btn-link"
            onClick=${() => load(true)}
          >
            ${tr('pair.renew')}
          </button>
        </div>`}
        <div class="pair-meta">${tr('pair.count', { n: devices.length, max })}</div>
        ${devices.length >= max && html`<p class="hint warn">${tr('pair.full')}</p>`}
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
      notify(tr('settings.saved'));
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

  return html`<${Modal} title=${tr('settings.title')} onClose=${onClose}>
    <div class="field">
      <label class="label" for="language">${tr('settings.language')}</label>
      <select
        id="language"
        value=${state.settings.language ?? 'auto'}
        onChange=${(e) => post('/api/settings', { language: e.target.value }).catch((err) => setError(err.message))}
      >
        <option value="auto">${tr('settings.languageAuto')}</option>
        <option value="zh-TW" lang="zh-Hant-TW">繁體中文</option>
        <option value="en" lang="en">English</option>
      </select>
      <p class="hint">${tr('settings.languageHint')}</p>
    </div>
    <div class="field">
      <label class="label" for="storage-dir">${tr('settings.folder')}</label>
      <div class="field-row" onDrop=${() => setError(tr('settings.dropHint'))}>
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
        <button class="btn-ghost" disabled=${busy} onClick=${choose}>${tr('settings.choose')}</button>
      </div>
    </div>
    ${error && html`<p class="hint bad" role="alert">${error}</p>`}
    <p class="hint">${tr('settings.folderHint', { formats: state.diskFormats })}</p>
    ${s.available
      ? html`<p class=${`hint ${s.warning ? 'warn' : ''}`}>${tr('settings.free', { free: fmtBytes(s.freeBytes), format: s.format, warning: s.warning })}</p>`
      : html`<p class="hint bad">${tr('settings.bad', { error: s.error })}</p>`}
    <div class="modal-foot">
      <button class="btn-ghost" onClick=${onClose}>${tr('common.cancel')}</button>
      <button class="btn-primary" disabled=${busy} onClick=${save}>${tr('settings.save')}</button>
    </div>
  <//>`;
}

render(html`<${App} />`, document.getElementById('app'));
