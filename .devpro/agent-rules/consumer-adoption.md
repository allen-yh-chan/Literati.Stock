---
name: consumer-adoption
description: Consumer adoption tooling：matrix/profile/doctor/smoke 的使用規則；觸發：評估 consumer 導入健康度、profile 分層、enforcement 可發現性、或 consumer smoke。
---

# Consumer Adoption Tooling

## Overview

Consumer adoption tooling answers: consumer-facing leaves, Hard Gate / Advisory / Doctrine coverage, and whether a consumer repo is wired correctly.

## When to Use

- Consumer repo 首次導入或同步後想確認健康度
- 使用者詢問 consumer-lite / consumer-full / source-maintainer profile
- 使用者詢問 Hard Gate / Advisory / Doctrine matrix
- Rules lane PR 需要 consumer-safe smoke evidence

Load-chain：fail/Program Issue 按需載入 `consumer-failure-playbook.md`、`openspec-flow-consumer.md`、`program-planning-state.md`；移除安裝按需載入 `consumer-uninstall.md`、hook 執行位元與落點按需載入 `consumer-hook-file-maintenance.md`；AGENTS 只載本 leaf。

## Process

### Matrix

Run:

```bash
node .devpro/scripts/consumer-adoption-matrix.mjs --check
node .devpro/scripts/consumer-adoption-matrix.mjs --json
node .devpro/scripts/consumer-adoption-matrix.mjs --profile consumer-lite
node .devpro/scripts/consumer-adoption-matrix.mjs --profile consumer-lite --enforcement-map
node .devpro/scripts/consumer-adoption-matrix.mjs --profile consumer-lite --summary
node .devpro/scripts/consumer-adoption-matrix.mjs --profile consumer-lite --agents-md
```

The matrix is the SSOT for profile input. Profile views filter entries by `entry.profiles`. Do not hand-maintain duplicate `AGENTS-lite.md` or `AGENTS-full.md` until generation exists.

### Enforcement Map

Use `--enforcement-map` to decide what to run/trust first. Buckets:

| Bucket | Meaning |
|---|---|
| Hard Gate | A named carrier can mechanically block or check the behavior. |
| Advisory | The carrier warns, nudges, or fails open. |
| Doctrine | Cooperative process / reviewer judgment; no hard block. |

Hard Gate rows must name at least one carrier. If a rule sounds mandatory but has no carrier, the matrix should classify it as Doctrine, not as a hard gate.

### Summary

Use `--summary` for compact adoption counts. It reports total entries, enforcement buckets, audience counts, and carrier-bearing entries. `--check` validates generated `.mjs` carriers against source-controlled `.devpro/scripts/**/*.mjs` basenames.

Use `--agents-md --profile <name>` for generated AGENTS-style onboarding. Stdout-only; do not hand-maintain `AGENTS-lite.md`.

Profile use: compact profile first; load leaf rules on demand when active task explicitly needs that domain; do not copy full rule corpus. `consumer-full` / `source-maintainer` need a documented reason. Track loaded rules with `rule-load-ledger.mjs`; do not re-read unchanged leaves in the same session.

### Doctor

Run:

```bash
node .devpro/scripts/devpro-doctor.mjs
```

Doctor is read-only. In consumer mode it may run root `sync-agent-rules.mjs --check`; it MUST NOT run `--sync`, commit, push, or modify hook config.
It reports source discovery, profile counts, OpenSpec, `gh`, drift, hook wiring, readiness, and next actions. Missing optional tools WARN; generated drift or missing rules source FAIL.

### Consumer Smoke

Run:

```bash
node .devpro/scripts/test-consumer-smoke.mjs
```

Consumer smoke is the rules-lane readiness check distinct from the full source governance suite. Full source suite remains `node .devpro/scripts/run-test-suite.mjs --tier all` and is source-maintainer evidence, not the default consumer smoke.

### Hook 執行位元與落點

sync 後的執行位元還原與 drift 分類、consumer 自有 git hook 的落點見 `consumer-hook-file-maintenance.md`。

### Husky／consumer shell hook LF（POSIX）

Consumer-owned `.husky/* text eol=lf`（放在 Devpro managed gitattributes 區塊**外**）與完整三態說明見 `gitattributes-alignment.md` §Consumer-owned suggestion。本節保留可 grep 的雙語意錨點：**未來 tracked checkout／normalization** 受 `eol=lf` 影響；**既有工作樹 CRLF 檔不會僅因加屬性而自動變 LF**（須明示選檔＋操作者同意後修檔）。既有 CRLF 具名檔的支援修法：先取得操作者對具名清單的明確同意，再跑 `node .devpro/scripts/repair-named-hook-eol.mjs --file <path> … --i-consent-rewrite-named-files`。**Agent 帶上 consent flag 不算同意**——flag 只是 CLI 閘門，不能替代操作者對具名檔的明示同意；禁止 silent 整包改寫 `.husky/`。

### Local overlay (`AGENTS.local.md`)

Consumer 自訂規範合法出口＝root `AGENTS.local.md`（additive-only；見 `consumer-local-rules.md`）。Synced `AGENTS.md`／source 衍生檔仍禁手改。Doctor／smoke 可報告 overlay 存在與否；契約細節以 `consumer-local-rules.md` 為準。

### Retired ledger items and sync notes

- **遷移**：Batch Approval Ledger 若含已退役的項目（`covers`／`excludes` 內的 `same_repo_exact_pr_external_disclosure`、`reviewer_sticky_write_back`、`reviewer_owned_sticky_write_back`、`external_disclosure`）會被拒，只刪那幾項、保留其餘項目；被刪的項目若原本在 `excludes`，那是先前的明示拒絕，刪除後該 change 的第二審照一般 same-repo PR 派送，AI 須在同一輪回覆告知使用者；要讓拒絕繼續成立，寫一條一般 `AGENTS.local.md` 規則在派送前停下，或走 `code-review-cross-model.md` §Merge Gate Enforcement 的 waiver。舊的 `approved` handoff 重跑 builder 重建。
- **sync**：managed gitignore 新增 `openspec/changes/**/lite-scope.md`（`--check` 要求 re-sync，屬例行）。

### Hotfix release-carrier lane（遷移）

Consumer 取得 hotfix carrier lane 規則後的生效點、grandfather 分流與遷移自查 (a)–(d) 見 `release-hotfix-carrier-lane.md` §Consumer 遷移自查。

### Uninstall

從 consumer repo 移除 devpro-agent-rules 的三層指令、移除範圍與不可逆項目見 `consumer-uninstall.md`；一律先跑 `--uninstall --dry-run`。

### Profile Semantics

| Profile | Meaning |
|---|---|
| `consumer-lite` | Minimal consumer operating surface: branch, OpenSpec, testing, security, rules sync, adapter, and adoption checks |
| `consumer-full` | All consumer-visible shared rules plus consumer-owned rules |
| `source-maintainer` | Source repo governance, rule design, hooks, release, and all shared rules |

## Exit Criteria

- Matrix check passes and covers every rule leaf
- Matrix check validates generated `.mjs` carriers against source-controlled carrier basenames
- Enforcement map output groups profile entries into Hard Gate / Advisory / Doctrine
- Summary output derives counts from the same profile-filtered matrix entries
- AGENTS-style artifact output is generated from profile-filtered matrix entries
- Doctor reports no FAIL checks
- Optional tool gaps such as OpenSpec or `gh` are reported as WARN with next actions
- Consumer smoke runs without full source-governance assumptions
- Profile guidance is derived from matrix output, not copied into a second manual prompt
- Profile output commands return only entries for the requested profile

## Common Rationalizations

| Rationalization | Response |
|---|---|
| "Just make an AGENTS-lite copy now" | Duplicate prompt files drift; generate profile views from the matrix first. |
| "Doctor should fix drift automatically" | Doctor is read-only; use `rules-flow.md` for sync. |
| "Consumer smoke can run the full source suite" | Full source suite includes source governance assumptions; consumer smoke must stay lightweight. |

## Verification

```bash
node .devpro/scripts/consumer-adoption-matrix.mjs --check
node .devpro/scripts/consumer-adoption-matrix.mjs --profile consumer-lite
node .devpro/scripts/consumer-adoption-matrix.mjs --profile consumer-lite --enforcement-map
node .devpro/scripts/consumer-adoption-matrix.mjs --profile consumer-lite --summary
node .devpro/scripts/consumer-adoption-matrix.mjs --profile consumer-lite --agents-md
node .devpro/scripts/devpro-doctor.mjs --consumer-smoke
node .devpro/scripts/test-consumer-smoke.mjs
```
