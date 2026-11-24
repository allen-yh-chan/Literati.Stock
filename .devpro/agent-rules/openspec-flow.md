---
name: openspec-flow
description: OpenSpec 流程規範：收到新需求 / 行為變更指令時觸發，定義 Branch Routing、Pre-flight、step 1-9、Archive、Scope Change 等完整流程與 exit criteria。
---

# OpenSpec 流程

啟動 change 先讀 `rules-rigor-level.md`：未設定預設 lite；本檔 A／B-mini／B 路徑在 full 已明確選定後適用。B 不自動授權升 full，升級前須依該 leaf 完成判斷與使用者授權。

## Overview

OpenSpec 是 spec-driven development 的強制閘道：**先 spec、後寫碼**。路徑深度由**變更形狀**決定：A（免 OpenSpec）／B-mini（迷你 OpenSpec）／B（完整 OpenSpec）；**禁止**把「行為變更」一律讀成 full B——僅判斷表判為 B 時才走完整流程（見下段與 `chore-classification.md`）。

**變更形狀 A vs B 判斷**（TL 開 `chore/` / `feature/` / `bugfix/` / `hotfix/` 時**必須**主動判定並告知使用者）：分類維度是變更形狀（非分支前綴）；分類為 A 類（免 OpenSpec）/ B-mini（迷你 OpenSpec）/ B 類（完整 OpenSpec）；分類表、Fast-Track 與版號 bump gate 見 `chore-classification.md`。

> 版號 bump（`chore/bump-v<X.Y.Z>`）屬 A 類：**免 OpenSpec + 免 dp-reviewer 六軸**，通過 metadata-only gate 即可 merge → 接續 Release 流程 Step 2-7（完整測試在 release branch 組裝後；見 `release-sit-uat-pat-prod.md`）。依賴升版：**若不確定一律走 B 類**。

**Chore A 類 Fast-Track（純文件修正）**：可 standalone 或走 `/devpro:change` 輕量車道；跳過 pre-flight/proposal/dp-programmer，但不跳 worktree/anchor/gate/需求白話卡，仍跑 preflight points 1-2。細節見 `chore-classification.md`。

**B-mini Fast-Track（迷你 OpenSpec）**：TL 自寫 `proposal-mini.md`，dp-architect review-only，dp-reviewer 六軸保留。TL 自寫不是手搓：寫前 MUST 對 `openspec-artifact-authoring`、`proposal-template.md`、`openspec-quality-and-formats.md`，不得憑記憶自創 proposal/proposal-mini 章節名；Active B-mini 驗證 MUST 用 `node .devpro/scripts/validate-openspec-change.mjs <name> --strict`，以 temp copy shim 成 `proposal.md` 跑 validate + scenario-preservation lint。不得把 `openspec validate <name>` / `--changes` 回傳 unknown/0 items 當成 B-mini 已驗證；zero-delta（≥1.9.0）見 §No-delta / skip_specs（`skip_specs: true` 或補 delta）。

**Rule-feedback OpenSpec routing**：修 `.devpro/agent-rules/*`、agent skill `SKILL.md`、platform adapter、hook、command/agent、reviewer workflow、PR gate、Session Recap gate 等，若改變 agent/runtime/review/gate 行為，**不得**判為 chore A；預設 B-mini，超規模或新建 capability 時升 B。`proposal-mini.md` 必含 Rule-feedback Surface Matrix：rule leaf/adapter、agent skill `SKILL.md`、affected capability spec、cross-runtime-parity、mechanical grep/hook tests、PR dependency wording；N/A 必寫 opt-out reason。

Load-chain：需要委派、多 agent、或 implementation briefing 細節時，按需載入 `model-delegation.md`；談需求 `/devpro:clarify`；AGENTS.md 功能/行為 row 只 eager-load 本 leaf。

## When to Use

觸發：收到新需求 / 行為變更 / 使用者確認開始做。**不觸發**：`chore A`（純重構 / 文件 / CI）；探索性討論。**分析階段是本流程第一步**，不得先非正式分析再正式化。

**Diagnosis-to-implementation re-entry**：session 起於 diagnosis/timing/read-only/`just look` 後，使用者說 `go`、`開始修`、`實作`、`do it` 或等效 intent 時，TL MUST 視為 `/devpro:change` re-entry before any repo write：明示 active intent、route through devpro:change/OpenSpec；先前 read-only diagnosis MUST NOT 算 completed change startup。若 re-entry formalize 已 claim 且記錄 batch approval 的 `notes/session-pending.md` 條目，第一個非 OpenSpec repo write 前 MUST 有 pre-write evidence checkpoint：active `proposal.md`/`proposal-mini.md` 的 `## Batch Approval Ledger`（lite 無 proposal 時為相符的 `lite-scope.md`）是 matching structured ledger；`N/A: no batch approval selected`、missing、mismatched 皆無效；只可先寫 `openspec/changes/<change-name>/` 修正 evidence。active intent/change name/approval boundary 模糊即問。**Scope-change 疊加**：若 diagnosis 過程中出現新 requirement（含 post-merge 補齊、Option A/B 定案、Recap 暴露的缺口），`實作` intent 仍 MUST 先滿足 `openspec-scope-change.md` §Requirement Scope Change（`decisions.md` `scope-change`、`dp-analyst -> dp-architect`、spec delta、OpenSpec-before-code hard gate），**不得**因使用者已選方案而跳過 spec。

**分支前綴與 OpenSpec 對應**（routing 見 `git-branch-naming-and-anchor.md` §分支前綴對照表）：

| 分支前綴 | OpenSpec change | tasks.md | qa-test-scope.md |
|---|---|---|---|
| `feature/<name>` | **必須** | **必須** | **必須** |
| `bugfix/<name>` | **必須** | **必須** | **必須** |
| `hotfix/<name>` | 緊急時可事後補；PR 描述必須記錄「為何延後」 | 事後補 | 事後補（上線後 24h 內） |
| `chore/<name>`（A 類） | **預設免**（涉及 agent 路由/gate/收尾條件者不適用） | **建議** | **免** |
| `chore/<name>`（B-mini 類） | **必須**（proposal-mini.md） | **免**（task outline 放 proposal-mini `Tasks` 段） | **免**（grep-based assertion 放新測試檔） |
| `chore/<name>`（B 類） | **必須** | **必須** | **必須** |

**Rule-feedback 最小矩陣**：rule-feedback 類 B-mini 不因「只改 markdown」豁免 OpenSpec。若改變 agent/runtime/review/gate 行為，TL 必須在 `proposal-mini.md` 明列 affected surfaces，並同步更新：1) rule leaf / adapter / hook / command 文字；agent skill `SKILL.md` 變更時同列；2) capability spec（通常 `openspec-flow`，或影響的能力域）；3) runtime/reviewer 行為變更時的 `cross-runtime-parity` spec 或明確 N/A；4) grep/hook tests；5) PR body dependency wording（若本 PR 依賴另一個 rule PR）。缺一項只能用具體 opt-out reason，不能 silent skip。

**Mandatory Clause Enforcement Map**（Principle 6）：本 leaf 的強制語氣由下列 carrier 對齊；新增/改 mandatory clause 時須更新本表或標 `cooperative-only`。

| Mandatory clause group | Enforcement carrier |
|---|---|
| chore A/B、rule-feedback routing | `chore-classification-contract-guard.test.mjs`、`dp-change-classification-routing.test.mjs`、`rule-feedback-openspec-routing-grep.test.mjs` |
| diagnosis-to-implementation re-entry + session-pending batch approval pre-write evidence checkpoint + general-mode batch approval ledger pre-write/archive-time checkpoint | `diagnosis-go-reentry-grep.test.mjs`、`batch-approval-ledger-grep.test.mjs`、`hook-pre-tool-gate.test.mjs` + `pre-tool-gate.mjs` Gate SP（`session-pending-batch-ledger-prewrite`）+ `general-batch-approval-ledger-prewrite`（一般模式）+ `pre-pr-archive-gate.mjs` check (c) |
| worktree / protected-branch / hook-visible cwd | `pre-tool-gate.mjs` + `hook-pre-tool-gate-worktree-mandatory.test.mjs`、`per-change-worktree-guard.test.mjs` |
| archive before push/PR、proposal headings、spec promotion | `pre-pr-archive-gate.mjs` checks (a)(b)(c)(h)(i) + `pre-pr-archive-gate*.test.mjs`、`archive-timing-cross-doc.test.mjs` |
| source repo local test gate | `node .devpro/scripts/run-test-suite.mjs --changed main` for pre-PR; `node .devpro/scripts/run-test-suite.mjs --tier all` for full-suite/release/`devpro:rule-governance`; cooperative command evidence |
| consumer Program Issue tracker | `program-issue-routing-grep.test.mjs`; repo-specific tracker updates are cooperative-only because source repo hooks cannot observe consumer project state |
| Supersede-sweep 完整性 + 保留舊 API 強制 deprecate | `supersede-discipline-grep.test.mjs` |

## Process

### Branch Routing Decision

> **歸屬決策樹完整明細**：見 `.devpro/agent-rules/openspec-branch-routing.md`

---

### Pre-flight Checklist

> **完整明細**：見 `.devpro/agent-rules/preflight-checklist.md`（pre-flight checklist 明細 + **commit-level 規則**：禁混 simplification + feature；純壓縮 / 文件 trim 須獨立 commit）。
>
> **執行順序 SSOT**：startup gates、worktree、環境、meeting-notes / brd / proposal 時序，以 `.devpro/agent-rules/openspec-step-1-to-9.md` 為準；`devpro:change` 只鏡像 slash-command 版流程。此 hub 禁以行號或完整子步驟重複描述，避免 SSOT 漂移。**Pre-flight docs 也是 repo write，受 protected-branch gate 約束；必須在 worktree 內完成，禁止在 main cwd 寫入。**

### OpenSpec + Branch Checklist（step 1-9）

> **完整明細**：見 `.devpro/agent-rules/openspec-step-1-to-9.md`

概覽：本檔只提供 step 1-9 的入口與 routing；逐步命令、anchor / worktree / artifact 時序、Archive 例外與 recovery 規則皆見 `.devpro/agent-rules/openspec-step-1-to-9.md`。變更 step 時先改 leaf，再同步 `devpro:change` 測試錨點。

> Load-chain（Consumer Issue-first Program Tracking）：consumer long-running program 前載入 `openspec-flow-consumer.md`（Program Issue discovery／bootstrap／update）。live tracker 不要求建 capability spec；synced `AGENTS.md` 仍禁手改；其他自訂→root `AGENTS.local.md`（additive-only；`consumer-local-rules.md`）；mechanics→`program-tracker-mode.md`。

> 回到既有可促進單位分支（跳建分支前置：anchor 計算 / remote rules sync）：見 `openspec-step-1-to-9.md`；Archive 原則：見 `openspec-archive-principles.md`。

### Tasks / Scope Change / Archive / 文件格式

> **Tasks 品質**（Section 2）與**文件格式**（Section 1）：見 `openspec-quality-and-formats.md`；**Scope Change 重進流程**：見 `openspec-scope-change.md`。
> Committed active HEAD MUST 完成 primary full review。
> 建立 sole-child archive/promote commit；可與implementation commits同一次 push。
> Valid transition MUST NOT 觸發 second primary full review。
> 最後由 `seal-final` 執行 final suite：`node .devpro/scripts/run-test-suite.mjs --changed main`。
> **Archive**：freeze 後、首次 push/PR 前同分支完成，禁先 PR 後 archive。Only an independently urgent hotfix may defer OpenSpec/archive 24h; non-urgent already-live backfill MUST complete OpenSpec/pre-flight 於實作前、archive 於 freeze 後且 PR 前。細則見 `openspec-archive-principles.md`。（rigor lite 的 OpenSpec／pre-flight／archive 要求改依 `release-already-live-backfill.md` §2）
>
> **Post-merge archive recovery（漏 archive 補救）**：觸發條件、偵測指令、`chore/docs-archive-<name>-recovery` 分支與 regular merge 流程，見 `openspec-step-1-to-9.md`「Post-merge Archive Recovery（漏 archive 補救）」。

### Source Repo Specifics

Source repo（devpro-agent-rules、devpro-agent-skills）走相同的 `devpro:change` 流程，差異：Step 2a/3a 跳過；script 路徑 `node .devpro/scripts/...`；anchor `node .devpro/scripts/detect-branch-base.mjs --anchor`；pre-PR test gate `node .devpro/scripts/run-test-suite.mjs --changed main`；release／`devpro:rule-governance` full suite `node .devpro/scripts/run-test-suite.mjs --tier all`；release → production 見 `release-sit-uat-pat-prod.md`，tag `production-v<X.Y.Z>`。

> **OpenSpec 效率提示**：開工前 pull 同步；spec 用 bash heredoc 一次寫入；`openspec new change "<name>"` / `openspec archive [name]`（`/opsx:*` 別名）。**TL 單 context fallback**：見 `openspec-flow-fallback.md`。

## Exit Criteria

- `openspec/changes/<name>/` 目錄已建立；`meeting-notes.md` 存在（chore A / B-mini 可免）；`brd.md` Pre-flight 完整（A / B-mini 免）
- `tasks.md` 全數勾選（B-mini 用 proposal-mini `Tasks` 段）；`qa-test-scope.md` 完整（B-mini 用 grep-based assertion 寫進測試檔）
- `decisions.md` 已產出（觸發點發生時）且格式符合 template
- archive 後 `openspec/specs/<cap>/spec.md` 已產出/更新 — PR gate 強制；archive 在同一條可促進單位分支完成
- 以上全部包含在同一個 PR 中

**Intent Lookup Order**：理解既有行為，或使用者問系統功能設計 / `system feature design` / `current design` / `intended behavior` / `current contract` 時，**MUST** 先查 current behavior → `openspec/specs/**` / `openspec/specs/<capability>/spec.md`；**MUST NOT** grep archive 判現狀。無 spec → 說 no canonical OpenSpec spec found，只標 observed/inferred，**MUST NOT** 稱 canonical/intended behavior；若要 define or fix intended behavior → 開 OpenSpec change。why → `git log`/`git blame` + PR 當**索引**，archive 只當終點、**MUST NOT** 當 grep 起點；以上皆優先於反推。Requirement Ledger **MUST** 標 `user correction` + 來源 PR/session。詳見 `intent-lookup-order.md`。

Load-chain（Intent Lookup Order）：完整順序、Why 與 correction 生命週期辨析載入 `intent-lookup-order.md`。

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「很簡單／先寫再補／先 PR 後 archive」 | 規範不豁免；禁先 PR 後首次 archive。 |
| 「已 merge／在 main 寫 spec 較快」 | tip 未入 `production-*` → 原分支修；main Write 必擋，worktree-first。 |

完整表與更多藉口：`ai-autonomy-rationalizations.md`。

## Verification

```bash
# change 目錄 + 文件
test -d openspec/changes/<name>/ && echo OK
ls openspec/changes/<name>/{brd.md,tasks.md,qa-test-scope.md}

# archive 完成
test -d openspec/changes/archive/ && ls openspec/changes/archive/ | grep <name>
git log --oneline | grep -E "archive|opsx"  # archive commit 早於 merge

# decisions.md
grep -l "觸發點\|user-override\|reviewer-rejection" openspec/changes/<name>/decisions.md 2>/dev/null || echo "no decisions (OK)"

# tip 未上 PROD
git tag --contains <branch-tip-sha> | grep "^production-"  # 空 → 在原分支修
```
