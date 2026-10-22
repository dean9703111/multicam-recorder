import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLog, logEvent } from './events.ts';
import { m, type LangSetting } from './i18n.ts';
import { diskFormat, formatLabel, isFat32, userDataDir } from './platform.ts';
import type { Guide, Orientation, RecordingSpec, Resolution, StopReason } from './protocol.ts';

export interface Settings {
  storageDir: string; // 新專案會建在這個資料夾底下
  resolution: Resolution;
  guide: Guide;
  facePriority: boolean; // 人像設定，說明在 protocol.ts 的 RecordingSpec
  lockExposure: boolean;
  maxMinutes: number; // 單段上限（分鐘），在 TAKE_MINUTES 的範圍內
  sounds: boolean; // 剩 3 分鐘、到上限自動停止時，電腦播放提示音
  language: LangSetting; // 介面語言；auto 是跟著瀏覽器（控制台）或系統（終端機）
  projectId: string | null; // 目前的專案；null 表示還沒建立或已結束
}

export const TAKE_MINUTES = { min: 10, max: 90 }; // 單段上限可以設的範圍（分鐘），控制台讓使用者自己輸入

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
  address?: string; // 配對時手機連的電腦位址（例如 192.168.1.20:8787），電腦的 IP 換了就要重新配對
  fileLimitBytes?: number; // 這支手機單一影片的大小上限（碰到過才知道），開始前會提醒
}

// 已經移除的手機：它錄的影片還在清單上，顯示時要知道名稱
export interface RemovedDevice {
  id: string;
  name: string;
  model: string;
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
  error?: string; // 舊版 App 送來的失敗訊息（原文）
  errorCode?: string; // 失敗原因的代碼，送給控制台時才換成那個分頁的語言（i18n.ts 的 fileError.*）
  errorParams?: Record<string, string>;
  spec: RecordingSpec;
  videoWidth?: number; // 手機實際錄的解析度
  videoHeight?: number;
  orientation?: Orientation; // 直拿錄的是 portrait；舊版 App 沒有回報，當成橫的
  trimmedFrom?: string; // 裁剪出來的影片：原本那支的 ID
  marked?: boolean; // 使用者標記為好的段落；同一段（takeId）的影片一起標
  audioChannels?: number; // 錄到的聲道數；舊版 App 沒有回報（單聲道）
  micDroppedAt?: number; // 錄影中外接麥克風斷開、改用手機內建麥克風的時間（電腦時間）
}

interface Db {
  settings: Settings;
  devices: Device[];
  removedDevices: RemovedDevice[];
  projects: Project[];
  files: FileEntry[];
}

// macOS 的「影片」資料夾叫 Movies，Windows 和 Linux 叫 Videos
export const DEFAULT_STORAGE_DIR = path.join(os.homedir(), process.platform === 'darwin' ? 'Movies' : 'Videos', 'MultiCamRecorder');

// 測試時用 RECORDER_DATA_DIR 指到別的資料夾，不會動到正式的配對與影片清單
export const DATA_DIR = path.resolve(process.env.RECORDER_DATA_DIR ?? userDataDir());
const DB_PATH = path.join(DATA_DIR, 'db.json');
const BACKUP_PATH = DB_PATH + '.bak'; // 上次成功啟動時的內容
// v0.5.0 以前存在程式資料夾的 data/ 裡，第一次啟動時複製過來（舊的留著當備份）
const LEGACY_DB_PATH = path.join(import.meta.dirname, '../data/db.json');

// db.json 壞掉時怎麼處理的，控制台會顯示：restored 改用了備份、reset 連備份也不能用，只好重新開始
export let dbProblem: { kind: 'restored' | 'reset'; kept: string } | undefined;

function readDb(file: string): Partial<Db> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return JSON.parse(text) as Partial<Db>;
}

function load(): Db {
  const defaults: Db = {
    settings: {
      storageDir: DEFAULT_STORAGE_DIR,
      resolution: '2160p',
      guide: 'none',
      facePriority: true,
      lockExposure: false,
      maxMinutes: 30,
      sounds: true,
      language: 'auto',
      projectId: null,
    },
    devices: [],
    removedDevices: [],
    projects: [],
    files: [],
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  initLog(DATA_DIR);
  if (!process.env.RECORDER_DATA_DIR && !fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
    fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
    logEvent('db.moved', { from: LEGACY_DB_PATH, to: DB_PATH });
  }
  let saved: Partial<Db> | undefined;
  try {
    saved = readDb(DB_PATH);
  } catch (e) {
    // 壞掉的檔案另外複製一份留著，不要直接蓋掉；改用上次成功啟動時的備份，備份也不能用才重新開始
    const kept = `${DB_PATH}.broken-${Date.now()}`;
    fs.copyFileSync(DB_PATH, kept);
    try {
      saved = readDb(BACKUP_PATH);
    } catch {
      saved = undefined;
    }
    dbProblem = { kind: saved ? 'restored' : 'reset', kept };
    logEvent('db.broken', { error: (e as Error).message, kept, restored: !!saved }, 'error');
  }
  if (!saved) return defaults;
  if (!dbProblem) {
    try {
      fs.copyFileSync(DB_PATH, BACKUP_PATH);
    } catch {
      // 備份失敗不影響啟動
    }
  }
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

// 最近一次存檔失敗的原因（例如硬碟滿了），控制台會顯示；存成功就清掉
export let saveError: string | undefined;

export function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}

// 先寫到暫存檔、確定寫進硬碟再改名，當機或斷電時才不會只剩一半。
// 寫不進去時不讓伺服器停掉：記下原因，5 秒後再試一次。
export function saveNow(): boolean {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const fd = fs.openSync(DB_PATH + '.tmp', 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(db, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(DB_PATH + '.tmp', DB_PATH);
    if (saveError !== undefined) logEvent('db.saveRecovered');
    saveError = undefined;
    return true;
  } catch (e) {
    if (saveError === undefined) logEvent('db.saveFailed', { error: (e as Error).message }, 'error');
    saveError = (e as Error).message;
    saveTimer = setTimeout(saveNow, 5000);
    return false;
  }
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
  let s: fs.StatsFs;
  try {
    s = fs.statfsSync(dir);
  } catch (e) {
    return { dir, available: false, error: m('dir.unreadable', { dir, error: (e as Error).message }) };
  }
  const format = diskFormat(dir);
  const info: StorageInfo = { dir, available: true, freeBytes: s.bavail * s.bsize, format: formatLabel(format) };
  if (isFat32(format)) info.warning = m('disk.fat32', { formats: m('disk.goodFormats') });
  return info;
}

// 資料夾存在而且可以寫入就回傳 undefined，否則回傳錯誤訊息。
// 不會自動建立資料夾：路徑打錯時才不會默默建出一個新的，外接硬碟沒接上時也不會寫進內建硬碟。
export function checkDir(dir: string): string | undefined {
  // macOS 的外接硬碟掛在 /Volumes 底下，Windows 則是另一個磁碟機代號
  const volume = /^\/Volumes\/[^/]+/.exec(dir)?.[0] ?? /^[A-Za-z]:[\\/]/.exec(dir)?.[0];
  if (volume && !fs.existsSync(volume)) return m('dir.volumeMissing', { volume });
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return m('dir.notFound', { dir });
  }
  if (!stat.isDirectory()) return m('dir.notFolder', { dir });
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return m('dir.notWritable', { dir });
  }
  return undefined;
}
