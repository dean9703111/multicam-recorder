// 重要事件的紀錄：寫進資料夾裡的 server.log，出問題時看得到發生過什麼。
// 不記 token；家目錄換成 ~，給別人看也不會露出這台電腦的使用者名稱。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024; // 超過就把舊的改名成 server.1.log，只留兩份
let file: string | undefined;

export function initLog(dir: string): void {
  file = path.join(dir, 'server.log');
}

const home = os.homedir();
const maskPath = (s: string): string => (home.length > 1 ? s.split(home).join('~') : s);

// warn、error 也印在終端機
export function logEvent(event: string, fields: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const line = maskPath(`${new Date().toISOString()} ${level} ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);
  if (level !== 'info') console.error(line);
  if (!file) return;
  try {
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) fs.renameSync(file, file.replace(/\.log$/, '.1.log'));
    fs.appendFileSync(file, line + '\n');
  } catch {
    // 寫不進去就算了，紀錄不能害伺服器出事
  }
}
