# 開發者文件

這份文件寫給想修改程式、自己編譯 App，或是想讓其他平台接上多機錄影（MultiCam Recorder）的開發者。一般使用請看 [README](../README.md)。

## 架構

![運作方式：電腦當控制台，手機當攝影機，全部走同一個 Wi-Fi](images/how-it-works.png)

- **電腦端**（`server/`）：Node.js 24 直接執行 TypeScript，不用編譯。同一個程式提供網頁控制台、手機的 WebSocket 連線和影片上傳的 HTTP API。控制台只接受本機連線。
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
npm run fake-phone -- --model "ASUS_AI2203" --tone 440 --mic "外接 USB（USB Audio）"
npm run fake-phone -- --model "Pixel 11 Pro" --tone 660 --mic "手機內建" --orientation portrait
```

測試用的環境變數：

| 變數 | 用途 |
| --- | --- |
| `PORT` | 伺服器的連接埠，預設 8787 |
| `RECORDER_MAX_SEC` | 單支上限秒數，預設 1800（30 分鐘） |
| `RECORDER_WARN_SEC` | 剩多少秒時提醒，預設 180 |
| `RECORDER_DATA_DIR` | 配對和影片清單存放的位置，預設 `data/`。測試時指到別處，就不會動到正式資料 |

例如 `RECORDER_MAX_SEC=40 RECORDER_WARN_SEC=15 npm start`，40 秒就會自動停止。型別檢查用 `npm run typecheck`。

## 自動測試

`npm run smoke-test` 會自己開一個伺服器和兩支模擬手機（一支橫拿、一支直拿），把配對、即時畫面、變焦、人像設定、兩支同時錄影、裁剪、傳檔驗證、專案、標記、移到垃圾桶、刪檔同步、改名、移除手機都跑一遍，大約 15 秒。測試資料放在暫存資料夾，跑完就清掉；只有兩支幾秒鐘的測試影片會留在系統的垃圾桶裡。

GitHub Actions 每次推送都會在 Windows、macOS、Linux 上各跑一次（[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)），Windows 上也會確認中文的資料夾路徑、NTFS 偵測和資源回收筒。

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

- 用電腦上的 ffmpeg 串流複製（`-c copy`），不重新壓縮，所以畫質不變、幾 GB 的檔案也只要幾秒。啟動時會找 `ffmpeg` 和 `ffprobe`，找不到時 `state.ffmpeg` 是 false，網頁會提示怎麼裝。
- 串流複製只能從關鍵影格開始，所以先用 `ffprobe -read_intervals` 只讀開頭附近的封包，找到開頭（含）之前最近的關鍵影格，從那裡裁。手機的 MediaRecorder 大多每 1 秒一個關鍵影格、沒有 B 影格，結尾可以照設定的時間裁。
- 同一段的其他手機用 `startedAt` 的差換算成各自的時間軸，裁的是同一段時間；各台的關鍵影格位置不同，裁好的幾支開始時間會差零點幾秒，新檔的 `startedAt` 記的是實際的開始時間，清單上照樣顯示時間差。
- 新檔放在同一個資料夾，檔名是原檔名加 `_1`，已經有就 `_2`、`_3`…（`trimmedName`）；先寫成 `.part` 再改名。新檔屬於新的一段（新的 `takeId`），`trimmedFrom` 記著原本那支，原檔不動。裁出來的影片不會觸發「錄完自動播放」，只有按下裁剪的那一台會換成播放新檔。
- `npm run smoke-test` 會裁兩次同一段，確認每台都產生 `_1`、`_2`、長度合理、原檔還在，也確認少於 1 秒的範圍會被擋下。

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
  protocol.ts              手機和電腦之間的通訊格式，Android App 照這份實作
  uploads.ts               邊錄邊傳、分段雜湊驗證
  store.ts                 配對、專案、影片清單、設定的存檔（data/db.json）
  platform.ts              各作業系統不一樣的地方：硬碟格式、垃圾桶、PowerShell
  public/                  網頁控制台（Preact + htm，不用打包）
android/app/src/main/
  kotlin/.../CameraRecorder.kt   Camera2 預覽與錄影、變焦、選擇麥克風
  kotlin/.../ServerLink.kt       和電腦的 WebSocket 連線、對時、送即時畫面
  kotlin/.../Uploader.kt         邊錄邊傳、驗證、補傳
  kotlin/.../GuideOverlay.kt     預覽上的構圖輔助框
  kotlin/.../MainActivity.kt     畫面與整體流程、跟著手機轉向、擷取即時畫面
  res/layout/overlay.xml         橫拿時的狀態列；直拿的在 layout-port/，直拿時的短字在 values-port/
tools/
  fake-phone.ts            模擬手機，也是通訊格式的參考實作
  smoke-test.ts            端對端測試，CI 在三種作業系統上跑
  install-android.sh       把 APK 裝到所有接上的手機
docs/                      產品網站（GitHub Pages），也放 README 的圖和文件
  index.html、en/          產品網站的中英文頁面
  assets/                  網站的樣式、字型、圖示
  images/                  README 和網站共用的截圖和示意圖
  mockups.html             示意圖的原稿
  development.md           這份文件
llms.txt                   給 AI 工具讀的專案摘要
```

## 傳輸流程

1. 錄影中：手機每次把檔案已經寫好的部分用 `PUT /api/upload/:fileId?offset=N` 傳給電腦，最後 256 KB 先保留，因為可能還在寫入。
2. 停止後：傳完剩下的部分 → `POST finish` → 雙方同時把整個檔案以 16 MB 分段算 SHA-256 → `POST verify`。不一樣的分段會補傳，直到完全相同。MP4 在停止時會改寫檔頭，所以第 0 段幾乎一定要補傳一次。
3. 驗證通過後，電腦把 `.part` 改名成 `.mp4`，網頁就能播放。

## 產品網站

`docs/` 整個資料夾就是產品網站，由 GitHub Pages 從 `main` 分支的 `/docs` 發佈。作者的 GitHub 個人網站設了自訂網域，所以網址是 <https://deanlin.net/multicam-recorder/>（英文版在 `/en/`）。

- `index.html`、`en/index.html`：中英文頁面，內容和 README 一致；`assets/` 是共用的樣式、字型（Barlow、Martian Mono，OFL 授權）和圖示，圖片直接用 `docs/images/`。
- 每頁的 `<head>` 有 SEO 標籤（title、description、canonical、hreflang、Open Graph）和 JSON-LD（SoftwareApplication、FAQPage）。**改了頁面上的常見問題，JSON-LD 裡的 FAQPage 也要跟著改**，兩邊的文字要一樣。
- `sitemap.xml`、`llms.txt`（給 AI 工具讀的摘要）、`404.html`；`.nojekyll` 讓 GitHub Pages 不經過 Jekyll，直接發佈檔案。
- 頁面上的對比圖（各自按 vs 按一次 R、裁切 vs 直拿、一般自動 vs 臉部優先、不鎖定 vs 鎖定、錄完再傳 vs 邊錄邊傳、串流 vs 在手機上錄）是直接寫在 HTML 裡的 SVG 加 CSS 動畫，不是圖片，所以中英文頁各有一份，**文字要兩頁一起改**。訪談場景的插圖放在頁首的 `<svg class="sprite">`（`#sc-land` 橫、`#sc-port` 直），用 `<use>` 重複使用。
- 動畫的規則寫在 `assets/site.css` 的「動態效果」和 `assets/site.js`：捲到畫面裡才播（`.viz` 加上 `.is-playing`），播一次就停在最後一格，旁邊有「重播」。`<head>` 的一行程式判斷系統的「減少動態效果」；沒有 JavaScript 或要求減少動態效果時，直接顯示最後一格，所以**元素平常的樣式就要是最後一格的樣子**，動畫只負責從頭播到那裡。
- 本機預覽：在 `docs/` 執行 `python3 -m http.server`，打開 <http://localhost:8000/>。
- 搜尋引擎只讀網域根目錄的 robots.txt，這個網站的 robots.txt 由 deanlin.net 那邊管理。

## 更新 README 的圖

- **示意圖**（how-it-works、pairing、phone-app、phone-app-portrait、use-cases、network、social-preview）的原稿都在 [`docs/mockups.html`](mockups.html)。在專案根目錄執行 `python3 -m http.server`，打開 <http://localhost:8000/docs/mockups.html>，把每個 section 各自截圖存到 `docs/images/`。
- **對比圖**（compare-sync、compare-pixels、compare-face-priority、compare-exposure-lock、compare-upload、compare-streaming）是從產品網站的中文頁截的：視窗 1440 寬、裝置像素比 1.5、開啟「減少動態效果」讓動畫直接停在最後一格，再各自截那個區塊。compare-streaming 截之前，先把左邊那張設成訊號變差的樣子（畫面模糊、方格、「畫質下降」、Wi-Fi 剩一格）。
- **控制台的截圖**（console、spec-guide、portrait-settings、trim、select-trash、setup）是用模擬手機實際操作截的；portrait-settings 是規格選單「人像」那一段的放大特寫：視窗開成 2160×1140、`html` 設 `zoom: 1.5` 再截，版面和 1440×760 一樣但比較清楚。電腦的硬碟空間不夠時，控制台上方會出現提醒，截圖前可以先把 `.alerts` 藏起來。
- 截圖裡不要出現自己電腦的使用者名稱或私人路徑，例如錄影資料夾的完整路徑。
- `social-preview.png`（1280×640）是分享連結時顯示的預覽圖，要到 GitHub 專案的 **Settings → General → Social preview** 手動上傳。

## 發佈新版

- 手機 App 改了，就要遞增 `android/app/build.gradle.kts` 的 `versionCode` 和 `versionName`，以及 `ServerLink.kt` 的 `APP_VERSION`。
- 正式版用專用金鑰簽章，設定在 `android/keystore.properties`（不放進 git，沒有這個檔案就只能編 debug 版）。編譯：`cd android && ./gradlew :app:assembleRelease`。
- Release 附的檔案名稱固定叫 `MultiCamRecorder.apk`，不要帶版號：配對網頁的下載連結指向 `releases/latest/download/MultiCamRecorder.apk`。
- 產品網站上的版本號和日期也要更新：`docs/index.html`、`docs/en/index.html`（頁面上的「最新版」、頁尾和 JSON-LD 的 `softwareVersion`、`dateModified`），以及 `docs/sitemap.xml` 的 `lastmod`。
