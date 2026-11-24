/**
 * D12/D11 post-PR-check half of the cost circuit breaker (task 7).
 * `render-second-review-packet.mjs` (task 6) is the pre-dispatch enforcement
 * carrier; this module is the post-PR-round carrier — `post-pr-completion-
 * check.mjs` calls it once per marker, after that marker's PR snapshot is
 * known. See `openspec/changes/add-change-cost-circuit-breaker/design.md`
 * D11 (Override 值語意 / S-1) and D12 (canonical change-identity input).
 *
 * Two independent mechanisms live here, deliberately not merged into one
 * function — they degrade to `unavailable` for overlapping reasons (same
 * change_name/checkpoint resolution) but block on entirely different
 * conditions and consume different inputs (checkpoint usage totals vs.
 * checkpoint overrides[] + PR body content):
 *   - `evaluatePostPrCostBudget` — the D10 threshold evaluation (same
 *     evaluator task 6 calls), fed by branch-name-derived change usage and,
 *     since `fix-zero-value-review-rounds` D19 row 3, by the review-stall
 *     observation this module loads for the same change name.
 *   - `evaluateOverrideDisclosure` — D11 §S-1 PR-body/checkpoint
 *     override-disclosure cross-check (multiset comparison, F-4-2).
 */
import {
  CHANGE_NAME_GRAMMAR,
  changeNameFolderExists,
  resolveChangeCostUsage,
} from "../../lib/resolve-change-cost-usage.mjs";
import { COST_BUDGET_THRESHOLDS, evaluateCostBudget } from "../../lib/cost-budget.mjs";
import { queryReviewStallState } from "../../review-remediation-evidence.mjs";
import { readChangeUsageCheckpoint } from "./change-usage-checkpoint.mjs";
import { extractSection } from "../../lib/clarification-contract.mjs";
// D7 point 2 (fix-second-review-loop-friction, T6): moved to its own
// dependency-free module so render-second-review-packet.mjs's round-override
// disclosure planner can reuse the SAME predicate without pulling this
// file's heavier transitive imports (review-remediation-evidence.mjs,
// clarification-contract.mjs) into the renderer's dependency graph.
// Re-exported here unchanged so every existing importer of
// `deriveChangeNameFromBranch` from THIS module keeps working.
import { deriveChangeNameFromBranch } from "../../lib/derive-change-name-from-branch.mjs";

export { deriveChangeNameFromBranch };

/**
 * D10 cost-budget evaluation for a post-PR-round marker. `branch` is the
 * marker/snapshot's `headRefName`. change_name resolution (grammar +
 * active/archive folder existence + checkpoint read) is entirely
 * `resolveChangeCostUsage`'s job (task 6) — reused as-is per D12's "兩處對稱
 * 處理" requirement, not reimplemented here. `usage: undefined` (any
 * resolution failure) flows straight into `evaluateCostBudget`, whose own
 * fail-open guard degrades thresholds (a)(b)(c) to `unavailable` — this
 * function adds no second failure path. There is no `prNumber` input any
 * more (`fix-second-review-loop-friction` D1/D3): the cost circuit breaker
 * has no pr-sticky-round-scoped threshold left to feed.
 *
 * `resolveReviewStall` is the second injection point, defaulting to
 * `defaultResolveReviewStall` below. It is NOT cached the way `resolveUsage`
 * is at the Stop-hook call site: a stall is the signal that now stops this
 * hook, and a stop that a caller's TTL could delay by a full turn is a stop
 * the change did not buy.
 *
 * That decision does not rest on the read being cheap, and must not be
 * defended as though it were: the read is a receipt-candidate listing, then
 * `latestReceipt`, then a full `walkReceiptAuthorityChain` -- subprocesses
 * proportional to the number of sealed rounds, run per pending marker per Stop
 * turn. What makes it affordable is the shape of its input rather than the
 * size of the read. The chain grows by exactly one round per sealed review, so
 * it stays short for the whole life of a change, and it is bounded by the very
 * number this change exists to keep small. The usage cache exists for the
 * opposite shape: transcript aggregation whose cost grows with session length,
 * which nothing bounds.
 *
 * `enumerationMemo` (optional, passed only by the Stop hook's marker loop) is a different
 * thing from that cache: it lets the stall observation reuse one successfully completed
 * worktree MEMBER LIST across the markers of one hook run. It never caches a stall
 * result, so the "no TTL, no delayed stop" rule above stands: every marker still
 * resolves its binding, lists its receipts and walks its chain fresh, and a failed
 * enumeration is never reused. A value that is not a real handle is refused by the
 * facade and lands in `defaultResolveReviewStall`'s catch as `unavailable`.
 *
 * `resolveUsage` is an injection point, defaulting to `resolveChangeCostUsage`
 * itself (so every existing caller/test is unaffected). `post-pr-completion-
 * check.mjs`'s Stop-hook call site overrides it with a TTL-cached resolver —
 * that hook's marker loop runs on every Stop turn, not once per review round,
 * so an uncached call here would re-read every session transcript in the
 * change's checkpoint on every single turn (see decisions.md's task 7
 * cost-usage-cache finding). This function itself stays cache-agnostic:
 * `resolveReviewStall` (the `stalled_rounds` observation, see above) is never
 * routed through that cache and always runs fresh on every call, so a stall
 * breach is never delayed by the usage cache's TTL.
 */
export function evaluatePostPrCostBudget({
  branch,
  cwd = process.cwd(),
  env = process.env,
  resolveUsage = resolveChangeCostUsage,
  resolveReviewStall = defaultResolveReviewStall,
  enumerationMemo,
} = {}) {
  const changeName = deriveChangeNameFromBranch(branch);
  const usage = resolveUsage({ changeName, cwd, env });
  const reviewStall = resolveReviewStall({ changeName, cwd, ...(enumerationMemo === undefined ? {} : { enumerationMemo }) });
  const result = evaluateCostBudget({ usage, reviewStall });
  return { changeName, result };
}

/**
 * `fix-zero-value-review-rounds` D19 row 3: the stall observation for one
 * marker. This is the SAME loader the report surface uses
 * (`report-session-token-usage.mjs --budget-check`) — the core's
 * `queryReviewStallState`, which delegates the streak rule to
 * `review-stall-budget.mjs` and to nothing else. Gate and report therefore
 * answer one question from one chain, which is D9/D10's seam and not something
 * this file is allowed to re-decide.
 *
 * The grammar guard lives here rather than in the loader because the two
 * callers differ in what they can promise about their change id.
 * `--budget-check` requires `--since-change`, so its id is always one a user
 * named; this one derives its id from a branch name that may be empty, may be
 * `main`, or may belong to a namespace this repo does not own. Asking the
 * loader about those resolves `not-applicable` anyway (there are no receipts
 * under a name nobody sealed) — the guard exists so that the ANSWER is reached
 * without a filesystem/git probe per marker per Stop turn for names that
 * cannot have receipts, not to change what the answer is.
 *
 * The observation enters through the production façade
 * (`review-remediation-evidence.mjs`), not the internal core factory: that
 * boundary is asserted, and the façade's input guard is what refuses a
 * production caller the core's mutation seams.
 *
 * A failure to construct or reach it degrades to `unavailable`, the same as a
 * damaged chain, and therefore blocks (D20). `queryReviewStallState` itself
 * never throws, so this catch is reached only when the module that owns the
 * rule could not be loaded at all — the gate cannot tell whether the change has
 * stalled, which is FAIL CLOSED's own case. The exit is the one D20 promises
 * for every blocking state: the existing named `DEVPRO_COST_BUDGET_OVERRIDE`,
 * which `reportedCostThresholds` below keeps declarable.
 */
function defaultResolveReviewStall({ changeName, cwd = process.cwd(), enumerationMemo } = {}) {
  if (!CHANGE_NAME_GRAMMAR.test(String(changeName ?? ""))) {
    return { state: "not-applicable", streak: null };
  }
  try {
    return queryReviewStallState({
      repoRoot: cwd,
      changeId: changeName,
      ...(enumerationMemo === undefined ? {} : { enumerationMemo }),
    });
  } catch {
    return { state: "unavailable", streak: null };
  }
}

// D19 row 3 / fix-second-review-loop-friction D3: the thresholds that still
// stop the post-PR Stop hook, and D20: which of their states do it. The three
// cumulative totals are not among them (R1) — a total cannot show whether
// anything is being wasted, so it cannot be what asks the user to stop. There
// is no cost-side `round` threshold to include here any more either
// (fix-second-review-loop-friction D1): extending pr-sticky review rounds is
// entirely the round gate's own `DEVPRO_REVIEW_ROUND_OVERRIDE` concern.
//
// `stalled_rounds` blocks on `unavailable` as well as on `exceeded` (D20): an
// unreadable receipt chain is THIS gate's own input being damaged while the
// change demonstrably has receipts, so a silent pass would be the "訊號看起來
// 在守、實際沒守" state the change exists to remove.
export const POST_PR_BLOCKING_COST_THRESHOLD_STATES = Object.freeze({
  stalled_rounds: Object.freeze(["exceeded", "unavailable"]),
});

/** The blocking thresholds this result actually trips, in table order. */
export function blockingCostThresholds(result) {
  return Object.keys(POST_PR_BLOCKING_COST_THRESHOLD_STATES).filter((key) =>
    POST_PR_BLOCKING_COST_THRESHOLD_STATES[key].includes(result?.thresholds?.[key]?.state),
  );
}

/**
 * The keys one marker reports, and — when it blocks — the exact set a
 * `DEVPRO_COST_BUDGET_OVERRIDE` has to declare to clear it: `exceeded_thresholds`
 * UNION whatever is blocking in a state that is not `exceeded`.
 *
 * The union, not either half. Passing `exceeded_thresholds` alone would leave
 * the one state D20 newly makes blocking — `stalled_rounds` `unavailable`,
 * with nothing else over — with an empty key list: nothing to print, and, the
 * override match being exact-set against an empty set that no non-empty
 * declaration can equal, no override able to clear it. That is a stop with no
 * exit, the opposite of what D20 promises ("出口與 `exhausted` 完全相同").
 * Passing the blocking subset alone would break the other direction, which T4
 * pinned: an already-declared `output,stalled_rounds` would stop matching and
 * block a user who was previously let through. Demoting a threshold takes
 * away its gate, not the meaning of an existing declaration.
 */
export function reportedCostThresholds(result) {
  const exceeded = result?.exceeded_thresholds ?? [];
  const blocking = blockingCostThresholds(result);
  return Object.keys(COST_BUDGET_THRESHOLDS).filter((key) => exceeded.includes(key) || blocking.includes(key));
}

// ---- D11 §S-1 override-disclosure cross-check -----------------------------

const OVERRIDE_LINE_RE = /^- at=(\S+) thresholds=(\S+) head_ref_oid=([0-9a-f]{40})$/;

// F-3-4: both sides normalize `at` to UTC ISO8601 seconds precision before
// comparing, so millisecond/offset formatting differences are not false
// mismatches. `null` signals "not a parseable date" — propagated as a value
// that cannot equal any valid triple's key, rather than thrown.
function normalizeAtSeconds(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// F-3-4 (display) + F-4-2 (comparison note): the PR-body author sorts
// ASCII-ascending for human readability, but the comparison itself is
// deliberately order-insensitive on both sides — this normalizer sorts
// whichever shape it's given (array from the checkpoint, or a comma-joined
// string parsed from a PR body line) so accidental input-order differences
// are never mistaken for real content mismatches.
function normalizeThresholds(thresholds) {
  const arr = Array.isArray(thresholds) ? thresholds : String(thresholds ?? "").split(",");
  return arr.map((t) => String(t).trim()).filter(Boolean).sort().join(",");
}

function tripleKey(t) {
  return `${t.at}\u0000${t.thresholds}\u0000${t.head_ref_oid}`;
}

function buildMultiset(triples) {
  const counts = new Map();
  for (const t of triples) {
    const key = tripleKey(t);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// F-4-2: multiset (bag) equality — every distinct triple's occurrence count
// must match exactly, not merely "present on both sides" (plain set
// equality would let a duplicated checkpoint entry pass against a PR body
// that only lists it once, or vice versa).
function multisetsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, count] of a) {
    if (b.get(key) !== count) return false;
  }
  return true;
}

function checkpointTriples(overrides) {
  return overrides.map((o) => ({
    at: normalizeAtSeconds(o.at),
    thresholds: normalizeThresholds(o.thresholds),
    head_ref_oid: String(o.head_ref_oid || ""),
  }));
}

// The `## Cost Circuit Breaker Overrides` body a non-empty overrides[] calls
// for, built with the comparison's own normalizers so `evaluateOverrideDisclosure`
// accepts it verbatim: `at` as UTC ISO8601 seconds, `thresholds` ASCII-ascending,
// rows ascending by `at`. `null` when any entry cannot be written in the
// canonical format (unparseable `at`, `thresholds` that would break the line
// grammar, a non-40-hex head) — better to print nothing than a line the gate
// would reject.
const EXPECTED_HEAD_REF_OID_RE = /^[0-9a-f]{40}$/;

export function formatExpectedOverrideDisclosureLines(overrides) {
  if (!Array.isArray(overrides) || overrides.length === 0) return null;
  const triples = checkpointTriples(overrides);
  const writable = triples.every((t) =>
    t.at !== null && /^\S+$/.test(t.thresholds) && EXPECTED_HEAD_REF_OID_RE.test(t.head_ref_oid));
  if (!writable) return null;
  return triples
    .map((t) => ({ key: tripleKey(t), line: `- at=${t.at} thresholds=${t.thresholds} head_ref_oid=${t.head_ref_oid}` }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.line);
}

// A block for a non-empty overrides[] names what the section should hold, not
// only what is wrong with it; empty when the entries cannot be written
// canonically (see `formatExpectedOverrideDisclosureLines`).
function expectedLinesOf(overrides) {
  const expectedLines = formatExpectedOverrideDisclosureLines(overrides);
  return expectedLines === null ? {} : { expectedLines };
}

// A single unparseable line invalidates the whole section (`null`) rather
// than being skipped — a line that cannot be trusted to represent a real
// triple cannot be trusted to be excluded from one either.
function parseOverrideLines(section) {
  const lines = section.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const triples = [];
  for (const line of lines) {
    const m = OVERRIDE_LINE_RE.exec(line);
    if (!m) return null;
    const atNorm = normalizeAtSeconds(m[1]);
    if (atNorm === null) return null;
    triples.push({ at: atNorm, thresholds: normalizeThresholds(m[2]), head_ref_oid: m[3] });
  }
  return triples;
}

// F-69e4833c: shipped `.github/PULL_REQUEST_TEMPLATE.md` leaves the
// authoring-instruction HTML comment directly above the default `- N/A`
// list item; `extractSection` returns the whole block verbatim, so an
// author who never touches this section (the common case) fails an
// equality check against a bare `N/A`. Stripping the comment before any
// equality/line-parse check makes gate correctness independent of whether
// the author deleted the instructional comment.
function stripTemplateHtmlComments(section) {
  return section.replace(/<!--[\s\S]*?-->/g, "");
}

// Empty-overrides declaration: bare `N/A` / `- N/A`, or the Requirement-Ledger
// style `N/A: <reason>` / `- N/A: <reason>` (same-line non-empty reason).
// Optional bullet MUST be hyphen + horizontal whitespace (reject `-N/A`).
// Colon+reason MUST stay on one line (reject next-line / whitespace-only reasons).
const EMPTY_OVERRIDE_NA_RE = /^(?:-[ \t]+)?N\/A(?:[ \t]*:[ \t]+\S[^\n]*)?$/;

function isEmptyOverrideNaDeclaration(trimmed) {
  return typeof trimmed === "string" && EMPTY_OVERRIDE_NA_RE.test(trimmed);
}

/**
 * D11 §S-1 PR-body/checkpoint override-disclosure cross-check. Returns
 * `{ status: "unavailable" }` when change_name can't be resolved, the
 * checkpoint can't be read, or the PR body itself couldn't be fetched
 * (independent third state — NEVER a block, per design.md's explicit "本交叉
 * 檢查本身 unavailable（不 block）"); otherwise `{ status: "ok" | "block",
 * changeName, reason?, expectedLines? }`. `expectedLines` rides only on a
 * block for a non-empty overrides[]: the canonical section body the author
 * should write, so the stop point can print it.
 *
 * F-c3472c23: `prBody == null` (caller's PR snapshot fetch failed, e.g. `gh`
 * unreachable — see post-pr-completion-check.mjs's `fetchPrSnapshot`
 * returning `null`) is checked BEFORE `String(prBody || "")`, and resolves
 * `unavailable`, not `block`. A body that was successfully fetched and is
 * genuinely an empty string is a materially different, known state — the
 * gate correctly still requires it to declare `N/A` below; only "we don't
 * know the body" is unavailable, not "we know it's empty."
 *
 * Resolves change_name/checkpoint access directly (grammar + folder
 * existence + `readChangeUsageCheckpoint`) rather than going through
 * `resolveChangeCostUsage` — this check only needs `overrides[]`, not a full
 * `aggregateSinceChangeUsage` usage rollup, so reusing the heavier resolver
 * would do transcript-aggregation work this check never consumes.
 */
export function evaluateOverrideDisclosure({ branch, prBody, cwd = process.cwd(), checkpointStateDir } = {}) {
  const changeName = deriveChangeNameFromBranch(branch);
  if (!CHANGE_NAME_GRAMMAR.test(changeName)) return { status: "unavailable" };
  if (!changeNameFolderExists({ changeName, cwd })) return { status: "unavailable" };
  const checkpoint = readChangeUsageCheckpoint({ cwd, changeName, stateDir: checkpointStateDir });
  if (checkpoint.status !== "ok") return { status: "unavailable" };
  if (prBody == null) return { status: "unavailable" };

  const overrides = checkpoint.overrides;
  const rawSection = extractSection(String(prBody || ""), "Cost Circuit Breaker Overrides");
  const section = rawSection === null ? null : stripTemplateHtmlComments(rawSection);

  if (overrides.length === 0) {
    const trimmed = section === null ? null : section.trim();
    if (isEmptyOverrideNaDeclaration(trimmed)) return { status: "ok", changeName };
    return {
      status: "block",
      changeName,
      reason: "checkpoint overrides[] is empty but the PR body's `## Cost Circuit Breaker Overrides` section is missing or not an accepted empty declaration (`N/A`, `- N/A`, or `N/A: <reason>`)",
    };
  }

  if (section === null) {
    return {
      status: "block",
      changeName,
      reason: "checkpoint overrides[] is non-empty but the PR body's `## Cost Circuit Breaker Overrides` section is missing",
      ...expectedLinesOf(overrides),
    };
  }
  const trimmedSection = section.trim();
  if (isEmptyOverrideNaDeclaration(trimmedSection)) {
    return {
      status: "block",
      changeName,
      reason: "checkpoint overrides[] is non-empty but the PR body's `## Cost Circuit Breaker Overrides` section is an empty declaration (`N/A` / `N/A: <reason>`)",
      ...expectedLinesOf(overrides),
    };
  }
  const parsedTriples = parseOverrideLines(section);
  if (parsedTriples === null) {
    return {
      status: "block",
      changeName,
      reason: "the PR body's `## Cost Circuit Breaker Overrides` section contains a line that does not match the canonical `- at=... thresholds=... head_ref_oid=...` format",
      ...expectedLinesOf(overrides),
    };
  }
  const checkpointSet = buildMultiset(checkpointTriples(overrides));
  const bodySet = buildMultiset(parsedTriples);
  if (!multisetsEqual(checkpointSet, bodySet)) {
    return {
      status: "block",
      changeName,
      reason: "the PR body's `## Cost Circuit Breaker Overrides` entries do not match checkpoint overrides[] (multiset comparison)",
      ...expectedLinesOf(overrides),
    };
  }
  return { status: "ok", changeName };
}
