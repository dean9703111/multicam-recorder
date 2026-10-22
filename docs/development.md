# 開發者文件

這份文件寫給想修改程式、自己編譯 App，或是想讓其他平台接上多機錄影（MultiCam Recorder）的開發者。一般使用請看 [README](../README.md)。

## 架構

![運作方式：電腦當控制台，手機當攝影機，全部走同一個 Wi-Fi](images/how-it-works.png)

- **電腦端**（`server/`）：Node.js 24 直接執行 TypeScript，不用編譯。同一個程式提供網頁控制台、手機的 WebSocket 連線和影片上傳的 HTTP API。
  - 控制台只接受這台電腦上、控制台自己的網頁：連線要來自本機，Host 要是本機的名稱（擋 DNS rebinding），瀏覽器帶的 Origin 要和 Host 一樣，POST 只收 JSON（擋其他網頁的跨站請求）。手機用的 API（配對、上傳、`/ws/device`）區網可以連，靠配對碼和 token 驗證。見 `server/http.ts` 的 `fromDashboard`。
  - 配對、專案和設定存在使用者資料夾：macOS 是 `~/Library/Application Support/MultiCamRecorder`、Windows 是 `%APPDATA%\MultiCamRecorder`、Linux 是 `~/.local/share/multicam-recorder`（`platform.ts` 的 `userDataDir`）。下載新版放到別的資料夾也不用重新配對；v0.5.0 和更早的版本放在程式資料夾的 `data/`，第一次啟動時會自動複製過去。
  - 存檔時先寫暫存檔、`fsync` 後再改名，寫不進去（例如硬碟滿了）不會讓伺服器停掉，會在控制台提醒並自動重試。每次成功啟動都會把 `db.json` 備份成 `db.json.bak`；檔案壞掉時改用備份，壞掉的那份另外留著。
  - 重要的事件（手機連線、開始、停止、失敗、驗證、裁剪、存檔失敗）記在同一個資料夾的 `server.log`（超過 2 MB 換新檔），出問題時可以看發生過什麼。不記 token，家目錄換成 `~`。
- **網頁控制台**（`server/public/`）：Preact＋htm，不用打包。
- **手機 App**（`android/`）：Kotlin，Camera2＋MediaRecorder。錄影用的 surface 一開始就放進相機的 session，開始錄影只要切換 request，啟動延遲短而且穩定。
- **通訊格式**：WebSocket 傳指令、狀態、對時和即時畫面；HTTP 分段上傳影片並驗證。完整格式在 [`server/protocol.ts`](../server/protocol.ts)，其他平台照著實作就能接上；[`tools/fake-phone.ts`](../tools/fake-phone.ts) 是參考實作。

## 自己編譯 App

用 Homebrew 安裝 JDK 和 Android SDK，不需要裝整個 Android Studio：

```sh
brew install openjdk@21
brew install --cask android-commandlinetools
export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
yes | sdkmanager --sdk_root="$HOME/Library/Android/sdk" --licenses
sdkmanager --sdk_root="$HOME/Library/Android/sdk" "platform-tools" "platforms;android-37.0" "build-tools;36.0.0"
echo "sdk.dir=$HOME/Library/Android/sdk" > android/local.properties
```

手機開啟「USB 偵錯」：

- Pixel：「設定 → 關於手機」連按「版本號碼」7 次，再到「設定 → 系統 → 開發人員選項」打開「USB 偵錯」。
- ASUS：在「設定」裡找到「軟體資訊」（通常在「設定 → 系統 → 關於手機」裡面），連按「版本號碼」7 次，再到「設定 → 系統 → 開發人員選項」打開「USB 偵錯」。

用 USB 線接上電腦，手機跳出「要允許 USB 偵錯嗎？」時，勾選「一律允許」後按「允許」，然後執行：

```sh
npm run android:build
npm run android:install
```

`android:build` 會產生 `android/app/build/outputs/apk/debug/app-debug.apk`，`android:install` 會把它裝到所有已接上、已允許偵錯的手機。

Windows 上請改用 `cd android` 再 `gradlew.bat :app:assembleDebug`（`JAVA_HOME` 要指到 JDK 21，`android/local.properties` 寫上 Android SDK 的位置），再用 `adb install -r app\build\outputs\apk\debug\app-debug.apk` 安裝。

> [!WARNING]
> 自己編譯的 debug 版和 Releases 上的正式版簽章不同，不能互相覆蓋安裝，要換的話得先解除安裝。**解除安裝會一起刪掉 App 裡的影片**，請先確認都已經傳到電腦。

## 不用手機也能測試

`tools/fake-phone.ts` 是模擬手機，會用 ffmpeg 產生測試影片：流動的漸層加上一圈刻度，白點每 3 秒繞一圈，下方有音量表，聲音是每秒嗶一聲。兩支模擬手機同時開始時，白點的位置和嗶聲都會對齊；顏色依手機名稱而定，方便分辨。它也會送即時畫面、支援 1× 到 4× 的變焦，加上 `--orientation portrait` 就是直拿的手機，走的流程和真正的手機完全一樣（需要先安裝 ffmpeg，例如 `brew install ffmpeg`）。啟動電腦端後，另外開兩個終端機：

```sh
npm run fake-phone -- --model "ASUS_AI2203" --tone 440 --mic usb --mic-name "USB Audio"
npm run fake-phone -- --model "Pixel 11 Pro" --tone 660 --orientation portrait
```

`--mic` 是回報給電腦的收音來源（`builtin`、`usb`、`wired`、`other`，預設 `builtin`），`--mic-name` 是外接麥克風的名稱；`--lang en` 模擬系統語言是英文的手機（預設 `zh-TW`），電腦送給它的訊息就會是英文。

測試「出問題時」的畫面用這幾個：

| 參數 | 模擬什麼 |
| --- | --- |
| `--silent` | 錄影中沒有聲音（超過 10 秒控制台會提醒） |
| `--hot` | 手機太熱（發熱等級 3） |
| `--free-gb 2` | 手機只剩 2 GB，開始前會先問要不要照樣錄 |
| `--max-resolution 1080p` | 錄不到 4K 的手機，選 4K 或 2K 時改錄 1080p，卡片上會寫出來 |
| `--offline-after 1000 --offline-for 15000` | 開始錄影 1 秒後斷線 15 秒，WebSocket 和上傳都連不上，手機照樣錄 |

測試用的環境變數：

| 變數 | 用途 |
| --- | --- |
| `PORT` | 伺服器的連接埠，預設 8787 |
| `RECORDER_MAX_SEC` | 單支上限秒數，設了就不管控制台設的單段上限 |
| `RECORDER_WARN_SEC` | 剩多少秒時提醒，預設 180 |
| `RECORDER_LOST_GRACE_SEC` | 錄影中斷線、超過上限多久還沒連回來就當成失聯，預設 60 |
| `RECORDER_DATA_DIR` | 配對、專案和設定存放的位置，預設是使用者資料夾（見上面的架構）。測試時指到別處，就不會動到正式資料 |

例如 `RECORDER_MAX_SEC=40 RECORDER_WARN_SEC=15 npm start`，40 秒就會自動停止。

`npm start` 會帶 `--open`：啟動 3 秒後如果沒有控制台分頁連上來，就用預設的瀏覽器打開控制台；重新啟動時，開著的分頁會自己連回來，不會多開一個。不想自動打開的話，改用 `node server/server.ts`。

`npm run demo` 再多帶 `--demo`，給使用者示範第一次怎麼設定：配對、專案和設定改存在系統暫存資料夾裡新建的 `multicam-demo-…`，也不搬舊版程式資料夾裡的 `data/db.json`。連接埠被占用時只提醒先關掉開著的那個，不會像 `npm start` 一樣直接打開它，免得示範時開到正式的控制台。有設 `RECORDER_DATA_DIR` 的話以它為準。

## 自動測試

- `npm run typecheck`：型別檢查。
- `npm run check`（[`tools/check.ts`](../tools/check.ts)）：控制台 JS 的語法、三套中英文字串的鍵有沒有對齊、各處的版本號和網站日期是否一致，以及 README、網站寫的簽章憑證指紋。英文少了某一句時控制台會退回顯示中文，不會出錯，所以要靠這個擋下來。
- `npm run smoke-test`：自己開伺服器和兩支模擬手機（一支橫拿、一支直拿），大約 40 秒，把這些都跑一遍：
  - 錄影資料夾（還沒儲存就查得到剩多少空間）、配對、即時畫面、變焦、人像設定、錄不到所選解析度的手機事先回報、兩支同時錄影（從手機真的開始錄才計時）、傳檔驗證、裁剪（含拍攝時間和時間碼）、播放的 Range 請求、專案、標記、移到垃圾桶、刪檔同步、改名、移除手機、中英文訊息。
  - 擋下跨站請求、DNS rebinding、區網其他裝置的請求；壞掉的請求和訊息不會讓伺服器停掉。
  - 手機空間不夠時開始前會先問；手機錄到一半斷線、電腦端又重開一次，手機連回來後影片照樣傳完，也記得是到上限自動停止。

  測試資料放在暫存資料夾，跑完就清掉；只有兩支幾秒鐘的測試影片會留在系統的垃圾桶裡。

GitHub Actions 每次推送都會在 Windows、macOS、Linux 上各跑一次（[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)），Windows 上也會確認中文的資料夾路徑、NTFS 偵測和資源回收筒；另外編一次手機 App。

## 人像設定

臉部優先、鎖定曝光都只是在相機的 request 上設定，交給手機的相機處理，不經過 App 自己的影像處理，所以畫質不變（[`CameraRecorder.kt`](../android/app/src/main/kotlin/dev/multicam/recorder/CameraRecorder.kt)）：

- **臉部優先**：`CONTROL_MODE_USE_SCENE_MODE`＋`CONTROL_SCENE_MODE_FACE_PRIORITY`。有臉部偵測的手機都會在 `CONTROL_AVAILABLE_SCENE_MODES` 列出它，而且自動曝光、白平衡、對焦照常運作。
- **鎖定曝光和白平衡**：`CONTROL_AE_LOCK`、`CONTROL_AWB_LOCK` 只加在錄影的 request 上，開始錄影的那一刻鎖住，停止後恢復自動。它不影響 session，切換時相機不用重開。
- Pixel 的 `sceneMode` 是 session 參數（`availableSessionKeys`），所以建 session 時用 `SessionConfiguration.sessionParameters` 先帶上；臉部優先改了就重建 session，和改解析度一樣只在沒錄影時做。
- 背景虛化（`CONTROL_EXTENDED_SCENE_MODE_BOKEH_CONTINUOUS`）在 v0.4.0、v0.4.1 試做過，v0.4.2 拿掉：只有少數手機有，還有解析度上限（Pixel 11 Pro 只到 1080p），開了之後變焦範圍也會變小，效果不穩定。

想知道某支手機做得到哪些，接上 USB 後用唯讀的 dumpsys 查（不會改手機的設定）：

```sh
adb shell dumpsys media.camera | grep -A3 "availableSceneModes\|aeLockAvailable\|awbLockAvailable"
```

`availableSceneModes` 裡有 `1` 就是做得到臉部優先。App 開著時，同一個指令輸出的「Last request sent」也看得到實際送出的 `android.control.mode`、`sceneMode`、`aeLock`。Android 模擬器的相機兩個都做得到。

## 裁剪

控制台的「裁剪…」是一條時間軸（`server/public/app.js` 的 `TrimBar`）：縮圖用一個看不到的 video 依序跳到 10 個位置畫出來，兩個把手（也能用方向鍵微調）設定開頭和結尾，拖的時候監看區跟著跳到那一格，「播放這段」會播到結尾就停。按下「裁剪」呼叫 `POST /api/takes/:takeId/trim`（`{ fileId, start, end }`，秒數是在 fileId 那支影片上的位置），由電腦端的 `trimTake`（[`server/server.ts`](../server/server.ts)）處理：

- 用電腦上的 ffmpeg 串流複製（`-c copy`），不重新壓縮，所以畫質不變、幾 GB 的檔案也只要幾秒。啟動時 `checkFfmpeg` 會找 `ffmpeg` 和 `ffprobe`，找不到時 `state.ffmpeg` 是 false，按「裁剪…」會跳出安裝說明（`FfmpegModal`，依 `state.platform` 只列那個系統的指令）。
- 安裝說明裡的「重新檢查」呼叫 `POST /api/ffmpeg/check` 再找一次：先找 PATH，再找剛裝好時可能在的資料夾（`platform.ts` 的 `toolDirs`：macOS 是 Homebrew 的 `/opt/homebrew/bin`、`/usr/local/bin`，Windows 從登錄檔讀最新的 PATH，Linux 是 `/usr/bin`、`/snap/bin`），因為執行 `npm start` 的終端機還是舊的 PATH。找到的完整路徑記在 `tools`，之後裁剪都用它。
- 串流複製只能從關鍵影格開始，所以先用 `ffprobe -read_intervals` 只讀開頭附近的封包，找到開頭（含）之前最近的關鍵影格，從那裡裁。手機的 MediaRecorder 大多每 1 秒一個關鍵影格、沒有 B 影格，結尾可以照設定的時間裁。
- 同一段的其他手機用 `startedAt` 的差換算成各自的時間軸，裁的是同一段時間；各台的關鍵影格位置不同，裁好的幾支開始時間會差零點幾秒，新檔的 `startedAt` 記的是實際的開始時間，清單上照樣顯示時間差。
- 新檔放在同一個資料夾，檔名是原檔名加 `_1`，已經有就 `_2`、`_3`…（`trimmedName`）；先寫成 `.part` 再改名。新檔屬於新的一段（新的 `takeId`），`trimmedFrom` 記著原本那支，原檔不動。裁出來的影片不會觸發「錄完自動播放」，只有按下裁剪的那一台會換成播放新檔。
- `npm run smoke-test` 會裁兩次同一段，確認每台都產生 `_1`、`_2`、長度合理、原檔還在，也確認少於 1 秒的範圍會被擋下。

## 介面語言（繁體中文、英文）

控制台、伺服器的訊息、配對網頁和手機 App 都有繁體中文和英文。控制台、伺服器和配對網頁遇到中文（不分地區）一律用繁體中文，其他語言一律用英文；手機 App 只有繁體中文的手機顯示中文（見下面）。

- **控制台**：文字集中在 [`server/public/i18n.js`](../server/public/i18n.js)，用 `tr(key, params)` 取用；句子裡有按鈕或標籤的寫成函式，回傳 htm 片段。語言預設跟著瀏覽器，右上角的按鈕可以一鍵切換，切換後記在設定裡（`language` 是 `auto`、`zh-TW` 或 `en`）。上次用的語言記在 localStorage，連上伺服器之前先用它，畫面才不會閃一下另一種語言。
- **伺服器**：錯誤訊息、配對網頁、終端機的訊息集中在 [`server/i18n.ts`](../server/i18n.ts)，用 `m(key, params)` 取用。每個請求用自己的語言（AsyncLocalStorage）：控制台送 `X-Lang`，手機的瀏覽器和 App 送 `Accept-Language`。推給控制台的狀態依每個分頁的語言各算一次；影片失敗的原因存成代碼（`errorCode`、`errorParams`），送出時才換成那個分頁的語言。終端機用設定的語言，自動時看電腦的系統語言。
- **手機 App**：文字在 `res/values/strings.xml`（英文，手機是其他語言時也用它）和 `res/values-b+zh+Hant/`（繁體中文，台灣、香港、澳門的手機會用）；直拿時比較窄，短一點的字在 `values-port/`、`values-b+zh+Hant-port/`。**不能只寫 `values-zh`**：Android 7.0 起沒寫字體的 `zh` 會被當成簡體，台灣的手機反而顯示英文。簡體中文的手機顯示英文；App 告訴電腦的語言是畫面上實際用的那一種（`language_tag`），電腦送來的訊息才會一致。Android 13 起可以在系統設定單獨替 App 選語言（`res/xml/locales_config.xml`）。送給電腦的請求都帶 `Accept-Language`，`hello` 也帶 `lang`；錄影失敗用代碼回報（`code`、`detail`），由電腦換成控制台的語言。
- **新增或修改文字**：兩種語言要一起改。英文少了某一句時會退回顯示中文，不會出錯，所以要自己切到英文看一遍；`npm run smoke-test` 會檢查錯誤訊息、配對網頁和狀態文字有跟著語言走。

## 開發時不用掃 QR Code

App 的 debug 版可以用 adb 直接傳入 QR Code 的網址：

```sh
adb shell am start -n dev.multicam.recorder/.MainActivity --es qr 'http://<電腦的 IP>:8787/pair?code=<配對碼>'
```

正式版不接受這個參數，但可以用配對網頁同樣的連結：

```sh
adb shell am start -a android.intent.action.VIEW -d 'multicam://pair?server=http%3A%2F%2F<電腦的 IP>%3A8787&code=<配對碼>'
```

在 Android 模擬器上轉向用 `adb emu rotate`；想看窄一點的手機，可以用 `adb shell wm density 480`（1080 像素寬的螢幕會變成 360 dp），測完用 `adb shell wm density reset` 改回來。

## 檔案結構

```
server/                    電腦端（Node.js 24 直接執行 TypeScript，不用編譯）
  server.ts                手機連線、錄影控制、專案、接收影片、裁剪、提供網頁
  http.ts                  HTTP 小工具：讀 JSON、送檔案（含 Range）、fromDashboard（只收控制台自己的請求）
  protocol.ts              手機和電腦之間的通訊格式，Android App 照這份實作
  uploads.ts               邊錄邊傳、分段雜湊驗證
  store.ts                 配對、專案、影片清單、設定的存檔（使用者資料夾的 db.json，含備份）
  events.ts                事件記錄（server.log）
  platform.ts              各作業系統不一樣的地方：資料夾位置、硬碟格式、垃圾桶、打開網址、PowerShell
  i18n.ts                  伺服器送出的文字（錯誤訊息、配對網頁、終端機），繁體中文和英文
  public/                  網頁控制台（Preact + htm，不用打包），文字在 public/i18n.js
android/app/src/main/
  kotlin/.../CameraRecorder.kt     Camera2 預覽與錄影、變焦、對焦和曝光鎖定、選擇麥克風、音量
  kotlin/.../ServerLink.kt         和電腦的 WebSocket 連線、對時、送即時畫面
  kotlin/.../Uploader.kt           邊錄邊傳、驗證、補傳；電腦不認得的影片交給 Store.orphans
  kotlin/.../Store.kt              App 自己的存檔：配對資料、還沒傳完的影片、沒傳到電腦的影片
  kotlin/.../GuideOverlay.kt       預覽上的構圖輔助框
  kotlin/.../AspectFrameLayout.kt  讓預覽維持錄影的長寬比
  kotlin/.../MainActivity.kt       畫面與整體流程、跟著手機轉向、擷取即時畫面、對話框
  res/layout/overlay.xml           橫拿時的狀態列；直拿的在 layout-port/
  res/values/strings.xml           App 的文字（英文）；繁體中文在 values-b+zh+Hant/，直拿時的短字在 values-port/、values-b+zh+Hant-port/
tools/
  fake-phone.ts            模擬手機，也是通訊格式的參考實作
  smoke-test.ts            端對端測試，CI 在三種作業系統上跑
  check.ts                 一致性檢查：控制台 JS 語法、中英文字串、版本號和日期
  install-android.sh       把 APK 裝到所有接上的手機
docs/                      產品網站（GitHub Pages），也放 README 的圖和文件
  index.html、en/          產品網站的中英文頁面
  assets/                  網站的樣式、字型、圖示
  images/                  README 和網站共用的截圖和示意圖
  mockups.html             示意圖的原稿
  development.md           這份文件
.github/
  workflows/ci.yml         每次推送都跑的檢查（見「自動測試」）
  ISSUE_TEMPLATE/          回報問題的表單（中英文）
CONTRIBUTING.md            參與開發的說明
llms.txt                   給 AI 工具讀的專案摘要
```

## 傳輸流程

1. 錄影中：手機每次把檔案已經寫好的部分用 `PUT /api/upload/:fileId?offset=N` 傳給電腦，最後 256 KB 先保留，因為可能還在寫入。
2. 停止後：傳完剩下的部分 → `POST finish` → 雙方同時把整個檔案以 16 MB 分段算 SHA-256 → `POST verify`。不一樣的分段會補傳，直到完全相同。MP4 在停止時會改寫檔頭，所以第 0 段幾乎一定要補傳一次。
3. 驗證通過後，電腦把 `.part` 改名成 `.mp4`，網頁就能播放。

幾個特別要注意的情況（`server/protocol.ts` 開頭有完整的規則）：

- **重送不會出錯**：手機沒收到回應就會重送。影片已經傳完的話，查詢會回完整大小，`finish`、`verify` 直接回成功，`PUT` 回 409 並附上電腦已經收到的大小，手機就知道不用再傳。
- **電腦不認得的影片（404）**：例如在控制台把傳輸失敗的影片移到了垃圾桶，或電腦端的存檔壞掉又沒有備份。手機不會一直重試，也不會刪掉檔案，而是把它交給 `Store.orphans`：狀態列寫「有 N 支影片沒傳到電腦」，點一下可以存到手機的「影片」資料夾（`Movies/MultiCamRecorder`，解除安裝 App 也不會被刪）。
- **電腦端重開**：還在傳、手機之後會補傳的影片不會被清掉，控制台寫「等這支手機連回來補傳」。

## 產品網站

`docs/` 整個資料夾就是產品網站，由 GitHub Pages 從 `main` 分支的 `/docs` 發佈。作者的 GitHub 個人網站設了自訂網域，所以網址是 <https://deanlin.net/multicam-recorder/>（英文版在 `/en/`）。

- `index.html`、`en/index.html`：中英文頁面，內容和 README 一致；`assets/` 是共用的樣式、字型（Barlow、Martian Mono，OFL 授權）和圖示，圖片直接用 `docs/images/`。
- 每頁的 `<head>` 有 SEO 標籤（title、description、canonical、hreflang、Open Graph）和 JSON-LD（SoftwareApplication、FAQPage）。**改了頁面上的常見問題，JSON-LD 裡的 FAQPage 也要跟著改**，兩邊的文字要一樣。
- `sitemap.xml`、`llms.txt`（給 AI 工具讀的摘要）、`404.html`；`.nojekyll` 讓 GitHub Pages 不經過 Jekyll，直接發佈檔案。
- 作者的社群帳號（Medium、Facebook、Threads、YouTube、GitHub）出現在：兩頁頁尾的「追蹤作者」、兩頁 JSON-LD 的 `Person`（`@id` 是 `https://deanlin.net/#person`，和作者其他專案的網站共用同一個，搜尋引擎才會把它們當成同一個人）、README 的「關於作者」和英文段落、兩份 `llms.txt`。帳號有變動時這幾處要一起改。
- 頁面上的對比圖（各自按 vs 按一次 R、裁切 vs 直拿、一般自動 vs 臉部優先、不鎖定 vs 鎖定、錄完再傳 vs 邊錄邊傳、串流 vs 在手機上錄）是直接寫在 HTML 裡的 SVG 加 CSS 動畫，不是圖片，所以中英文頁各有一份，**文字要兩頁一起改**。訪談場景的插圖放在頁首的 `<svg class="sprite">`（`#sc-land` 橫、`#sc-port` 直），用 `<use>` 重複使用。
- 動畫的規則寫在 `assets/site.css` 的「動態效果」和 `assets/site.js`：捲到畫面裡才播（`.viz` 加上 `.is-playing`），播一次就停在最後一格，旁邊有「重播」。`<head>` 的一行程式判斷系統的「減少動態效果」；沒有 JavaScript 或要求減少動態效果時，直接顯示最後一格，所以**元素平常的樣式就要是最後一格的樣子**，動畫只負責從頭播到那裡。
- 本機預覽：在 `docs/` 執行 `python3 -m http.server`，打開 <http://localhost:8000/>。
- 搜尋引擎只讀網域根目錄的 robots.txt，這個網站的 robots.txt 由 deanlin.net 那邊管理。

## 更新 README 的圖

- **示意圖**（how-it-works、pairing、phone-app、phone-app-portrait、use-cases、network、social-preview）的原稿都在 [`docs/mockups.html`](mockups.html)，英文版在 [`docs/mockups-en.html`](mockups-en.html)，**版面要兩份一起改**。在專案根目錄執行 `python3 -m http.server`，打開 <http://localhost:8000/docs/mockups.html>，用裝置像素比 1.5 把每個 section 各自截圖存到 `docs/images/`（social-preview 用 1 倍，剛好 1280×640）。截出來的上下邊緣如果多了一條灰線（section 的高度有小數），裁掉再存。
- **對比圖**（compare-sync、compare-pixels、compare-face-priority、compare-exposure-lock、compare-upload、compare-streaming）是從產品網站的中文頁截的：視窗 1440 寬、裝置像素比 1.5、開啟「減少動態效果」讓動畫直接停在最後一格，再各自截那個區塊。compare-streaming 截之前，先把左邊那張設成訊號變差的樣子（畫面模糊、方格、「畫質下降」、Wi-Fi 剩一格）。
- **控制台的截圖**（console、spec-guide、portrait-settings、trim、select-trash、setup）是用模擬手機實際操作截的；spec-guide 的視窗是 1440×760（英文的選單比較長，開到 1440×800，選單才不會被切掉）；portrait-settings 是規格選單「人像」那一段的放大特寫：視窗開成 2160×1140（英文 2160×1200）、`html` 設 `zoom: 1.5`，把選單裡「人像」以外的組藏起來（`.spec-group:not(:last-child) { display: none }`），再只截 `.spec-menu` 這個元素。console 是錄到 30 幾秒時截的，頂列會有 REC 計時、每台有音量表。電腦的硬碟空間不夠時，控制台上方會出現提醒，截圖前可以先把 `.alerts` 藏起來。
- **英文版的圖**檔名後面加 `-en`（例如 `console-en.png`），英文網站和 README 的英文段落用這些。控制台的截圖照同樣的步驟，只是把控制台切到英文、模擬手機加上 `--lang en`。中文版沒有對應英文圖的（trim、select-trash、對比圖）只用在 README 的中文段落。
- 截圖裡不要出現自己電腦的使用者名稱或私人路徑，例如錄影資料夾的完整路徑。用 CSS 換掉顯示的文字（例如 `.setup code { font-size: 0 } .setup code::before { content: "~/Movies/MultiCamRecorder" }`），直接改 DOM 的文字會在畫面重繪時被換回來。視窗有捲軸時加上 `* { scrollbar-width: none }`，版面才是完整的寬度。
- `social-preview.png`（1280×640）是分享連結時顯示的預覽圖，要到 GitHub 專案的 **Settings → General → Social preview** 手動上傳；`social-preview-en.png` 是英文網站的分享預覽圖。

## 發佈新版

照順序做，每一步都確認過再往下：

1. **改版本號**：`package.json` 的 `version`；手機 App 改了的話，遞增 `android/app/build.gradle.kts` 的 `versionCode` 和 `versionName`（App 回報的版本直接讀 `BuildConfig.VERSION_NAME`，不用另外改），並把 `server/server.ts` 的 `LATEST_APP_VERSION` 改成同一版，舊版 App 連上時控制台才會提示更新。
2. **改網站**：`docs/index.html`、`docs/en/index.html`（頁面上的「最新版」、頁尾和 JSON-LD 的 `softwareVersion`、`dateModified`），以及 `docs/sitemap.xml` 的 `lastmod`。
3. **本機檢查**：`npm run typecheck && npm run check && npm run smoke-test`。`check` 會擋下版本號或日期沒改齊的地方。
4. **推上去等 CI 綠燈**：三個作業系統的測試和 App 編譯都要通過。
5. **實機 5 分鐘檢查**：至少一支真的手機，配對 → 錄 1 分鐘 → 停止 → 影片傳完並能在控制台播放；App 改過的話，橫拿和直拿各錄一次。
6. **編正式版 APK**：用專用金鑰簽章，設定在 `android/keystore.properties`（不放進 git，沒有這個檔案就只能編 debug 版）。`cd android && ./gradlew :app:assembleRelease`，再用 `apksigner verify --print-certs` 確認憑證的 SHA-256 指紋和 `server/server.ts` 的 `APP_CERT_SHA256` 一樣（README「這個 App 安全嗎？」、網站和配對網頁也寫著同一串，`npm run check` 會比對）。
7. **先建草稿再發佈**：在 GitHub 建一個 draft release，附上 APK，檔名固定叫 `MultiCamRecorder.apk`，不要帶版號（配對網頁和網站的下載連結都指向 `releases/latest/download/MultiCamRecorder.apk`）。說明裡寫這一版改了什麼、APK 的 SHA-256（`shasum -a 256 MultiCamRecorder.apk`）和憑證指紋。下載草稿裡的 APK 裝一次確認沒問題，再按發佈。

提高 `targetSdk` 之前，要先處理 Android 16 的區網權限（Local Network Protection）：系統可能把連到區網裝置的連線改成需要執行期權限 `ACCESS_LOCAL_NETWORK`，沒宣告也沒請求的話，App 連不到電腦，等於整個不能用。要先實測，並把它加進配對流程的權限說明。
