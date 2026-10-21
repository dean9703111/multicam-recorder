// 手機 ↔ 電腦的通訊格式，Android App 依照這份實作。
//
// 1. QR Code 的內容是網址 http://<電腦>:8787/pair?code=<配對碼>。
//    App 內掃描：直接從網址取出電腦位址和配對碼。
//    用手機相機掃描：打開的網頁有按鈕，會用 multicam://pair?server=<電腦位址>&code=<配對碼> 打開 App。
//    拿到之後 POST {電腦}/api/pair 換到 deviceToken（之後都用它）。
// 2. 連 WebSocket {url}/ws/device?token=<deviceToken>，第一則訊息送 hello。
//    定期送 sync 對時：offset = t1 - (t0 + t2) / 2，t2 是手機收到回覆的時間，取來回最短的那次。
// 3. 收到 start 後，在 startAt（電腦時間）開始錄影；錄影中就用
//    PUT /api/upload/:fileId?offset=N 把檔案已寫入的部分邊錄邊傳（header 帶 X-Device-Token）。
//    傳失敗時用 GET /api/upload/:fileId 查電腦已收到多少，從那裡續傳。
// 4. 停止後：傳完剩下的位元組 → POST finish → 把整個檔案以 CHUNK_SIZE 分段算 SHA-256
//    → POST verify，依回覆補傳 resend 列出的分段，再 verify 一次，直到 ok。
//    （MP4 在停止時會改寫檔頭，所以第 0 段幾乎一定要補傳。）
//
// 其他規則：
// - 錄到 maxDurationSec 時手機自己停止，reason 用 'maxDuration'。
// - 還沒到 startAt 就收到 stop：取消這次錄影，回 recordingFailed。
// - WebSocket 斷線時照常錄影和上傳；recordingStarted、recordingStopped 等訊息先排隊，連回來再送。
// - 即時畫面：收到 preview on 之後，大約每秒 5 張，把目前的預覽畫面壓成 JPEG（640×360 左右），
//   用 WebSocket 的二進位訊息送出；收到 preview off 就停。網路塞住時寧可丟掉，不要排隊。
// - 變焦：收到 zoom 就把倍率套到預覽和錄影（超出範圍時取最接近的值），在 status 回報實際倍率和可用範圍。
//   完整的參考實作在 tools/fake-phone.ts。

export type Resolution = '2160p' | '1440p' | '1080p' | '720p';

// 構圖輔助框：只疊在預覽畫面上，錄影永遠是 16:9
export type Guide = 'none' | '9:16' | '4:5' | '1:1';

export interface RecordingSpec {
  resolution: Resolution;
  fps: number;
  bitrate: number; // bps
  maxDurationSec: number;
  warnBeforeSec: number; // 剩這麼多秒時提醒
  guide: Guide;
}

// /api/pairing 回傳的配對資訊（模擬手機用）
export interface QrPayload {
  v: 1;
  url: string;
  pair: string;
}

export interface PairRequest {
  pair: string;
  deviceId: string; // 手機自己產生並保存的 UUID
  model: string; // Build.MODEL
}

export interface PairResponse {
  deviceToken: string;
  name: string;
}

export interface DeviceStatus {
  battery?: number; // 0–100
  charging?: boolean;
  temperatureC?: number;
  freeBytes?: number;
  cameraReady?: boolean;
  recordingFileId?: string | null;
  audioInput?: string; // 目前用哪支麥克風，例如「外接 USB（DJI Mic）」
  zoom?: number; // 目前的變焦倍率
  zoomRange?: [number, number]; // 這支手機能用的變焦範圍，例如 [0.5, 10]
}

export type StopReason = 'user' | 'maxDuration' | 'error';

// 手機 → 電腦
export type DeviceMessage =
  | { type: 'hello'; model: string; appVersion: string; features?: string[] } // features：'preview'、'zoom'
  | { type: 'sync'; t0: number }
  | ({ type: 'status' } & DeviceStatus)
  // startedAt 要換算成電腦時間；width、height 是實際錄的解析度（手機不支援要求的解析度時會降級）
  | { type: 'recordingStarted'; fileId: string; startedAt: number; width?: number; height?: number }
  | { type: 'recordingStopped'; fileId: string; reason: StopReason; durationMs: number; size: number }
  | { type: 'recordingFailed'; fileId: string; error: string };

// 電腦 → 手機
export type ServerMessage =
  | { type: 'welcome'; name: string; serverTime: number; spec: RecordingSpec; zoom: number }
  | ({ type: 'config' } & RecordingSpec) // 電腦改了錄影設定，手機可以先把相機準備好
  | { type: 'sync'; t0: number; t1: number }
  | ({ type: 'start'; fileId: string; takeId: string; fileName: string; startAt: number } & RecordingSpec)
  | { type: 'stop'; fileId: string }
  | { type: 'rename'; name: string }
  | { type: 'zoom'; ratio: number }
  | { type: 'preview'; on: boolean } // 電腦上有人在看這支手機的即時畫面時才開
  | { type: 'error'; code: 'unpaired'; message: string };

export const CHUNK_SIZE = 16 * 1024 * 1024;

export interface FinishRequest {
  size: number;
  durationMs: number;
}

export interface VerifyRequest {
  chunkSize: number;
  hashes: string[]; // 每段 SHA-256 的 hex
}

export type VerifyResponse = { ok: true } | { ok: false; resend: number[] };
