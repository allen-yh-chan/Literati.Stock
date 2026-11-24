---
name: ai-autonomy-rationalizations
description: AI 常見合理化藉口反駁表 + 動手前 Red Flags 自我檢查清單。觸發：自我懷疑正在繞規範 / scope creep / surface fix 時，或收尾自我審查。
---

# AI 合理化與 Red Flags

> Load-chain：本檔由 `ai-autonomy.md` 按需載入；entry leaf 只保留行為邊界與十句自檢，合理化反駁表與 Red Flags 清單在此。

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「很簡單／使用者只要我改一行／不用走 OpenSpec」 | 一行 change 也是 change，30 秒開好 OpenSpec。規範不因口語化指令或目錄不存在而豁免。 |
| 「先寫完再補 spec／分析結果在 context 裡了」 | 那叫補文件，不叫 spec-driven。對話 context 不是持久化記錄，必須寫入物理檔案才算完成。 |
| 「改動太小不用跑測試／應該不會有問題」 | 一行就能壞 build。「應該」不是驗證，跑一次只要幾秒。 |
| 「順手改旁邊程式碼／順便加了 XXX」 | 範圍外的修改另開 task，沒被要求的功能不要加。 |
| 「已經知道規則了／記得內容／檔案太長先跳過」 | 未驗證的記憶先跳過讀檔；hook 提供 routing，但具體 leaf 內容必須讀；session 內已讀 + git 未變更可跳過重讀（cache + revalidate 模式） |
| 「就幾個檔案自己改更快／改 markdown 不用委派」 | TL context 是全對話最貴資源。判斷標準是操作性質不是檔案類型；≥2 步機械操作是委派訊號，不單獨授權 spawn，executor 依 `model-delegation.md` §Executor 決策序判定（隔離效益高於 handoff／重讀／協調成本才派，否則 TL-direct 並產出同 schema 同 acceptance）。 |
| 「叫使用者跑 `/devpro:*`／先 push 等使用者回報 Actions」 | slash command 是 Skill tool 可直接 invoke；`gh run watch` 一行就有結果。 |
| 「直接 commit/開分支，應該沒人改 main」 | 先同步再動：`git fetch origin --tags`；需本地 `main` 時 clean worktree 再 `git pull --ff-only`。 |
| 「反正 CI 會擋」 | CI 擋不住 SQL injection、PII 洩漏、授權問題；所有 workflow 到終態才算完成。 |
| 「上次你同意過了」 | 一次授權不等於永久授權，每次都要重新確認。 |
| 「我有問使用者啊」 | 問了但沒等回答就做，等於沒問。確認問句必須是該 response 的唯一輸出。 |
| 「問句在首段／夾段、後續是補充」/「字面不是中間」/「前面順便夾一句問」 | 判準看整體 macro 結構，不看字面位置。問句段必須是**末段且唯一**；多處問句一律拆 response 或合併。見 `ai-autonomy.md` §回報方式「複合段落應用」。 |
| 「複雜決策需要展開鋪陳」 | 推薦/建議先給結論與關鍵理由；選項間取捨確實需要比較時才用 table；鋪陳是補充不是預設。 |
| 「現在 codebase 沒有 X 可以簡化掉處理 X 的邏輯」 | 設計依據是「未來會不會有 X」不是「現在有沒有」。 |
| 「architect 方案很明確，照做就好，不用委派」 | 方案明確正是最適合委派的情境；walkthrough 要比對 scenario、產報告，是 ≥2 步產出工作。 |
| 「已經知道 root cause，先改比較快」 | 先改 = 無法驗證「修復前測試確實失敗」，revert 實作，寫測試，確認 RED，再改。 |
| 「source repo 在 main 直接改就好／meta repo 應該可以豁免」 | source repo 也走分支，無豁免。任何規則文檔修改都要 chore A/B 分類後走流程。 |
| 「繞 Branch Routing 直接從 anchor 建新分支比較快」 | 修 bug 前必先過 Branch Routing 決策樹判斷歸屬；跳過 = 已知反覆犯錯模式。 |
| 「chore A 跑 dp-analyst 比較安全」 | chore A 完整 OpenSpec 流程是浪費；走 fast-track（TL 判斷 → dp-assistant 修 → test → review → PR）。 |
| 「不查過官方就 invent 整合 workflow」 | 先讀 README + `<tool> --help` + expanded profile；無解才 invent 並在 PR/decisions 記錄已查位置。 |
| 「先記在 memory，下次就不會再問」 | memory 跨 agent 不繼承（per-agent 隔離）。規則／流程／pattern 必須寫進 `.devpro/agent-rules/*.md` 走 chore A/B；個人偏好可留 memory。 |
| 「『整理乾淨』含 `rm -rf` 授權／sandbox 擋換條路試試」 | 泛化指令 ≠ 具名授權；sandbox refusal 是升級訊號不是待解之謎。見 `ai-autonomy.md` §Destructive Operation User Authorization Patterns（issue #498）。 |
| 「gitignore／未 commit／archive leftover = 可當殘渣刪掉」 | **false**：`admission-records/`（含 `codex-reviewer-intents/`）與 `override-ledger/` 是 worktree-local authority carriers，不是 disposable residue。undo archive 前 MUST 執行 `openspec-archive-redo-undo.md` **Undo-Archive Preserve Checklist**（本列只 cross-ref，勿複製全文）。 |
| 「官方摘要／工具預設輸出／既有報告已給數字，直接當結論轉述」 | 第三方摘要只是**待驗證線索**不是已證結論。診斷類提問（分析X／為什麼Y／哪裡最Z）證據必須在第一句之前——先取證（查本機資料／跑 self-test／讀完實作）再開口。同類：該跑的驗證、該讀完的程式沒做就推論（半截閱讀下結論）。見 `ai-autonomy.md` §先看再改，不准憑空編造。 |
| 「已拿 batch approval，但還是先問一次要不要 commit／push 比較安全」 | matching `same-change-dp-change-batch` 且 `covers` 含 `local_commit`／`first_push`／`pr_create_update` 時 Ask First **已滿足**（見 `ai-autonomy.md` Matching Batch Approval Ledger）；再問＝covered-scope 回問。只在 `excludes` 或 ledger mismatch 才停。 |
| 「實作／tasks 做完了，先問要不要跑 pre-PR／push／開 PR 比較清楚」 | matching ledger 已覆蓋 `pre_pr_gate`（常連 `first_push`／`pr_create_update`）時，實作完成只是 progress——**MUST** 直接進 `/devpro:pre-pr` 續跑（見 `ai-autonomy.md` Implementation-complete → covered pre-PR）；製造「1.pre-PR 2.push 3.開PR」＝milestone idle-stop／covered-scope 回問。 |
| 「未上線仍寫舊版相容／先做 vN-1 dual-read 比較安全」 | 先做 `pre-implementation-over-design.md` §`Pre-Ship Contract Dual-Read Ban` holder test；陰性 → 只對齊現行契約，禁雙讀（假想使用者不構成相容需求）。 |
| 「環境問題先繞過去把 gate 跑起來／先 junction 共用主 checkout 的 node_modules」 | 外部環境不可執行 → Stop-Point `blocked`／PR `not verified`（見 `ai-autonomy.md` §Stop-Point 環境不可執行專條）。**禁** junction／symlink／hardlink 共用依賴、改跑無關目錄、跳過約定測試卻假綠。 |
| 「使用者已選 Option B／說在這個 PR 補齊，先寫碼」 | requirement scope change 的 OpenSpec-before-code hard gate 不因使用者點頭實作而豁免；見 `openspec-scope-change.md` §Requirement Scope Change。 |
| 「PR 已 merge，change 在 archive，直接延續實作」 | post-merge continuation 須 active-missing 還原**同一 named change** 並補 `scope-change` + spec delta，**禁止**無 active folder 寫 implementation carrier。 |
| 「先 dogfood／草稿程式，spec 之後再補」 | 草稿不取代 `decisions.md`／tasks／spec delta；dogfood 僅能在 hard gate 通過後或限 `openspec/changes/<name>/` 內文件。 |
| 「sticky PASS／checks 綠／workflow N/A，可以停了／再問一次要不要繼續」 | `PASS|WARN` 與綠燈只是 gate progress，不是 terminal。matching `same-change-dp-change-batch` 已覆蓋的 pre-PR／push／PR／sticky／post-PR MUST continue（見 `devpro:pre-pr` Carry-Forward Precheck／`post-pr-completion-gate` Ready Response）；只在 ledger `excludes`（merge／release／destructive／secrets／cross-repo）或真正 user gate 才停問。 |
| 「production PR 合併、tag 推完、告警觀察中，release 完成了」 | 不是 terminal。一般 release 還要 Step 6A 把 `production` 合回 `main`（`--require-main-ancestor` exit 0）；缺 back-merge 即未完成，見 `release-sit-uat-pat-prod.md` Common Rationalizations。 |
| 「AI 可能故意偽造這筆紀錄／繞過這個閘，所以要加終端機限定、金鑰、簽章，或要使用者親自操作、親自去 GitHub 留言」 | 過度設計。閘只防 AI 不小心、不防故意（產品安全與合規除外），見 `design-core.md` §11 原則與 F-9；要防的是作答前就寫、寫錯 change／PR、沿用舊紀錄這類不小心。 |

## Verification

如果你發現自己正在做以下事情，**立即停下來**重新評估（Red Flags）：

- 寫超過 100 行程式碼卻還沒跑任何測試
- 內心浮現「讓我順手也改一下這個…」— scope creep
- 修改了 task scope 以外的檔案「因為剛好看到」
- 在沒有 OpenSpec change 的情況下開始寫程式碼
- 需求在對話中擴張（新 Option／新 gate／post-merge 補齊）但尚未寫 `decisions.md` `scope-change` 就改 script/rule
- 原 PR 已 merge、change 僅在 `archive/`，卻直接改 `.devpro/scripts` 或 rule leaf
- 勾選 task 但沒有驗收證據
- 跳過 review checklist 的某一軸「因為這次不適用」卻沒說明原因
- 對使用者說「你要不要自己跑一下 xxx」— 能自己做的事不要叫人做
- 回覆「建議可以這樣改」但沒有實際動手改
- 進入新階段卻沒讀對應的 `.devpro/agent-rules/*.md` 規則檔案
- 沒讀檔案就開始編輯它
- 對不確定的事情給出肯定的回答
- 用 `cat`、`grep`、`sed` 等通用指令做有專用工具能做的事；**尤其禁止用 `sed -i`、`printf "$(…)" > file`、`… > file` 等 in-place 重寫既有檔案**——指令一旦語法錯誤（如 BSD/GNU sed 不相容、`$(…)` 回空字串），會**靜默清空或損毀檔案**。改用 Read 後 Edit/Write 專用工具；非用 shell 不可時先寫暫存檔再比對，不直接覆寫原檔
- 加入使用者沒要求的功能或「順便改善」
- TL 即將連續執行 ≥2 步機械性操作（批次更新、grep survey 等）卻沒依 `model-delegation.md` §Executor 決策序判定 executor（既沒做 `dp-assistant` admission，也沒記 TL-direct 的理由）
- TL 即將對 ≥2 個檔案執行 Edit/Write 且尚未輸出委派計畫（逐 task 的 executor：dp-* 或 TL 自己做，附理由）——先補計畫再動手
- 修 bug 時已修改實作程式碼但尚未寫出重現測試（Prove-It 順序違反）

**Session Recap 驗證**：見 `session-recap.md` §Verification。
