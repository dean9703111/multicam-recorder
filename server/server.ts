import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import { HttpError, isLoopback, readJson, sendFile, sendJson } from './http.ts';
import { GOOD_FORMATS, moveToTrash, powershellArgs, psQuote, TRASH_NAME } from './platform.ts';
import type {
  DeviceMessage,
  DeviceStatus,
  FinishRequest,
  Guide,
  PairRequest,
  PairResponse,
  QrPayload,
  RecordingSpec,
  Resolution,
  ServerMessage,
  VerifyRequest,
} from './protocol.ts';
import {
  checkDir,
  db,
  DEFAULT_STORAGE_DIR,
  save,
  saveNow,
  storageInfo,
  type Device,
  type FileEntry,
  type Project,
  type StorageInfo,
} from './store.ts';
import { finalPath, finish, partPath, receivedBytes, verify, writeChunk } from './uploads.ts';

const PORT = Number(process.env.PORT ?? 8787);
// 測試時可以用環境變數縮短
const MAX_DURATION_SEC = Number(process.env.RECORDER_MAX_SEC ?? 30 * 60);
const WARN_BEFORE_SEC = Number(process.env.RECORDER_WARN_SEC ?? 3 * 60);
const START_DELAY_MS = 800; // 先把指令送到每台手機，大家在同一個時間點開始
const START_TIMEOUT_MS = 10_000;
const RESOLUTIONS: { id: Resolution; label: string; width: number; height: number; bitrate: number }[] = [
  { id: '2160p', label: '4K', width: 3840, height: 2160, bitrate: 40_000_000 },
  { id: '1440p', label: '2K', width: 2560, height: 1440, bitrate: 24_000_000 },
  { id: '1080p', label: '1080p', width: 1920, height: 1080, bitrate: 16_000_000 },
  { id: '720p', label: '720p', width: 1280, height: 720, bitrate: 8_000_000 },
];
const GUIDES: Guide[] = ['none', '9:16', '4:5', '1:1'];
const MAX_DEVICES = 10; // 再多 Wi-Fi 和傳輸就吃不消了
// 手機還沒裝 App 時，配對網頁會提供這個下載連結（GitHub Releases 上最新版的 APK）
const APP_DOWNLOAD_URL = 'https://github.com/dean9703111/multicam-recorder/releases/latest/download/MultiCamRecorder.apk';
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const NODE_MODULES = path.join(import.meta.dirname, '../node_modules');
const VENDOR_FILE = path.join(NODE_MODULES, 'htm/preact/standalone.module.js');
const STATIC: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
};

// ---------- 手機連線 ----------

interface Live {
  ws: WebSocket;
  status: DeviceStatus;
  alive: boolean;
  previewOn: boolean; // 已經請手機送即時畫面
  features: string[]; // 手機支援的功能，舊版 App 沒有即時畫面和變焦
}

const live = new Map<string, Live>();

function sendTo(ws: WebSocket, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function send(deviceId: string, msg: ServerMessage): boolean {
  const l = live.get(deviceId);
  if (!l) return false;
  sendTo(l.ws, msg);
  return true;
}

function onDeviceConnection(ws: WebSocket, token: string | null): void {
  ws.on('error', () => {});
  const d = db.devices.find((x) => x.token === token);
  if (!d) {
    sendTo(ws, { type: 'error', code: 'unpaired', message: '這支手機還沒配對，請重新掃 QR Code' });
    ws.close(4001, 'unpaired');
    return;
  }
  live.get(d.id)?.ws.terminate(); // 同一支手機重連，舊的連線作廢
  const l: Live = { ws, status: {}, alive: true, previewOn: false, features: [] };
  live.set(d.id, l);
  ws.on('pong', () => {
    l.alive = true;
  });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return relayPreview(d.id, raw as Buffer); // 二進位訊息是即時畫面的 JPEG
    let m: DeviceMessage;
    try {
      m = JSON.parse(String(raw)) as DeviceMessage;
    } catch {
      return;
    }
    onDeviceMessage(d, l, m);
  });
  ws.on('close', () => {
    if (live.get(d.id) !== l) return;
    live.delete(d.id);
    changed();
  });
  changed();
}

function onDeviceMessage(d: Device, l: Live, m: DeviceMessage): void {
  const f = 'fileId' in m ? db.files.find((x) => x.id === m.fileId && x.deviceId === d.id) : undefined;
  switch (m.type) {
    case 'hello':
      l.features = Array.isArray(m.features) ? m.features.filter((x) => typeof x === 'string') : [];
      if (m.model && m.model !== d.model) {
        d.model = m.model;
        save();
      }
      send(d.id, { type: 'welcome', name: d.name, serverTime: Date.now(), spec: currentSpec(), zoom: d.zoom ?? 1 });
      updatePreviewRequests();
      break;
    case 'sync':
      send(d.id, { type: 'sync', t0: m.t0, t1: Date.now() });
      return;
    case 'status': {
      const { type: _, ...status } = m;
      l.status = { ...l.status, ...status };
      break;
    }
    case 'recordingStarted':
      if (f && f.state !== 'ready') {
        f.state = 'recording';
        f.startedAt = m.startedAt;
        f.error = undefined;
        if (typeof m.width === 'number' && typeof m.height === 'number') {
          f.videoWidth = m.width;
          f.videoHeight = m.height;
        }
        save();
      }
      break;
    case 'recordingStopped':
      // 手機每 2 秒才回報一次狀態，先在這裡清掉，緊接著再按開始才不會被當成「已經在錄影」
      if (l.status.recordingFileId === m.fileId) l.status.recordingFileId = null;
      // 傳輸可能比這則訊息早完成，所以停止原因一定要記，狀態則不要倒退
      if (f) {
        f.stoppedAt ??= Date.now();
        f.durationMs = m.durationMs;
        f.stopReason = m.reason;
        if (f.state !== 'ready') {
          f.state = 'finishing';
          f.size = m.size;
        }
        save();
      }
      break;
    case 'recordingFailed':
      if (l.status.recordingFileId === m.fileId) l.status.recordingFileId = null;
      if (f && f.state !== 'ready') {
        f.state = 'failed';
        f.error = m.error;
        save();
      }
      break;
  }
  changed();
}

// ---------- 錄影控制 ----------

const activeFile = (deviceId: string): FileEntry | undefined =>
  db.files.find((f) => f.deviceId === deviceId && (f.state === 'starting' || f.state === 'recording'));

const isRecording = (): boolean => db.files.some((f) => f.state === 'starting' || f.state === 'recording');

function startRecording(deviceIds?: string[]): { skipped: string[] } {
  const project = currentProject();
  if (!project) throw new HttpError(409, '請先新增專案', { needProject: true });
  const skipped: string[] = [];
  const targets = db.devices.filter((d) => {
    if (deviceIds && !deviceIds.includes(d.id)) return false;
    const l = live.get(d.id);
    if (!l) skipped.push(`${d.name} 離線`);
    else if (activeFile(d.id) || l.status.recordingFileId) skipped.push(`${d.name} 已經在錄影`);
    else if (l.status.cameraReady === false) skipped.push(`${d.name} 相機還沒準備好`);
    else return true;
    return false;
  });
  if (!targets.length) throw new HttpError(409, skipped.join('、') || '還沒有配對任何手機');

  const takeId = crypto.randomUUID();
  const startAt = Date.now() + START_DELAY_MS;
  const spec = currentSpec();
  for (const d of targets) {
    const dir = project.dir;
    const f: FileEntry = {
      id: crypto.randomUUID(),
      takeId,
      projectId: project.id,
      deviceId: d.id,
      name: uniqueName(dir, `${stamp(startAt)}_${fileSafe(d.name)}.mp4`),
      dir,
      createdAt: Date.now(),
      state: 'starting',
      spec,
    };
    db.files.push(f);
    send(d.id, { type: 'start', fileId: f.id, takeId, fileName: f.name, startAt, ...spec });
  }
  save();
  changed();
  return { skipped };
}

function currentSpec(): RecordingSpec {
  const r = RESOLUTIONS.find((x) => x.id === db.settings.resolution) ?? RESOLUTIONS[0];
  return {
    resolution: r.id,
    fps: 30,
    bitrate: r.bitrate,
    maxDurationSec: MAX_DURATION_SEC,
    warnBeforeSec: WARN_BEFORE_SEC,
    guide: db.settings.guide,
  };
}

// ---------- 專案 ----------

const currentProject = (): Project | undefined => db.projects.find((p) => p.id === db.settings.projectId);

// Windows 不能當資料夾名稱的保留字（不分大小寫，加副檔名也不行）
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

// macOS（APFS 預設）和 Windows 的資料夾名稱不分大小寫
const samePath = (a: string, b: string): boolean =>
  process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();

// 專案名稱就是資料夾名稱，建在目前設定的錄影資料夾底下。規則以 Windows 為準，資料夾搬到哪一台電腦都能用。
function createProject(rawName: unknown): Project {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name || name.length > 60) throw new HttpError(400, '專案名稱要 1 到 60 個字');
  if (/[/\\:*?"<>|\x00-\x1f]/.test(name) || name.startsWith('.') || name.endsWith('.')) {
    throw new HttpError(400, '專案名稱不能包含 / \\ : * ? " < > |，也不能用 . 開頭或結尾');
  }
  if (RESERVED_NAME.test(name)) throw new HttpError(400, `「${name}」是 Windows 保留的名稱，請換一個`);
  if (isRecording()) throw new HttpError(409, '錄影中不能切換專案，請先停止');
  const rootError = checkDir(db.settings.storageDir);
  if (rootError) throw new HttpError(400, `錄影資料夾不能用：${rootError}`);
  const dir = path.join(db.settings.storageDir, name);
  if (db.projects.some((p) => samePath(p.dir, dir))) throw new HttpError(409, '已經有同名的專案，可以從專案清單打開它');
  fs.mkdirSync(dir, { recursive: true });
  endCurrentProject();
  const project: Project = { id: crypto.randomUUID(), name, dir, createdAt: Date.now() };
  db.projects.push(project);
  db.settings.projectId = project.id;
  save();
  changed();
  return project;
}

function endCurrentProject(): void {
  const p = currentProject();
  if (p) p.endedAt = Date.now();
  db.settings.projectId = null;
}

function openProject(id: string): void {
  const p = db.projects.find((x) => x.id === id);
  if (!p) throw new HttpError(404, '找不到這個專案');
  if (isRecording()) throw new HttpError(409, '錄影中不能切換專案，請先停止');
  if (p.id === db.settings.projectId) return;
  endCurrentProject();
  p.endedAt = undefined;
  db.settings.projectId = p.id;
  save();
  changed();
}

function stopRecording(deviceIds?: string[]): { skipped: string[] } {
  const skipped: string[] = [];
  let sent = 0;
  for (const d of db.devices) {
    if (deviceIds && !deviceIds.includes(d.id)) continue;
    const f = activeFile(d.id);
    if (!f) continue;
    if (send(d.id, { type: 'stop', fileId: f.id })) sent++;
    else skipped.push(`${d.name} 離線，停止指令送不到`);
  }
  if (!sent && !skipped.length) throw new HttpError(409, '沒有正在錄影的手機');
  return { skipped };
}

// 檔名用的時間：20261020_143005
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 檔名裡不能有的字元（以 Windows 為準）和空白都拿掉
const fileSafe = (name: string): string => name.replace(/[/\\:*?"<>|\s\x00-\x1f]+/g, '') || 'phone';

function uniqueName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${base}_${i}${ext}`;
    const taken =
      db.files.some((f) => f.dir === dir && f.name === candidate) ||
      fs.existsSync(path.join(dir, candidate)) ||
      fs.existsSync(path.join(dir, candidate + '.part'));
    if (!taken) return candidate;
  }
}

function defaultName(model: string): string {
  const base = fileSafe(model);
  let name = base;
  for (let i = 2; db.devices.some((d) => d.name === name); i++) name = `${base}-${i}`;
  return name;
}

// ---------- 配對 ----------

let pairing: { token: string; expiresAt: number } | undefined;

// 這台電腦在區網的 IP。避開 VPN、虛擬機、Docker 這類虛擬網卡，優先用私有網段的位址。
const VIRTUAL_NIC = /^(utun|tun|tap|bridge|vmnet|vbox|veth|docker|br-|zt|tailscale|wg)|virtual|vmware|vethernet|hyper-v/i;
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function lanAddress(): string | undefined {
  const found: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) found.push({ name, address: a.address });
    }
  }
  const rank = (a: { name: string; address: string }) => (VIRTUAL_NIC.test(a.name) ? 2 : 0) + (PRIVATE_IP.test(a.address) ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b))[0]?.address;
}

// 有效期間內重開配對畫面會沿用同一個 QR Code，兩支手機掃同一個就好。
// QR Code 是網址：用手機相機掃，會打開下面 pairPage 的網頁；用 App 內的掃描則直接讀網址裡的配對碼。
async function createPairing(renew: boolean): Promise<{ qr: string; link: string; payload: QrPayload; expiresAt: number }> {
  const address = lanAddress();
  if (!address) throw new HttpError(500, '找不到這台電腦的區域網路 IP，請確認電腦已連上網路');
  if (renew || !pairing || pairing.expiresAt - Date.now() < 60_000) {
    pairing = { token: crypto.randomBytes(16).toString('base64url'), expiresAt: Date.now() + 10 * 60_000 };
  }
  const payload: QrPayload = { v: 1, url: `http://${address}:${PORT}`, pair: pairing.token };
  const link = `${payload.url}/pair?code=${encodeURIComponent(payload.pair)}`;
  const qr = await QRCode.toDataURL(link, { margin: 1, width: 360 });
  return { qr, link, payload, expiresAt: pairing.expiresAt };
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// 用手機相機掃 QR Code 後打開的網頁。按鈕會用 multicam://pair 打開 App，並把電腦位址和配對碼交給它；
// 還沒裝 App 的話，Chrome 會改去下載 APK（browser_fallback_url）。
function pairPage(req: IncomingMessage, res: ServerResponse, code: string | null): void {
  const valid = !!pairing && code === pairing.token && Date.now() < pairing.expiresAt;
  const host = /^[\w.-]+(:\d+)?$/.test(req.headers.host ?? '') ? req.headers.host : `${lanAddress()}:${PORT}`;
  const intent =
    `intent://pair?server=${encodeURIComponent(`http://${host}`)}&code=${encodeURIComponent(code ?? '')}` +
    `#Intent;scheme=multicam;package=dev.multicam.recorder;S.browser_fallback_url=${encodeURIComponent(APP_DOWNLOAD_URL)};end`;
  const ios = /iPhone|iPad|iPod/.test(req.headers['user-agent'] ?? '');
  let body: string;
  if (ios) {
    body = `<h1>目前只支援 Android</h1>
       <p>「多機錄影」的手機 App 目前只有 Android 版，iPhone 還不能當攝影機。</p>`;
  } else if (valid) {
    body = `<h1>配對這支手機</h1>
       <p>按下按鈕會打開「多機錄影」App，並自動完成配對。</p>
       <a class="btn" href="${escapeHtml(intent)}">打開 App 並配對</a>
       <h2>還沒安裝 App？</h2>
       <ol>
         <li>按上面的按鈕，或<a href="${APP_DOWNLOAD_URL}">直接下載 APK</a>。下載完點開安裝，第一次會要你允許瀏覽器安裝應用程式。</li>
         <li>裝好後回到這一頁，再按一次「打開 App 並配對」。</li>
       </ol>
       <p class="note">這個 QR Code 10 分鐘內有效。過期的話，請在電腦上按「配對手機」重新產生。</p>`;
  } else {
    body = `<h1>QR Code 已失效</h1>
       <p>請在電腦上按「配對手機」，再掃一次新的 QR Code。</p>`;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>配對多機錄影</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='none' stroke='%23ece8e1' stroke-width='3'/%3E%3Ccircle cx='16' cy='16' r='8' fill='%23ff3b3b'/%3E%3C/svg%3E" />
<style>
  body { margin: 0; padding: 40px 20px; background: #0a0b0d; color: #ece8e1; font: 17px/1.6 system-ui, sans-serif; }
  h1 { font-size: 26px; margin: 0 0 12px; }
  h2 { font-size: 18px; margin: 36px 0 8px; }
  p, li { color: #b9bdc4; }
  ol { padding-left: 22px; }
  li + li { margin-top: 8px; }
  a { color: #59c2ff; }
  .btn { display: block; margin: 28px 0; padding: 16px; border-radius: 6px; background: #ff3b3b; color: #fff;
         font-size: 19px; font-weight: 700; text-align: center; text-decoration: none; }
  .note { margin-top: 28px; font-size: 14px; color: #8b919a; }
</style>
</head>
<body>${body}</body>
</html>`);
}

async function pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson<PairRequest>(req);
  if (!pairing || b.pair !== pairing.token || Date.now() > pairing.expiresAt) {
    throw new HttpError(403, 'QR Code 已失效，請在電腦上重新產生');
  }
  if (typeof b.deviceId !== 'string' || !/^[\w-]{8,64}$/.test(b.deviceId)) throw new HttpError(400, 'deviceId 格式不正確');
  const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : 'Android';
  let d = db.devices.find((x) => x.id === b.deviceId);
  if (!d && db.devices.length >= MAX_DEVICES) {
    throw new HttpError(409, `最多只能配對 ${MAX_DEVICES} 支手機，請先在電腦上移除不用的手機`);
  }
  if (!d) {
    d = { id: b.deviceId, token: '', model, name: defaultName(model), pairedAt: Date.now() };
    db.devices.push(d);
  }
  d.model = model;
  d.token = crypto.randomBytes(24).toString('base64url'); // 重新配對就換新 token
  save();
  changed();
  const body: PairResponse = { deviceToken: d.token, name: d.name };
  sendJson(res, 200, body);
}

// ---------- 網頁控制台 ----------

// 每個控制台分頁，和它正在看即時畫面的手機
const uiClients = new Map<WebSocket, Set<string>>();
let broadcastTimer: NodeJS.Timeout | undefined;

function changed(): void {
  broadcastTimer ??= setTimeout(() => {
    broadcastTimer = undefined;
    if (!uiClients.size) return;
    const msg = JSON.stringify(snapshot());
    for (const c of uiClients.keys()) c.send(msg);
  }, 250);
}

// ---------- 即時畫面 ----------

// 有分頁在看才請手機送，沒人看就停，省手機的電和 Wi-Fi
function updatePreviewRequests(): void {
  for (const [id, l] of live) {
    const wanted = [...uiClients.values()].some((ids) => ids.has(id));
    if (wanted === l.previewOn) continue;
    l.previewOn = wanted;
    sendTo(l.ws, { type: 'preview', on: wanted });
  }
}

// 轉給正在看的分頁。格式：1 個位元組的手機 ID 長度、手機 ID、JPEG。
// 分頁收得慢（還有很多沒送出去）就丟掉這一張，畫面才不會越來越延遲。
function relayPreview(deviceId: string, jpeg: Buffer): void {
  const id = Buffer.from(deviceId);
  let frame: Buffer | undefined;
  for (const [ws, ids] of uiClients) {
    if (!ids.has(deviceId) || ws.bufferedAmount > 512 * 1024) continue;
    frame ??= Buffer.concat([Buffer.from([id.length]), id, jpeg]);
    ws.send(frame);
  }
}

let storageCache: { at: number; info: StorageInfo } | undefined;

function currentStorage(): StorageInfo {
  const dir = db.settings.storageDir;
  if (!storageCache || storageCache.info.dir !== dir || Date.now() - storageCache.at > 3000) {
    storageCache = { at: Date.now(), info: storageInfo(dir) };
  }
  return storageCache.info;
}

function snapshot() {
  // 每個專案有幾支傳完的影片、共多大
  const stats = new Map<string, { files: number; bytes: number }>();
  for (const f of db.files) {
    const s = stats.get(f.projectId) ?? { files: 0, bytes: 0 };
    if (f.state === 'ready') {
      s.files++;
      s.bytes += f.size ?? 0;
    }
    stats.set(f.projectId, s);
  }
  return {
    type: 'state',
    serverTime: Date.now(),
    platform: process.platform, // 網頁依系統顯示 Finder 或檔案總管
    sep: path.sep, // 顯示路徑用：Windows 是反斜線
    trashName: TRASH_NAME,
    diskFormats: GOOD_FORMATS,
    settings: db.settings,
    storage: currentStorage(),
    limits: { maxDurationSec: MAX_DURATION_SEC, warnBeforeSec: WARN_BEFORE_SEC, maxDevices: MAX_DEVICES },
    resolutions: RESOLUTIONS,
    guides: GUIDES,
    project: currentProject() ?? null,
    projects: [...db.projects]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => ({ ...p, ...(stats.get(p.id) ?? { files: 0, bytes: 0 }) })),
    devices: db.devices.map((d) => ({
      id: d.id,
      name: d.name,
      model: d.model,
      zoom: d.zoom ?? 1,
      online: live.has(d.id),
      features: live.get(d.id)?.features ?? [],
      status: live.get(d.id)?.status ?? {},
    })),
    // 只送目前專案的影片
    files: db.files
      .filter((f) => f.projectId === db.settings.projectId)
      .map((f) => ({ ...f, receivedBytes: f.state === 'ready' ? f.size : receivedBytes(f) })),
  };
}

// ---------- 選擇資料夾 ----------

// 瀏覽器拿不到資料夾的完整路徑，所以由伺服器這邊跳出系統的選擇資料夾視窗。
// 控制台只能在執行伺服器的這台電腦上開，視窗一定出現在使用者面前。
let choosing = false;

// 回傳 [指令, 參數, 使用者按取消時的判斷]；不支援的系統回傳 undefined
function folderPicker(start: string): [string, string[], (code: number | null, stderr: string) => boolean] | undefined {
  if (process.platform === 'darwin') {
    const quoted = `"${start.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const script = [
      'activate',
      `set f to choose folder with prompt "選擇錄影資料夾（建議選外接 SSD）" default location (POSIX file ${quoted})`,
      'POSIX path of f',
    ];
    return ['osascript', script.flatMap((line) => ['-e', line]), (_, stderr) => /-128/.test(stderr)];
  }
  if (process.platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = '選擇錄影資料夾（建議選外接 SSD）'",
      `$d.SelectedPath = ${psQuote(start)}`,
      "if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath } else { exit 2 }",
    ].join('\n');
    return ['powershell.exe', powershellArgs(ps, true), (code) => code === 2];
  }
  return undefined;
}

async function chooseFolder(): Promise<{ path?: string; canceled?: boolean }> {
  if (choosing) throw new HttpError(409, '選擇資料夾的視窗已經開著了');
  const current = db.settings.storageDir;
  const start = fs.existsSync(current) ? current : process.platform === 'darwin' ? '/Volumes' : os.homedir();
  const picker = folderPicker(start);
  if (!picker) throw new HttpError(501, '這個系統沒有選擇資料夾的視窗，請直接貼上路徑');
  const [command, args, canceled] = picker;
  choosing = true;
  try {
    return await new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
        if (!err) return resolve({ path: stdout.trim().replace(/(.)[\\/]$/, '$1') });
        if (canceled(typeof err.code === 'number' ? err.code : null, stderr)) return resolve({ canceled: true });
        reject(new HttpError(500, `打不開選擇資料夾的視窗：${stderr.trim() || err.message}`));
      });
    });
  } finally {
    choosing = false;
  }
}

// 把影片移到系統的垃圾桶（Windows 是資源回收筒），之後還救得回來。錄影中、傳輸中的不能刪。
async function trashFiles(ids: unknown): Promise<{ trashed: number }> {
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, '沒有選要刪除的影片');
  const targets = [...new Set(ids)].map((id) => {
    const f = db.files.find((x) => x.id === id);
    if (!f) throw new HttpError(404, '找不到要刪除的影片，清單可能已經更新了');
    if (f.state !== 'ready' && f.state !== 'failed') throw new HttpError(409, `${f.name} 還在錄影或傳輸，不能刪除`);
    return f;
  });
  // 失敗的影片可能只留下傳到一半的 .part
  const pathOf = (f: FileEntry) => (f.state === 'ready' ? finalPath(f) : partPath(f));
  let error: unknown;
  try {
    await moveToTrash(targets.map(pathOf).filter((file) => fs.existsSync(file)));
  } catch (e) {
    error = e;
  }
  // 不管成功幾支，已經不在原處的就從清單拿掉
  const gone = new Set(targets.filter((f) => !fs.existsSync(pathOf(f))).map((f) => f.id));
  db.files = db.files.filter((f) => !gone.has(f.id));
  save();
  changed();
  if (gone.size < targets.length) {
    const reason = error instanceof Error ? `：${error.message}` : '';
    throw new HttpError(500, `有 ${targets.length - gone.size} 支影片沒有移到${TRASH_NAME}${reason}`);
  }
  return { trashed: gone.size };
}

// 在 Finder／檔案總管打開目前的專案資料夾；有指定影片時，macOS 會直接選取那支影片
function openFolder(fileId?: string): void {
  let target: string;
  if (fileId) {
    const f = db.files.find((x) => x.id === fileId && x.state === 'ready');
    if (!f) throw new HttpError(404, '找不到這支影片');
    target = finalPath(f);
  } else {
    const p = currentProject();
    if (!p) throw new HttpError(409, '還沒有專案');
    target = p.dir;
  }
  if (!fs.existsSync(target)) throw new HttpError(404, `找不到 ${target}`);
  const folder = fileId ? path.dirname(target) : target;
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', fileId ? ['-R', target] : [target]]
      : process.platform === 'win32'
        ? ['explorer.exe', [folder]]
        : ['xdg-open', [folder]];
  execFile(command, args, () => {}); // explorer.exe 成功時也會回傳非 0，所以不看結果
}

// ---------- HTTP ----------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method ?? 'GET';

  // 手機用的 API：區網可以連，靠配對碼和 token 驗證
  if (method === 'GET' && p === '/pair') return pairPage(req, res, url.searchParams.get('code'));
  if (method === 'POST' && p === '/api/pair') return pair(req, res);
  let m = /^\/api\/upload\/([\w-]+)(\/finish|\/verify)?$/.exec(p);
  if (m) return upload(req, res, m[1], m[2], url);

  // 其他都只允許執行伺服器的這台電腦本機
  if (!isLoopback(req)) throw new HttpError(403, '只能在執行伺服器的這台電腦上操作');

  if (method === 'GET') {
    const name = p === '/' ? 'index.html' : p.slice(1);
    if (STATIC[name]) {
      res.writeHead(200, { 'Content-Type': STATIC[name], 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, name)));
      return;
    }
    if (p === '/vendor/preact-htm.js') return sendFile(req, res, VENDOR_FILE, 'text/javascript; charset=utf-8');
    m = /^\/fonts\/((barlow-condensed|barlow|martian-mono)-latin-\d{3}-normal\.woff2)$/.exec(p);
    if (m) return sendFile(req, res, path.join(NODE_MODULES, '@fontsource', m[2], 'files', m[1]), 'font/woff2');
    if (p === '/api/state') return sendJson(res, 200, snapshot());
    m = /^\/media\/([\w-]+)$/.exec(p);
    if (m) {
      const f = db.files.find((x) => x.id === m![1]);
      if (!f || f.state !== 'ready') throw new HttpError(404, '影片還沒傳完');
      return sendFile(req, res, finalPath(f), 'video/mp4');
    }
  }

  if (method === 'POST') {
    if (p === '/api/record/start') {
      const b = await readJson<{ deviceIds?: string[] }>(req);
      return sendJson(res, 200, startRecording(b.deviceIds));
    }
    if (p === '/api/record/stop') {
      const b = await readJson<{ deviceIds?: string[] }>(req);
      return sendJson(res, 200, stopRecording(b.deviceIds));
    }
    if (p === '/api/choose-folder') return sendJson(res, 200, await chooseFolder());
    if (p === '/api/open-folder') {
      const b = await readJson<{ fileId?: string }>(req);
      openFolder(b.fileId);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/projects') {
      const b = await readJson<{ name?: string }>(req);
      return sendJson(res, 200, createProject(b.name));
    }
    if (p === '/api/projects/end') {
      if (isRecording()) throw new HttpError(409, '錄影中不能結束專案，請先停止');
      endCurrentProject();
      save();
      changed();
      return sendJson(res, 200, { ok: true });
    }
    m = /^\/api\/projects\/([\w-]+)\/open$/.exec(p);
    if (m) {
      openProject(m[1]);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/pairing') {
      const b = await readJson<{ renew?: boolean }>(req);
      return sendJson(res, 200, await createPairing(b.renew === true));
    }
    if (p === '/api/settings') {
      const b = await readJson<{ resolution?: Resolution; guide?: Guide; storageDir?: string }>(req);
      if (b.resolution !== undefined) {
        if (!RESOLUTIONS.some((r) => r.id === b.resolution)) throw new HttpError(400, '不支援這個解析度');
        if (isRecording()) throw new HttpError(409, '錄影中不能改解析度，停止後再調整');
        db.settings.resolution = b.resolution;
      }
      if (b.guide !== undefined) {
        if (!GUIDES.includes(b.guide)) throw new HttpError(400, '不支援這種輔助框');
        db.settings.guide = b.guide; // 只影響預覽，錄影中也可以改
      }
      if (b.resolution !== undefined || b.guide !== undefined) {
        for (const id of live.keys()) send(id, { type: 'config', ...currentSpec() });
      }
      if (b.storageDir !== undefined) {
        const dir = path.resolve(b.storageDir.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
        const error = checkDir(dir);
        if (error) throw new HttpError(400, error);
        db.settings.storageDir = dir;
      }
      save();
      changed();
      return sendJson(res, 200, { ok: true });
    }
    m = /^\/api\/devices\/([\w-]+)\/remove$/.exec(p);
    if (m) {
      const d = db.devices.find((x) => x.id === m![1]);
      if (!d) throw new HttpError(404, '找不到這支手機');
      const active = activeFile(d.id);
      const l = live.get(d.id);
      if (active && l) throw new HttpError(409, '這支手機正在錄影，停止後才能移除');
      // 錄影中斷線、一直沒連回來的手機（例如沒電了）也要能移除，不然整個控制台會一直停在錄影中
      if (active) {
        active.state = 'failed';
        active.error = '手機已從電腦上移除，影片留在手機上';
      }
      if (l) {
        sendTo(l.ws, { type: 'error', code: 'unpaired', message: '這支手機已經從電腦上移除，要再使用請重新掃 QR Code' });
        l.ws.close(4001, 'removed');
      }
      db.devices = db.devices.filter((x) => x !== d);
      save();
      changed();
      return sendJson(res, 200, { ok: true });
    }
    m = /^\/api\/devices\/([\w-]+)\/zoom$/.exec(p);
    if (m) {
      const d = db.devices.find((x) => x.id === m![1]);
      if (!d) throw new HttpError(404, '找不到這支手機');
      const b = await readJson<{ ratio?: number }>(req);
      if (typeof b.ratio !== 'number' || !(b.ratio > 0 && b.ratio <= 100)) throw new HttpError(400, '變焦倍率不正確');
      // 手機會自己限制在它能用的範圍內，再回報實際的倍率
      d.zoom = Math.round(b.ratio * 100) / 100;
      send(d.id, { type: 'zoom', ratio: d.zoom });
      save();
      changed();
      return sendJson(res, 200, { ok: true });
    }
    m = /^\/api\/takes\/([\w-]+)\/mark$/.exec(p);
    if (m) {
      const b = await readJson<{ marked?: boolean }>(req);
      const files = db.files.filter((f) => f.takeId === m![1]);
      if (!files.length) throw new HttpError(404, '找不到這一段');
      for (const f of files) f.marked = b.marked === true;
      save();
      changed();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/files/trash') {
      const b = await readJson<{ fileIds?: unknown }>(req);
      return sendJson(res, 200, await trashFiles(b.fileIds));
    }
    m = /^\/api\/devices\/([\w-]+)\/rename$/.exec(p);
    if (m) {
      const d = db.devices.find((x) => x.id === m![1]);
      if (!d) throw new HttpError(404, '找不到這支手機');
      const b = await readJson<{ name?: string }>(req);
      const name = (b.name ?? '').trim();
      if (!name || name.length > 40) throw new HttpError(400, '名稱要 1 到 40 個字');
      d.name = name;
      send(d.id, { type: 'rename', name });
      save();
      changed();
      return sendJson(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, '找不到這個網址');
}

async function upload(req: IncomingMessage, res: ServerResponse, fileId: string, action: string | undefined, url: URL): Promise<void> {
  const f = db.files.find((x) => x.id === fileId);
  if (!f) throw new HttpError(404, '找不到這個檔案');
  const d = db.devices.find((x) => x.id === f.deviceId);
  if (!d || req.headers['x-device-token'] !== d.token) throw new HttpError(401, '裝置驗證失敗');

  if (action === '/verify' && req.method === 'POST') {
    if (f.state === 'ready') return sendJson(res, 200, { ok: true });
    const result = await verify(f, await readJson<VerifyRequest>(req));
    if (result.ok) {
      f.state = 'ready';
      f.error = undefined;
      save();
      changed();
    }
    return sendJson(res, 200, result);
  }
  if (f.state === 'ready') throw new HttpError(409, '這個檔案已經傳完了');
  if (!action && req.method === 'GET') return sendJson(res, 200, { receivedBytes: receivedBytes(f) });
  if (!action && req.method === 'PUT') {
    const offset = Number(url.searchParams.get('offset'));
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'offset 格式不正確');
    const n = await writeChunk(f, offset, req);
    changed();
    return sendJson(res, 200, { receivedBytes: n });
  }
  if (action === '/finish' && req.method === 'POST') {
    const b = await readJson<FinishRequest>(req);
    if (!Number.isSafeInteger(b.size) || b.size < 0) throw new HttpError(400, 'size 格式不正確');
    finish(f, b.size);
    f.durationMs = b.durationMs;
    f.state = 'finishing';
    save();
    changed();
    return sendJson(res, 200, { ok: true });
  }
  throw new HttpError(405, '不支援這個操作');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e: unknown) => {
    const err = e instanceof HttpError ? e : new HttpError(500, (e as Error).message);
    if (err.status >= 500) console.error(`${req.method} ${req.url}:`, (e as Error).message);
    if (res.headersSent) res.destroy();
    else sendJson(res, err.status, { error: err.message, ...err.body });
  });
});

// 手機送的最大是即時畫面的 JPEG，幾十 KB 而已
const deviceWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const uiWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/ws/device') {
    deviceWss.handleUpgrade(req, socket, head, (ws) => onDeviceConnection(ws, url.searchParams.get('token')));
  } else if (url.pathname === '/ws/ui' && isLoopback(req)) {
    uiWss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      uiClients.set(ws, new Set());
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(String(raw)) as { type?: string; deviceIds?: unknown };
          if (m.type !== 'watch' || !Array.isArray(m.deviceIds)) return;
          uiClients.set(ws, new Set(m.deviceIds.filter((x): x is string => typeof x === 'string')));
          updatePreviewRequests();
        } catch {
          // 看不懂的訊息就不理
        }
      });
      ws.on('close', () => {
        uiClients.delete(ws);
        updatePreviewRequests();
      });
      ws.send(JSON.stringify(snapshot()));
    });
  } else {
    socket.destroy();
  }
});

// ---------- 定時檢查 ----------

const stopSent = new Set<string>();
let tick = 0;

// 使用者在 Finder 或檔案總管裡刪掉的影片或專案資料夾，清單上也跟著拿掉。
// 上一層資料夾也不見時（例如外接硬碟沒接上）先保留，接回來就會恢復。
function pruneMissing(): boolean {
  const before = db.projects.length + db.files.length;
  const gone = new Set(db.projects.filter((p) => fs.existsSync(path.dirname(p.dir)) && !fs.existsSync(p.dir)).map((p) => p.id));
  if (gone.size) {
    db.projects = db.projects.filter((p) => !gone.has(p.id));
    db.files = db.files.filter((f) => !gone.has(f.projectId));
    if (db.settings.projectId && gone.has(db.settings.projectId)) db.settings.projectId = null;
  }
  db.files = db.files.filter((f) => f.state !== 'ready' || !fs.existsSync(f.dir) || fs.existsSync(finalPath(f)));
  return db.projects.length + db.files.length !== before;
}

setInterval(() => {
  const now = Date.now();
  for (const f of db.files) {
    if (f.state === 'starting' && now - f.createdAt > START_DELAY_MS + START_TIMEOUT_MS) {
      f.state = 'failed';
      f.error = '手機沒有回應開始錄影';
      save();
      changed();
    }
    // 手機自己會在時間到時停止，這裡是保險
    if (f.state === 'recording' && f.startedAt && now - f.startedAt > (f.spec.maxDurationSec + 5) * 1000 && !stopSent.has(f.id)) {
      stopSent.add(f.id);
      send(f.deviceId, { type: 'stop', fileId: f.id });
    }
    // 錄影中斷線、超過上限時間一分鐘還沒連回來（例如沒電了）就不再等，免得控制台一直停在錄影中。
    // 手機之後連回來的話，照樣會把影片傳完。
    if (f.state === 'recording' && f.startedAt && !live.has(f.deviceId) && now - f.startedAt > (f.spec.maxDurationSec + 60) * 1000) {
      f.state = 'failed';
      f.error = '手機斷線後一直沒有連回來，影片還在手機上';
      save();
      changed();
    }
  }
  if (++tick % 5 === 0) {
    if (pruneMissing()) save();
    changed(); // 剩餘空間等資訊定期更新
  }
}, 1000);

// 偵測已經斷掉但沒有正常關閉的連線
setInterval(() => {
  for (const l of live.values()) {
    if (!l.alive) {
      l.ws.terminate();
      continue;
    }
    l.alive = false;
    l.ws.ping();
  }
}, 10_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    saveNow();
    process.exit(0);
  });
}

server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `連接埠 ${PORT} 已被占用，伺服器可能已經在執行` : e.message);
  process.exit(1);
});

// 上次失敗的錄影只是殘留紀錄，重新啟動時清掉
db.files = db.files.filter((f) => f.state !== 'failed');
if (!currentProject()) db.settings.projectId = null;
pruneMissing();
saveNow();

// 預設的錄影資料夾由我們自己建立；使用者指定的資料夾則必須已經存在
if (db.settings.storageDir === DEFAULT_STORAGE_DIR) fs.mkdirSync(DEFAULT_STORAGE_DIR, { recursive: true });

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanAddress();
  console.log(`控制台：http://localhost:${PORT}`);
  console.log(ip ? `手機連線位址：http://${ip}:${PORT}` : '找不到區域網路 IP，手機會連不到');
  console.log(`錄影資料夾：${db.settings.storageDir}`);
});
