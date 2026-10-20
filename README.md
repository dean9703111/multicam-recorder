# MultiCam Recorder｜多機錄影

用電腦的網頁同時控制多支手機錄影：一鍵同步開始、手機原生 4K 錄影、錄影中就把影片傳回電腦，停止後很快就能在電腦上播放。適合訪談、課程、Podcast、產品拍攝這類需要多機位的場合。

Turn several phones into synchronized 4K cameras controlled from a web dashboard on your computer (macOS / Windows) over Wi-Fi. Start and stop every phone with one key, stream the footage to the computer while recording, and play it back shortly after you stop.

![電腦：macOS | Windows](https://img.shields.io/badge/%E9%9B%BB%E8%85%A6-macOS%20%7C%20Windows-000000?logo=nodedotjs&logoColor=white)
![手機：Android 12+](https://img.shields.io/badge/%E6%89%8B%E6%A9%9F-Android%2012%2B-3DDC84?logo=android&logoColor=white)
![Kotlin](https://img.shields.io/badge/Kotlin-Camera2-7F52FF?logo=kotlin&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-blue)

![多機錄影控制台：兩支手機同時用 4K 錄影，邊錄邊傳回電腦](docs/images/console.png)

> 上圖是電腦上的控制台。每支手機一個監看區，錄影中會亮紅燈；下方是這支手機在目前專案錄好的影片，點一下就能播放。（畫面中的漸層動畫來自開發用的模擬手機，實際使用時就是手機拍到的畫面。）

## 目錄

- [功能](#功能)
- [運作方式](#運作方式)
- [需要準備](#需要準備)
- [快速開始](#快速開始)
- [網路設定建議](#網路設定建議)
- [常見問題](#常見問題)
- [開發與測試](#開發與測試)
- [已知限制](#已知限制)
- [English](#english)

## 功能

- **一鍵控制所有手機**：按 `R` 全部開始、`S` 全部停止，也可以單獨控制某一台。開始前電腦會先和每台手機對時，約好同一刻一起開始，影片清單上會顯示各台實際開始的時間差。最多可以接 10 台。
- **手機原生畫質**：4K、2K、1080p、720p 可選，所有手機一起套用。單支最長 30 分鐘，剩 3 分鐘時網頁和手機都會提醒。
- **構圖輔助框**：錄影一律是 16:9，可以在手機預覽和電腦的播放器上疊一個 9:16、4:5 或 1:1 的框，架機時就照最後要出的比例構圖。
- **用專案整理影片**：開錄前先選專案，影片會存進「錄影資料夾／專案名稱」。之後可以從選單打開舊專案接著錄。
- **錄完馬上看**：錄影中就邊錄邊傳，停止後只要補最後一小段，再用分段雜湊確認和手機上的檔案一模一樣，就能在網頁播放原檔，畫面和聲音都有。短片幾秒內就好，30 分鐘的 4K 大約多等十幾秒。
- **外接麥克風**：手機接上 USB 或耳機孔麥克風時，會自動改用它收音；App 和網頁都會顯示目前用的是哪支麥克風。
- **狀態一目瞭然**：每台手機的電量、溫度、剩餘空間、還能錄幾分鐘、傳輸速度。電腦的硬碟快不夠、傳輸停住、手機斷線時都會直接提示。
- **掃 QR Code 配對**：用手機相機掃一次就好，不用輸入 IP。還沒裝 App 的話，掃完打開的網頁裡就有下載連結。
- **斷線也不怕**：Wi-Fi 斷掉時手機照常錄影，連回來會自動續傳。
- **檔名好整理**：`20261020_143005_ROG6D.mp4`，時間前綴加手機名稱。同一次錄影的檔案時間前綴相同，排序時會排在一起。

## 運作方式

![運作方式：電腦當控制台，手機當攝影機，全部走同一個 Wi-Fi](docs/images/how-it-works.png)

- 電腦上跑一個本機伺服器，同時提供網頁控制台。控制台只能在這台電腦上開，同一個網路的其他裝置打不開。
- 手機 App 用 WebSocket 接收指令、回報狀態，影片則用 HTTP 分段傳回電腦。
- 錄影是在手機上進行（Camera2 + MediaRecorder），畫質不受 Wi-Fi 影響。Wi-Fi 只負責把檔案傳回來。
- 手機和電腦之間的通訊格式都寫在 [`server/protocol.ts`](server/protocol.ts)。目前手機端只有 Android App，其他平台照這份格式實作就能接上。

## 需要準備

| 項目 | 說明 |
| --- | --- |
| 電腦 | macOS 或 Windows，安裝 [Node.js](https://nodejs.org/) 24 以上。目前在 Apple Silicon 的 Mac 上實際使用，Windows 版還沒實測。 |
| 手機 | Android 12 以上，最多 10 台。目前在 ASUS ROG Phone 6D、Google Pixel 11 Pro 實機測試過。 |
| 網路 | 手機和電腦連同一個 Wi-Fi，不要用訪客網路。最好讓電腦接網路線，詳見[網路設定建議](#網路設定建議)。 |
| 儲存空間 | 建議用外接 SSD，macOS 用 APFS 或 exFAT，Windows 用 NTFS 或 exFAT（FAT32 存不了超過 4 GB 的檔案）。4K 每台手機錄 30 分鐘大約 9 GB。 |

## 快速開始

### 1. 啟動電腦端

```sh
git clone https://github.com/dean9703111/multicam-recorder.git
cd multicam-recorder
npm install
npm start
```

用瀏覽器打開 <http://localhost:8787>，畫面上的「開始使用」會帶你走完三個步驟：確認錄影資料夾、配對手機、新增專案。

- 錄影資料夾預設是「影片」資料夾底下的 `MultiCamRecorder`（macOS 是 `~/Movies/MultiCamRecorder`，Windows 是 `~/Videos/MultiCamRecorder`）。要改的話按右上角「設定」，再按「選擇資料夾…」挑一個（建議選外接 SSD），也可以直接貼上路徑。資料夾必須已經存在，不會自動建立。
- 第一次接受手機連線時，系統可能會問要不要讓 node 接受連入連線：macOS 請按「允許」；Windows 防火牆請勾選「私人網路」再按「允許存取」。

### 2. 安裝手機 App

**下載 APK（建議）**：到 [Releases](https://github.com/dean9703111/multicam-recorder/releases/latest) 下載 `MultiCamRecorder.apk`，傳到手機上點開安裝。也可以直接跳到下一步：用手機相機掃配對的 QR Code，打開的網頁裡就有下載連結。第一次安裝時，手機會要你允許瀏覽器或檔案 App「安裝不明應用程式」。

之後有新版時，下載新的 APK 直接安裝就會覆蓋舊版，配對和設定都會保留。

<details>
<summary>自己編譯 App（給開發者）</summary>

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

自己編譯的 debug 版和 Releases 上的正式版簽章不同，不能互相覆蓋安裝，要換的話得先解除安裝。解除安裝會一起刪掉 App 裡的影片，請先確認都已經傳到電腦。

</details>

### 3. 配對手機

![配對流程：電腦顯示 QR Code、手機相機掃描、按「打開 App 並配對」、配對完成](docs/images/pairing.png)

1. 在電腦網頁按「配對手機」，畫面會出現 QR Code，10 分鐘內有效。
2. 用手機相機掃描，點開出現的連結。
3. 在打開的網頁按「打開 App 並配對」。App 會自動打開，第一次會詢問相機和麥克風權限。還沒裝 App 的話，按下去會先下載 App，裝好後回到這一頁再按一次。
4. 完成後，電腦網頁上會多一個這支手機的監看區。

也可以打開 App，點右下角「掃描 QR Code」直接掃。每支手機只要配對一次，之後打開 App 就會自動連線。手機名稱可以在網頁上點一下修改，之後的檔名也會用這個名稱。

### 4. 新增專案、開始錄影

- **專案**：按上方「專案」選單裡的「新增專案…」，預設名稱是今天的日期。影片會存進「錄影資料夾／專案名稱」。還沒有專案就按開始的話，會先請你新增一個。
- **錄影規格**：「錄影規格」選單可以選解析度和構圖輔助框，所有手機一起套用。解析度從下一次開始錄影時生效，錄影中不能改；輔助框隨時可以換。手機不支援選的解析度時，會改錄它能錄的最大 16:9，影片清單上會標出實際的大小。
- **開始和停止**：按網頁上的「開始錄影」或鍵盤 `R`，所有手機一起開始；「停止」或 `S` 全部停止。每個監看區也有「單獨開始／單獨停止」。快捷鍵只在控制台分頁是目前視窗時有效。
- 30 分鐘會自動停止。最後 3 分鐘網頁會跳出提示並發出提示音。
- 錄影時 App 要一直開在前景，螢幕不能關。Android 不允許背景 App 使用相機。

![錄影規格選單：4K、2K、1080p、720p 和構圖輔助框，播放器上疊著 9:16 的框](docs/images/spec-guide.png)

手機上的 App 畫面長這樣：

![手機 App 畫面說明：名稱與連線、錄影計時、收音來源、傳輸狀態、調暗螢幕、掃描與清除、構圖輔助框](docs/images/phone-app.png)

1. **手機名稱、連線狀態**：名稱可以在電腦網頁上點一下修改。連不上電腦太久時，這裡會提示檢查伺服器和 Wi-Fi。
2. **錄影計時**：最後 3 分鐘會變成琥珀色，並顯示剩餘時間。
3. **收音來源**：接上外接麥克風後，請確認這裡顯示「外接 USB」或「耳機孔外接」。
4. **傳輸狀態**：「邊錄邊傳中」「還有 1 支在收尾」，或「影片都已傳到電腦」。
5. **調暗螢幕**：長時間錄影時省電、降溫。
6. **掃描、清除已傳完的影片**：錄影中會停用，避免誤觸而中斷錄影。還沒配對時，掃描按鈕會變成紅色。
7. **構圖輔助框**：在電腦上選了 9:16、4:5 或 1:1 時，會疊在預覽上。

### 5. 播放與管理影片

- 停止後，影片會自動放進那台手機的播放器，點清單上的 ▶ 可以切換。播放器下方的「在 Finder 中顯示」（Windows 是「在檔案總管中顯示」）會直接打開影片所在的資料夾，「專案」選單裡也有「打開專案資料夾」。
- 傳輸中的檔案副檔名是 `.part`，驗證通過後才改成 `.mp4`。
- 清單上會顯示同一次錄影的各台開始時間差幾毫秒，剪輯時可以參考；要精準對齊，建議用剪輯軟體依音訊自動同步。
- 在 Finder 或檔案總管裡刪掉影片或專案資料夾，清單上也會跟著拿掉。外接硬碟沒接上時紀錄會先保留，接回來就恢復。
- 手機上的原檔不會自動刪除。確認電腦上的檔案沒問題後，可以在 App 按「清除已傳完的影片」，它只會刪掉已經傳到電腦並驗證過的檔案。

## 網路設定建議

- **最好讓電腦接網路線**：這樣每支手機的影片在空中只要走一段。
- **或讓手機和電腦分開頻段**：例如手機連 2.4 GHz、電腦連 5 GHz。兩邊在同一個頻段時，影片要在同一個頻道上走兩次（手機→路由器→電腦），容易變慢或卡住。
- 兩台都錄 4K 時合計約 80 Mbps，手機越多需要的頻寬越大。錄影中傳不完沒關係，停止後會補完；網頁上可以看到每台的傳輸速度。
- 不要用訪客網路，訪客網路通常會隔離裝置，手機會連不到電腦。
- 電腦開著 VPN 時手機可能連不到，請關掉 VPN，或開啟它的區域網路存取選項。
- 電腦的 IP 變了手機就會連不到，重新掃一次配對的 QR Code 就好。常用的話，建議在路由器裡把電腦的 IP 固定下來。

## 常見問題

<details>
<summary>用手機相機掃 QR Code，只看到一串網址？</summary>

點開那個連結，會打開一個寫著「配對這支手機」的網頁，再按「打開 App 並配對」就好。網址列顯示「不安全」是因為區網用的是 http，可以放心。
</details>

<details>
<summary>網頁顯示「傳輸停住了」？</summary>

通常是那支手機的 Wi-Fi 訊號不好，或是和電腦擠在同一個頻段，請參考[網路設定建議](#網路設定建議)。App 只要 10 秒沒有進度就會自動換一條連線重試，影片不會遺失。
</details>

<details>
<summary>監看區顯示「相機未就緒」？</summary>

手機連得上電腦，但相機沒有打開。通常是 App 被切到背景，或還沒允許相機和麥克風權限。把 App 打開在前景；如果 App 上方寫著需要權限，點一下就會打開系統設定。
</details>

<details>
<summary>手機在錄影中沒電或關機了？</summary>

網頁會提示那支手機離線了。手機連回來之後，已經錄到的部分會自動補傳。如果確定它不會再連回來，可以在它的監看區按「移除」；不處理的話，超過錄影上限一分鐘後也會自動標成失敗，其他手機照常使用。影片會留在手機上。
</details>

<details>
<summary>外接麥克風沒有被錄到？</summary>

先看 App 右上角的「收音」。如果顯示「手機內建」，代表系統沒偵測到外接麥克風，請重新插拔，或換一個 USB 孔試試。開始錄影後，那裡顯示的就是系統實際使用的麥克風。
</details>

<details>
<summary>手機在錄影中被切到背景或來電了？</summary>

App 會先把影片正常收尾再停止，已經錄到的部分會照常傳到電腦，網頁上會標示「手機端中斷，提早停止」。回到 App 後相機會自動恢復。
</details>

<details>
<summary>系統一直詢問權限？</summary>

第一次接受手機連線時，macOS 或 Windows 防火牆可能會問要不要讓 node 接受連入連線，請允許（Windows 請勾選「私人網路」）。在 macOS 上第一次寫入外接 SSD 時，也可能會問終端機能不能存取外接磁碟上的檔案，請按「允許」。
</details>

<details>
<summary>有支援 iPhone 嗎？</summary>

目前手機端只有 Android 12 以上的 App。電腦和手機之間的通訊格式是公開的（[`server/protocol.ts`](server/protocol.ts)），其他平台照著實作就能接上。
</details>

## 開發與測試

### 不用手機也能測試

`tools/fake-phone.ts` 是模擬手機，會用 ffmpeg 產生測試影片：流動的漸層加上一圈刻度，白點每 3 秒繞一圈，下方有音量表，聲音是每秒嗶一聲。兩支模擬手機同時開始時，白點的位置和嗶聲都會對齊；顏色依手機名稱而定，方便分辨。它走的流程和真正的手機完全一樣（需要先安裝 ffmpeg，例如 `brew install ffmpeg`）。啟動電腦端後，另外開兩個終端機：

```sh
npm run fake-phone -- --model "ASUS_AI2203" --tone 440 --mic "外接 USB（USB Audio）"
npm run fake-phone -- --model "Pixel 11 Pro" --tone 660 --mic "手機內建"
```

測試用的環境變數：

| 變數 | 用途 |
| --- | --- |
| `PORT` | 伺服器的連接埠，預設 8787 |
| `RECORDER_MAX_SEC` | 單支上限秒數，預設 1800（30 分鐘） |
| `RECORDER_WARN_SEC` | 剩多少秒時提醒，預設 180 |
| `RECORDER_DATA_DIR` | 配對和影片清單存放的位置，預設 `data/`。測試時指到別處，就不會動到正式資料 |

例如 `RECORDER_MAX_SEC=40 RECORDER_WARN_SEC=15 npm start`，40 秒就會自動停止。型別檢查用 `npm run typecheck`。

### 開發時不用掃 QR Code

App 的 debug 版可以用 adb 直接傳入 QR Code 的網址：

```sh
adb shell am start -n dev.multicam.recorder/.MainActivity --es qr 'http://<電腦的 IP>:8787/pair?code=<配對碼>'
```

正式版不接受這個參數，但可以用配對網頁同樣的連結：

```sh
adb shell am start -a android.intent.action.VIEW -d 'multicam://pair?server=http%3A%2F%2F<電腦的 IP>%3A8787&code=<配對碼>'
```

### 檔案結構

```
server/                    電腦端（Node.js 24 直接執行 TypeScript，不用編譯）
  server.ts                手機連線、錄影控制、專案、接收影片、提供網頁
  protocol.ts              手機和電腦之間的通訊格式，Android App 照這份實作
  uploads.ts               邊錄邊傳、分段雜湊驗證
  store.ts                 配對、專案、影片清單、設定的存檔（data/db.json）
  public/                  網頁控制台（Preact + htm，不用打包）
android/app/src/main/kotlin/dev/multicam/recorder/
  CameraRecorder.kt        Camera2 預覽與錄影、選擇麥克風
  ServerLink.kt            和電腦的 WebSocket 連線、對時
  Uploader.kt              邊錄邊傳、驗證、補傳
  GuideOverlay.kt          預覽上的構圖輔助框
  MainActivity.kt          畫面與整體流程
tools/
  fake-phone.ts            模擬手機，也是通訊格式的參考實作
  install-android.sh       把 APK 裝到所有接上的手機
```

### 傳輸流程

1. 錄影中：手機每次把檔案已經寫好的部分用 `PUT /api/upload/:fileId?offset=N` 傳給電腦，最後 256 KB 先保留，因為可能還在寫入。
2. 停止後：傳完剩下的部分 → `POST finish` → 雙方同時把整個檔案以 16 MB 分段算 SHA-256 → `POST verify`。不一樣的分段會補傳，直到完全相同。MP4 在停止時會改寫檔頭，所以第 0 段幾乎一定要補傳一次。
3. 驗證通過後，電腦把 `.part` 改名成 `.mp4`，網頁就能播放。

完整的訊息格式請看 [`server/protocol.ts`](server/protocol.ts)。

## 已知限制

- 手機端目前只有 Android App，錄影時 App 必須留在前景。
- 電腦端的 Windows 版還沒實測；Linux 也沒有測過，而且沒有選擇資料夾的視窗，要直接貼上路徑。
- 影片存在 App 自己的資料夾（`Android/data/dev.multicam.recorder/files/Movies`），解除安裝 App 會連影片一起刪掉。
- 外接麥克風能不能被選用，依手機和麥克風而定，請以 App 上顯示的收音來源為準。
- 錄影中不提供即時監看畫面，錄完後才能在電腦上播放。
- 還沒有雲端上傳，影片目前存在電腦上。
- 介面目前只有繁體中文。

## English

**MultiCam Recorder** turns several phones into a synchronized multi-camera rig controlled from a web dashboard on your computer.

- **One-key control**: press `R` / `S` to start or stop every phone (up to 10) at the same moment. The computer syncs clocks and schedules a common start time, and the dashboard shows the measured start offset between phones.
- **Native quality**: phones record locally with Camera2 + MediaRecorder at 4K / 2K / 1080p / 720p, so Wi-Fi never limits image quality. Takes are capped at 30 minutes, with a warning 3 minutes before the end.
- **Framing guides**: footage is always 16:9; optional 9:16, 4:5 or 1:1 guides are overlaid on the phone preview and the dashboard player.
- **Projects**: every take goes into `<recording folder>/<project name>`.
- **Instant playback**: footage streams to the computer while recording; after you stop, only the tail is sent and the file is verified chunk by chunk with SHA-256 against the phone's original, so you can play it right away.
- **External microphones**: USB and headset-jack mics are detected automatically, and the active input is shown on both the phone and the dashboard.
- **Live status**: battery, temperature, free space, minutes left, and transfer speed for each phone, plus warnings for low disk space, stalled transfers and disconnected phones.
- **QR pairing**: scan once with the phone's camera; the page that opens also offers the APK download.
- **Resilient**: recording continues if Wi-Fi drops, and uploads resume automatically.

Quick start:

```sh
git clone https://github.com/dean9703111/multicam-recorder.git
cd multicam-recorder
npm install && npm start            # open http://localhost:8787
```

Then download `MultiCamRecorder.apk` from [Releases](https://github.com/dean9703111/multicam-recorder/releases/latest) (or scan the pairing QR code and use the download link on the page that opens), pair each phone, create a project and press `R`.

Requirements: macOS or Windows with Node.js 24+ (Windows is not tested yet), Android 12+ phones on the same Wi-Fi. The phone protocol is documented in [`server/protocol.ts`](server/protocol.ts), so other phone platforms can be added. The UI is currently in Traditional Chinese.

## 授權

[MIT](LICENSE)
