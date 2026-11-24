---
name: platform-adapter-copilot
description: "GitHub Copilot：風險型差異（規範注入、自動化邊界）。觸發：Copilot 類 IDE 內實作前；不綁特定產品版本。"
---

# Platform Adapter：GitHub Copilot

## Overview

先讀 `platform-adapter-contract.md`，再讀本檔。
風險軸與觸發時機已摘要於檔首 `description`；可執行細節以本文 **Process** 為準。能力真值一律以契約探測 + `RuntimeCaps` 為準（見風險 C），**不綁產品小版本**。

## When to Use

- 在 VS Code（或同類 IDE）用 Copilot 做會改 repo、跑指令、或開 PR 的工作前

## Process

### 風險 A：規範未載入（最高頻）

- **觸發**：使用者首則訊息未附 `AGENTS.md` Core Contract 或同等摘要。
- **行為**：`AskFirstPending` 維持非 `none` → **只輸出確認問句**（唯一輸出），要求貼上摘要或明確授權「依 repo 現有規範執行」。
- **禁止**：用「業界最佳實踐」替代 Core Contract。

### 風險 B：自動化可能繞過人類意圖（含 git）

- **觸發**：任何「一鍵到 PR / 自動套用 / 背景執行」類流程。
- **行為**：在執行受限動作前，逐條確認 Ask First；若無法確認，改走契約 Fallback（只輸出可複製指令／diff）。
- **禁止**：默認目標分支為 `main` / `master`；禁止假設「IDE 已授權」。

### 風險 C：能力不確定

- **不寫死** shell/git/subagent 能力表。
- **必做**：依 `platform-adapter-contract.md` 跑四探測，更新 `RuntimeCaps`；與本次實際 UI 自報的「工作模式」並列（例：`mode=self-declared:<一句>`），若矛盾以探測為準。

### 風險 D：repo hook surface 未證明

- **觸發**：Copilot 類 IDE 執行 git write / PR automation 時。
- **行為**：No repo PreToolUse hook surface is assumed for this adapter. 受限動作必須靠 Ask First、分支/cwd 證據、可複製指令或 human-reviewed diff；若某 Copilot integration 提供 repo hook surface，須先記錄 `RuntimeCaps` evidence，再比照 Claude/Codex/Cursor 的 hook-visible cwd evidence 規則。
- **禁止**：假設 Copilot 自動化會觸發 `.devpro/scripts/hooks/pre-tool-gate.mjs`。

### Load-Plan Capability

**Support**: partial support, IDE instruction visibility varies by integration. Use the active instructions / custom prompts UI when available; fallback is manual read of repository instructions and AGENTS.md trigger index before starting implementation.

### Edit-Time Syntax Validation

**Support**: not applicable, no shared repo `PostToolUse` hook surface is assumed for Copilot. Fallback: rely on IDE language-server diagnostics when visible, then manually run `bash -n`, `node --check`, JSON parse, or `python3 -m py_compile` before declaring syntax-clean status.

### Pre-commit Cross-Review Reminder

**Support**: not applicable, no shared repo `PreToolUse` hook surface is assumed for Copilot. Fallback：before commit/PR automation, manually check whether the branch is cross-review exempt; if not exempt, run `/devpro:cross-review` equivalent before merge.

### User-Invocable Command/Skill Capability

**Support**: fully implemented via custom prompts. Copilot users can invoke reusable workflows through IDE custom prompts / prompt files when the integration exposes them; fallback is to paste the relevant AGENTS.md trigger and leaf-rule path into the prompt before starting the workflow.

### Cache-Friendly Design Metric

**Support**: partial support, Copilot billing/usage docs expose token totals and may account for cached tokens at billing level, but repo-local sessions do not expose a stable cache-read field. Verification path: check Copilot enterprise usage dashboard / NDJSON export for prompt/output token fields; if no cached-token field is visible, mark cache metric unavailable and keep prompts cache-friendly by structure only.

### Reasoning Depth Control

**Support**: partial support, model selector may exist but no repo-stable reasoning-effort flag is assumed. Mapping heuristic 未驗證：small edits use fastest/default model; design, review, RCA, and security-sensitive changes use the strongest visible model; if selector is hidden, state `reasoning-depth unavailable` and proceed with normal verification gates. Shared effort rank 與 TL Effort Floor 見 `model-delegation-delegation-rules.md` §TL Effort Floor。本 runtime 無 verified／repo-stable selector → 解析為 `unavailable`；宣告 `reasoning-depth unavailable`（既有字面），MUST NOT 發明 selector。

### Per-Session Usage Telemetry

**Support**: not applicable, Recap 記 source: N/A: host does not expose usage data

## Rigor Level（DEVPRO_AGENT_RULES_LEVEL）

本 runtime 讀取與其他 runtime 相同的旗標 `DEVPRO_AGENT_RULES_LEVEL`（值 `full|lite|off`，預設 `lite`）及相同的 consumer `.devpro/rules.config`，precedence 一致（env > config > 內建 lite）。禁止使用任何 runtime-specific 旗標別名。以 shell 環境變數設定：在終端機執行 `export DEVPRO_AGENT_RULES_LEVEL=lite` 後啟動 IDE，或透過 IDE 的 terminal 環境設定注入。詳見 `rules-rigor-level.md`。

## Exit Criteria

- 已讀 `platform-adapter-contract.md` + 本檔
- 規範摘要已載入或已取得使用者明確授權路徑
- `RuntimeCaps` 已更新；受限動作未在 `AskFirstPending=none` 前執行
- repo hook surface 未證明時，git write 依 Ask First + cwd/branch evidence，不宣稱 hook 已保護

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「Copilot 本來就會幫我 commit」 | 會≠允許；Ask First 逐次有效 |
| 「使用者沒貼規範但我能猜」 | 猜測違反 Core Contract；先問 |
| 「Copilot 會自動跑 hooks」 | No repo PreToolUse hook surface is assumed；沒有 RuntimeCaps evidence 就當不會 |

## Capability snapshot（GitHub Copilot per 2026-05）

`shell ~ / file-rw ✓ / git-ops ~ / spec-flow ~ / review partial / test-run ~ / web ✗ / delegate ~`

> 本 snapshot 為當前實測快照；`~` 表依當前 IDE integration 功能而定。具體能力由 `platform-adapter-contract.md` 契約探測落地（見 Risk C）；本 snapshot 不取代探測。

## Verification

```bash
rg -n "風險 A|風險 B|風險 C|風險 D|RuntimeCaps|AskFirstPending|No repo PreToolUse hook surface is assumed|Capability snapshot" .devpro/agent-rules/platform-adapters/copilot.md
```

## Cross-Model Second Opinion Adapter

**Copilot 無 hook 機制：`checkCrossModelMergeGate` 在 Copilot session 不觸發；merge gate enforcement N/A。**

### 限制（永久架構限制，非暫時）

- Copilot 為 IDE-based suggestion model，無 pre-tool-use hook、無 PR-stage automation hook surface。
- `pre-tool-gate.mjs`（`checkCrossModelMergeGate`）對 Copilot host **不適用**（架構特性，非 Phase 限制）。
- 無 server-side enforcement：CI body lint 已拆除（D9 teardown），無其他自動兜底機制。
- Copilot 若無 CLI 只能寫 UNAVAILABLE audit sticky；此狀態 blocked，不是 merge approval（per D4 / R5 緩解）。

### 使用者責任（唯一強制機制：手動 + 人審）

Copilot host 使用者的 PR **預設需要 cross-model review**，除非命中 `code-review-cross-model.md` 「豁免條件」段（branch-pattern 豁免 / diff-shape 豁免）。未命中豁免時，**必須**：

1. 在終端機手動執行 cross-model review：執行 `codex` CLI 或 `claude` CLI（或切換至對應 host adapter）取得第二意見
2. 用 `gh pr comment <PR#> --body-file <tmp>` 手動寫 sticky comment 至 PR，body 必含：
   - magic marker `<!-- cross-model-second-opinion:sticky -->`
   - `verdict: PASS | WARN | CRITICAL | UNAVAILABLE` 單行
   - `last_reviewed_sha: <headRefOid>` 單行
   - `reason:` 行（UNAVAILABLE 時必填）
3. 若本人無法執行 cross-model review（CLI 皆不可用）→ **ping 人類 reviewer 接手**；sticky comment 填 `verdict: UNAVAILABLE` + `reason: Copilot host — no CLI available; human review required`，且不得宣告 ready
4. **External evaluator 入口（優先於 3）**：CLI 皆不可用時，除了 ping 人類接手，TL 也可改發行 External Evaluator 審查單（`render-second-review-packet.mjs` 帶 `executor_kind: "external-evaluator"`），交由另一 family 的獨立 session live 讀 PR 並自寫 sticky，TL 再跑 `accept-external-second-review.mjs <packet-dir>` 驗收；撤回改跑 `render-second-review-packet.mjs --void-external-dispatch <packet-dir>`（審查單不提供 same-family fallback）；完整契約見 `second-review-external-evaluator.md`（審查單＋收據）。footer `Tool:` token SSOT 見 `second-review-sticky-authority.mjs` `STICKY_PROVENANCE_TOOL_TOKENS`。

`chore/bump-v<X.Y.Z>` 分支 → 略過 cross-model（FR-9 例外）。

### 說明

Copilot host 無法在 IDE session 內觸發 cross-model enforcement（brd §8 R6 認可的 trade-off）。緩解機制：

1. 本段明示限制，使用者讀後知道需手動補齊。
2. 手動寫 sticky comment 後，`last_reviewed_sha` 可被 merge gate 比對（若使用者切換至 Claude Code / Codex host 跑 `gh pr merge`）。
3. 若 Copilot 全程完成 PR 流程（包含 merge），sticky comment 不存在 → 完全依賴人類 reviewer。

結論：Copilot host 的 cross-model 保護**全程靠使用者手動執行 + 人類 reviewer 接手**；無 in-session enforcement，無 server-side 自動兜底。
