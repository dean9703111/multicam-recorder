// 手機 ↔ Mac 的通訊格式，Android App 依照這份實作。
//
// 1. QR Code 的內容是網址 http://<Mac>:8787/pair?code=<配對碼>。
//    App 內掃描：直接從網址取出 Mac 位址和配對碼。
//    用手機相機掃描：打開的網頁有按鈕，會用 multicam://pair?server=<Mac 位址>&code=<配對碼> 打開 App。
//    拿到之後 POST {Mac}/api/pair 換到 deviceToken（之後都用它）。
// 2. 連 WebSocket {url}/ws/device?token=<deviceToken>，第一則訊息送 hello。
//    定期送 sync 對時：offset = t1 - (t0 + t2) / 2，t2 是手機收到回覆的時間，取來回最短的那次。
// 3. 收到 start 後，在 startAt（Mac 時間）開始錄影；錄影中就用
//    PUT /api/upload/:fileId?offset=N 把檔案已寫入的部分邊錄邊傳（header 帶 X-Device-Token）。
//    傳失敗時用 GET /api/upload/:fileId 查 Mac 已收到多少，從那裡續傳。
// 4. 停止後：傳完剩下的位元組 → POST finish → 把整個檔案以 CHUNK_SIZE 分段算 SHA-256
//    → POST verify，依回覆補傳 resend 列出的分段，再 verify 一次，直到 ok。
//    （MP4 在停止時會改寫檔頭，所以第 0 段幾乎一定要補傳。）
//
// 其他規則：
// - 錄到 maxDurationSec 時手機自己停止，reason 用 'maxDuration'。
// - 還沒到 startAt 就收到 stop：取消這次錄影，回 recordingFailed。
// - WebSocket 斷線時照常錄影和上傳；recordingStarted、recordingStopped 等訊息先排隊，連回來再送。
//   完整的參考實作在 tools/fake-phone.ts。

export type Resolution = '2160p' | '1080p' | '720p';

export interface RecordingSpec {
  resolution: Resolution;
  fps: number;
  bitrate: number; // bps
  maxDurationSec: number;
  warnBeforeSec: number; // 剩這麼多秒時提醒
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
}

export type StopReason = 'user' | 'maxDuration' | 'error';

// 手機 → Mac
export type DeviceMessage =
  | { type: 'hello'; model: string; appVersion: string }
  | { type: 'sync'; t0: number }
  | ({ type: 'status' } & DeviceStatus)
  | { type: 'recordingStarted'; fileId: string; startedAt: number } // 換算成 Mac 時間
  | { type: 'recordingStopped'; fileId: string; reason: StopReason; durationMs: number; size: number }
  | { type: 'recordingFailed'; fileId: string; error: string };

// Mac → 手機
export type ServerMessage =
  | { type: 'welcome'; name: string; serverTime: number; spec: RecordingSpec }
  | ({ type: 'config' } & RecordingSpec) // Mac 改了錄影設定，手機可以先把相機準備好
  | { type: 'sync'; t0: number; t1: number }
  | ({ type: 'start'; fileId: string; takeId: string; fileName: string; startAt: number } & RecordingSpec)
  | { type: 'stop'; fileId: string }
  | { type: 'rename'; name: string }
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
