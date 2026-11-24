---
name: rule-governance
description: "Rule-corpus governance workflow with selectable modes: audit-only, split-dedup-review, and convergence-loop. 使用時機：使用者要求審查/rationalize rule corpus、拆分/dedup、rule self-evolution 閉環自我收斂（消費 open [rule-feedback] issue pool 與 eligible session-pending）、掃描 dead/orphan rule-leaf 或治理觀測、修復 accepted audit findings，或提到舊 dp-rule-audit/dp-convergence-loop 入口時。"
metadata:
  user-invocable: true
---

# Devpro Rule Governance

## Overview

本 skill 是 rule corpus governance 的單一 user-invocable 入口。`dp-rule-audit` 與 `dp-convergence-loop` 只是本 skill 的 mode alias（使用者語句出現時對應到對應 mode），不是獨立 skill。

**Policy SSOT 留在 rule leaves，本 skill 只負責 mode selection、載入順序與 loop orchestration：**

| Area | SSOT |
|---|---|
| audit cadence、inventory、三視角、disposition、risk、fan-out | `rule-audit-playbook.md` |
| split/dedup decision gate、7-step SOP、Protected Anchors、file-role ledger shape | `doc-split-and-dedup-sop.md` |
| 6 Principles、ROT、Hook-or-Don't-Add、Skill SSOT | `rule-design-principles.md` |
| value-score、cruel-metric、why_not_hack、anti-spin、governance-budget、dual-source ingest／claim-all／Governance Batch Selection | `rule-self-evolution.md` |
| corpus-dup 債觀察口（同一 cadence，非平行軌道） | `rule-audit-playbook.md`（cite `dry-ssot-corpus.md`） |
| subagent / fan-out finding verification | `multi-agent-handoff.md` §Finding Verification |
| governance full suite + red-suite disposition | `test-suite-cadence.md` |

`convergence-loop` mode 修的就是 audit 找出、且經 disposition/value gate 接受的 issues；它不得跳過 audit 基準另起一套審查標準。

## Mode Selection

若使用者未明確指定 mode，停下並用以下三個選項請使用者選擇；不要新增第四個 mode：

1. `audit-only` — 盤點與審查 rule corpus，輸出 verified findings、disposition、risk tier；不主動修。
2. `split-dedup-review` — 針對拆分、merge、dedup、Protected Anchors 做決策審查；不主動修。
3. `convergence-loop` — 先 audit，再只修 accepted findings，驗證並 re-sweep until dry。

Alias routing:

- 使用者說 `dp-rule-audit`、audit、審查、盤點、rationalize → `audit-only`，除非他明確要求修。
- 使用者說 split、dedup、de-bundle、Protected Anchors、拆檔 → `split-dedup-review`。
- 使用者說 `dp-convergence-loop`、convergence、closed-loop、自我收斂、找問題修到 dry → `convergence-loop`。

## Common Process

1. Record the selected mode in the response or proposal artifact.
2. Run `node .devpro/scripts/run-test-suite.mjs --tier all` before any mode-specific step; red-suite disposition per `test-suite-cadence.md` §Source Repo Test Runtime Budget.
3. Load only the SSOT leaves required for that mode. Do not paste their policy criteria into this skill's ledger/output.
4. Treat every subagent or static finding as a hypothesis until TL verifies the cited source lines or repro command per `multi-agent-handoff.md` §Finding Verification.
5. Keep paths repo-relative in governance artifacts; do not commit host absolute paths.
6. For any accepted change to rule corpus, route implementation through `devpro:change` / OpenSpec / TDD / pre-PR as required by the active rule flow.

## Mode: audit-only

Use when the user wants corpus audit/rationalization without automatic repair.

1. Load `rule-audit-playbook.md`; load `doc-split-and-dedup-sop.md` when split/dedup classification is involved; load `rule-design-principles.md` only for referenced design criteria.
2. Inventory before judging: produce the file-role ledger shape required by `doc-split-and-dedup-sop.md`.
3. Audit the inventory with the audit playbook views and signal prioritization. **MUST** include the token budget / cap pressure lane (rule-file utilization/over-cap + `AGENTS.md` HARD pressure via production measurements / `cap-pressure=over`).
4. Verify each finding at source before accepting it.
5. Assign disposition and risk tier using `rule-audit-playbook.md`.
6. Output a prioritized ledger. Do not edit files unless the user separately authorizes a repair change. Repair remains **accepted-finding-only**; ordinary hard-trim-for-cap of valued semantics is banned.

## Mode: split-dedup-review

Use when the user is deciding whether to split, merge, trim, de-bundle, or deduplicate rule/skill/AGENTS content.

1. Load `doc-split-and-dedup-sop.md` and the relevant parts of `rule-design-principles.md`.
2. Apply the split decision gate before proposing a split; if the gate fails, recommend trim or no-op instead.
3. Classify duplication only as `true duplication`, `leaf-self-contained`, or `cross-runtime fallback`.
4. Check Protected Anchors before wording compression or anchor movement.
5. Output the decision and required follow-up carrier. Do not perform the edit unless the user explicitly asks to implement it.

## Mode: convergence-loop

Use when the user wants closed-loop corpus repair, not just a report.

1. Load `rule-audit-playbook.md`, `rule-self-evolution.md`, and `multi-agent-handoff.md` §Finding Verification; load repair-flow SSOT lazily when a repair is accepted.
2. Start with an audit pass or an existing audit ledger. Existing findings still need TL source verification before action.
3. Apply disposition/risk from `rule-audit-playbook.md` and value gates from `rule-self-evolution.md`. Consume the **unified** ranked pool: open `[rule-feedback]` **and** eligible session-pending (eligibility／`source_provenance`／ledger／cluster SSOT in `rule-self-evolution.md`—do not restate long flow here).
4. Before any accepted-repair / OpenSpec write for an evolution batch: selection-time revalidate → **claim-all** → durable `## Governance Batch Selection` MUST complete (`claim_all_status: all-success`). **First-batch exception:** when no tracked proposal/proposal-mini exists yet, after claim-all the operator MAY create only the tracked **skeleton + `## Governance Batch Selection` segment**; **MUST NOT** accepted-repair or other OpenSpec writes until durable selection succeeds (partial claim → release THIS attempt → reselect; post-claim durable-persist failure paths per leaf).
5. Repair only findings accepted by those gates (**accepted-finding-only**). Rejected, deferred, unverified, or high-risk findings do not enter the current repair batch. Ordinary changes MUST NOT hard-trim valued semantics solely to satisfy a cap.
6. For each accepted repair, open the proper change lane and use TDD/mechanical guard coverage proportional to risk.
7. Verify the original finding's repro turns negative, then re-sweep the relevant audit lanes.
8. Converged means two consecutive dry rounds: no new verified findings, no accepted findings after gates, and all fixed findings stay negative.

> Optional load check: `node .devpro/scripts/report-governance-ratio.mjs` prints a report-only governance-vs-dev-work ratio + trend over archived changes (path-based rule-leaf taxonomy). It is observation only — it never gates advancement — so use it to eyeball self-maintenance load, not as a pass/fail signal. (That a report-only ratio observation is permitted yet never gates advancement is defined by the `Governance Budget Stop-Loss` requirement in the `rule-self-evolution` capability spec; the `rule-self-evolution.md` leaf carries the companion `governance-budget` anti-hack row — per-candidate friction, not a ratio threshold/dashboard.)

Minimum sweep lanes for convergence mode (**MUST** enumerate; silently omitting a lane is a governance contract violation):

- test/validation health
- dead references and orphan routing — run `node .devpro/scripts/report-leaf-references.mjs [--dead-threshold N]` to surface dead / near-dead leaves as consolidation candidates (report-only, always exits 0, never gates; deleting a `dead` leaf paired with a governance net-add satisfies the Governance Budget Stop-Loss pairing option)
- token budget / cap pressure — **MUST** scan rule-file utilization/over-cap and `AGENTS.md` HARD pressure (`rule-token-budget.mjs` / `cap-pressure=over`); repair accepted-finding-only; ordinary hard-trim-for-cap banned
- skill manifest and runtime discovery alignment
- state hygiene for markers, sentinels, and fixtures
- twin-gate checks when mechanical gate behavior changed
- DRY/SSOT sweep for duplicated facts, thresholds, symbols, or policy prose

## Common Pitfalls

- Treating `convergence-loop` as a separate review standard instead of an audit-plus-repair mode.
- Fixing raw simulation output before TL source verification.
- Repairing a finding that has not passed disposition, risk, and value gates.
- Starting accepted-repair before claim-all + durable `## Governance Batch Selection` on an evolution batch (first-batch skeleton + selection segment after claim-all is the only OpenSpec bootstrap exception).
- Skipping the token budget / cap pressure MUST-scan lane or hard-trimming valued semantics on an ordinary change to clear cap pressure.
- Keeping `dp-rule-audit` or `dp-convergence-loop` as separate manifest/runtime discovery entries.
- Duplicating SSOT prose from the leaf rules inside the skill body or governance ledger.

## Verification

```bash
node .devpro/scripts/lint-agent-skills.mjs
node --test .devpro/scripts/tests/agent-skill-governance.test.mjs
# T6 presence locks (also asserted in agent-skill-governance.test.mjs):
grep -E "token budget / cap pressure|accepted-finding-only|hard-trim-for-cap|MUST.*scan" .devpro/agent-skills/rules-authoring/rule-governance/SKILL.md
```
