# GitHub 發布流程

本文件供維護者後續發布使用；commit／push／tag 均須經明確授權。本次首次發布依維護者要求完成，不代表後續版本會自動發布。

## 1. 先確認授權與曝光範圍

- 目前採 `UNLICENSED`，不宣稱一般開源授權；Pi Git 安裝不要求 npm publish 或 MIT。若要改採開源授權，須先確認原始碼權利與 upstream attribution，再更新 `LICENSE`、`NOTICE.md`、`package.json`。
- `private: true` 可繼續保留：只防止 npm publish，不阻擋 Pi Git 安裝。
- 若要讓所有人直接安裝，GitHub repo 必須是 public；private repo 只適用有 GitHub 存取權的使用者。不會自動改 repo visibility。
- 不上傳 `AGENTS.md`、`.peicd100/`、個人 settings/auth、`node_modules/`、log 或 credentials。

## 2. 本機驗收

```sh
npm ci
npm run check:package
npm test
npm run test:install
npm pack --dry-run
```

`.github/workflows/ci.yml` 已配置 Node.js 22 在 Linux／Windows／macOS 的相同驗證；須推送後才會執行，尚不可把它視為已通過的跨平台證據。

`test:install` 使用 disposable local Git repo；不是實際 GitHub remote 安裝驗證。

## 3. 審閱 Git 狀態後明確加入發布檔案

```sh
git status --short
git diff --cached
```

本專案原先已有 `1.txt` 的 staged 變更且 working tree 中缺檔；請先由維護者決定如何處理。**不要直接 commit 現有 index，也不要用 `git add .` 混入無關變更。**

預期的發布檔案：

```sh
git add .gitignore .gitattributes .github package.json package-lock.json README.md CHANGELOG.md LICENSE NOTICE.md policy.json extensions src tests scripts docs
```

再檢查 staged files／diff，確認沒有無關變更、個人資訊或 secrets。若 index 仍包含既有 `1.txt` 變更，先明確決定其處理方式，不要盲目 commit。

## 4. 推送與建立固定版本

完成授權、檔案與 index 審查後才操作：

```sh
git commit -m "Package passive ACM 1.4.2 for Pi Git installation"
git push origin HEAD
git tag v1.4.2
git push origin v1.4.2
```

這些命令須由維護者自行執行或另外明確授權；若 tag 已存在，不要覆蓋或 force push，改用新的版本號。

## 5. 從 GitHub 做最後驗收

發布 tag 後，可在本 repo 執行 `npm run test:remote`：它使用 disposable Pi 使用者環境，直接從公開 GitHub 安裝固定版本，驗證 list／load／remove，不做 URL 重導、不讀取個人 Pi 設定、不呼叫 provider。

也可在全新／可拋棄的 Pi 使用者環境手動測試：

```sh
pi install git:github.com/peicd100/pi_acm@v1.4.2
pi list
```

啟動 Pi，在 idle 時執行 `/acm-status`、`/acm-config 95 85`，確認兩個 extensions 載入無錯誤。測試 provider 時會使用該測試環境的 credentials 並可能產生費用；先確認授權與 budget。卸載也應驗證；package 移除不會還原 ACM-owned user settings。

## 後續版本

更新版本與 changelog，跑相關測試及安裝 smoke，再建立新 tag。固定 tag 的使用者不會自動跳版；branch 使用者以 `pi update git:github.com/peicd100/pi_acm` 更新。不要更動已發布 tag。
