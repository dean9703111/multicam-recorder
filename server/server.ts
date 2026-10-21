import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import { HttpError, isLoopback, readJson, sendFile, sendJson } from './http.ts';
import { currentLang, joinList, LANG_SETTINGS, m, parseLang, PHONE_ERRORS, setDefaultLang, systemLang, withLang, type Lang, type LangSetting } from './i18n.ts';
import { ffmpegInstallCommand, moveToTrash, powershellArgs, psQuote, toolDirs } from './platform.ts';
import type {
  CameraCapabilities,
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
  'i18n.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
};

// ---------- 手機連線 ----------

interface Live {
  ws: WebSocket;
  status: DeviceStatus;
  alive: boolean;
  previewOn: boolean; // 已經請手機送即時畫面
  features: string[]; // 手機支援的功能，舊版 App 沒有即時畫面和變焦
  camera: CameraCapabilities | null; // 做得到哪些人像設定；舊版 App 沒有回報
  lang: Lang; // 送給這支手機的訊息用的語言：連線時的 Accept-Language，hello 裡的 lang
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

function onDeviceConnection(ws: WebSocket, token: string | null, lang: Lang): void {
  ws.on('error', () => {});
  const d = db.devices.find((x) => x.token === token);
  if (!d) {
    sendTo(ws, { type: 'error', code: 'unpaired', message: m('device.unpaired', {}, lang) });
    ws.close(4001, 'unpaired');
    return;
  }
  live.get(d.id)?.ws.terminate(); // 同一支手機重連，舊的連線作廢
  const l: Live = { ws, status: {}, alive: true, previewOn: false, features: [], camera: null, lang };
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

// 手機回報的相機能力；格式不對的項目當成做不到
function cameraOf(c: Partial<CameraCapabilities> | undefined): CameraCapabilities | null {
  if (!c || typeof c !== 'object') return null;
  return { facePriority: c.facePriority === true, lockExposure: c.lockExposure === true };
}

function onDeviceMessage(d: Device, l: Live, m: DeviceMessage): void {
  const f = 'fileId' in m ? db.files.find((x) => x.id === m.fileId && x.deviceId === d.id) : undefined;
  switch (m.type) {
    case 'hello':
      l.features = Array.isArray(m.features) ? m.features.filter((x) => typeof x === 'string') : [];
      l.camera = cameraOf(m.camera);
      l.lang = parseLang(m.lang) ?? l.lang;
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
        clearError(f);
        if (typeof m.width === 'number' && typeof m.height === 'number') {
          f.videoWidth = m.width;
          f.videoHeight = m.height;
        }
        if (m.orientation === 'portrait' || m.orientation === 'landscape') f.orientation = m.orientation;
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
        // 新版 App 用代碼回報，控制台才能用自己的語言顯示；舊版 App 直接送中文訊息
        if (typeof m.code === 'string' && PHONE_ERRORS.includes(m.code)) {
          setError(f, `fileError.phone.${m.code}`, { detail: typeof m.detail === 'string' ? m.detail : '' });
        } else {
          setError(f, undefined, undefined, m.error);
        }
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
  if (!project) throw new HttpError(409, m('rec.needProject'), { needProject: true });
  const skipped: string[] = [];
  const targets = db.devices.filter((d) => {
    if (deviceIds && !deviceIds.includes(d.id)) return false;
    const l = live.get(d.id);
    if (!l) skipped.push(m('rec.offline', { name: d.name }));
    else if (activeFile(d.id) || l.status.recordingFileId) skipped.push(m('rec.busy', { name: d.name }));
    else if (l.status.cameraReady === false) skipped.push(m('rec.cameraNotReady', { name: d.name }));
    else return true;
    return false;
  });
  if (!targets.length) throw new HttpError(409, joinList(skipped) || m('rec.noPhones'));

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
    facePriority: db.settings.facePriority,
    lockExposure: db.settings.lockExposure,
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
  if (!name || name.length > 60) throw new HttpError(400, m('project.nameLength'));
  if (/[/\\:*?"<>|\x00-\x1f]/.test(name) || name.startsWith('.') || name.endsWith('.')) {
    throw new HttpError(400, m('project.nameChars'));
  }
  if (RESERVED_NAME.test(name)) throw new HttpError(400, m('project.reserved', { name }));
  if (isRecording()) throw new HttpError(409, m('project.switchWhileRecording'));
  const rootError = checkDir(db.settings.storageDir);
  if (rootError) throw new HttpError(400, m('project.badRoot', { error: rootError }));
  const dir = path.join(db.settings.storageDir, name);
  if (db.projects.some((p) => samePath(p.dir, dir))) throw new HttpError(409, m('project.exists'));
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
  if (!p) throw new HttpError(404, m('project.notFound'));
  if (isRecording()) throw new HttpError(409, m('project.switchWhileRecording'));
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
    else skipped.push(m('rec.stopUnreachable', { name: d.name }));
  }
  if (!sent && !skipped.length) throw new HttpError(409, m('rec.nothingRecording'));
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

// 清單上、資料夾裡已經有這個檔名（傳輸中的 .part 也算）
const nameTaken = (dir: string, name: string): boolean =>
  db.files.some((f) => f.dir === dir && f.name === name) ||
  fs.existsSync(path.join(dir, name)) ||
  fs.existsSync(path.join(dir, name + '.part'));

function uniqueName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${base}_${i}${ext}`;
    if (!nameTaken(dir, candidate)) return candidate;
  }
}

// 裁剪出來的檔名：原檔名後面加 _1，已經有了就用 _2、_3…
function trimmedName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${base}_${i}${ext}`;
    if (!nameTaken(dir, candidate)) return candidate;
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
  if (!address) throw new HttpError(500, m('pair.noIp'));
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
    body = `<h1>${m('pairPage.iosTitle')}</h1>
       <p>${m('pairPage.iosBody')}</p>`;
  } else if (valid) {
    body = `<h1>${m('pairPage.heading')}</h1>
       <p>${m('pairPage.body')}</p>
       <a class="btn" href="${escapeHtml(intent)}">${m('pairPage.button')}</a>
       <h2>${m('pairPage.noApp')}</h2>
       <ol>
         <li>${m('pairPage.step1', { url: APP_DOWNLOAD_URL })}</li>
         <li>${m('pairPage.step2')}</li>
       </ol>
       <p class="note">${m('pairPage.validity')}</p>`;
  } else {
    body = `<h1>${m('pairPage.expiredTitle')}</h1>
       <p>${m('pairPage.expiredBody')}</p>`;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html>
<html lang="${m('html.lang')}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${m('pairPage.title')}</title>
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
    throw new HttpError(403, m('pair.expired'));
  }
  if (typeof b.deviceId !== 'string' || !/^[\w-]{8,64}$/.test(b.deviceId)) throw new HttpError(400, m('pair.badDeviceId'));
  const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : 'Android';
  let d = db.devices.find((x) => x.id === b.deviceId);
  if (!d && db.devices.length >= MAX_DEVICES) {
    throw new HttpError(409, m('pair.tooMany', { max: MAX_DEVICES }));
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
const uiLangs = new Map<WebSocket, Lang>(); // 每個分頁用的語言
let broadcastTimer: NodeJS.Timeout | undefined;

// 沒有請求可以參考時用的語言：使用者選的，自動時看這台電腦的系統語言
const defaultLang = (): Lang => (db.settings.language === 'zh-TW' || db.settings.language === 'en' ? db.settings.language : systemLang());
setDefaultLang(defaultLang);

const stateMessage = (lang: Lang): string => withLang(lang, () => JSON.stringify(snapshot()));

function changed(): void {
  broadcastTimer ??= setTimeout(() => {
    broadcastTimer = undefined;
    const messages = new Map<Lang, string>();
    for (const [c, lang] of uiLangs) {
      if (!messages.has(lang)) messages.set(lang, stateMessage(lang));
      c.send(messages.get(lang)!);
    }
  }, 250);
}

// 影片失敗的原因存代碼，送給控制台時才換成那個分頁的語言；舊版 App 送來的訊息照原樣存在 error
function setError(f: FileEntry, code?: string, params?: Record<string, string>, text?: string): void {
  f.errorCode = code;
  f.errorParams = params;
  f.error = text;
}
const clearError = (f: FileEntry): void => setError(f);

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

const storageCache = new Map<Lang, { at: number; info: StorageInfo }>(); // 說明文字跟著語言，所以各存一份

function currentStorage(): StorageInfo {
  const dir = db.settings.storageDir;
  const cached = storageCache.get(currentLang());
  if (cached && cached.info.dir === dir && Date.now() - cached.at < 3000) return cached.info;
  const info = storageInfo(dir);
  storageCache.set(currentLang(), { at: Date.now(), info });
  return info;
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
    trashName: m('trash.name'),
    ffmpeg: ffmpegReady, // 有 ffmpeg 才能裁剪
    diskFormats: m('disk.goodFormats'),
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
      camera: live.get(d.id)?.camera ?? null,
      status: live.get(d.id)?.status ?? {},
    })),
    // 只送目前專案的影片
    files: db.files
      .filter((f) => f.projectId === db.settings.projectId)
      .map(({ errorCode, errorParams, ...f }) => ({
        ...f,
        error: errorCode ? m(errorCode, errorParams) : f.error,
        receivedBytes: f.state === 'ready' ? f.size : receivedBytes(f),
      })),
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
      `set f to choose folder with prompt "${m('folder.prompt')}" default location (POSIX file ${quoted})`,
      'POSIX path of f',
    ];
    return ['osascript', script.flatMap((line) => ['-e', line]), (_, stderr) => /-128/.test(stderr)];
  }
  if (process.platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = ${psQuote(m('folder.prompt'))}`,
      `$d.SelectedPath = ${psQuote(start)}`,
      "if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath } else { exit 2 }",
    ].join('\n');
    return ['powershell.exe', powershellArgs(ps, true), (code) => code === 2];
  }
  return undefined;
}

async function chooseFolder(): Promise<{ path?: string; canceled?: boolean }> {
  if (choosing) throw new HttpError(409, m('folder.busy'));
  const current = db.settings.storageDir;
  const start = fs.existsSync(current) ? current : process.platform === 'darwin' ? '/Volumes' : os.homedir();
  const picker = folderPicker(start);
  if (!picker) throw new HttpError(501, m('folder.unsupported'));
  const [command, args, canceled] = picker;
  choosing = true;
  try {
    return await new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
        if (!err) return resolve({ path: stdout.trim().replace(/(.)[\\/]$/, '$1') });
        if (canceled(typeof err.code === 'number' ? err.code : null, stderr)) return resolve({ canceled: true });
        reject(new HttpError(500, m('folder.failed', { error: stderr.trim() || err.message })));
      });
    });
  } finally {
    choosing = false;
  }
}

// 把影片移到系統的垃圾桶（Windows 是資源回收筒），之後還救得回來。錄影中、傳輸中的不能刪。
async function trashFiles(ids: unknown): Promise<{ trashed: number }> {
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, m('files.noneSelected'));
  const targets = [...new Set(ids)].map((id) => {
    const f = db.files.find((x) => x.id === id);
    if (!f) throw new HttpError(404, m('files.missing'));
    if (f.state !== 'ready' && f.state !== 'failed') throw new HttpError(409, m('files.busy', { name: f.name }));
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
    const reason = error instanceof Error ? `${m('punct.colon')}${error.message}` : '';
    throw new HttpError(500, m('files.trashFailed', { count: targets.length - gone.size, trash: m('trash.name'), reason }));
  }
  return { trashed: gone.size };
}

// ---------- 裁剪 ----------

// 裁剪用電腦上的 ffmpeg、ffprobe 做串流複製，不重新壓縮，畫質不變。
// 沒裝的話控制台會跳出安裝說明；裝好後按「重新檢查」會再找一次，不用重開。
let ffmpegReady = false;
const tools: Record<string, string> = {}; // 找到的執行檔：PATH 上的就是名稱，其他資料夾的是完整路徑

// 先找 PATH，找不到再找剛裝好時可能在的資料夾（toolDirs）
async function checkFfmpeg(): Promise<boolean> {
  if (ffmpegReady) return true;
  const runs = (file: string) => runTool(file, ['-version']).then(() => true, () => false);
  let dirs: string[] | undefined;
  for (const name of ['ffmpeg', 'ffprobe']) {
    if (await runs(name)) {
      tools[name] = name;
      continue;
    }
    dirs ??= await toolDirs();
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    let found: string | undefined;
    for (const dir of dirs) {
      const file = path.join(dir, exe);
      if (fs.existsSync(file) && (await runs(file))) {
        found = file;
        break;
      }
    }
    if (!found) return false;
    tools[name] = found;
  }
  ffmpegReady = true;
  changed();
  return true;
}
void checkFfmpeg();
const trimming = new Set<string>(); // 正在裁剪的段落，避免連按兩次

function runTool(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(tools[cmd] ?? cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (e, stdout, stderr) =>
      e ? reject(new Error(String(stderr).trim().split('\n').pop() || e.message)) : resolve(String(stdout)),
    ),
  );
}

// time 秒（含）之前最近的關鍵影格。串流複製只能從關鍵影格開始，不然開頭的畫面解不出來；手機大多每 1 秒一個。
async function keyframeBefore(file: string, time: number): Promise<number> {
  if (time <= 0) return 0;
  const start = Number(await runTool('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', file])) || 0;
  const around = `${start + Math.max(0, time - 10)}%${start + time + 0.1}`; // 只讀附近，30 分鐘的 4K 也很快
  const packets = await runTool('ffprobe', [
    ...['-v', 'error', '-select_streams', 'v:0', '-read_intervals', around],
    ...['-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file],
  ]);
  let best = 0;
  for (const line of packets.split('\n')) {
    const [pts, flags] = line.split(',');
    const t = Number(pts) - start;
    if (flags?.startsWith('K') && t <= time + 0.001 && t > best) best = t;
  }
  return best;
}

// 只裁前後：同一段的每台手機一起裁，另存新檔（檔名加 _1），原本的不動。
// start、end 是在 fileId 那支影片上的秒數，其他手機用開始時間差換算，裁的是同一段時間。
async function trimTake(takeId: string, b: { fileId?: unknown; start?: unknown; end?: unknown }) {
  if (!(await checkFfmpeg())) {
    throw new HttpError(409, m('trim.needFfmpeg', { cmd: ffmpegInstallCommand() }));
  }
  const files = db.files.filter((f) => f.takeId === takeId && f.state === 'ready');
  const ref = files.find((f) => f.id === b.fileId);
  if (!ref) throw new HttpError(404, m('trim.clipMissing'));
  const start = Number(b.start);
  const end = Number(b.end);
  if (!(start >= 0 && end - start >= 1 && end <= (ref.durationMs ?? 0) / 1000 + 0.5)) throw new HttpError(400, m('trim.badRange'));
  if (trimming.has(takeId)) throw new HttpError(409, m('trim.busy'));
  trimming.add(takeId);
  try {
    const newTake = crypto.randomUUID();
    const made: FileEntry[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const offset = f.startedAt && ref.startedAt ? (f.startedAt - ref.startedAt) / 1000 : 0;
      const from = Math.max(0, start - offset);
      const to = Math.min((f.durationMs ?? 0) / 1000, end - offset);
      if (to - from < 0.5) {
        skipped.push(m('trim.notCovered', { name: db.devices.find((d) => d.id === f.deviceId)?.name ?? f.name }));
        continue;
      }
      const src = finalPath(f);
      const at = await keyframeBefore(src, from);
      const name = trimmedName(f.dir, f.name);
      const out = path.join(f.dir, name);
      try {
        await runTool('ffmpeg', [
          ...['-v', 'error', '-y', '-ss', String(at), '-i', src, '-t', String(to - at)],
          ...['-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-f', 'mp4', out + '.part'],
        ]);
        fs.renameSync(out + '.part', out);
      } catch (e) {
        fs.unlink(out + '.part', () => {});
        throw new HttpError(500, m('trim.failed', { name: f.name, error: (e as Error).message }));
      }
      const probed = Number(await runTool('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]));
      const entry: FileEntry = {
        id: crypto.randomUUID(),
        takeId: newTake,
        projectId: f.projectId,
        deviceId: f.deviceId,
        name,
        dir: f.dir,
        createdAt: Date.now(),
        startedAt: f.startedAt ? f.startedAt + Math.round(at * 1000) : undefined, // 新檔實際從這裡開始
        durationMs: Math.round((Number.isFinite(probed) ? probed : to - at) * 1000),
        size: fs.statSync(out).size,
        state: 'ready',
        spec: f.spec,
        videoWidth: f.videoWidth,
        videoHeight: f.videoHeight,
        orientation: f.orientation,
        trimmedFrom: f.id,
      };
      db.files.push(entry);
      made.push(entry);
      save();
      changed();
    }
    return { files: made.map((f) => ({ id: f.id, name: f.name, from: f.trimmedFrom })), skipped };
  } finally {
    trimming.delete(takeId);
  }
}

// 在 Finder／檔案總管打開目前的專案資料夾；有指定影片時，macOS 會直接選取那支影片
function openFolder(fileId?: string): void {
  let target: string;
  if (fileId) {
    const f = db.files.find((x) => x.id === fileId && x.state === 'ready');
    if (!f) throw new HttpError(404, m('file.notFound'));
    target = finalPath(f);
  } else {
    const p = currentProject();
    if (!p) throw new HttpError(409, m('project.none'));
    target = p.dir;
  }
  if (!fs.existsSync(target)) throw new HttpError(404, m('path.notFound', { path: target }));
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
  let match = /^\/api\/upload\/([\w-]+)(\/finish|\/verify)?$/.exec(p);
  if (match) return upload(req, res, match[1], match[2], url);

  // 其他都只允許執行伺服器的這台電腦本機
  if (!isLoopback(req)) throw new HttpError(403, m('http.localOnly'));

  if (method === 'GET') {
    const name = p === '/' ? 'index.html' : p.slice(1);
    if (STATIC[name]) {
      res.writeHead(200, { 'Content-Type': STATIC[name], 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, name)));
      return;
    }
    if (p === '/vendor/preact-htm.js') return sendFile(req, res, VENDOR_FILE, 'text/javascript; charset=utf-8');
    match = /^\/fonts\/((barlow-condensed|barlow|martian-mono)-latin-\d{3}-normal\.woff2)$/.exec(p);
    if (match) return sendFile(req, res, path.join(NODE_MODULES, '@fontsource', match[2], 'files', match[1]), 'font/woff2');
    if (p === '/api/state') return sendJson(res, 200, snapshot());
    match = /^\/media\/([\w-]+)$/.exec(p);
    if (match) {
      const f = db.files.find((x) => x.id === match![1]);
      if (!f || f.state !== 'ready') throw new HttpError(404, m('file.notReady'));
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
    if (p === '/api/ffmpeg/check') return sendJson(res, 200, { ffmpeg: await checkFfmpeg() });
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
      if (isRecording()) throw new HttpError(409, m('project.endWhileRecording'));
      endCurrentProject();
      save();
      changed();
      return sendJson(res, 200, { ok: true });
    }
    match = /^\/api\/projects\/([\w-]+)\/open$/.exec(p);
    if (match) {
      openProject(match[1]);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/pairing') {
      const b = await readJson<{ renew?: boolean }>(req);
      return sendJson(res, 200, await createPairing(b.renew === true));
    }
    if (p === '/api/settings') {
      const b = await readJson<{
        resolution?: Resolution;
        guide?: Guide;
        storageDir?: string;
        facePriority?: boolean;
        lockExposure?: boolean;
        language?: LangSetting;
      }>(req);
      if (b.resolution !== undefined) {
        if (!RESOLUTIONS.some((r) => r.id === b.resolution)) throw new HttpError(400, m('settings.badResolution'));
        if (isRecording()) throw new HttpError(409, m('settings.resolutionWhileRecording'));
        db.settings.resolution = b.resolution;
      }
      if (b.guide !== undefined) {
        if (!GUIDES.includes(b.guide)) throw new HttpError(400, m('settings.badGuide'));
        db.settings.guide = b.guide; // 只影響預覽，錄影中也可以改
      }
      // 人像設定會改變錄到的畫面，跟解析度一樣錄影中不能改
      const portrait = (['facePriority', 'lockExposure'] as const).filter((k) => b[k] !== undefined);
      for (const k of portrait) {
        if (typeof b[k] !== 'boolean') throw new HttpError(400, m('settings.portraitBool'));
        if (isRecording()) throw new HttpError(409, m('settings.portraitWhileRecording'));
        db.settings[k] = b[k] === true;
      }
      if (b.resolution !== undefined || b.guide !== undefined || portrait.length) {
        for (const id of live.keys()) send(id, { type: 'config', ...currentSpec() });
      }
      // 介面語言：auto 時控制台跟著瀏覽器；伺服器沒有請求可以參考時（終端機、計時器）也用這個
      if (b.language !== undefined) {
        if (!LANG_SETTINGS.includes(b.language)) throw new HttpError(400, m('settings.badLanguage'));
        db.settings.language = b.language;
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
    match = /^\/api\/devices\/([\w-]+)\/remove$/.exec(p);
    if (match) {
      const d = db.devices.find((x) => x.id === match![1]);
      if (!d) throw new HttpError(404, m('device.notFound'));
      const active = activeFile(d.id);
      const l = live.get(d.id);
      if (active && l) throw new HttpError(409, m('device.removeWhileRecording'));
      // 錄影中斷線、一直沒連回來的手機（例如沒電了）也要能移除，不然整個控制台會一直停在錄影中
      if (active) {
        active.state = 'failed';
        setError(active, 'fileError.removed');
      }
      if (l) {
        sendTo(l.ws, { type: 'error', code: 'unpaired', message: m('device.removedByComputer', {}, l.lang) });
        l.ws.close(4001, 'removed');
      }
      db.devices = db.devices.filter((x) => x !== d);
      save();
      changed();
      return sendJson(res, 200, { ok: true });
    }
    match = /^\/api\/devices\/([\w-]+)\/zoom$/.exec(p);
    if (match) {
      const d = db.devices.find((x) => x.id === match![1]);
      if (!d) throw new HttpError(404, m('device.notFound'));
      const b = await readJson<{ ratio?: number }>(req);
      if (typeof b.ratio !== 'number' || !(b.ratio > 0 && b.ratio <= 100)) throw new HttpError(400, m('device.badZoom'));
      // 手機會自己限制在它能用的範圍內，再回報實際的倍率
      d.zoom = Math.round(b.ratio * 100) / 100;
      send(d.id, { type: 'zoom', ratio: d.zoom });
      save();
      changed();
      return sendJson(res, 200, { ok: true });
    }
    match = /^\/api\/takes\/([\w-]+)\/mark$/.exec(p);
    if (match) {
      const b = await readJson<{ marked?: boolean }>(req);
      const files = db.files.filter((f) => f.takeId === match![1]);
      if (!files.length) throw new HttpError(404, m('take.notFound'));
      for (const f of files) f.marked = b.marked === true;
      save();
      changed();
      return sendJson(res, 200, { ok: true });
    }
    match = /^\/api\/takes\/([\w-]+)\/trim$/.exec(p);
    if (match) {
      const b = await readJson<{ fileId?: unknown; start?: unknown; end?: unknown }>(req);
      return sendJson(res, 200, await trimTake(match[1], b));
    }
    if (p === '/api/files/trash') {
      const b = await readJson<{ fileIds?: unknown }>(req);
      return sendJson(res, 200, await trashFiles(b.fileIds));
    }
    match = /^\/api\/devices\/([\w-]+)\/rename$/.exec(p);
    if (match) {
      const d = db.devices.find((x) => x.id === match![1]);
      if (!d) throw new HttpError(404, m('device.notFound'));
      const b = await readJson<{ name?: string }>(req);
      const name = (b.name ?? '').trim();
      if (!name || name.length > 40) throw new HttpError(400, m('device.nameLength'));
      d.name = name;
      send(d.id, { type: 'rename', name });
      save();
      changed();
      return sendJson(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, m('http.notFound'));
}

async function upload(req: IncomingMessage, res: ServerResponse, fileId: string, action: string | undefined, url: URL): Promise<void> {
  const f = db.files.find((x) => x.id === fileId);
  if (!f) throw new HttpError(404, m('upload.fileNotFound'));
  const d = db.devices.find((x) => x.id === f.deviceId);
  if (!d || req.headers['x-device-token'] !== d.token) throw new HttpError(401, m('upload.auth'));

  if (action === '/verify' && req.method === 'POST') {
    if (f.state === 'ready') return sendJson(res, 200, { ok: true });
    const result = await verify(f, await readJson<VerifyRequest>(req));
    if (result.ok) {
      f.state = 'ready';
      clearError(f);
      save();
      changed();
    }
    return sendJson(res, 200, result);
  }
  if (f.state === 'ready') throw new HttpError(409, m('upload.done'));
  if (!action && req.method === 'GET') return sendJson(res, 200, { receivedBytes: receivedBytes(f) });
  if (!action && req.method === 'PUT') {
    const offset = Number(url.searchParams.get('offset'));
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, m('upload.badOffset'));
    const n = await writeChunk(f, offset, req);
    changed();
    return sendJson(res, 200, { receivedBytes: n });
  }
  if (action === '/finish' && req.method === 'POST') {
    const b = await readJson<FinishRequest>(req);
    if (!Number.isSafeInteger(b.size) || b.size < 0) throw new HttpError(400, m('upload.badSize'));
    finish(f, b.size);
    f.durationMs = b.durationMs;
    f.state = 'finishing';
    save();
    changed();
    return sendJson(res, 200, { ok: true });
  }
  throw new HttpError(405, m('http.unsupported'));
}

const requestLang = (req: IncomingMessage): Lang =>
  parseLang(req.headers['x-lang']) ?? parseLang(req.headers['accept-language']) ?? defaultLang();

const server = http.createServer((req, res) => {
  withLang(requestLang(req), () => route(req, res)).catch((e: unknown) => {
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
    deviceWss.handleUpgrade(req, socket, head, (ws) => onDeviceConnection(ws, url.searchParams.get('token'), requestLang(req)));
  } else if (url.pathname === '/ws/ui' && isLoopback(req)) {
    uiWss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      uiClients.set(ws, new Set());
      uiLangs.set(ws, parseLang(url.searchParams.get('lang') ?? undefined) ?? requestLang(req));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as { type?: string; deviceIds?: unknown; lang?: string };
          if (msg.type === 'lang') {
            uiLangs.set(ws, parseLang(msg.lang) ?? defaultLang());
            ws.send(stateMessage(uiLangs.get(ws)!));
            return;
          }
          if (msg.type !== 'watch' || !Array.isArray(msg.deviceIds)) return;
          uiClients.set(ws, new Set(msg.deviceIds.filter((x): x is string => typeof x === 'string')));
          updatePreviewRequests();
        } catch {
          // 看不懂的訊息就不理
        }
      });
      ws.on('close', () => {
        uiClients.delete(ws);
        uiLangs.delete(ws);
        updatePreviewRequests();
      });
      ws.send(stateMessage(uiLangs.get(ws)!));
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
      setError(f, 'fileError.noStart');
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
      setError(f, 'fileError.lost');
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
  console.error(e.code === 'EADDRINUSE' ? m('log.portInUse', { port: PORT }) : e.message);
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
  console.log(m('log.dashboard', { url: `http://localhost:${PORT}` }));
  console.log(ip ? m('log.phones', { url: `http://${ip}:${PORT}` }) : m('log.noIp'));
  console.log(m('log.folder', { dir: db.settings.storageDir }));
});
