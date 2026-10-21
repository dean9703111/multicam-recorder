import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diskFormat, formatLabel, GOOD_FORMATS, isFat32 } from './platform.ts';
import type { Guide, Orientation, RecordingSpec, Resolution, StopReason } from './protocol.ts';

export interface Settings {
  storageDir: string; // 新專案會建在這個資料夾底下
  resolution: Resolution;
  guide: Guide;
  facePriority: boolean; // 人像設定，說明在 protocol.ts 的 RecordingSpec
  lockExposure: boolean;
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
  zoom?: number; // 變焦倍率，手機連上時套用
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
  orientation?: Orientation; // 直拿錄的是 portrait；舊版 App 沒有回報，當成橫的
  trimmedFrom?: string; // 裁剪出來的影片：原本那支的 ID
  marked?: boolean; // 使用者標記為好的段落；同一段（takeId）的影片一起標
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
    settings: {
      storageDir: DEFAULT_STORAGE_DIR,
      resolution: '2160p',
      guide: 'none',
      facePriority: true,
      lockExposure: false,
      projectId: null,
    },
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
  format?: string; // 硬碟格式，例如 APFS、NTFS
  warning?: string;
  error?: string;
}

export function storageInfo(dir: string): StorageInfo {
  const error = checkDir(dir);
  if (error) return { dir, available: false, error };
  const s = fs.statfsSync(dir);
  const format = diskFormat(dir);
  const info: StorageInfo = { dir, available: true, freeBytes: s.bavail * s.bsize, format: formatLabel(format) };
  if (isFat32(format)) info.warning = `這顆硬碟是 FAT32 格式，存不了超過 4 GB 的檔案，請改成 ${GOOD_FORMATS}`;
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
