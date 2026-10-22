// 端對端測試：開一個伺服器和兩支模擬手機（一支橫拿、一支直拿），把整個流程跑一遍。CI 在 Windows、macOS、Linux 上都會跑。
// 會用到 ffmpeg（模擬手機錄影用）。測試資料放在暫存資料夾，跑完就清掉；只有被移到垃圾桶的兩支小影片會留在系統的垃圾桶裡。
//
// 用法：node tools/smoke-test.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-smoke-'));
const dataDir = path.join(tmp, 'data');
const recDir = path.join(tmp, '錄影資料夾'); // 中文路徑：Windows 上也要能用
const PROJECT = '測試專案';
// 一支橫拿、一支直拿一起錄，例如同時錄長影片和短影音
const PHONES = [
  { model: 'Smoke Phone', orientation: 'landscape' },
  { model: 'Smoke Portrait', orientation: 'portrait' },
];
const slugOf = (model: string) => model.replace(/\W+/g, '-').toLowerCase(); // 和 fake-phone.ts 存檔的資料夾名稱一樣
const logs: string[] = [];
const children: ChildProcess[] = [];

// ---------- 小工具 ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function step(name: string): void {
  console.log(`✓ ${name}`);
}

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`等不到：${what}`);
    await sleep(300);
  }
}

async function api<T = any>(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}, base = BASE): Promise<{ status: number; data: T }> {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

async function ok<T = any>(method: string, urlPath: string, body?: unknown, base = BASE): Promise<T> {
  const r = await api<T>(method, urlPath, body, {}, base);
  assert(r.status === 200, `${method} ${urlPath} 應該成功，結果是 HTTP ${r.status}：${JSON.stringify(r.data)}`);
  return r.data;
}

const state = (base = BASE) => ok('GET', '/api/state', undefined, base);

// fetch 不能改 Host，測 DNS rebinding 時用 http.request
function rawGet(urlPath: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: urlPath, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

// 控制台的 WebSocket 能不能連上
function wsOpens(url: string, origin?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.once('open', () => {
      ws.close();
      resolve(true);
    });
    ws.once('error', () => resolve(false));
  });
}

function start(name: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (d) => logs.push(`[${name}] ${String(d).trimEnd()}`));
  children.push(child);
  return child;
}

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// JPEG 的寬高記在 SOF 區段
function jpegSize(jpeg: Buffer): { width: number; height: number } {
  for (let i = 2; i + 9 < jpeg.length; i += 2 + jpeg.readUInt16BE(i + 2)) {
    const marker = jpeg[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) return { width: jpeg.readUInt16BE(i + 7), height: jpeg.readUInt16BE(i + 5) };
  }
  throw new Error('JPEG 裡找不到寬高');
}

// 被移到垃圾桶的檔案找不找得到。macOS 的垃圾桶有隱私保護，讀不到時回傳 undefined。
function inTrash(name: string, size: number): boolean | undefined {
  if (process.platform === 'linux') return fs.existsSync(path.join(os.homedir(), '.local/share/Trash/files', name));
  if (process.platform === 'win32') {
    const bin = path.join(path.parse(tmp).root, '$Recycle.Bin');
    const script = `Get-ChildItem -LiteralPath '${bin}' -Force -Recurse -File -Filter '$R*' -ErrorAction SilentlyContinue | Where-Object { $_.Length -eq ${size} } | Select-Object -First 1 -ExpandProperty FullName`;
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim() !== '';
  }
  try {
    return fs.existsSync(path.join(os.homedir(), '.Trash', name));
  } catch {
    return undefined;
  }
}

// ---------- 測試 ----------

async function main(): Promise<void> {
  fs.mkdirSync(recDir, { recursive: true });
  start('server', ['server/server.ts'], { PORT: String(PORT), RECORDER_DATA_DIR: dataDir, RECORDER_MAX_SEC: '120' });
  await waitFor('伺服器啟動', () => api('GET', '/api/state').then((r) => r.status === 200).catch(() => false), 20_000);
  step(`伺服器在 ${process.platform} 上啟動`);

  await ok('POST', '/api/settings', { storageDir: recDir, resolution: '720p' });
  let s = await state();
  assert(s.storage.available, `錄影資料夾不能用：${s.storage.error}`);
  assert(s.sep === path.sep, `路徑分隔符號應該是 ${path.sep}`);
  // Windows 的硬碟格式在背景查，下一次更新才會有
  const format = await waitFor('硬碟格式', async () => (await state()).storage.format as string | undefined, 20_000);
  // 單段上限：10～90 之間的整數分鐘，其他的擋下
  for (const bad of [9, 91, 30.5, '30']) assert((await api('POST', '/api/settings', { maxMinutes: bad })).status === 400, `單段上限 ${JSON.stringify(bad)} 應該被擋下`);
  await ok('POST', '/api/settings', { maxMinutes: 45 });
  assert((await state()).settings.maxMinutes === 45, '單段上限應該存成 45 分鐘');
  step(`設定錄影資料夾（硬碟格式 ${format}，剩 ${Math.round(s.storage.freeBytes / 1e9)} GB）和單段上限`);

  for (const bad of ['CON', 'lpt1.mp4', '結尾句點.', 'a/b']) {
    assert((await api('POST', '/api/projects', { name: bad })).status === 400, `專案名稱「${bad}」應該被擋下`);
  }
  const project = await ok('POST', '/api/projects', { name: PROJECT });
  const projectDir = path.join(recDir, PROJECT);
  assert(fs.statSync(projectDir).isDirectory(), '應該建立專案資料夾');
  assert((await api('POST', '/api/projects', { name: PROJECT })).status === 409, '同名專案應該被擋下');
  step('新增專案、擋下不合規的名稱');

  // 中英文：錯誤訊息跟著控制台送的 X-Lang，配對網頁跟著手機瀏覽器的 Accept-Language
  const en = await api('POST', '/api/projects', { name: 'CON' }, { 'X-Lang': 'en' });
  const zh = await api('POST', '/api/projects', { name: 'CON' }, { 'X-Lang': 'zh-TW' });
  assert(en.status === 400 && /reserved name/.test(en.data.error), `英文的錯誤訊息不對：${en.data.error}`);
  assert(zh.status === 400 && /保留的名稱/.test(zh.data.error), `中文的錯誤訊息不對：${zh.data.error}`);
  const { link } = await ok('POST', '/api/pairing', {});
  const pairPage = async (lang: string) =>
    (await fetch(String(link).replace(/^http:\/\/[^/]+/, BASE), { headers: { 'Accept-Language': lang } })).text();
  assert((await pairPage('en-US,en;q=0.9')).includes('Pair this phone'), '英文的手機應該看到英文的配對網頁');
  assert((await pairPage('zh-TW,zh;q=0.9,en;q=0.8')).includes('配對這支手機'), '中文的手機應該看到中文的配對網頁');
  const trashName = (await api('GET', '/api/state', undefined, { 'X-Lang': 'en' })).data.trashName;
  assert(trashName === 'Trash' || trashName === 'Recycle Bin', `英文的垃圾桶名稱不對：${trashName}`);
  assert((await api('POST', '/api/settings', { language: 'fr' })).status === 400, '不支援的語言應該被擋下');
  await ok('POST', '/api/settings', { language: 'en' });
  assert((await state()).settings.language === 'en', '介面語言應該存起來');
  await ok('POST', '/api/settings', { language: 'auto' });
  step('中英文：錯誤訊息、配對網頁、狀態裡的文字跟著語言，介面語言的設定存得起來');

  // 控制台只接受這台電腦上、控制台自己的網頁：同一個 Wi-Fi 的其他裝置、其他網頁的跨站請求、DNS rebinding 都要擋下
  const evil = 'http://evil.example';
  assert((await api('POST', '/api/settings', { language: 'en' }, { Origin: evil })).status === 403, '其他網站送來的請求應該被擋下');
  const plain = await fetch(BASE + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"language":"en"}' });
  assert(plain.status === 403, '不是 JSON 的請求應該被擋下（跨站請求不用 preflight 就能送 text/plain）');
  assert((await rawGet('/api/state', { Host: `evil.example:${PORT}` })) === 403, 'Host 不是本機的請求應該被擋下（DNS rebinding）');
  assert(!(await wsOpens(`ws://127.0.0.1:${PORT}/ws/ui`, evil)), '其他網站不能連控制台的 WebSocket');
  assert(await wsOpens(`ws://127.0.0.1:${PORT}/ws/ui`, BASE), '控制台自己的網頁要連得上 WebSocket');
  const lanUrl = (await ok('POST', '/api/pairing', {})).payload.url as string;
  assert((await api('GET', '/api/state', undefined, {}, lanUrl)).status === 403, '用區網位址連的請求應該被擋下');
  assert((await state()).settings.language === 'auto', '被擋下的請求不應該改到設定');
  step('擋下跨站請求、DNS rebinding、區網其他裝置的請求，控制台自己照常');

  // 靜態檔案都拿得到（控制台少一個檔案就整頁空白）
  for (const file of ['/', '/app.js', '/i18n.js', '/style.css', '/vendor/preact-htm.js']) {
    assert((await fetch(BASE + file)).status === 200, `${file} 應該拿得到`);
  }

  const phones = PHONES.map((p, i) =>
    start(`phone${i + 1}`, ['tools/fake-phone.ts', '--model', p.model, '--orientation', p.orientation, '--server', BASE, '--encoder', 'libx264'], {
      RECORDER_DATA_DIR: dataDir,
    }),
  );
  const devices = await waitFor('兩支模擬手機上線', async () => {
    const all = (await state()).devices;
    const found = PHONES.map((p) => all.find((d: any) => d.model === p.model && d.online && d.status.cameraReady && d.status.zoomRange));
    return found.every(Boolean) ? found : undefined;
  });
  for (const [i, d] of devices.entries()) {
    assert(d.features.includes('preview') && d.features.includes('zoom'), `${d.name} 應該回報支援即時畫面和變焦`);
    assert(d.status.orientation === PHONES[i].orientation, `${d.name} 應該回報 ${PHONES[i].orientation}，結果是 ${d.status.orientation}`);
    assert(d.camera?.facePriority && d.camera.lockExposure, `${d.name} 應該回報做得到臉部優先和鎖定曝光`);
  }
  step('兩支模擬手機配對並上線（一支橫拿、一支直拿）');

  // 即時畫面：用控制台的 WebSocket 訂閱兩支，應該各自收到轉正的 JPEG，直拿的是直的
  const ui = new WebSocket(`ws://127.0.0.1:${PORT}/ws/ui`);
  await new Promise((resolve, reject) => ui.once('open', resolve).once('error', reject));
  const frames = new Map<string, Buffer>();
  ui.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = data as Buffer;
    frames.set(buf.subarray(1, 1 + buf[0]).toString(), buf.subarray(1 + buf[0]));
  });
  ui.send(JSON.stringify({ type: 'watch', deviceIds: devices.map((d) => d.id) }));
  await waitFor('兩支手機的即時畫面', () => devices.every((d) => frames.has(d.id)));
  ui.close(); // 沒人看之後手機應該停止傳
  const sizes = devices.map((d, i) => {
    const jpeg = frames.get(d.id)!;
    assert(jpeg[0] === 0xff && jpeg[1] === 0xd8, `${d.name} 的即時畫面格式不對`);
    const { width, height } = jpegSize(jpeg);
    assert(height > width === (PHONES[i].orientation === 'portrait'), `${d.name} 的即時畫面方向不對（${width}×${height}）`);
    return `${width}×${height}`;
  });
  step(`收到兩支手機的即時畫面（${sizes.join('、')}）`);

  const [phone] = devices;
  await ok('POST', `/api/devices/${phone.id}/zoom`, { ratio: 2 });
  await waitFor('手機回報變焦 2×', async () => (await state()).devices.find((d: any) => d.id === phone.id)?.status.zoom === 2, 10_000);
  await ok('POST', `/api/devices/${phone.id}/zoom`, { ratio: 1 });
  step('調整變焦倍率');

  // 人像設定：臉部優先預設開、鎖定曝光預設關；打開鎖定曝光再錄，錄影中不能改
  s = await state();
  assert(s.settings.facePriority && !s.settings.lockExposure, '人像設定的預設應該是臉部優先開、鎖定曝光關');
  await ok('POST', '/api/settings', { lockExposure: true });

  // 兩支一起錄兩段，第二段緊接著開始（剛停止時不能被當成還在錄影）
  const takes: any[][] = [];
  for (const seconds of [3, 2]) {
    const done = new Set(takes.flat().map((f) => f.id));
    const r = await ok('POST', '/api/record/start', {});
    assert(r.skipped.length === 0, `開始錄影時被跳過：${r.skipped.join('、')}`);
    if (!takes.length) assert((await api('POST', '/api/settings', { lockExposure: false })).status === 409, '錄影中應該不能改人像設定');
    // 兩支都真的開始錄了才計時：ffmpeg 啟動要多久，每台機器不一樣
    await waitFor(
      '兩支手機開始錄影',
      async () => {
        const fresh = (await state()).files.filter((f: any) => !done.has(f.id));
        return fresh.length === devices.length && fresh.every((f: any) => f.state === 'recording');
      },
      20_000,
    );
    await sleep(seconds * 1000);
    await ok('POST', '/api/record/stop', {});
    const files = await waitFor(
      '兩支影片傳完並驗證',
      async () => {
        const fresh = (await state()).files.filter((f: any) => !done.has(f.id));
        const failed = fresh.find((f: any) => f.state === 'failed');
        if (failed) throw new Error(`${failed.name} 錄影失敗：${failed.error}`);
        return fresh.length === devices.length && fresh.every((f: any) => f.state === 'ready') ? fresh : undefined;
      },
      90_000,
    );
    takes.push(files);
  }
  for (const files of takes) {
    assert(new Set(files.map((f) => f.takeId)).size === 1, '同一次開始的影片應該屬於同一段');
    for (const [i, d] of devices.entries()) {
      const f = files.find((x) => x.deviceId === d.id);
      assert(f, `${d.name} 少了一支影片`);
      assert(f.orientation === PHONES[i].orientation, `${f.name} 應該記成 ${PHONES[i].orientation}，結果是 ${f.orientation}`);
      const local = path.join(dataDir, 'fake-phones', slugOf(PHONES[i].model), f.name);
      assert(sha256(path.join(projectDir, f.name)) === sha256(local), `${f.name} 和手機上的原檔不一樣`);
      assert(f.spec.facePriority && f.spec.lockExposure, `${f.name} 應該記著錄影時的人像設定`);
    }
  }
  step(`兩支一起錄兩段、傳到專案資料夾，和手機原檔的 SHA-256 一致，直式、橫式也記對了（共 ${takes.flat().length} 支），錄影中不能改人像設定`);

  await ok('POST', `/api/takes/${takes[0][0].takeId}/mark`, { marked: true });
  s = await state();
  assert(takes[0].every((t) => s.files.find((f: any) => f.id === t.id)?.marked), '第一段的兩支影片都應該被標記');
  step('標記第一段（兩支一起標）');

  // 裁剪：同一段的每台手機一起裁，另存成 _1、_2，原本的不動
  assert((await state()).ffmpeg, '伺服器應該找得到 ffmpeg');
  assert((await ok('POST', '/api/ffmpeg/check')).ffmpeg === true, '控制台按「重新檢查」時也要回報找得到 ffmpeg');
  const ref = takes[0][0];
  // 從手機真的開始錄才計時，錄到的長度應該接近按的時間
  const dur = ref.durationMs / 1000;
  assert(dur >= 2.3, `${ref.name} 太短（${dur} 秒），應該接近 3 秒`);
  assert((await api('POST', `/api/takes/${ref.takeId}/trim`, { fileId: ref.id, start: 0.2, end: 0.7 })).status === 400, '少於 1 秒的範圍應該被擋下');
  const ranges = [{ start: 0.1, end: dur }, { start: 0.1, end: 1.2 }];
  for (const [i, range] of ranges.entries()) {
    const n = i + 1;
    const r = await ok('POST', `/api/takes/${ref.takeId}/trim`, { fileId: ref.id, ...range });
    assert(r.files.length === devices.length, `應該裁出 ${devices.length} 支，結果是 ${r.files.length}：${r.skipped.join('、')}`);
    s = await state();
    const made = r.files.map((x: any) => s.files.find((f: any) => f.id === x.id));
    assert(new Set(made.map((f: any) => f.takeId)).size === 1 && made[0].takeId !== ref.takeId, '裁出來的影片應該是新的一段');
    for (const f of made) {
      const from = takes[0].find((x) => x.id === f.trimmedFrom);
      assert(from && f.name === from.name.replace(/\.mp4$/, `_${n}.mp4`), `檔名應該是原檔名加 _${n}，結果是 ${f.name}`);
      assert(f.state === 'ready' && fs.existsSync(path.join(projectDir, f.name)), `${f.name} 應該在專案資料夾裡`);
      // 串流複製從前一個關鍵影格開始，所以可能比要的長一點，但不會短；每台原片的長度不一定一樣
      const want = (Math.min(range.end, from.durationMs / 1000) - range.start) * 1000;
      assert(f.durationMs >= want - 150 && f.durationMs <= want + 3000, `${f.name} 長度不對：${f.durationMs} ms，應該約 ${Math.round(want)} ms`);
      assert(fs.existsSync(path.join(projectDir, from.name)), `原本的 ${from.name} 應該還在`);
      // 剪輯軟體用的拍攝時間和時間碼
      const tags = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=creation_time,timecode:stream_tags=timecode', '-of', 'json', path.join(projectDir, f.name)], { encoding: 'utf8' });
      assert(/creation_time/.test(tags) && /timecode/.test(tags), `${f.name} 應該帶著拍攝時間和時間碼：${tags}`);
    }
  }
  step(`裁剪：兩支一起裁、另存成 _1 和 _2，原檔不動，帶著拍攝時間和時間碼（原片 ${dur.toFixed(1)} 秒）`);

  // 播放：Range 請求（控制台的播放器拖進度要用）
  const media = takes[0][1];
  const head = await fetch(`${BASE}/media/${media.id}`, { headers: { Range: 'bytes=0-99' } });
  assert(head.status === 206 && head.headers.get('content-range') === `bytes 0-99/${media.size}`, `Range 請求應該回 206，結果是 ${head.status} ${head.headers.get('content-range')}`);
  assert((await head.arrayBuffer()).byteLength === 100, 'Range 請求應該只回 100 個位元組');
  assert((await fetch(`${BASE}/media/${media.id}`, { headers: { Range: `bytes=${media.size}-` } })).status === 416, '超出範圍的 Range 應該回 416');
  step('播放影片的 Range 請求');

  const trashed = takes[1];
  const r = await ok('POST', '/api/files/trash', { fileIds: trashed.map((f) => f.id) });
  assert(r.trashed === trashed.length, `應該移走 ${trashed.length} 支影片，結果是 ${r.trashed}`);
  s = await state();
  for (const f of trashed) {
    assert(!fs.existsSync(path.join(projectDir, f.name)), `${f.name} 應該不在專案資料夾了`);
    assert(!s.files.some((x: any) => x.id === f.id), `${f.name} 應該從清單上拿掉了`);
  }
  const found = trashed.map((f) => inTrash(f.name, f.size));
  const missing = trashed.filter((_, i) => found[i] === false).map((f) => f.name);
  assert(!missing.length, `在垃圾桶裡找不到 ${missing.join('、')}`);
  step(`把沒標記的第二段移到垃圾桶${found.includes(undefined) ? '（這台的垃圾桶有隱私保護，沒辦法確認裡面）' : '，在垃圾桶裡找得到'}`);

  const deleted = takes[0][0];
  fs.unlinkSync(path.join(projectDir, deleted.name));
  await waitFor('刪掉的檔案從清單拿掉', async () => !(await state()).files.some((f: any) => f.id === deleted.id), 15_000);
  step('直接刪掉的影片會從清單拿掉');

  await ok('POST', `/api/devices/${phone.id}/rename`, { name: '改名測試' });
  assert((await state()).devices.find((d: any) => d.id === phone.id)?.name === '改名測試', '名稱應該改好了');
  step('手機改名');

  // 壞掉的請求和訊息只影響它自己，伺服器不能停掉
  await new Promise<void>((resolve) => {
    const socket = net.connect(PORT, '127.0.0.1', () =>
      socket.end('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'),
    );
    socket.on('close', () => resolve()).on('error', () => resolve());
  });
  const creds = JSON.parse(fs.readFileSync(path.join(dataDir, 'fake-phones', slugOf(PHONES[1].model), `creds-${PORT}.json`), 'utf8'));
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws/device?token=${encodeURIComponent(creds.token)}`);
  await new Promise((resolve, reject) => bad.once('open', resolve).once('error', reject));
  for (const msg of ['null', '42', '{"type":"hello","lang":1,"model":5}', '{"type":"status","battery":"x","zoomRange":"y"}', '{"type":"recordingStarted","fileId":7}']) bad.send(msg);
  await sleep(500);
  bad.close();
  assert((await api('GET', '/api/state')).status === 200, '收到壞掉的請求和訊息後，伺服器應該還在');
  step('壞掉的請求和訊息不會讓伺服器停掉');

  for (const p of phones) p.kill();
  await waitFor('手機離線', async () => (await state()).devices.every((d: any) => !d.online), 15_000);
  for (const d of devices) await ok('POST', `/api/devices/${d.id}/remove`, {});
  assert((await state()).devices.length === 0, '手機應該都移除了');
  step('移除離線的手機');

  await ok('POST', '/api/projects/end', {});
  assert((await state()).project === null, '專案應該結束了');
  await ok('POST', `/api/projects/${project.id}/open`, {});
  assert((await state()).project?.id === project.id, '應該重新打開專案');
  step('結束專案、再打開');

  await resumeAfterRestart();
}

// 手機錄到一半斷線，久到電腦把它當成失聯；這段時間電腦端重開了一次。手機連回來後，影片要照樣傳完。
// 另開一個上限 4 秒的伺服器，手機也在 4 秒時自己停止（順便測到上限自動停止）。
async function resumeAfterRestart(): Promise<void> {
  const port = PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const data = path.join(tmp, 'data-restart');
  const rec = path.join(tmp, 'rec-restart');
  fs.mkdirSync(rec, { recursive: true });
  const env = { PORT: String(port), RECORDER_DATA_DIR: data, RECORDER_MAX_SEC: '4', RECORDER_LOST_GRACE_SEC: '2' };
  const up = () => waitFor('伺服器啟動', () => api('GET', '/api/state', undefined, {}, base).then((r) => r.status === 200).catch(() => false), 20_000);
  let server = start('server2', ['server/server.ts'], env);
  await up();
  await ok('POST', '/api/settings', { storageDir: rec, resolution: '720p' }, base);
  await ok('POST', '/api/projects', { name: 'restart' }, base);
  const model = 'Smoke Offline';
  // 這支手機回報只剩 1 MB：開始前要先問過，確認後才開始
  const phone = start(
    'phone3',
    ['tools/fake-phone.ts', '--model', model, '--server', base, '--encoder', 'libx264', '--offline-after', '800', '--offline-for', '15000', '--free-gb', '0.001'],
    { RECORDER_DATA_DIR: data },
  );
  await waitFor('斷線測試的手機上線', async () => (await state(base)).devices.some((d: any) => d.online && d.status.cameraReady && d.status.freeBytes != null));
  const ask = await api('POST', '/api/record/start', {}, {}, base);
  assert(ask.status === 409 && ask.data.confirm?.length === 1 && ask.data.confirm[0].includes('SmokeOffline'), `空間不夠時應該先問：${JSON.stringify(ask.data)}`);
  await ok('POST', '/api/record/start', { force: true }, base);
  const lost = await waitFor(
    '電腦把斷線的手機當成失聯',
    async () => (await state(base)).files.find((f: any) => f.state === 'failed'),
    30_000,
  );

  server.kill();
  await new Promise((resolve) => server.once('exit', resolve));
  server = start('server2', ['server/server.ts'], env);
  await up();
  assert((await state(base)).files.some((f: any) => f.id === lost.id), '重開之後還要記得等著補傳的影片');

  const done = await waitFor(
    '手機連回來把影片傳完',
    async () => {
      const f = (await state(base)).files.find((x: any) => x.id === lost.id);
      return f?.state === 'ready' ? f : undefined;
    },
    60_000,
  );
  const local = path.join(data, 'fake-phones', slugOf(model), done.name);
  assert(sha256(path.join(rec, 'restart', done.name)) === sha256(local), `${done.name} 和手機上的原檔不一樣`);
  assert(done.stopReason === 'maxDuration', `應該記成到上限自動停止，結果是 ${done.stopReason}`);
  phone.kill();
  server.kill();
  step('手機錄到一半斷線、電腦端又重開了一次，手機連回來後影片照樣傳完，也記得是到上限自動停止');
}

let failed = false;
try {
  await main();
  console.log('\n全部通過');
} catch (e) {
  failed = true;
  console.error(`\n✗ ${(e as Error).message}\n\n---- 伺服器與模擬手機的輸出 ----\n${logs.join('\n')}`);
} finally {
  for (const c of children) c.kill();
  await sleep(500);
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows 上 ffmpeg 可能還沒放開檔案，暫存資料夾留著也無妨
  }
}
process.exit(failed ? 1 : 0);
