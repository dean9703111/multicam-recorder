import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { m } from './i18n.ts';

export class HttpError extends Error {
  status: number;
  body?: Record<string, unknown>;

  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// 本機的連線還要確認是控制台自己的網頁，因為這台電腦上打開的其他網頁也連得到 localhost：
// Host 要是本機的名稱（擋 DNS rebinding），瀏覽器帶的 Origin 要和 Host 一樣（擋跨站請求），
// POST 一定要是 JSON（表單和不經過 preflight 的跨站請求都送不出 JSON）。本機的程式（例如模擬手機）不帶 Origin，照樣可以用。
export function fromDashboard(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin.toLowerCase() !== `http://${host}`) return false;
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return false;
  return true;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, m('http.tooLarge'));
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
  } catch {
    throw new HttpError(400, m('http.badJson'));
  }
}

// 支援 Range，<video> 才能拖曳進度、不用整個檔案讀完才播放
export function sendFile(req: IncomingMessage, res: ServerResponse, file: string, type: string): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    throw new HttpError(404, m('http.fileNotFound'));
  }
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  // 讀到一半出錯（例如外接硬碟被拔掉）只中斷這個請求，不讓整個伺服器停掉
  if (!range || (!range[1] && !range[2])) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    pipeline(fs.createReadStream(file), res).catch(() => {});
    return;
  }
  let start = range[1] ? Number(range[1]) : size - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
  pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
}
