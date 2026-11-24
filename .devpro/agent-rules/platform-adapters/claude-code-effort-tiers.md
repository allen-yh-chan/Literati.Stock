---
name: platform-adapter-claude-code-effort-tiers
description: "Claude Code reasoning effort tiers：low / medium / high / xhigh / max 對應、切換方式與範例流程。"
---

# Platform Adapter：Claude Code Effort Tiers

## Overview

本檔是 `platform-adapters/claude-code.md` 的 reasoning-depth leaf。Shared effort rank SSOT 為 `model-delegation-delegation-rules.md` §TL Effort Floor 的四階（低努力層／中努力層／高努力層／最高努力層）；本檔只做 rank→selector mapping，不得把本檔 selector 倒灌成 shared 詞彙。

## When to Use

- TL 需要選 reasoning depth，而不是只選角色或 subagent
- `devpro:pre-pr`、RCA、proposal 設計、cross-review 需要臨時升降 effort
- 同一工作流內需說明何時從高 effort 降回 routine execution

## Process

### Effort Mapping

| Shared rank | 用途 | Claude Code selector |
|---|---|---|
| 低努力層 | 小 typo、格式調整且無行為設計 | `low` |
| 中努力層 | routine 實作、測試、OpenSpec 小改 | `medium` |
| 高努力層 | proposal 設計、複雜 code review、RCA | `high` |
| adapter-only intermediate，非 shared rank | 高與最高之間的可選中間檔，**不**滿足 floor-gated 架構權衡；跨檔高風險 debug | `xhigh` |
| 最高努力層 | 多方案架構權衡、release/security/production blocker 的最深推理 | `max` |

Claude CLI/account 的一般 effort ceiling 目前仍是 `max`。Codex-host external Claude second reviewer 則依 `claude-code-cross-review.md` 的 probe-backed canonical recipe 使用 `--model <resolved>` + handoff `reviewer_effort_ceiling`（缺省 `xhigh`；`max` 須明示宣告）內 highest-compatible `--effort xhigh|max`（functional probe 先證 `xhigh`，ceiling 允許且相容後才條件升級 `max`；ceiling=`xhigh` 時 `max` 標 `ceiling_capped` 不得選；`max` 不相容保留 `xhigh`；`xhigh` 不相容則 fail closed，禁 silent fixed effort=`high` fallback）。這是 reviewer recipe 政策，不是把一般 CLI ceiling 改成 `xhigh`/`max` 以外的值。CLI surface 改版後須以 live probe、focused regression 與 dogfood evidence 才能調整。`--model <resolved>` 該值為集中定義的探測政策解析結果，可經 `DEVPRO_SECOND_REVIEWER_MODEL_CLAUDE` 覆寫；政策 selector 集中宣告於 `second-reviewer-cli-recipe-contract.mjs` 的 `SECOND_REVIEWER_MODEL_DEFAULTS`；實際 exact model 與探測證據以 renderer 的 `reviewer_model_selection` 為準。

### Switching

- 互動 session：`/model <model-or-effort-selector>`，切換後回報目前 tier 與理由。
- 新 process：`claude --model <model-or-effort-selector>`；長流程可開不同 terminal 固定不同 tier。
- Shared rules 不寫死 model 字面；若 selector unavailable，降到帳號可用最高相鄰 tier，並在回報中標記 fallback。

### Sample Workflows

**Routine implementation**：medium TL 讀 proposal → dp-programmer 實作 → medium TL 驗收；若測試失敗兩輪仍無 RCA，升 high 做根因判斷。

**Production/security blocker**：max TL 先做假設樹與風險排序 → xhigh/high 驗證最可能路徑 → medium/dp-assistant 跑機械測試與 log 過濾。

> _Anchor: 截至 2026-05 Claude Code interactive model switching 支援 `/model`，CLI launch 支援 `--model`；本檔只綁 selector 類型，不綁具體 model 版本字面。_

### Sub-agent Effort（frontmatter）

`.claude/agents/*.md` frontmatter 支援 `effort:` 欄位（Claude Code 官方 sub-agents.md）。設定後固定該 sub-agent 的 reasoning depth，**覆蓋** spawn 它的 TL session 當下 effort——未設則繼承 session。

**與 TL `/model` 切換正交**：model 與 effort 獨立設定；sub-agent 的 frontmatter effort 不隨 TL 浮動，TL 升/降 session effort 不影響已固定 effort 的 sub-agent。

**devpro 分配原則**（見 §Effort Mapping）：

| 職責分類 | agent | effort | 理由 |
|---|---|---|---|
| mandatory-gate / 高風險設計 | dp-reviewer, dp-architect | xhigh | 六軸 mandatory gate / 高風險架構設計；與 Codex host 投影同級（見下方對齊說明） |
| reasoning-critical（需求分析）| dp-analyst | xhigh | 設計鏈上游——analyst 漏的需求/風險 architect 設計時補不回，近 architect |
| reasoning-critical（cross-review wrapper）| devpro:second-review | xhigh | wrapper orchestration；與 Codex host 投影同級 |
| reasoning-critical（實作）| dp-programmer | high | 需理解設計語意 |
| rote work（機械判斷偶需） | dp-assistant | medium | 機械為主偶需判斷 |
| 唯讀 fan-out 搜尋 | dp-explorer | low | 純讀 fan-out 平行 spawn——high × 大量 = 成本爆 |

reasoning-critical agent effort 由職責保障（不隨 TL 浮動）；機械/唯讀 agent 用 medium/low 符 §Common Rationalizations 成本紀律（反「無推理任務付 high overhead」）。

**devpro:second-review 兩層 effort（重要）**：devpro:second-review 的 frontmatter effort（`xhigh`）是 **wrapper orchestration 自身**的 reasoning depth（組 review packet / 抽 schema-valid JSON / 驗 sticky / 處理 fallback）——這是 Claude Code 層。它 **spawn 的 codex CLI** 的 `model_reasoning_effort` 是另一層，依 cross-review recipe 政策固定 `xhigh`（`gpt-6` 目錄另有 `max`/`ultra`，本 recipe 不採用；`high`/`max` 仍 fail-closed；見 `codex-effort-tiers.md` §Switching + `.devpro/agent-rules/code-review-cross-model.md` Cross-Model SHALL clause）。Codex-host 投影 `.codex/agents/dp-second-reviewer.toml` 的 `model_reasoning_effort=xhigh` 同樣是 **wrapper/Codex projection 層**，**不是** terminal `claude -p --effort`；terminal Claude second-reviewer argv 另由 recipe 釘 `--model <resolved>` + handoff `reviewer_effort_ceiling` 內 probe-backed `--effort xhigh|max`（見本檔上方 ceiling 句；exact model 為集中定義的探測政策解析結果，可經 `DEVPRO_SECOND_REVIEWER_MODEL_CLAUDE` 覆寫，政策 selector 宣告於 `SECOND_REVIEWER_MODEL_DEFAULTS`；實際 exact model 與探測證據以 renderer 的 `reviewer_model_selection` 為準）。兩層不混，不能用 frontmatter／toml effort 代表 terminal Claude argv effort。

**Claude Code／Codex host 對齊**：dp-reviewer、dp-architect、devpro:second-review 的 frontmatter effort 與 `.codex/agents/*.toml` 的 `model_reasoning_effort` 同級（`xhigh`；cross-review recipe 政策固定，非 catalog 上限），同一職責在兩個 host 付出同級推理深度。不再以「職責綁定 max」常駐 `max`；個別高風險判斷需要 `max` 時由 TL 在 session 層明示升級，不改 frontmatter。frontmatter effort 覆蓋 session（見上），所以 session 升級只作用於 TL 自己的判斷：Claude Code 上 floor-gated 架構權衡需最高努力層時，TL 升 session 至 `max` 自行判斷；委派 dp-architect（`xhigh`）不視為達 floor。

## Exit Criteria

- 已選 low / medium / high / xhigh / max 之一
- 已說明升降 effort 的理由
- 若 selector 不可用，已標記 fallback tier

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「全程 max 最保險」 | 高 effort output 與 input context 都更貴；只在高風險判斷點使用 |
| 「小修也用 high」 | 小修的固定 overhead 大於收益；medium/low 足夠 |

## Verification

```bash
grep -E "low|medium|high|xhigh|max" .devpro/agent-rules/platform-adapters/claude-code-effort-tiers.md
grep -F "_Anchor:" .devpro/agent-rules/platform-adapters/claude-code-effort-tiers.md
```
