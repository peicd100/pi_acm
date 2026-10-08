# 本次包裝驗證

## GitHub 發布與實際安裝驗證

- 公開 repo：<https://github.com/peicd100/pi_acm>。
- 已發布 `v1.4.0` tag，release commit：`fad62b94a4c338b2cc52554363fb09f636ecaa76`。
- `npm run test:remote` 通過：直接從公開 GitHub 安裝 `git:github.com/peicd100/pi_acm@v1.4.0`，安裝後 HEAD 與 release commit 一致。
- 驗證真正 Pi Git install／固定 tag／list／兩個 extensions load／remove，runtime tokenizer 有安裝，沒有複製 Pi host libraries。
- 使用 disposable Pi 設定目錄與空白／非 ASCII 路徑；沒有修改個人 Pi 設定，也沒有呼叫 provider。
- 原有 `1.txt` 暫存 entry 保留且未加入 release commit；個人 AGENTS／PEICD／credentials 未發布。

## 套件化階段已驗證

環境：Windows、Node.js `24.13.1`、Pi SDK `1.1.0`。

| 項目 | 結果 |
|---|---|
| 原始 runtime／policy 保真 | 6 個檔案與本機 passive 1.4.0 byte-identical |
| `npm run check:package` | PASS：manifest、guard 順序、policy、可攜檔案 |
| `npm test` | 64／64 通過，0 skipped；mocked model streams |
| `npm run test:install` | PASS：真正 Pi Git install、固定 tag、list、extension load、remove |
| 空白／非 ASCII 路徑 | 隔離安裝測試通過 |
| Runtime 依賴 | 安裝 tokenizer；不複製 Pi host libraries |
| `npm pack --dry-run` | Runtime 文件齊全，排除 personal memory／dependencies／credentials |

隔離測試將假 Git URL 在**測試子程序**重導向 disposable local Git repo；未推送 GitHub，未修改個人 Pi settings，未發出模型請求。暫存 repo 中的 fixture commit／tag 只用於測試，不是本專案的 commit／tag。

## 尚未驗證／發布前事項

- GitHub remote 安裝已通過上方的實際驗證；live-provider 測試與跨平台 CI 是另外的驗證範圍。
- Linux／macOS 與 Node.js 22：已提供 CI workflow，尚未執行遠端 CI。
- Live provider 與實際 backend 容量：mock tests 不代表 backend qualification。
- 授權／upstream provenance：待維護者確認，暫標 `UNLICENSED`。

套件化階段沒有 commit／push；後續依維護者明確授權建立發布 commit，並推送 main 與 `v1.4.0`。未建立額外 GitHub Release 頁面，Pi Git 安裝只需要 repo 與 tag。
