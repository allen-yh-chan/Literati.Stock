# Cross-Review Troubleshooting (cold reference)

Distilled index into `platform-adapters/codex-host-cross-review-troubleshooting.md` (SSOT). Read the SSOT file for full wording; this is a quick lookup table for which fault maps to which next action.

| Symptom | Classification | Next action | SSOT detail |
|---|---|---|---|
| Sandbox `Not logged in` / auth-network denied；或成功 init 的 `apiKeySource:none` | 前者為 `sandbox-surface-fault`；後者為中性 metadata | 前者須在 fallback/`UNAVAILABLE` 前 host-rerun；後者不單獨觸發 fault | `code-review-cross-model-cli-contract.md` §External Reviewer CLI Skill Contract point 2; `host-auth-surface.mjs::classifyAuthSurfaceFault` |
| `error_max_turns` on `claude -p` | Invocation/orchestration fault | Reframe smaller packet, fix self-write allowlist, switch stream/progress extraction, or write audit-only `UNAVAILABLE`. Do NOT just raise `--max-turns` and retry same shape | `codex-host-cross-review-troubleshooting.md` §Max-Turn / Empty Result |
| `requires approval` / `permission_denials` | Allowlist or command-shape fault | Narrow to bounded profile (PR read/diff/comment/API + optional `Write` to a body file in the reviewer current neutral cwd); sticky-only PATCH retry uses comment id + head SHA only | `codex-host-cross-review-troubleshooting.md` §Permission Denials And Sticky Write |
| HTTP `529 overloaded` | Provider transient | Retry/backoff; do not classify as auth failure | `codex-host-cross-review-troubleshooting.md` §Provider Transient |
| Stale `PASS\|WARN` sticky + narrow delta (follow-up/test-only/gate-evidence commit) same-shape broad rerun times out | Orchestration friction, not reviewer-unavailable | Reframe as focused sticky-refresh packet (previous sticky/verdict/findings + delta + current head SHA + current gate evidence) | `code-review-cross-model.md` §執行流程 point 4 |
| `30m` total hard cap / transport kill hits after reviewer may have already written sticky | Transport/finalization fault | Query `gh pr view <PR#> --json comments,headRefOid` FIRST; exact current-head marker-matching `PASS` satisfies post-PR authority while the fault remains diagnostic；`WARN`仍須無fault與完整receipt chain | `codex-host-cross-review.md` Timeout-after-writeback rule |
| No stdout for a while | Not automatically "hung" | Health-probe child process / stderr / final JSON readiness / permission evidence / current-head sticky；wrapper samples every `60s`, auto-continues after the non-terminal `15m` checkpoint, and final-verifies/classifies before terminating at the `30m` total hard cap | `code-review-cross-model-cli-contract.md` §External Reviewer CLI Skill Contract Timeout policy |
| Harness blocks `gh` write; `pr-sticky` cannot publish sticky | Harness `gh` write-block | Run `audit-only` (cap 3) → TL builds sticky with `provenance: manual-publish audit-only` (NOT gate artifact) → user publishes from terminal → merge gate remains unsatisfied until verified `pr-sticky` or explicit user waiver | `second-review/SKILL.md` §Harness write-block degrade path |

## Forbidden Corrective Actions

- Do not repeatedly bump `--max-turns` on the same packet shape
- Do not classify sandbox auth failure as "reviewer unavailable" without a host-rerun attempt
- Do not let the host (TL) transcribe/rewrite reviewer findings into the sticky — the reviewer self-writes
- Do not remove the `30m` total hard cap or switch to no-total-timeout for a completed-sticky finalization fault

## Provider Probe History (context, not a live contract)

2026-06-05 live probe found Claude Code 2.1.163 could return `error_max_turns` even at `--max-turns 2/3` on real PR packets, while no-max stream-json completed within the then-current probe cap. This is why the default correction is packet/mode changes, not repeatedly raising the turn cap or removing the current `30m` hard cap. See `codex-host-cross-review-troubleshooting.md` §Provider Probe History for the authoritative note if this needs re-verification against a newer CLI version.

## Verification

```bash
node --test .devpro/scripts/tests/agent-skill-governance.test.mjs .devpro/scripts/tests/cross-review-cli-skills-grep.test.mjs
```
