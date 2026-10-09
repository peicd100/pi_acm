# Pi ACM Passive

**不摘要、自動滑動的 Pi context window 管理插件。** 原始 transcript 保留在 Pi session；ACM 只調整下一次送給模型的 context，不會呼叫額外模型產生摘要。

版本：`1.4.1`。套件名稱 `pi-acm-passive`；GitHub repo 名稱 `pi_acm`。這不是 npm 的 `pi-acm` 套件。

## 安裝

需求：Node.js 22 以上、Git、已安裝的 Pi。開發與整合驗證使用 `@earendil-works/pi-coding-agent@1.1.0`；其他 Pi 版本尚未在本 repo 驗證。Pi API 相容性不代表每個模型／provider 都已實測。

```sh
pi install git:github.com/peicd100/pi_acm
```

建議固定版本安裝：

```sh
pi install git:github.com/peicd100/pi_acm@v1.4.1
```

兩者擇一；不要和原來的本機 passive ACM、npm `pi-acm` 或其他 compaction/context 管理插件同時載入。先用 `pi list`、`pi config` 檢查並停用重複插件。Extension 會以 Pi 的 OS 權限執行，安裝前應審閱來源。

安裝後重新啟動 Pi，或在**沒有工具執行、沒有排隊訊息**的 idle session 執行 `/reload`。然後：

```text
/acm-status
/acm-config 95 85
```

首次使用請執行 `/acm-config 95 85`，將當前模型的 Pi native token budget 與 ACM 比例同步。設定尚未符合時，插件會安全拒絕請求，而不是自行產生摘要。切換模型後也應在 idle 時執行 `/acm-config <trigger> <target>` 同步新模型。

本機開發安裝：

```sh
npm ci
pi install .
```

`pi install .` 會修改目前使用者的 Pi package 設定；測試不想碰個人環境時，請改用下方 `npm run test:install`。

## 指令

| 指令 | 用途 |
|---|---|
| `/acm-status` | 顯示 native usage、policy、校準 budget 與保存的 boundary |
| `/acm-config` | 唯讀顯示目前百分比與說明 |
| `/acm-config 95 85` | 保存 trigger 95%、target 85%，並 reload idle session |
| `/acm-config reset` | 還原預設 95%／85%，同步當前模型 budget |

接受小數與 `%`，例如 `/acm-config 85.5% 75%`。要求 `0 < target < trigger < 100`；建議間距 5–10 個百分點，小於 5 只會警告，不會任意禁止。

`/acm-anchor`、`/acm-restore`、`/acm-checkpoint` 已移除；舊 session 的 branch state 與 historical anchor 仍按原有邏輯重建，不會因移除指令而復活已排除訊息。

## 滑動行為與限制

1.4.1 的新安裝與 reset 預設是 95/85；升版不覆蓋既有自訂比例。高保留量不保證降低延遲，也不修復 provider 串流中斷。Window/config 使用新 versioned module path，避免同 process reload 沿用舊 ESM defaults。

- **Trigger**：校準後的下一次 input 超過有效容量的指定比例，才啟動滑動。
- **Target**：選擇近期 chronological suffix 時的目標比例；必要內容和完整 tool batch 優先，因此不是精確保留比例。
- 有效容量為模型 metadata 的 `contextWindow` 與 `policy.json.contextCap` 的較小值；預設 cap 是 `1,050,000`，**不是宣稱 backend 支援這個容量**。
- System/tool declarations、當前 user input、自動 task anchor、最新完整 tool batch 受保護；tool calls/results 不拆散。
- 未知／無效 cost、不成對的 tool batch、必要 input 過大會 fail closed，不會改用 AI 摘要或默默丟棄必要指令。
- 較舊的大段 tool text 可能只送出 bounded preview；原始 transcript 不改寫。
- 成功且 usage 有效的對應 response 才提交 cut；ESC、error、guard failure 不提交，也不訓練 calibration。
- 原始紀錄存在不代表模型仍看得到所有舊內容；長期需求／決策請另存工作檔。
- Footer `ACM 40.8%` 使用 Pi native usage；與校準後下一次請求 budget 是不同測量。

Producer 與 independent no-summary guard 的順序固定為 `extensions/index.ts`、`extensions/no-summary-guard.ts`。Guard 會取消 native threshold、overflow、manual compaction 與 tree summary；policy/config 無效時也不允許 fallback AI summary。這是應用程式保護，不是 OS sandbox；不受信任的後載入 extension 可能繞過保護。

## 設定保存與副作用

比例保存在套件外的 **Pi user settings**，因此套件更新不會清除：

```json
{
  "acm": {
    "triggerPercent": 95,
    "targetPercent": 85
  }
}
```

`/acm-config` 會在 idle 時原子更新 user `settings.json` 的 ACM 比例、`compaction.enabled=true`、native reserve/keepRecent 與**當前模型** override，再 reload。其他設定與其他模型 override 保留；不寫 project settings，不讀取未受信任 project 設定。受信任 project 的衝突設定會在寫入前拒絕。

Native `reserveTokens = model.contextWindow - floor(effectiveCapacity × triggerRatio)`；`keepRecentTokens = floor(effectiveCapacity × targetRatio)`。修改不會復活歷史 context，也不改寫 session cursor、calibration 或工作檔。其他正在執行的 Pi session 必須自行 idle reload。

Save 使用 Pi-compatible 短 lock、同目錄 temporary file 與 rename。Save 失敗保留原檔；reload 失敗只有在設定檔仍等於此次保存版本時才還原，避免覆蓋他人的後續修改。失敗後請在 idle 手動 `/reload`。

SDK 的 custom `agentDir` 須同步 `PI_CODING_AGENT_DIR`，並提供真正的 `commandContextActions.reload`；預設 no-op 不足以同步設定。

## 更新與移除

追蹤 branch 的安裝可以更新：

```sh
pi update git:github.com/peicd100/pi_acm
```

固定 tag 不會自動跳到新 tag；升版時安裝新的 tag，確認只保留一份 package。移除時請使用與安裝相同的來源：

```sh
pi remove git:github.com/peicd100/pi_acm
# 若安裝的是固定版本：
pi remove git:github.com/peicd100/pi_acm@v1.4.1
```

移除後 idle `/reload` 或重啟。**移除 package 不會還原 `/acm-config` 修改的 user settings。** 改回 native compaction 前，請在 `pi config`／settings 中檢查 `acm`、`compaction.reserveTokens`、`keepRecentTokens` 與相關 model override；只調整確定屬於 ACM 的項目，不要用舊備份整份覆蓋後來的其他設定。`/acm-config reset` 是重設 ACM 比例，不是卸載還原。

## 開發與驗證

```sh
npm ci
npm run check:package
npm test
npm run test:install
```

- Regression tests 使用 disposable credential stubs、mocked streams，不呼叫 signed-in providers。
- Test host 預設從本 repo 的 devDependency 解析，不硬編碼個人 home path；也可設定 `PI_TEST_HOST` 指向已安裝的 Pi coding-agent package 目錄。
- `test:install` 使用真正的 Pi Git install／tag／list／load／remove，Git URL 只在測試子程序透過 `insteadOf` 導向 disposable local Git repo；**不 push、不碰個人 Pi 設定**。測試包含空白／非 ASCII 路徑。
- 安裝測試可能透過 npm registry 下載 `gpt-tokenizer`，但不呼叫模型。失敗保留 fixture 並顯示位置；成功刪除 fixture。
- `npm run test:remote` 可在 disposable Pi 環境驗證真正的 GitHub `v1.4.1` 安裝／載入／移除；需要 GitHub 與 npm registry 網路，不會修改個人 Pi 環境或呼叫 provider。
- Tests 通過不代表 live-provider activation 或 backend capacity 已驗證。

發布流程見 [docs/RELEASING.md](docs/RELEASING.md)。

## 授權狀態

目前保留 `private: true`（防止意外 npm publish）及 `license: UNLICENSED`。**Git 安裝仍可運作，但本 repo 尚未授予一般開源授權**；若要授予修改／再散布等開源權利，維護者須確認程式碼來源／第三方 attribution 並選定授權。見 [LICENSE](LICENSE) 與 [NOTICE.md](NOTICE.md)。
