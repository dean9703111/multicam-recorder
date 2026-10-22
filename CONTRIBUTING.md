# 參與開發

謝謝你願意幫忙！不管是回報問題、改文字還是改程式都很歡迎。

## 回報問題

到 [Issues](https://github.com/dean9703111/multicam-recorder/issues/new/choose) 選「回報問題」，照表單寫下發生了什麼事、怎麼做會遇到，和電腦、手機的版本（多機錄影的版本寫在控制台「設定」的最下面）。

## 改程式

開發環境、架構和測試方法都寫在 [docs/development.md](docs/development.md)。需要 Node.js 24 以上和 ffmpeg（模擬手機用）。

送出 pull request 之前，請確認這三個都通過（CI 也會在 Windows、macOS、Linux 上跑）：

```sh
npm run typecheck   # 型別檢查
npm run check       # 控制台 JS 的語法、中英文字串、版本號是否一致
npm run smoke-test  # 用模擬手機把整個流程跑一遍，大約 40 秒
```

幾個約定：

- **好用、出問題時說清楚怎麼辦**：錯誤訊息寫成「發生什麼事＋可以怎麼做」，放在使用者一定看得到的地方。
- **文字中英文一起改**：控制台在 `server/public/i18n.js`，伺服器在 `server/i18n.ts`，App 在 `android/app/src/main/res/values*/strings.xml`。`npm run check` 會擋下只改了一種語言的情況。
- **功能改了，文件也要改**：README（中文和 English 段落）、產品網站（`docs/index.html`、`docs/en/index.html`）、`docs/development.md`。
- 改了手機和電腦之間的通訊格式，要一起改 `server/protocol.ts` 的說明和 `tools/fake-phone.ts`。

---

## Contributing (English)

Bug reports, wording fixes, and code are all welcome. When reporting a problem, use the issue form and include your computer and phone versions (the MultiCam Recorder version is at the bottom of **Settings** in the dashboard).

Development setup, architecture, and testing are described in [docs/development.md](docs/development.md) (in Traditional Chinese). You need Node.js 24+ and ffmpeg. Before opening a pull request, make sure `npm run typecheck`, `npm run check`, and `npm run smoke-test` pass. Update Chinese and English strings together, and keep the README and product website in sync with feature changes.
