import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RecordingSpec, Resolution, StopReason } from './protocol.ts';

export interface Settings {
  storageDir: string;
  resolution: Resolution;
}

export interface Device {
  id: string;
  token: string;
  model: string;
  name: string; // 顯示名稱，也用在檔名
  pairedAt: number;
}

export type FileState = 'starting' | 'recording' | 'finishing' | 'ready' | 'failed';

export interface FileEntry {
  id: string;
  takeId: string; // 同一次「開始」的影片共用
  deviceId: string;
  name: string;
  dir: string;
  createdAt: number;
  startedAt?: number; // 手機回報的實際開始時間（Mac 時間）
  stoppedAt?: number;
  durationMs?: number;
  size?: number;
  stopReason?: StopReason;
  state: FileState;
  error?: string;
  spec: RecordingSpec;
}

interface Db {
  settings: Settings;
  devices: Device[];
  files: FileEntry[];
}

export const DEFAULT_STORAGE_DIR = path.join(os.homedir(), 'Movies', 'MultiCamRecorder');

// 測試時用 RECORDER_DATA_DIR 指到別的資料夾，不會動到正式的配對與影片清單
export const DATA_DIR = path.resolve(process.env.RECORDER_DATA_DIR ?? path.join(import.meta.dirname, '../data'));
const DB_PATH = path.join(DATA_DIR, 'db.json');

function load(): Db {
  const defaults: Db = {
    settings: { storageDir: DEFAULT_STORAGE_DIR, resolution: '2160p' },
    devices: [],
    files: [],
  };
  let text: string;
  try {
    text = fs.readFileSync(DB_PATH, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaults;
    throw e;
  }
  // 檔案壞掉就直接報錯，不要用空資料蓋掉已配對的手機
  const saved = JSON.parse(text) as Partial<Db>;
  return { ...defaults, ...saved, settings: { ...defaults.settings, ...saved.settings } };
}

export const db: Db = load();

let saveTimer: NodeJS.Timeout | undefined;

export function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}

export function saveNow(): void {
  clearTimeout(saveTimer);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB_PATH + '.tmp', DB_PATH);
}

export interface StorageInfo {
  dir: string;
  available: boolean;
  freeBytes?: number;
  warning?: string;
  error?: string;
}

export function storageInfo(dir: string): StorageInfo {
  const error = checkDir(dir);
  if (error) return { dir, available: false, error };
  const s = fs.statfsSync(dir);
  const info: StorageInfo = { dir, available: true, freeBytes: s.bavail * s.bsize };
  if (fsType(dir) === 'msdos') {
    info.warning = '這顆硬碟是 FAT32 格式，存不了超過 4 GB 的檔案，請改成 exFAT 或 APFS';
  }
  return info;
}

// 資料夾存在而且可以寫入就回傳 undefined，否則回傳錯誤訊息。
// 不會自動建立資料夾：路徑打錯時才不會默默建出一個新的，外接硬碟沒接上時也不會寫進內建硬碟。
export function checkDir(dir: string): string | undefined {
  const volume = /^\/Volumes\/[^/]+/.exec(dir)?.[0];
  if (volume && !fs.existsSync(volume)) return `找不到 ${volume}，外接硬碟可能沒接上`;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return `找不到這個資料夾：${dir}`;
  }
  if (!stat.isDirectory()) return `這不是資料夾：${dir}`;
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return `沒有權限寫入這個資料夾：${dir}`;
  }
  return undefined;
}

// 從 mount 的輸出找出資料夾所在磁碟的格式（apfs、exfat、msdos…）
function fsType(dir: string): string | undefined {
  let best = { mountPoint: '', type: undefined as string | undefined };
  for (const line of execFileSync('mount', { encoding: 'utf8' }).split('\n')) {
    const m = /^.+? on (.+) \(([^,)]+)/.exec(line);
    if (!m) continue;
    const [, mountPoint, type] = m;
    const prefix = mountPoint.endsWith('/') ? mountPoint : mountPoint + '/';
    const inside = dir === mountPoint || dir.startsWith(prefix);
    if (inside && mountPoint.length > best.mountPoint.length) best = { mountPoint, type };
  }
  return best.type;
}
