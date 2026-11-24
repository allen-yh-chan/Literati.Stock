/**
 * hook-pre-tool-gate-context-headroom-gate-order.test.mjs
 *
 * Task 10 regression: Gate CH (`context-headroom-circuit-breaker`) must be
 * evaluated after every existing BLOCKING-bucket gate (HARD | STATE_BACKED)
 * in BASH_BLOCKING_GATES — design.md D5's ordering requirement.
 *
 * These are structural assertions against the live gate array, not a
 * behavioral replay of existing cross-model / Gate 3b coverage.
 * `checkCrossModelMergeGate` (incl. Path D′) and Gate 3b
 * (`archive-before-push-or-pr-create`) already have dedicated test files —
 * hook-pre-tool-gate-cross-model-merge.test.mjs,
 * hook-pre-tool-gate-cross-model-path-d-prime.test.mjs,
 * hook-pre-tool-gate-archive-before-push.test.mjs — and none of their
 * source was touched when Gate CH was added (task 9 only appended one new
 * entry at the tail of BASH_BLOCKING_GATES); those files staying green in
 * the full suite IS the "existing tests green, behavior unchanged" evidence
 * (see decisions.md Task 10 for the citation).
 *
 * Gate CH's own command matcher (render-second-review-packet.mjs /
 * run-test-suite.mjs) is disjoint from checkCrossModelMergeGate's
 * (`gh pr merge ...`) and Gate 3b's (`git push` / `gh pr create`) matchers —
 * no single command string can trigger both, so a same-command dual-trigger
 * replay is not a sound way to prove D5. An order assertion against the
 * live array is.
 *
 * Scope note: BASH_BLOCKING_GATES, not the flattened ACTIVE_GATE_INVENTORY.
 * ACTIVE_GATE_INVENTORY = [...BASH_BLOCKING_GATES, ...BASH_STATE_UPDATE_GATES,
 * ...BASH_ADVISORY_GATES, ...WRITE_BLOCKING_GATES] concatenates gate arrays
 * from DIFFERENT tool-dispatch pipelines (Bash vs. Write/Edit/MultiEdit)
 * that never compete for evaluation order in the same hook invocation — a
 * global "last blocking-bucket entry" scan over it would spuriously compare
 * Gate CH against e.g. `protected-branch-file-write` (WRITE_BLOCKING_GATES),
 * which cannot ever run in the same PreToolUse call as a Bash-only gate.
 * BASH_BLOCKING_GATES is the actual single array runGateInventory() iterates
 * for a Bash payload (see `runGateInventory(BASH_BLOCKING_GATES, ctx)` at
 * the top of evaluatePreToolUsePayload), so it is the only array where an
 * "evaluated after" ordering claim is meaningful.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoFileUrl } from "./lib/repo-root.mjs";

const MODULE_URL = repoFileUrl(".devpro/scripts/hooks/pre-tool-gate.mjs");

test("Gate CH (context-headroom-circuit-breaker) is evaluated after cross-model-sticky-merge-review in BASH_BLOCKING_GATES", async () => {
  const { BASH_BLOCKING_GATES } = await import(MODULE_URL + `?t=${Date.now()}`);
  const ids = BASH_BLOCKING_GATES.map((g) => g.id);
  const chIndex = ids.indexOf("context-headroom-circuit-breaker");
  const crossModelIndex = ids.indexOf("cross-model-sticky-merge-review");
  assert.ok(chIndex >= 0, "context-headroom-circuit-breaker must be registered in BASH_BLOCKING_GATES");
  assert.ok(crossModelIndex >= 0, "cross-model-sticky-merge-review must be registered in BASH_BLOCKING_GATES");
  assert.ok(
    chIndex > crossModelIndex,
    `Gate CH (index ${chIndex}) must be evaluated after cross-model-sticky-merge-review (index ${crossModelIndex}) — design.md D5 ordering requirement`,
  );
});

test("Gate CH is the LAST entry among all BLOCKING-bucket (HARD | STATE_BACKED) gates in BASH_BLOCKING_GATES", async () => {
  const { BASH_BLOCKING_GATES, GATE_BUCKETS } = await import(MODULE_URL + `?t=${Date.now()}`);
  const blockingBuckets = new Set([GATE_BUCKETS.HARD, GATE_BUCKETS.STATE_BACKED]);
  const blockingGateIds = BASH_BLOCKING_GATES.filter((g) => blockingBuckets.has(g.bucket)).map((g) => g.id);
  assert.ok(
    blockingGateIds.length > 1,
    "sanity: there must be more than one blocking-bucket gate to make this assertion meaningful",
  );
  assert.equal(
    blockingGateIds[blockingGateIds.length - 1],
    "context-headroom-circuit-breaker",
    `Gate CH must be the last blocking-bucket gate evaluated in BASH_BLOCKING_GATES; blocking gate order was: ${blockingGateIds.join(", ")}`,
  );
});

test("archive-before-push-or-pr-create (Gate 3b) remains in the ADVISORY bucket, unaffected by Gate CH's registration", async () => {
  const { ACTIVE_GATE_INVENTORY, GATE_BUCKETS } = await import(MODULE_URL + `?t=${Date.now()}`);
  const gate3b = ACTIVE_GATE_INVENTORY.find((g) => g.id === "archive-before-push-or-pr-create");
  assert.ok(gate3b, "archive-before-push-or-pr-create (Gate 3b) must still be registered");
  assert.equal(
    gate3b.bucket,
    GATE_BUCKETS.ADVISORY,
    "Gate 3b must remain advisory-bucket — a HARD/STATE_BACKED gate ordering claim does not apply to it",
  );
});
