// 一致性檢查（npm run check），CI 每次都會跑，發佈前也要跑：
// 1. 控制台的 JS 語法：server/public/*.js 沒有經過 TypeScript 檢查，少一個括號整頁就空白
// 2. 中英文字串的鍵對得起來：控制台 i18n.js、伺服器 i18n.ts、App 的 strings.xml（少了一種語言的字就會顯示成另一種語言）
// 3. 各處的版本號一致：package.json、App 的 versionName、伺服器的 LATEST_APP_VERSION、網站上寫的版本；網站和 sitemap 的日期也要一樣；
//    README、網站和配對網頁寫的簽章憑證指紋也要一樣
//
// 用法：node tools/check.ts

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const problems: string[] = [];

// ---------- 1. 控制台的 JS 語法 ----------

for (const file of ['server/public/app.js', 'server/public/i18n.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`${file} 有語法錯誤：\n${String((e as { stderr?: Buffer }).stderr ?? e)}`);
  }
}

// ---------- 2. 中英文字串的鍵 ----------

// 從 start 那一行開始，取到縮排相同的結尾那一行為止
function block(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`找不到「${start}」`);
  const to = text.indexOf(end, from + start.length);
  return text.slice(from + start.length, to);
}

function compare(what: string, zh: Set<string>, en: Set<string>): void {
  const onlyZh = [...zh].filter((k) => !en.has(k));
  const onlyEn = [...en].filter((k) => !zh.has(k));
  if (onlyZh.length) problems.push(`${what}：英文少了 ${onlyZh.join(', ')}`);
  if (onlyEn.length) problems.push(`${what}：中文少了 ${onlyEn.join(', ')}`);
}

const consoleText = read('server/public/i18n.js');
// 每個鍵都在這一層的縮排（4 格），值寫成多行的函式時，後面幾行縮排更深，不會被當成鍵
const consoleKeys = (s: string) => new Set([...s.matchAll(/^ {4}(?:'([^']+)'|([A-Za-z_]\w*)):/gm)].map((m) => m[1] ?? m[2]));
compare('控制台（server/public/i18n.js）', consoleKeys(block(consoleText, "'zh-TW': {", '\n  },')), consoleKeys(block(consoleText, '\n  en: {', '\n  },')));

const serverText = read('server/i18n.ts');
const serverKeys = (s: string) => new Set([...s.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1]));
compare('伺服器（server/i18n.ts）', serverKeys(block(serverText, 'const ZH: Record<string, Message> = {', '\n};')), serverKeys(block(serverText, 'const EN: Record<string, Message> = {', '\n};')));

// App：每個要翻譯的 string、plurals 兩種語言都要有
const appKeys = (file: string) => {
  const xml = read(file);
  return new Set([...xml.matchAll(/<(string|plurals) name="([^"]+)"([^>]*)>/g)].filter((m) => !/translatable="false"/.test(m[3])).map((m) => `${m[1]}:${m[2]}`));
};
const res = 'android/app/src/main/res';
compare('App（values／values-b+zh+Hant）', appKeys(`${res}/values-b+zh+Hant/strings.xml`), appKeys(`${res}/values/strings.xml`));
compare('App 直拿（values-port／values-b+zh+Hant-port）', appKeys(`${res}/values-b+zh+Hant-port/strings.xml`), appKeys(`${res}/values-port/strings.xml`));

// ---------- 3. 版本號和日期 ----------

function found(file: string, pattern: RegExp): string[] {
  return [...read(file).matchAll(pattern)].map((m) => m[1]);
}

const version = JSON.parse(read('package.json')).version as string;
const versions: [string, string[]][] = [
  ['android/app/build.gradle.kts 的 versionName', found('android/app/build.gradle.kts', /versionName = "([^"]+)"/g)],
  ['server/server.ts 的 LATEST_APP_VERSION', found('server/server.ts', /const LATEST_APP_VERSION = '([^']+)'/g)],
  ['docs/index.html 的 softwareVersion', found('docs/index.html', /"softwareVersion": "([^"]+)"/g)],
  ['docs/index.html 的「最新版」和頁尾', found('docs/index.html', /(?:最新版 v|（v)(\d+\.\d+\.\d+)/g)],
  ['docs/en/index.html 的 softwareVersion', found('docs/en/index.html', /"softwareVersion": "([^"]+)"/g)],
  ['docs/en/index.html 的 Latest 和頁尾', found('docs/en/index.html', /(?:Latest v|\(v)(\d+\.\d+\.\d+)/g)],
];
for (const [where, list] of versions) {
  if (!list.length) problems.push(`${where}：找不到版本號`);
  for (const v of list) if (v !== version) problems.push(`${where} 是 ${v}，package.json 是 ${version}`);
}

const dates = [
  ...found('docs/index.html', /"dateModified": "([^"]+)"/g),
  ...found('docs/en/index.html', /"dateModified": "([^"]+)"/g),
  ...found('docs/index.html', /最後更新 (\d{4}-\d{2}-\d{2})/g),
  ...found('docs/en/index.html', /Last updated (\d{4}-\d{2}-\d{2})/g),
  ...found('docs/sitemap.xml', /<lastmod>([^<]+)<\/lastmod>/g),
];
if (new Set(dates).size > 1) problems.push(`網站和 sitemap 的日期不一致：${[...new Set(dates)].join('、')}`);

// 簽章憑證的指紋：README、兩個網頁和配對網頁要寫同一串，不然想核對的人會被嚇到
const fingerprint = found('server/server.ts', /const APP_CERT_SHA256 = '([0-9a-f]{64})'/g)[0];
if (!fingerprint) problems.push('server/server.ts：找不到 APP_CERT_SHA256');
else for (const file of ['README.md', 'docs/index.html', 'docs/en/index.html']) {
  if (!read(file).includes(fingerprint)) problems.push(`${file} 沒有寫簽章憑證的指紋 ${fingerprint.slice(0, 8)}…（要和 server/server.ts 的 APP_CERT_SHA256 一樣）`);
}

// ---------- 結果 ----------

if (problems.length) {
  console.error(`✗ ${problems.length} 個問題：\n\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`✓ 控制台的 JS 語法、中英文字串、版本號（${version}）、網站日期和憑證指紋都一致`);
