---
name: platform-adapter-codex-effort-tiers
description: "Codex reasoning effort tiers：low / medium / high / xhigh 對應、CLI flag；cross-review recipe 政策固定 xhigh（gpt-6 目錄另有 max/ultra 但不採用）；觸發：需要選 Codex reasoning depth 時。"
---

# Platform Adapter：Codex Effort Tiers

## Overview

本檔是 `platform-adapters/codex.md` 的 reasoning-depth leaf，也是 `platform-adapters/claude-code-effort-tiers.md` 的 Codex 對稱檔。Shared effort rank SSOT 為 `model-delegation-delegation-rules.md` §TL Effort Floor 的四階（低努力層／中努力層／高努力層／最高努力層）；本檔只做 rank→selector mapping，不得把本檔 selector 倒灌成 shared 詞彙。Codex `gpt-6` 世代目錄另提供 `max`／`ultra`；本檔的 4-Tier Mapping 是 devpro 的 rank→selector 政策（cross-review recipe 固定 `xhigh`），非宣稱 `xhigh` 為 catalog 上限。

## When to Use

- TL 需要選 Codex reasoning depth，而不是只選角色或 subagent
- Codex host 執行 proposal、RCA、review、或高風險修復前
- 其他 host 把 Codex CLI 當 external second reviewer 呼叫時

## Process

### 4-Tier Mapping

| Shared rank | 用途 | Codex selector |
|---|---|---|
| 低努力層 | 小 typo、格式調整且無行為設計 | `-c model_reasoning_effort="low"` |
| 中努力層 | routine 實作、測試、OpenSpec 小改 | `-c model_reasoning_effort="medium"` |
| 高努力層 | 複雜 code review、RCA 根因判定、Branch Routing、相依性／分派排序、TL review 綜合判斷 | `-c model_reasoning_effort="high"` |
| 最高努力層 | proposal 技術設計／架構權衡、release/security/production blocker 的 TL 判斷；Codex 對跨檔高風險 debug 的加嚴建議 | `-c model_reasoning_effort="xhigh"` |

> 上表為 devpro 的 rank→selector 政策映射，非 catalog 上限：Codex `gpt-6` 世代目錄另提供 `max`／`ultra`，而 cross-review recipe 政策固定 `xhigh` 且不採用之。

`model_reasoning_effort` 的指定值只記為 selected effort。只有 adapter 可觀測的 runtime session metadata 或 switch report 證明實際生效時，才可記為 effective rank；selected 值或角色 frontmatter 本身不得當作 floor 證據。Codex 有 verified selector 但沒有 effective 證據時，依 shared 規則記為 `unknown`。

### Switching

- Codex CLI invocation：在 `codex exec` 加 `-c model_reasoning_effort="<tier>"`。
- Cross-review recipe 政策固定 `xhigh`（不寫死 high；selector rejected 時 fail closed，不得降可用最高相鄰 tier，亦不得在 sticky/final 標 effort fallback）。`gpt-6` 世代目錄另提供 `max`／`ultra`，本 recipe 不採用；`high`／`max` 仍 fail-closed。語意 SSOT 為 `.devpro/agent-rules/code-review-cross-model.md` 的 Cross-Model 第二意見 SHALL clause（「該 CLI 固定政策內最高相容 reasoning tier」）。
- 不寫死 `-m <model>`；model 由帳號可用 tier 與 runtime policy 決定。

```bash
# </dev/null 關閉 stdin，避免 codex CLI 在 positional prompt 模式仍等 stdin 而卡死
# reasoning effort 依 cross-review recipe 政策固定 xhigh（gpt-6 目錄另有 max/ultra 但本 recipe 不採用）
codex exec --json -c model_reasoning_effort="xhigh" -C <abs-worktree> "<prompt>" </dev/null
```

> _Anchor: 截至 2026-05 Codex CLI 支援以 `-c model_reasoning_effort="<tier>"` 控制 reasoning effort；本檔只綁 selector 類型，不綁具體 model 版本字面。Codex `gpt-6` 世代 catalog 有效值另含 `max`／`ultra`，但 cross-review recipe 政策固定 `xhigh`，本檔不宣稱 `xhigh` 為 catalog 上限。_

## Exit Criteria

- 已選 low / medium / high / xhigh 之一
- selected effort 與 observable effective rank 分開記錄；只有 selected 值時不得宣稱已達 floor
- 已說明升降 effort 的理由
- 若 selector 不可用，已標記 fallback tier（cross-model second-opinion 例外：fail closed、不降階，見 §Switching）

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「Codex review 一律 xhigh」 | 區分兩類：一般 review（TL host=codex 自審 routine）按 tier 表（medium/high，避免 token/latency 固定放大）；**cross-model second-opinion review 例外**——依 cross-review recipe 政策固定 `xhigh`（`gpt-6` 目錄另有 `max`/`ultra` 但本 recipe 不採用；`high`/`max` 仍 fail-closed；per `.devpro/agent-rules/code-review-cross-model.md` Cross-Model SHALL clause + 上方 §Switching），對抗性紅利靠頂級互檢。 |
| 「selector 被拒就當 Codex 不可用」 | selector failure 只代表 tier 不可用；一般 review 可降到最高相鄰 tier 後繼續（cross-model second-opinion 例外：`xhigh` 不相容時 fail closed、不降 `high`，見 §Switching）。 |

## Verification

```bash
grep -E "low|medium|high|xhigh" .devpro/agent-rules/platform-adapters/codex-effort-tiers.md
grep -F "_Anchor:" .devpro/agent-rules/platform-adapters/codex-effort-tiers.md
```
