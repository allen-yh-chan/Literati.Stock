# fixtures/loop-termination/

Fixtures for `hook-pre-tool-gate-cross-model-path-d-prime.test.mjs` (Path D′
fresh-equivalent merge-gate carve-out; see
`openspec/changes/strengthen-cross-review-loop-termination/design.md` D2/D11/D12)
and for `review-round-budget.test.mjs` (D11 (b)/(c) round-budget replay
fixtures).

## SHA provenance (all files)

Every `last_reviewed_sha` / `headRefOid` value in this directory is a
**form-equivalent 40-hex placeholder** (`a1a1…` / `b2b2…` patterns), **not** a
real commit sha from PR #2407 or any other PR. `design.md` D11 prefers real
PR #2407 sha values but explicitly permits placeholders when real values are
not conveniently reproducible; the real PR #2407 history does not contain an
exact "round 8 PASS + whitelist-only bookkeeping diff" sequence at the round
number the design uses illustratively (the real PR's sticky comment reached
round 22+ before this fixture set was authored), so placeholders are used
throughout to avoid presenting an unverified sha sequence as if it were a
validated real one. Every JSON file also carries this note in its own
top-level `_meta.sha_provenance` field.

No PII: no email addresses, no personal absolute paths, no tokens. PR
numbers, repo-relative paths, and branch names referenced in `_meta` fields
are public repo facts (`devpro-tw/devpro-agent-rules`, public GitHub repo).

## Files

| File | D2 judgement-table row | Expected `evaluateFreshEquivalent` outcome |
|---|---|---|
| `path-d-prime-positive.json` | (a) positive — whitelist-only diff | `fresh_equivalent: true`, `reason: "path-d-prime-whitelist-only"` |
| `path-d-prime-negative-outside-whitelist.json` | (a) reverse — same base, files gains a `.devpro/agent-rules/*.md` entry | `fresh_equivalent: false`, `reason: "path-d-prime-whitelist-miss"` |
| `path-d-prime-negative-specs-segment.json` | (a′) prefix hit but `specs` path segment under `openspec/changes/**` | `fresh_equivalent: false`, `reason: "path-d-prime-whitelist-miss"` |
| `path-d-prime-negative-1-compare-unavailable.json` | #1 — gh spawn/exit failure or non-JSON stdout (incl. offline/rate-limit) | `fresh_equivalent: false`, `reason: "compare-unavailable"` |
| `path-d-prime-negative-2-http-error.json` | #2 — HTTP 404/422 (sha not found / repo no access) | `fresh_equivalent: false`, `reason: "compare-unavailable"` |
| `path-d-prime-negative-3-diverged.json` | #3 — `status` ∉ `{"ahead","identical"}` (`diverged`) | `fresh_equivalent: false`, `reason: "compare-status-not-ancestor"` |
| `path-d-prime-negative-4-files-invalid.json` | #4 — `files` missing/non-array/element missing `filename` | `fresh_equivalent: false`, `reason: "compare-files-invalid"` |
| `path-d-prime-negative-5-files-truncated.json` | #5 — `files.length >= 300` (cannot prove whitelist-only) | `fresh_equivalent: false`, `reason: "compare-files-truncated"` |

Fixtures with an `_meta.mock_env` field of `"CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_ERROR"`
carry a `compare.error` string instead of `compare.status`/`compare.files` —
the test harness injects that string via the `_ERROR` mock env var (simulating
a real `gh api` non-zero exit / spawn failure) rather than the `_OUTPUT` mock
(which simulates a parsed, exit-0 JSON body).

## Round-budget replay fixtures (D11 (b)/(c))

| File | D11 row | Expected outcome |
|---|---|---|
| `round-budget-convergence-bookkeeping.json` | (b) round 24→25 convergence | at-cap dispatch still fails closed `review_round_budget_exhausted`; the R6 convergence predicate governs verdict content on an authorized round, not dispatch eligibility |
| `round-budget-fault-recovery.json` | (c) fault-recovery does not count | `round_count` unchanged; `dispatch_lineage` gains one entry, `kind: "fault-recovery"`, `round` == the unincremented `round_count` |

Consumed by `../review-round-budget.test.mjs`.
