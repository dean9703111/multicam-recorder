import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import { HttpError, isLoopback, readJson, sendFile, sendJson } from './http.ts';
import type {
  DeviceMessage,
  DeviceStatus,
  FinishRequest,
  PairRequest,
  PairResponse,
  QrPayload,
  RecordingSpec,
  Resolution,
  ServerMessage,
  VerifyRequest,
} from './protocol.ts';
import { checkDir, db, DEFAULT_STORAGE_DIR, save, saveNow, storageInfo, type Device, type FileEntry, type StorageInfo } from './store.ts';
import { finalPath, finish, receivedBytes, verify, writeChunk } from './uploads.ts';

const PORT = Number(process.env.PORT ?? 8787);
// 測試時可以用環境變數縮短
const MAX_DURATION_SEC = Number(process.env.RECORDER_MAX_SEC ?? 30 * 60);
const WARN_BEFORE_SEC = Number(process.env.RECORDER_WARN_SEC ?? 3 * 60);
const START_DELAY_MS = 800; // 先把指令送到每台手機，大家在同一個時間點開始
const START_TIMEOUT_MS = 10_000;
const BITRATE: Record<Resolution, number> = { '2160p': 40_000_000, '1080p': 16_000_000, '720p': 8_000_000 };
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
  const l: Live = { ws, status: {}, alive: true };
  live.set(d.id, l);
  ws.on('pong', () => {
    l.alive = true;
  });
  ws.on('message', (raw) => {
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
      if (m.model && m.model !== d.model) {
        d.model = m.model;
        save();
      }
      send(d.id, { type: 'welcome', name: d.name, serverTime: Date.now(), spec: currentSpec() });
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
        save();
      }
      break;
    case 'recordingStopped':
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

function startRecording(deviceIds?: string[]): { skipped: string[] } {
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
    const dir = db.settings.storageDir;
    const f: FileEntry = {
      id: crypto.randomUUID(),
      takeId,
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
  const resolution = db.settings.resolution;
  return { resolution, fps: 30, bitrate: BITRATE[resolution], maxDurationSec: MAX_DURATION_SEC, warnBeforeSec: WARN_BEFORE_SEC };
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

const fileSafe = (name: string): string => name.replace(/[/\\:*?"<>|\s]+/g, '') || 'phone';

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

// Mac 在區網的 IP。優先用實體網卡（en0 通常是 Wi-Fi），避開 VPN 的 utun。
function lanAddress(): string | undefined {
  const found: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) found.push({ name, address: a.address });
    }
  }
  return (found.find((a) => a.name.startsWith('en')) ?? found[0])?.address;
}

// 有效期間內重開配對畫面會沿用同一個 QR Code，兩支手機掃同一個就好。
// QR Code 是網址：用手機相機掃，會打開下面 pairPage 的網頁；用 App 內的掃描則直接讀網址裡的配對碼。
async function createPairing(renew: boolean): Promise<{ qr: string; link: string; payload: QrPayload; expiresAt: number }> {
  const address = lanAddress();
  if (!address) throw new HttpError(500, '找不到 Mac 的區域網路 IP，請確認 Mac 已連上 Wi-Fi');
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

// 用手機相機掃 QR Code 後打開的網頁。按鈕會用 multicam://pair 打開 App，並把 Mac 位址和配對碼交給它。
function pairPage(req: IncomingMessage, res: ServerResponse, code: string | null): void {
  const valid = !!pairing && code === pairing.token && Date.now() < pairing.expiresAt;
  const host = /^[\w.-]+(:\d+)?$/.test(req.headers.host ?? '') ? req.headers.host : `${lanAddress()}:${PORT}`;
  const intent =
    `intent://pair?server=${encodeURIComponent(`http://${host}`)}&code=${encodeURIComponent(code ?? '')}` +
    '#Intent;scheme=multicam;package=dev.multicam.recorder;end';
  const body = valid
    ? `<h1>配對這支手機</h1>
       <p>按下按鈕會打開「多機錄影」App，並自動完成配對。</p>
       <a class="btn" href="${escapeHtml(intent)}">打開 App 並配對</a>
       <p class="note">按了沒反應的話，請確認這支手機已經安裝「多機錄影」App。</p>`
    : `<h1>QR Code 已失效</h1>
       <p>請在 Mac 上按「配對手機」，再掃一次新的 QR Code。</p>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>配對多機錄影</title>
<style>
  body { margin: 0; padding: 40px 20px; background: #0a0b0d; color: #ece8e1; font: 17px/1.6 system-ui, sans-serif; }
  h1 { font-size: 26px; margin: 0 0 12px; }
  p { color: #b9bdc4; }
  .btn { display: block; margin: 28px 0; padding: 16px; border-radius: 6px; background: #ff3b3b; color: #fff;
         font-size: 19px; font-weight: 700; text-align: center; text-decoration: none; }
  .note { font-size: 14px; color: #8b919a; }
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

const uiClients = new Set<WebSocket>();
let broadcastTimer: NodeJS.Timeout | undefined;

function changed(): void {
  broadcastTimer ??= setTimeout(() => {
    broadcastTimer = undefined;
    if (!uiClients.size) return;
    const msg = JSON.stringify(snapshot());
    for (const c of uiClients) c.send(msg);
  }, 250);
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
  return {
    type: 'state',
    serverTime: Date.now(),
    settings: db.settings,
    storage: currentStorage(),
    limits: { maxDurationSec: MAX_DURATION_SEC, warnBeforeSec: WARN_BEFORE_SEC },
    recordingBitrate: BITRATE[db.settings.resolution], // 網頁用來估算手機還能錄多久
    devices: db.devices.map((d) => ({
      id: d.id,
      name: d.name,
      model: d.model,
      online: live.has(d.id),
      status: live.get(d.id)?.status ?? {},
    })),
    files: db.files.map((f) => ({ ...f, receivedBytes: f.state === 'ready' ? f.size : receivedBytes(f) })),
  };
}

// ---------- 選擇資料夾 ----------

// 瀏覽器拿不到資料夾的完整路徑，所以由 Mac 這邊跳出系統的「選擇檔案夾」視窗。
// 控制台只能在 Mac 本機開，視窗一定出現在使用者面前。
let choosing = false;

async function chooseFolder(): Promise<{ path?: string; canceled?: boolean }> {
  if (choosing) throw new HttpError(409, '選擇資料夾的視窗已經開著了');
  const current = db.settings.storageDir;
  const start = fs.existsSync(current) ? current : '/Volumes';
  const quoted = `"${start.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const script = [
    'activate',
    `set f to choose folder with prompt "選擇錄影資料夾（建議選外接 SSD）" default location (POSIX file ${quoted})`,
    'POSIX path of f',
  ];
  choosing = true;
  try {
    return await new Promise((resolve, reject) => {
      execFile('osascript', script.flatMap((line) => ['-e', line]), { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
        if (!err) return resolve({ path: stdout.trim().replace(/(.)\/$/, '$1') });
        if (/-128/.test(stderr)) return resolve({ canceled: true }); // 使用者按了取消
        reject(new HttpError(500, `打不開選擇資料夾的視窗：${stderr.trim() || err.message}`));
      });
    });
  } finally {
    choosing = false;
  }
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

  // 其他都只允許 Mac 本機
  if (!isLoopback(req)) throw new HttpError(403, '只能在 Mac 本機操作');

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
    if (p === '/api/pairing') {
      const b = await readJson<{ renew?: boolean }>(req);
      return sendJson(res, 200, await createPairing(b.renew === true));
    }
    if (p === '/api/settings') {
      const b = await readJson<{ resolution?: Resolution; storageDir?: string }>(req);
      if (b.resolution !== undefined) {
        if (!(b.resolution in BITRATE)) throw new HttpError(400, '不支援這個解析度');
        if (db.files.some((f) => f.state === 'starting' || f.state === 'recording')) {
          throw new HttpError(409, '錄影中不能改解析度，停止後再調整');
        }
        db.settings.resolution = b.resolution;
        for (const id of live.keys()) send(id, { type: 'config', ...currentSpec() });
      }
      if (b.storageDir !== undefined) {
        const dir = path.resolve(b.storageDir.trim().replace(/^~(?=$|\/)/, os.homedir()));
        const error = checkDir(dir);
        if (error) throw new HttpError(400, error);
        db.settings.storageDir = dir;
      }
      save();
      changed();
      return sendJson(res, 200, { ok: true });
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

const deviceWss = new WebSocketServer({ noServer: true });
const uiWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/ws/device') {
    deviceWss.handleUpgrade(req, socket, head, (ws) => onDeviceConnection(ws, url.searchParams.get('token')));
  } else if (url.pathname === '/ws/ui' && isLoopback(req)) {
    uiWss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      uiClients.add(ws);
      ws.on('close', () => uiClients.delete(ws));
      ws.send(JSON.stringify(snapshot()));
    });
  } else {
    socket.destroy();
  }
});

// ---------- 定時檢查 ----------

const stopSent = new Set<string>();
let tick = 0;

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
  }
  if (++tick % 5 === 0) changed(); // 剩餘空間等資訊定期更新
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

// 預設的錄影資料夾由我們自己建立；使用者指定的資料夾則必須已經存在
if (db.settings.storageDir === DEFAULT_STORAGE_DIR) fs.mkdirSync(DEFAULT_STORAGE_DIR, { recursive: true });

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanAddress();
  console.log(`控制台：http://localhost:${PORT}`);
  console.log(ip ? `手機連線位址：http://${ip}:${PORT}` : '找不到區域網路 IP，手機會連不到');
  console.log(`錄影資料夾：${db.settings.storageDir}`);
});
