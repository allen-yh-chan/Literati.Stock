/**
 * Tests for lib/cost-budget-override.mjs — D11 `DEVPRO_COST_BUDGET_OVERRIDE`
 * named-override consumer (task 8). Six independent negative tests + one
 * positive test per tasks.md task 8 acceptance; see design.md D11 for the
 * exact-set-match and write-gated-effectiveness rationale.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCostBudgetOverride,
  resolveCostBudgetOverride,
} from "../lib/cost-budget-override.mjs";
import { captureTlHostSession } from "../lib/session-usage-manifest.mjs";
import { readChangeUsageCheckpoint } from "../hooks/lib/change-usage-checkpoint.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

function withStateDir(fn) {
  const dir = makeTempDir("devpro-cost-budget-override-");
  const previous = process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
  process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
    else process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = previous;
  }
}

const CHANGE = "add-change-cost-circuit-breaker";
const HEAD_SHA = "a".repeat(40);

// ── Negative 1: missing ──────────────────────────────────────────────────
test("resolveCostBudgetOverride: missing env value is not effective", () => {
  withStateDir(() => {
    const result = resolveCostBudgetOverride({
      envValue: undefined,
      changeName: CHANGE,
      exceededThresholds: ["output"],
      sessionId: "session-a",
      headRefOid: HEAD_SHA,
    });
    assert.equal(result.effective, false);
    assert.equal(result.reason, "missing");
    assert.equal(readChangeUsageCheckpoint({ changeName: CHANGE }).status, "unavailable");
  });
});

// ── Negative 2: malformed ────────────────────────────────────────────────
test("resolveCostBudgetOverride: malformed env value (no colon) is not effective", () => {
  withStateDir(() => {
    const result = resolveCostBudgetOverride({
      envValue: "no-colon-here",
      changeName: CHANGE,
      exceededThresholds: ["output"],
      sessionId: "session-a",
      headRefOid: HEAD_SHA,
    });
    assert.equal(result.effective, false);
    assert.equal(result.reason, "malformed");
  });
});

test("resolveCostBudgetOverride: malformed env value (invalid threshold token shape) is not effective", () => {
  withStateDir(() => {
    const result = resolveCostBudgetOverride({
      envValue: `${CHANGE}:Output`,
      changeName: CHANGE,
      exceededThresholds: ["output"],
      sessionId: "session-a",
      headRefOid: HEAD_SHA,
    });
    assert.equal(result.effective, false);
    assert.equal(result.reason, "malformed");
  });
});

// ── Negative 3: change name mismatch ─────────────────────────────────────
test("resolveCostBudgetOverride: change name mismatch is not effective", () => {
  withStateDir(() => {
    const result = resolveCostBudgetOverride({
      envValue: "some-other-change:output",
      changeName: CHANGE,
      exceededThresholds: ["output"],
      sessionId: "session-a",
      headRefOid: HEAD_SHA,
    });
    assert.equal(result.effective, false);
    assert.equal(result.reason, "change_mismatch");
  });
});

// ── Negative 4: threshold key outside D10 table ──────────────────────────
test("resolveCostBudgetOverride: threshold key not in D10 table is not effective", () => {
  withStateDir(() => {
    const result = resolveCostBudgetOverride({
      envValue: `${CHANGE}:bogus_key`,
      changeName: CHANGE,
      exceededThresholds: ["output"],
      sessionId: "session-a",
      headRefOid: HEAD_SHA,
    });
    assert.equal(result.effective, false);
    assert.equal(result.reason, "unknown_threshold_key");
    assert.deepEqual(result.unknown_keys, ["bogus_key"]);
  });
});

// ── Negative 5: multi-exceed declaration not an exact set ────────────────
test("resolveCostBudgetOverride: declared subset of exceeded thresholds is not effective", () => {
  withStateDir(() => {
    // exceeded = {output, cache_read}; declared = {output} only — missing
    // cache_read, so this MUST NOT silently cover the undeclared dimension.
    const result = resolveCostBudgetOverride({
      envValue: `${CHANGE}:output`,
      changeName: CHANGE,
      exceededThresholds: ["output", "cache_read"],
      sessionId: "session-a",
      headRefOid: HEAD_SHA,
    });
    assert.equal(result.effective, false);
    assert.equal(result.reason, "not_exact_set");
  });
});

test("resolveCostBudgetOverride: declared superset of exceeded thresholds is not effective", () => {
  withStateDir(() => {
    // exceeded = {output} only; declared = {output, cache_read} — lists a
    // threshold that is not actually exceeded.
    const result = resolveCostBudgetOverride({
      envValue: `${CHANGE}:output,cache_read`,
      changeName: CHANGE,
      exceededThresholds: ["output"],
      sessionId: "session-a",
      headRefOid: HEAD_SHA,
    });
    assert.equal(result.effective, false);
    assert.equal(result.reason, "not_exact_set");
  });
});

// ── Negative 6 (F-5-4): overrides[] append write failure ────────────────
test("resolveCostBudgetOverride: overrides[] append write failure means NOT effective (write_failed is not written)", () => {
  withStateDir(() => {
    const result = resolveCostBudgetOverride({
      envValue: `${CHANGE}:output`,
      changeName: CHANGE,
      exceededThresholds: ["output"],
      sessionId: "session-a",
      headRefOid: HEAD_SHA,
      append: () => ({ status: "write_failed", reason: "injected EACCES" }),
    });
    assert.equal(result.effective, false);
    assert.equal(result.reason, "override_write_failed");
    assert.equal(result.write_reason, "injected EACCES");
  });
});

// ── Positive: exact-set match + successful append ────────────────────────
test("resolveCostBudgetOverride: exact-set match with successful append IS effective and overrides[] gets exactly one entry", () => {
  withStateDir(() => {
    const result = resolveCostBudgetOverride({
      envValue: `${CHANGE}:output,cache_read`,
      changeName: CHANGE,
      exceededThresholds: ["cache_read", "output"], // order-insensitive vs. declared order
      sessionId: "session-a",
      headRefOid: HEAD_SHA,
      now: () => "2026-09-01T12:00:00.000Z",
    });
    assert.equal(result.effective, true);
    assert.deepEqual(new Set(result.declared_thresholds), new Set(["output", "cache_read"]));

    const checkpoint = readChangeUsageCheckpoint({ changeName: CHANGE });
    assert.equal(checkpoint.status, "ok");
    assert.equal(checkpoint.overrides.length, 1);
    assert.equal(checkpoint.overrides[0].session_id, "session-a");
    assert.equal(checkpoint.overrides[0].at, "2026-09-01T12:00:00.000Z");
    assert.equal(checkpoint.overrides[0].head_ref_oid, HEAD_SHA);
    assert.deepEqual(new Set(checkpoint.overrides[0].thresholds), new Set(["output", "cache_read"]));
  });
});

// round 3 finding F-ce6fae98: a Stop-hook re-fires resolveCostBudgetOverride
// every turn while the threshold stays exceeded (REMIND_AFTER_MS=0). The
// second call's write must dedup at the appendChangeUsageOverride layer AND
// still report effective:true — a dedup no-op must not be misread as
// override_write_failed (that would flip an already-authorized override
// back into a block).
test("resolveCostBudgetOverride: repeated call with the same session/head/thresholds stays effective and does not duplicate overrides[]", () => {
  withStateDir(() => {
    const call = () => resolveCostBudgetOverride({
      envValue: `${CHANGE}:output,cache_read`,
      changeName: CHANGE,
      exceededThresholds: ["cache_read", "output"],
      sessionId: "session-a",
      headRefOid: HEAD_SHA,
      now: () => "2026-09-01T12:00:00.000Z",
    });
    const first = call();
    const second = call();
    assert.equal(first.effective, true);
    assert.equal(second.effective, true);

    const checkpoint = readChangeUsageCheckpoint({ changeName: CHANGE });
    assert.equal(checkpoint.overrides.length, 1);
  });
});

// ── Unresolvable session identity: treated as not effective (no partial write) ──
test("resolveCostBudgetOverride: authorized override with no resolvable sessionId is not effective and writes nothing", () => {
  withStateDir(() => {
    const result = resolveCostBudgetOverride({
      envValue: `${CHANGE}:output`,
      changeName: CHANGE,
      exceededThresholds: ["output"],
      sessionId: undefined,
      headRefOid: HEAD_SHA,
    });
    assert.equal(result.effective, false);
    assert.equal(result.reason, "session_unresolvable");
    assert.equal(readChangeUsageCheckpoint({ changeName: CHANGE }).status, "unavailable");
  });
});

// ── Unresolvable head_ref_oid: fail-closed, no partial write (F-e81f9d44) ──
// Read-side `OVERRIDE_LINE_RE` in post-pr-cost-circuit-breaker.mjs demands
// exactly 40 lowercase hex chars; each of these shapes previously wrote
// successfully with a head_ref_oid the read side could never match, leaving
// a permanent, unresolvable block. Mirrors the sessionId tests above.
for (const [label, badHeadRefOid] of [
  ["undefined", undefined],
  ["empty string", ""],
  ["uppercase hex", HEAD_SHA.toUpperCase()],
  ["wrong length", HEAD_SHA.slice(0, 39)],
]) {
  test(`resolveCostBudgetOverride: authorized override with ${label} headRefOid is not effective and writes nothing`, () => {
    withStateDir(() => {
      const result = resolveCostBudgetOverride({
        envValue: `${CHANGE}:output`,
        changeName: CHANGE,
        exceededThresholds: ["output"],
        sessionId: "session-a",
        headRefOid: badHeadRefOid,
      });
      assert.equal(result.effective, false);
      assert.equal(result.reason, "head_ref_oid_unresolvable");
      assert.equal(readChangeUsageCheckpoint({ changeName: CHANGE }).status, "unavailable");
    });
  });
}

// ── parseCostBudgetOverride: pure-function boundary (order/dup insensitivity) ──
test("parseCostBudgetOverride: exact-set comparison is order-insensitive and dedupes", () => {
  const result = parseCostBudgetOverride(`${CHANGE}:cache_read,output,output`, {
    changeName: CHANGE,
    exceededThresholds: ["output", "cache_read"],
  });
  assert.equal(result.authorized, true);
  assert.deepEqual(new Set(result.declared_thresholds), new Set(["output", "cache_read"]));
});

test("parseCostBudgetOverride: all four D1 keys can be declared together (round removed, stalled_rounds in its place)", () => {
  const result = parseCostBudgetOverride(`${CHANGE}:output,cache_read,model_time,stalled_rounds`, {
    changeName: CHANGE,
    exceededThresholds: ["stalled_rounds", "model_time", "cache_read", "output"],
  });
  assert.equal(result.authorized, true);
});

// ── fix-second-review-loop-friction T1 prove-it (D13 P4; design.md D5;
// workflow-cost-controls MODIFIED "Cost Override Effectiveness Diagnostics
// Are Named", scenario "Legacy round declaration names the round override")
// ──────────────────────────────────────────────────────────────────────────
// RED against base: `round` is still a member of COST_BUDGET_THRESHOLDS
// today, so an exact-set `<change>:round` declaration against an exceeded set
// of exactly {round} resolves `authorized`, not `unknown_threshold_key` — and
// `parseCostBudgetOverride`'s result shape has no `hint` field at all yet, on
// either token.
test("Scenario: Legacy round declaration names the round override", () => {
  for (const token of ["round", "review_round"]) {
    const result = parseCostBudgetOverride(`${CHANGE}:${token}`, {
      changeName: CHANGE,
      exceededThresholds: [token],
    });
    assert.equal(result.authorized, false, `${token}: must not be an authorized threshold`);
    assert.equal(result.reason, "unknown_threshold_key", token);
    assert.equal(typeof result.hint, "string", `${token}: base result shape has no hint field yet`);
    assert.match(result.hint ?? "", /DEVPRO_REVIEW_ROUND_OVERRIDE/, token);
  }
});

// ── Provider-neutral host session (strengthen-host-session-neutrality) ───
test("resolveCostBudgetOverride: provider-neutral host session records an authorized override (Scenario: Neutral session records a cost override on a non-claude/codex host)", () => {
  withStateDir(() => {
    const captured = captureTlHostSession({ DEVPRO_HOST_SESSION_ID: "ses_neutral01" });
    assert.equal(captured?.host, "host-neutral");
    assert.equal(captured?.session_id, "ses_neutral01");
    const result = resolveCostBudgetOverride({
      envValue: `${CHANGE}:output`,
      changeName: CHANGE,
      exceededThresholds: ["output"],
      sessionId: captured.session_id,
      headRefOid: HEAD_SHA,
      now: () => "2026-09-21T00:00:00.000Z",
    });
    assert.equal(result.effective, true);
    const checkpoint = readChangeUsageCheckpoint({ changeName: CHANGE });
    const overrides = checkpoint?.overrides ?? [];
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].session_id, "ses_neutral01");
  });
});
