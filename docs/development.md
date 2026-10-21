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
npm run android:build     # 產生 android/app/build/outputs/apk/debug/app-debug.apk
npm run android:install   # 安裝到所有已接上、已允許偵錯的手機
```

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

`npm run smoke-test` 會自己開一個伺服器和兩支模擬手機（一支橫拿、一支直拿），把配對、即時畫面、變焦、兩支同時錄影、傳檔驗證、專案、標記、移到垃圾桶、刪檔同步、改名、移除手機都跑一遍，大約 15 秒。測試資料放在暫存資料夾，跑完就清掉；只有兩支幾秒鐘的測試影片會留在系統的垃圾桶裡。

GitHub Actions 每次推送都會在 Windows、macOS、Linux 上各跑一次（[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)），Windows 上也會確認中文的資料夾路徑、NTFS 偵測和資源回收筒。

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
  server.ts                手機連線、錄影控制、專案、接收影片、提供網頁
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
docs/
  images/                  README 的截圖和示意圖
  mockups.html             示意圖的原稿
  development.md           這份文件
llms.txt                   給 AI 工具讀的專案摘要
```

## 傳輸流程

1. 錄影中：手機每次把檔案已經寫好的部分用 `PUT /api/upload/:fileId?offset=N` 傳給電腦，最後 256 KB 先保留，因為可能還在寫入。
2. 停止後：傳完剩下的部分 → `POST finish` → 雙方同時把整個檔案以 16 MB 分段算 SHA-256 → `POST verify`。不一樣的分段會補傳，直到完全相同。MP4 在停止時會改寫檔頭，所以第 0 段幾乎一定要補傳一次。
3. 驗證通過後，電腦把 `.part` 改名成 `.mp4`，網頁就能播放。

## 更新 README 的圖

- **示意圖**（how-it-works、pairing、phone-app、phone-app-portrait、use-cases、long-short、network、social-preview）的原稿都在 [`docs/mockups.html`](mockups.html)。在專案根目錄執行 `python3 -m http.server`，打開 <http://localhost:8000/docs/mockups.html>，把每個 section 各自截圖存到 `docs/images/`。
- **控制台的截圖**（console、spec-guide、select-trash、setup）是用模擬手機實際操作截的。電腦的硬碟空間不夠時，控制台上方會出現提醒，截圖前可以先把 `.alerts` 藏起來。
- 截圖裡不要出現自己電腦的使用者名稱或私人路徑，例如錄影資料夾的完整路徑。
- `social-preview.png`（1280×640）是分享連結時顯示的預覽圖，要到 GitHub 專案的 **Settings → General → Social preview** 手動上傳。

## 發佈新版

- 手機 App 改了，就要遞增 `android/app/build.gradle.kts` 的 `versionCode` 和 `versionName`，以及 `ServerLink.kt` 的 `APP_VERSION`。
- 正式版用專用金鑰簽章，設定在 `android/keystore.properties`（不放進 git，沒有這個檔案就只能編 debug 版）。編譯：`cd android && ./gradlew :app:assembleRelease`。
- Release 附的檔案名稱固定叫 `MultiCamRecorder.apk`，不要帶版號：配對網頁的下載連結指向 `releases/latest/download/MultiCamRecorder.apk`。
