---
name: openspec-archive-principles
description: OpenSpec Archive 原則（design.md 時序、canonical 邊界、Pre-archive delta 守門、Capability retirement recipe、Gate (i)；Pre-merge Archive Re-do／Undo-Archive Preserve Checklist 只留路由，內容在 `openspec-archive-redo-undo.md`）。觸發：Step 7 archive／re-archive／漏 archive 時由 openspec-step-1-to-9.md Load-chain 載入；OpenSpec/tasks/quality eager 不載本檔。
---

# OpenSpec Archive 原則

> Load-chain：本檔由 `openspec-step-1-to-9.md` 按需載入；entry 保留 Step 7 路由與 `### Post-merge Archive Recovery`。不做 archive 時可不讀本 sibling。

### Archive 原則

- OpenSpec archive 屬該變更的收尾工作，**必須**在同一條可促進單位分支流程中完成
- **PR gate（archive 後驗證）**：`devpro:pre-pr` 驗證 `openspec/specs/<cap>/spec.md` 已產出或更新；未產出/未更新 → block PR 建立
- **PR gate（lint-spec-shall-must）**：`devpro:pre-pr` 第三點七步跑 `node .devpro/scripts/lint-spec-shall-must.mjs <change-dir>`
- **design.md 時序**：
  - proposal.md 承載 Why/What；full change 的 design.md（章節對齊 `design-template.md`：hook-enforced `## Context`＋`## Decisions`，且至少 `### D1 — <title>`）承載 How，由 dp-architect 在 Step 5 委派前、proposal.md 完成後持久化——Cooperative watershed：full 的一句話 How 仍寫入 stub design.md，不得作為 full 免檔授權。B-mini／chore A 免寫。archive format-when-present 不因 B-mini／chore A 缺檔擋 archive。
  - 若 design.md 存在，Step 5 委派 / 實作前先完成 `dp-second-reviewer` `audit-only` second-review，且先用 `.devpro/scripts/render-second-review-packet.mjs` / `.devpro/scripts/validate-second-review-packet.mjs` 取得 renderer-generated `packet_path`、`observability_context_path` 與 sidecar，再依 `devpro:second-review` dispatch；缺 sidecar / path / `projection_runner_command` 為 `projection_observability_contract_missing`，不得啟動 reviewer CLI。
  - `PASS` 續行；`WARN` 逐項依 `code-review-checklist.md` Finding Disposition Discipline 處理；`CRITICAL` / `UNAVAILABLE` / 缺 terminal evidence fail closed；audit-only terminal evidence 須依序包含 `projection_cli_exited` → `projection_sticky_verification_skipped`；audit-only 不寫 PR sticky、不滿足 PR merge gate。
  - 無 design.md 時，在 durable carrier 記 `design second-review: N/A - no design.md`。

> Load-chain（需撰寫 design.md）：格式載入 `design-template.md`。

- canonical：archive僅promote specs；proposal/design僅備查。
- Committed active HEAD MUST 完成 primary full review。
- 建立 sole-child archive/promote commit；可與implementation commits同一次 push。
- Valid transition MUST NOT 觸發 second primary full review。
- 最後由 `seal-final` 執行 final suite：`node .devpro/scripts/run-test-suite.mjs --changed main`。
- **首次 archive 時點**：spec freeze後archive；首次 push/PR前納入同PR，**禁止先開 PR 後補**。
- Task wording：見`openspec-quality-advanced-patterns.md` §Archive-Time Task Split。
- behavior/scope change才re-archive；否則禁。
- merge後禁補首次archive（hotfix事後補、Post-merge Recovery例外）。cutover 後已直合 production 的補件另有明確例外，見 `release-already-live-backfill.md` §3.4。
- 禁為單純archive另建分支/PR（使用者明示或Recovery例外）。
- **independently urgent hotfix 補件（24h）**：anchor 開 `chore/docs-<hotfix-name>`，補 OpenSpec + QA + archive 後 PR → main；non-urgent already-live backfill：OpenSpec/pre-flight MUST 實作前；archive MUST 依「首次 archive 時點」於 freeze 後、PR 前。cutover 後已直合 production、從未有 OpenSpec 的 non-urgent 事故補件，例外依 `release-already-live-backfill.md` §3.4。（rigor lite 的 OpenSpec／pre-flight／archive 要求改依 `release-already-live-backfill.md` §2）
- **Post-merge Recovery（漏 archive 補救）**：merge 後發現漏跑，依 entry `openspec-step-1-to-9.md` `### Post-merge Archive Recovery` 唯一流程；`decisions.md` 必含 `recovery-rationale`
- PR merge 到 `main` 時 OpenSpec change 應已 archive；**merge 即結束**（recovery chore 除外）
- **archive folder 日期**：`archive/<YYYY-MM-DD>-<name>/` 為 archive 執行日（CLI 時鐘），非 open 日

**Pre-archive delta 守門**（`devpro:pre-pr` Step 3.6）依序執行：

1. 跑 `node .devpro/scripts/lint-modified-scenario-preservation.mjs openspec/changes/<name> --base <change-base-ref>`（`<change-base-ref>` 同下一條；或經 `validate-openspec-change --strict`，該 wrapper 不帶 `--base`；禁裸 `openspec validate` 當保全證據）。每個 MODIFIED Requirement 的 scenario set 必須包含 canonical 同名 Requirement 的完整 scenario set，傳 `--base` 時另含 canonical 在該 ref 時的 scenario set（delta 與 canonical 同 change 內一起改名／刪除也攔，#2978）；缺漏若未由 `## Removed Scenarios` 授權，即 block。作者形狀見 quality §Dual Author Shapes。這一步在 archive 前攔截 scenario 流失，不依賴人工比對。
2. 用建立 worktree 時保存的 immutable anchor SHA 跑 `node .devpro/scripts/lint-delta-body-canonical-wrap.mjs openspec/changes/<name> --base <change-base-ref>`。禁止拿 `HEAD^`、最後一個 remediation commit 或任意 recent ref 代替；base 缺失或無效即 fail closed。這一步同時驗證：(a) 每個 MODIFIED Requirement 的 canonical block 在 delta 中連續、原序、逐行相等；(b) change 開始後每個被觸及的 canonical Requirement 都有 active delta 完整鏡像。Hard-wrap、缺行或同檔只鏡像部分 touched Requirements 均 block。
   - (b) 若由具名依賴 merge 帶入：勿抄進 delta，改宣告 `## Dependency-Absorbed Requirements`（自我設限，見 lint stderr）。

#### Capability retirement recipe

整 capability retire（promote 後無 forward product requirements）時 MUST 依本節（SSOT）。quality／`devpro:pre-pr` Step 3.6 只 pointer，**禁止**複寫完整雙列 abort triage 表。

**路徑 A（預設）— all-REMOVED + ADDED tombstone**：① `## REMOVED` 各退役 requirement；② 同 cap `## ADDED` ≥1 retirement／absence **tombstone**（SHALL NOT 再暴露該能力）；③ live `openspec/specs/<cap>/spec.md` 第一個 `##` 前 preamble／`## Purpose` **直改**（promote 不改 Purpose）；④ MUST NOT all-REMOVED only → 0-requirement。

**路徑 B — forbid**：刪 `openspec/specs/<cap>/` 現況 forbid（除非 documented operable CLI delete-capability）。`--skip-specs` ≠ path B；手動 `git rm` 非權威 recipe。

**REMOVED timing**：`## REMOVED` titles MUST remain on live `### Requirement:` set until archive 成功。MUST NOT 為 wrap／pre-archive lint 提前刪；wrap 不授權提前刪。

**Abort triage**

| Abort／症狀 | 修復 recipe |
|---|---|
| `Spec must have at least one requirement` | 路徑 A 補 ADDED tombstone＋Purpose preamble 直改；MUST NOT path B。修後重跑 lints＋archive。 |
| `REMOVED` title not found | 自 immutable change-base only restore（OID／`production-vX.Y.Z`）。MUST NOT `origin/main`／moving tip；base 遺失 → fail closed。確認 live 後重跑；MUST NOT 再刪「對齊目標態」。 |

`Aborted. No files were changed.` → attempt **原子** non-promote（含 siblings）；修後 MUST 重跑完整 `openspec archive`。

**Post-archive delta 正文復原（archive commit 前）**：有 capability delta 時，`openspec archive` 成功後、建立 sole-child archive/promote commit 前，MUST 先跑下列 preview，再對同一組參數加 `--apply`（無漂移時 idempotent no-op）：

```bash
node .devpro/scripts/repair-archive-delta-bodies.mjs --change <name> --reviewed-head <primary-reviewed-SHA> --archive-root openspec/changes/archive/<date>-<name>
```

**Post-merge Archive Recovery 路徑**：該情境的 archive 必然晚於 reviewed HEAD（見 `openspec-step-1-to-9.md` §Post-merge Archive Recovery），一般前置條件不可能成立，因此同一條指令 MUST 另加 `--recovery-archive-after-merge`。工具改以「reviewed HEAD 是 HEAD 的祖先」為前提，比較基準仍是 reviewed HEAD 的 delta blob，正文逐字比對與空白復原規則不變；reviewed HEAD 非祖先時 fail closed。

`<primary-reviewed-SHA>` 取已封存 primary receipt 的 reviewed HEAD；**一般流程** MUST 仍是當前 HEAD，不能改用 moving ref 或 archive 後的 SHA；Post-merge Archive Recovery 走上一段，以「reviewed HEAD 是 HEAD 的祖先」為前提。工具只做 commit 前的正文檢查／復原，不產生 review authority；原 `seal-final` 仍驗 receipt、sole-child、move identity、raw diff 與 exact delta body。工具使用 seal 同一正文解析器（CRLF→LF、去掉正文兩端空行的既有規則），只允許 ADDED／MODIFIED 正文的**空行**漂移；非空白行（含縮排、行尾空格、標點、SHALL/MUST）須逐行完全相同，才還原 reviewed delta 的正文。它先核對 archived delta 與 reviewed blob 的 exact bytes（checkout-only 行尾轉換以 Git clean 後的 blob 身分核對），並檢查全部 capability 才寫 canonical；只替換選定正文，保留其他區域的實體行尾與 BOM；不改 archived delta／receipt／commit。apply 禁在 main／master／production／integration／release/* 寫入。非 delta 的 #2592 空白容忍不變。

preview 或 apply 失敗 MUST 停止 archive commit；正文 mismatch 診斷須具名 requirement 與 canonical path；HEAD、archived blob、parser 或檔案錯誤則具名操作或路徑。文字變動、title 集不符、保留 REMOVED 或 archived delta 被改，不得用空白復原掩蓋，改走本檔指向的 re-do/undo recipe。這是 `cooperative-only` 操作步驟，不是新增 hook／整體 readiness gate；工具沿用既有 seal parser 的 Markdown 邊界，不宣稱 CommonMark 語意分析。

**Post-archive brand/vendor guard**（archive 後）：`openspec archive` 會把 change delta promote 進 canonical `openspec/specs/`，使原本不掃 `openspec/changes/` 的 brand/vendor guards 擴大掃描 scope。若本 change 的 spec delta、rule leaf、或 adapter 文字含 runtime/vendor/model 相關字眼或泛化工作，`devpro:pre-pr` Step 3.6 archive 後、宣告 archive gate 完成前，必須重跑 `node --test .devpro/scripts/tests/platform-brand-isolation-grep.test.mjs .devpro/scripts/tests/vendor-leak-regression.test.mjs`（或直接跑 canonical full suite `node .devpro/scripts/run-test-suite.mjs --tier all`），避免 promote 後才暴露的 generic-layer brand/vendor leak 延後到 full suite。

**Gate (i)（post-archive canonical 守門）**：
- `pre-pr-archive-gate.mjs` check (i) 在 archive **後**比對 promoted canonical `openspec/specs/<cap>/spec.md` 的 `#### Scenario:` title set（baseline vs HEAD）；未授權靜默移除 → block。
- Gate (i) 是終局兜底（catch `git rm spec.md`、archive CLI 替換語意等 pre-archive 看不到的路徑）。
- 兩道守門共用同一 escape-hatch（`## Removed Scenarios` 於 proposal／proposal-mini／decisions／tasks **四檔**；**禁**只寫 active delta——見 quality／authoring skill #2658），author 心智模型一致。
- **lite 例外**：lite 不 archive，四檔不存在。rigor 非 `full` 且 PR 未觸及 archive 時，gate (i) 改認 `--pr <n>` 指定、且從目前分支開出的 PR 說明裡的 `## Removed Scenarios`（同 parser、同裸標題比對）。沒帶 `--pr`、讀不到 body、PR 屬別的分支或未列標題都維持紅燈。有 archive 或 rigor `full` 時只認 archive。
- **archive gate MUST 跑在 archive/promote 已 commit 之後**：未 commit 時本 check 與 cadence (f) 皆失效，見 `openspec-quality-advanced-patterns.md`。
- **批次 backlog archive MUST 逐步重跑 gate**：N≥2 時，每個 archive commit 後立刻 `node .devpro/scripts/pre-pr-archive-gate.mjs --mid-batch`（跳過 (a)、仍跑 (i)）才可 archive 下一個；最後一個改跑無旗標完整 gate。MUST NOT 整批完才總掃；MUST NOT 中途跑無旗標（(a) 會擋未 archive sibling）（#2430）。

**Pre-merge Archive Re-do / pre-merge re-archive**：PR 未 merge 而要改已 archive 的 spec delta（reviewer feedback 或 `scope-change`；必須維持 same branch/change/PR）、原 PR 已 merge 後在同一 named change 上接續、要 undo archive commit（`git reset`／`revert` archive promote）、或要刪除可能含 review authority carriers 的 ignored／untracked 路徑時，MUST 先讀 `openspec-archive-redo-undo.md` 再動手；Re-do 流程（含 active-missing continuation）、Undo-Archive Preserve Checklist 與 check (h) 歷史資料補齊例外的內容都在該 leaf，本檔不複寫。
