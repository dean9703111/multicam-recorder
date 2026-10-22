// 伺服器送出的文字：錯誤訊息、配對網頁、狀態裡的說明、終端機的訊息。支援繁體中文和英文。
// 哪一種語言由請求決定：控制台送 X-Lang、手機的瀏覽器和 App 送 Accept-Language；都沒有時用預設語言。
// m(key) 會用目前這個請求的語言（AsyncLocalStorage），所以丟錯誤的地方不用一路傳語言進去。
import { AsyncLocalStorage } from 'node:async_hooks';

export type Lang = 'zh-TW' | 'en';
export type LangSetting = Lang | 'auto';
export const LANG_SETTINGS: LangSetting[] = ['auto', 'zh-TW', 'en'];

// zh、zh-TW、zh-Hant、zh-CN 都用繁體中文；其他語言一律英文。認不出來就回傳 undefined。
export function parseLang(header: unknown): Lang | undefined {
  const value: unknown = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || !value) return undefined;
  const tags = value
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = Number(params.map((x) => x.trim()).find((x) => x.startsWith('q='))?.slice(2) ?? 1);
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of tags) {
    if (tag.startsWith('zh')) return 'zh-TW';
    if (tag === '*' || /^[a-z]{2,3}(-|$)/.test(tag)) return 'en';
  }
  return undefined;
}

// 這台電腦的系統語言（終端機的訊息用）
export const systemLang = (): Lang => (/^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh-TW' : 'en');

const context = new AsyncLocalStorage<Lang>();
let fallback: () => Lang = systemLang;

// 沒有請求可以參考時（計時器、終端機）用的語言；伺服器會依設定改成使用者選的語言
export function setDefaultLang(get: () => Lang): void {
  fallback = get;
}
export const currentLang = (): Lang => context.getStore() ?? fallback();
export const withLang = <T>(lang: Lang, fn: () => T): T => context.run(lang, fn);

type Params = Record<string, string | number | undefined>;
type Message = string | ((p: Params) => string);

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const ZH: Record<string, Message> = {
  'html.lang': 'zh-Hant-TW',
  'list.sep': '、',
  'punct.colon': '：',
  'unit.min': '{n} 分鐘',
  'unit.sec': '{n} 秒',

  'trash.name': isWin ? '資源回收筒' : '垃圾桶',
  'disk.goodFormats': isMac ? 'APFS 或 exFAT' : isWin ? 'NTFS 或 exFAT' : 'exFAT 或 ext4',
  'disk.hfs': 'Mac OS 擴充格式',
  'disk.fat32': '這顆硬碟是 FAT32 格式，存不了超過 4 GB 的檔案，請改成 {formats}',
  'dir.volumeMissing': '找不到 {volume}，外接硬碟可能沒接上',
  'dir.notFound': '找不到這個資料夾：{dir}',
  'dir.notFolder': '這不是資料夾：{dir}',
  'dir.notWritable': '沒有權限寫入這個資料夾：{dir}',
  'dir.unreadable': '讀不到這個資料夾的空間資訊：{error}',
  'trash.noGio': '這台電腦沒有 gio 指令，沒辦法移到垃圾桶',

  'http.tooLarge': 'JSON 太大',
  'http.badJson': 'JSON 格式錯誤',
  'http.fileNotFound': '找不到檔案',
  'http.notFound': '找不到這個網址',
  'http.localOnly': '只能在執行伺服器的這台電腦上操作',
  'http.crossSite': '這個請求不是控制台送出的，已經擋下（防止其他網頁操作你的錄影）',
  'http.unsupported': '不支援這個操作',

  'upload.fileNotFound': '找不到這個檔案',
  'upload.auth': '裝置驗證失敗',
  'upload.done': '這個檔案已經傳完了',
  'upload.badOffset': 'offset 格式不正確',
  'upload.badSize': 'size 格式不正確',
  'upload.offsetTooFar': 'offset 超過已收到的大小',
  'upload.incomplete': '檔案還沒傳完',
  'upload.finishFirst': '請先呼叫 finish',
  'upload.chunkSize': 'chunkSize 必須是 {size}',
  'upload.hashCount': 'hashes 應該有 {count} 段',

  'device.unpaired': '這支手機還沒配對，請重新掃 QR Code',
  'device.removedByComputer': '這支手機已經從電腦上移除，要再使用請重新掃 QR Code',
  'device.notFound': '找不到這支手機',
  'device.removeWhileRecording': '這支手機正在錄影，停止後才能移除',
  'device.badZoom': '變焦倍率不正確',
  'device.nameLength': '名稱要 1 到 40 個字',

  'pair.noIp': '找不到這台電腦的區域網路 IP，請確認電腦已連上網路',
  'pair.expired': 'QR Code 已失效，請在電腦上重新產生',
  'pair.badDeviceId': 'deviceId 格式不正確',
  'pair.tooMany': '最多只能配對 {max} 支手機，請先在電腦上移除不用的手機',

  'pairPage.title': '配對多機錄影',
  'pairPage.iosTitle': '目前只支援 Android',
  'pairPage.iosBody': '「多機錄影」的手機 App 目前只有 Android 版，iPhone 還不能當攝影機。',
  'pairPage.heading': '配對這支手機',
  'pairPage.body': '按下按鈕會打開「多機錄影」App，並自動完成配對。',
  'pairPage.button': '打開 App 並配對',
  'pairPage.noApp': '還沒安裝 App？',
  'pairPage.step1': (p) =>
    `按上面的按鈕，或<a href="${p.url}">直接下載 APK</a>。下載完點開安裝，第一次會要你允許瀏覽器安裝應用程式。`,
  'pairPage.step2': '裝好後回到這一頁，再按一次「打開 App 並配對」。',
  'pairPage.verify': (p) =>
    `App 不是從 Google Play 下載的，所以 Google Play 安全防護跳出提醒是正常的。正式版的簽章憑證 SHA-256 指紋是 <code>${p.fp}</code>。`,
  'pairPage.validity': '這個 QR Code 10 分鐘內有效。過期的話，請在電腦上按「配對手機」重新產生。',
  'pairPage.expiredTitle': 'QR Code 已失效',
  'pairPage.expiredBody': '請在電腦上按「配對手機」，再掃一次新的 QR Code。',

  'rec.needProject': '請先新增專案',
  'rec.offline': '{name} 離線',
  'rec.busy': '{name} 已經在錄影',
  'rec.cameraNotReady': '{name} 相機還沒準備好',
  'rec.noPhones': '還沒有配對任何手機',
  'rec.stopQueued': '{name} 離線，等它連回來會自動停止',
  'rec.nothingRecording': '沒有正在錄影的手機',
  'rec.lowPhoneSpace': '{name} 的空間只夠錄大約 {left}（這一段最長 {max}），錄到一半會停。可以先在手機上按「清除已傳完的影片」，或改用低一點的解析度',
  'rec.lowBattery': '{name} 只剩 {battery}% 電量而且沒在充電，可能錄到一半就沒電，建議先接上充電器',
  'rec.fileLimit': '{name} 的一支影片最大大約 {size}，這個解析度錄大約 {left} 就會停（這一段最長 {max}）。要錄更久，請在「錄影規格」改用低一點的解析度',
  'rec.lowComputerSpace': '電腦的錄影資料夾只剩 {free}，這一段最多要 {need}，可能傳到一半就放不下。可以先清出空間，或在「設定」換一個資料夾',

  'project.nameLength': '專案名稱要 1 到 60 個字',
  'project.nameChars': '專案名稱不能包含 / \\ : * ? " < > |，也不能用 . 開頭或結尾',
  'project.reserved': '「{name}」是 Windows 保留的名稱，請換一個',
  'project.switchWhileRecording': '錄影中不能切換專案，請先停止',
  'project.badRoot': '錄影資料夾不能用：{error}',
  'project.exists': '已經有同名的專案，可以從專案清單打開它',
  'project.notFound': '找不到這個專案',
  'project.endWhileRecording': '錄影中不能結束專案，請先停止',
  'project.none': '還沒有專案',

  'folder.prompt': '選擇錄影資料夾（建議選外接 SSD）',
  'folder.busy': '選擇資料夾的視窗已經開著了',
  'folder.unsupported': '這個系統沒有選擇資料夾的視窗，請直接貼上路徑',
  'folder.failed': '打不開選擇資料夾的視窗：{error}',

  'files.noneSelected': '沒有選要刪除的影片',
  'files.missing': '找不到要刪除的影片，清單可能已經更新了',
  'files.busy': '{name} 還在錄影或傳輸，不能刪除',
  'files.trashFailed': '有 {count} 支影片沒有移到{trash}{reason}',
  'file.notFound': '找不到這支影片',
  'file.notReady': '影片還沒傳完',
  'path.notFound': '找不到 {path}',
  'take.notFound': '找不到這一段',

  'trim.needFfmpeg': '裁剪要用到 ffmpeg：請在終端機執行 {cmd}，裝好後再試一次',
  'trim.clipMissing': '找不到這支影片，清單可能已經更新了',
  'trim.badRange': '裁剪的範圍不對，至少要留 1 秒',
  'trim.busy': '這一段正在裁剪，請稍等',
  'trim.notCovered': '{name} 沒有錄到這段時間',
  'trim.failed': '裁剪 {name} 失敗：{error}。這一段都沒有裁，原本的影片不受影響',
  'trim.timeout': 'ffmpeg 超過 {minutes} 分鐘還沒做完，已經停止。影片在外接硬碟上的話，請確認硬碟還接著',

  'settings.badResolution': '不支援這個解析度',
  'settings.resolutionWhileRecording': '錄影中不能改解析度，停止後再調整',
  'settings.badMaxMinutes': '單段上限要是 {min}～{max} 之間的整數（分鐘）',
  'settings.maxWhileRecording': '錄影中不能改單段上限，停止後再調整',
  'settings.badGuide': '不支援這種輔助框',
  'settings.portraitBool': '人像設定只能是開或關',
  'settings.portraitWhileRecording': '錄影中不能改人像設定，停止後再調整',
  'settings.badLanguage': '不支援這個語言',

  // 影片失敗的原因：伺服器自己判斷的，和手機回報的（手機用代碼回報，detail 是系統給的技術訊息）
  'fileError.removed': '這支手機已經從電腦上移除，影片還在手機上。重新配對後會自動補傳',
  'fileError.noStart': '手機沒有回應開始錄影。如果它其實有在錄，連回來後會自動補傳',
  'fileError.lost': '手機斷線後一直沒有連回來，影片還在手機上。手機連回來後會自動補傳',
  'fileError.stoppedUnknown': '手機已經停止錄影，但電腦沒收到停止的通知，也還沒收到影片。手機連回來後會自動補傳',
  'fileError.phone.busy': '這支手機已經在錄影',
  'fileError.phone.cameraNotReady': '相機還沒準備好：請把手機上的 App 打開放在前景',
  'fileError.phone.unsupportedResolution': '手機不支援這個解析度，請在「錄影規格」改低一點',
  'fileError.phone.startFailed': '開始錄影失敗：{detail}。可以再按一次開始；一直失敗的話，請重新打開手機上的 App',
  'fileError.phone.cancelled': '還沒開始就取消了',
  'fileError.phone.notFinalized': '錄影沒有正常結束，影片可能無法播放：{detail}',
  'fileError.phone.appClosed': 'App 在錄影中被關掉，這支影片沒有正常收尾、無法播放。錄影時請把 App 留在前景，手機接上充電器',
  'fileError.phone.recorderError': '手機錄影發生錯誤：{detail}。手機太熱或空間不夠時常會這樣，讓手機休息一下、清出空間再試',

  'log.dashboard': '控制台：{url}',
  'log.phones': '手機連線位址：{url}',
  'log.noIp': '找不到區域網路 IP，手機會連不到',
  'log.folder': '錄影資料夾：{dir}',
  'log.keepOpen': '錄影時這個視窗要一直開著，關掉就會停止。',
  'log.portInUse': '多機錄影已經在執行了（連接埠 {port} 被占用），直接打開 {url} 就好',
};

const EN: Record<string, Message> = {
  'html.lang': 'en',
  'list.sep': ', ',
  'punct.colon': ': ',
  'unit.min': '{n} min',
  'unit.sec': '{n} s',

  'trash.name': isWin ? 'Recycle Bin' : 'Trash',
  'disk.goodFormats': isMac ? 'APFS or exFAT' : isWin ? 'NTFS or exFAT' : 'exFAT or ext4',
  'disk.hfs': 'Mac OS Extended',
  'disk.fat32': "This drive is formatted as FAT32, which can't store files over 4 GB. Reformat it as {formats}.",
  'dir.volumeMissing': "Can't find {volume}. The external drive may not be connected.",
  'dir.notFound': 'Folder not found: {dir}',
  'dir.notFolder': 'Not a folder: {dir}',
  'dir.notWritable': 'No permission to write to this folder: {dir}',
  'dir.unreadable': "Can't read how much space this folder has: {error}",
  'trash.noGio': "The gio command isn't available on this computer, so files can't be moved to the Trash.",

  'http.tooLarge': 'The request is too large.',
  'http.badJson': 'Invalid JSON.',
  'http.fileNotFound': 'File not found.',
  'http.notFound': 'Not found.',
  'http.localOnly': 'This can only be done on the computer running the server.',
  'http.crossSite': "This request didn't come from the dashboard, so it was blocked (to stop other web pages from controlling your recordings).",
  'http.unsupported': 'Unsupported operation.',

  'upload.fileNotFound': 'File not found.',
  'upload.auth': 'Device authentication failed.',
  'upload.done': 'This file has already been uploaded.',
  'upload.badOffset': 'Invalid offset.',
  'upload.badSize': 'Invalid size.',
  'upload.offsetTooFar': 'The offset is beyond what has been received.',
  'upload.incomplete': "The file hasn't been fully uploaded yet.",
  'upload.finishFirst': 'Call finish first.',
  'upload.chunkSize': 'chunkSize must be {size}.',
  'upload.hashCount': 'hashes should have {count} entries.',

  'device.unpaired': "This phone isn't paired. Scan the QR code again.",
  'device.removedByComputer': 'This phone was removed from the computer. Scan the QR code again to use it.',
  'device.notFound': 'Phone not found.',
  'device.removeWhileRecording': 'This phone is recording. Stop it before removing it.',
  'device.badZoom': 'Invalid zoom ratio.',
  'device.nameLength': 'Names must be 1 to 40 characters.',

  'pair.noIp': "Can't find this computer's local network IP. Make sure it's connected to a network.",
  'pair.expired': 'This QR code has expired. Create a new one on the computer.',
  'pair.badDeviceId': 'Invalid deviceId.',
  'pair.tooMany': 'You can pair up to {max} phones. Remove one you no longer use on the computer first.',

  'pairPage.title': 'Pair with MultiCam Recorder',
  'pairPage.iosTitle': 'Android only for now',
  'pairPage.iosBody': "The MultiCam Recorder phone app is only available for Android, so iPhones can't be used as cameras yet.",
  'pairPage.heading': 'Pair this phone',
  'pairPage.body': 'The button opens the MultiCam Recorder app and pairs it automatically.',
  'pairPage.button': 'Open the app and pair',
  'pairPage.noApp': "Don't have the app yet?",
  'pairPage.step1': (p) =>
    `Tap the button above, or <a href="${p.url}">download the APK</a> directly. Open the download to install it; the first time, Android asks you to allow your browser to install apps.`,
  'pairPage.step2': 'After installing, come back to this page and tap “Open the app and pair” again.',
  'pairPage.verify': (p) =>
    `The app doesn't come from Google Play, so a Google Play Protect warning is expected. The release signing certificate's SHA-256 fingerprint is <code>${p.fp}</code>.`,
  'pairPage.validity': 'This QR code is valid for 10 minutes. If it expires, click “Pair phone” on the computer to create a new one.',
  'pairPage.expiredTitle': 'This QR code has expired',
  'pairPage.expiredBody': 'Click “Pair phone” on the computer and scan the new QR code.',

  'rec.needProject': 'Create a project first.',
  'rec.offline': '{name} is offline',
  'rec.busy': '{name} is already recording',
  'rec.cameraNotReady': "{name}'s camera isn't ready",
  'rec.noPhones': 'No phones are paired yet.',
  'rec.stopQueued': "{name} is offline. It'll stop as soon as it reconnects",
  'rec.nothingRecording': 'No phones are recording.',
  'rec.lowPhoneSpace':
    '{name} only has room for about {left} (this take can run up to {max}), so it will stop partway. Tap “Clear uploaded videos” on the phone, or pick a lower resolution',
  'rec.lowBattery': "{name} is at {battery}% and isn't charging, so it may die mid-take. Plug in a charger first",
  'rec.fileLimit':
    '{name} can only record about {size} per video, which is about {left} at this resolution (this take can run up to {max}). To record longer, pick a lower resolution under Recording settings',
  'rec.lowComputerSpace':
    'The recording folder only has {free} free and this take may need up to {need}, so uploads may run out of room. Free up space, or choose another folder in Settings',

  'project.nameLength': 'Project names must be 1 to 60 characters.',
  'project.nameChars': 'Project names can\'t contain / \\ : * ? " < > | or start or end with a period.',
  'project.reserved': '“{name}” is a reserved name on Windows. Choose another name.',
  'project.switchWhileRecording': "You can't switch projects while recording. Stop first.",
  'project.badRoot': "The recording folder can't be used: {error}",
  'project.exists': 'A project with this name already exists. Open it from the project list.',
  'project.notFound': 'Project not found.',
  'project.endWhileRecording': "You can't end the project while recording. Stop first.",
  'project.none': "There's no project yet.",

  'folder.prompt': 'Choose a recording folder (an external SSD is recommended)',
  'folder.busy': 'The folder picker is already open.',
  'folder.unsupported': 'This system has no folder picker. Paste the path instead.',
  'folder.failed': "Couldn't open the folder picker: {error}",

  'files.noneSelected': 'No clips selected.',
  'files.missing': "Couldn't find a clip to delete. The list may have changed.",
  'files.busy': "{name} is still recording or uploading and can't be deleted.",
  'files.trashFailed': (p) => `${p.count} ${p.count === 1 ? "clip couldn't" : "clips couldn't"} be moved to the ${p.trash}${p.reason ?? ''}`,
  'file.notFound': 'Clip not found.',
  'file.notReady': "This clip hasn't finished uploading.",
  'path.notFound': 'Not found: {path}',
  'take.notFound': 'Take not found.',

  'trim.needFfmpeg': 'Trimming needs ffmpeg. Run {cmd} in a terminal, then try again.',
  'trim.clipMissing': "Couldn't find this clip. The list may have changed.",
  'trim.badRange': 'Invalid range. Keep at least 1 second.',
  'trim.busy': 'This take is already being trimmed. Please wait.',
  'trim.notCovered': "{name} didn't record this part",
  'trim.failed': "Couldn't trim {name}: {error}. Nothing in this take was trimmed, and the original clips are untouched.",
  'trim.timeout': "ffmpeg didn't finish within {minutes} min, so it was stopped. If the clips are on an external drive, make sure it's still connected.",

  'settings.badResolution': 'Unsupported resolution.',
  'settings.resolutionWhileRecording': "You can't change the resolution while recording. Stop first.",
  'settings.badMaxMinutes': 'The take length must be a whole number of minutes from {min} to {max}.',
  'settings.maxWhileRecording': "You can't change the take length while recording. Stop first.",
  'settings.badGuide': 'Unsupported framing guide.',
  'settings.portraitBool': 'Portrait settings must be on or off.',
  'settings.portraitWhileRecording': "You can't change portrait settings while recording. Stop first.",
  'settings.badLanguage': 'Unsupported language.',

  'fileError.removed': "This phone was removed from the computer. The video is still on the phone and will upload after it's paired again.",
  'fileError.noStart': "The phone didn't respond to the start command. If it was actually recording, the video will upload when it reconnects.",
  'fileError.lost': 'The phone disconnected and never reconnected. The video is still on the phone and will upload when it reconnects.',
  'fileError.stoppedUnknown': "The phone stopped recording, but the computer didn't get the stop message or any video yet. It will upload when the phone reconnects.",
  'fileError.phone.busy': 'This phone is already recording.',
  'fileError.phone.cameraNotReady': "The camera isn't ready. Open the app on the phone and keep it in the foreground.",
  'fileError.phone.unsupportedResolution': "The phone doesn't support this resolution. Pick a lower one under Recording settings.",
  'fileError.phone.startFailed': "Couldn't start recording: {detail}. Try starting again; if it keeps failing, reopen the app on the phone.",
  'fileError.phone.cancelled': 'Canceled before it started.',
  'fileError.phone.notFinalized': "The recording didn't finish properly and may not play: {detail}",
  'fileError.phone.appClosed':
    "The app was closed while recording, so this video wasn't finalized and can't be played. Keep the app in the foreground and the phone on a charger while recording.",
  'fileError.phone.recorderError': 'Recording error on the phone: {detail}. This often happens when the phone is too hot or out of space. Let it cool down or free up space, then try again.',

  'log.dashboard': 'Dashboard: {url}',
  'log.phones': 'Phones connect to: {url}',
  'log.noIp': "No local network IP found; phones won't be able to connect.",
  'log.folder': 'Recording folder: {dir}',
  'log.keepOpen': 'Keep this window open while recording. Closing it stops MultiCam Recorder.',
  'log.portInUse': 'MultiCam Recorder is already running (port {port} is in use). Just open {url}.',
};

const MESSAGES: Record<Lang, Record<string, Message>> = { 'zh-TW': ZH, en: EN };

// 手機用代碼回報的失敗原因（舊版 App 直接送中文訊息，沒有代碼）
export const PHONE_ERRORS = ['busy', 'cameraNotReady', 'unsupportedResolution', 'startFailed', 'cancelled', 'notFinalized', 'appClosed', 'recorderError'];

export function m(key: string, params: Params = {}, lang: Lang = currentLang()): string {
  const entry = MESSAGES[lang][key] ?? ZH[key];
  if (entry === undefined) return key;
  if (typeof entry === 'function') return entry(params);
  return entry.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''));
}

export const joinList = (items: string[]): string => items.join(m('list.sep'));
