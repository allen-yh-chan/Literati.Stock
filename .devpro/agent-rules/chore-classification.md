---
name: chore-classification
description: 變更形狀三類分類（A / B-mini / B）判斷表 + 版號 bump gate + 各類 Fast-Track 路徑。openspec-flow.md Overview 段的分類外部化（檔名歷史保留；語意＝change-classification）。
---

# 變更形狀分類（Change Classification）

## Overview

定義**變更形狀**三類分類（A / B-mini / B）+ 各類 fast-track 路徑。適用前綴：`chore/`、`feature/`、`bugfix/`、`hotfix/`。**分類維度是變更形狀，不是分支前綴**——前綴仍保留語意與 anchor 職責（含 hotfix 的 `production-*` tag），但不得只因前綴把 feature/bugfix/hotfix 強制綁定 full path。檔名 `chore-classification.md` 保留以穩定既有 pointer／grep guard；語意等同 change-classification。TL 開上述任一前綴分支時**必須**主動判定並告知使用者。

## When to Use

收到 `chore/` / `feature/` / `bugfix/` / `hotfix/` 分支請求、版號 bump（`chore/bump-v<X.Y.Z>`，屬 A 類 metadata-only gate）、或依賴升版 A vs B 判斷時載入。

## Process

> **規範同步（consumer rules lane）**：舊規範同步路徑已退役，consumer repo 改走 `rules/<source>-v<X.Y.Z>` 獨立 release lane（見 `rules-flow.md`、`release-sit-uat-pat-prod.md` Rules Lane）；本檔以下 chore A/B-mini/B 三類分類**不**含此路徑。

### A vs B 判斷（形狀表；四前綴共用）

先解析 rigor 並讀 `rules-rigor-level.md` §升 full：本表只決定 full 已獲授權時的 artifact 深度，B 分類不會自動把 lite 升為 full。lite 的免除與保留以 rigor 矩陣為準；升級須先有理由及使用者明確同意。

| 判斷項 | A 類（免 OpenSpec） | B-mini（迷你 OpenSpec）| B 類（完整 OpenSpec）|
|---|---|---|---|
| 外部行為會變嗎？ | 否 | 改規則 phrasing / 補既有 framework 的 mechanical gate | 是（新功能 / 新 capability）|
| 使用者／呼叫方會察覺嗎？ | 否 | 是（agent 行為換 mechanical gate）| 是 |
| QA 需要回歸測試嗎？ | 否 | grep-based assertion 即可 | 完整 regression + functional |
| 是否改變 agent 路由／gate／收尾條件？ | 否 | 是（小修補）| 是（新增 / 大改）|
| 觸及範圍 | 任意 | 不新建 capability spec；既有 capability MODIFIED Requirement 不限數 | 含新建 capability 或 ≥ 2 capability MODIFIED |
| 規模 | 任意 | 淨增 markdown ≤ 100 行（計法見 §計數定義）；新增 mechanical gate ≤ 5 條（計數定義：含 MUST/SHALL 強度條款；framing / 表格擴充 / nuance 不計） | > 100 行 / ≥ 6 條 |
| 設計判斷量 | 不適用 | 一句話可陳述；無行為相關 trade-off 比較（單一方案） | 需 architect 比較兩個以上會影響外部行為、capability contract 或呼叫方的選項（行為相關 trade-off）|
| dp-analyst pre-flight | 免 | 免（TL 自驗 4 點：追溯/scope/touch/prior） | 必（完整 checklist）|
| dp-architect | 免 | review-only（≤ 3 條 critical comment） | 設計模式（完整 proposal）|
| dp-programmer | 免 | 視 task 性質 | 必 |
| dp-reviewer 六軸 | **必** | **必** | **必** |
| 五欄白話卡（第一個實作寫入前確認） | **必**（第零步；入口 (a) 在第一次 git 動作確認訊息） | **必**（第零步） | **必**（full：pre-analyst 訪談後；lite：第零步） |

> 版號 bump（`chore/bump-v<X.Y.Z>`）屬 A 類：**免 OpenSpec + 免 dp-reviewer 六軸**，走 metadata-only gate：(1) 命名格式（SemVer pattern）；(2) SemVer 級別（與本 cycle 累積行為變更一致）；(3) diff 只限 approved version metadata files，且新版本 = 分支名 `<X.Y.Z>`。bump PR **不跑完整專案測試**；完整測試在 release branch 組裝完成後執行（見 `release-sit-uat-pat-prod.md`）。其他 chore A 類仍走 fast-track 含 dp-reviewer 六軸。版號 bump 屬非需求變更車道，不出五欄白話卡（適用範圍見 `ambiguity-scoring.md` §Operator usage probe）。
>
> 依賴升版：A 類（patch 升版且無行為變化）vs B 類（major 升版或安全補丁需廣播）；**若不確定一律走 B 類**。
>
> **新增 mechanical gate 的載體（source repo）**：判定要「新增 mechanical gate」時，source repo 的 enforcement 載體 MUST 為本地 `.devpro/scripts/tests/` 套件，並由 tier-aware runner（pre-PR：`node .devpro/scripts/run-test-suite.mjs --changed <base>`；full suite：`node .devpro/scripts/run-test-suite.mjs --tier all`）執行，**禁**新增 source-owned GitHub Actions workflow（source CI workflows 已退役，local-test gate 為唯一測試防線）。權威 SSOT：`cross-runtime-parity` spec 的 `Cross-Runtime Parity Verification` requirement；勿在此複寫約束，只走此指針。

### Session-owned 分類 metadata（chore action point）

TL 判定具名 `chore/<name>` 的 A / B-mini / B 後，MUST 執行 `node .devpro/scripts/record-session-change-classification.mjs --branch chore/<name> --classification <A|B-mini|B>`。有可驗證 runtime metadata 才補 actual `--session-id`／相同 run-hook `--host`；MUST NOT 臆造 ID／host 或由 branch/path 推定。缺 trusted ID／host 時 CLI exit 0、回 `recorded:false,status:not-checked` 與具名 reason，只寫 repo-local diagnostic、不建 session classification／工作，繼續原工作不得因此卡住。非法參數／分類／storage error 仍失敗；明確 adoption CLI 仍嚴格拒絕缺 identity。

Producer 只寫本 stable session 的具名分支 classification，不建立工作／Recap obligation；`PostToolUse` hook 不因 lite 被跳過，只有成功 own work path 才讀 explicit payload 或此 owned metadata 記工作，支援 optional／later Recap。A 跳過，unknown 表示 unconfirmed、仍靜默；不得掃描／繼承 foreign 或 ownerless 狀態。CLI 成功回 `recorded:true`；分類 metadata 在 lite 亦須嘗試記錄，不會升 full／建立 full artifact，lite 仍無 automatic Recap reminder。只有明確接手才走 `adopt-session-reminder.mjs`，見 `session-recap.md`。

### 前綴車道（chore/ 輕量車道）

分類有兩條互不污染的軸：**形狀分類**（A / B-mini / B）看變更形狀，決定 OpenSpec 重量；**前綴車道**看 `chore/` 前綴與非測試程式碼行數，決定「無本 change proposal 時是否免第二意見」。

- `chore/` 是無本 change proposal 時免第二意見的輕量車道；留在車道 MUST 滿足非測試程式碼新增加刪除合計 ≤ 100 行（計法見 `### 計數定義`）。
- **本 change proposal** 的判定以 `code-review-cross-model.md` §Diff-shape exemption 為唯一定義；push 閘、merge 閘、PR 前檢查、post-PR 閘同判。只 in-place 修改他 change 既有 proposal（例：更正日期）仍可留在車道；形狀分類另判。
- 超過 100 行 MUST 升級（見 `### 判錯只升不降與升級路徑`）。升級**不改形狀分類**：純重構仍是 A、仍免 OpenSpec，只是 PR 改走第二意見。
- 機械擋關（`chore-code-size-push`）只在 source repo 生效；consumer repo 不受此門檻約束。
- 不受影響：`chore/bump-v*`、有本 change `proposal.md`／`proposal-mini.md` 的分支、其他前綴、規則同步與 release 分支。

### 計數定義

**非測試程式碼行數**（擋關與本規則共用；門檻 `100`，總數 **> 100** 才算超過）：

- 範圍：`origin/main...HEAD`（三點，相對 merge-base）的 `git diff --numstat -M`。
- 計量路徑：一般記錄取其路徑；搬檔取新路徑；刪除取被刪路徑。
- 計入：副檔名為 `mjs, cjs, js, ts, tsx, jsx, sh, py, ps1`（大小寫照字面，與 `chore-code-size-gate.mjs` 的 `CODE_FILE_EXTENSIONS` 相同），且不是測試程式碼，且不在 `openspec/changes/archive/` 底下。
- 測試程式碼：路徑含 `tests/` 或 `__tests__/` 目錄、檔名為 `*.test.*`／`*.spec.*`、或檔名為 `test-suite-manifest.mjs`。
- 每筆計數＝新增＋刪除；binary 與純搬檔算 0；搬檔同時修改內容時照算內容修改。

**markdown 行數**（B-mini 規模用，cooperative-only，無機械閘）：同一範圍下 `*.md` 的（新增－刪除）總和。計量檔案排除 `openspec/changes/**` 與 `openspec/specs/**`；其餘 `*.md`（rule leaf、skill、scenario、docs）都計入。

### 判錯只升不降與升級路徑

判錯升級不降級：B-mini → B 可，A → B-mini 可；反向降級需重新審視。

被擋或發現 `chore/` 分支超過車道時，二擇一：

- **(a) 有行為變更**：在原分支補 `proposal-mini.md` 或 `proposal.md`；分支名不用改。
- **(b) 純重構、無規格變更**：**第一次 push 前**執行 `git branch -m chore/x feature/x`；change 名稱、worktree、用量檢查點、session-pending claim 都沿用。已 push 過 MUST 開新分支＋新 PR，或走 (a)。

**手動清單**（程式不會自動處理）：

- 有 proposal 時，同步改 Batch Approval Ledger 的 `branch:`；lite 沒有 proposal 時，同步改 `lite-scope.md` 的 `branch=`（否則 Gate R1 判為 mismatch）。
- 放棄已 push 的舊分支時，清掉孤兒 push／Recap 狀態 marker。
- 關閉舊 PR、刪舊遠端分支；舊名不得再用。
- 有 change 資料夾時，更新 meeting-notes／brd 內的分支文字。

**Recap 觸發**：升級後的純重構是 feature commits，需要 Recap（見 `session-recap.md`）。

### 已知限制

- 純文件大改動不受門檻限制；用規則文字改行為仍可能掛在 `chore/`（安全網是六軸審查與 A 類前置閘）。
- `DEVPRO_HOOK_BYPASS` 與人手動 push 可繞過；拆成多個小 PR 屬故意規避。
- 已 push 的中途 PR 長到 > 100 行後，每次 push 都被擋。
- 在別的分支下推 chore 分支不檢查；JSON／YAML 不計。
- 本機 `origin/main` 過舊或堆疊分支會多算；shallow clone 找不到 merge-base 時顯示 `base-unresolved` 並放行。
- rigor lite 看不到未檢查訊息；blocking 清單較前的 runner 對同一指令回 advisory 時，本擋關的未檢查提示會被略過（既有結構，whitespace 擋關相同；任何 block 仍優先）。
- 以下情形放行並顯示 `checked=false` 的未檢查提示、不擋：push 對象無法證明（明確 refspec、`--tags`、多個 push、自訂 push 設定）、串接含 `git add`／`git commit` 與唯讀指令（`status`、`diff`、`log`、`show`、`rev-parse`、`ls-files`、`branch --show-current`，不含帶 `--output` 者）以外的 git 指令（`fetch` 會動 `origin/main`，不算唯讀）、add／commit 在不同目錄、串 `--amend` 且 HEAD 即 merge-base、cwd 或 git 探測失敗、擋關內部錯誤；rigor `off` 整道略過。
- 串接內才刪除已提交 proposal，預檢看不到。
- 串 commit 為估算：**可能多算**——路徑限定 commit、只 add 部分檔案、`git add` 帶入未追蹤檔、索引與工作區不同取較大者、直接 `mv`、`git add -N`、`commit … || push` 的文字位置判斷；**可能少算（漏擋）**——串接內非 git 指令或唯讀指令的 shell 重導向改檔、路徑限定 commit 缺口、部分 hunk 暫存／提交、`git add -f` 強加被忽略檔、搬檔配對競爭。要精確數字：把 commit 與 push 分兩次執行。

### Chore A 類 Fast-Track（純文件修正）

**前置閘**：若文件修改會改變 agent 路由／gate／收尾條件，**不得**走本 fast-track，必須改判為 B-mini 或 chore B。

chore A 有**兩條同等合法入口**（差別只在起點，非主／從）：
- **(a) standalone 手動 fast-track**（見 `scenarios/scenario-a-source-repo-typo-fix.md`）：已知極簡的純文件/typo，直接 `git worktree add … -b chore/<scope> <anchor-sha>`，**不** invoke `/devpro:change`；每次 git write 逐步取得使用者同意（不納入 batch consent）。第一次 git 動作的確認訊息 MUST 另起需求白話卡分區（五欄規則見 `ambiguity-scoring.md` §Operator usage probe）；確認（改欄後再確認）前不建 worktree，確認後照 `/devpro:change` 第零步寫 card capsule（change-name＝分支名去掉 `chore/` 前綴）。
- **(b) `/devpro:change` 內輕量車道**：需求經 `/devpro:change` 進場、第二步判 A 類、第三步建 worktree。

兩條路徑**共同不變式**（缺一不可）：
- **流程**：dp-assistant 執行修改 → test gate → `/devpro:pre-pr` → PR → main。`/devpro:pre-pr` 執行至少六軸 + archive gate + validate gate；對純文件 chore A，simplification step 自動 N/A、scenario walkthrough 視 diff scope 觸發。
- **都跳過**重產出（完整 pre-flight、proposal 設計、dp-programmer 實作）。只更正他 change 既有 proposal 的日期等（in-place 修改）仍是 A 類，判定見上方「本 change proposal」。
- **都不跳過** worktree/anchor 分支紀律與上述 gate。chore A still runs preflight points 1-2（branch/name/scope sanity），並對齊 `preflight-checklist.md`。
- **Receipt authority（#2495）**：chore A 無 OpenSpec change folder → `classify-bounded` 無法 mint `dispatch_id`。Step 3 MUST 記 `receipt_authority_unavailable: chore_a_no_openspec`（mutable envelope + PR Review Summary；不進 `walkReceiptAuthorityChain`），細節 SSOT → `devpro:pre-pr` SKILL Step 3；**禁**自造 digest。

**六軸豁免例外**（此豁免**僅免六軸 step**，其餘 gate 不免）：
- **(i) 版號 bump**：`chore/bump-v<X.Y.Z>`，metadata-only gate，不跑完整專案測試。
- **(ii) micro-trim**：純壓縮、無新增段落、≤ 500 byte，TL override 須記 commit/PR body。
- 豁免後仍須以 `openspec validate` 或 `pre-pr-archive-gate.mjs` 任一輸出滿足 hook merge gate（`Totals:` / `archived as` 任一）；非 bump 的 test gate 仍強制。

**對齊類 chore A 必驗（self-alignment grep）**：當 chore A PR 本質為「同步現存兩處或多處互引內容」（README 對齊 source code、CHANGELOG 對齊 git log、docs 對齊 spec、描述對齊行為等），TL 委派 dp-assistant 改檔**前**，必須對「被對齊的核心數字 / 名詞」執行 `grep -c <token> <file>` 列所有 instance，逐一比對是否同步。Anti-pattern：「對齊 PR 自身留下半對齊」（whack-a-mole）；歷史案例見文末 [^align-434]。

觸發 scope（同時滿足）：
1. chore A 純文件 PR
2. PR 本質為「使 X 與 Y 內容/狀態一致」之意圖（TL 對主旨做對齊本質判斷，不限字面 token；典型同義詞集：對齊 / align / sync / 同步 / 補完 / reflect / match / 一致 / consistent / update to match — 列舉非窮舉，TL 判斷對齊本質為主、字面 token 為輔）
3. 動到 docs / README / CHANGELOG / 描述類 markdown（非 enforcement 載體 — `.devpro/agent-rules/*.md` / scenarios / hooks / agents / commands 自有 walkthrough 流程，不重複觸發）

執行紀律：
- TL 在發出 dp-assistant briefing 前 grep 列出所有 instance
- briefing `exact_instructions` 須列舉所有 instance 的位置（行號 / 段名）
- TL 直接 edit 不委派時同樣適用（紀律鎖 TL 決策層，不限委派路徑）
- 若僅鎖一處（漏其他 instance），dp-assistant 嚴格遵守 → 半對齊 → dp-reviewer 軸 1 backstop 才抓到
- 不加 mechanical hook gate（核心數字 / 名詞太抽象、自動偵測誤殺風險）
- **未截斷證據（#2494）**：掃描證據 MUST 來自未截斷輸出。預設用計數模式（`grep -c` / ripgrep `--count` / `output_mode: count` / `| wc -l`）——計數本身即全量約束，不依賴清單是否被 UI 分頁。若改用列清單介面，MUST 先確認輸出無 pagination／truncation 標記（例：`Showing results with pagination`、`head_limit`、`max_results`、`[truncated]`）；否則 MUST 收斂 glob／提高上限後重跑。截斷輸出 MUST NOT 被引用為「已列出所有 instance」的證據，也 MUST NOT 出現在 PR body／回報 evidence 表。為何預設計數：清單工具常在 agent runtime 預設截斷，截斷提示易被當成正常結束，造成「看起來掃過、實際覆蓋不全」。對照：`token-frugal-io.md` 鼓勵限縮進 context 的輸出；本條禁止把「限縮後的殘段」誤當全量結論——省 token ≠ 可用截斷結果當窮盡證據（互指 `code-review-cross-carrier.md` 窮盡律）。

> **Backstop**：`code-review-checklist.md` 軸 1 root-cause adequacy sub-check 豁免清單已同步修正：`chore A`（對齊類除外）— 對齊類 chore A 仍受軸 1 root-cause adequacy 審查，作為前置紀律之安全網。

### B-mini Fast-Track（迷你 OpenSpec）

滿足 B-mini 表格條件（不新建 capability / ≤ 100 行 / 一句話設計）→ 跳過 dp-analyst pre-flight 與 dp-architect 設計模式；TL 自寫 `proposal-mini.md`（`## Why` + `## What Changes`〔archive gate (c) 強制〕+ Batch Approval Ledger / Target State / Touch / Tasks 六段，≤ 60 行），dp-architect 改 review-only（≤ 3 條 critical），dp-reviewer 六軸保留。產物**不需要** brd.md/ tasks.md（task outline 直接放 proposal-mini `Tasks` 段）/ qa-test-scope.md（grep-based assertion 直接寫進新測試檔）。`devpro:pre-pr` 與 PR 描述必須把 `proposal-mini.md` `Tasks` 段與 grep/test assertion evidence 視為 B-mini 的 tasks/QA 對應證據，不得要求不存在的 full-flow 檔案。Active B-mini 驗證用 `node .devpro/scripts/validate-openspec-change.mjs <name> --strict`；不要直接依賴 upstream `openspec validate <name>` / `--changes`，因為 proposal-mini-only folder 可能不被 discover。

B-mini 的 Requirement Ledger **必須**有 `decisions.md` 中唯一的 `## Requirement Baseline Ledger`；baseline row、具名 decision heading 與 append-only 契約見 `openspec-quality-and-formats.md` §Requirement Count Ratchet。

**Rule-feedback B-mini 子路徑**：修補 `.devpro/agent-rules/*`、agent skill `SKILL.md`、platform adapter、hook、command/agent、reviewer workflow、PR gate、Session Recap gate 時，若改變 agent/runtime/review/gate 行為，即使 diff 是 markdown 也不得判為 chore A。符合 B-mini 規模時走 B-mini，且 `proposal-mini.md` 必須含 `openspec-quality-and-formats.md` 的 Rule-feedback Surface Matrix；新建 capability、修改 ≥2 個 capability spec、或設計需比較兩個以上會影響外部行為、capability contract 或呼叫方的選項（行為相關 trade-off）時升 full B。純 typo、格式、連結修正且不改行為才可維持 chore A。**B-mini 必攜 delta**：B-mini 依定義即有可觀察行為變更（routing／gate／review／exit 條件，或新增 mechanical guard——guard 本身即可觀察能力契約），故 `proposal-mini.md` 必含**至少一個** `specs/<capability>/spec.md` delta；找對應 capability 寫 `## ADDED`／`## MODIFIED`。**真無 capability semantics**（純無行為語意 prose、無新 guard）**⇒ 判 chore A / doc-only fast-track，不走 B-mini**；不得在 B-mini 用 `N/A: no capability semantics` 規避 delta。

### 一句話設計＝mini↔full 分水嶺

**一句話設計** = B-mini 選道準則：設計判斷收斂為單一概念、無行為相關 trade-off 比較（單一方案，不比較行為相關選項），可用一句話陳述「怎麼做」。滿足即可走 B-mini（`proposal-mini.md` 六段即可，免 `design.md`）。

**行為相關 trade-off（升 full B 的唯一 trade-off 軸）**：僅當比較的選項會影響**外部行為**、**capability contract**、或**呼叫方**時，才計入分水嶺。**測試載體選擇、命名、檔案位置**等不影響外部行為／capability contract／呼叫方的實作細節比較，MUST NOT 單獨觸發升 full B。

**逃生口 guard（堵「Target State 變 design」）**：**禁**把施工圖級 How（怎麼做、tradeoff、風險、遷移的細節）塞進 proposal 或 proposal-mini 的 Target State 段來規避寫 `design.md`——Target State 只列可觀測 done-when，不是 How 的藏身處。判斷準則：一旦設計超出一句話、或需比較兩個以上會影響外部行為、capability contract 或呼叫方的選項（行為相關 trade-off），**即升 full B**，How 進 `design.md`（見 `design-template.md`）；不得留在 B-mini 用 Target State 的長條目硬撐。dp-architect **review-only** 守此 watershed——即使 B-mini 免完整設計模式，仍須在 review 時檢查 Target State 是否夾帶施工圖級 How，超標即打回升 full B。

## Exit Criteria

判斷結果書面記錄。版號 bump：metadata-only gate 全通過 + `openspec validate --strict --all` 一次（產生 `Totals:` 跡證；完整專案測試延後到 release branch 組裝完成後）。B-mini：`proposal-mini.md` 存在（六段，含 `## Why` + `## What Changes` + `## Batch Approval Ledger`）、**含至少一個 `specs/<capability>/spec.md` delta**，且 `validate-openspec-change.mjs <name> --strict` 通過。A 類 fast-track：`devpro:pre-pr` 全步走完（含六軸；bump 例外走 metadata-only gate）。

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「幾行規則文字不用判分類」 | 改 phrasing 若影響路由 → B-mini；必須先過判斷表 |
| 「版號 bump PR 要跑完整測試才安全」 | 錯時點；bump PR 是 metadata-only，完整測試在 release branch 組裝完成後才有代表性。 |
| 「不新建 capability 一定 A 類」 | B-mini：不新建 capability 且行為有可觀察變化 → 仍 B-mini |
| 「對齊類 PR 我只改使用者指定的那行就好」 | 對齊類 chore A commit 前必須 grep 同概念全部 instance；只鎖一處等於把「對齊」誤縮為「替換」，dp-reviewer 軸 1 root-cause adequacy 會 partial。 |

## Verification

```bash
ls openspec/changes/<name>/proposal-mini.md  # B-mini proposal-mini.md 存在
node .devpro/scripts/validate-openspec-change.mjs <name> --strict  # B-mini active-change validate shim
git diff --check  # bump PR metadata-only gate
openspec validate --strict --all  # 產生 hook merge gate 跡證
grep -E "chore A|B-mini|chore B" openspec/changes/<name>/proposal-mini.md 2>/dev/null || \
  git log --oneline -1 | grep -E "chore A|B-mini|chore B"  # 分類已書面記錄
```

[^align-434]: whack-a-mole 歷史案例——PR #434 commit `763c34b`：README 同段 cell 已改新值、同段 heading 漏改舊值，dp-reviewer Step 3 partial 才抓到，多耗 1 commit + 1 review round-trip。
