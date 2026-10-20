import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Guide, RecordingSpec, Resolution, StopReason } from './protocol.ts';

export interface Settings {
  storageDir: string; // 新專案會建在這個資料夾底下
  resolution: Resolution;
  guide: Guide;
  projectId: string | null; // 目前的專案；null 表示還沒建立或已結束
}

// 一個專案就是錄影資料夾底下的一個子資料夾
export interface Project {
  id: string;
  name: string;
  dir: string; // 建立時的完整路徑
  createdAt: number;
  endedAt?: number;
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
  projectId: string;
  deviceId: string;
  name: string;
  dir: string;
  createdAt: number;
  startedAt?: number; // 手機回報的實際開始時間（電腦時間）
  stoppedAt?: number;
  durationMs?: number;
  size?: number;
  stopReason?: StopReason;
  state: FileState;
  error?: string;
  spec: RecordingSpec;
  videoWidth?: number; // 手機實際錄的解析度
  videoHeight?: number;
}

interface Db {
  settings: Settings;
  devices: Device[];
  projects: Project[];
  files: FileEntry[];
}

// macOS 的「影片」資料夾叫 Movies，Windows 和 Linux 叫 Videos
export const DEFAULT_STORAGE_DIR = path.join(os.homedir(), process.platform === 'darwin' ? 'Movies' : 'Videos', 'MultiCamRecorder');

// 測試時用 RECORDER_DATA_DIR 指到別的資料夾，不會動到正式的配對與影片清單
export const DATA_DIR = path.resolve(process.env.RECORDER_DATA_DIR ?? path.join(import.meta.dirname, '../data'));
const DB_PATH = path.join(DATA_DIR, 'db.json');

function load(): Db {
  const defaults: Db = {
    settings: { storageDir: DEFAULT_STORAGE_DIR, resolution: '2160p', guide: 'none', projectId: null },
    devices: [],
    projects: [],
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
  const loaded: Db = { ...defaults, ...saved, settings: { ...defaults.settings, ...saved.settings } };
  // 舊版還沒有專案，之前錄的影片集中放進「之前的錄影」
  const orphans = loaded.files.filter((f) => !f.projectId);
  if (orphans.length) {
    const legacy: Project = {
      id: crypto.randomUUID(),
      name: '之前的錄影',
      dir: orphans[0].dir,
      createdAt: Math.min(...orphans.map((f) => f.createdAt)),
      endedAt: Date.now(),
    };
    loaded.projects.push(legacy);
    for (const f of orphans) f.projectId = legacy.id;
  }
  return loaded;
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

// 適合存大型影片檔的硬碟格式
export const GOOD_FORMATS = process.platform === 'darwin' ? 'APFS 或 exFAT' : process.platform === 'win32' ? 'NTFS 或 exFAT' : 'exFAT 或 ext4';

export function storageInfo(dir: string): StorageInfo {
  const error = checkDir(dir);
  if (error) return { dir, available: false, error };
  const s = fs.statfsSync(dir);
  const info: StorageInfo = { dir, available: true, freeBytes: s.bavail * s.bsize };
  if (['msdos', 'vfat'].includes(fsType(dir) ?? '')) {
    info.warning = `這顆硬碟是 FAT32 格式，存不了超過 4 GB 的檔案，請改成 ${GOOD_FORMATS}`;
  }
  return info;
}

// 資料夾存在而且可以寫入就回傳 undefined，否則回傳錯誤訊息。
// 不會自動建立資料夾：路徑打錯時才不會默默建出一個新的，外接硬碟沒接上時也不會寫進內建硬碟。
export function checkDir(dir: string): string | undefined {
  // macOS 的外接硬碟掛在 /Volumes 底下，Windows 則是另一個磁碟機代號
  const volume = /^\/Volumes\/[^/]+/.exec(dir)?.[0] ?? /^[A-Za-z]:[\\/]/.exec(dir)?.[0];
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

// 從 mount 的輸出找出資料夾所在磁碟的格式（apfs、exfat、msdos、vfat…）。
// macOS 的格式是「/dev/x on /Volumes/SSD (exfat, local)」，Linux 是「/dev/x on /media/SSD type vfat (rw)」。
// Windows 沒有 mount 指令，就不檢查。
function fsType(dir: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  let output: string;
  try {
    output = execFileSync('mount', { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  let best = { mountPoint: '', type: undefined as string | undefined };
  for (const line of output.split('\n')) {
    const m = /^.+? on (.+?) (?:type (\S+) )?\(([^,)]+)/.exec(line);
    if (!m) continue;
    const mountPoint = m[1];
    const type = m[2] ?? m[3];
    const prefix = mountPoint.endsWith('/') ? mountPoint : mountPoint + '/';
    const inside = dir === mountPoint || dir.startsWith(prefix);
    if (inside && mountPoint.length > best.mountPoint.length) best = { mountPoint, type };
  }
  return best.type;
}
