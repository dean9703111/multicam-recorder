<p align="center">
  <img src="docs/images/logo.svg" width="88" height="88" alt="MultiCam Recorder 多機錄影的標誌">
</p>

<h1 align="center">MultiCam Recorder｜多機錄影</h1>

<p align="center">
  <b>免費開源的手機多機位錄影工具：用電腦一鍵遙控多支 Android 手機同步錄影</b><br>
  即時畫面・手機原生 4K・人像模式・直式＋橫式同時錄・邊錄邊傳回電腦・支援 macOS／Windows
</p>

<p align="center">
  <a href="https://github.com/dean9703111/multicam-recorder/releases/latest"><img src="https://img.shields.io/github/v/release/dean9703111/multicam-recorder?label=%E4%B8%8B%E8%BC%89%20App&color=ff3b3b" alt="下載最新版 App"></a>
  <a href="https://github.com/dean9703111/multicam-recorder/actions/workflows/ci.yml"><img src="https://github.com/dean9703111/multicam-recorder/actions/workflows/ci.yml/badge.svg" alt="CI：每次更新都在 Windows、macOS、Linux 自動測試"></a>
  <img src="https://img.shields.io/badge/%E9%9B%BB%E8%85%A6-macOS%20%7C%20Windows-000000?logo=nodedotjs&logoColor=white" alt="電腦：macOS、Windows">
  <img src="https://img.shields.io/badge/%E6%89%8B%E6%A9%9F-Android%2012%2B-3DDC84?logo=android&logoColor=white" alt="手機：Android 12 以上">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT 授權"></a>
</p>

<p align="center">
  <a href="https://deanlin.net/multicam-recorder/"><b>產品網站</b></a> ・
  <a href="#快速開始"><b>快速開始</b></a> ・
  <a href="#適合哪些情境">使用情境</a> ・
  <a href="#功能特色">功能特色</a> ・
  <a href="#規格一覽">規格</a> ・
  <a href="#常見問題">常見問題</a> ・
  <a href="#english">English</a>
</p>

![多機錄影控制台截圖：兩支 Android 手機同步用 4K 錄影，左邊橫拿 16:9、右邊直拿 9:16，監看區顯示即時畫面，下方是邊錄邊傳回電腦的影片清單](docs/images/console.png)

<p align="center"><sub>電腦上的控制台：兩支手機同時錄 4K，左邊橫拿 16:9、右邊直拿 9:16。每台都看得到即時畫面，影片一邊錄一邊傳回電腦。<br>（畫面中的漸層動畫來自開發用的模擬手機，實際使用時就是手機拍到的畫面。）</sub></p>

## 多機錄影是什麼？

**多機錄影（MultiCam Recorder）是一套免費、開源的多機位錄影工具，把手邊的 Android 手機變成可以同步錄影的攝影機。** 在電腦（macOS 或 Windows）上打開網頁控制台，就能同時看到每支手機的即時畫面、各自調整變焦，按一個鍵讓所有手機在同一刻開始錄影。

影片是在每支手機上**用手機原生畫質錄的，最高 4K**，錄影中就一邊傳回電腦，停止後很快就能在電腦上播放檢查。整個過程只用家裡或辦公室的 **Wi-Fi 區域網路**，**不需要雲端帳號，影片也不會上傳到網路**。

### 和每支手機各自按錄影，差在哪？

| | 每支手機各自錄 | 用多機錄影 |
| --- | --- | --- |
| **開始錄影** | 一支一支跑去按，開始時間差好幾秒 | 按一次 `R`，所有手機約好同一刻開始 |
| **看畫面** | 只看得到眼前那一支 | 電腦上同時看每支的即時畫面 |
| **拿到檔案** | 錄完再一支一支傳、改檔名 | 邊錄邊傳回電腦，自動命名、確認檔案完整 |
| **注意狀態** | 電量、空間不夠時才發現 | 電量、溫度、剩餘空間、還能錄幾分鐘一目瞭然 |

## 適合哪些情境？

![多機錄影的四種使用情境俯視圖：訪談與 Podcast 雙機位、一台橫拿一台直拿同時做長影片和短影音、課程講座的全景加講者近景、產品拍攝的正面俯拍與特寫](docs/images/use-cases.png)

- **訪談、Podcast**：主持人和來賓各一台，外接麥克風接在其中一台當主音軌，剪輯時隨時切換角度。
- **同時做長影片和短影音**：一台橫拿錄 YouTube 用的 16:9，一台直拿錄 Reels、Shorts、TikTok 用的 9:16，一次錄好兩種版本。[詳細做法](#使用情境一次錄好長影片和短影音)
- **課程、講座**：一台在後面拍全景，一台在側邊拍講者和白板。
- **產品拍攝、開箱**：正面、正上方俯拍、側面特寫同時錄，最多可以接 10 台手機。

## 功能特色

**錄影**

- **一鍵同步開始、停止**：按 `R` 全部開始、`S` 全部停止，也能單獨控制某一台。開始前電腦會先和每台手機對時，約好同一刻一起開始，清單上會顯示各台實際的開始時間差。
- **手機原生畫質**：4K、2K、1080p、720p 可選，所有手機一起套用。單段最長 30 分鐘，剩 3 分鐘時網頁和手機都會提醒。
- **直式、橫式都能錄**：手機橫拿錄 16:9、直拿錄 9:16，App 會自動跟著手機轉，錄影中鎖住方向。
- **人像設定**：「臉部優先」預設開啟，對焦、曝光、白平衡都以人臉為準；手機做得到的話，還能開「背景虛化」；也可以在錄影時鎖定曝光和白平衡，亮度和顏色不會錄到一半變掉。這些都交給手機的相機處理，**畫質和解析度都不變**。[詳細說明](#人像設定臉部優先背景虛化鎖定曝光)
- **外接麥克風**：接上 USB 或耳機孔麥克風會自動改用它收音，App 和網頁都會顯示目前用的是哪一支。

**監看**

- **即時畫面**：每秒約 5 張，用來確認構圖。按下開始錄影時，監看區一律切回即時畫面，隨時知道現在拍到什麼。
- **各別變焦**：常用倍率的按鈕加上滑桿，每台各自設定；有超廣角或望遠鏡頭的手機會自動換鏡頭。
- **構圖輔助框**：在手機預覽、即時畫面和播放器上疊一個 9:16、4:5 或 1:1 的框，架機時就照最後要出的比例構圖。
- **狀態一目瞭然**：每台的電量、溫度、剩餘空間、還能錄幾分鐘、傳輸速度。電腦的硬碟快滿、傳輸停住、手機斷線時都會直接提示。

**傳檔與整理**

- **錄完馬上看**：錄影中就邊錄邊傳，停止後只要補最後一小段，再用 SHA-256 分段比對，確認和手機上的檔案一模一樣，就能在網頁播放原檔。短片幾秒內就好，30 分鐘的 4K 大約多等十幾秒。
- **斷線也不怕**：Wi-Fi 斷掉時手機照常錄影，連回來會自動續傳。
- **用專案整理**：開錄前先選專案，影片會存進「錄影資料夾／專案名稱」，檔名是時間加手機名稱，例如 `20261020_143005_ROG6D.mp4`，同一段的檔案會排在一起。
- **標記好的段落、一次清掉其他的**：點星號標記好的段落，同一段的每台手機一起標記；沒標記的可以一鍵移到垃圾桶（Windows 是資源回收筒），刪錯了也救得回來。
- **掃 QR Code 配對**：用手機相機掃一次就好，不用輸入 IP。還沒裝 App 的話，掃完打開的網頁裡就有下載連結。

## 規格一覽

| 項目 | 說明 |
| --- | --- |
| 價格 | **免費**，MIT 授權開源 |
| 電腦 | macOS、Windows，需要 [Node.js](https://nodejs.org/) 24 以上 |
| 手機 | Android 12 以上，**最多 10 台**；目前沒有 iPhone 版 |
| 解析度 | 4K（3840×2160）、2K（2560×1440）、1080p、720p，每秒 30 格；直拿時寬高對調 |
| 影片格式 | MP4（H.264 影像、AAC 聲音），4K 約 40 Mbps |
| 人像設定 | 臉部優先（預設開）、背景虛化（手機做得到才有，例如 Pixel 11 Pro 最高 1080p）、錄影時鎖定曝光和白平衡 |
| 單段長度 | 最長 30 分鐘；4K 每台約 9 GB |
| 連線方式 | 手機和電腦連同一個 Wi-Fi，影片只在區域網路裡傳輸 |
| 收音 | 手機內建麥克風，或 USB、耳機孔外接麥克風 |
| 即時畫面 | 每秒約 5 張（橫拿 640×360、直拿 360×640） |
| 介面語言 | 繁體中文 |

## 運作方式

![運作方式示意圖：電腦當控制台，手機當攝影機，全部走同一個 Wi-Fi；指令和即時畫面走 WebSocket，影片邊錄邊傳、停止後分段驗證](docs/images/how-it-works.png)

- **電腦**上跑一個本機伺服器，同時提供網頁控制台。控制台只能在這台電腦上開，同一個網路的其他裝置打不開。
- **手機 App** 用 WebSocket 接收開始、停止、變焦等指令並回報狀態，也用它傳即時畫面（電腦上有人在看時才傳）；影片則用 HTTP 分段傳回電腦。
- **錄影在手機上進行**（Camera2＋MediaRecorder），所以畫質不受 Wi-Fi 影響，Wi-Fi 只負責傳檔和控制。

## 快速開始

> [!TIP]
> 第一次設定大約 10 分鐘：裝好電腦端和手機 App、掃 QR Code 配對、新增專案，就能開始錄影。之後每次只要 `npm start`、打開 App。

### 1. 安裝並啟動電腦端

1. 安裝 [Node.js](https://nodejs.org/)（選 **LTS** 版本，需要 24 以上），照安裝程式一路按下一步。
2. 下載這個專案：會用 Git 的話執行下面的 `git clone`；不會的話，在這個頁面上方按綠色的 **Code → Download ZIP**，再解壓縮（資料夾會叫 `multicam-recorder-main`）。
3. 打開終端機（macOS 是「終端機」App，Windows 是「PowerShell」），執行下面的指令。用 ZIP 下載的話，跳過前兩行，改用 `cd` 進到解壓縮出來的 `multicam-recorder-main` 資料夾；`npm install` 只有第一次需要。

```sh
git clone https://github.com/dean9703111/multicam-recorder.git
cd multicam-recorder
npm install
npm start
```

4. 看到 `控制台：http://localhost:8787` 就成功了。用瀏覽器打開 <http://localhost:8787>，畫面上的「開始使用」會帶你走完三個步驟：確認錄影資料夾、配對手機、新增專案。要關掉時，在終端機按 `Ctrl＋C`。

![控制台的「開始使用」畫面：確認錄影資料夾、配對手機、新增專案三個步驟](docs/images/setup.png)

- **錄影資料夾**預設是「影片」資料夾底下的 `MultiCamRecorder`（macOS 是 `~/Movies/MultiCamRecorder`，Windows 是 `~/Videos/MultiCamRecorder`）。要改的話按右上角「設定」，再按「選擇資料夾…」挑一個，**建議選外接 SSD**；也可以直接貼上路徑。資料夾必須已經存在。
- 第一次有手機連線時，系統可能會問要不要讓 node 接受連入連線：macOS 請按「允許」；Windows 防火牆請勾選「私人網路」再按「允許存取」。

### 2. 安裝手機 App

1. 到 [Releases](https://github.com/dean9703111/multicam-recorder/releases/latest) 下載 **`MultiCamRecorder.apk`**，傳到手機上點開安裝。也可以直接跳到下一步，用手機相機掃配對的 QR Code，打開的網頁裡就有下載連結。
2. 第一次安裝時，手機會要你允許瀏覽器或檔案 App「安裝不明應用程式」。
3. 之後有新版時，下載新的 APK 直接安裝就會覆蓋舊版，**配對和設定都會保留**。

想自己從原始碼編譯 App，請看[開發者文件](docs/development.md#自己編譯-app)。

### 3. 配對手機

![配對流程：電腦顯示 QR Code、用手機相機掃描、按「打開 App 並配對」、配對完成](docs/images/pairing.png)

1. 在電腦網頁按 **「配對手機」**，畫面會出現 QR Code，10 分鐘內有效。
2. 用手機相機掃描，點開出現的連結。
3. 在打開的網頁按 **「打開 App 並配對」**。App 會自動打開，第一次會詢問相機和麥克風權限。還沒裝 App 的話，按下去會先下載 App，裝好後回到這一頁再按一次。
4. 完成後，電腦網頁上會多一個這支手機的監看區。

也可以打開 App，點右下角「掃描 QR Code」直接掃。**每支手機只要配對一次**，之後打開 App 就會自動連線。手機名稱可以在網頁上點一下修改，之後的檔名也會用這個名稱。

### 4. 新增專案、開始錄影

- **專案**：按上方「專案」選單裡的「新增專案…」，預設名稱是今天的日期。影片會存進「錄影資料夾／專案名稱」。還沒有專案就按開始的話，會先請你新增一個。
- **錄影規格**：「錄影規格」選單可以選解析度、構圖輔助框和人像設定，所有手機一起套用。解析度和人像設定從下一次開始錄影時生效，錄影中不能改；輔助框隨時可以換。手機不支援選的解析度時，會改錄它能錄的最大解析度，影片清單上會標出實際的大小。
- **人像設定**：「臉部優先」預設開著，拍人不用特別調。要背景虛化或鎖定曝光的話，在同一個選單打開，做法請看[人像設定](#人像設定臉部優先背景虛化鎖定曝光)。
- **即時畫面與變焦**：監看區平常顯示手機的即時畫面。下面的「變焦」可以按常用倍率或拖滑桿，每台手機各自設定，邊看即時畫面邊調；App 重開也會記得，錄影中也能調。
- **直拿或橫拿**：手機怎麼放就錄怎麼樣的影片，橫拿 16:9、直拿 9:16，系統的自動旋轉關著也一樣。一台直、一台橫同時錄的做法，請看[使用情境](#使用情境一次錄好長影片和短影音)。
- **開始和停止**：按網頁上的「開始錄影」或鍵盤 `R`，所有手機一起開始；「停止」或 `S` 全部停止。每個監看區也有「單獨開始／單獨停止」。快捷鍵只在控制台分頁是目前視窗時有效。
- **30 分鐘會自動停止**。最後 3 分鐘網頁會跳出提示並發出提示音。

> [!IMPORTANT]
> 錄影時 App 要一直開在前景，螢幕不能關，因為 Android 不允許背景 App 使用相機。長時間錄影可以按 App 上的「調暗螢幕」省電、降溫。

![錄影規格選單：解析度（4K、2K、1080p、720p）、構圖輔助框，最下面是人像設定（臉部優先開著、背景虛化列出做得到的手機、錄影時鎖定曝光和白平衡）；橫拿那台的即時畫面上疊著 9:16 的框，直拿那台本來就是 9:16](docs/images/spec-guide.png)

手機上的 App 畫面長這樣：

![手機 App 畫面說明（橫拿）：名稱與連線、錄影計時、收音來源與變焦、傳輸狀態、調暗螢幕、掃描與清除、構圖輔助框](docs/images/phone-app.png)

1. **手機名稱、連線狀態**：名稱可以在電腦網頁上點一下修改。連不上電腦太久時，這裡會提示檢查伺服器和 Wi-Fi。
2. **錄影計時**：最後 3 分鐘會變成琥珀色，並顯示剩餘時間。
3. **收音來源、變焦**：接上外接麥克風後，請確認這裡顯示「外接 USB」或「耳機孔外接」。下面一行是目前的變焦倍率。
4. **傳輸狀態**：「邊錄邊傳中」「還有 1 支在收尾」，或「影片都已傳到電腦」。
5. **調暗螢幕**：長時間錄影時省電、降溫。
6. **掃描、清除已傳完的影片**：錄影中會停用，避免誤觸而中斷錄影。還沒配對時，掃描按鈕會變成紅色。
7. **構圖輔助框**：在電腦上選了 9:16、4:5 或 1:1 時，會疊在預覽上。

手機直拿時，App 的畫面也會轉成直的，內容一樣，只是排列不同：名稱和收音在上面，計時在下一行，上傳狀態和三個按鈕在最下面。直拿時寬度比較窄，「清除已傳完的影片」會簡寫成「清除已傳完」，按下去一樣會先列出要刪的影片讓你確認。

<p align="center">
  <img src="docs/images/phone-app-portrait.png" width="480" alt="手機 App 直拿時的畫面：名稱和收音在上面、錄影計時在下一行、三個按鈕在最下面排成一列，錄影中方向鎖住">
</p>

### 5. 播放、標記與整理影片

- **停止後馬上看**：影片傳完會自動放進那台手機的監看區播放，按「回到即時畫面」回去；點清單上的 ▶ 可以切換。按下開始錄影時，監看區會一律切回即時畫面，原本在播的影片會停掉；錄影中，上一段傳完也不會自動切去播放。
- **打開資料夾**：監看區下方的「在 Finder 中顯示」（Windows 是「在檔案總管中顯示」）會直接打開影片所在的資料夾，「專案」選單裡也有「打開專案資料夾」。
- **標記和清理**：覺得不錯的段落點右邊的星號，同一段的每台手機會一起標記。「專案」選單裡的「把沒標記的移到垃圾桶…」會一次清掉其他段；「選取要刪除的影片…」可以自己勾選（「選取沒標記的」能先幫你勾好）。刪掉的影片會進系統的垃圾桶（Windows 是資源回收筒），之後還救得回來；手機上的原檔不受影響。

![選取模式：勾選要刪的影片，標記星號的段落留下，下方工具列可以一起移到垃圾桶](docs/images/select-trash.png)

- 傳輸中的檔案副檔名是 `.part`，驗證通過後才改成 `.mp4`。
- 清單上會顯示同一次錄影的各台開始時間差幾毫秒，剪輯時可以參考；要精準對齊，建議用剪輯軟體依音訊自動同步。
- 在 Finder 或檔案總管裡刪掉影片或專案資料夾，清單上也會跟著拿掉。外接硬碟沒接上時紀錄會先保留，接回來就恢復。
- 手機上的原檔不會自動刪除。確認電腦上的檔案沒問題後，可以在 App 按「清除已傳完的影片」，它只會刪掉已經傳到電腦並驗證過的檔案。

## 使用情境：一次錄好長影片和短影音

![一次錄好長影片和短影音：CAM A 橫拿錄 16:9 給 YouTube 長影片、CAM B 直拿錄 9:16 給 Reels、Shorts、TikTok；直接直拿錄的 2160×3840 比從 4K 橫畫面裁切的 1215×2160 畫素多約 3 倍](docs/images/long-short.png)

例如訪談、講座、產品介紹，同一段內容想剪成 YouTube 的橫式長片，也想剪成 Reels、Shorts、TikTok 的直式短片：

- 一支手機**橫放**，拍 16:9 的畫面，剪長影片用。
- 另一支**直放**，拍 9:16 的畫面，剪短影音用。直接錄直的，不用從橫的畫面裁切，解析度比較高：4K 直拿錄的是 2160×3840，從 4K 橫的畫面裁出直的只剩大約 1215×2160，**畫素差了約 3 倍**。
- 按一次 `R` 兩支一起開始、按 `S` 一起停止，兩邊錄的是同一段時間，剪輯時很好對齊。

### 架設與錄影

1. **照想要的方向架好手機**：App 會跟著手機轉，直放錄 9:16、橫放錄 16:9，系統的「自動旋轉」關著也一樣。四個方向都可以，倒過來放也行（例如讓麥克風線往下走），錄出來都是正的。
2. **在控制台確認方向**：直放那台的監看區會變成直的，下方寫著「即時畫面・直式 9:16」；橫放的寫「即時畫面・橫式 16:9」。方向不對的話，把手機轉一下，控制台馬上跟著變。
3. **看即時畫面構圖**：每台各自調變焦。需要的話，在「錄影規格」選單打開構圖輔助框：
   - 橫的那台選 9:16，可以看出之後從橫的畫面裁出直式時，主角會不會出框。
   - 直的那台選 4:5 或 1:1，可以看出 IG 貼文的裁切範圍。9:16 就是直的那台的整個畫面，所以直的那台不會畫框。
4. **開始錄影**：按 `R` 或「開始錄影」，每台的監看區都會切回即時畫面，原本在播的影片會停掉，可以直接確認現在拍到什麼。錄影中，上一段傳完也不會自動切去播放。
5. **錄影中方向固定**：從按下開始到停止，方向都不會變，中途碰到手機也不會錄成一半直、一半橫。停止後，App 才會再跟著手機轉。
6. **停止後馬上檢查**：每台的影片傳完會自動在監看區播放，直式影片會直著播，清單上也會標「直式」。覺得不錯就點星號，同一段的兩支會一起標記。

### 剪輯時

- 直拿的影片和手機內建相機拍的一樣，檔案裡存的是橫的畫面，另外記著播放時要轉 90°。大部分的播放器和剪輯軟體都會自動轉正；遇到不認得的工具，在軟體裡把片段旋轉 90° 就好。
- 清單上會顯示同一段裡各台的開始時間差幾毫秒；要精準對齊，建議用剪輯軟體依音訊自動同步。

> [!NOTE]
> 從正上方往下拍時，手機平放分不出直橫，會沿用平放前的方向。請先拿成想要的方向、等畫面轉好，再放平。

## 人像設定：臉部優先、背景虛化、鎖定曝光

拍訪談、Podcast、課程這類以人為主的內容時，「錄影規格」選單最下面的「人像」有三個設定，所有手機一起套用。**全部交給手機的相機處理，解析度、位元率和每秒格數都不變**。

![錄影中的控制台：錄影規格是 1080p、背景虛化、鎖定曝光；直拿的 Pixel11Pro 監看區下方寫著「背景虛化・鎖定曝光」，做不到虛化的 ROG6D 只寫「鎖定曝光」](docs/images/portrait-settings.png)

<p align="center"><sub>錄影中的控制台：直拿的 Pixel 套用了背景虛化，兩台都鎖住曝光和白平衡。做不到虛化的手機照常錄影。</sub></p>

| 設定 | 預設 | 效果 | 適合 |
| --- | --- | --- | --- |
| **臉部優先** | 開 | 對焦、曝光、白平衡以人臉為準：背後有亮窗時臉不會黑掉，對焦也不會跑到背景。畫面裡沒有人時，跟一般的自動模式一樣 | 有人入鏡的拍攝 |
| **背景虛化** | 關 | 由手機自己的相機把背景模糊，讓人物更突出 | 訪談、Podcast 的人物鏡頭 |
| **錄影時鎖定曝光和白平衡** | 關 | 按下開始的那一刻鎖住，到停止前亮度和顏色都不變 | 燈光固定的室內 |

### 背景虛化

- **只有部分手機做得到**：手機的相機要有 Android 的「連續背景虛化」（Android 11 起的標準功能）。打開選單時，「背景虛化」底下會列出目前連線的手機裡哪幾台做得到、最高能錄多少解析度。手機原廠相機裡的人像影片、電影模式是廠商自己的功能，其他 App 用不到。
- **有解析度上限**：例如 Pixel 11 Pro 最高 1080p。選的解析度超過上限時，那台照樣用選的解析度錄，只是不虛化，**不會為了虛化偷偷降畫質**。想要虛化，就把解析度改成上限以內。
- **變焦範圍會變小**：例如 Pixel 11 Pro 虛化時只能在 1× 到 3× 之間，用不到超廣角。原本的倍率超出範圍時會先用最接近的值，關掉虛化後回到原本的倍率。畫面也可能比平常窄一點。
- **可能比平常熱一點**：虛化要由手機即時運算，雖然是手機的相機自己做、比 App 一格一格加工省得多，長時間錄影時還是建議接著充電。
- **控制台會標出來**：有套用的那台，監看區下方會寫「即時畫面・背景虛化」，即時畫面上也看得到效果。開了虛化的手機，對焦和曝光交給手機的人像處理，「臉部優先」在那台不另外套用。
- 想讓模糊更自然，拍法也有幫助：**讓人離背景越遠越好**，背景暗一點、乾淨一點。

### 鎖定曝光和白平衡

- 平常手機會一直自動調整亮度和顏色。錄到一半有人走過、窗外的雲飄過，畫面就跟著變；兩台手機還會各變各的，剪輯時很難對色。
- 打開後，每台在**按下開始的那一刻**鎖住當下的亮度和顏色，停止後恢復自動。錄影中，監看區下方會寫「鎖定曝光」。
- 開始前先讓畫面穩定下來（例如人先坐好、燈先打開），鎖住的才是你要的樣子。
- 適合燈光固定的室內。**戶外或燈光會變的場合請關掉**，不然光線一變，畫面就會太亮或太暗。

沒有濾鏡和美顏，原因請看[常見問題](#有濾鏡或美顏嗎)。

## 網路設定建議

![網路怎麼接最快：最推薦電腦接網路線；也可以讓電腦連 5 GHz、手機連 2.4 GHz；避免全部擠在同一個頻段、訪客網路和 VPN](docs/images/network.png)

- **最好讓電腦接網路線**：這樣每支手機的影片在空中只要走一段。
- **或讓手機和電腦分開頻段**：例如手機連 2.4 GHz、電腦連 5 GHz。兩邊在同一個頻段時，影片要在同一個頻道上走兩次（手機→路由器→電腦），容易變慢或卡住。
- 兩台都錄 4K 時合計約 80 Mbps，手機越多需要的頻寬越大。錄影中傳不完沒關係，停止後會補完；網頁上可以看到每台的傳輸速度。
- **不要用訪客網路**，訪客網路通常會隔離裝置，手機會連不到電腦。
- 電腦開著 VPN 時手機可能連不到，請關掉 VPN，或開啟它的區域網路存取選項。
- 電腦的 IP 變了手機就會連不到，重新掃一次配對的 QR Code 就好。常用的話，建議在路由器裡把電腦的 IP 固定下來。

## 常見問題

### 多機錄影要付費嗎？

**不用。** 多機錄影是 MIT 授權的開源軟體，電腦端和手機 App 都免費，沒有廣告，也不用訂閱或註冊帳號。

### 可以用 iPhone 嗎？

**目前只有 Android 12 以上的 App。** 電腦和手機之間的通訊格式是公開的（[`server/protocol.ts`](server/protocol.ts)），其他平台照著實作就能接上。

### 電腦端支援 Windows 嗎？

**支援。** 每次更新程式，GitHub Actions 都會在 Windows、macOS、Linux 上用兩支模擬手機（一支橫拿、一支直拿）把整個流程跑一遍：配對、即時畫面、變焦、人像設定、兩支同時錄影、傳檔和 SHA-256 驗證、中文的資料夾路徑、專案、標記、移到資源回收筒、偵測硬碟格式（NTFS、FAT32）。實際使用的是 Apple Silicon 的 Mac；Windows 還沒有人用實機錄過，選擇資料夾的視窗和「在檔案總管中顯示」也還沒實際試過，遇到問題歡迎開 issue。

### 需要網路嗎？影片會上傳到雲端嗎？

**不會上傳到雲端。** 錄影和傳檔只在你的手機和電腦之間進行，走同一個 Wi-Fi 的區域網路，不需要任何帳號；影片存在電腦上你選的錄影資料夾。只有第一次下載程式和 App 時需要上網。

### 錄影畫質會受 Wi-Fi 影響嗎？

**不會。** 影片是在手機上用原生畫質錄的，Wi-Fi 只負責傳檔和控制。Wi-Fi 慢的時候只是傳得比較久，停止後會把剩下的補完。

### 和把手機畫面串流到電腦（例如當成 OBS 的攝影機）有什麼不同？

串流的做法是把畫面即時傳到電腦，畫質會受網路影響，適合直播。**多機錄影是在每支手機上錄原生畫質，再把檔案傳回電腦**，適合錄完要剪輯的拍攝；它沒有直播功能。

### 最多可以接幾支手機？

**10 支。** 手機越多，Wi-Fi 頻寬需求越大（兩台 4K 一起錄合計約 80 Mbps），請參考[網路設定建議](#網路設定建議)。

### 可以同時錄直式和橫式嗎？

**可以。** 手機直拿就錄 9:16、橫拿就錄 16:9，同一次錄影裡可以混著用，例如一台錄長影片、一台錄短影音。做法請看[使用情境](#使用情境一次錄好長影片和短影音)。

### 有人像模式嗎？可以背景虛化嗎？

**有。** 「臉部優先」預設開著，對焦、曝光、白平衡都以人臉為準，大部分手機都能用。背景虛化要手機的相機做得到（例如 Pixel 11 Pro，最高 1080p），由手機自己處理，畫質不受影響；做不到的手機照常錄影。詳細請看[人像設定](#人像設定臉部優先背景虛化鎖定曝光)。

### 有濾鏡或美顏嗎？

**沒有，這是刻意的。** 暖色、日系、電影感這類濾鏡和美顏，手機的相機做不到，要由 App 一格一格加工：手機會更燙、更耗電，效果也會燒進影片，拍完就改不回來。兩支不同廠牌的手機套同一個濾鏡，顏色也還是不一樣。多機錄影負責錄出**乾淨、各台一致**的原始畫面，濾鏡和調色建議在剪輯軟體裡一次套到所有機位。

### 多支手機錄的影片怎麼對齊？

電腦會先和每支手機對時，**約好同一刻開始**，清單上會顯示各台實際的開始時間差。要精準到同一格畫面，建議用剪輯軟體依音訊自動同步，大部分剪輯軟體都有這個功能。

## 疑難排解

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
<summary>即時畫面有點延遲、不太順？</summary>

即時畫面是每秒約 5 張的小預覽（橫拿 640×360、直拿 360×640），用來確認構圖和變焦，所以會有一點延遲，看起來也不流暢；錄下來的影片是手機原生畫質，不受影響。Wi-Fi 很擠時會自動少送幾張，不會拖慢影片傳輸。只有電腦上的控制台開著、而且正在看那台時，手機才會傳。
</details>

<details>
<summary>開了背景虛化，畫面卻沒有變化？</summary>

打開「錄影規格」選單，看「人像」底下的提醒。常見的原因是那台手機做不到背景虛化，或是選的解析度超過它的上限（例如 Pixel 11 Pro 要 1080p 以下）。有套用的手機，監看區下方會寫「即時畫面・背景虛化」。另外，App 要更新到 0.4.0 以上才有人像設定。
</details>

<details>
<summary>直拿錄的影片，在剪輯軟體裡變成橫的？</summary>

和手機內建的相機一樣，直拿時影片檔裡存的是橫的畫面，另外記著播放時要轉 90°。大部分的播放器和剪輯軟體都會照這個記號自動轉正；遇到不認得的工具，畫面會是側的，在軟體裡把片段旋轉 90° 就好。
</details>

## 已知限制

- 手機端目前只有 Android App，錄影時 App 必須留在前景。
- 電腦端在 Windows 上還沒有人用實機錄過，選擇資料夾的視窗和「在檔案總管中顯示」也還沒實際試過；其他流程在 CI 上測過。Linux 沒有選擇資料夾的視窗，要直接貼上路徑。
- 影片存在 App 自己的資料夾（`Android/data/dev.multicam.recorder/files/Movies`），解除安裝 App 會連影片一起刪掉。
- 外接麥克風能不能被選用，依手機和麥克風而定，請以 App 上顯示的收音來源為準。
- 即時畫面是每秒約 5 張的低解析度預覽，只用來確認構圖和變焦，不能取代監看螢幕。
- 手機平放（例如從正上方往下拍）時分不出直拿或橫拿，會沿用平放前的方向。
- 背景虛化只有部分手機做得到，而且有解析度上限（例如 Pixel 11 Pro 最高 1080p），開了之後變焦範圍也會變小。
- 沒有濾鏡和美顏，調色請在剪輯軟體裡做。
- 還沒有雲端上傳，影片目前存在電腦上。
- 介面目前只有繁體中文。

## 給開發者

電腦端是 Node.js 24 直接執行 TypeScript（不用編譯），網頁控制台是 Preact＋htm，手機 App 是 Kotlin（Camera2＋MediaRecorder）。手機和電腦的通訊格式寫在 [`server/protocol.ts`](server/protocol.ts)，[`tools/fake-phone.ts`](tools/fake-phone.ts) 是不用手機也能測試的模擬手機。

模擬手機、自動測試、自己編譯 App、檔案結構和傳輸流程，請看 **[開發者文件](docs/development.md)**。歡迎開 issue 或送 pull request。

## English

**MultiCam Recorder** is a free, open-source multi-camera recording tool that turns Android phones into synchronized cameras. Open the web dashboard on your Mac or Windows PC, watch every phone's live view, set each phone's zoom, and start or stop all of them with one key. Each phone records phone-native 4K locally and streams the footage to your computer over local Wi-Fi while recording, so you can play it back shortly after you stop. No cloud account is needed and footage never leaves your local network.

- **Synchronized start**: press `R` / `S` to start or stop every phone (up to 10) at the same moment. The computer syncs clocks and schedules a common start time, and the dashboard shows the measured start offset between phones.
- **Portrait or landscape**: hold a phone sideways to record 16:9 or upright to record 9:16, so one phone can shoot the long-form video while another shoots the shorts in the same take. The app follows each phone's orientation and locks it while recording.
- **Portrait settings**: face priority (on by default) makes focus, exposure and white balance follow faces; background blur uses the phone's own continuous bokeh mode where the camera supports it (for example, Pixel 11 Pro up to 1080p); exposure and white balance can be locked for the whole take. Everything runs in the phone's camera pipeline, so resolution and bitrate stay the same. There are no filters on purpose: grade the clean footage in your editor.
- **Live view and per-phone zoom**: about 5 fps for framing; pressing record always switches every monitor back to the live view. Phones with ultra-wide or telephoto lenses switch lenses automatically.
- **Instant playback**: footage is uploaded while recording; after you stop, only the tail is sent and the file is verified chunk by chunk with SHA-256 against the phone's original.
- **Framing guides**: optional 9:16, 4:5 or 1:1 guides on the phone preview, the live view and the dashboard player; the full frame is always recorded.
- **Projects, marking and cleanup**: takes go into `<recording folder>/<project name>`; star the good takes (all angles together) and move the rest to the system Trash / Recycle Bin in one go.
- **External microphones**: USB and headset-jack mics are detected automatically, and the active input is shown on both the phone and the dashboard.
- **Resilient**: recording continues if Wi-Fi drops, and uploads resume automatically.

| | |
| --- | --- |
| Price | Free, MIT license |
| Computer | macOS or Windows with Node.js 24+ |
| Phones | Android 12+, up to 10 (no iPhone app yet) |
| Video | 4K / 2K / 1080p / 720p at 30 fps, MP4 (H.264 + AAC), up to 30 minutes per take |
| Network | Phones and computer on the same Wi-Fi; footage stays on your local network |

Quick start:

```sh
git clone https://github.com/dean9703111/multicam-recorder.git
cd multicam-recorder
npm install
npm start
```

Open <http://localhost:8787>, then download `MultiCamRecorder.apk` from [Releases](https://github.com/dean9703111/multicam-recorder/releases/latest) (or scan the pairing QR code and use the download link on the page that opens), pair each phone, create a project and press `R`.

Every push runs an end-to-end test with two simulated phones (one portrait, one landscape) on Windows, macOS and Linux in GitHub Actions; Windows has not been used with real phones yet. The phone protocol is documented in [`server/protocol.ts`](server/protocol.ts), so other phone platforms can be added. Developer notes are in [`docs/development.md`](docs/development.md). The UI is currently in Traditional Chinese. Product site: <https://deanlin.net/multicam-recorder/en/>

## 授權

[MIT](LICENSE)
