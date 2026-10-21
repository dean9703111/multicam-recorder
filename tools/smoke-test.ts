// 端對端測試：開一個伺服器和兩支模擬手機（一支橫拿、一支直拿），把整個流程跑一遍。CI 在 Windows、macOS、Linux 上都會跑。
// 會用到 ffmpeg（模擬手機錄影用）。測試資料放在暫存資料夾，跑完就清掉；只有被移到垃圾桶的兩支小影片會留在系統的垃圾桶裡。
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
// 一支橫拿、一支直拿一起錄，例如同時錄長影片和短影音。直拿的那支做得到背景虛化（最高 1080p，和 Pixel 11 Pro 一樣）
const PHONES = [
  { model: 'Smoke Phone', orientation: 'landscape', bokehMax: null },
  { model: 'Smoke Portrait', orientation: 'portrait', bokehMax: '1920x1080' },
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
  step(`設定錄影資料夾（硬碟格式 ${format}，剩 ${Math.round(s.storage.freeBytes / 1e9)} GB）`);

  for (const bad of ['CON', 'lpt1.mp4', '結尾句點.', 'a/b']) {
    assert((await api('POST', '/api/projects', { name: bad })).status === 400, `專案名稱「${bad}」應該被擋下`);
  }
  const project = await ok('POST', '/api/projects', { name: PROJECT });
  const projectDir = path.join(recDir, PROJECT);
  assert(fs.statSync(projectDir).isDirectory(), '應該建立專案資料夾');
  assert((await api('POST', '/api/projects', { name: PROJECT })).status === 409, '同名專案應該被擋下');
  step('新增專案、擋下不合規的名稱');

  const phones = PHONES.map((p, i) =>
    start(
      `phone${i + 1}`,
      [
        ...['tools/fake-phone.ts', '--model', p.model, '--orientation', p.orientation, '--server', BASE, '--encoder', 'libx264'],
        ...(p.bokehMax ? ['--bokeh-max', p.bokehMax] : []),
      ],
      { RECORDER_DATA_DIR: dataDir },
    ),
  );
  const devices = await waitFor('兩支模擬手機上線', async () => {
    const all = (await state()).devices;
    const found = PHONES.map((p) => all.find((d: any) => d.model === p.model && d.online && d.status.cameraReady && d.status.zoomRange));
    return found.every(Boolean) ? found : undefined;
  });
  for (const [i, d] of devices.entries()) {
    assert(d.features.includes('preview') && d.features.includes('zoom'), `${d.name} 應該回報支援即時畫面和變焦`);
    assert(d.status.orientation === PHONES[i].orientation, `${d.name} 應該回報 ${PHONES[i].orientation}，結果是 ${d.status.orientation}`);
    const max = PHONES[i].bokehMax?.split('x').map(Number) ?? null;
    assert(d.camera?.facePriority && d.camera.lockExposure, `${d.name} 應該回報做得到臉部優先和鎖定曝光`);
    assert(JSON.stringify(d.camera.bokehMax) === JSON.stringify(max), `${d.name} 回報的背景虛化上限不對：${JSON.stringify(d.camera.bokehMax)}`);
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

  // 人像設定：背景虛化只套用在做得到、解析度又沒超過上限的手機，這時變焦範圍變小；關掉後回到原本的倍率
  s = await state();
  assert(s.settings.facePriority && !s.settings.bokeh && !s.settings.lockExposure, '人像設定的預設應該是臉部優先開、其他關');
  const statusOf = async (d: any) => (await state()).devices.find((x: any) => x.id === d.id)?.status;
  const bokehPhone = devices[1];
  await ok('POST', `/api/devices/${bokehPhone.id}/zoom`, { ratio: 4 });
  await ok('POST', '/api/settings', { bokeh: true, lockExposure: true });
  await waitFor('直拿的手機套用背景虛化，變焦限制在 3×', async () => {
    const st = await statusOf(bokehPhone);
    return st?.bokeh === true && st.zoom === 3 && st.zoomRange?.[1] === 3;
  }, 10_000);
  assert((await statusOf(phone))?.bokeh === false, '做不到背景虛化的手機不應該套用');
  await ok('POST', '/api/settings', { resolution: '2160p' });
  await waitFor('4K 超過上限，不套用背景虛化，變焦回到 4×', async () => {
    const st = await statusOf(bokehPhone);
    return st?.bokeh === false && st.zoom === 4;
  }, 10_000);
  await ok('POST', '/api/settings', { resolution: '720p' });
  await waitFor('回到 720p 又套用背景虛化', async () => (await statusOf(bokehPhone))?.bokeh === true, 10_000);
  await ok('POST', `/api/devices/${bokehPhone.id}/zoom`, { ratio: 1 });
  step('人像設定：背景虛化只套用在做得到的手機，超過解析度上限就不套用，變焦範圍跟著變');

  // 兩支一起錄兩段，第二段緊接著開始（剛停止時不能被當成還在錄影）
  const takes: any[][] = [];
  for (const seconds of [3, 2]) {
    const r = await ok('POST', '/api/record/start', {});
    assert(r.skipped.length === 0, `開始錄影時被跳過：${r.skipped.join('、')}`);
    if (!takes.length) assert((await api('POST', '/api/settings', { bokeh: false })).status === 409, '錄影中應該不能改人像設定');
    await sleep(seconds * 1000 + 800);
    await ok('POST', '/api/record/stop', {});
    const done = new Set(takes.flat().map((f) => f.id));
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
      assert(f.spec.facePriority && f.spec.bokeh && f.spec.lockExposure, `${f.name} 應該記著錄影時的人像設定`);
    }
  }
  step(`兩支一起錄兩段、傳到專案資料夾，和手機原檔的 SHA-256 一致，直式、橫式也記對了（共 ${takes.flat().length} 支），錄影中不能改人像設定`);

  await ok('POST', `/api/takes/${takes[0][0].takeId}/mark`, { marked: true });
  s = await state();
  assert(takes[0].every((t) => s.files.find((f: any) => f.id === t.id)?.marked), '第一段的兩支影片都應該被標記');
  step('標記第一段（兩支一起標）');

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
