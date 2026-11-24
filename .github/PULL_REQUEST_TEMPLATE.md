## OpenSpec

- change: `openspec/changes/<name>/`
- tasks.md: all checked / partial (explain)
- archive: done in this PR branch

## Change Context
- 改什麼：<plain language what changed>
- 目的：<why>
<!-- 白話；先改什麼再目的；禁 file-first／檔案清單當標題；path MAY 短輔助 -->

## Manual Test
- 需要人工測試：是 / 否（否 → 一行 `N/A: <reason>`，刪其餘 bullet）
- 怎麼測：<steps>
- 測什麼：<scope>
- 通過標準：<pass criteria>

## Requirement Ledger Completion

- disposition counts: implemented <n>, partial <n>, deferred <n>, rejected <n>, moved-to-issue <n>
- non-implemented rows: N/A / <R# disposition + owner/issue/next step>
- coverage: implemented/partial rows have `[Req: R#]` task evidence; unknown `[Req]` refs: none

## Test Evidence

- 指令：`node --test .devpro/scripts/tests/` / `node .devpro/scripts/lint-agent-skills.mjs` / project-specific command
- 結果：`passed <n>, failed 0` **或** `not verified: <reason>`
- 覆蓋：`<各 gate 輸出的範圍／檢查數；base 不可解填 not verified／base unresolved；base 已解析且 0／不相交須註明 no applicable files 或 checked=0>`
- QA 範圍：`openspec/changes/<name>/qa-test-scope.md`
- **驗收證據**：
  - [ ] <proposal target state evidence>
  - [ ] <regression test or grep evidence>

## Cross-Model Review

- Status: exempt / sticky URL + `verdict:` + `last_reviewed_sha:` / blocked (`UNAVAILABLE` or `CRITICAL`)
- Human reviewer handoff: N/A / required because <reason>

## Scenario Walkthrough
<!-- Required when PR touches enforcement carriers: `.devpro/agent-rules/*.md`, `scenarios/scenario-*.md`, `.devpro/scripts/hooks/*.mjs`, `.devpro/scripts/hooks/lib/*.mjs`, `.claude/agents/*.md`, `.claude/commands/*.md`, or `.devpro/agent-skills/**/SKILL.md`. Otherwise mark N/A. -->
- Status: [executed PASS | skipped by AI decision: <reason> | skipped per user decision: <reason> | N/A (non-enforcement-carrier change)]
- Evidence: [walkthrough subagent return summary | mechanical scenarios.test.mjs output | N/A]

## Cost Circuit Breaker Overrides
<!-- Required when this change-cycle's checkpoint (notes/tmp/state/devpro-change-usage/<change>.json) has any overrides[] entries; otherwise `N/A` or `N/A: <reason>`. One line per override, sorted by `at` ascending: `- at=<ISO8601> thresholds=<comma-separated, ASCII-ascending> head_ref_oid=<40-hex sha>`. This section also records `thresholds=review_round` entries (a round-cap extension via `DEVPRO_REVIEW_ROUND_OVERRIDE`); disclosure is one entry per (session, head), not one per round. -->
- N/A

## Fixes / Closes（有對應 issue 時填；否則刪本段）
<!-- 每個要關的 issue 各一獨立裸文字 KEYWORD #N。每行一條 Closes #N／Fixes #N，或 Closes #12, closes #34。
     MUST NOT: Close #12 / #34、Close #12/#34、Fixes #12 / Fixes #34、Closes #12, #34（slash／裸 #N after comma 不會都關）。 -->
- Closes #N
- Closes #M

## 條件式欄位（適用時必須填寫，不適用則刪除該區塊）

### 新增或升級第三方套件

| 套件名稱 | 版本 | SPDX 授權 |
|---------|------|----------|
|         |      |          |

### DB Schema 變更

- **Migration 檔案路徑**：
- **Rollback 可行性**：可 rollback / 不可逆（說明原因）

### Release 線或 Production 修復

- **影響範圍**：
- **受影響環境**：DEV / SIT / UAT / PAT / PROD
- **Rollback 計畫**：

### Release 目標輪（milestone）

- **Release Target**：填 `Release Target: <YYYYMMDD>`（與 PR milestone 一致；warn-only 人讀備援，不阻擋 PR）

## Review Summary

- **Critical**：0 件
- **Important**：0 件
- **Suggestion**：0 件
- **已檢查**：SQL injection ✓ | PII ✓ | 授權 ✓（或 N/A）
