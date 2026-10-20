# MultiCam Recorder｜多機錄影

用 Mac 的網頁同時控制多支 Android 手機錄影：一鍵同步開始、手機原生 4K 錄影、錄影中就把影片傳回 Mac，停止後很快就能在電腦上播放。適合訪談、課程、Podcast、產品拍攝這類需要多機位的場合。

Control multiple Android phones as synchronized 4K cameras from a Mac web dashboard over Wi-Fi — start/stop every phone with one key, stream the footage to the Mac while recording, and play it back shortly after you stop.

![Android 12+](https://img.shields.io/badge/Android-12%2B-3DDC84?logo=android&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-Node.js%2024-000000?logo=apple&logoColor=white)
![Kotlin](https://img.shields.io/badge/Kotlin-Camera2-7F52FF?logo=kotlin&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-blue)

![多機錄影控制台：兩支手機同時用 4K 錄影，邊錄邊傳回 Mac](docs/images/console.png)

> 上圖是 Mac 上的控制台。每支手機一個監看區，錄影中會亮紅燈；下方是這支手機錄好的影片，點一下就能播放。（畫面中的彩色測試畫面來自開發用的模擬手機。）

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

- **一鍵控制所有手機**：按 `R` 全部開始、`S` 全部停止，也可以單獨控制某一台。開始前 Mac 會先和每台手機對時，約好同一刻一起開始。
- **手機原生畫質**：4K、1080p、720p 可選，在網頁上切換後所有手機一起套用。單支最長 30 分鐘，剩 3 分鐘時網頁和手機都會提醒。
- **錄完馬上看**：錄影中就邊錄邊傳，停止後只要補最後一小段，再用分段雜湊確認和手機上的檔案一模一樣，就能在網頁播放原檔，畫面和聲音都有。短片幾秒內就好，30 分鐘的 4K 大約多等十幾秒。
- **外接麥克風**：手機接上 USB 或耳機孔麥克風時，會自動改用它收音；App 和網頁都會顯示目前用的是哪支麥克風。
- **狀態一目瞭然**：每台手機的電量、溫度、剩餘空間、還能錄幾分鐘、傳輸速度。傳輸停住時會直接提示。
- **掃 QR Code 配對**：用手機相機掃一次就好，不用輸入 IP。
- **斷線也不怕**：Wi-Fi 斷掉時手機照常錄影，連回來會自動續傳。
- **檔名好整理**：`20261020_143005_ROG6D.mp4`，時間前綴加手機名稱。同一次錄影的檔案時間前綴相同，排序時會排在一起。

## 運作方式

![運作方式：Mac 當控制台，手機當攝影機，全部走同一個 Wi-Fi](docs/images/how-it-works.png)

- Mac 上跑一個本機伺服器，同時提供網頁控制台。控制台只能在 Mac 本機開啟，同一個網路的其他裝置打不開。
- 手機 App 用 WebSocket 接收指令、回報狀態，影片則用 HTTP 分段傳回 Mac。
- 錄影是在手機上進行（Camera2 + MediaRecorder），畫質不受 Wi-Fi 影響。Wi-Fi 只負責把檔案傳回來。

## 需要準備

| 項目 | 說明 |
| --- | --- |
| Mac | 安裝 Node.js 24 以上。要自己編譯 App 的話，另外需要 JDK 21 和 Android SDK（下面有安裝步驟）。 |
| Android 手機 | Android 12 以上。目前在 ASUS ROG Phone 6D、Google Pixel 11 Pro 實機測試過。 |
| 網路 | 手機和 Mac 連同一個 Wi-Fi，不要用訪客網路。最好讓 Mac 接網路線，詳見[網路設定建議](#網路設定建議)。 |
| 儲存空間 | 建議用外接 SSD（APFS 或 exFAT 格式）。4K 每台手機錄 30 分鐘大約 9 GB。 |

## 快速開始

### 1. 啟動 Mac 端

```sh
git clone https://github.com/dean9703111/android-multicam-recorder.git
cd android-multicam-recorder
npm install
npm start
```

用瀏覽器打開 <http://localhost:8787>。第一次使用先按右上角「設定」，再按「選擇資料夾…」挑一個存影片的資料夾（建議選外接 SSD），也可以直接貼上路徑。資料夾必須已經存在，不會自動建立。

如果 macOS 問要不要讓 node 接受連入連線，請按「允許」。

### 2. 安裝手機 App

**第一次編譯：安裝 JDK 和 Android SDK**（用 Homebrew，不需要裝整個 Android Studio）

```sh
brew install openjdk@21
brew install --cask android-commandlinetools
export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
yes | sdkmanager --sdk_root="$HOME/Library/Android/sdk" --licenses
sdkmanager --sdk_root="$HOME/Library/Android/sdk" "platform-tools" "platforms;android-37.0" "build-tools;36.0.0"
echo "sdk.dir=$HOME/Library/Android/sdk" > android/local.properties
```

**編譯並安裝到手機**

1. 手機開啟「USB 偵錯」：
   - Pixel：「設定 → 關於手機」連按「版本號碼」7 次，再到「設定 → 系統 → 開發人員選項」打開「USB 偵錯」。
   - ASUS：在「設定」裡找到「軟體資訊」（通常在「設定 → 系統 → 關於手機」裡面），連按「版本號碼」7 次，再到「設定 → 系統 → 開發人員選項」打開「USB 偵錯」。
2. 用 USB 線接上 Mac。手機跳出「要允許 USB 偵錯嗎？」時，勾選「一律允許」後按「允許」。
3. 執行：

   ```sh
   npm run android:build     # 產生 android/app/build/outputs/apk/debug/app-debug.apk
   npm run android:install   # 安裝到所有已接上、已允許偵錯的手機
   ```

不想接線的話，也可以把 `app-debug.apk` 傳到手機上直接安裝，安裝時要允許「安裝不明應用程式」。

### 3. 配對手機

![配對流程：Mac 顯示 QR Code、手機相機掃描、按「打開 App 並配對」、配對完成](docs/images/pairing.png)

1. 在 Mac 網頁按「配對手機」，畫面會出現 QR Code，10 分鐘內有效。
2. 用手機相機掃描，點開出現的連結。
3. 在打開的網頁按「打開 App 並配對」。App 會自動打開，第一次會詢問相機和麥克風權限。
4. 完成後，Mac 網頁上會多一個這支手機的監看區。

也可以打開 App，點右下角「掃描 QR Code」直接掃。每支手機只要配對一次，之後打開 App 就會自動連線。

### 4. 開始錄影

- 按網頁上的「開始錄影」或鍵盤 `R`，所有手機一起開始；「停止」或 `S` 全部停止。每個監看區也有「單獨開始／單獨停止」。快捷鍵只在控制台分頁是目前視窗時有效。
- 上方的「錄影解析度」會套用到所有手機，從下一次開始時生效。錄影中不能改。
- 30 分鐘會自動停止。最後 3 分鐘網頁會跳出提示並發出提示音。
- 錄影時 App 要一直開在前景，螢幕不能關。Android 不允許背景 App 使用相機。

手機上的 App 畫面長這樣：

![手機 App 畫面說明：名稱與連線、錄影計時、收音來源、傳輸狀態、調暗螢幕、掃描與清除](docs/images/phone-app.png)

1. **手機名稱、連線狀態**：名稱可以在 Mac 網頁上點一下修改，之後的檔名也會用這個名稱。
2. **錄影計時**：最後 3 分鐘會變成琥珀色，並顯示剩餘時間。
3. **收音來源**：接上外接麥克風後，請確認這裡顯示「外接 USB」或「耳機孔外接」。
4. **傳輸狀態**：「邊錄邊傳中」「還有 1 支在收尾」，或「影片都已傳到 Mac」。
5. **調暗螢幕**：長時間錄影時省電、降溫。
6. **掃描、清除已傳完的影片**：錄影中會停用，避免誤觸而中斷錄影。

### 5. 播放與管理影片

- 停止後，影片會自動放進那台手機的播放器，點清單上的 ▶ 可以切換。
- 影片存在你在「設定」選的資料夾。傳輸中的檔案副檔名是 `.part`，驗證通過後才改成 `.mp4`。
- 清單上會顯示兩台開始時間差幾毫秒，剪輯時可以參考；要精準對齊，建議用剪輯軟體依音訊自動同步。
- 手機上的原檔不會自動刪除。確認 Mac 上的檔案沒問題後，可以在 App 按「清除已傳完的影片」，它只會刪掉已經傳到 Mac 並驗證過的檔案。

## 網路設定建議

- **最好讓 Mac 接網路線**：這樣每支手機的影片在空中只要走一段。
- **或讓手機和 Mac 分開頻段**：例如手機連 2.4 GHz、Mac 連 5 GHz。兩邊在同一個頻段時，影片要在同一個頻道上走兩次（手機→路由器→Mac），容易變慢或卡住。
- 兩台都錄 4K 時合計約 80 Mbps。錄影中傳不完沒關係，停止後會補完；網頁上可以看到每台的傳輸速度。
- 不要用訪客網路，訪客網路通常會隔離裝置，手機會連不到 Mac。
- Mac 開著 VPN 時手機可能連不到，請關掉 VPN，或開啟它的區域網路存取選項。

## 常見問題

<details>
<summary>用手機相機掃 QR Code，只看到一串網址？</summary>

點開那個連結，會打開一個寫著「配對這支手機」的網頁，再按「打開 App 並配對」就好。網址列顯示「不安全」是因為區網用的是 http，可以放心。
</details>

<details>
<summary>網頁顯示「傳輸停住了」？</summary>

通常是那支手機的 Wi-Fi 訊號不好，或是和 Mac 擠在同一個頻段，請參考[網路設定建議](#網路設定建議)。App 只要 10 秒沒有進度就會自動換一條連線重試，影片不會遺失。
</details>

<details>
<summary>外接麥克風沒有被錄到？</summary>

先看 App 右上角的「收音」。如果顯示「手機內建」，代表系統沒偵測到外接麥克風，請重新插拔，或換一個 USB 孔試試。開始錄影後，那裡顯示的就是系統實際使用的麥克風。
</details>

<details>
<summary>手機在錄影中被切到背景或來電了？</summary>

App 會先把影片正常收尾再停止，已經錄到的部分會照常傳到 Mac，網頁上會標示「手機端中斷，提早停止」。回到 App 後相機會自動恢復。
</details>

<details>
<summary>macOS 一直詢問權限？</summary>

第一次接受手機連線時，macOS 可能會問要不要讓 node 接受連入連線；第一次寫入外接 SSD 時，也可能會問終端機能不能存取外接磁碟上的檔案。都請按「允許」。
</details>

<details>
<summary>有支援 iPhone 嗎？</summary>

目前只支援 Android 12 以上的手機。
</details>

## 開發與測試

### 不用手機也能測試

`tools/fake-phone.ts` 是模擬手機，會用 ffmpeg 產生測試畫面和嗶聲，走的流程和真正的手機完全一樣（需要先 `brew install ffmpeg`）。啟動 Mac 端後，另外開兩個終端機：

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
adb shell am start -n dev.multicam.recorder/.MainActivity --es qr 'http://<Mac 的 IP>:8787/pair?code=<配對碼>'
```

### 檔案結構

```
mac/                       Mac 端（Node.js 24 直接執行 TypeScript，不用編譯）
  server.ts                手機連線、錄影控制、接收影片、提供網頁
  protocol.ts              手機和 Mac 之間的通訊格式，Android App 照這份實作
  uploads.ts               邊錄邊傳、分段雜湊驗證
  store.ts                 配對、影片清單、設定的存檔（data/db.json）
  public/                  網頁控制台（Preact + htm，不用打包）
android/app/src/main/kotlin/dev/multicam/recorder/
  CameraRecorder.kt        Camera2 預覽與錄影、選擇麥克風
  MacLink.kt               和 Mac 的 WebSocket 連線、對時
  Uploader.kt              邊錄邊傳、驗證、補傳
  MainActivity.kt          畫面與整體流程
tools/
  fake-phone.ts            模擬手機
  install-android.sh       把 APK 裝到所有接上的手機
```

### 傳輸流程

1. 錄影中：手機每次把檔案已經寫好的部分用 `PUT /api/upload/:fileId?offset=N` 傳給 Mac，最後 256 KB 先保留，因為可能還在寫入。
2. 停止後：傳完剩下的部分 → `POST finish` → 雙方同時把整個檔案以 16 MB 分段算 SHA-256 → `POST verify`。不一樣的分段會補傳，直到完全相同。MP4 在停止時會改寫檔頭，所以第 0 段幾乎一定要補傳一次。
3. 驗證通過後，Mac 把 `.part` 改名成 `.mp4`，網頁就能播放。

完整的訊息格式請看 [`mac/protocol.ts`](mac/protocol.ts)。

## 已知限制

- 只支援 Android，App 錄影時必須留在前景。
- 影片存在 App 自己的資料夾（`Android/data/dev.multicam.recorder/files/Movies`），解除安裝 App 會連影片一起刪掉。
- 外接麥克風能不能被選用，依手機和麥克風而定，請以 App 上顯示的收音來源為準。
- 錄影中不提供即時監看畫面，錄完後才能在 Mac 上播放。
- 還沒有雲端上傳，影片目前存在 Mac 上。

## English

**MultiCam Recorder** turns several Android phones into a synchronized multi-camera rig controlled from a web dashboard on your Mac.

- **One-key control**: press `R` / `S` to start or stop every phone at the same moment (the Mac syncs clocks and schedules a common start time).
- **Native quality**: phones record locally with Camera2 + MediaRecorder at 4K / 1080p / 720p, so Wi-Fi never limits image quality.
- **Instant playback**: footage streams to the Mac while recording; after you stop, only the tail is sent and the file is verified chunk by chunk with SHA-256 against the phone's original, so you can play it right away.
- **External microphones**: USB and headset-jack mics are detected automatically, and the active input is shown on both the phone and the dashboard.
- **Live status**: battery, temperature, free space, minutes left, and transfer speed for each phone.
- **QR pairing**: scan once with the phone's camera; no IP addresses to type.
- **Resilient**: recording continues if Wi-Fi drops, and uploads resume automatically.

Quick start:

```sh
git clone https://github.com/dean9703111/android-multicam-recorder.git
cd android-multicam-recorder
npm install && npm start            # open http://localhost:8787
npm run android:build && npm run android:install
```

Requirements: macOS with Node.js 24+, Android 12+ phones on the same Wi-Fi. Building the app needs JDK 21 and the Android SDK; see the commands above. The UI is currently in Traditional Chinese.

## 授權

[MIT](LICENSE)
