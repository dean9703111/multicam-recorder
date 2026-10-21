// 端對端測試：開一個伺服器和一支模擬手機，把整個流程跑一遍。CI 在 Windows、macOS、Linux 上都會跑。
// 會用到 ffmpeg（模擬手機錄影用）。測試資料放在暫存資料夾，跑完就清掉；只有被移到垃圾桶的一支小影片會留在系統的垃圾桶裡。
//
// 用法：node tools/smoke-test.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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

async function api<T = any>(method: string, urlPath: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

async function ok<T = any>(method: string, urlPath: string, body?: unknown): Promise<T> {
  const r = await api<T>(method, urlPath, body);
  assert(r.status === 200, `${method} ${urlPath} 應該成功，結果是 HTTP ${r.status}：${JSON.stringify(r.data)}`);
  return r.data;
}

const state = () => ok('GET', '/api/state');

function start(name: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (d) => logs.push(`[${name}] ${String(d).trimEnd()}`));
  children.push(child);
  return child;
}

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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
  step(`設定錄影資料夾（硬碟格式 ${format}，剩 ${Math.round(s.storage.freeBytes / 1e9)} GB）`);

  for (const bad of ['CON', 'lpt1.mp4', '結尾句點.', 'a/b']) {
    assert((await api('POST', '/api/projects', { name: bad })).status === 400, `專案名稱「${bad}」應該被擋下`);
  }
  const project = await ok('POST', '/api/projects', { name: PROJECT });
  const projectDir = path.join(recDir, PROJECT);
  assert(fs.statSync(projectDir).isDirectory(), '應該建立專案資料夾');
  assert((await api('POST', '/api/projects', { name: PROJECT })).status === 409, '同名專案應該被擋下');
  step('新增專案、擋下不合規的名稱');

  const phone = start('phone', ['tools/fake-phone.ts', '--model', 'Smoke Phone', '--server', BASE, '--encoder', 'libx264'], {
    RECORDER_DATA_DIR: dataDir,
  });
  const device = await waitFor('模擬手機上線', async () => {
    const d = (await state()).devices[0];
    return d?.online && d.status.cameraReady && d.status.zoomRange ? d : undefined;
  });
  assert(device.features.includes('preview') && device.features.includes('zoom'), '手機應該回報支援即時畫面和變焦');
  step('模擬手機配對並上線');

  // 即時畫面：用控制台的 WebSocket 訂閱，應該收到這支手機的 JPEG
  const ui = new WebSocket(`ws://127.0.0.1:${PORT}/ws/ui`);
  await new Promise((resolve, reject) => ui.once('open', resolve).once('error', reject));
  const frame = new Promise<Buffer>((resolve) =>
    ui.on('message', (data, isBinary) => {
      if (isBinary) resolve(data as Buffer);
    }),
  );
  ui.send(JSON.stringify({ type: 'watch', deviceIds: [device.id] }));
  const buf = await Promise.race([frame, sleep(30_000).then(() => undefined)]);
  assert(buf, '30 秒內沒收到即時畫面');
  const id = buf.subarray(1, 1 + buf[0]).toString();
  const jpeg = buf.subarray(1 + buf[0]);
  assert(id === device.id && jpeg[0] === 0xff && jpeg[1] === 0xd8, '即時畫面的格式不對');
  ui.close(); // 沒人看之後手機應該停止傳
  step(`收到即時畫面（${Math.round(jpeg.length / 1024)} KB 的 JPEG）`);

  await ok('POST', `/api/devices/${device.id}/zoom`, { ratio: 2 });
  await waitFor('手機回報變焦 2×', async () => (await state()).devices[0].status.zoom === 2, 10_000);
  await ok('POST', `/api/devices/${device.id}/zoom`, { ratio: 1 });
  step('調整變焦倍率');

  // 錄兩段，第二段緊接著開始（剛停止時不能被當成還在錄影）
  const takes: any[] = [];
  for (const seconds of [3, 2]) {
    const r = await ok('POST', '/api/record/start', {});
    assert(r.skipped.length === 0, `開始錄影時被跳過：${r.skipped.join('、')}`);
    await sleep(seconds * 1000 + 800);
    await ok('POST', '/api/record/stop', {});
    const file = await waitFor(
      '影片傳完並驗證',
      async () => (await state()).files.find((f: any) => f.state === 'ready' && !takes.some((t) => t.id === f.id)),
      90_000,
    );
    takes.push(file);
  }
  for (const f of takes) {
    const local = path.join(dataDir, 'fake-phones', 'smoke-phone', f.name);
    assert(sha256(path.join(projectDir, f.name)) === sha256(local), `${f.name} 和手機上的原檔不一樣`);
  }
  step(`錄兩段、傳到專案資料夾，和手機原檔的 SHA-256 一致（${takes.map((f) => f.name).join('、')}）`);

  await ok('POST', `/api/takes/${takes[0].takeId}/mark`, { marked: true });
  s = await state();
  assert(s.files.find((f: any) => f.id === takes[0].id)?.marked, '第一段應該被標記');
  step('標記第一段');

  const trashed = takes[1];
  const r = await ok('POST', '/api/files/trash', { fileIds: [trashed.id] });
  assert(r.trashed === 1, '應該移走 1 支影片');
  assert(!fs.existsSync(path.join(projectDir, trashed.name)), '影片應該不在專案資料夾了');
  assert(!(await state()).files.some((f: any) => f.id === trashed.id), '清單上應該拿掉了');
  const found = inTrash(trashed.name, trashed.size);
  assert(found !== false, `在垃圾桶裡找不到 ${trashed.name}`);
  step(`把沒標記的第二段移到垃圾桶${found === undefined ? '（這台的垃圾桶有隱私保護，沒辦法確認裡面）' : '，在垃圾桶裡找得到'}`);

  fs.unlinkSync(path.join(projectDir, takes[0].name));
  await waitFor('刪掉的檔案從清單拿掉', async () => !(await state()).files.some((f: any) => f.id === takes[0].id), 15_000);
  step('直接刪掉的影片會從清單拿掉');

  await ok('POST', `/api/devices/${device.id}/rename`, { name: '改名測試' });
  assert((await state()).devices[0].name === '改名測試', '名稱應該改好了');
  step('手機改名');

  phone.kill();
  await waitFor('手機離線', async () => !(await state()).devices[0]?.online, 15_000);
  await ok('POST', `/api/devices/${device.id}/remove`, {});
  assert((await state()).devices.length === 0, '手機應該移除了');
  step('移除離線的手機');

  await ok('POST', '/api/projects/end', {});
  assert((await state()).project === null, '專案應該結束了');
  await ok('POST', `/api/projects/${project.id}/open`, {});
  assert((await state()).project?.id === project.id, '應該重新打開專案');
  step('結束專案、再打開');
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
