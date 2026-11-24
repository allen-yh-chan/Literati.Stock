import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BYTES_PER_TOKEN,
  PER_FILE_MAX_OVERRIDE,
  READABILITY_CAP_GUARDS,
  TIERS,
  findRuleTokenTier,
  measureRuleTokenBudget,
  validateRuleTokenRegistry,
} from "../lib/rule-token-budget.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rulesDir = path.join(REPO_ROOT, ".devpro", "agent-rules");

it("shared design and performance workflows use the existing next tier without cap overrides", () => {
  for (const name of ["design-reasoning.md", "performance-investigation.md", "project-documentation.md"]) {
    const tier = findRuleTokenTier(`.devpro/agent-rules/${name}`);
    assert.deepEqual(tier.memberships, ["next"]);
    assert.equal(tier.cap, TIERS.next.maxTokens);
    assert.equal(Object.hasOwn(PER_FILE_MAX_OVERRIDE, name), false);
  }
});

// amend-token-tier-registration: TIERS / PER_FILE_MAX_OVERRIDE moved from this test file to
// the production lib (89784ddb8), and unregistered leaves run on the small fallback, so the
// authoring guidance must say "unregistered = small, register only to go higher" and name the lib.
describe("tier registration guidance points at the production registry", () => {
  const namesTestFileAsRegistry = (line) => /rule-token-budget\.test\.mjs/.test(line);

  it("forbidden-side matcher catches the old pointer and passes the new one (resident fixture)", () => {
    assert.equal(namesTestFileAsRegistry("寫完新 leaf 通過 `rule-anatomy.test.mjs` 後，**必須**到 `rule-token-budget.test.mjs` `TIERS` 登記 tier；"), true);
    assert.equal(namesTestFileAsRegistry("未登記＝`small` 1500，免登記；超過才到 `.devpro/scripts/lib/rule-token-budget.mjs` `TIERS` 登記較高 tier；"), false);
  });

  it("rule-file-template.md: unregistered is small with no registration; higher tiers register in the lib", async () => {
    const lines = (await fs.readFile(path.join(rulesDir, "rule-file-template.md"), "utf8")).split("\n");
    const starts = lines.flatMap((line, i) => (line === "### Token Budget Tier Registration" ? [i] : []));
    assert.equal(starts.length, 1, `expected exactly one tier-registration heading, found ${starts.length} at ${starts.map((i) => i + 1)}`);
    const rest = lines.slice(starts[0] + 1);
    const end = rest.findIndex((line) => /^(#{1,3} |---$)/.test(line));
    const section = end === -1 ? rest : rest.slice(0, end);
    assert.ok(
      section.some((line) => /^未登記＝`small` 1500，免登記；超過才到 `\.devpro\/scripts\/lib\/rule-token-budget\.mjs` `TIERS` 登記較高 tier；/.test(line)),
      "tier-registration section must state on one line: unregistered = small 1500, no registration; register higher tiers in the lib TIERS"
    );
    assert.deepEqual(section.filter(namesTestFileAsRegistry), [], "tier-registration section must not send authors to the test file");
  });

  it("rule-design-principles.md: the raise-cap branch names the lib PER_FILE_MAX_OVERRIDE", async () => {
    const lines = (await fs.readFile(path.join(rulesDir, "rule-design-principles.md"), "utf8")).split("\n");
    const raise = lines.filter((line) => line.startsWith("> 3. **提 cap**"));
    assert.equal(raise.length, 1, `expected exactly one raise-cap branch line, found ${raise.length}`);
    assert.match(raise[0], /\*\*提該檔專屬 cap\*\*（`\.devpro\/scripts\/lib\/rule-token-budget\.mjs` 的 `PER_FILE_MAX_OVERRIDE`）/);
    assert.equal(namesTestFileAsRegistry(raise[0]), false, "raise-cap branch must not point at the test file");
  });
});

// Tiered token budget per D3 decision.
// token estimate = Math.ceil(bytes / BYTES_PER_TOKEN)
// Files not listed in any tier fall back to the small tier limit.
// Codex hot path carries host-auth/sandbox/cross-review anchors that must remain literal.
// Keep a narrow buffer so required anchors do not get semantically compressed to satisfy
// an exact boundary.
// Raised 6100 → 6500 in fix-second-reviewer-control-plane-recursion after the
// every-compression readability precheck: the 60s/15m/30m callback boundary is
// action-point content whose order and branches became ambiguous when compressed.
// The initial 6300 bound left only 85 tokens over the measured 6215-token entry;
// 6500 is the smallest round local cap with practical edit headroom, remains far
// below the adapter tier cap, and avoids threshold-fitting compression churn.
// Raised 7000 → 7500 in add-per-session-usage-telemetry: T12 requires the new
// Per-Session Usage Telemetry capability's literal Support marker to live
// directly in this file (vendor-leak-regression.test.mjs only sibling-splices
// claude-code.md, not codex.md), pushing the measured token count from
// 6997/7000 to 7032. ceil((7032 + 250) / 500) * 500 = 7500 per the
// token-budget-precheck.md minimum-cap formula (PER_FILE_MAX_OVERRIDE and
// READABILITY_CAP_GUARDS in rule-token-budget.mjs raised in lockstep).
const CODEX_HOT_PATH_MAX_TOKENS = 7500;

// Per-file cap overrides — narrower than moving a whole tier's maxTokens.
// Use ONLY when one hot-path SSOT leaf legitimately grows past its tier cap but
// the rest of the tier should keep the tighter guard (raising the tier cap would
// silently gift every sibling unearned headroom). Each entry carries a rationale.
//   ai-autonomy.md 7500 → 7750 in strengthen-preflight-self-check: adds the §0
//   動手前十句自檢 item 10 「一致性掃描」 (consistency sweep before action — the
//   防改漏 symmetry of item 1's追溯性). The file was 7435/7500 (65 tok headroom)
//   before this change; the normative 10th self-check the change was chartered to
//   add does not fit (measured 7704 tok with the item's full wording).
//   ai-autonomy.md 7750 → 8500 in strengthen-current-state-delta-gate: owner
//   directive favors readable rule text over over-compression for core autonomy
//   gates. The Current-State Delta Gate is hot-path decision guidance, so its
//   examples and four-question structure stay explicit; only ai-autonomy.md gets
//   this extra headroom, keeping sibling core leaves at the 7500 guard.
//   ai-autonomy.md 8500 → 9000 in strengthen-agent-index-loadchain-guard: the
//   explicit root-cause Load-chain declaration measured 8503 tokens. It is
//   routing evidence, not expendable prose; per the owner's readability rule,
//   ceil((8503 + 250) / 500) * 500 = 9000 is the minimum governed local cap.
//   platform-adapters/codex-host-cross-review.md 10500 → 11000 in
//   strengthen-codex-subagent-auth-gate: same-repo ExternalDisclosureApproval,
//   reviewer-owned sticky write-back, timeout, and cross-repo write boundaries
//   are load-bearing adapter semantics. The file exceeded the adapter tier by
//   62 tokens after cross-carrier sync; a per-file override preserves readable
//   boundary wording without raising the whole adapter tier. Raised 11000 → 11500
//   in fix-second-reviewer-control-plane-recursion after the readability precheck:
//   the wrapper liveness timeline and callback/no-callback branches measured
//   11133/11200 after review, leaving only 67 tokens. A 11500 local cap is the
//   smallest round bound with practical headroom; hard compression obscured order.
//   Raised 11500 → 12000 when the reviewer result/control-classification boundary
//   added the next concrete follow-up: the readable wording measured 11424/11500,
//   only 76 tokens free. That repeats the threshold-fitting failure D17 forbids;
//   12000 keeps the adapter tier bounded and leaves one practical follow-up buffer.
//   Raised 12000 → 12500 in fix-second-reviewer-projection-contract after the
//   compatibility/classification sync measured 12043/12000. The added HTTP 400
//   recipe boundary is load-bearing; the required pre-compression readability
//   check selected the smallest practical round headroom instead of dense prose.
//   Raised 12500 → 13000, then 13500 in strengthen-control-plane-evidence after
//   immutable evidence, bounded cleanup, and typed-denial wording saturated the
//   prior caps. The direct-runner and projection state machines remain explicit,
//   ordered steps; the owner directed retaining AI-readable contract ordering
//   instead of threshold-fitting compression.
//   codex-host-cross-review-troubleshooting.md gets a 2000 local bound in the same
//   change: its measured 1665-token fault table has no duplicate/offset candidate,
//   so the smallest practical round headroom is safer than dense compression or
//   promoting all small leaves to 3000.
//   Raised 1600 → 2000 in fix-second-reviewer-projection-contract after the typed
//   HTTP 400/401/403 classification matrix measured 1665/1600. The matrix is an
//   action-point contract; 2000 is smaller than next-tier promotion and preserves
//   readable branches instead of threshold-fitting compression.
//   Raised 2000 → 2500 after the file reached 2072: the `command -v gh` bullet
//   duplicating the host adapter was removed (2004); the 2026-06-05 probe
//   history is kept because this cold sibling is its designated home.
//   ceil((2004 + 250) / 500) * 500 = 2500.
//   rule-audit-playbook.md 3000 → 3500 in add-audit-sim-fp-taxonomy: adds the
//   mature-corpus sim FP taxonomy (four systematic false-positive classes, each
//   with a "先確認 X" reject action, bound to the Fan-out 回源 gate) distilled
//   from convergence-loop Round 1-4 evidence. The file was 2928/3000 (72 tok
//   headroom, already pointer-dense with zero re-statable slack) before this
//   change; the actionable judgment-checklist form does not compress to fit next
//   tier without losing the per-class reject actions (owner directive I-2:
//   readable rule text over token compression). Only this audit-methodology SSOT
//   leaf gets the override; sibling next-tier leaves keep the 3000 guard.
//   Raised 3500 → 4500 in rationalize-rules-cycle-9: the cadence action point now
//   separates audit trigger from change creation and preserves dry-no-op, static
//   re-arm, stop, and risk-routing branches. At 3362/3500 before the change, the
//   138-token headroom could not carry those load-bearing transitions without
//   shorthand that forces AI to reconstruct meaning. The canonical smallest-cap
//   formula for the complete 3953-token target yields 4500; the focused cadence
//   guard locks the branches while sibling next-tier leaves remain at 3000.
//   code-review-cross-model.md 7500 → 8500, post-pr-completion-gate.md,
//   file-write-destinations.md, and second-review-control-evidence.md
//   3000 → 3500, plus multi-agent-handoff.md 7500 → 8000 in
//   strengthen-control-plane-evidence: the new immutable
//   fault-chain and typed provider-denial contracts saturated these leaves. The
//   owner explicitly requires preserving full AI-readable load-chain, rationale,
//   and ordered gate branches instead of threshold-fitting shorthand. These
//   narrow round caps retain practical edit headroom without raising whole tiers.
//   second-review-control-evidence.md 3500 → 4500 in the same PR after the
//   publication-transaction correction measured 3932 tokens: the explicit
//   transaction → authoritative head → reservation → seven-carrier publication
//   → marker CAS and exact recovery branches are load-bearing. Per the owner's
//   readability directive, ceil((3932 + 250) / 500) * 500 = 4500 is the exact
//   minimum governed cap; the contract is not compressed into inferred shorthand.
//   Raised 4500 → 5500 after the completed control-plane contract measured 5044
//   tokens: terminal-receipt recovery, direct-predecessor exclusivity, crash-stale
//   capacity ownership, and agent-facing unblock semantics are all load-bearing.
//   ceil((5044 + 250) / 500) * 500 = 5500 preserves their full readable order.
//   post-pr-completion-gate.md 3500 → 4500 in the same readability pass: its
//   complete 3796-token gate contract needs ceil((3796 + 250) / 500) * 500 = 4500;
//   compressing the predecessor alternatives would obscure the unblock action.
//   code-review-checklist.md 7500 → 8500 in the same readability pass: its
//   complete 7773-token review contract needs ceil((7773 + 250) / 500) * 500 = 8500;
//   retaining the exact review and disposition branches is more important than
//   fitting the default tier through AI-hostile shorthand.
//   token-budget-precheck.md 3000 → 3500 in the same readability convergence:
//   the direct-d fail-closed contract, exact-table identity rules, and minimum-
//   evidence/non-exhaustive-semantics warning measure 3202 tokens. Applying
//   ceil((3202 + 250) / 500) * 500 = 3500 preserves those action points.
//   platform-adapters/codex-host-cross-review.md 14000 → 14500 in R17: the
//   Claude-only implicit-repo/literal-PR safe-mode contract measured 14164
//   tokens. Its family split, validated source, and forbidden-expansion clauses
//   are load-bearing; ceil((14164 + 250) / 500) * 500 = 14500 preserves them.
//   release-rules-lane.md 3000 → 3500 in fix-pending-rule-guard-gaps: the
//   complete promotion/reconciliation contract measured ~3115 tokens; its
//   graph-only/content-review polarity must remain AI-readable rather than be
//   compressed. ceil((3115 + 250) / 500) * 500 = 3500.
//   Raised 3500 → 4500 in raise-release-rules-lane-token-cap after #1959 PAT
//   executable recipe measured 4144 tokens. ceil((4144 + 250) / 500) * 500 = 4500
//   preserves the copy-pastable managed-checkout recipe and negative-control
//   contract without compressing action-point bash.
//   gitignore-alignment.md 1500 → 3000 in fix-skill-discovery-completeness:
//   the manifest inventory, terminal-block construction, strict batched Git
//   evidence parser, and cross-platform tree proof are one executable contract.
//   Keeping their exact failure semantics readable is more important than
//   compressing the original orientation/exit guidance or new action points
//   into AI-hostile shorthand. The measured 2446 tokens plus the mandatory
//   250-token edit headroom rounds up to the 3000-token local cap.
//   Raised 3000 → 3500 once the contract grew to 3178 tokens: the `## Rules`
//   bullets are required by the rule anatomy check and the rest is the
//   sync-time baseline input plus fail-closed conditions.
//   ceil((3178 + 250) / 500) * 500 = 3500. The file is also registered in
//   TIERS.next so it stops reporting as unregistered.
//   change-consequence-assessment.md registers in TIERS.small with a 2000
//   override+guard: 1742 tokens, no duplicate or historical prose;
//   ceil((1742 + 250) / 500) * 500 = 2000 (next-tier 3000 would exceed the
//   formula). gitattributes-alignment.md (2330) registers in TIERS.next and
//   platform-adapters/opencode.md (4726) in TIERS.adapter, both without override.
//   model-delegation.md receives a narrower 7000 cap in
//   fix-consumer-source-corpus-routing: the complete 6523-token delegation
//   action-point contract needs ceil((6523 + 250) / 500) * 500 = 7000. This
//   override preserves the Task Outline→tasks.md writer split without granting
//   the broader 7500 core-tier headroom.
//   code-review-cross-model.md 8500 → 9000, platform-adapters/codex-host-
//   cross-review.md 14500 → 15000, and platform-adapters/claude-code-cross-
//   review.md receives a 10000 local bound in fix-consumer-source-corpus-routing.
//   The complete API-only single-authority state machine, current-invocation
//   denial precedence, exact read-back, and lineage-bound successor recovery
//   contracts measure 8439, 14393, and 9442 tokens respectively. Their ordered
//   branches are load-bearing; applying ceil((tokens + 250) / 500) * 500 yields
//   the exact 9000, 15000, and 10000 per-file caps without relaxing siblings.
//   Raised platform-adapters/claude-code-cross-review.md 10000 → 10500,
//   platform-adapters/codex-host-cross-review.md 15000 → 15500, and
//   second-review-control-evidence.md 5500 → 6000 after rebasing
//   fix-focused-range-evidence-capability onto main. The complete typed v4
//   scope/capability, API-only sticky authority, and terminal-evidence contracts
//   measure 10085, 15049, and 5453 tokens; further threshold compression would
//   obscure ordered branches. The exact formulas are ceil((10085 + 250) / 500) *
//   500 = 10500, ceil((15049 + 250) / 500) * 500 = 15500, and
//   ceil((5453 + 250) / 500) * 500 = 6000.
//   Raised platform-adapters/claude-code-cross-review.md 10500 → 11000 while restoring
//   the issue #1728 live-read data-to-argv carve-out: re-adding the validator-checked
//   full-pr positive-decimal and commit-range base/head grant prose (deleted by the
//   issue #1725 over-removal) measures 10551 tokens; ceil((10551 + 250) / 500) * 500 =
//   11000. Compressing the carve-out below the old cap would risk re-introducing the
//   fail-closed misread it documents, so the fuller wording is kept and the narrow
//   per-file cap is lifted instead (READABILITY_CAP_GUARDS mirror stays in lockstep).
//   Raised file-write-destinations.md 3500 → 4000 in
//   fix-cross-review-carrier-add-dir-collision: the canonical cross-review carrier
//   root row plus its owner/TTL cleanup sentence brings the destination table to 3252
//   tokens. Each row is a mutually exclusive "which files may be written here, under
//   what authorization, and who cleans them up" branch, so merging or compressing any
//   two rows costs a destination its independently identifiable stop condition.
//   ceil((3252 + 250) / 500) * 500 = 4000. strengthen-reviewer-writable-root-leanness
//   then added the notes/tmp top-level entry ceiling bullet, measuring 3470 tokens;
//   ceil((3470 + 250) / 500) * 500 = 4000 — the same cap, so it is left unchanged and
//   only this rationale is refreshed rather than left recording a stale 3252.
//   strengthen-pr-1834-followups adds the R2 attempt cleanup owner/action point:
//   test fixtures remove only their exact registered root, while the production
//   owner preserves a whole attempt unless ownership, terminal evidence, and TTL
//   eligibility all hold. The leaf now measures 13930 bytes / 3980 tokens, leaving
//   only 20 tokens above the required 250-token edit headroom under 4000. Its
//   mutually exclusive skip outcomes are operational stop conditions, so they stay
//   identifiable and the cap takes the minimum next bucket instead:
//   ceil((3980 + 250) / 500) * 500 = 4500.
//   Raised second-review-control-evidence.md 6000 → 6500 in
//   fix-publication-transaction-recovery: §1.3 point 4 gains the marker-bound
//   pre-filter obligation (same predicate as the CAS, adopt-before-pre-filter
//   ordering) and point 8 narrows the third state with the two-source orphan
//   recovery authority and its zero-residue precondition. All three readability
//   dimensions FAIL — point 6 is an ordered 1→6 protocol whose sequence lives in
//   the numbering, each sub-clause binds its own fail-closed trigger, and point
//   7/8 now carry a third mutually exclusive branch whose predicates must stay
//   individually identifiable. Compressing any of them would re-introduce the
//   exact misread this change fixes, so the fuller wording is kept and the narrow
//   per-file cap is lifted instead (READABILITY_CAP_GUARDS mirror stays in
//   lockstep). Measured 6026 tokens; ceil((6026 + 250) / 500) * 500 = 6500.
//   Raised code-review-cross-model.md 9000 → 9500 in
//   fix-reviewer-writable-root-exposure: the :111 point 5 family-staging
//   rewrite (Codex recipe drops --add-dir; every family's reviewer sticky body
//   file now lands in the reviewer's own neutral cwd) measured 9016 tokens, over
//   the prior 9000 cap. All three readability-precheck dimensions FAIL — the
//   MUST call sequence is a numbered 1→7 ordered protocol, each sub-clause binds
//   its own fail-closed trigger, and the Codex/Claude safe-mode family split must
//   stay independently identifiable per NFR5 — so compression was rejected and
//   the minimum necessary cap is taken instead: ceil((9016 + 250) / 500) * 500 =
//   9500 (READABILITY_CAP_GUARDS mirror stays in lockstep).
//   strengthen-pr-1827-followups (T2) moves the entire ### External Reviewer CLI
//   Skill Contract section (:137-165, the numbered 1→7 protocol plus timeout
//   policy) out of code-review-cross-model.md into a new sibling
//   code-review-cross-model-cli-contract.md, so this file's composition post-move
//   measures 23302 bytes / 6658 tokens — well under the 9500 cap (70.1%). The
//   9500 override is kept rather than reverted to the 7500 core default: falling
//   back to 7500 would put usage at 88.8%, immediately re-triggering the >=80%
//   mitigation cycle this cap was raised to relieve, and erasing the headroom
//   this move was meant to recover.
//   code-review-cross-model-cli-contract.md receives a 3500 cap in the same
//   change. The moved section is one leaf-self-contained, load-bearing unit (the
//   numbered 1→7 dispatch protocol plus the shared wrapper timeout policy) that
//   D4 requires moving whole rather than re-split across an Overview/When to
//   Use/Process template, so the new leaf mirrors code-review-cross-model.md's
//   own anatomy (frontmatter + H1 + Load-chain + direct ### sections) instead of
//   paying the ~450-token 6-section overhead. Measured 10644 bytes / 3042 tokens
//   after the move — below the architect's 3540-token proposal estimate (which
//   assumed the fuller template), so per token-budget-precheck.md's cap-bucket
//   reconciliation (T4) the formula is applied to the actual count instead of the
//   estimate: ceil((3042 + 250) / 500) * 500 = 3500, not the originally proposed
//   4000 (READABILITY_CAP_GUARDS mirror stays in lockstep).
//   strengthen-pr-1834-followups keeps schema/manifest How in the capability spec
//   and shared validator, while this CLI leaf adds only the R1 linked-issue SSOT
//   pointer and R5 reviewer/material ownership boundary. It now measures 11225
//   bytes / 3208 tokens; ceil((3208 + 250) / 500) * 500 = 3500, so the existing cap
//   remains sufficient with 292 tokens of headroom.
//   Raised platform-adapters/codex-host-cross-review.md 15500 -> 16000 in the same
//   change. The :39/:72/:116 exit-clause removals SHRINK the leaf by 34 bytes to
//   53823 bytes / 15378 tokens, but the >=80% readability precheck triggers on
//   "does this PR touch the carrier", not on "does it grow": at 15378 tokens the
//   minimum necessary cap already exceeded the registered 15500 at the change
//   anchor (15388 tokens), and pre-pr-archive-gate.mjs requires mitigation (d) to
//   record exactly smallestPracticalReadabilityCap. All three dimensions FAIL --
//   the render -> probe -> runner -> spawn -> sticky-verify projection lifecycle is
//   strictly ordered (extra/missing/reordered activity events fail closed), every
//   typed fault binds its own pre-spawn or terminal stop condition, and the
//   full-pr/commit-range material matrix, pr-sticky/audit-only mode split and
//   callback/no-callback wait strategy must stay individually identifiable. So
//   compression is rejected and the minimum necessary cap is taken instead:
//   ceil((15378 + 250) / 500) * 500 = 16000 (READABILITY_CAP_GUARDS mirror stays
//   in lockstep).
//   strengthen-pr-1827-followups touches both adapter files again for an
//   unrelated consistency fix (T12 repo-wide scan): claude-code-cross-review.md
//   gets no content change relevant to this PR's diff beyond a 1-line heading
//   repoint (code-review-cross-model.md -> code-review-cross-model-cli-contract.md,
//   part of the same change's S6 anchor-move) and stays at 37347 bytes / 10671
//   tokens, still exactly the registered 11000 cap's minimum necessary value, so
//   no bump. codex-host-cross-review.md's recipe block gains a `--carrier-root`
//   flag plus a 2-line comment explaining the renderer-allocated attempt_id
//   directory contract, growing it to 55205 bytes / 15773 tokens -- only 227
//   tokens under the registered 16000 cap, below the 250-token minimum edit
//   headroom this system requires. Same three dimensions FAIL for the same
//   reasons as the 16000 raise above (ordered projection lifecycle, per-fault
//   stop conditions, full-pr/commit-range + pr-sticky/audit-only + wait-strategy
//   splits must stay independently identifiable), so compression is rejected
//   again and the cap is raised to the next minimum necessary value instead:
//   ceil((15773 + 250) / 500) * 500 = 16500 (READABILITY_CAP_GUARDS mirror stays
//   in lockstep).
//   test-performance-patterns.md 3000 → 3500 in
//   refactor-test-performance-patterns-headroom (close #1873): the spawn-pattern
//   leaf measures 10477 bytes / 2994 tokens (99.8% of the next-tier default).
//   Three-branch corollary evaluation rejects (1) 拆檔 — (a)–(e) are not
//   mutually exclusive A/B paths and common spawn paths need (a)–(d) together;
//   splitting would force leaf→leaf chains — and (2) hard trim — chasing
//   util<80%@3000 needs ~594 tok cut while PATTERN_LEAF_PHRASES locks titles /
//   mechanisms / STOP / fail-open. Branch (3) 提 cap is selected. Cap formula:
//   ceil((2994 + 250) / 500) * 500 = 3500. 4000 is forbidden (above-formula);
//   promoting into TIERS.core is forbidden (trigger-loaded next routing stays
//   correct; core headroom would be surplus). Post-raise util≈85.5% stays ≥80%
//   so semanticReview=required remains an accepted advisory outcome — chasing
//   <80% would require the forbidden 4000 bucket or hard-trimming anchored
//   semantics. Distinct from Hot-Entry Cap Governance (that requirement froze
//   a change that forbade raising the entry cap); this leaf uses the 守則 4
//   corollary / formula last-resort path instead. Only this leaf gets the
//   override+guard=3500 pair; sibling next-tier leaves keep the 3000 guard.
//   Raised second-review-control-evidence.md 6500 → 7000 in
//   strengthen-second-review-audit-convergence: T1 adds the
//   host_session_limit_stop classification clause to the audit-methodology
//   contract, measuring 22907 bytes. Applying the standard token estimate
//   ceil(22907 / 3.5) = 6545 tokens, over the prior 6500 cap. Bytes-to-token
//   conversion uses BYTES_PER_TOKEN = 3.5; the smallest round bound with the
//   mandatory 250-token edit headroom is ceil((6545 + 250) / 500) * 500 = 7000
//   (READABILITY_CAP_GUARDS mirror stays in lockstep).
//   strengthen-requirements-clarification-contract raises three caps for the
//   propose-and-confirm / Scenario Ledger / high-risk taxonomy contract (owner
//   readability over threshold-fitting compression; READABILITY_CAP_GUARDS
//   lockstep):
//   - openspec-quality-and-formats.md 7800 → 8500: Scenario Ledger Current
//     Requirement / conditional Initiator·Affected / Non-goals escape ban /
//     risk_classes recording measured 8219 tokens;
//     ceil((8219 + 250) / 500) * 500 = 8500. Stay core; do not raise tier.
//   - openspec-quality-and-formats.md 8500 → 9500 in add-change-governance-guardrails:
//     Material Semantic Carrier Group Scope Stop-Loss additive contract measured
//     8770 tokens after compression; ceil((8770 + 250) / 500) * 500 = 9500.
//     Stay core; owner-readability over threshold-fitting compression.
//   - openspec-quality-and-formats.md 9500 → 10000 in refactor-scope-change-leaf
//     (decisions D2, owner decision): measured 9725 tokens after three splits;
//     ceil((9725 + 250) / 500) * 500 = 10000. Utilization is about 97%, so
//     semanticReview=required is an accepted advisory outcome: the kept entry text
//     is load-bearing and the owner chose not to trim it. The Rule-feedback Surface
//     Matrix section (about 400 tokens) remains splittable; split it before any
//     further raise, and do not use a bucket above the formula.
//   - Governance split-dedup-review 2026-10-10 (owner decision): three single-purpose
//     files that fail the split gate or have no splittable part within reach, and no
//     unlocked redundancy, move to the formula cap ceil((N + 250) / 500) * 500:
//     code-review-cross-model.md 11500 → 13000 (12363), design-core.md 10000 → 10500
//     (10018), ambiguity-scoring.md 4500 → 5500 (4808). Per-file reasons sit beside
//     each PER_FILE_MAX_OVERRIDE entry. No rule text changed. All three stay at or
//     above 80% utilization (about 95.1%, 95.4%, 87.4%), so semanticReview=required is an
//     accepted advisory outcome: the formula bucket is the ceiling, and getting under 80%
//     would need an above-formula cap or a hard trim of the locked text listed per file.
//   - Governance split-dedup-review 2026-10-10, second batch (owner decision): five files
//     that cannot be split under lite rigor (the splittable part is too small, or is named
//     by a spec and needs its own OpenSpec change) and have no unlocked redundancy move
//     to the formula cap: ai-autonomy.md 10000 → 11500 (10900), code-review-checklist.md
//     13000 → 14500 (14225), workflow-cost-controls.md 3500 → 5000 (4359),
//     proposal-template.md 3000 → 4500 (3979), rules-rigor-level.md 3000 → 4000 (3394).
//     Per-file reasons sit beside each PER_FILE_MAX_OVERRIDE entry. No rule text changed.
//     All five stay at or above 80% utilization (about 94.8%, 98.1%, 87.2%, 88.4%, 84.9%),
//     so semanticReview=required is an accepted advisory outcome for the same reason: an
//     above-formula cap is forbidden and the remaining text is spec- or test-locked.
//   - Governance split-dedup-review 2026-10-10, third batch (owner decision):
//     platform-adapters/codex-host-cross-review.md 16500 → 18500 (18004). The only part
//     large enough to split is the byte-locked system-prompt mirror. No rule text changed.
//     Utilization stays about 97.3%, so semanticReview=required is an accepted advisory
//     outcome: an above-formula cap is forbidden and the mirror is a runtime payload.
//   - update-spec-pinned-rule-caps (owner decision 2026-10-10): the two leaves whose cap
//     the token-budget-tooling spec pins by name move to the current formula value.
//     test-performance-patterns.md 4500 → 5500: measured 4777 tokens;
//     ceil((4777 + 250) / 500) * 500 = 5500. 6000 is forbidden (above-formula).
//     Utilization stays about 86.9%, so semanticReview=required remains an accepted
//     advisory outcome: getting under 80% would need an above-formula cap or a hard trim
//     of anchored pattern text. release-rules-lane.md 4500 → 5500: measured 5175 tokens;
//     ceil((5175 + 250) / 500) * 500 = 5500. 6000 is forbidden (above-formula).
//     Utilization stays about 94.1%, so semanticReview=required remains an accepted
//     advisory outcome here too: even 6000 would leave it at about 86.3%, so getting under
//     80% would need a cap two buckets above the formula or a hard trim of the recipe that
//     is copy-pasted as written. Split and hard trim stay rejected for both (see the
//     PER_FILE_MAX_OVERRIDE notes). Both stay next-tier. No rule text changed.
//   - update-token-cap-scenarios-to-formula (2026-10-11): the spec scenarios for these two
//     leaves now state the formula instead of the computed number. The assertions below pin
//     each cap next to the token count measured when it was registered (4777 and 5175) and
//     check the cap against the formula of that count. They do not re-measure the live file:
//     growth inside or past the cap stays a soft warning owned by rule governance
//     (token-budget-tooling "Ordinary-PR Cap Soft Gate And Governance Ownership"), so an
//     ordinary edit to either leaf cannot turn this file red. No cap value changed.
//   - refactor-test-suite-cadence-leaf (owner decision 2026-10-11): test-suite-cadence.md
//     is a new next-tier Load-chain leaf holding the test suite cadence section moved
//     verbatim out of testing-and-qa.md. Measured 4394 tokens;
//     ceil((4394 + 250) / 500) * 500 = 5000. 5500 is forbidden (above-formula).
//     Utilization stays about 87.9%, so semanticReview=required is an accepted advisory
//     outcome: getting under 80% would need the above-formula 5500 bucket or a trim of
//     the moved text, which must stay byte-identical to its pre-move source. Splitting
//     the leaf in two stays rejected (see the PER_FILE_MAX_OVERRIDE note).
//     The moved text is unchanged. testing-and-qa.md kept its 9000 override in that change;
//     a follow-up removed the override and guard: the file measures 6956 tokens and
//     ceil((6956 + 250) / 500) * 500 = 7500 is the core tier default. Utilization is about
//     92.7%, so semanticReview=required is an accepted advisory outcome: the remaining
//     sections were checked for verbatim duplicates before the split and none were found,
//     and a cap above the formula value is forbidden.
//   - refactor-suite-exclusivity-to-cadence-leaf (owner decision 2026-10-11): the gate／
//     release suite exclusivity section moved verbatim from test-performance-patterns.md to
//     test-suite-cadence.md. test-performance-patterns.md 5500 → 5000: measured 4587 tokens;
//     ceil((4587 + 250) / 500) * 500 = 5000, so 5500 is now above-formula and forbidden.
//     test-suite-cadence.md stays 5000: measured 4705 tokens;
//     ceil((4705 + 250) / 500) * 500 = 5000. Utilization is about 91.7% and 94.1%, so
//     semanticReview=required is an accepted advisory outcome for both: getting under 80%
//     would need an above-formula cap or a hard trim of grep-locked pattern text and of
//     moved text that must stay byte-identical to its source. Both stay next-tier.
//   - refactor-consumer-pre-pr-checks-leaf (owner decision 2026-10-11):
//     consumer-pre-pr-checks.md is a new next-tier Load-chain leaf holding the consumer
//     pre-PR checks contract moved verbatim out of consumer-local-rules.md, together with
//     the exit criterion, rationalization rows and verification commands that sat outside
//     the section. Measured 5533 tokens; ceil((5533 + 250) / 500) * 500 = 6000. 6500 is
//     forbidden (above-formula). Utilization stays about 92.2%, so semanticReview=required
//     is an accepted advisory outcome: getting under 80% would need the above-formula
//     6500 bucket or a trim of the moved text, which must stay byte-identical to its
//     pre-move source. Splitting the leaf further stays rejected (see the
//     PER_FILE_MAX_OVERRIDE note). consumer-local-rules.md measures 1134 tokens after the
//     move and stays on the small-tier 1500 default with no override. No other cap changed.
//   - stop-point-comms.md receives 4000: 規則 5 plain-language options +
//     recommended rationale beside the option + ban empty「為什麼有推薦」
//     measured 3364 tokens; ceil((3364 + 250) / 500) * 500 = 4000. Stay next.
//   - preflight-checklist.md 3000 → 3500: clarification-contract pointers
//     measured 3194 tokens; ceil((3194 + 250) / 500) * 500 = 3500. Stay next.
//   - preflight-checklist.md 3500 → 4000 in add-already-live-backfill-record: the two non-urgent
//     already-live backfill copies each end with the fixed lite pointer; measured 3539 tokens;
//     ceil((3539 + 250) / 500) * 500 = 4000. Stay next.
//   strengthen-rule-token-budget-caps raises 13 leaves after the
//   devpro:rule-governance convergence-loop audit found them over cap. Of those
//   13, 7 (code-review-checklist.md, test-performance-patterns.md,
//   ai-autonomy.md, post-pr-completion-gate.md, ambiguity-scoring.md,
//   file-write-destinations.md, platform-adapters/claude-code-cross-review.md)
//   already carried a PER_FILE_MAX_OVERRIDE; git-archaeology on each of
//   those 7 overrides' introduction commit confirmed every one crossed the
//   100% fail boundary genuinely after its override was set (85.5%-99.5%
//   utilization at set-time, all below 100%) — re-armed evidence, not a
//   stale/already-known state re-triggering the same static threshold. The
//   remaining 6 (security-access-audit-trail.md, testing-and-qa.md,
//   database-conventions.md, code-review-checklist-fallback.md,
//   agent-skill-governance.md, program-tracker-mode.md) had no prior
//   override at all — they sat at their unmodified tier default, so this
//   is their first-ever override registration, not a re-arm. Source read
//   confirmed all 15 leaves (13 raised + 2 newly
//   registered) are load-bearing, single-topic content with no A/B
//   mutually-exclusive branch and no 70%-common-path subset, so the split
//   gate fails 三題 and cap-raise via the existing
//   ceil((actual + 250) / 500) * 500 formula is the correct disposition:
//   - code-review-checklist.md 8500 → 10000: measured 9724 tokens;
//     ceil((9724 + 250) / 500) * 500 = 10000.
//   - security-access-audit-trail.md receives a new 4000 override+guard pair
//     (was unregistered in PER_FILE_MAX_OVERRIDE, default next-tier 3000
//     applied): measured 3586 tokens; ceil((3586 + 250) / 500) * 500 = 4000.
//   - test-performance-patterns.md 3500 → 4500: measured 3932 tokens;
//     ceil((3932 + 250) / 500) * 500 = 4500.
//   - testing-and-qa.md receives a new 9000 override+guard pair (was
//     unregistered, default core-tier 7500 applied): measured 8325 tokens;
//     ceil((8325 + 250) / 500) * 500 = 9000.
//   - database-conventions.md receives a new 4000 override+guard pair (was
//     unregistered, default next-tier 3000 applied): measured 3314 tokens;
//     ceil((3314 + 250) / 500) * 500 = 4000.
//   - code-review-checklist-fallback.md receives a new 3500 override+guard
//     pair (was unregistered, default next-tier 3000 applied): measured
//     3142 tokens; ceil((3142 + 250) / 500) * 500 = 3500.
//   - ai-autonomy.md 9000 → 10000: measured 9316 tokens;
//     ceil((9316 + 250) / 500) * 500 = 10000.
//   - post-pr-completion-gate.md 5500 → 6000: measured 5629 tokens;
//     ceil((5629 + 250) / 500) * 500 = 6000.
//   - ambiguity-scoring.md 3500 → 4000: measured 3550 tokens;
//     ceil((3550 + 250) / 500) * 500 = 4000.
//   - file-write-destinations.md 4500 → 5000: measured 4539 tokens;
//     ceil((4539 + 250) / 500) * 500 = 5000.
//   - agent-skill-governance.md receives a new 3500 override+guard pair (was
//     unregistered, default next-tier 3000 applied): measured 3014 tokens;
//     ceil((3014 + 250) / 500) * 500 = 3500.
//   - platform-adapters/claude-code-cross-review.md 11000 → 11500: measured
//     11045 tokens; ceil((11045 + 250) / 500) * 500 = 11500.
//   - program-tracker-mode.md receives a new 3500 override+guard pair (was
//     unregistered, default next-tier 3000 applied): measured 3018 tokens;
//     ceil((3018 + 250) / 500) * 500 = 3500.
//   All READABILITY_CAP_GUARDS mirrors stay in lockstep with the
//   PER_FILE_MAX_OVERRIDE values above. The same change registers
//   rule-self-evolution.md and workflow-cost-controls.md into
//   TIERS.next.files — both were referenced by AGENTS.md's 觸發式載入索引 but
//   had never been registered in any tier. They measure 1700 and 1890
//   tokens respectively, well under the 3000 next-tier default, so no
//   override is needed for either.
//
// R-note (strengthen-subagent-delegation-strategy, decisions.md D40/D41): the
//   round-6 six-axis review found the change had pushed three carriers over
//   cap. Every figure below is measured against the change anchor 10bc573f, not
//   against the previous commit -- "already over before this round" was the
//   round-6 mis-attribution this note exists to prevent. Mitigation order from
//   token-budget-precheck.md was applied per file; split was rejected for both
//   raises (the added sentences are operative clauses of a ladder / cap table
//   whose only entry pointer lives in that same leaf) and trim was rejected
//   (both are held by polarity-bound grep tests, and shortening one to save
//   bytes is what produced F-r6-evaluation-face-clause-drops-new-qualifier), so
//   the remaining overage took the min-necessary-cap formula:
//   - workflow-cost-controls.md receives a new 3500 override+guard pair. The
//     earlier R-note above registered it into TIERS.next.files with no
//     override; that "no override is needed" describes only the state at that
//     change. At anchor it measured 2082 tokens (69.40% of the 3000 next-tier
//     default), at HEAD 3111 tokens;
//     ceil((3111 + 250) / 500) * 500 = 3500.
//   - multi-agent-handoff.md 8000 -> 8500: anchor 7799 tokens (97.49%), HEAD
//     8026 tokens; ceil((8026 + 250) / 500) * 500 = 8500.
//   READABILITY_CAP_GUARDS mirrors stay in lockstep with both.
//   AGENTS.md crossed its byte-governed line in the same change (8677 -> 8778
//   bytes against the 8750 HARD) and is deliberately NOT raised and NOT
//   trimmed: agents-md-maintenance.md fixes 8750 as a soft-warn / governance
//   observation point the ordinary path does not fail closed on, and forbids
//   deleting an existing routing synonym to save bytes -- which is the change's
//   only edit to that file. It is recorded as a governance accepted finding and
//   has no PER_FILE_MAX_OVERRIDE entry to keep in sync.
//   Superseded by amend-agents-md-hard-cap: the carrier kept growing (8815
//   bytes) and the 2026-10-14 rule audit took the accepted finding to the
//   min-necessary-cap formula, ceil((8815 + 875) / 1750) * 1750 = 10500; the
//   rationale lives next to the constant in agents-md-size.test.mjs.
//   This comment block is the third carrier that token-budget-precheck.md's
//   min-necessary-cap SSOT requires alongside the registry and the guard table.
//   It has no mechanical guard of its own, so a cap change that skips it fails
//   silently; D41 records why a comment-vs-registry assertion was not added.
//
// R-note (strengthen-subagent-delegation-strategy, decisions.md D15): the P0
//   rule text landed the Executor 決策序 (steps 0-5) in model-delegation.md, the
//   outcome-mandatory / fresh-trigger role rewrite in
//   model-delegation-delegation-rules.md and the six-field admission record in
//   model-delegation-briefing.md. Mitigation order from token-budget-precheck.md
//   was followed before touching any cap: the thread-lifecycle and caps tables
//   moved out of the entry leaf into the new sibling
//   model-delegation-threads-and-caps.md, duplicated sentences were trimmed,
//   then the remaining overage took the min-necessary-cap formula:
//   - model-delegation.md 7000 → 8000: measured 7739 tokens;
//     ceil((7739 + 250) / 500) * 500 = 8000.
//   - model-delegation-delegation-rules.md receives a new 4000 override+guard
//     pair (next-tier 3000 applied before): measured 3500 tokens;
//     ceil((3500 + 250) / 500) * 500 = 4000.
//   - model-delegation-briefing.md receives a new 3500 override+guard pair
//     (next-tier 3000 applied before). It first landed at 4000 from a
//     3742-token measurement (c229343b); the round-1 duplicate-front-matter
//     repair then re-measured the faithful carrier at 3225 tokens, so dfa82656
//     lowered registry and guard to ceil((3225 + 250) / 500) * 500 = 3500. The
//     leaf later grew to 3555 tokens, where the formula would hand back the
//     superseded 4000. refactor-delegation-briefing-leaf replaced its
//     dp-architect immutable dispatch block, a copy of model-delegation.md and
//     multi-agent-handoff.md text, with one routing line; it now measures 3236
//     tokens and ceil((3236 + 250) / 500) * 500 = 3500 matches the cap again.
//   READABILITY_CAP_GUARDS mirrors stay in lockstep. The same change registers
//   model-delegation-token-efficiency.md (~1721 tokens; previously unregistered,
//   1500 fallback) and the new model-delegation-threads-and-caps.md (~1877
//   tokens) into TIERS.next.files; both sit under the 3000 next-tier default,
//   so no override is needed for either.
// 2026-10 over-cap pass, second batch. Four single-trigger leaves with no
//   conditional section to split move to their formula cap
//   ceil((tokens + 250) / 500) * 500: stop-point-comms.md 4000 → 4500 (4225 after
//   removing a background paragraph and four same-file restatements),
//   code-review-checklist-fallback.md 3500 → 4500 (3800),
//   code-review-cross-model-cli-contract.md 3500 → 4500 (3812),
//   model-delegation-delegation-rules.md 4000 → 4500 (4161). Seven other over-cap
//   leaves were left at their caps on purpose: an audit-only cross-model review
//   found conditional sections in each that must be evaluated for a split first.
// R-note (fix-review-dispatch-gaps, decisions.md D5): R1 landed the
//   `### Bounded Rereview Manifest Production` section in code-review-checklist.md
//   (manifest field meanings, the three-layer digest, and the
//   seal-manifest/verify-manifest request shapes) plus its new grep guard
//   bounded-rereview-manifest-production-grep.test.mjs. The section is the
//   change's only operator-grade carrier for producing a durable manifest, so
//   trim was rejected exactly as on this file's earlier raises (every field
//   line is literally bound to core schema/CLI tokens by that guard), and the
//   overage took the min-necessary-cap formula: measured 12324 tokens
//   (43134 bytes / 3.5); ceil((12324 + 250) / 500) * 500 = 13000. The
//   READABILITY_CAP_GUARDS mirror moved in lockstep and the pinned assertion
//   below carries the same measurement.
// R-note (add-consumer-second-review-rules): code-review-cross-model.md 13000 → 13500.
//   The `#### Consumer 審查規則（second-review-rules.local.md）` subsection is the single
//   contract for the consumer rules file; it was trimmed to the sentences a reader needs
//   to act, and the file then measured 13238 tokens (46331 bytes / 3.5), over 13000.
//   ceil((13238 + 250) / 500) * 500 = 13500. The READABILITY_CAP_GUARDS mirror moved in
//   lockstep and the pinned formula assertion below carries the same measurement.
//   Later commits of the same change added five clauses to the contract (+447 bytes);
//   the post-PR second review added the PII or secret pattern stop (+93 bytes);
//   the file is 13392 tokens (46871 bytes), still inside 13500, so the cap did not move.
//   amend-consumer-local-rules-as-markdown rewrote the contract for a free-form markdown file;
//   the file is 13386 tokens (46851 bytes), still inside 13500, so the cap did not move again.
// R-note (refactor-cross-model-review-leaf): code-review-cross-model.md 13500 → 12000.
//   Later edits grew it to 14159 tokens (105%). The script-enforced dispatch contracts
//   moved verbatim to code-review-cross-model-dispatch-mechanics.md (4127 tokens, next
//   tier, cap ceil((4127 + 250) / 500) * 500 = 4500); the remainder measures 11574 tokens
//   (40508 bytes / 3.5), so ceil((11574 + 250) / 500) * 500 = 12000. Both guards moved in
//   lockstep with the pinned formula table below.
// R-note (rationalize-rule-token-caps, rule-governance audit 2026-11-07 item 8): fifteen
//   over-cap leaves move to the formula cap ceil((tokens + 250) / 500) * 500. Six already
//   had an override whose split/trim rejection stands: code-review-checklist.md
//   14500 → 16000 (15710), multi-agent-handoff.md 8500 → 9000 (8610), testing-and-qa.md
//   8000 → 8500 (8097), session-pending-lifecycle.md 4500 → 5000 (4590),
//   agent-skill-governance.md 3500 → 4500 (3864), change-consequence-assessment.md
//   2000 → 2500 (2014). Nine had no recorded disposition; each was checked for the split
//   gate and for lines carried elsewhere first, then got a new override+guard pair:
//   environment-setup-nvm-nodejs-openspec.md 4000 (3676), consumer-failure-playbook.md
//   2500 (1793), openspec-archive-principles.md 4000 (3528), review-guarantee-ceiling.md
//   2000 (1718), pre-implementation-over-design.md 4000 (3287),
//   second-review-external-evaluator.md 4000 (3267), troubleshooting.md 3500 (3074),
//   rules-flow.md 8000 (7511) and design-template.md 2000 (1516; now registered in
//   TIERS.small). The per-file reasons sit beside each override in the lib.
//   design-core.md stays at 10500 and over it: the owner declined the §7–§11 split
//   (spec-pinned, rarely loaded), recorded beside its override.
// ── T1: collectOffsetCandidates ──────────────────────────────────────────────
// Deterministic scan of a markdown body for sections that are candidates for
// compression.  Returns [{line, heading, feature}] where:
//   line    – 1-based line number of the triggering line
//   heading – nearest heading above (or "<top-level>" if none)
//   feature – short description of which heuristic fired
//
// Three heuristics (thresholds fixed here and pinned by unit tests):
//   1. long-paren  – a single line contains paren-enclosed content ≥ 80 chars
//      (full-width 「（）」or ASCII parentheses)
//   2. repeated-crossref – the same `<file>.md` backtick pattern appears ≥ 3
//      times across the whole body
//   3. near-duplicate-bullet – adjacent bullet lines share ≥ 60% of their
//      whitespace-tokenised words (case-insensitive)
//
// Same input → same output; no Date.now / Math.random.
function collectOffsetCandidates(filename, body) {
  const LONG_PAREN_THRESHOLD = 80;   // chars inside parens (inclusive)
  const CROSSREF_MIN_OCCURRENCES = 3; // repeat count to trigger
  const BULLET_OVERLAP_RATIO = 0.6;  // fraction of shared tokens to trigger

  const rawLines = body.split("\n");
  const candidates = [];

  // Track current heading for context
  let currentHeading = "<top-level>";

  // ── heuristic 2 pre-pass: count backtick `*.md` occurrences ────────────
  const crossrefCounts = new Map(); // filename → [{line}]
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    // Match `something.md` (backtick-quoted md filename)
    const matches = line.matchAll(/`([A-Za-z0-9._-]+\.md)`/g);
    for (const m of matches) {
      const ref = m[1];
      if (!crossrefCounts.has(ref)) crossrefCounts.set(ref, []);
      crossrefCounts.get(ref).push(i + 1); // 1-based
    }
  }

  // Build a set of lines that already triggered crossref (to avoid duplicates)
  const crossrefViolatingRefs = new Set();
  for (const [ref, lines] of crossrefCounts.entries()) {
    if (lines.length >= CROSSREF_MIN_OCCURRENCES) {
      crossrefViolatingRefs.add(ref);
    }
  }

  // Track which lines are already emitted for crossref to avoid duplicates
  const emittedCrossrefLines = new Set();

  // ── main pass ────────────────────────────────────────────────────────────
  let prevBulletLine = null; // {lineNo, text, tokens}

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const line = rawLines[i];

    // Update current heading
    if (/^#{1,6}\s/.test(line)) {
      currentHeading = line.replace(/^#+\s+/, "").trim();
      prevBulletLine = null; // reset adjacent-bullet tracking on heading change
    }

    // ── heuristic 1: long-paren ─────────────────────────────────────────
    // Match ASCII parens content or full-width （） content
    const parenMatch =
      line.match(/\(([^)]{80,})\)/) || line.match(/（([^）]{40,})）/);
    if (parenMatch) {
      // For full-width, threshold is 40 chars (roughly 80 bytes)
      const inner = parenMatch[1];
      const isFw = line.includes("（");
      const threshold = isFw ? 40 : LONG_PAREN_THRESHOLD;
      if (inner.length >= threshold) {
        candidates.push({
          line: lineNo,
          heading: currentHeading,
          feature: `long-paren (${inner.length} chars)`,
        });
      }
    }

    // ── heuristic 2: repeated cross-ref ─────────────────────────────────
    const crossMatches = line.matchAll(/`([A-Za-z0-9._-]+\.md)`/g);
    for (const m of crossMatches) {
      const ref = m[1];
      if (crossrefViolatingRefs.has(ref) && !emittedCrossrefLines.has(lineNo)) {
        candidates.push({
          line: lineNo,
          heading: currentHeading,
          feature: `repeated-crossref \`${ref}\` (${crossrefCounts.get(ref).length} occurrences)`,
        });
        emittedCrossrefLines.add(lineNo);
        break; // one candidate per line
      }
    }

    // ── heuristic 3: near-duplicate adjacent bullet ──────────────────────
    const bulletMatch = line.match(/^(\s*[-*+]|\s*\d+\.)\s+(.+)/);
    if (bulletMatch) {
      const bulletText = bulletMatch[2].toLowerCase();
      const bulletTokens = new Set(bulletText.split(/\s+/).filter(Boolean));

      if (prevBulletLine !== null) {
        const prevTokens = prevBulletLine.tokens;
        // overlap = intersection size / union size (Jaccard)
        let intersect = 0;
        for (const t of bulletTokens) {
          if (prevTokens.has(t)) intersect++;
        }
        const union = bulletTokens.size + prevTokens.size - intersect;
        const ratio = union > 0 ? intersect / union : 0;

        if (ratio >= BULLET_OVERLAP_RATIO) {
          // Emit for current line (the second of the pair)
          candidates.push({
            line: lineNo,
            heading: currentHeading,
            feature: `near-duplicate-bullet (${Math.round(ratio * 100)}% overlap with line ${prevBulletLine.lineNo})`,
          });
        }
      }

      prevBulletLine = { lineNo, text: bulletText, tokens: bulletTokens };
    } else if (!/^\s*$/.test(line) && !/^(\s*[-*+]|\s*\d+\.)/.test(line)) {
      // Non-blank, non-bullet line resets adjacency (table rows, headings, etc.)
      // But only reset if it is not just whitespace
      if (!/^\s+$/.test(line)) {
        prevBulletLine = null;
      }
    }
  }

  return candidates;
}

// ── T6: compressionDiffReport ────────────────────────────────────────────────
// Deterministic helper: given a before/after body pair for a single file,
// returns an object with:
//   netTokenDelta  – integer (negative = compression savings)
//   affectedSections – string[] of heading names whose content changed
//
// Token estimate uses the same formula as the main budget check:
//   Math.ceil(bytes / BYTES_PER_TOKEN)
//
// "bytes" is measured as Buffer.byteLength(body, 'utf8') for accuracy.
// "Affected section" = a heading whose body text differs between before/after.
function compressionDiffReport(beforeBody, afterBody) {
  const beforeTokens = Math.ceil(Buffer.byteLength(beforeBody, "utf8") / BYTES_PER_TOKEN);
  const afterTokens = Math.ceil(Buffer.byteLength(afterBody, "utf8") / BYTES_PER_TOKEN);
  const netTokenDelta = afterTokens - beforeTokens;

  // Split into sections by heading
  function extractSections(body) {
    const sections = new Map(); // heading → content
    let currentHeading = "<top-level>";
    let currentLines = [];
    for (const line of body.split("\n")) {
      if (/^#{1,6}\s/.test(line)) {
        sections.set(currentHeading, currentLines.join("\n"));
        currentHeading = line.replace(/^#+\s+/, "").trim();
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }
    sections.set(currentHeading, currentLines.join("\n"));
    return sections;
  }

  const beforeSections = extractSections(beforeBody);
  const afterSections = extractSections(afterBody);

  const allHeadings = new Set([...beforeSections.keys(), ...afterSections.keys()]);
  const affectedSections = [];
  for (const heading of allHeadings) {
    const before = beforeSections.get(heading) ?? "";
    const after = afterSections.get(heading) ?? "";
    if (before !== after) {
      affectedSections.push(heading);
    }
  }

  return { netTokenDelta, affectedSections };
}

const findTier = (filename) => {
  const policy = findRuleTokenTier(
    filename === "AGENTS.md" ? filename : `.devpro/agent-rules/${filename}`
  );
  return { name: policy.name === "unregistered" ? "small (fallback)" : policy.name, max: policy.cap };
};

// Format an actionable tier-violation message that branches by tier of origin.
// Per issue #708: prior single-line message hid the next/core tier paths +
// rationale comment template, forcing trial-and-error. Per cross-model round-1
// finding: the message must also differ by tier-of-origin — a `next`-tier leaf
// over 3000 tokens cannot remediate by「register in next」(already there), and
// a `core`-tier leaf over 7500 tokens cannot remediate by registering at all.
//
// Branches:
//   fallback / small → compress OR promote to next OR promote to core
//   next             → compress OR justify promotion to core
//   core             → compress OR split leaf into multiple smaller leaves
//
// Optional `body` string: when provided, appends an "Offset candidates" block
// listing sections that may be candidates for compression (advisory only).
function formatTierViolation(filename, tokens, tier, body) {
  const header = `${filename}: ${tokens} tokens / ${tier.max} max (tier "${tier.name}")`;
  const footer = `See .devpro/agent-rules/rule-file-template.md § Token Budget Tier Registration for tier judgment criteria.`;
  const lines = [header, ``, `Options:`];

  const isSmallOrFallback = tier.name === "small" || tier.name === "small (fallback)";
  const isNext = tier.name === "next";
  const isCore = tier.name === "core";

  if (isSmallOrFallback) {
    lines.push(
      `  1. Compress to ≤ ${TIERS.small.maxTokens} tokens (stay in small tier; default for terse routing / config leaves).`,
      `  2. Register in \`next\` tier (${TIERS.next.maxTokens} max) — edit .devpro/scripts/lib/rule-token-budget.mjs`,
      `     Add to \`TIERS.next.files\` with a rationale comment, e.g.:`,
      `       // <promotion-reason>: <leaf-purpose> (~<token>/${TIERS.next.maxTokens} cap)`,
      `       "${filename}",`,
      `  3. Register in \`core\` tier (${TIERS.core.maxTokens} max) — only for hot-path SSOT (e.g. /dp:change 必讀 routing, anchor SSOT).`
    );
  } else if (isNext) {
    lines.push(
      `  1. Compress to ≤ ${TIERS.next.maxTokens} tokens (stay in next tier).`,
      `  2. Promote to \`core\` tier (${TIERS.core.maxTokens} max) — only if this leaf is hot-path SSOT (/dp:change 必讀 routing, anchor SSOT) and expected to keep growing.`,
      `     Move "${filename}" from \`TIERS.next.files\` to \`TIERS.core.files\` with a rationale comment, e.g.:`,
      `       // <promotion-reason>: <leaf-purpose> (~<token>/${TIERS.core.maxTokens} cap)`
    );
  } else if (isCore) {
    lines.push(
      `  1. Compress to ≤ ${TIERS.core.maxTokens} tokens.`,
      `  2. Split this leaf — extract one sub-topic into a new leaf (see rule-design-principles.md split criteria). No higher tier exists.`
    );
  }

  lines.push(``, footer);

  // ── T2: append Offset candidates block (over-cap path only) ─────────────
  if (body !== undefined) {
    const candidates = collectOffsetCandidates(filename, body);
    lines.push(``);
    lines.push(`Offset candidates (候選 ≠ 一定可砍 — advisory only):`);
    if (candidates.length === 0) {
      lines.push(`  (none detected by heuristics)`);
    } else {
      for (const c of candidates) {
        lines.push(`  L${c.line} [${c.heading}] ${c.feature}`);
      }
    }
  }

  return lines.join("\n");
}

describe("agent-rules token budget", () => {
  it("Codex active adapter stays under hot-path budget and lazy-loads cold leaves", async () => {
    const filename = "platform-adapters/codex.md";
    const filePath = path.join(rulesDir, filename);
    const body = await fs.readFile(filePath, "utf8");
    const tokens = Math.ceil(Buffer.byteLength(body, "utf8") / BYTES_PER_TOKEN);
    const coldLeaves = [
      "platform-adapters/codex-github-writes.md",
      "platform-adapters/codex-cli-tooling.md",
      "platform-adapters/codex-workflow-capabilities.md",
      "platform-adapters/codex-host-cross-review.md",
      "platform-adapters/codex-effort-tiers.md",
    ];

    assert.ok(
      tokens <= CODEX_HOT_PATH_MAX_TOKENS,
      `${filename}: ${tokens} tokens / ${CODEX_HOT_PATH_MAX_TOKENS} hot-path max; move cold detail to Load-chain siblings`
    );
    assert.match(body, /### Action-based Load Chain/);
    assert.match(body, /唯讀不載 GitHub-write／reviewer CLI／workflow capability／post-PR leaves/);
    for (const leaf of coldLeaves) {
      assert.ok(body.includes(leaf), `${filename} must reference lazy-load leaf ${leaf}`);
    }
  });

  it("applies a justified per-file cap override to a small fallback leaf", () => {
    assert.deepEqual(
      findTier("platform-adapters/codex-host-cross-review-troubleshooting.md"),
      { name: "small (fallback)", max: 2500 }
    );
  });

  it("each file within Tiered budget per D3", async () => {
    // Top-level leaves keyed by basename; platform-adapters/*.md keyed by
    // `platform-adapters/<name>.md` relative path (issue #1200 FB#3: previously
    // unscanned subdirectory). findTier matches both because adapter tier files
    // use the same relative-path keys. Key MUST use a literal forward slash (not
    // path.join, which yields `\` on Windows) so the key matches the adapter tier
    // list on every platform; fs reads below re-join with path.join for the OS.
    const topLevel = (await fs.readdir(rulesDir)).filter(f => f.endsWith(".md"));
    const adapterDir = path.join(rulesDir, "platform-adapters");
    const adapterFiles = (await fs.readdir(adapterDir))
      .filter(f => f.endsWith(".md"))
      .map(f => `platform-adapters/${f}`);
    const files = [...topLevel, ...adapterFiles].sort();
    const lines = [];
    const violations = [];

    for (const f of files) {
      const filePath = path.join(rulesDir, f);
      const stat = await fs.stat(filePath);
      const tokens = Math.ceil(stat.size / BYTES_PER_TOKEN);
      const tier = findTier(f);
      const status = tokens <= tier.max ? "OK" : "OVER";
      lines.push(
        `  ${f.padEnd(50)} ${String(tokens).padStart(5)} tokens / ${String(tier.max).padStart(5)} max [${tier.name}] ${status}`
      );
      if (tokens > tier.max) {
        const body = await fs.readFile(filePath, "utf8");
        violations.push(formatTierViolation(f, tokens, tier, body));
      }
    }

    console.log(`[rule-token-budget] ${files.length} files:`);
    for (const line of lines) console.log(line);

    // Ordinary path: threshold exceedance is soft (governance-owned). Emit
    // diagnostics via formatTierViolation but do not fail closed on over-cap alone.
    if (violations.length > 0) {
      console.warn(
        `soft-warn cap-pressure=over count=${violations.length} (ordinary path; governance-owned)\n\n` +
          violations.join("\n\n")
      );
    }
    assert.ok(files.length > 0, "expected agent-rules markdown carriers to measure");
  });

  // ── formatTierViolation helper unit tests ────────────────────────────────
  // Per issue #708 acceptance: assert the failure message lists three explicit
  // options + rationale comment template, so downstream new-leaf authors do
  // not need to read the test source to discover tier-registration mechanics.
  // Per cross-model round-1 finding: the message must also differ by tier of
  // origin — a `next` or `core` violator can NOT be told to "register in next".
  describe("formatTierViolation helper", () => {
    const fakeSmallFallback = { name: "small (fallback)", max: TIERS.small.maxTokens };
    const fakeSmall = { name: "small", max: TIERS.small.maxTokens };
    const fakeNext = { name: "next", max: TIERS.next.maxTokens };
    const fakeCore = { name: "core", max: TIERS.core.maxTokens };

    describe("small / fallback branch", () => {
      it("contains all three numbered options", () => {
        const msg = formatTierViolation("fake-leaf.md", 2500, fakeSmallFallback);
        assert.match(msg, /1\. Compress to/);
        assert.match(msg, /2\. Register in `next` tier/);
        assert.match(msg, /3\. Register in `core` tier/);
      });

      it("treats explicit `small` tier the same as `small (fallback)`", () => {
        const msg = formatTierViolation("x.md", 1700, fakeSmall);
        assert.match(msg, /2\. Register in `next` tier/);
        assert.match(msg, /3\. Register in `core` tier/);
      });

      it("references the correct tier caps from TIERS", () => {
        const msg = formatTierViolation("fake-leaf.md", 2500, fakeSmallFallback);
        assert.ok(msg.includes(`${TIERS.next.maxTokens} max`), "next cap missing");
        assert.ok(msg.includes(`${TIERS.core.maxTokens} max`), "core cap missing");
      });

      it("includes the rationale comment template targeting next tier", () => {
        const msg = formatTierViolation("fake-leaf.md", 2500, fakeSmallFallback);
        assert.match(msg, /\/\/ <promotion-reason>:/);
        assert.match(msg, /<leaf-purpose>/);
        assert.match(msg, /\(~<token>\/3000 cap\)/);
      });

      it("embeds filename in the registration suggestion line", () => {
        const msg = formatTierViolation("my-new-leaf.md", 2500, fakeSmallFallback);
        assert.ok(
          msg.includes('"my-new-leaf.md",'),
          "filename not quoted in TIERS.next.files snippet"
        );
      });
    });

    describe("next branch", () => {
      it("offers compress-or-promote-to-core, NOT register-in-next", () => {
        const msg = formatTierViolation("registered-leaf.md", 3100, fakeNext);
        assert.match(msg, /1\. Compress to ≤ 3000 tokens/);
        assert.match(msg, /2\. Promote to `core` tier/);
        assert.ok(
          !/Register in `next` tier/.test(msg),
          "next-tier violator must not be told to register in next"
        );
      });

      it("rationale comment template targets core tier cap", () => {
        const msg = formatTierViolation("registered-leaf.md", 3100, fakeNext);
        assert.match(msg, /\(~<token>\/7500 cap\)/);
      });

      it("references filename in the promote-move instruction", () => {
        const msg = formatTierViolation("registered-leaf.md", 3100, fakeNext);
        assert.ok(msg.includes('"registered-leaf.md"'), "filename missing from promote instruction");
      });
    });

    describe("core branch", () => {
      it("offers compress-or-split, no registration advice", () => {
        const msg = formatTierViolation("core-leaf.md", 7800, fakeCore);
        assert.match(msg, /1\. Compress to ≤ 7500 tokens/);
        assert.match(msg, /2\. Split this leaf/);
        assert.ok(
          !/Register in/.test(msg) && !/Promote to/.test(msg),
          "core-tier violator must not be told to register or promote (no higher tier)"
        );
      });

      it("references rule-design-principles for split criteria", () => {
        const msg = formatTierViolation("core-leaf.md", 7800, fakeCore);
        assert.ok(
          msg.includes("rule-design-principles.md split criteria"),
          "split cross-ref missing for core-tier violator"
        );
      });
    });

    describe("shared elements", () => {
      it("points all branches to rule-file-template.md § Token Budget Tier Registration", () => {
        for (const tier of [fakeSmallFallback, fakeSmall, fakeNext, fakeCore]) {
          const msg = formatTierViolation("x.md", tier.max + 100, tier);
          assert.ok(
            msg.includes("rule-file-template.md § Token Budget Tier Registration"),
            `cross-ref missing for tier "${tier.name}"`
          );
        }
      });

      it("renders tier name verbatim across branches", () => {
        assert.match(formatTierViolation("x.md", 1600, fakeSmallFallback), /tier "small \(fallback\)"/);
        assert.match(formatTierViolation("x.md", 1600, fakeSmall), /tier "small"/);
        assert.match(formatTierViolation("x.md", 3100, fakeNext), /tier "next"/);
        assert.match(formatTierViolation("x.md", 7800, fakeCore), /tier "core"/);
      });
    });
  });

  // ── T2: over-cap offset-candidate integration ────────────────────────────
  describe("formatTierViolation over-cap offset candidates (T2)", () => {
    const fakeNext = { name: "next", max: TIERS.next.maxTokens };
    const fakeCore = { name: "core", max: TIERS.core.maxTokens };

    it("contains 'Offset candidates' anchor literal when body is provided", () => {
      const body = "## Section A\n\nSome content here.\n";
      const msg = formatTierViolation("leaf.md", 3100, fakeNext, body);
      assert.ok(msg.includes("Offset candidates"), "anchor literal 'Offset candidates' missing");
    });

    it("contains advisory literal '候選 ≠ 一定可砍' when body is provided", () => {
      const body = "## Section A\n\nSome content here.\n";
      const msg = formatTierViolation("leaf.md", 3100, fakeNext, body);
      assert.ok(msg.includes("候選 ≠ 一定可砍"), "advisory literal missing");
    });

    it("over-cap with body containing candidates lists them", () => {
      // Construct a body with a long-paren line to trigger a candidate
      const longParenContent = "x".repeat(85);
      const body = `## Heavy Section\n\nThis line has (${longParenContent}) in it.\n`;
      const msg = formatTierViolation("leaf.md", 7800, fakeCore, body);
      assert.ok(msg.includes("Offset candidates"), "anchor missing");
      assert.ok(msg.includes("Heavy Section"), "heading missing from candidate");
      assert.ok(msg.includes("long-paren"), "feature label missing");
    });

    it("over-cap with no candidates shows '(none detected by heuristics)'", () => {
      const body = "## Clean Section\n\nShort content.\n";
      const msg = formatTierViolation("leaf.md", 3100, fakeNext, body);
      assert.ok(msg.includes("Offset candidates"), "anchor missing");
      assert.ok(msg.includes("(none detected by heuristics)"), "empty-candidate message missing");
    });

    it("without body argument does NOT append offset-candidate block", () => {
      const msg = formatTierViolation("leaf.md", 3100, fakeNext);
      assert.ok(!msg.includes("Offset candidates"), "offset-candidate block must not appear without body");
      assert.ok(!msg.includes("候選 ≠ 一定可砍"), "advisory must not appear without body");
    });

    it("does not alter existing three-option text when body is provided", () => {
      const body = "## Intro\n\nSome text.\n";
      const msg = formatTierViolation("leaf.md", 3100, fakeNext, body);
      assert.match(msg, /1\. Compress to ≤ 3000 tokens/);
      assert.match(msg, /2\. Promote to `core` tier/);
    });
  });

  // ── T1: collectOffsetCandidates unit tests ───────────────────────────────
  describe("collectOffsetCandidates (T1)", () => {
    it("returns empty array for body with no heuristic triggers", () => {
      const body = "## Overview\n\nShort sentence.\n\n## Summary\n\nAnother short line.\n";
      const result = collectOffsetCandidates("clean.md", body);
      assert.deepEqual(result, []);
    });

    it("same input returns same output (deterministic)", () => {
      const body = "## Notes\n\nThis has (`ref.md`) a cross-ref, (`ref.md`) twice, and (`ref.md`) three times.\n";
      const r1 = collectOffsetCandidates("x.md", body);
      const r2 = collectOffsetCandidates("x.md", body);
      assert.deepEqual(r1, r2);
    });

    describe("heuristic 1 – long-paren", () => {
      it("detects ASCII paren content >= 80 chars", () => {
        const inner = "a".repeat(80);
        const body = `## Section\n\nThis line (${inner}) ends here.\n`;
        const result = collectOffsetCandidates("f.md", body);
        assert.equal(result.length, 1);
        assert.equal(result[0].heading, "Section");
        assert.match(result[0].feature, /long-paren/);
        assert.ok(result[0].feature.includes("80"), "should report 80 chars");
      });

      it("does NOT trigger for paren content < 80 chars", () => {
        const inner = "a".repeat(79);
        const body = `## Section\n\nThis line (${inner}) ends here.\n`;
        const result = collectOffsetCandidates("f.md", body);
        assert.equal(result.length, 0);
      });

      it("correctly attributes line number", () => {
        const inner = "b".repeat(82);
        const body = `Line one\nLine two\n## Heading\nLine after heading (${inner}) here\n`;
        const result = collectOffsetCandidates("f.md", body);
        assert.equal(result.length, 1);
        assert.equal(result[0].line, 4);
      });
    });

    describe("heuristic 2 – repeated cross-ref", () => {
      it("detects same .md backtick ref appearing >= 3 times", () => {
        const body = [
          "## Cross Refs",
          "See `target.md` for details.",
          "Also check `target.md` again.",
          "And `target.md` one more time.",
        ].join("\n");
        const result = collectOffsetCandidates("f.md", body);
        const refs = result.filter(c => c.feature.includes("repeated-crossref"));
        assert.ok(refs.length >= 1, "should detect at least one repeated-crossref candidate");
        assert.ok(refs.every(c => c.feature.includes("target.md")), "should name the ref file");
      });

      it("does NOT trigger for a ref appearing only twice", () => {
        const body = [
          "## Notes",
          "See `other.md`.",
          "Also `other.md`.",
        ].join("\n");
        const result = collectOffsetCandidates("f.md", body);
        const refs = result.filter(c => c.feature.includes("repeated-crossref"));
        assert.equal(refs.length, 0);
      });

      it("candidate includes occurrence count", () => {
        const body = [
          "## Refs",
          "Check `guide.md`.",
          "See `guide.md` for more.",
          "Refer to `guide.md` again.",
          "And `guide.md` once more.",
        ].join("\n");
        const result = collectOffsetCandidates("f.md", body);
        const refs = result.filter(c => c.feature.includes("repeated-crossref") && c.feature.includes("guide.md"));
        assert.ok(refs.length >= 1);
        assert.ok(refs[0].feature.includes("4 occurrences"), `expected '4 occurrences' in: ${refs[0].feature}`);
      });
    });

    describe("heuristic 3 – near-duplicate adjacent bullet", () => {
      it("detects adjacent bullets with >= 60% word overlap", () => {
        const body = [
          "## Steps",
          "- Run the deployment script on the server",
          "- Run the deployment script on the cluster",
        ].join("\n");
        const result = collectOffsetCandidates("f.md", body);
        const dupes = result.filter(c => c.feature.includes("near-duplicate-bullet"));
        assert.ok(dupes.length >= 1, "should detect near-duplicate bullet pair");
      });

      it("does NOT trigger for bullets with low overlap", () => {
        const body = [
          "## Steps",
          "- Install dependencies and configure the environment",
          "- Run tests and check coverage reports",
        ].join("\n");
        const result = collectOffsetCandidates("f.md", body);
        const dupes = result.filter(c => c.feature.includes("near-duplicate-bullet"));
        assert.equal(dupes.length, 0);
      });

      it("references the first bullet line number in the feature description", () => {
        const body = [
          "## Section",
          "- identical words match exactly here now",
          "- identical words match exactly here now",
        ].join("\n");
        const result = collectOffsetCandidates("f.md", body);
        const dupes = result.filter(c => c.feature.includes("near-duplicate-bullet"));
        assert.ok(dupes.length >= 1);
        assert.ok(dupes[0].feature.includes("line 2"), `expected 'line 2' in: ${dupes[0].feature}`);
      });

      it("heading boundary resets adjacent bullet tracking", () => {
        const body = [
          "## Section A",
          "- identical words here right now",
          "## Section B",
          "- identical words here right now",
        ].join("\n");
        // The two identical bullets are separated by a heading, so not adjacent
        const result = collectOffsetCandidates("f.md", body);
        const dupes = result.filter(c => c.feature.includes("near-duplicate-bullet"));
        assert.equal(dupes.length, 0, "heading boundary should reset bullet adjacency");
      });
    });

    it("returns correct heading for candidates before any heading (top-level)", () => {
      const inner = "x".repeat(85);
      const body = `Top level line (${inner}) here.\n## Later section\n`;
      const result = collectOffsetCandidates("f.md", body);
      const topLevel = result.filter(c => c.heading === "<top-level>");
      assert.ok(topLevel.length >= 1, "should use <top-level> when no heading yet");
    });
  });

  // ── T1 (refactor-core-tier-saturation-split-doc-sop): new leaf + headroom ──
  // RED until doc-split-and-dedup-sop.md is created (file-not-found) and
  // rule-design-principles.md is trimmed below 6000 tokens.
  it("doc-split-and-dedup-sop.md exists in next tier (< 3000 tokens)", async () => {
    const filename = "doc-split-and-dedup-sop.md";
    const filePath = path.join(rulesDir, filename);
    const stat = await fs.stat(filePath); // throws ENOENT if file doesn't exist
    const tokens = Math.ceil(stat.size / BYTES_PER_TOKEN);
    assert.ok(
      tokens < 3000,
      `${filename}: ${tokens} tokens — must be < 3000 (next tier cap)`
    );
  });

  it("rule-design-principles.md < 6800 tokens (per-file bound, raised per 守則 4 corollary)", async () => {
    // Rationale: rule-design-principles.md was 7499/7500 (core cap) blocking
    // all further doc↔enforcement sync. After extracting §文件拆分 SOP +
    // §Protected Anchors to doc-split-and-dedup-sop.md, it sat at ~5566 tokens
    // and the per-file bound was set to 6000 (≥ 1500 headroom from core cap).
    //
    // Bound raised 6000 → 6800 (strengthen-rule-anchor-guard-authoring, user
    // decision 2026-07-03) after applying the 守則 4 corollary this very change
    // adds to rule-design-principles.md — the three-branch tier-cap evaluation
    // (提 cap / 拆檔 / trim, 禁硬 trim 到語意不可讀):
    //   - branch 1 (拆檔): the grep-guard 強度守則 topic this change authors is
    //     independently loadable → branch-1 split applied at creation, written as
    //     the next-tier leaf rule-anchor-guard-strength.md (892/3000) rather than
    //     kept in this file. (Net-new topic — rule-design-principles.md never held
    //     it;母檔 carries only a stub pointer.) Applied.
    //   - what remains over 6000 is the §守則 4 corollary itself — a single-topic
    //     deepening of Token-First / usefulness-first token discipline (design-layer SSOT for tier-cap policy).
    //     Extracting it would create a leaf→leaf chain (守則 3 violation), so it
    //     does NOT pass branch-1's split gate; trimming it would cut load-bearing
    //     semantics, so branch 2 (trim真冗餘) does not apply either.
    //   - branch 3 (提 cap): single-topic deepening + trim would only cut valued
    //     semantics + headroom remains below core cap → raise the per-file bound.
    // 6800 leaves ≥ 700 headroom from the 7500 core cap. This is the corollary
    // dogfooding itself: the change that documents "cap is a design parameter,
    // don't hard-trim to unreadability" is the change that exercises branch 3.
    const filename = "rule-design-principles.md";
    const filePath = path.join(rulesDir, filename);
    const stat = await fs.stat(filePath);
    const tokens = Math.ceil(stat.size / BYTES_PER_TOKEN);
    assert.ok(
      tokens < 6800,
      `${filename}: ${tokens} tokens — must be < 6800 (per-file bound raised 6000→6800 per 守則 4 corollary three-branch eval; ≥ 700 headroom from core 7500 cap)`
    );
  });

  it("requires an AI-readability precheck before every rule compression", async () => {
    const body = await fs.readFile(path.join(rulesDir, "token-budget-precheck.md"), "utf8");
    assert.match(body, /production SSOT.*rule-token-budget\.mjs/s);
    assert.match(body, /committed、staged、unstaged tracked 與 untracked probes/);
    assert.match(body, /known-empty.*known-nonempty.*unknown/s);
    assert.match(body, /semanticReview=required/);
    assert.match(body, /advisory-signal only/);
    assert.match(body, /soft\/governance|soft-warn/);
    assert.match(body, /hard-trim-for-cap/);
    assert.match(body, /over-cap alone MUST NOT fail closed/);
    assert.match(body, /Gate 不得產生 semantic PASS\/FAIL|機器不得產生 semantic PASS\/FAIL/);
    assert.match(body, /不得要求 proposal 內的 coverage、estimate、cap、mitigation、readability/);
  });

  it("measures the same manifest and bytes deterministically without repository identity", () => {
    const manifest = {
      state: "known-nonempty",
      entries: [{ status: "M", oldPath: "", newPath: ".devpro/agent-rules/token-budget-precheck.md", probe: "unstaged" }],
    };
    const readFile = () => Buffer.from("x".repeat(7000));
    const source = measureRuleTokenBudget({ cwd: "/source", manifest, readFile });
    const consumer = measureRuleTokenBudget({ cwd: "/consumer", manifest, readFile });
    assert.deepEqual(source, consumer);
    assert.deepEqual(Object.keys(source.files[0]), [
      "path", "status", "bytes", "tokens", "tier", "cap", "utilization",
      "registry", "guard", "reason", "verdict", "semanticReview",
    ]);
  });

  it("reports deterministic non-sensitive read and measurement failure reasons", () => {
    const manifest = {
      state: "known-nonempty",
      entries: [{ status: "M", oldPath: "", newPath: ".devpro/agent-rules/token-budget-precheck.md", probe: "unstaged" }],
    };
    const unreadable = measureRuleTokenBudget({
      cwd: "/fixture",
      manifest,
      readFile: () => {
        throw Object.assign(new Error("secret /absolute/path"), { code: "EACCES" });
      },
    });
    const invalid = measureRuleTokenBudget({ cwd: "/fixture", manifest, readFile: () => undefined });

    assert.equal(unreadable.files[0].reason, "read-error:EACCES");
    assert.doesNotMatch(JSON.stringify(unreadable), /absolute|secret/);
    assert.equal(unreadable.verdict, "block");
    assert.equal(invalid.files[0].reason, "measurement-error:INVALID_BODY");
    assert.equal(invalid.verdict, "block");
  });

  it("measures rename/copy final carriers once and records rename-out as deletion", () => {
    const renameOut = ".devpro/agent-rules/rename-out.md";
    const renameIn = ".devpro/agent-rules/rename-in.md";
    const copied = ".devpro/agent-rules/copied.md";
    const requested = [];
    const result = measureRuleTokenBudget({
      cwd: "/fixture",
      manifest: {
        state: "known-nonempty",
        entries: [
          { status: "R100", oldPath: renameOut, newPath: "notes/renamed-out.md", probe: "committed" },
          { status: "R097", oldPath: "notes/renamed-in.md", newPath: renameIn, probe: "staged" },
          { status: "C100", oldPath: ".devpro/agent-rules/copy-source.md", newPath: copied, probe: "committed" },
        ],
      },
      readFile: (filePath) => {
        requested.push(filePath);
        return Buffer.from("final carrier bytes\n");
      },
    });

    assert.equal(result.checked, 3);
    assert.equal(result.verdict, "pass");
    assert.deepEqual(
      result.files.map(({ path: repoPath, status, bytes }) => ({ path: repoPath, status, bytes })),
      [
        { path: copied, status: "C100", bytes: 20 },
        { path: renameIn, status: "R097", bytes: 20 },
        { path: renameOut, status: "R100", bytes: null },
      ]
    );
    assert.deepEqual(
      requested.map((filePath) => path.basename(filePath)).sort(),
      ["copied.md", "rename-in.md"]
    );
  });

  it("fails closed when executable registry or guard policy drifts", async () => {
    const productionPath = path.join(scriptDir, "../lib/rule-token-budget.mjs");
    const source = await fs.readFile(productionPath, "utf8");
    const fixtureDir = await fs.mkdtemp(path.join(tmpdir(), "rule-token-policy-drift-"));
    const carrier = ".devpro/agent-rules/token-budget-precheck.md";
    const manifest = {
      state: "known-nonempty",
      entries: [{ status: "M", oldPath: "", newPath: carrier, probe: "unstaged" }],
    };
    try {
      const duplicateRegistry = source.replace(
        'files: Object.freeze(["api-design-http-semantics.md"',
        'files: Object.freeze(["token-budget-precheck.md", "api-design-http-semantics.md"'
      );
      assert.notEqual(duplicateRegistry, source, "registry mutation fixture must alter production source");
      const registryModulePath = path.join(fixtureDir, "registry-drift.mjs");
      await fs.writeFile(registryModulePath, duplicateRegistry);
      const registryModule = await import(`${pathToFileURL(registryModulePath).href}?case=registry`);
      const registryResult = registryModule.measureRuleTokenBudget({
        cwd: "/fixture",
        manifest,
        readFile: () => Buffer.from("within cap\n"),
      });
      assert.equal(registryResult.files[0].registry, "block");
      assert.equal(registryResult.verdict, "block");

      const guardMarker = "export const READABILITY_CAP_GUARDS";
      const markerIndex = source.indexOf(guardMarker);
      assert.ok(markerIndex >= 0, "guard registry marker must exist");
      const guardPrefix = source.slice(0, markerIndex);
      const guardBody = source.slice(markerIndex).replace(
        '".devpro/agent-rules/token-budget-precheck.md": 3500,',
        '".devpro/agent-rules/token-budget-precheck.md": 3499,'
      );
      assert.notEqual(guardBody, source.slice(markerIndex), "guard mutation fixture must alter production source");
      const guardModulePath = path.join(fixtureDir, "guard-drift.mjs");
      await fs.writeFile(guardModulePath, guardPrefix + guardBody);
      const guardModule = await import(`${pathToFileURL(guardModulePath).href}?case=guard`);
      const guardResult = guardModule.measureRuleTokenBudget({
        cwd: "/fixture",
        manifest,
        readFile: () => Buffer.from("within cap\n"),
      });
      assert.equal(guardResult.files[0].guard, "block");
      assert.equal(guardResult.verdict, "block");
    } finally {
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("keeps unregistered carriers on the small fallback cap at the 1500/1501 boundary", () => {
    const carrier = ".devpro/agent-rules/unregistered-boundary.md";
    const manifest = {
      state: "known-nonempty",
      entries: [{ status: "A", oldPath: "", newPath: carrier, probe: "untracked" }],
    };
    const atCap = measureRuleTokenBudget({
      cwd: "/fixture",
      manifest,
      readFile: () => Buffer.alloc(5250),
    });
    const overCap = measureRuleTokenBudget({
      cwd: "/fixture",
      manifest,
      readFile: () => Buffer.alloc(5251),
    });

    assert.equal(findRuleTokenTier(carrier).cap, TIERS.small.maxTokens);
    assert.deepEqual(
      { tokens: atCap.files[0].tokens, cap: atCap.files[0].cap, verdict: atCap.verdict },
      { tokens: 1500, cap: 1500, verdict: "pass" }
    );
    // Threshold exceedance alone is soft: verdict=pass; utilization may exceed 100.
    assert.deepEqual(
      {
        tokens: overCap.files[0].tokens,
        cap: overCap.files[0].cap,
        verdict: overCap.verdict,
        reason: overCap.files[0].reason,
        registry: overCap.files[0].registry,
        guard: overCap.files[0].guard,
      },
      { tokens: 1501, cap: 1500, verdict: "pass", reason: "none", registry: "pass", guard: "pass" }
    );
    assert.ok(overCap.files[0].utilization > 100, "over-cap utilization must exceed 100%");
  });

  it("soft polarity: threshold-only over-cap passes; definition integrity blocks (F1 dual fixtures)", async () => {
    const carrier = ".devpro/agent-rules/token-budget-precheck.md";
    const manifest = {
      state: "known-nonempty",
      entries: [{ status: "M", oldPath: "", newPath: carrier, probe: "unstaged" }],
    };
    // Threshold-only soft fixture: actual > cap, registry/guard pass → verdict=pass.
    const soft = measureRuleTokenBudget({
      cwd: "/fixture",
      manifest,
      readFile: () => Buffer.alloc(Math.ceil(3500 * BYTES_PER_TOKEN) + 1),
    });
    assert.equal(soft.verdict, "pass");
    assert.equal(soft.files[0].verdict, "pass");
    assert.equal(soft.files[0].reason, "none");
    assert.ok(soft.files[0].utilization > 100);
    assert.equal(soft.files[0].semanticReview, "required");

    // Definition-integrity hard fixture: guard drift → verdict=block (even under cap).
    const productionPath = path.join(scriptDir, "../lib/rule-token-budget.mjs");
    const source = await fs.readFile(productionPath, "utf8");
    const fixtureDir = await fs.mkdtemp(path.join(tmpdir(), "rule-token-soft-hard-"));
    try {
      const guardMarker = "export const READABILITY_CAP_GUARDS";
      const markerIndex = source.indexOf(guardMarker);
      assert.ok(markerIndex >= 0);
      const guardPrefix = source.slice(0, markerIndex);
      const guardBody = source.slice(markerIndex).replace(
        '".devpro/agent-rules/token-budget-precheck.md": 3500,',
        '".devpro/agent-rules/token-budget-precheck.md": 3499,'
      );
      const guardModulePath = path.join(fixtureDir, "integrity-hard.mjs");
      await fs.writeFile(guardModulePath, guardPrefix + guardBody);
      const guardModule = await import(`${pathToFileURL(guardModulePath).href}?case=integrity-hard`);
      const hard = guardModule.measureRuleTokenBudget({
        cwd: "/fixture",
        manifest,
        readFile: () => Buffer.from("within cap\n"),
      });
      assert.equal(hard.files[0].guard, "block");
      assert.equal(hard.verdict, "block");

      // F1 priority: threshold exceedance + integrity together → still block.
      const both = guardModule.measureRuleTokenBudget({
        cwd: "/fixture",
        manifest,
        readFile: () => Buffer.alloc(Math.ceil(3500 * BYTES_PER_TOKEN) + 1),
      });
      assert.ok(both.files[0].utilization > 100);
      assert.equal(both.files[0].guard, "block");
      assert.equal(both.verdict, "block");
    } finally {
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("normalizes ./AGENTS.md consistently for registry and readability guards", () => {
    assert.deepEqual(validateRuleTokenRegistry("./AGENTS.md"), {
      registry: "pass",
      guard: "pass",
    });
  });

  it("binds readability cap guards to the executable per-file overrides", () => {
    for (const [relativeRulePath, cap] of Object.entries(PER_FILE_MAX_OVERRIDE)) {
      const carrier = `.devpro/agent-rules/${relativeRulePath}`;
      assert.equal(
        READABILITY_CAP_GUARDS[carrier],
        cap,
        `${relativeRulePath} per-file override must have an equal readability guard`
      );
    }
    for (const [carrier, cap] of Object.entries(READABILITY_CAP_GUARDS)) {
      const relativeRulePath = carrier.replace(/^\.devpro\/agent-rules\//, "");
      assert.equal(
        findTier(relativeRulePath).max,
        cap,
        `${carrier} readability guard must equal its effective executable cap`
      );
    }
    assert.equal(
      READABILITY_CAP_GUARDS[".devpro/agent-rules/second-review-control-evidence.md"],
      13000,
      "the 12589-token control-evidence contract (operator-only recovery entries split out) requires its formula-derived 13000 readable cap"
    );
    assert.equal(
      READABILITY_CAP_GUARDS[".devpro/agent-rules/second-review-operator-recovery.md"],
      4000,
      "the 3547-token operator recovery entries require their formula-derived 4000 readable cap"
    );
    assert.equal(
      READABILITY_CAP_GUARDS[".devpro/agent-rules/gitignore-alignment.md"],
      3500,
      "the 3178-token gitignore baseline／inventory contract requires its formula-derived 3500 readable cap"
    );
    assert.equal(
      READABILITY_CAP_GUARDS[".devpro/agent-rules/change-consequence-assessment.md"],
      2500,
      "the 2014-token consequence-assessment contract requires its formula-derived 2500 readable cap"
    );
    assert.equal(
      READABILITY_CAP_GUARDS[".devpro/agent-rules/test-suite-cadence.md"],
      5000,
      "the 4394-token test suite cadence contract requires its formula-derived 5000 readable cap"
    );
    assert.equal(
      READABILITY_CAP_GUARDS[".devpro/agent-rules/session-pending-lifecycle.md"],
      5000,
      "the 4590-token session-pending lifecycle contract requires its formula-derived 5000 readable cap"
    );
    assert.equal(
      READABILITY_CAP_GUARDS[".devpro/agent-rules/post-pr-completion-gate.md"],
      6000,
      "the 5629-token completion-gate contract requires its formula-derived 6000 readable cap"
    );
    assert.equal(
      READABILITY_CAP_GUARDS[".devpro/agent-rules/code-review-checklist.md"],
      16000,
      "the 15710-token full code-review contract requires its formula-derived 16000 readable cap"
    );
    for (const [leaf, cap, tokens] of [
      ["ai-autonomy.md", 11500, 10900],
      ["workflow-cost-controls.md", 5000, 4359],
      ["proposal-template.md", 4500, 3979],
      ["rules-rigor-level.md", 4000, 3394],
      ["platform-adapters/codex-host-cross-review.md", 18500, 18004],
      // amend-gate-forgery-rule-for-waiver-records: the waiver exception sentence moves this cap 12000 → 13000
      // (12336 tokens) and gives cursor.md its own 11000 override (10537 tokens); both follow the formula.
      ["code-review-cross-model.md", 13000, 12336],
      ["platform-adapters/cursor.md", 11000, 10537],
      ["code-review-cross-model-dispatch-mechanics.md", 4500, 4127],
      // rationalize-rule-token-caps: the rest of the over-cap leaves at their formula caps.
      ["multi-agent-handoff.md", 9000, 8610],
      ["agent-skill-governance.md", 4500, 3864],
      ["environment-setup-nvm-nodejs-openspec.md", 4000, 3676],
      ["consumer-failure-playbook.md", 2500, 1793],
      ["openspec-archive-principles.md", 4000, 3528],
      ["review-guarantee-ceiling.md", 2000, 1718],
      ["pre-implementation-over-design.md", 4000, 3287],
      ["second-review-external-evaluator.md", 4000, 3267],
      ["troubleshooting.md", 3500, 3074],
      ["rules-flow.md", 8000, 7511],
      ["design-template.md", 2000, 1516],
      // rationalize-threat-model-token-caps: the accident-only threat model rows took this leaf past its next default.
      ["ai-autonomy-rationalizations.md", 3500, 3044],
    ]) {
      assert.equal(
        READABILITY_CAP_GUARDS[`.devpro/agent-rules/${leaf}`],
        cap,
        `the ${tokens}-token ${leaf} requires its formula-derived ${cap} readable cap`
      );
      assert.equal(cap, Math.ceil((tokens + 250) / 500) * 500, `${leaf} cap must follow the minimum-necessary formula`);
      assert.equal(findTier(leaf).max, cap, `${leaf} executable cap must match its guard`);
    }
    assert.equal(
      findRuleTokenTier(".devpro/agent-rules/design-template.md").name,
      "small",
      "design-template.md registers in TIERS.small with its formula override, not in next for headroom"
    );
    // The owner declined the design-core.md §7–§11 split (2026-11-08) and kept that choice at 13032 tokens
    // (2026-11-10); its cap must not rise instead.
    assert.equal(PER_FILE_MAX_OVERRIDE["design-core.md"], 10500, "design-core.md keeps its 10500 cap");
    assert.equal(READABILITY_CAP_GUARDS[".devpro/agent-rules/design-core.md"], 10500);
    assert.equal(
      READABILITY_CAP_GUARDS[".devpro/agent-rules/rule-audit-playbook.md"],
      4500,
      "the 3953-token cadence state machine requires its formula-derived 4500 readable cap"
    );
    assert.equal(findTier("rule-audit-playbook.md").max, 4500);
    assert.equal(
      READABILITY_CAP_GUARDS[".devpro/agent-rules/git-branch-naming-and-anchor.md"],
      7500,
      "the repair action point must bind to the existing core-tier cap"
    );
    assert.equal(findTier("git-branch-naming-and-anchor.md").max, 7500);
    // refactor-release-rule-carriers: owner requires faithful text over cap-fitting
    // compression. Keep four narrow formula caps; shared tier defaults stay unchanged.
    for (const [leaf, registeredTokens, tier] of [
      ["release-sit-uat-pat-prod.md", 8606, "core"],
      ["release-step-1-7.md", 10007, "core"],
      ["release-verification-commands.md", 1777, "small"],
      ["testing-and-qa.md", 8097, "core"],
    ]) {
      const cap = Math.ceil((registeredTokens + 250) / 500) * 500;
      assert.equal(PER_FILE_MAX_OVERRIDE[leaf], cap, `${leaf} must use the minimum faithful-carrier cap`);
      assert.equal(READABILITY_CAP_GUARDS[`.devpro/agent-rules/${leaf}`], cap, `${leaf} guard must match its narrow cap`);
      assert.equal(findRuleTokenTier(`.devpro/agent-rules/${leaf}`).name, tier, `${leaf} must stay in its original tier`);
    }
    assert.equal(TIERS.core.maxTokens, 7500, "faithful carrier overrides must not raise the core tier");
    assert.equal(TIERS.small.maxTokens, 1500, "faithful carrier overrides must not raise the small tier");
    // token-budget-tooling "Formula-Derived Next-Tier Leaf Cap Override" names these two
    // leaves. Each row pins the cap beside the token count measured when it was registered;
    // the bucket above each formula value is above-formula and forbidden.
    // consumer-pre-pr-checks.md is registered under the same requirement; no scenario names it.
    for (const [leaf, cap, tokens] of [
      ["test-performance-patterns.md", 5000, 4587],
      ["release-rules-lane.md", 5500, 5175],
      ["consumer-pre-pr-checks.md", 6000, 5533],
    ]) {
      assert.equal(cap, Math.ceil((tokens + 250) / 500) * 500, `${leaf} cap must follow the minimum-necessary formula`);
      assert.equal(PER_FILE_MAX_OVERRIDE[leaf], cap, `${leaf} override must equal the formula cap of its ${tokens} registered tokens`);
      assert.equal(
        READABILITY_CAP_GUARDS[`.devpro/agent-rules/${leaf}`],
        cap,
        `${leaf} readability guard must lockstep the formula cap`
      );
      assert.equal(findTier(leaf).max, cap, `findTier(${leaf}).max must be the formula cap (never a bucket above it)`);
      assert.equal(findRuleTokenTier(`.devpro/agent-rules/${leaf}`).name, "next", `${leaf} must remain next-tier`);
      assert.ok(!TIERS.core.files.includes(leaf), `${leaf} must not enter TIERS.core.files for headroom`);
    }
  });

  it("locks the compression precheck and smallest-practical-cap escape hatch", async () => {
    const body = await fs.readFile(path.join(rulesDir, "token-frugal-io.md"), "utf8");
    assert.match(body, /Readability precheck before compression/);
    assert.match(body, /每次壓縮 rule、briefing、packet 或 action-point content/);
    assert.match(body, /MUST NOT.*high-density unreadable single paragraph/);
    // per enforce-readability-precheck design.md D4/D6: the English
    // "increase the smallest practical cap/headroom" escape-hatch phrase and its
    // adjacent rationale/guard wording were net-neutral-rephrased to a Chinese
    // cap-adjustment clause that cross-references token-budget-precheck.md
    // (which retains the load-bearing "理由鎖進鄰近 mechanical test" rationale
    // requirement) instead of duplicating it here.
    assert.match(body, /over CAP.*調整最小必要 cap（mitigation 見 `token-budget-precheck\.md`）/);
    assert.match(body, /此為每次適用之 cooperative 紀律.*token-budget-precheck\.md.*機械 backstop/);
  });

  // ── T6: compressionDiffReport unit tests ────────────────────────────────
  describe("compressionDiffReport (T6)", () => {
    it("reports correct net token delta for compression", () => {
      const before = "# Title\n\nThis is a longer paragraph with many words to fill space here.\n\n## Section\n\nMore content here.\n";
      const after = "# Title\n\nShort paragraph.\n\n## Section\n\nMore content here.\n";
      const { netTokenDelta } = compressionDiffReport(before, after);
      // after is shorter, so delta should be negative
      assert.ok(netTokenDelta < 0, `expected negative delta, got ${netTokenDelta}`);
    });

    it("reports zero delta for identical bodies", () => {
      const body = "# Title\n\nSame content.\n";
      const { netTokenDelta, affectedSections } = compressionDiffReport(body, body);
      assert.equal(netTokenDelta, 0);
      assert.deepEqual(affectedSections, []);
    });

    it("contains literal 'net token delta' concept — delta value is a number", () => {
      const before = "# H\n\nLong text that adds many tokens here for testing purposes.\n";
      const after = "# H\n\nShort.\n";
      const result = compressionDiffReport(before, after);
      // The key is named netTokenDelta (implements 'net token delta' concept)
      assert.ok(typeof result.netTokenDelta === "number", "netTokenDelta must be a number");
    });

    it("lists affected sections by heading when content changes", () => {
      const before = "# Doc\n\n## Overview\n\nOriginal overview content here.\n\n## Details\n\nUnchanged.\n";
      const after = "# Doc\n\n## Overview\n\nShortened.\n\n## Details\n\nUnchanged.\n";
      const { affectedSections } = compressionDiffReport(before, after);
      assert.ok(affectedSections.includes("Overview"), `expected 'Overview' in ${JSON.stringify(affectedSections)}`);
      assert.ok(!affectedSections.includes("Details"), `'Details' should not be affected`);
    });

    it("includes top-level section when pre-heading content changes", () => {
      const before = "Preamble text before any heading.\n\n## Section\n\nContent.\n";
      const after = "Changed preamble.\n\n## Section\n\nContent.\n";
      const { affectedSections } = compressionDiffReport(before, after);
      assert.ok(affectedSections.includes("<top-level>"), `expected '<top-level>' in ${JSON.stringify(affectedSections)}`);
    });

    it("detects newly added section", () => {
      const before = "## Existing\n\nContent.\n";
      const after = "## Existing\n\nContent.\n\n## New Section\n\nAdded.\n";
      const { affectedSections } = compressionDiffReport(before, after);
      assert.ok(affectedSections.includes("New Section"), `expected 'New Section' in ${JSON.stringify(affectedSections)}`);
    });

    it("same input produces same output (deterministic)", () => {
      const before = "# Doc\n\n## A\n\nContent A.\n\n## B\n\nContent B.\n";
      const after = "# Doc\n\n## A\n\nCompressed.\n\n## B\n\nContent B.\n";
      const r1 = compressionDiffReport(before, after);
      const r2 = compressionDiffReport(before, after);
      assert.deepEqual(r1, r2);
    });

    it("delta uses Math.ceil(bytes/BYTES_PER_TOKEN) formula", () => {
      // Construct exact bodies to verify the formula
      const before = "x".repeat(350); // 350 bytes / 3.5 = 100 tokens exactly
      const after = "x".repeat(175);  // 175 bytes / 3.5 = 50 tokens exactly
      const { netTokenDelta } = compressionDiffReport(before, after);
      assert.equal(netTokenDelta, -50, `expected -50, got ${netTokenDelta}`);
    });
  });
});
