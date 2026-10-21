import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './http.ts';
import { m } from './i18n.ts';
import { CHUNK_SIZE, type VerifyRequest, type VerifyResponse } from './protocol.ts';
import { checkDir, type FileEntry } from './store.ts';

// 傳輸中的檔案存成 .part，驗證通過才改成正式檔名
export const partPath = (f: FileEntry): string => path.join(f.dir, f.name + '.part');
export const finalPath = (f: FileEntry): string => path.join(f.dir, f.name);

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function receivedBytes(f: FileEntry): number {
  return sizeOf(f.state === 'ready' ? finalPath(f) : partPath(f));
}

// 每個檔案每一段的雜湊。某段被寫入就清掉重算；version 用來避免
// 「算到一半剛好被寫入」時存到舊的雜湊。
interface Hashes {
  hashes: (string | undefined)[];
  versions: number[];
  running: Promise<void>;
}

const cache = new Map<string, Hashes>();

function hashesOf(fileId: string): Hashes {
  let h = cache.get(fileId);
  if (!h) {
    h = { hashes: [], versions: [], running: Promise.resolve() };
    cache.set(fileId, h);
  }
  return h;
}

function invalidate(fileId: string, start: number, end: number): void {
  const h = cache.get(fileId);
  if (!h || end <= start) return;
  for (let i = Math.floor(start / CHUNK_SIZE); i * CHUNK_SIZE < end; i++) {
    h.hashes[i] = undefined;
    h.versions[i] = (h.versions[i] ?? 0) + 1;
  }
}

export async function writeChunk(f: FileEntry, offset: number, req: IncomingMessage): Promise<number> {
  const dirError = checkDir(f.dir);
  if (dirError) throw new HttpError(503, dirError);
  const file = partPath(f);
  const current = sizeOf(file);
  if (offset > current) throw new HttpError(409, m('upload.offsetTooFar'), { receivedBytes: current });
  fs.closeSync(fs.openSync(file, 'a')); // r+ 不會自己建立檔案
  const out = fs.createWriteStream(file, { flags: 'r+', start: offset });
  try {
    await pipeline(req, out);
  } finally {
    invalidate(f.id, offset, offset + out.bytesWritten);
  }
  return sizeOf(file);
}

// 手機傳完最後一段後呼叫。電腦這時就開始算雜湊，跟手機同時算，比較快。
export function finish(f: FileEntry, size: number): void {
  const file = partPath(f);
  const current = sizeOf(file);
  if (current < size) throw new HttpError(409, m('upload.incomplete'), { receivedBytes: current });
  if (current > size) {
    fs.truncateSync(file, size);
    invalidate(f.id, size, current);
  }
  f.size = size;
  void computeHashes(f).catch(() => {}); // 失敗的話 verify 會再算一次並回報錯誤
}

function computeHashes(f: FileEntry): Promise<void> {
  const h = hashesOf(f.id);
  h.running = h.running.catch(() => {}).then(() => fillHashes(f, h));
  return h.running;
}

async function fillHashes(f: FileEntry, h: Hashes): Promise<void> {
  const size = f.size ?? 0;
  const count = Math.ceil(size / CHUNK_SIZE);
  h.hashes.length = count;
  const fh = await fs.promises.open(partPath(f), 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK_SIZE);
    for (let i = 0; i < count; i++) {
      if (h.hashes[i]) continue;
      const version = h.versions[i] ?? 0;
      const len = Math.min(CHUNK_SIZE, size - i * CHUNK_SIZE);
      const { bytesRead } = await fh.read(buf, 0, len, i * CHUNK_SIZE);
      const digest = crypto.createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
      if ((h.versions[i] ?? 0) === version) h.hashes[i] = digest;
    }
  } finally {
    await fh.close();
  }
}

export async function verify(f: FileEntry, req: VerifyRequest): Promise<VerifyResponse> {
  if (f.size === undefined) throw new HttpError(409, m('upload.finishFirst'));
  if (req.chunkSize !== CHUNK_SIZE) throw new HttpError(400, m('upload.chunkSize', { size: CHUNK_SIZE }));
  const count = Math.ceil(f.size / CHUNK_SIZE);
  if (!Array.isArray(req.hashes) || req.hashes.length !== count) {
    throw new HttpError(400, m('upload.hashCount', { count }));
  }
  const actual = sizeOf(partPath(f));
  if (actual > f.size) {
    fs.truncateSync(partPath(f), f.size);
    invalidate(f.id, f.size, actual);
  }
  await computeHashes(f);
  const { hashes } = hashesOf(f.id);
  const resend = req.hashes.flatMap((hash, i) => (hash === hashes[i] ? [] : [i]));
  if (resend.length) return { ok: false, resend };
  fs.renameSync(partPath(f), finalPath(f));
  cache.delete(f.id);
  return { ok: true };
}
