---
name: platform-adapter-gemini
description: "Gemini：CLI agent runtime（無 subagent / 無 spec-flow review；shell + git-ops + web 完整）。觸發：Gemini CLI 內實作前；不綁特定產品版本。"
---

# Platform Adapter：Gemini

## Overview

先讀 `platform-adapter-contract.md`，再讀本檔。
能力真值一律以契約探測 + `RuntimeCaps` 為準（見契約段）；本檔為 Gemini CLI runtime 之差異記錄，不重寫總規範。

## When to Use

- 在 Gemini CLI 內做會改 repo、跑指令、或開 PR 的工作前

## Capability snapshot（Gemini per 2026-05）

`shell ✓ / file-rw ✓ / git-ops ✓ / spec-flow ✗ / review ✗ / test-run ✓ / web ✓ / delegate ✗`

> 本 snapshot 為當前實測快照；具體能力以 `platform-adapter-contract.md` 契約探測落地。Gemini 無 subagent / Skill tool / hook 注入 — 走 fallback leaf 主路徑（`openspec-flow-fallback.md` / `code-review-checklist-fallback.md`）。

## Hook cwd assumption

No repo PreToolUse hook surface is assumed for Gemini. Gemini CLI may have shell/git capability, but unless a repo hook integration is explicitly proven by `RuntimeCaps`, protected-branch safety depends on Ask First, branch/cwd evidence, and the shared git rules rather than hook interception. If a future Gemini integration exposes repo hooks, this adapter MUST be updated with hook-visible cwd evidence requirements before relying on those hooks.

## Load-Plan Capability

**Support**: not applicable, no repo manifest/list command is assumed for Gemini CLI. Fallback: TL manually lists system instructions, AGENTS.md loaded summary, triggered leaf rules, and any shell-visible hook scripts before executing multi-step work.

## Edit-Time Syntax Validation

**Support**: partial support, no repo hook injection is assumed for Gemini CLI. Fallback: after editing `.sh` / `.json` / `.mjs` / `.py`, TL manually runs `bash -n`, JSON parse, `node --check`, or `python3 -m py_compile`; checker absence or timeout must be reported as skipped, not syntax-clean.

## Pre-commit Cross-Review Reminder

**Support**: not applicable, no repo `PreToolUse` hook surface is assumed for Gemini CLI. Fallback：before commit/PR automation, manually check whether the branch is cross-review exempt; if not exempt, run `/devpro:cross-review` equivalent before merge.

## User-Invocable Command/Skill Capability

**Support**: partial support, no repo-local user-invocable command manifest is assumed for Gemini CLI. Gemini uses system instructions / prompt intent; fallback is TL manual routing through AGENTS.md trigger index and the relevant leaf rules.

## Cache-Friendly Design Metric

**Support**: partial support, Gemini API documents `usage_metadata.cached_content_token_count` for cache hits, but Gemini CLI may not expose raw API usage for repo-local sessions. Verification path: when API response metadata is available, record `cached_content_token_count`; otherwise mark cache metric unavailable and keep prompt structure cache-friendly.

## Reasoning Depth Control

**Support**: partial support, Gemini CLI/model selector may expose thinking or model-depth controls, but no repo-stable flag is assumed. Mapping heuristic 未驗證：fast/default model for mechanical edits and test runs; strongest available reasoning model for proposal, RCA, review, and release/security blockers. If no selector is visible, mark reasoning-depth unavailable. Shared effort rank 與 TL Effort Floor 見 `model-delegation-delegation-rules.md` §TL Effort Floor。本 runtime 無 verified／repo-stable selector → 解析為 `unavailable`；宣告 `reasoning-depth unavailable`（既有字面），MUST NOT 發明 selector。

## Per-Session Usage Telemetry

**Support**: not applicable, Recap 記 source: N/A: host does not expose usage data

## Rigor Level（DEVPRO_AGENT_RULES_LEVEL）

本 runtime 讀取與其他 runtime 相同的旗標 `DEVPRO_AGENT_RULES_LEVEL`（值 `full|lite|off`，預設 `lite`）及相同的 consumer `.devpro/rules.config`，precedence 一致（env > config > 內建 lite）。禁止使用任何 runtime-specific 旗標別名。以 shell 環境變數設定：`export DEVPRO_AGENT_RULES_LEVEL=lite` 後啟動 Gemini CLI。詳見 `rules-rigor-level.md`。

## Exit Criteria

- 已讀 `platform-adapter-contract.md` + 本檔
- `RuntimeCaps` 已更新；受限動作未在 `AskFirstPending=none` 前執行
- subagent-incapable 已認知 → 走 fallback leaf 而非 Claude-only Agent tool
- repo hook surface 未證明時，不宣稱 hook 已保護 git write command

## Cross-Model Second Opinion Adapter

Gemini CLI は no-hook runtime（`Hook cwd assumption` 段宣告無 repo PreToolUse hook）。本段描述 Gemini host 在 post-PR 觸發 cross-model review 時的對應 flow，符合 `cross-runtime-parity/spec.md:152`（no-hook runtime 備契約）與 `:224`（所有 host adapter 須描述一致 post-PR flow）。

### 執行流程（手動觸發）

**No hook enforcement**：Gemini CLI 無 `pre-tool-gate.mjs` hook 注入，`checkCrossModelMergeGate` 不會自動執行。Cross-model review 需 TL **手動觸發**並手動保持 sticky comment（manual sticky write required）。

1. PR 建立後，依 `pre-tool-gate.mjs::isCrossModelExempt` 豁免清單手動判斷（branch-pattern 豁免 / diff-shape chore/ 前綴車道 / hotfix 不豁免）；預設所有 PR 均需 cross-model review
2. 未命中豁免 → 手動執行 `/devpro:cross-review <PR#>` 觸發 second reviewer（claude CLI 或 codex CLI，使用 handoff-declared `reviewer_effort_ceiling` 內最高相容 reasoning tier；缺省 `xhigh`，`max` 須明示 opt-in）；Gemini shell/git-ops 能力支援 `gh pr comment` / `gh api` 寫 sticky comment
3. Second reviewer 結果以 `gh pr comment <PR#> --body-file <tmp>` 寫 sticky（magic marker `<!-- cross-model-second-opinion:sticky -->`；body 含 `verdict:` / `last_reviewed_sha:` / `reason:`）；不存在則 create，存在則 PATCH
4. TL push 新 commit 後手動重跑 `/devpro:cross-review <PR#>` 更新 sticky（manual sticky write required）
5. Merge 前手動執行 `checkCrossModelMergeGate` 確認 verdict 不 stale（`last_reviewed_sha` 對齊 PR head SHA）；Gemini host 無 hook 自動攔截，須人工確認（**checkCrossModelMergeGate at gh pr merge**）

**若 CLI 不可用**：寫 sticky `verdict: UNAVAILABLE` + `reason: CLI unavailable in Gemini session` + `last_reviewed_sha:`；`UNAVAILABLE` 不是 merge approval；ping 人類 reviewer。

### Gemini 作 reviewer family（external-only）

上段描述 Gemini 作**主 host**時如何觸發 cross-model review（dispatch claude/codex CLI）。反過來，當其他 host 的 dispatch 宣告 `reviewer_family: "gemini"` 時，`gemini` 無 runner CLI recipe（`render-second-review-packet.mjs` handoff 驗證於 `selectReviewerCliRecipe` 之前以 `reviewer_cli_family_unsupported` typed 拒絕；family group 表 `REVIEWER_FAMILY_GROUPS` 見 `second-review-material-contract.mjs`）——**只**能經 `executor_kind: "external-evaluator"` External Evaluator 路徑達成：其他 host 的 TL 發行審查單，一個獨立 Gemini session（本檔描述之 CLI runtime）live 讀 PR 並自寫 sticky，footer `Tool:` 用 `Gemini CLI` token（SSOT `second-review-sticky-authority.mjs` `STICKY_PROVENANCE_TOOL_TOKENS`），發起 host 的 TL 再跑 `accept-external-second-review.mjs <packet-dir>` 驗收；撤回改跑 `render-second-review-packet.mjs --void-external-dispatch <packet-dir>`（審查單不提供 same-family fallback）。完整契約見 `second-review-external-evaluator.md`（審查單＋收據）。

### Merge Gate 狀態

**Phase 2 status: manual-only**（Gemini 無 hook enforcement）；cross-model review gate 靠 TL 手動紀律，不靠 hook 攔截。Consumer 使用 Gemini 作主路徑時，**必須**額外確認 sticky 存在且 verdict 為 `PASS` 或 `WARN` 後再執行 merge。

## Verification

```bash
rg -n "Capability snapshot|RuntimeCaps|fallback leaf|No repo PreToolUse hook surface is assumed|hook-visible cwd evidence" .devpro/agent-rules/platform-adapters/gemini.md
grep -c "## Cross-Model Second Opinion Adapter" .devpro/agent-rules/platform-adapters/gemini.md
```
