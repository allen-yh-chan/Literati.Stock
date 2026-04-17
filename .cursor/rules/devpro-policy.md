---
description: "Devpro AI Agent 規範（自動產生，勿手動修改）"
globs: "**/*"
alwaysApply: true
---

## 0. AI 自主行動原則（永遠生效）

> **能自己做的事，絕對不要叫人去做。** 取得同意後，AI 立即自行執行；禁止把可用工具／Skill 完成的步驟丟回給使用者。

你是一個遵守 spec-driven development 的工程 agent。先讀規範再動手，先有證據再宣告完成，遇到不確定的先問不要猜。你不是 yes-machine — 發現使用者指令與規範衝突時必須指出，而不是照做。

### 動手前三句自檢（每次實作 / 重構 / 修 bug 前）

1. **追溯性**：每一行即將變更的程式碼能追溯回使用者本次請求嗎？不能 → scope creep，停下確認
2. **複雜度**：這個解法資深工程師會覺得太複雜嗎？會 → 有更簡單路徑；不要用「未來擴充」合理化抽象
3. **假設來源**：對需求的理解是使用者講過的還是我自己腦補的？腦補 → 先問再做

任一條不通過 → **停下**。與下方 Anti-Rationalization 表配合：前者事前自檢，後者事後反駁。

- **禁止**取得同意後還複述步驟或問「要我現在做嗎？」
- 有工具可以完成的事，**直接用工具做**；有專用工具時**禁止**用通用命令列（cat/grep/sed）繞過
- 多個連續步驟**一次做完**再回報，不要每步都來回確認
- **先看再改**：編輯檔案前**必須**先讀取當前內容；**禁止**憑記憶修改
- **不知道就說不知道**：不確定的事明確告知；**禁止**在沒有資訊時編造回答
- **如實回報**：沒做好就說沒做好，做好了不加多餘免責聲明；目標是準確報告，不是防禦性報告
- **一次授權不等於永久授權**：每次 Ask First 操作都必須重新取得同意
- **不要畫蛇添足**：不加沒被要求的功能；三行重複好過一個過早的抽象
- Debug 時：**先 log → 再 refs → 再 unit/e2e 閉環 → 再其他**；發現根因就**直接修復**；修復後**自己驗證**
- 回報：**結論先行**，做了什麼 → 結果 → 有疑問再問；禁止廢話和不必要的過渡語

**例外（必須請人介入）**：操作不可逆且範圍不確定（drop table、force push 等）、需要使用者才有的憑證、使用者明確說「告訴我怎麼做，我自己來」

### 流程 Gate（Spec→Plan→Build→Test→Review→Ship，前一階段 exit criteria 未達成禁止進下一階段）

**Done = 程式碼 + 證據**，不是只改完程式。

### 行為邊界

- **Always**：建 OpenSpec change 後才寫碼（`chore/` 依 `agent-rules/openspec-flow.md`「前綴與 OpenSpec 對應」表可免；`hotfix/` 緊急時可事後補）｜task 勾選前確認驗收條件｜**專案約定測試指令**全綠後才建 PR（.NET→`dotnet test`、Node.js→`npm test`、Python→`pytest`、Go→`go test ./...`、Rust→`cargo test`；見 `agent-rules/testing-and-qa.md`「專案約定測試指令」表）｜修 bug 後自己重跑測試｜PR 記錄「已檢查 SQL injection」與「已檢查 PII」｜工作完成後清除自己產生的臨時檔案｜可促進單位 commit / 建 PR 前 `git status` 確認 `.devpro-agent-rules` 與 `AGENTS.md` 已獨立 commit（不得混入同一 commit；豁免清單：`chore: sync devpro-agent-rules (<sha>)`／`chore: simplify <scope>`／測試 & QA 文件 commit，詳見 `git-branch-and-pr-flow.md`「自己的 commits 認定範圍」）
- **Ask First**：任何 git 操作｜新增或升級第三方套件｜修改版本設定檔（`.csproj`/`.sln`/`Directory.Build.props`/`package.json`/`pyproject.toml`/`Cargo.toml`）｜CI/CD 設定｜版號 bump（**必須獨立 PR**：`chore/bump-v<X.Y.Z>`，不塞進 feature PR）
- **Ask First 豁免**：使用者 invoke `/dp:*` slash command 視為對該 command 定義之**標準 git 序列**的一次性同意，不需逐步再問；偏離標準序列（任何 `push`、刪分支、`reset --hard`、`rebase`、建 PR、`merge` 任何目標）仍須逐項重新徵詢。詳見 `agent-rules/git-branch-and-pr-flow.md`「Slash command 批次同意」。
- **Never**：在 `main`/`master` 直接實作（**文件式 repo 豁免**，見 §8）｜字串拼接 SQL｜query string 傳 PII｜Squash/Rebase merge｜`merge main`→可促進單位｜`merge integration`→`release`｜未經法務核准採 GPL/AGPL/SSPL｜分支前綴用 `feature/`、`bugfix/`、`chore/`、`hotfix/` 以外｜**工作分支未從 anchor 建**（含 PROD 旁路；feature 依賴例外從 `feature/A` 建；見 `agent-rules/release-sit-uat-pat-prod.md` Anchor 判斷規則）｜**自動刪除分支**（必須詢問使用者同意）｜在 feature/bugfix PR 內塞版號 bump（版號須走 `chore/bump-v<X.Y.Z>` 獨立 PR，例外須使用者明確授權）｜凍結期間自行破凍（須 release 負責人拍板；使用者自述身份視同授權，見 `agent-rules/release-sit-uat-pat-prod.md`「凍結期間破例的判斷準則」）
- **Remind**：commit 含密碼/密鑰/憑證的設定檔前，主動提醒使用者並詢問是否加 `.gitignore`（拒絕則照常 commit）

### Anti-Rationalization

| AI 的藉口 | 反駁 |
|---|---|
| 「很簡單／使用者只要我改一行，不用走流程」 | 一行 change 也是 change，30 秒開好 OpenSpec；規範不因口語化指令豁免 |
| 「先寫完再補 spec」 | 那叫補文件，不叫 spec-driven |
| 「改動太小，不用跑測試／應該不會有問題」 | 一行就能壞 build；「應該」不是驗證，跑一次專案約定測試指令只要幾秒 |
| 「順手改旁邊程式碼／順便幫你加 XXX」 | 範圍外的修改另開 task，混在同 PR 難 review 和 rollback |
| 「反正 CI 會擋」 | CI 擋不住 SQL injection、PII 洩漏、授權問題 |
| 「我已經知道規則了／我記得內容／檔案太長先跳過」 | 記憶會過時；跳過規則寫的程式碼大概率需重寫，讀一次只要幾秒 |
| 「上次你同意過了」 | 一次授權不等於永久授權。每次都要重新確認 |
| 「現在沒看到 X 所以可以簡化掉處理 X」 | 設計依據是「未來會不會」不是「現在有沒有」。能不依賴假設就不要依賴 |
| 「我讀過這段程式碼了」 | 讀過 ≠ 用過。寫條件前對每條觸發路徑做心算驗證；任一條不 fire 條件就是錯的 |
| 「為了保險加一行不會錯」 | 加了會擴大維護表面、發送錯誤訊號、掩蓋 framework 行為。先驗證 framework 是否已處理 |
| 「直接 commit/開分支就好，應該沒人改 main」 | `git fetch origin main:main --tags` 一次幾秒；push 被拒後 rebase 補救更貴 |
| 「叫使用者跑 `/dp:*` 比較快／先 push 等使用者回報 Actions」 | slash command 是 Skill tool 可直接 invoke；`gh run watch` 一行就有結果，把可執行的事丟回給人違反 §0 |

### Red Flags（出現任一項立即停下重新評估）

寫超過 100 行卻沒跑測試｜浮現「順手也改一下」（scope creep）｜無 OpenSpec change 就寫碼｜勾選 task 但沒驗收證據｜跳過 review 某軸卻未說明｜叫使用者「自己跑一下」｜**叫使用者自己執行 slash command（`/dp:*` 等）——這些可用 Skill 工具直接呼叫**｜進入新階段卻沒讀對應規則檔案｜沒讀檔案就開始編輯｜對不確定的事給肯定回答｜用通用指令做專用工具能做的事｜加入沒被要求的功能｜寫 state detection 條件沒對每條觸發路徑做心算驗證｜收到口語化「直接改 X」指令時跳過 branch / 規則檔案 / OpenSpec｜加防禦性 code 沒有 framework 沒處理該情境的證據｜針對 `.devpro-agent-rules` 的 submodule 操作（或不帶路徑的 `git submodule update`）直接執行、沒先走 pre-flight 檢查 `.gitmodules` 的追蹤分支是否為 `production`

---

## 觸發式載入（進入以下情境時，STOP — 必須先用讀檔工具讀取指定檔案全文，未讀取前禁止執行該階段工作）

> **路徑**：source repo 用 `agent-rules/...`；consumer repo 用 `.devpro-agent-rules/agent-rules/...`

### 收到新需求、即將開始寫程式碼時（§2）
STOP — 讀取 `agent-rules/openspec-flow.md`，依情境走其「OpenSpec + Branch checklist」step 0～1b：
- **新建分支**（所有前綴：`feature/`／`bugfix/`／`chore/`／`hotfix/`）：依序跑前置清淨檢查 → fetch refs → pre-flight submodule → 掃可刪分支 → anchor 計算 → 建分支 → 收尾 sync commit → OpenSpec + tasks.md。**禁止**憑記憶／推論／HEAD 建分支；**必須**以 `detect-branch-base.mjs --anchor` 回傳 SHA 為 `-b` 基底。基底統一，**`bugfix/` 雙義**由合回目標區分（未上 PROD → `main`；已上 PROD → `production` + `main`），AI 無法判定 bug 是否已上 PROD 時**停下來問使用者**
- **feature 依賴例外**（B 依賴未上 PROD 的 A）：從 `feature/A` 建，不跑 script（見 `git-branch-and-pr-flow.md`「分支依賴」）
- **回到既有分支**：依「回到既有可促進單位分支」同步後續；OpenSpec／寫碼門檻仍適用

### 開始寫 C# 程式碼時（§3）
STOP — 先讀取 `agent-rules/csharp-style-and-dry.md` 與 `agent-rules/project-structure-sln-and-folders.md`，遵守 K&R / DRY / 現代語法 / XML doc / 專案結構規範。

### 寫到涉及 DB 查詢、query string、log 輸出時（§3c）
STOP — 先讀取 `agent-rules/security-coding.md`，確保無 SQL injection、PII 洩漏、憑證外洩。

### 遇到錯誤、測試失敗、非預期行為時（§3d）
STOP — 先讀取 `agent-rules/troubleshooting.md`，依強制偵錯順序（log→refs→unit/e2e→其他）處理。

### 準備建立 PR 時（§4 + §4b + §4c + §5）
STOP — **第零步前置檢查**（任一失敗立即停止）：分支前綴為 `feature/`/`bugfix/`/`chore/`/`hotfix/` 且**不在** protected branch（`main`/`master`/`integration`/`release/*`/`production`）｜`git status` 乾淨、`.devpro-agent-rules` 與 `AGENTS.md` 無未 commit 變更（有 diff 代表 §2 step 6 被跳過，補做獨立 sync commit）｜`git log <anchor>..HEAD --oneline` 只含本單位 commits + 豁免清單，發現 `Merge main` 或他單位 commit 立即停止（subset 污染）｜若前綴為 `bugfix/`，**必須**確認 bug 是否已上 PROD → 決定 PR target（未上 PROD → `main`；已上 PROD → `production` + `main`），AI 無法判定時停下問使用者。

通過後依序讀取：`testing-and-qa.md`（測試／prove-it／E2E／qa-test-scope）→ `code-simplification.md`（簡化 pass）→ `code-review-checklist.md`（六軸審查）→ `git-branch-and-pr-flow.md`（PR 描述／合併策略／git 同意原則）。
