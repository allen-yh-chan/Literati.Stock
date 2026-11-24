---
name: consumer-failure-playbook
description: Consumer failure playbook：dirty tree、rules drift、PR dirty/conflicting、no CI、gh auth、archive、cross-review 卡住時的排查入口。
---

# Consumer Failure Playbook

## Overview

First stop when consumer adoption, sync, PR, archive, hook, or review gets stuck. It routes a symptom to first check, owner rule, and fail-closed next action.

## When to Use

- Consumer adoption or rules sync is blocked
- PR is dirty, conflicting, checkless, or cross-review blocked
- Hook, `gh`, or OpenSpec archive status is unclear

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | `pre-tool-gate.mjs`, `pre-pr-archive-gate.mjs`, `post-pr-completion-check.mjs`, `sync-agent-rules.mjs --check` |
| Advisory | `devpro-doctor.mjs`, `test-consumer-smoke.mjs` |
| Doctrine | `cooperative-only: symptom triage requires current repo/PR state and routes to owner rules` |

Start with one row, run the first check, then continue in the owner rule. Do not repair, commit, push, merge, or bypass unless the row and user authorization allow it.

<!-- consumer-failure-playbook:triage:start -->
| Failure | First check | Owner route | Fail-closed next action |
|---|---|---|---|
| Dirty tree before branch/PR | `git status --short` | `ai-autonomy.md`, `openspec-step-1-to-9.md` | Stop for commit/stash/discard/WIP choice. Only AI-caused `.devpro-agent-rules` checkout drift may be rechecked out. |
| Rules pointer pollution in feature | `git status --short .devpro-agent-rules AGENTS.md` | `openspec-flow-consumer.md`, `git-branch-hygiene.md` | Do not commit pointer/generated drift. Restore residue or open `rules/<source>-v<X.Y.Z>`. |
| PR DIRTY / CONFLICTING after rules sync | `gh pr view <PR#> --json mergeStateStatus,isDirty` | `rules-flow.md` | Never merge main into `rules/*`; rebase/recreate, rerun sync and `sync-agent-rules.mjs --check`, then push with lease if rewritten. |
| Hook false positive | Hook message + gate name | `troubleshooting.md`, `session-recap.md` | No silent bypass. `DEVPRO_HOOK_BYPASS=1 <command>` needs user authorization; record rule feedback if hook/rule is wrong. |
| No CI / no checks | `gh pr checks <PR#> --repo github.com/OWNER/REPO` + `gh run list --branch <branch> -R github.com/OWNER/REPO` | `git-workflow-tracking.md` | Use the No-trigger SOP in `git-workflow-tracking.md` for the specific event. Report `CI: N/A` only when the evidence shows that no workflow would run. If evidence is missing or a lookup failed, report CI as undetermined. Track an expected run and escalate if it stays absent. A required check still pending blocks merge. |
| `gh` unavailable/auth | `gh auth status --active --hostname github.com --json hosts` | `tool-selection.md`, `consumer-adoption.md` | Only missing executable or explicit no-login permits verified devpro-work MCP fallback. Invalid auth, permission/network failure or unknown write outcome stops the operation; no automatic login. |
| OpenSpec archive missed | `find openspec/changes -mindepth 1 -maxdepth 1 -type d ! -name archive` | `openspec-step-1-to-9.md` | Before merge, archive same branch. After merge, use `chore/docs-archive-<name>-recovery`; no second change. |
| Generated AGENTS drift | `node .devpro/scripts/sync-agent-rules.mjs --check` | `rules-flow.md`, `consumer-adoption.md` | In rules lane, run submodule `--sync`, then root `--check`; never hand-edit generated files. |
| Submodule sync drift | `git submodule status .devpro-agent-rules` | `rules-flow-routing.md`, `environment-setup-nvm-nodejs-openspec.md` | If newer rules are needed, stop for rules lane PR; do not advance pointer inside feature work. |
| `devpro:*` skills missing from host skill list | `node .devpro/scripts/sync-agent-rules.mjs --check` | active platform adapter, `rules-flow.md` | Links missing → rules lane sync. Links present → the host may load the entry only in a trusted workspace; accept workspace trust, then restart the session. |
| Cross-model sticky stale/unavailable | `gh pr view <PR#> --json headRefOid,comments` | `post-pr-completion-gate.md`, `code-review-checklist.md` | Rerun `/devpro:cross-review <PR#>`. Labeled same-family fallback allowed; stale/missing/`CRITICAL`/`UNAVAILABLE` blocks merge without explicit risk acceptance. |
| Second review stops with `consumer_review_rules_invalid`, or rejects a handoff with `reviewer_constraints must be a single markdown string` | The stop message (names `base` or `head` and a problem code, never the file text); `node .devpro/scripts/devpro-doctor.mjs` for the file state | `code-review-cross-model.md` §Consumer 審查規則（second-review-rules.local.md）, `consumer-local-rules.md` | `head`: fix `.devpro/second-review-rules.local.md` in this PR, push, rerun the builder. `base`: repair in a new PR; the owner decides how it is released. An older handoff is rebuilt with the current builder, never patched or reused. |
| Doctor reports `.devpro/pre-pr-checks.local` or `.devpro/second-review-rules.local` as no longer read | `node .devpro/scripts/devpro-doctor.mjs` | `consumer-local-rules.md` | The old name is ignored. `git mv` it to `<name>.local.md` (if that file exists, merge into it and delete the old one), commit, rerun doctor until it shows `tracked`; the old content can stay as it is, it is plain markdown now. |
<!-- consumer-failure-playbook:triage:end -->

### Fast Health Checks

```bash
node .devpro/scripts/devpro-doctor.mjs --consumer-smoke
node .devpro/scripts/test-consumer-smoke.mjs
node .devpro/scripts/consumer-adoption-matrix.mjs --profile consumer-lite --enforcement-map
```

## Exit Criteria

- Failure class maps to one owner route
- First check result is known and in handoff
- Write/bypass/rebase/force-push/archive recovery/cross-review rerun is owner-rule authorized
- No generated files or submodule pointers enter unrelated feature work

## Common Rationalizations

| Rationalization | Response |
|---|---|
| "I'll read all rules and decide" | Pick the row first, then read the owner rule. |
| "The hook is wrong, bypass it" | Bypass is user-authorized exception, not diagnosis. |
| "No checks means CI failed" | Verify `gh pr checks` and `gh run list`; it may be `CI: N/A`. |
| "Rules drift is small" | Pointer/generated drift belongs in a rules lane. |

## Verification

```bash
node --test .devpro/scripts/tests/consumer-failure-playbook-grep.test.mjs
node .devpro/scripts/consumer-adoption-matrix.mjs --check
node .devpro/scripts/consumer-adoption-matrix.mjs --profile consumer-lite
```
