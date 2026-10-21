// 各作業系統不一樣的地方：硬碟格式、垃圾桶、PowerShell。
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { m } from './i18n.ts';

const run = promisify(execFile);

// PowerShell 指令用 -EncodedCommand 傳，路徑裡有引號、中文都不用另外跳脫；輸出固定用 UTF-8
export function powershellArgs(script: string, sta = false): string[] {
  const full = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`;
  return ['-NoProfile', ...(sta ? ['-STA'] : []), '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')];
}

// PowerShell 的單引號字串
export const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

// ---------- 硬碟格式 ----------

// Windows 要開 PowerShell 才查得到，比較慢，所以在背景查、記住結果，下一次更新時才顯示
const windowsFormats = new Map<string, string | null>();

function windowsFormat(dir: string): string | undefined {
  const root = path.parse(dir).root; // 例如 E:\；網路路徑不查
  if (!/^[A-Za-z]:\\$/.test(root)) return undefined;
  const known = windowsFormats.get(root);
  if (known !== undefined) return known ?? undefined;
  windowsFormats.set(root, null);
  run('powershell.exe', powershellArgs(`[System.IO.DriveInfo]::new(${psQuote(root)}).DriveFormat`), { timeout: 15_000 })
    .then(({ stdout }) => windowsFormats.set(root, stdout.trim() || null))
    .catch(() => windowsFormats.delete(root)); // 硬碟可能還沒接上，下次再查
  return undefined;
}

// 資料夾所在磁碟的格式（apfs、exfat、msdos、NTFS、FAT32…），查不到時回傳 undefined。
// macOS 的 mount 輸出是「/dev/x on /Volumes/SSD (exfat, local)」，Linux 是「/dev/x on /media/SSD type vfat (rw)」。
export function diskFormat(dir: string): string | undefined {
  if (process.platform === 'win32') return windowsFormat(dir);
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

export const isFat32 = (format: string | undefined): boolean => ['msdos', 'vfat', 'fat', 'fat32'].includes(format?.toLowerCase() ?? '');

// 顯示用的名稱：apfs → APFS、msdos → FAT32
export function formatLabel(format: string | undefined): string | undefined {
  if (!format) return undefined;
  if (isFat32(format)) return 'FAT32';
  const known: Record<string, string> = { apfs: 'APFS', exfat: 'exFAT', ntfs: 'NTFS', hfs: m('disk.hfs') };
  return known[format.toLowerCase()] ?? format;
}

// ---------- 垃圾桶 ----------

// Windows：一次把所有檔案交給 SHFileOperation 放進資源回收筒。
// FOF_WANTNUKEWARNING：放不進去（檔案比資源回收筒大、隨身碟沒有資源回收筒）時會先跳出警告，不會默默永久刪除。
const RECYCLE_TYPE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MulticamRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Op { public IntPtr hwnd; public uint func; public string from; public string to; public ushort flags; public bool aborted; public IntPtr mappings; public string title; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref Op op);
  public static int Send(string[] paths) {
    // FO_DELETE；FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_WANTNUKEWARNING
    var op = new Op { func = 3, from = string.Join("\\0", paths) + "\\0\\0", flags = 0x0040 | 0x0010 | 0x0004 | 0x4000 };
    return SHFileOperation(ref op);
  }
}
'@
`;

// 移到系統的垃圾桶，之後還救得回來。沒辦法移到垃圾桶時直接報錯，不會改成永久刪除。
export async function moveToTrash(files: string[]): Promise<void> {
  if (!files.length) return;
  if (process.platform === 'darwin') {
    // macOS 15 起有內建的 trash 指令；舊版請 Finder 代勞（第一次會問要不要讓終端機控制 Finder）
    if (fs.existsSync('/usr/bin/trash')) {
      await run('/usr/bin/trash', files);
    } else {
      const list = files.map((f) => `POSIX file "${f.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ');
      await run('osascript', ['-e', `tell application "Finder" to delete {${list}}`]);
    }
    return;
  }
  if (process.platform === 'win32') {
    // 命令列有長度上限，分批送
    for (let i = 0; i < files.length; i += 40) {
      const batch = files.slice(i, i + 40).map(psQuote).join(', ');
      const script = `$ErrorActionPreference = 'Stop'\n${RECYCLE_TYPE}\n$code = [MulticamRecycle]::Send(@(${batch}))\nif ($code -ne 0) { throw "SHFileOperation error $code" }`;
      await run('powershell.exe', powershellArgs(script), { timeout: 10 * 60_000 });
    }
    return;
  }
  try {
    await run('gio', ['trash', '--', ...files]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(m('trash.noGio'));
    throw e;
  }
}
