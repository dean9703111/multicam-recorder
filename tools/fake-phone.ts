// 模擬一支手機，在沒有實機的情況下測試 Mac 端：配對 → 連線 → 收到指令就用 ffmpeg
// 產生測試影片（彩色測試畫面加嗶聲），並照 mac/protocol.ts 的流程邊錄邊傳、停止後驗證。
//
// 用法：node tools/fake-phone.ts --model "Pixel 11 Pro" [--tone 660] [--mic "手機內建"] [--server http://127.0.0.1:8787]

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import {
  CHUNK_SIZE,
  type DeviceMessage,
  type PairResponse,
  type QrPayload,
  type Resolution,
  type ServerMessage,
  type StopReason,
  type VerifyResponse,
} from '../mac/protocol.ts';

const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: 'Pixel 11 Pro' },
    tone: { type: 'string', default: '440' },
    mic: { type: 'string', default: '模擬麥克風' }, // 回報給 Mac 的收音來源
    server: { type: 'string', default: 'http://127.0.0.1:8787' },
  },
});

const model = args.model;
const slug = model.replace(/\W+/g, '-').toLowerCase();
const dataDir = process.env.RECORDER_DATA_DIR ?? path.join(import.meta.dirname, '../data');
const home = path.resolve(dataDir, 'fake-phones', slug);
// 依伺服器的埠號分開存，同時開好幾個伺服器測試時才不會連錯
const credsFile = path.join(home, `creds-${new URL(args.server).port || '80'}.json`);
const SIZE: Record<Resolution, string> = { '2160p': '3840x2160', '1080p': '1920x1080', '720p': '1280x720' };
const PIECE = 4 * 1024 * 1024; // 每次 PUT 的大小
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
  // 真的手機是掃 QR Code；模擬器在 Mac 本機，直接跟伺服器要 QR Code 的內容
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
let clockOffset = 0; // Mac 時間 - 本機時間
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
    socket.send(JSON.stringify({ type: 'hello', model, appVersion: 'fake-1' } satisfies DeviceMessage));
    for (const m of outbox.splice(0)) socket.send(JSON.stringify(m));
    bestRtt = Infinity;
    for (let i = 0; i < 5; i++) setTimeout(() => sendMsg({ type: 'sync', t0: Date.now() }), i * 200);
    sendStatus();
  });
  socket.on('message', (raw) => onMessage(JSON.parse(String(raw)) as ServerMessage));
  socket.on('close', async (code) => {
    ws = undefined;
    if (code === 4001) {
      log('Mac 說這支手機沒有配對，重新配對');
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
    case 'rename':
      log(`Mac 上的名稱：${m.name}`);
      break;
    case 'config':
      log(`Mac 的錄影設定改成 ${m.resolution}`);
      break;
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

function startRecording(m: Extract<ServerMessage, { type: 'start' }>): void {
  if (rec) {
    sendMsg({ type: 'recordingFailed', fileId: m.fileId, error: '這支手機已經在錄影' });
    return;
  }
  const r: Rec = { fileId: m.fileId, file: path.join(home, m.fileName) };
  rec = r;
  const delay = Math.max(0, m.startAt - serverNow());
  r.timer = setTimeout(() => {
    const ffmpegArgs = [
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-re', '-f', 'lavfi', '-i', `testsrc2=size=${SIZE[m.resolution]}:rate=${m.fps}`],
      ...['-re', '-f', 'lavfi', '-i', `sine=frequency=${args.tone}:sample_rate=48000:beep_factor=4`],
      ...['-t', String(m.maxDurationSec), '-vf', 'format=yuv420p'],
      ...['-c:v', 'h264_videotoolbox', '-b:v', String(m.bitrate), '-c:a', 'aac', '-b:a', '128k'],
      ...['-y', r.file],
    ];
    const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    r.proc = proc;
    r.startedLocal = Date.now();
    let stderr = '';
    proc.stderr!.on('data', (d) => (stderr += d));
    proc.on('exit', (code) => onRecordingEnded(r, code, stderr));
    jobs.push({ fileId: r.fileId, file: r.file, sent: 0 });
    sendMsg({ type: 'recordingStarted', fileId: r.fileId, startedAt: Math.round(serverNow()) });
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

  // 錄完了：通知 Mac 開始算雜湊，自己也同時算，然後比對、補傳不一樣的分段
  await call('POST', `/api/upload/${job.fileId}/finish`, { size: job.size, durationMs: job.durationMs ?? 0 });
  const hashes = await chunkHashes(job.file, job.size);
  for (let round = 0; round < 3; round++) {
    const v = await call<VerifyResponse>('POST', `/api/upload/${job.fileId}/verify`, { chunkSize: CHUNK_SIZE, hashes });
    if (v.ok) {
      log(`已傳到 Mac 並驗證通過${round ? `（補傳 ${round} 次）` : ''}`);
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
          job.sent = e.body.receivedBytes; // Mac 收到的跟我們以為的不一樣，從 Mac 的進度接著傳
          job.retryAt = undefined;
        } else {
          log(`上傳暫停，3 秒後重試：${(e as Error).message}`);
          // 連不上之前那次 PUT 可能其實有寫進去，下次從 Mac 實際收到的位置繼續
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
  rec?.proc?.stdin?.write('q');
  setTimeout(() => process.exit(0), 300);
});
