# Archive-Gate Required Headings Reference (cold reference)

SSOT: `proposal-template.md`. This is a distilled lookup table for which heading satisfies which `pre-pr-archive-gate.mjs` check letter; if this drifts from the rule leaf, the rule leaf wins.

| Heading | Required by | Enforcement carrier |
|---|---|---|
| `## Why` | All proposals/proposal-minis | `pre-pr-archive-gate.mjs` check (c); missing → CLI does not produce `spec.md` |
| `## What Changes` | All proposals/proposal-minis | `pre-pr-archive-gate.mjs` check (c) |
| `## Requirement Ledger` | All proposals/proposal-minis | `pre-pr-archive-gate.mjs` check (m); MUST be a parseable 6-column markdown table, not a bullet list |
| `## Issue Anchor Verification` | All proposals/proposal-minis | archive-gate self-check discipline (design-fact verification, not necessarily an issue-closing reference) |
| `## Batch Approval Ledger` | All proposals/proposal-minis | `pre-pr-archive-gate.mjs` check (c) extension (enforce-batch-scope-ledger-presence); heading absent blocks like `## Why`/`## What Changes`; present-but-incomplete (`shapeless`) blocks independently — `N/A: no batch approval selected` or a complete `kind`/`named_change`/`branch`/`repo_scope`/non-empty `covers`/`excludes` ledger is required |
| `## File-Role Ledger` | Proven source topology proves delete, rename/copy, split, merge/collapse, or cross-file dedup | Split-gate + duplication classification discipline |
| `## Dedup Audit 三步結果` | Same proven source topology trigger as File-Role Ledger | Three-step dedup audit per `doc-split-and-dedup-sop.md` |

Proven consumer proposals omit both source-governance headings even when an adopted carrier is renamed/deleted. Ordinary source lone M / independent A also omits them. Ambiguous bounded source topology uses exact `Source-Governance-Action: none|split|delete|merge|dedup; carriers=<exact comma-separated paths>; evidence=<status/path tuples>`; `none` cannot suppress a definite trigger. Unknown identity with a bounded candidate blocks for identity evidence; without a bounded candidate it also omits headings, attestation, and N/A. Do not add substitute evidence.

Token budget has no proposal heading or evidence carrier. Pre-PR checks (e)/(r) measure the actual `AGENTS.md` and `.devpro/agent-rules/**/*.md` final state; >=80% is only `semanticReview=required` for the actual carrier.

## Requirement Ledger schema (exact columns, do not rename)

```
| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |
```

- `ID` MUST be `R<N>` format (`R1`, `R2`, `R1a`) — no other prefix, no ranges (`R1-R7` is rejected by gate (m))
- `Disposition` enum: `implemented` / `partial` / `deferred` / `rejected` / `moved-to-issue`
- Cells MUST NOT contain an unescaped `|` — escape a literal pipe as `\|`, or use `/` / cite a source instead
- Every `implemented`/`partial` row needs at least one task/evidence covering it; `deferred`/`rejected`/`moved-to-issue` rows need an owner/next-step instead

## Pre-architect self-check (from `proposal-template.md`)

Before review, self-check:

1. AGENTS.md 觸發式載入索引 entry exists for any new rule/template/skill file in the touch list
2. New mechanical gate has a named hook path / `devpro:pre-pr` step / check letter
3. Section 1 Target State uses grep-able literals, not abstract phrasing
4. Ledger: 6-column table; each requirement listed; follow-on changes keep Root + Parent; tasks use exact `[Req: R<N>]` (no ranges); non-implemented rows have owner/next-step
5. Issue Anchor is present; source File-Role/Dedup headings are present only when proven source topology triggers them

## Verification

```bash
# Always run:
grep "^## Why\|^## What Changes\|^## Requirement Ledger\|^## Issue Anchor Verification" openspec/changes/<name>/proposal.md

# Run exactly one source-governance branch after identity/topology classification:
# A. proven-source bounded operation definite/attested — both headings MUST exist
grep "^## File-Role Ledger\|^## Dedup Audit" openspec/changes/<name>/proposal.md
# B. proven consumer, non-triggering source, or unknown identity without bounded candidate — both headings MUST be absent
! grep "^## File-Role Ledger\|^## Dedup Audit" openspec/changes/<name>/proposal.md
```
