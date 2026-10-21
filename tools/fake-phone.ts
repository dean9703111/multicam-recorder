// 模擬一支手機，在沒有實機的情況下測試電腦端：配對 → 連線 → 收到指令就用 ffmpeg
// 產生測試影片（漸層動畫加嗶聲），並照 server/protocol.ts 的流程邊錄邊傳、停止後驗證。
//
// 用法：node tools/fake-phone.ts --model "Pixel 11 Pro" [--tone 660] [--mic "手機內建"] [--server http://127.0.0.1:8787]
//                              [--encoder libx264]（預設 macOS 用硬體編碼 h264_videotoolbox，其他系統用 libx264）
//                              [--orientation portrait]（模擬直拿的手機，預設是橫拿）
//                              [--bokeh-max 1920x1080]（模擬做得到背景虛化的手機，這是虛化能錄的最大解析度）

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import {
  CHUNK_SIZE,
  type DeviceMessage,
  type Orientation,
  type PairResponse,
  type QrPayload,
  type RecordingSpec,
  type Resolution,
  type ServerMessage,
  type StopReason,
  type VerifyResponse,
} from '../server/protocol.ts';

const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: 'Pixel 11 Pro' },
    tone: { type: 'string', default: '440' },
    mic: { type: 'string', default: '模擬麥克風' }, // 回報給電腦的收音來源
    server: { type: 'string', default: 'http://127.0.0.1:8787' },
    encoder: { type: 'string', default: process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264' },
    orientation: { type: 'string', default: 'landscape' },
    'bokeh-max': { type: 'string' },
  },
});

if (args.orientation !== 'portrait' && args.orientation !== 'landscape') throw new Error('--orientation 只能是 portrait 或 landscape');
const orientation = args.orientation as Orientation;
const portrait = orientation === 'portrait';
// 沒給就是做不到背景虛化
const bokehMax = args['bokeh-max'] ? (args['bokeh-max'].split('x').map(Number) as [number, number]) : null;
if (bokehMax && !(bokehMax.length === 2 && bokehMax.every((n) => n > 0))) throw new Error('--bokeh-max 要寫成 1920x1080');

const model = args.model;
const slug = model.replace(/\W+/g, '-').toLowerCase();
const dataDir = process.env.RECORDER_DATA_DIR ?? path.join(import.meta.dirname, '../data');
const home = path.resolve(dataDir, 'fake-phones', slug);
// 依伺服器的埠號分開存，同時開好幾個伺服器測試時才不會連錯
const credsFile = path.join(home, `creds-${new URL(args.server).port || '80'}.json`);
const SIZE: Record<Resolution, string> = { '2160p': '3840x2160', '1440p': '2560x1440', '1080p': '1920x1080', '720p': '1280x720' };
const PIECE = 4 * 1024 * 1024; // 每次 PUT 的大小
const ZOOM_RANGE: [number, number] = [1, 4]; // 模擬的變焦只能放大（從畫面中間裁切）
const BOKEH_ZOOM_RANGE: [number, number] = [1, 3]; // 背景虛化時範圍比較小，和 Pixel 11 Pro 一樣
const TAIL_GUARD = 256 * 1024; // 錄影中最後這段可能還在寫入，先不傳

const log = (...a: unknown[]) => console.log(`[${model}]`, ...a);
fs.mkdirSync(home, { recursive: true });

// ---------- 配對 ----------

interface Creds {
  deviceId: string;
  token: string;
  url: string;
}

async function pair(): Promise<Creds> {
  // 真的手機是掃 QR Code；模擬器在電腦本機，直接跟伺服器要 QR Code 的內容
  const r = await fetch(`${args.server}/api/pairing`, { method: 'POST' });
  if (!r.ok) throw new Error(`拿不到配對碼：HTTP ${r.status}`);
  const { payload } = (await r.json()) as { payload: QrPayload };
  const deviceId = crypto.randomUUID();
  const res = await fetch(`${payload.url}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pair: payload.pair, deviceId, model }),
  });
  if (!res.ok) throw new Error(`配對失敗：HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as PairResponse;
  const creds = { deviceId, token: body.deviceToken, url: payload.url };
  fs.writeFileSync(credsFile, JSON.stringify(creds, null, 2));
  log(`配對完成，名稱：${body.name}`);
  return creds;
}

let creds: Creds = fs.existsSync(credsFile) ? JSON.parse(fs.readFileSync(credsFile, 'utf8')) : await pair();
const auth = () => ({ 'X-Device-Token': creds.token });

// ---------- WebSocket（斷線時訊息先排隊，連回來再送） ----------

let ws: WebSocket | undefined;
const outbox: DeviceMessage[] = [];
let clockOffset = 0; // 電腦時間 - 本機時間
let bestRtt = Infinity;
const serverNow = () => Date.now() + clockOffset;

function sendMsg(m: DeviceMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  else if (m.type !== 'status' && m.type !== 'sync') outbox.push(m);
}

function connect(): void {
  const url = creds.url.replace(/^http/, 'ws') + `/ws/device?token=${encodeURIComponent(creds.token)}`;
  const socket = new WebSocket(url);
  ws = socket;
  socket.on('open', () => {
    log('已連線');
    const camera = { facePriority: true, bokehMax, lockExposure: true };
    socket.send(JSON.stringify({ type: 'hello', model, appVersion: 'fake-1', features: ['preview', 'zoom'], camera } satisfies DeviceMessage));
    for (const m of outbox.splice(0)) socket.send(JSON.stringify(m));
    bestRtt = Infinity;
    for (let i = 0; i < 5; i++) setTimeout(() => sendMsg({ type: 'sync', t0: Date.now() }), i * 200);
    sendStatus();
  });
  socket.on('message', (raw) => onMessage(JSON.parse(String(raw)) as ServerMessage));
  socket.on('close', async (code) => {
    ws = undefined;
    setPreview(false);
    if (code === 4001) {
      log('電腦說這支手機沒有配對，重新配對');
      try {
        creds = await pair();
      } catch (e) {
        log((e as Error).message);
      }
    }
    setTimeout(connect, 2000);
  });
  socket.on('error', () => {});
}

function onMessage(m: ServerMessage): void {
  switch (m.type) {
    case 'sync': {
      // 取來回時間最短的那次估算時差
      const t2 = Date.now();
      const rtt = t2 - m.t0;
      if (rtt < bestRtt) {
        bestRtt = rtt;
        clockOffset = m.t1 - (m.t0 + t2) / 2;
      }
      break;
    }
    case 'start':
      startRecording(m);
      break;
    case 'stop':
      stopRecording(m.fileId);
      break;
    case 'welcome':
      applySpec(m.spec);
      setZoom(m.zoom);
      log(`電腦上的名稱：${m.name}`);
      break;
    case 'rename':
      log(`電腦上的名稱：${m.name}`);
      break;
    case 'zoom':
      setZoom(m.ratio);
      log(`變焦改成 ${zoomNow()}×`);
      break;
    case 'preview':
      setPreview(m.on);
      break;
    case 'config': {
      const onOff = (on: boolean) => (on ? '開' : '關');
      applySpec(m);
      log(
        `電腦的錄影設定改成 ${m.resolution}，輔助框 ${m.guide}，` +
          `臉部優先${onOff(m.facePriority)}、背景虛化${onOff(m.bokeh)}${m.bokeh && !bokehOn() ? '（這個解析度做不到）' : ''}、鎖定曝光${onOff(m.lockExposure)}`,
      );
      break;
    }
    case 'error':
      log(m.message);
      break;
  }
}

setInterval(() => sendMsg({ type: 'sync', t0: Date.now() }), 10_000);

// ---------- 狀態 ----------

let battery = 87;
let temperature = 33;

function sendStatus(): void {
  const used = jobs.reduce((n, j) => n + sizeOf(j.file), 0);
  sendMsg({
    type: 'status',
    battery: Math.round(battery),
    charging: false,
    temperatureC: temperature,
    freeBytes: 180e9 - used,
    cameraReady: true,
    recordingFileId: rec?.fileId ?? null,
    audioInput: args.mic,
    zoom: zoomNow(),
    zoomRange: zoomRange(),
    orientation,
    bokeh: bokehOn(),
  });
}

setInterval(() => {
  if (rec?.proc) {
    battery = Math.max(5, battery - 0.03);
    temperature = Math.min(45, temperature + 0.05);
  } else {
    temperature = Math.max(33, temperature - 0.1);
  }
  sendStatus();
}, 2000);

// ---------- 錄影（用 ffmpeg 模擬） ----------

interface Rec {
  fileId: string;
  file: string;
  timer?: NodeJS.Timeout;
  proc?: ChildProcess;
  startedLocal?: number;
  stopReason?: StopReason;
}

let rec: Rec | undefined;

// 測試畫面：流動的漸層上有一圈刻度，白點每 3 秒繞一圈，下方是音量表；聲音是每秒嗶一聲。
// 兩支模擬手機同時開始時，白點的位置和嗶聲都會對齊。顏色依手機名稱挑，方便分辨是哪一台。
// 先用 960×540（直拿是 540×960）畫再放大到要求的解析度，4K 也能即時產生。
const PALETTES = [
  { a: ['1c0a0a', 'd11f3a', 'ffb000', '1c0a0a'], b: ['ff4d8d', '1c0a0a'] }, // 紅橘
  { a: ['0a1030', '1d4ed8', '22d3ee', '0a1030'], b: ['8b5cf6', '0a1030'] }, // 藍紫
  { a: ['04140f', '0f766e', '3ddc84', '04140f'], b: ['a3e635', '04140f'] }, // 綠
  { a: ['140b24', '7c3aed', 'f472b6', '140b24'], b: ['fb923c', '140b24'] }, // 粉紫
];

// zoom 大於 1 時從畫面中間裁切再放大，模擬變焦；即時畫面不需要聲音
function testPattern(width: number, height: number, fps: number, withAudio = true): string[] {
  const nameSum = [...model].reduce((n, c) => n + c.codePointAt(0)!, 0);
  const { a, b } = PALETTES[nameSum % PALETTES.length];
  const colors = (list: string[]) => list.map((c, i) => `c${i}=0x${c}`).join(':');
  const R = 150; // 刻度圈的半徑
  const dist = (x: string, y: string) => `hypot(X-(${x}),Y-(${y}))`;
  // 12 個刻度點，3、6、9、12 點鐘的大一點
  const tick = 'round(atan2(Y-H/2,X-W/2)/(PI/6))';
  const tickDist = dist(`W/2+${R + 18}*cos(${tick}*PI/6)`, `H/2+${R + 18}*sin(${tick}*PI/6)`);
  const dial = [
    `110*exp(-pow(${dist('W/2', 'H/2')}-${R},2)/5)`, // 圈
    `230*clip(if(eq(mod(${tick},3),0),3.2,2.2)-${tickDist},0,1)`, // 刻度
    `230*clip(4-${dist('W/2', 'H/2')},0,1)`, // 圓心
  ].join('+');
  const dot = `255*clip(9.5-${dist('18', '18')},0,1)+110*exp(-pow(${dist('18', '18')},2)/50)`;
  const still = (size: string, alpha: string) =>
    `color=c=white@0:s=${size}:r=${fps}:d=${1 / fps},format=rgba,geq=r=255:g=255:b=255:a='min(255,${alpha})',loop=loop=-1:size=1`;
  const input = (graph: string) => ['-re', '-f', 'lavfi', '-i', graph];
  const base = portrait ? '540x960' : '960x540';
  return [
    ...input(`gradients=s=${base}:r=${fps}:n=4:${colors(a)}:seed=3:speed=0.012:type=linear`),
    ...input(`gradients=s=${base}:r=${fps}:n=2:${colors(b)}:seed=9:speed=0.02:type=radial`),
    ...input(`aevalsrc=exprs='0.12*sin(2*PI*${args.tone}*t)+0.4*lt(mod(t,1),0.1)*sin(2*PI*4*${args.tone}*t)':s=48000`),
    ...input(still(base, dial)),
    ...input(still('36x36', dot)),
    ...input(`color=c=black@0:s=${base}:r=${fps},format=rgba`),
    '-filter_complex',
    [
      // 背景虛化時只模糊背景的漸層，刻度和白點維持清楚
      `[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]blend=all_mode=screen,vignette=angle=PI/5,format=yuv420p${bokehOn() ? ',boxblur=12' : ''}[bg]`,
      // 白點畫在透明的一層上，lagfun 讓它拖出漸淡的尾巴；張數少的時候衰減快一點，尾巴才一樣長
      `[5:v][4:v]overlay=x='W/2+${R}*cos(2*PI*t/3-PI/2)-w/2':y='H/2+${R}*sin(2*PI*t/3-PI/2)-h/2':format=rgb,lagfun=decay=${(0.9 ** (30 / fps)).toFixed(3)}[dot]`,
      '[bg][3:v]overlay=format=auto[dial];[dial][dot]overlay=format=auto[pic]',
      withAudio ? '[2:a]asplit=2[a][meter]' : '[2:a]anull[meter]',
      `[meter]showvolume=r=${fps}:w=320:h=6:b=0:t=0:v=0:f=0.8:p=0.18:c=0xe6ffffff[vu]`,
      `[pic][vu]overlay=x=(W-w)/2:y=H/2+${R + 52}:format=auto,crop=iw/${zoomNow()}:ih/${zoomNow()},scale=${width}:${height}:flags=fast_bilinear,format=yuv420p[v]`,
    ].join(';'),
    ...['-map', '[v]', ...(withAudio ? ['-map', '[a]'] : [])],
  ];
}

// ---------- 變焦、人像設定與即時畫面 ----------

let requestedZoom = 1; // 電腦要求的倍率，實際用的是 zoomNow()
let spec: RecordingSpec | undefined; // 電腦最近送來的錄影設定
let preview: ChildProcess | undefined;

// 背景虛化有沒有套用：設定打開、這支做得到、解析度沒超過上限
function bokehOn(): boolean {
  if (!spec?.bokeh || !bokehMax) return false;
  const [width, height] = SIZE[spec.resolution].split('x').map(Number);
  return width <= bokehMax[0] && height <= bokehMax[1];
}

const zoomRange = (): [number, number] => (bokehOn() ? BOKEH_ZOOM_RANGE : ZOOM_RANGE);
// 超出範圍時取最接近的值；背景虛化關掉後回到原本要求的倍率
const zoomNow = (): number => Math.min(zoomRange()[1], Math.max(zoomRange()[0], requestedZoom));

// 變焦或背景虛化有變就回報，即時畫面重新開一次才會套用；錄影中的影片維持開始時的樣子
function changeView(change: () => void): void {
  const before = `${zoomNow()} ${bokehOn()}`;
  change();
  if (`${zoomNow()} ${bokehOn()}` === before) return;
  sendStatus();
  if (preview) {
    setPreview(false);
    setPreview(true);
  }
}

function setZoom(ratio: number): void {
  changeView(() => (requestedZoom = ratio || 1));
}

function applySpec(next: RecordingSpec): void {
  changeView(() => (spec = next));
}

// 每秒 5 張 640×360（直拿是 360×640）的 JPEG。ffmpeg 輸出的 JPEG 一張接一張，用結尾的 FF D9 切開。
function setPreview(on: boolean): void {
  if (!on) {
    preview?.kill();
    preview = undefined;
    return;
  }
  if (preview) return;
  const proc = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', ...testPattern(portrait ? 360 : 640, portrait ? 640 : 360, 5, false), '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe', '-'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  preview = proc;
  let pending = Buffer.alloc(0);
  proc.stdout!.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (let end = pending.indexOf(EOI); end >= 0; end = pending.indexOf(EOI)) {
      const frame = pending.subarray(0, end + 2);
      pending = pending.subarray(end + 2);
      // 網路塞住時丟掉，不要排隊
      if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(frame);
    }
  });
  proc.on('exit', () => {
    if (preview === proc) preview = undefined;
  });
}

const EOI = Buffer.from([0xff, 0xd9]);

function startRecording(m: Extract<ServerMessage, { type: 'start' }>): void {
  if (rec) {
    sendMsg({ type: 'recordingFailed', fileId: m.fileId, error: '這支手機已經在錄影' });
    return;
  }
  applySpec(m); // 開始的指令也帶著完整的錄影設定
  const r: Rec = { fileId: m.fileId, file: path.join(home, m.fileName) };
  rec = r;
  const delay = Math.max(0, m.startAt - serverNow());
  r.timer = setTimeout(() => {
    const [width, height] = SIZE[m.resolution].split('x').map(Number);
    // 真的手機直拿時照樣錄橫的畫面，在檔案裡記著播放時要轉 90°。ffmpeg 即時編碼時寫不了這個記號，所以模擬手機直接錄直的。
    const ffmpegArgs = [
      ...['-hide_banner', '-loglevel', 'error'],
      ...testPattern(portrait ? height : width, portrait ? width : height, m.fps),
      ...['-t', String(m.maxDurationSec)],
      // macOS 預設用硬體編碼比較省 CPU；CI 的虛擬機沒有硬體編碼，用 --encoder libx264
      ...['-c:v', args.encoder, ...(args.encoder === 'libx264' ? ['-preset', 'veryfast'] : [])],
      ...['-b:v', String(m.bitrate), '-c:a', 'aac', '-b:a', '128k'],
      ...['-y', r.file],
    ];
    const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    r.proc = proc;
    r.startedLocal = Date.now();
    let stderr = '';
    proc.stderr!.on('data', (d) => (stderr += d));
    proc.on('exit', (code) => onRecordingEnded(r, code, stderr));
    jobs.push({ fileId: r.fileId, file: r.file, sent: 0 });
    sendMsg({ type: 'recordingStarted', fileId: r.fileId, startedAt: Math.round(serverNow()), width, height, orientation });
    log(`開始錄影 ${m.fileName}（${m.resolution}，最長 ${m.maxDurationSec} 秒）`);
  }, delay);
}

function stopRecording(fileId: string): void {
  if (!rec || rec.fileId !== fileId) return;
  if (!rec.proc) {
    clearTimeout(rec.timer);
    sendMsg({ type: 'recordingFailed', fileId, error: '還沒開始就取消了' });
    rec = undefined;
    return;
  }
  rec.stopReason = 'user';
  rec.proc.stdin!.write('q'); // 讓 ffmpeg 正常收尾，MP4 才會完整
}

function onRecordingEnded(r: Rec, code: number | null, stderr: string): void {
  rec = undefined;
  sendStatus(); // 和真的 App 一樣，停止後馬上回報
  const job = jobs.find((j) => j.fileId === r.fileId);
  if (code !== 0 || !job) {
    sendMsg({ type: 'recordingFailed', fileId: r.fileId, error: `ffmpeg 結束代碼 ${code}：${stderr.trim()}` });
    return;
  }
  const size = sizeOf(r.file);
  const probed = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', r.file], { encoding: 'utf8' }));
  const durationMs = Number.isFinite(probed) ? Math.round(probed * 1000) : Date.now() - r.startedLocal!;
  const reason = r.stopReason ?? 'maxDuration';
  job.size = size;
  job.durationMs = durationMs;
  sendMsg({ type: 'recordingStopped', fileId: r.fileId, reason, durationMs, size });
  log(`停止錄影（${reason}），${(size / 1e6).toFixed(1)} MB`);
}

// ---------- 上傳 ----------

interface Job {
  fileId: string;
  file: string;
  sent: number;
  size?: number; // 錄完才知道
  durationMs?: number;
  retryAt?: number;
}

const jobs: Job[] = [];

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

async function readRange(file: string, start: number, length: number): Promise<Buffer<ArrayBuffer>> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

class UploadError extends Error {
  status: number;
  body: { receivedBytes?: number; error?: string };
  constructor(status: number, body: { receivedBytes?: number; error?: string }) {
    super(`HTTP ${status} ${body.error ?? ''}`);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(method: string, urlPath: string, body?: Buffer<ArrayBuffer> | object): Promise<T> {
  const bytes = Buffer.isBuffer(body) ? (body as Buffer<ArrayBuffer>) : undefined;
  const res = await fetch(`${creds.url}${urlPath}`, {
    method,
    headers: { ...auth(), 'Content-Type': bytes ? 'application/octet-stream' : 'application/json' },
    body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new UploadError(res.status, data);
  return data as T;
}

async function sendRange(job: Job, start: number, end: number): Promise<void> {
  for (let offset = start; offset < end; ) {
    const piece = await readRange(job.file, offset, Math.min(PIECE, end - offset));
    if (!piece.length) break;
    await call('PUT', `/api/upload/${job.fileId}?offset=${offset}`, piece);
    offset += piece.length;
    if (offset > job.sent) job.sent = offset;
  }
}

async function chunkHashes(file: string, size: number): Promise<string[]> {
  const hashes: string[] = [];
  for (let start = 0; start < size; start += CHUNK_SIZE) {
    const data = await readRange(file, start, Math.min(CHUNK_SIZE, size - start));
    hashes.push(crypto.createHash('sha256').update(data).digest('hex'));
  }
  return hashes;
}

async function step(job: Job): Promise<boolean> {
  const limit = job.size ?? Math.max(0, sizeOf(job.file) - TAIL_GUARD);
  if (job.sent < limit) await sendRange(job, job.sent, limit);
  if (job.size === undefined || job.sent < job.size) return false;

  // 錄完了：通知電腦開始算雜湊，自己也同時算，然後比對、補傳不一樣的分段
  await call('POST', `/api/upload/${job.fileId}/finish`, { size: job.size, durationMs: job.durationMs ?? 0 });
  const hashes = await chunkHashes(job.file, job.size);
  for (let round = 0; round < 3; round++) {
    const v = await call<VerifyResponse>('POST', `/api/upload/${job.fileId}/verify`, { chunkSize: CHUNK_SIZE, hashes });
    if (v.ok) {
      log(`已傳到電腦並驗證通過${round ? `（補傳 ${round} 次）` : ''}`);
      return true;
    }
    for (const i of v.resend) await sendRange(job, i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, job.size));
  }
  throw new Error('補傳三次還是對不上');
}

async function uploadLoop(): Promise<void> {
  for (;;) {
    for (const job of [...jobs]) {
      if (job.retryAt && Date.now() < job.retryAt) continue;
      try {
        if (await step(job)) jobs.splice(jobs.indexOf(job), 1);
        job.retryAt = undefined;
      } catch (e) {
        job.retryAt = Date.now() + 3000;
        if (e instanceof UploadError && e.status === 409 && e.body.receivedBytes !== undefined) {
          job.sent = e.body.receivedBytes; // 電腦收到的跟我們以為的不一樣，從電腦的進度接著傳
          job.retryAt = undefined;
        } else {
          log(`上傳暫停，3 秒後重試：${(e as Error).message}`);
          // 連不上之前那次 PUT 可能其實有寫進去，下次從電腦實際收到的位置繼續
          call<{ receivedBytes: number }>('GET', `/api/upload/${job.fileId}`)
            .then((r) => (job.sent = Math.min(r.receivedBytes, job.size ?? Infinity)))
            .catch(() => {});
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

connect();
void uploadLoop();

process.on('SIGINT', () => {
  preview?.kill();
  rec?.proc?.stdin?.write('q');
  setTimeout(() => process.exit(0), 300);
});
