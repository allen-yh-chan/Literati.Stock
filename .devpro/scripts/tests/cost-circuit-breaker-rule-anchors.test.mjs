import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";
import { readIfExists, listArchivedChangeDirs } from "./lib/spec-delta-reader.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

function readRule(leaf) {
  return read(`.devpro/agent-rules/${leaf}`);
}

const CHANGE_NAME = "add-change-cost-circuit-breaker";

// design.md lives in the active change folder while this task sequence is
// in flight, then migrates to openspec/changes/archive/<date>-<name>/ once
// the change merges — the Enforcement Map it carries (D13) must stay
// verifiable either way, so this reads both locations (only one is ever
// non-empty in practice).
function readDesignDoc() {
  const active = readIfExists(`openspec/changes/${CHANGE_NAME}/design.md`);
  const archived = listArchivedChangeDirs(CHANGE_NAME)
    .map((name) => readIfExists(`openspec/changes/archive/${name}/design.md`))
    .join("\n");
  const combined = [active, archived].join("\n");
  assert.ok(
    combined.trim().length > 0,
    `design.md not found (active or archived) for change ${CHANGE_NAME}`,
  );
  return combined;
}

// R8's shape survives `fix-zero-value-review-rounds`; its membership does not,
// and (per `fix-second-review-loop-friction` R1/D3/D12) the pr-sticky round cap
// is no longer part of that membership either. The mechanical trigger is still
// additive to the user/runtime one — it still activates the same hard-stop
// with no user or runtime signal present — but the three cumulative totals
// were never part of it (a total cannot show whether anything is being
// wasted, so it cannot be what asks a user to stop) and the pr-sticky round
// cap is now explicitly carved OUT: it is enforced solely by the round gate
// (`review_round_budget_exhausted`, sole unlock `DEVPRO_REVIEW_ROUND_OVERRIDE`)
// and is NOT a Cost Circuit Breaker threshold. `stalled_rounds` reporting
// `unavailable` is the only thing left that still blocks this way — a demoted
// threshold that is still printed is exactly the one a reader is most likely
// to relay as a stop anyway, so this test pins both what remains blocking and
// what has been carved out, not just the surviving half.
test("R8: workflow-cost-controls Stop-Loss trigger is a superset (mechanical threshold ∪ existing user/runtime trigger)", () => {
  const body = readRule("workflow-cost-controls.md");

  assert.match(
    body,
    /User quota\/cost concern or trusted runtime\/provider warning activates a hard-stop/,
    "existing user/runtime trigger sentence must remain verbatim (not narrowed or replaced)",
  );

  assert.match(
    body,
    /Cost Circuit Breaker's three cumulative totals[\s\S]{0,40}`lib\/cost-budget\.mjs`/,
    "the mechanical threshold sentence must still reference the cost-budget.mjs evaluator",
  );

  assert.match(
    body,
    /activates the same hard-stop independent of user or runtime signal/,
    "the mechanical trigger must still be additive: the same hard-stop, with no user or runtime signal required",
  );

  assert.match(
    body,
    /are \*\*advisory\*\* in every consumer[\s\S]{0,160}MUST NOT be relayed as a stop/,
    "the three cumulative totals must be documented as advisory in EVERY consumer, with the relay prohibition attached",
  );

  assert.match(
    body,
    /hard-stop independent of user or runtime signal is a blocking Cost Circuit Breaker threshold[\s\S]{0,40}`stalled_rounds` reporting \*\*`unavailable`\*\*/,
    "R8 anchor: only `stalled_rounds` reporting `unavailable` may be named as what still blocks (round is no longer a Cost Circuit Breaker threshold)",
  );

  assert.match(
    body,
    /pr-sticky review-round cap is enforced solely by the round gate[\s\S]{0,80}`review_round_budget_exhausted`[\s\S]{0,80}`DEVPRO_REVIEW_ROUND_OVERRIDE`[\s\S]{0,40}is not a Cost Circuit Breaker threshold/,
    "the leaf must explicitly carve the pr-sticky round cap OUT of the Cost Circuit Breaker's blocking membership",
  );

  assert.doesNotMatch(
    body,
    /hard-stop independent of user or runtime signal is `round`/,
    "regression guard: `round` MUST NOT be named alongside `stalled_rounds` as a Cost Circuit Breaker blocking threshold",
  );
});

test("R10: Mandatory Clause Enforcement Map (design.md D13) covers NFR-1/NFR-2/NFR-4/NFR-5 with named carriers", () => {
  const design = readDesignDoc();

  assert.match(
    design,
    /Mandatory Clause Enforcement Map（R10／NFR-5）/,
    "D13 Enforcement Map heading missing",
  );

  for (const nfr of ["NFR-1", "NFR-2", "NFR-4", "NFR-5"]) {
    const rowPattern = new RegExp(`\\|\\s*${nfr}\\s*\\|[^\\n]+\\|[^\\n]+\\|`);
    assert.match(design, rowPattern, `Enforcement Map must carry a table row for ${nfr}`);
  }

  // NFR-1 carrier must name the actual task 9(ii) bounded-read test, not
  // just prose asserting a carrier exists (tasks.md task 14 acceptance).
  assert.match(
    design,
    /readBoundedTailCacheRead: NFR-1 bytesRead does not scale with total file size/,
    "NFR-1 carrier must cite the named bounded-read test, not bare prose",
  );

  // D1 sliver owner/re-check trigger, verbatim (grep-locked per task 14 acceptance).
  assert.match(
    design,
    /owner ＝ `dp-architect`，複查 trigger ＝ 本 change merge 後首次取得 `--by-class` 實際分佈時/,
    "D1 cooperative-sliver owner/re-check trigger must be present verbatim",
  );

  // D4 Codex-gap owner/re-check trigger, verbatim (grep-locked per task 14 acceptance).
  assert.match(
    design,
    /owner ＝ `dp-architect`；複查 trigger ＝ Codex host 出現第一次 context-overrun 事件/,
    "D4 Codex-gap owner/re-check trigger must be present verbatim",
  );
});

// D13 table rows only — NOT a whole-file or whole-section grep. `design.md`
// legitimately says "pending" elsewhere: session-pending.md /
// session_pending_line_count_at_start field names in D7/D8 prose, AND the
// free-text "完成時的誠實狀態" paragraphs that follow this very table
// (which correctly describe "pending" having been resolved). A bare
// doc-wide or whole-section assert.doesNotMatch would false-positive on
// both. Collect only the contiguous `| ... |` table lines starting at the
// D13 header row — the first non-`|`-prefixed line (blank line or free-text
// paragraph) ends the table — per task 15 decisions.
function d13EnforcementMapTableRows(design) {
  const start = design.indexOf("### D13");
  assert.notEqual(start, -1, "D13 Enforcement Map heading missing");
  const fromHeading = design.slice(start);
  const tableStart = fromHeading.indexOf("| 條款 |");
  assert.notEqual(tableStart, -1, "D13 Enforcement Map table header missing");
  const lines = fromHeading.slice(tableStart).split("\n");
  const tableLines = [];
  for (const line of lines) {
    if (!line.startsWith("|")) break;
    tableLines.push(line);
  }
  return tableLines.join("\n");
}

test("R7/R10: D13 Enforcement Map carries no residual `pending` carrier placeholder", () => {
  const design = readDesignDoc();
  const rows = d13EnforcementMapTableRows(design);
  assert.doesNotMatch(
    rows,
    /pending/u,
    "every D13 row must have a resolved carrier or an explicit cooperative-only+reason — no row may still read pending",
  );
});

// R11: round 3 finding surfaced that classify-bounded's dispatch_id is
// HEAD-sensitive (its digest input includes head_sha) — any commit between
// obtaining it and calling dp-reviewer silently invalidates it, even when
// risk_shape_digest_sha256 is unchanged. Discovered mid-flight in this same
// change's own round 3 dispatch prep; user explicitly chose to fold the
// fix into this change (AskUserQuestion, "併入這個 change 本身") rather than
// defer it. Per this change's own R10 discipline, the new MUST needs a
// named carrier, not a bare cooperative-only shrug — this test is that
// carrier, locking the SKILL.md/reference text against silent drift.
test("R11: devpro:pre-pr Step 3 forbids a commit between classify-bounded and dp-reviewer dispatch (dispatch_id is HEAD-sensitive)", () => {
  // Step 3 body lives in references/full-review-and-archive.md; read the full-rigor reading order.
  const skill = readPrePrSkillFullReadingOrder();

  assert.match(
    skill,
    /`dispatch_id` HEAD 敏感性（MUST）/,
    "Step 3 must carry the dispatch_id HEAD-sensitivity MUST heading",
  );
  assert.match(
    skill,
    /MUST NOT[\s\S]{0,10}有任何 commit/,
    "must forbid any commit between obtaining dispatch_id and calling dp-reviewer",
  );
  assert.match(
    skill,
    /MUST[\s\S]{0,40}重跑一次 `classify-bounded` 取得新鮮 `dispatch_id`/,
    "must require a fresh classify-bounded re-run when an intervening commit is unavoidable",
  );

  const blocks = read(".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md");
  assert.match(
    blocks,
    /It is HEAD-sensitive \(the digest input includes `head_sha`\)/,
    "subagent-dispatch-blocks.md's dispatch_id explanation must carry the same HEAD-sensitivity reminder",
  );
});
