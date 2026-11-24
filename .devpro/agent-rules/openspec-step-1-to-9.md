---
name: openspec-step-1-to-9
description: OpenSpec 9-step checklist；含 main-tip、step 4a/b/c、既有分支、Archive Load-chain、Post-merge Recovery。
---

# OpenSpec + Branch Checklist（step 1-9）

## Overview

Load-chain：tasks 品質、Scope Change、文件格式、Archive task wording 等細節按需載入 `openspec-quality-and-formats.md`；Archive 原則全文按需載入 `openspec-archive-principles.md`；六軸 rereview cadence／finding disposition → `code-review-checklist.md`（本檔不擁有 review cadence）；AGENTS.md 的 OpenSpec/tasks/quality row 只 eager-load 本 checklist entry leaf。
> Load-chain：doc 格式（meeting-notes/brd/decisions/ledger）細則見 `openspec-quality-doc-formats.md`；Diagram / Archive-Time Task Split 進階見 `openspec-quality-advanced-patterns.md`；需求數棘輪閘的實作邊界見 `requirement-count-ratchet-internals.md`；spec delta 條件性陷阱見 `openspec-spec-delta-pitfalls.md`；requirement scope change 重進流程與 hard gate 見 `openspec-scope-change.md`。

## When to Use

`/devpro:change`、既有分支、Archive／PR gate 時載入。

## Process

MUST 先依 `rules-rigor-level.md` 核對級別及來源；未設定預設 lite。本檔的完整 OpenSpec／active continuation artifacts 只適用已選定且授權的 full；B 形狀不授權升級，升 full 須先有具體理由與使用者明確同意。

### Step 1 Working Tree 乾淨

`git status --porcelain`；若有 uncommitted／untracked（`.devpro-agent-rules` 與 `AGENTS.md` 除外），停下問 stash / commit / discard / 帶 WIP。未回覆前**禁止** Step 2。

### Step 2 同步 refs

`git fetch origin --tags`（不切 main、不寫 checked-out local branch ref）。若需更新本地 `main`，只在 clean `main` worktree 用 `git pull --ff-only`；若 divergence，停下釐清，**禁止**擅自 merge / rebase。

> **Consumer rules lane routing**：普通 `devpro:change` 不跑 remote `.devpro-agent-rules` update；需新版 rules/scripts 時先走 `devpro:sync-rules`。**分支清理**統一移到 Step 6。

#### Step 2c 計算 anchor（強制）

- 建分支前先列候選：local/remote `feature/*`、`bugfix/*`、`chore/*`（排除本 change）。
- 候選為空且 `mainAheadCommits` 空 → 記錄「no candidate dependency branches」並跑 `--anchor`，不得要求使用者回「無依賴」。
- 候選存在或需求提及未上 PROD 依賴 → 附清單詢問；確認才從該分支建，否則用 anchor。
- **禁止**用記憶 / HEAD / `main` 作 base。

> **Main-tip dependency 處理**：`mainAheadCommits` 只代表 `main` 對 latest `production-*` 有內容差；graph-only merge（diff 空）不詢問。非空才跑 `--main-tip`；依賴 → 從 `main` HEAD + decisions 記 SHA；否則用 production-tag SHA。**禁**無確認 branch from main HEAD。**詢問與證據**：這題併入 `/devpro:change` 第零步的同一則訊息（不另開一輪）；第零步沒有發問時（請求已明說 batch／stepwise），在建分支前單獨問。TL 取 `--main-tip --limit <N>` 導到檔案再解析（N 為 `mainAheadCommits` 筆數；`--main-tip` 預設只回最新 50 筆；`truncated: true` 時不得下「無重疊」結論），以每筆 `filesTouched` 與本次預計要動的檔取交集，訊息附有重疊的 commit（超過 10 筆只列最新 10 筆（authorDate 新→舊）並附總數）與建議選項（有重疊→`main` HEAD；無重疊→production-tag SHA）；無重疊時明說「共 N 筆 main 領先 commit，與本次要動的檔無重疊」。建議只是預設值，回答由使用者做：回答前不得建分支，也不得以重疊證據代替回答；fetch 後 anchor SHA 或 `mainAheadCommits` 與發問時不同→以新證據重問；回答與證據記入 decisions（lite：PR `## Change Context`）。

#### Step 2d session-pending source claim gate（條件式）

- 若本 change 是從 `notes/session-pending.md` 條目 formalize 而來，Step 3a 建 branch/worktree 前 MUST 先跑 `node .devpro/scripts/session-pending-claim.mjs claim --item <N> --change <change-name>`。
- `<N>` 由 `node .devpro/scripts/session-pending-claim.mjs list` 的當前 1-based index 取得。
- helper 會寫 `<main-checkout-root>/notes/session-pending.md` 並以 lock/atomic rename 防雙抓；claim 失敗（已被其他 change claimed、item 不存在、pending file 不存在）→ 禁止建 branch/worktree，先依 `session-pending-lifecycle.md` 判定 in-flight / stale / done。

### Step 3 選前綴／基底

新功能／bug／chore → `feature/`/`bugfix/`/`chore/`（基底 step 2c anchor，合 main）；緊急 PROD bug 或 verified already-live repo-missing backfill → `hotfix/`（最近 `production-*` tag；source／consumer 同構經 release carrier 組裝進 production，tag 後 carrier ff＋一次 back-merge PR 回 main（見 `release-hotfix-carrier-policy.md`）；無 tag → 先排除異常能補就補、確不可能才降 `bugfix/`，見 `release-sit-uat-pat-prod.md`）。not-yet-live nonurgent 即使來自客戶／upstream，仍按內容走可促進單位；**`bugfix/` 一律為可促進單位**。

#### Step 3a 建 worktree、進 cwd、環境檢查（新可促進單位）

Step 1 / Step 2 / Step 2c / Step 3 完成前，**禁止**建立 branch 或 worktree。基底決定後，使用 `git worktree add <repo-root-abs>/.worktree/<change-name> -b <prefix>/<name> <anchor-sha>`（hotfix 用最近 `production-*` tag），接著 literal `cd <repo-root-abs>/.worktree/<change-name>` 並留下 `pwd && git rev-parse --abbrev-ref HEAD && git status --short --branch`，再跑 `git submodule update --init --recursive` 與 `environment-setup-nvm-nodejs-openspec.md` 要求的環境檢查/setup（含 `.nvmrc` 時 `nvm install` → `nvm use`）。

所有 repo write（meeting-notes / brd / proposal / tasks / code / tests）都必須在 worktree cwd 內完成；若仍在 protected branch cwd，停下切換。`devpro:change` 的第三步是本 Step 3a 的 slash-command 執行版，不得另用 `openspec-flow.md` 行號作 SSOT。

開工前 over-design + preparatory refactoring 自檢 → `pre-implementation-over-design.md`

#### Step 3b anchor-divergence 自檢（touch set 確定後）

touch set 確定後、動手寫第一行程式碼前，執行分歧自檢。規則詳見 `git-branch-naming-and-anchor.md` [§ 動手前 anchor-divergence 自檢（touch set）](git-branch-naming-and-anchor.md#動手前-anchor-divergence-自檢touch-set)。

### Step 4 建立 change 目錄與初始化

確認 `openspec/changes/<name>/` 存在並具備本流程要求的 OpenSpec artifacts：meeting-notes.md / brd.md / proposal.md / tasks.md / qa-test-scope.md（B-mini 例外依 `chore-classification.md`）。若 `.openspec.yaml` 或 spec scaffold 缺失，執行 `openspec new change "<name>"` 初始化；目錄不存在**不是**免除 OpenSpec 的理由。

#### Step 4a Make-vs-Buy 評估（符合觸發條件時強制）

若本次變更預估 >200 行、>1 工作天、或屬公認領域（auth、HTTP client、序列化、PDF/Excel、parser、rate limiter 等），**必須**先產出 `openspec/changes/<name>/make-vs-buy.md`（見 `third-party-packages-licensing.md`），使用者決策後才進入 tasks.md 撰寫。決策結論摘要寫入 `decisions.md`（觸發點 2）。

#### Step 4b Capability spec 存在性檢查（採 Workflow B per `/opsx:onboard`）

1. 列觸及 capability（brd/proposal 的 Capabilities 段）+ 對每個跑 `ls openspec/specs/<capability>/spec.md` 確認存在性
2. spec **不存在** → 只能用 `## ADDED Requirements` 建新 requirement（proposal「New Capabilities」列出）；`## MODIFIED Requirements` 無 canonical 可改，形狀錯
3. spec **已存在** → 先比對 canonical `### Requirement:` title set：title 不存在的新 requirement 用 `## ADDED`；title 已存在的任何 body/scenario 變更用 `## MODIFIED`（複製整段 + 編輯；加 scenario 到既有 requirement 也是 `MODIFIED`，不是 `ADDED`）；proposal「Modified Capabilities」列出
4. 不確定既有行為停下問使用者；**排除** Workflow A（全套 import）與 Workflow C（skip spec）

> **Capability 命名規範**：kebab-case；以「能力域」為單位。避免：(a) 動詞開頭；(b) 過度細碎；(c) 過於宏大。

> **GLOBAL config（首次 `/opsx:onboard`）**：每機一次；`openspec config set profile custom`；`openspec config set workflows '["propose","explore","apply","archive","onboard"]'`；MUST `openspec config list` 回讀。不驗 enum。

#### Step 4c Token Budget Pre-Check

- Proposal 不承載 Token Budget/coverage/estimate/cap/mitigation/readability/N/A 或 substitute evidence；authoring 時只列 touch scope。
- Pre-PR checks (e)/(r) 從完整 Git probes 建立 authoritative manifest，直接量測 actual `AGENTS.md` 與 `.devpro/agent-rules/**/*.md` final state。
- utilization >=80% 只產生 `semanticReview=required`，semantic review 對 actual carrier 執行；objective failure 或任何 probe/measurement/registry/guard uncertainty 都 fail closed。
- Production module、ordered result fields、exact-list assertion seam 與 cross-profile deterministic contract 見 `token-budget-precheck.md`。

**Source-governance basic matrix（與 Token gate 正交）**：

| Repo identity / bounded operation evidence | Proposal action |
|---|---|
| proven consumer（即使 adopted carrier rename/delete） | 跳過 source-maintainer gate；省略 File-Role Ledger、Dedup Audit 與 N/A |
| proven source + delete、rename/copy、split、merge/collapse、cross-file dedup definite/attested | 寫 File-Role Ledger 與 Dedup Audit |
| proven source + ordinary lone M / independent A | 省略兩章與 N/A |
| proven source + ambiguous bounded topology | 寫 exact `Source-Governance-Action` attestation；無法精確判定則停下/fail closed |
| unknown identity + bounded candidate | fail closed 並列 identity diagnostic；attestation 不得替代 identity evidence |
| unknown identity + no bounded candidate | 省略兩章、attestation 與 N/A；不 hard fail |

#### Step 4d Consumer Program Issue Routing

Consumer only；source 跳過。long-running program 在 planning / implementation 前 MUST 讀 `program-tracker-mode.md`「Issue-first Program Tracking」（由 `openspec-flow-consumer.md` 按需載入）；短命 branch / archive / release subset 仍依本檔原則。

### Step 5 委派計畫 → 實作 → 勾選

開工前 over-design + preparatory refactoring 自檢 → `pre-implementation-over-design.md`

design.md（Cooperative watershed）細節見 `openspec-archive-principles.md`「design.md 時序」。熱路徑：full change MUST 持久化 design.md（`## Context` + `## Decisions` 且至少 D1）；B-mini／chore A 免寫。archive format-when-present 仍不因缺檔擋 B-mini／chore A。若 design.md 存在，Step 5 委派 / 實作前先完成 `dp-second-reviewer` `audit-only` second-review independent of the design author（renderer packet／sidecar 齊備後才 dispatch；full 因檔案必在而必跑）。`PASS` 續行；`WARN` 逐項依 `code-review-checklist.md` Finding Disposition Discipline 處理；`CRITICAL` / `UNAVAILABLE` / 缺 terminal evidence fail closed。無 design.md 時記 `design second-review: N/A - no design.md`。此 audit-only 迴圈受 `audit round cap 6` 約束：達上限仍未通過即 MUST NOT 再派下一輪，MUST 停下交回使用者裁決；迴圈提前停止判準為 `Critical = 0` 且相對 ledger 無新增 finding 即可停止再派下一輪，Important 不強制清零。

> Load-chain（需撰寫 design.md）：格式載入 `design-template.md`。

若 design.md 存在，第一個實作寫入前先完成設計冷讀（`design-reasoning.md` §Design Cold Read and Implementation Handoff；步驟見 `/devpro:change`）。

先產出委派表格，再委派 dp-programmer/dp-assistant 執行，依「tasks.md 品質要求」驗收勾選。

**tasks.md 作為連鎖工作的 compact 接續載體**：
- 當「改 A 時發現 B、B 又牽出 C/D」這類連鎖工作展開時，新發現的 B/C/D 必須**即時回寫 tasks.md**（追加為 task，標明衍生來源與原 task 的關係），而非只留在當前 context。
- 理由：長 session 主動 `/compact`（或換議題 `/clear`）會壓掉工具歷史，但 tasks.md 在 repo 內不被壓掉。
- 主動 compact/clear **前**，tasks.md 必須是 fresh 的接續點（做完什麼 / 進行中什麼 / 待查什麼俱全）；compact 後讀 tasks.md 即接回線索鏈，不依賴被壓掉的對話歷史。
- 成本依據見 `token-frugal-io.md`。

### Step 6 測試全綠 + QA 報告

專案約定測試指令全綠 + 完成 `qa-test-scope.md`。產出時 MUST 含 `ui smoke:`＋`ui smoke head:`（觸發／非觸發皆列；形狀與觸發 SSOT：`testing-and-qa.md` §UI smoke；禁另寫第二套定義）。

### Step 7 Archive change

Committed active HEAD MUST 完成 primary full review。

**Mechanical gate ordering（review 是 archive 前最後一步）**：archive commit 必須是 reviewed HEAD 的唯一子 commit，所以凡輸入在 archive 前已存在的機械閘 MUST 在 **reviewer dispatch 之前**全綠——八項（consumer 七項）active content lint（具名清單見 `devpro:pre-pr` 第三點零步段 item 1）、`validate-openspec-change --strict --risk-shape-probe`、`pre-pr-archive-gate.mjs . --pre-review`（gate (e) 的 source-governance topology，並另斷言 **regression-head currency**（source-maintainer 義務；consumer 由 gate 印具名 skip）：`evaluateRegressionHeadCurrency` 非 `ok`——含缺收據、非祖先、或 `tested..tip` 含非 R6 bookkeeping 路徑——即 exit 1；exact-HEAD 或 bookkeeping tip-move carve-out 皆可通過；manifest 來自 git name-status，attestation 讀 active proposal；MUST NOT 與 `--mid-batch` 併用；bugfix 分支另斷言 owned active change 的 prove-it 標記，與 gate (l) 同一判定，#2985）、repo-wide `openspec validate --strict --specs --no-interactive`（source／identity unknown；consumer 正面身分改跑 `openspec-validate-delta.mjs`，見 `devpro:pre-pr` 第三點零步段 item 3）、shall-must lint、兩道 whitespace gate。操作順序 recipe 見 `devpro:pre-pr` 第三點零步段。

receipt 封存後才紅的機械閘＝流程缺陷，處置固定：撤掉本機 archive commit（未 push 時 `git reset --hard <reviewed-head>`，並逐 byte 還原 untracked 的 admission records 與 override claim proof）、把修復落在 reviewed HEAD **之前**、重跑 pre-review 掃描、再重審。**MUST NOT** 在 reviewed HEAD 之後補 commit 硬過 archive transition，**MUST NOT** 為過閘空 commit。

反向對稱面：archive commit 對 change folder 是**純搬移**。`deriveActiveArchiveMapping`（`review-remediation-evidence-core.mjs`）比對 reviewed HEAD 與 archive 後的兩個檔案集，要求 1:1 對映且 mode／OID／bytes 全等——檔數不等 → `archive transition mapping is missing or duplicate`；內容差一位元 → `archive transition byte/mode/OID mapping mismatch`。`admission-records/`、`override-ledger/` 兩個 hook 載體前綴**不是豁免**：它們依 `.gitignore` managed block 為 gitignored，依建構就不該被 Git 追蹤（`git ls-files` 對兩者恆為零命中），故 reviewed HEAD tree、archive commit tree、raw transition diff 三者之中任一出現被追蹤的該前綴路徑，一律 fail closed（訊息指出該路徑並要求 `git rm --cached` untrack）。舊版把兩者當成 blanket 豁免，且只把 archive 側新增拿去和 active 側刪除配對，導致「沒有對應刪除的 archive 側新增」完全不受檢查——`git add -f` 可在這兩個前綴下夾帶任意未審檔案通過 archive transition（PR #2473 cross-model Critical）。故「延後到 archive commit 再 backfill」不是合法處置：review 指出的 `proposal.md`／`design.md`／`tasks.md` 等 change folder 內任何文字，MUST 在 reviewed HEAD **之前**就地改完。**但別把它反向讀成「archive 後一律不能補」**：`post-pr-completion-gate.md` §Post-archive 修復落點明文允許 archive **之後**另開 commit 直接編輯 `openspec/changes/archive/<date>-<name>/` 內的`proposal.md`／`tasks.md`／`decisions.md`／`qa-test-scope.md`（記帳類），且不為此 re-archive；該條同時自帶另一半限制——**不得延伸到 archived spec delta 的 body/scenario**。合法與否的分界是**落在哪個 commit**：archive commit 本身純搬移、寫不進任何東西；archive 之後的記帳 commit 可以寫。因此 defer 的 trigger 若寫「archive commit」即無效，寫「post-archive 記帳 commit」則可執行。此出口的界線是**修正的性質，不是載體**——`proposal.md` 自己就是 risk-shape 載體而該條照樣允許改它，故「落在 risk-shape 載體」不成判準；判準是這筆編輯會不會改變 reviewer 當時的結論：純記帳回填（補記已發生的事實，不新增也不改變任何義務）落在哪個載體都可以，事實性或行為性修正則一律要落在 reviewed HEAD 之前——那是上一段既有機械閘的範圍，不是本出口新增的禁令。把 remediation 的 owner／trigger 指向 archive commit＝指向一個機械上無法執行的 trigger（`strengthen-subagent-delegation-strategy` round-4：同一份 defer 處置橫跨四個 decision，全部無效）。
建立 sole-child archive/promote commit；可與implementation commits同一次 push。
Valid transition MUST NOT 觸發 second primary full review。
最後由 `seal-final` 執行 final suite：`node .devpro/scripts/run-test-suite.mjs --changed main`。

> **Archive EOF checkpoint**：promote 後只修**本 change 剛 promote**的 canonical `openspec/specs/<cap>/spec.md` 為 exactly one trailing LF（`node .devpro/scripts/normalize-eof.mjs <spec>`）。`/devpro:pre-pr` 仍 keep repo-wide `normalize-eof.mjs --fix`；若 `--fix` 改到本 PR 三點 diff（`<target-base-ref>...HEAD`）以外的 spec.md，MUST 獨立 commit 並在 PR body 列出檔案與 originating commits。見 `openspec-archive-principles.md` 與 `devpro:pre-pr` Spec EOF 自動自癒。

### Step 8 一次 push

**一次 push**（feature code + archive 後的 `openspec/` 變更 + QA 文件）→ 才建立 PR

### Step 9 PR → review → merge

PR → review → approve → merge；merge 後**不需要**再做任何 archive commit/push

> **PR 建立後**：`gh pr create` ≠ 結束；同 turn 跑 workflow 終態 + 4 項 handoff。Archive 在 spec freeze 後、首次 push/PR 前納入同 PR。**re-archive**：review 要求行為變更或 pre-merge requirement scope change → 依 Pre-merge Archive Re-do 還原 active、改 spec、重 archive；`decisions.md` 觸發點分別為 `reviewer-rejection` / `scope-change`。

> **Pre-archive proposal headings 驗證**（per `proposal-template.md`）：archive 前 `## Why` + `## What Changes` 各 ≥1；缺則 CLI 不產 spec.md。`pre-pr-archive-gate.mjs` check (c) backstop。

### 回到既有可促進單位分支

`checkout` 回既有分支：先 `git fetch` + pull（依 `git-branch-naming-and-anchor.md`）；**只跳過** anchor 計算、分支建立、worktree 建立與 remote rules sync，不跳過 OpenSpec / TDD / QA / pre-PR。若 `.devpro-agent-rules` 或 `AGENTS.md` 有 sync diff → 還原殘留或另開 `rules/<source>-v<X.Y.Z>`，**禁止**併入 feature。

Active OpenSpec continuation checkpoint（形狀判為 **B-mini／B** 必做——前綴可為 `feature/*` / `bugfix/*` / `chore/*` / `hotfix/*`；形狀 **A** 依 `chore-classification.md` 例外。**禁止**只因前綴是 feature/bugfix 就預設 full）：

1. 確認 `openspec/changes/<branch-segment>/` active folder 與本形狀要求的 artifacts（B：meeting-notes / brd / proposal / tasks / qa-test-scope；B-mini：proposal-mini 等 per `chore-classification.md`）；目錄不存在**不是** OpenSpec 豁免。
2. folder 對應本 logical unit → 延續同 change：補 Step 0 frontier evidence、更新 artifacts，必要時重新 dispatch dp-analyst / dp-architect（僅 full B）；驗收後才勾 task。
3. folder 已 archive、缺失、或 stale → fail closed；`decisions.md` 記原因，reopen/reconstruct continuation（active-missing）或建明確 follow-up OpenSpec 後才可 coding。
4. 形狀判為 B-mini／B 時缺 `proposal*.md`／`proposal-mini.md`（依判定）是 missing OpenSpec evidence，不得因前綴是 feature/bugfix 或 cross-model diff-shape 豁免；形狀 A 才得免。
5. **Requirement scope change**（含 post-merge、使用者已選方案並要求實作）：MUST 先走 `openspec-scope-change.md` §Requirement Scope Change（`scope-change` entry、`dp-analyst -> dp-architect`、spec delta、OpenSpec-before-code hard gate），**禁止**因「同 session 延續」「程式已草稿」「不要新 change 名」跳過而直接寫 implementation carrier。

完成 continuation checkpoint 後才回 Step 5 實作；push 後回 Step 9。

### Archive 原則

> Load-chain（Archive 原則）：完整原則（design.md 時序、canonical 邊界、Pre-archive delta 守門、Post-archive brand/vendor guard、Gate (i)）見 `openspec-archive-principles.md`；Pre-merge Archive Re-do／pre-merge re-archive 與 Undo-Archive Preserve Checklist 見 `openspec-archive-redo-undo.md`。熱路徑：dp-reviewer active-spec freeze 後、首次 push/PR 前同分支完成 `/opsx:archive`；**禁止**先開 PR 後補首次 archive。漏 archive 補救見本檔下節 `### Post-merge Archive Recovery`。

### Post-merge Archive Recovery（漏 archive 補救）

- **觸發條件**：`openspec/changes/` 有非 `archive/` 子目錄，且 `<name>` 對應 PR 已 merged（漏首次 archive）
- **偵測步驟**：
   1. 列未 archive change：`find openspec/changes -mindepth 1 -maxdepth 1 -type d ! -name archive -exec basename {} \;`；先查原分支 head（`feature/`、`bugfix/`、`chore/`、`hotfix/` + `<name>`）：`gh pr list --state merged --head "<prefix>/<name>" --json number,title,headRefName,mergedAt --limit 20`
   2. head 查無 → fallback PR body 路徑 `gh pr list --state merged --search '"openspec/changes/<name>/" in:body' ...`；命中 merged PR → recovery；皆查無時**不得只靠 PR title 判斷**，先人工追溯確認未 merge 才回原分支 archive
- **標準補救流程**（每個 `<name>` 必做）：
   1. 依 `git-branch-naming-and-anchor.md` 從 anchor 建 worktree：`git worktree add <repo-root-abs>/.worktree/docs-archive-<name>-recovery -b chore/docs-archive-<name>-recovery <anchor-sha>`（多 change 同格式；`<anchor-sha>`=當下 `detect-branch-base.mjs --anchor` JSON 之 `sha`，非已刪 feature tip；禁憶測/`main` tip/手填）
   2. 此 recovery branch 是「分支/change name 一致」的明文例外；不建立第二個 OpenSpec change，只補 archive 漏件
   3. 在 recovery 分支執行：`openspec archive <name> -y`；archive 成功後、archive commit 前，依 `openspec-archive-principles.md` §Post-archive delta 正文復原跑 `repair-archive-delta-bodies.mjs`，並因本路徑的 archive 晚於 reviewed HEAD 而 MUST 加 `--recovery-archive-after-merge`（preview 通過後再 `--apply`）
   4. commit：`chore: recover archive for <name> after merged PR #<pr-number>`
   5. 確認 `decisions.md` 含 `recovery-rationale`，記錄漏補原因、原 PR、recovery 範圍
   6. 開 PR 到 `main`，描述必含漏補原因、原 PR 連結、recovery 範圍
   7. 合併策略：**Create a merge commit**（regular merge；遵守 `git-pr-template-and-merge.md`）
- **限制**：Recovery PR 禁止夾帶 feature/bugfix 行為變更；若發現行為需調整，另開正常可促進單位分支處理
- **繼承殘影例外（非 recovery 對象）**：若 `openspec/changes/<name>/` 仍存在、但 `origin/main` tree 已含 `archive/*-<name>/`，表示 main 已完成 archive 而本分支仍持有舊版 active 殘影——此殘影非漏 archive，merge 時 git 以 main 側 rename 勝出自動消解，**不適用本 recovery SOP**，亦無需開 `chore/docs-archive-<name>-recovery` 分支；gate (a) 已將此情境降為 informational（`will resolve on merge`），不阻擋 PR。

## Exit Criteria

Step 1-9 依序完成；archive 在同一條可促進單位分支完成並納入 PR；測試全綠；PR gate：`openspec/specs/<cap>/spec.md` 已產出/更新 + lint-spec-shall-must 通過。
## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「先開 PR，archive 之後再補」 | 禁先 PR 後補首次 archive；觸發 re-approval、違反 merge=結束 |
| 「anchor 用 main HEAD 就好」 | 禁憑記憶/HEAD/main 作 base；跑 anchor script |
| 「main-tip commits 不影響我的 change」 | `mainAheadCommits` 非空仍須先問；重疊證據只能當建議選項、不能代替回答；禁靜默 branch from main HEAD |

## Verification

```bash
git status --porcelain                          # step 1：乾淨
node .devpro/scripts/detect-branch-base.mjs --anchor  # step 2c：anchor
node .devpro/scripts/run-test-suite.mjs --changed main  # step 6：canonical pre-PR suite 全綠
ls openspec/changes/archive/ | grep <name>     # step 7：archive 完成
ls openspec/specs/<cap>/spec.md                # PR gate
```
