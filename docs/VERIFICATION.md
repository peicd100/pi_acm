# 本次包裝驗證

## 已驗證

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

- GitHub remote 安裝：必須先推送程式碼與 tag，再在新的測試環境驗證。
- Linux／macOS 與 Node.js 22：已提供 CI workflow，尚未執行遠端 CI。
- Live provider 與實際 backend 容量：mock tests 不代表 backend qualification。
- 授權／upstream provenance：待維護者確認，暫標 `UNLICENSED`。

既有 `1.txt` index／working-tree 差異未更動；本次未建立本專案 commit、push、GitHub release 或遠端 tag。
