import "./lib/isolated-control-evidence-state.mjs";
/**
 * hook-pre-tool-gate-cross-model-path-d-prime.test.mjs
 *
 * TDD tests for the Path D′ fresh-equivalent merge-gate carve-out (Group B,
 * strengthen-cross-review-loop-termination R3/R4). Covers:
 *   TB1/TB2 — `evaluateFreshEquivalent` (fresh-equivalent-compare.mjs) against
 *             the design.md D2 judgement table (rows #1-#5, positive, and the
 *             outside-whitelist reverse example), using the
 *             `.devpro/scripts/tests/fixtures/loop-termination/` fixture set.
 *   TB3     — `checkCrossModelMergeGate`'s Path D carve-out (pre-tool-gate.mjs),
 *             end-to-end for the positive fixture and the outside-whitelist
 *             reverse example.
 *   TB4′    — parity: pre-tool-gate.mjs calls `evaluateFreshEquivalent`
 *             directly in Path D; post-pr-completion-check.mjs calls it
 *             indirectly via `resolveStickyFreshness` at the snapshot layer,
 *             deriving `reviewedHeadRefOid`, which every dispatch/marker/
 *             completion "is this current for the PR head" comparison uses
 *             instead of the raw live headRefOid. This file asserts the
 *             source-text shape of that wiring and shared-export judgement
 *             parity; `hook-post-pr-completion-path-d-prime.test.mjs` asserts
 *             full functional (spawned Stop hook) reachability.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateFreshEquivalent,
  PATH_D_PRIME_WHITELIST,
} from "../hooks/lib/fresh-equivalent-compare.mjs";
import { checkCrossModelMergeGate } from "../hooks/pre-tool-gate.mjs";
import {
  defaultPostPrCompletionDir,
  postPrCompletionDir,
} from "../hooks/lib/post-pr-completion-state.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures", "loop-termination");
const PRE_TOOL_GATE_SOURCE = readFileSync(
  path.join(TEST_DIR, "../hooks/pre-tool-gate.mjs"),
  "utf8"
);
const POST_PR_COMPLETION_SOURCE = readFileSync(
  path.join(TEST_DIR, "../hooks/post-pr-completion-check.mjs"),
  "utf8"
);

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));
}

// ── Mock env plumbing ───────────────────────────────────────────────────────

const COMPARE_MOCK_ENV_KEYS = [
  "CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT",
  "CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_ERROR",
];

/**
 * Apply a fixture's `compare` field as the corresponding mock env var, run
 * `fn`, then restore. `compare.error` (string) → COMPARE_ERROR mock;
 * `compare.status`/`compare.files` (object) → COMPARE_OUTPUT mock (the raw
 * `compare` sub-object re-serialized as the simulated `gh api` stdout body).
 */
function withFixtureCompareEnv(fixture, fn) {
  const saved = {};
  for (const k of COMPARE_MOCK_ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of COMPARE_MOCK_ENV_KEYS) delete process.env[k];
    if (typeof fixture.compare?.error === "string") {
      process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_ERROR = fixture.compare.error;
    } else {
      process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT = JSON.stringify(fixture.compare);
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function evaluateFixture(fixture) {
  return withFixtureCompareEnv(fixture, () =>
    evaluateFreshEquivalent({
      lastReviewedSha: fixture.sticky.last_reviewed_sha,
      headRefOid: fixture.prData.headRefOid,
      repoSlug: null,
      cwd: process.cwd(),
    })
  );
}

// ── TB1/TB2: evaluateFreshEquivalent against the D2 judgement table ────────

describe("evaluateFreshEquivalent — D2 judgement table (fixture-driven)", () => {
  test("PDP-1: positive fixture — whitelist-only diff → fresh_equivalent true", () => {
    const fixture = loadFixture("path-d-prime-positive");
    const result = evaluateFixture(fixture);
    assert.equal(result.fresh_equivalent, true, JSON.stringify(result));
    assert.equal(result.reason, "path-d-prime-whitelist-only");
  });

  test("PDP-2: reverse example — files gains a non-whitelisted rule leaf → block", () => {
    const fixture = loadFixture("path-d-prime-negative-outside-whitelist");
    const result = evaluateFixture(fixture);
    assert.equal(result.fresh_equivalent, false, JSON.stringify(result));
    assert.equal(result.reason, "path-d-prime-whitelist-miss");
  });

  test("PDP-2b: specs path segment under openspec/changes/** → whitelist miss (issue #2413 F-ea5e4c895069)", () => {
    const fixture = loadFixture("path-d-prime-negative-specs-segment");
    const result = evaluateFixture(fixture);
    assert.equal(result.fresh_equivalent, false, JSON.stringify(result));
    assert.equal(result.reason, "path-d-prime-whitelist-miss");
  });

  test("PDP-2c: substring myspecs must NOT trip the specs path-segment exclusion", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT = JSON.stringify({
      status: "ahead",
      files: [{ filename: "openspec/changes/example/myspecs/notes.md" }],
    });
    try {
      const result = evaluateFreshEquivalent({
        lastReviewedSha: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        headRefOid: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        repoSlug: null,
        cwd: process.cwd(),
      });
      assert.equal(result.fresh_equivalent, true, JSON.stringify(result));
      assert.equal(result.reason, "path-d-prime-whitelist-only");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT;
    }
  });

  test("PDP-3: row #1 — gh spawn/exit failure or non-JSON stdout → compare-unavailable", () => {
    const fixture = loadFixture("path-d-prime-negative-1-compare-unavailable");
    const result = evaluateFixture(fixture);
    assert.equal(result.fresh_equivalent, false, JSON.stringify(result));
    assert.equal(result.reason, "compare-unavailable");
  });

  test("PDP-4: row #2 — HTTP 404/422 → compare-unavailable (real gh CLI maps this to a non-zero exit, same code path as row #1)", () => {
    const fixture = loadFixture("path-d-prime-negative-2-http-error");
    const result = evaluateFixture(fixture);
    assert.equal(result.fresh_equivalent, false, JSON.stringify(result));
    assert.equal(result.reason, "compare-unavailable");
  });

  test("PDP-5: row #3 — status: diverged (non-ancestor) → compare-status-not-ancestor", () => {
    const fixture = loadFixture("path-d-prime-negative-3-diverged");
    const result = evaluateFixture(fixture);
    assert.equal(result.fresh_equivalent, false, JSON.stringify(result));
    assert.equal(result.reason, "compare-status-not-ancestor");
  });

  test("PDP-6: row #4 — files missing entirely → compare-files-invalid", () => {
    const fixture = loadFixture("path-d-prime-negative-4-files-invalid");
    const result = evaluateFixture(fixture);
    assert.equal(result.fresh_equivalent, false, JSON.stringify(result));
    assert.equal(result.reason, "compare-files-invalid");
  });

  test("PDP-6b: row #4 variant — files present but an element is missing `filename` → compare-files-invalid (inline, not a fixture file)", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT = JSON.stringify({
      status: "ahead",
      files: [{ filename: "notes/tmp/ok.md" }, { sha: "deadbeef" }],
    });
    try {
      const result = evaluateFreshEquivalent({
        lastReviewedSha: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        headRefOid: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        repoSlug: null,
        cwd: process.cwd(),
      });
      assert.equal(result.fresh_equivalent, false, JSON.stringify(result));
      assert.equal(result.reason, "compare-files-invalid");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT;
    }
  });

  test("PDP-7: row #5 — files.length >= 300 (truncated) → compare-files-truncated, even though every listed file is whitelist-only", () => {
    const fixture = loadFixture("path-d-prime-negative-5-files-truncated");
    assert.ok(fixture.compare.files.length >= 300, "fixture must actually hit the truncation boundary");
    const result = evaluateFixture(fixture);
    assert.equal(result.fresh_equivalent, false, JSON.stringify(result));
    assert.equal(result.reason, "compare-files-truncated");
  });

  test("PDP-8: prefix-boundary — a path that merely contains 'notes/' as a nested substring must NOT match the notes/ whitelist prefix", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT = JSON.stringify({
      status: "ahead",
      files: [{ filename: ".devpro/agent-rules/notes/x.md" }],
    });
    try {
      const result = evaluateFreshEquivalent({
        lastReviewedSha: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        headRefOid: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        repoSlug: null,
        cwd: process.cwd(),
      });
      assert.equal(result.fresh_equivalent, false, JSON.stringify(result));
      assert.equal(result.reason, "path-d-prime-whitelist-miss");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT;
    }
  });

  test("PDP-9: documented edge case — empty files array with status ahead is vacuously whitelist-only (no files to violate the whitelist)", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT = JSON.stringify({
      status: "ahead",
      files: [],
    });
    try {
      const result = evaluateFreshEquivalent({
        lastReviewedSha: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        headRefOid: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        repoSlug: null,
        cwd: process.cwd(),
      });
      assert.equal(result.fresh_equivalent, true, JSON.stringify(result));
      assert.equal(result.reason, "path-d-prime-whitelist-only");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT;
    }
  });

  test("PDP-10: abbreviated (short) last_reviewed_sha is fail-closed (compare-invalid-sha-shape), even under mock", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT = JSON.stringify({
      status: "ahead",
      files: [{ filename: "notes/tmp/ok.md" }],
    });
    try {
      const result = evaluateFreshEquivalent({
        lastReviewedSha: "a1a1a1a", // 7 hex chars — valid per the sticky parser, invalid here
        headRefOid: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        repoSlug: null,
        cwd: process.cwd(),
      });
      assert.equal(result.fresh_equivalent, false, JSON.stringify(result));
      assert.equal(result.reason, "compare-invalid-sha-shape");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT;
    }
  });

  test("PDP-11: PATH_D_PRIME_WHITELIST is exactly the two D12 prefixes", () => {
    assert.deepEqual([...PATH_D_PRIME_WHITELIST].sort(), ["notes/", "openspec/changes/"]);
  });

  test("PDP-12: all 8 D2-scoped fixtures exist and load as JSON", () => {
    const expected = [
      "path-d-prime-positive",
      "path-d-prime-negative-outside-whitelist",
      "path-d-prime-negative-specs-segment",
      "path-d-prime-negative-1-compare-unavailable",
      "path-d-prime-negative-2-http-error",
      "path-d-prime-negative-3-diverged",
      "path-d-prime-negative-4-files-invalid",
      "path-d-prime-negative-5-files-truncated",
    ];
    const present = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    for (const name of expected) {
      assert.ok(present.includes(name), `missing fixture: ${name}`);
      assert.doesNotThrow(() => loadFixture(name), `fixture ${name} must be valid JSON`);
    }
  });
});

// ── TB3: checkCrossModelMergeGate Path D carve-out (end-to-end) ────────────

const MAGIC_MARKER = "<!-- cross-model-second-opinion:sticky -->";
const PR_NUMBER = "8888";
const PROPOSAL_PATH = "openspec/changes/loop-termination-fixture/proposal.md";

function buildStickyBody({ verdict, lastReviewedSha }) {
  return [
    MAGIC_MARKER,
    "## Cross-Model Second Opinion Review",
    "",
    "Some review content here.",
    "",
    `verdict: ${verdict}`,
    `last_reviewed_sha: ${lastReviewedSha}`,
    "dispatch_id: dispatch-path-d-prime-test",
    "reason: The bounded review completed for the requested scope.",
    "Rules: v6.93.0 · Tool: Claude Code · Model: claude-test",
  ].join("\n");
}

function buildPrJson(fixture) {
  return JSON.stringify({
    headRefOid: fixture.prData.headRefOid,
    headRefName: "feature/path-d-prime-fixture",
    baseRefName: fixture.prData.baseRefName || "main",
    comments: [
      {
        id: "C_0",
        url: `https://github.com/example/repo/pull/${PR_NUMBER}#issuecomment-0`,
        body: buildStickyBody({
          verdict: fixture.sticky.verdict,
          lastReviewedSha: fixture.sticky.last_reviewed_sha,
        }),
      },
    ],
  });
}

const GATE_MOCK_ENV_KEYS = [
  "CROSS_MODEL_MERGE_GATE_MOCK_BRANCH",
  "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES",
  "CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT",
  ...COMPARE_MOCK_ENV_KEYS,
];

function runGateWithFixture(fixture) {
  const saved = {};
  for (const k of GATE_MOCK_ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of GATE_MOCK_ENV_KEYS) delete process.env[k];
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_BRANCH = "feature/path-d-prime-fixture";
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES = PROPOSAL_PATH;
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = buildPrJson(fixture);
    if (typeof fixture.compare?.error === "string") {
      process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_ERROR = fixture.compare.error;
    } else {
      process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT = JSON.stringify(fixture.compare);
    }
    return checkCrossModelMergeGate(`gh pr merge ${PR_NUMBER} --merge`, process.cwd());
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// The merge gate also reads local post-PR markers. Reading the shared checkout
// state lets markers another test or session is writing during a parallel run
// turn into `marker_unreadable` and flip these fixtures to a different block.
test("merge gate fixtures read an isolated post-PR state dir, not the shared checkout state", () => {
  assert.notEqual(postPrCompletionDir(process.cwd()), defaultPostPrCompletionDir(process.cwd()));
});

describe("checkCrossModelMergeGate — Path D′ carve-out (TB3)", () => {
  test("PDP-13: (a) positive fixture → Path D′ carve-out fires, gate passes (null)", () => {
    const fixture = loadFixture("path-d-prime-positive");
    const result = runGateWithFixture(fixture);
    assert.equal(result, null, `expected pass, got: ${JSON.stringify(result)}`);
  });

  test("PDP-14: (a) reverse example → carve-out does not apply, gate still blocks with reason mentioning Path D", () => {
    const fixture = loadFixture("path-d-prime-negative-outside-whitelist");
    const result = runGateWithFixture(fixture);
    assert.equal(result?.block, true, `expected block, got: ${JSON.stringify(result)}`);
    assert.match(result.reason, /Path D/);
    assert.match(result.reason, /last_reviewed_sha/i);
  });

  test("PDP-15: each of the five D2 judgement-table negatives still blocks with reason mentioning Path D", () => {
    const negatives = [
      "path-d-prime-negative-1-compare-unavailable",
      "path-d-prime-negative-2-http-error",
      "path-d-prime-negative-3-diverged",
      "path-d-prime-negative-4-files-invalid",
      "path-d-prime-negative-5-files-truncated",
    ];
    for (const name of negatives) {
      const fixture = loadFixture(name);
      const result = runGateWithFixture(fixture);
      assert.equal(result?.block, true, `${name}: expected block, got: ${JSON.stringify(result)}`);
      assert.match(result.reason, /Path D/, `${name}: reason should mention Path D`);
    }
  });
});

// ── TB4′ parity ──────────────────────────────────────────────────────────
//
// TB4′ (superseding the original TB4 wiring): post-pr-completion-check.mjs's
// Path D′ parity moved from the deep completion-receipt comparison to the
// snapshot layer — `resolveStickyFreshness` (used by both `mockPrSnapshot`
// and `snapshotFromGhData`) calls the shared `evaluateFreshEquivalent`
// export and derives `snapshot.reviewedHeadRefOid`, which every
// "is this dispatch/marker current for the PR head" comparison
// (`isAuthoritativeCurrentHeadPass`, `assertDispatchMatchesCurrentSnapshot`,
// and the completion-receipt consistency check) now compares against instead
// of the raw live `snapshot.headRefOid`. This makes the carve-out reachable
// end-to-end — see `hook-post-pr-completion-path-d-prime.test.mjs` for the
// full functional (spawned Stop hook) proof of that reachability. What is
// asserted below is (1) the source-text shape of that wiring, and (2) the
// shared export itself returns an identical judgement for the same
// fixture-derived input triple regardless of which caller's shape invokes it.

describe("TB4′ parity — shared evaluateFreshEquivalent authority", () => {
  test("PDP-16: pre-tool-gate.mjs's Path D branch calls evaluateFreshEquivalent (source-text assertion)", () => {
    assert.match(PRE_TOOL_GATE_SOURCE, /evaluateSecondReviewEvidence\(/);
    const shared = readFileSync(path.join(TEST_DIR, "../hooks/lib/github-review-policy.mjs"), "utf8");
    const pathDIndex = shared.indexOf("// Path D: stale sha check");
    assert.ok(pathDIndex >= 0, "Path D stale sha check block not found");
    const window = shared.slice(pathDIndex, pathDIndex + 1500);
    assert.match(window, /evaluateFreshEquivalentEvidence\(/, "Path D block must call evaluateFreshEquivalent");
  });

  test("PDP-17: post-pr-completion-check.mjs's resolveStickyFreshness calls evaluateFreshEquivalent, and reviewedHeadRefOid gates the dispatch/marker/completion checks (source-text assertion)", () => {
    const resolveIndex = POST_PR_COMPLETION_SOURCE.indexOf("function resolveStickyFreshness(");
    assert.ok(resolveIndex >= 0, "resolveStickyFreshness not found");
    const resolveWindow = POST_PR_COMPLETION_SOURCE.slice(resolveIndex, resolveIndex + 1500);
    assert.match(resolveWindow, /evaluateFreshEquivalent\(/, "resolveStickyFreshness must call evaluateFreshEquivalent");
    assert.match(resolveWindow, /reviewedHeadRefOid/);

    assert.match(
      POST_PR_COMPLETION_SOURCE,
      /function isAuthoritativeCurrentHeadPass[\s\S]{0,300}snapshot\.reviewedHeadRefOid\s*===\s*marker\.head_ref_oid/,
      "isAuthoritativeCurrentHeadPass must compare against reviewedHeadRefOid, not the raw live headRefOid"
    );
    assert.match(
      POST_PR_COMPLETION_SOURCE,
      /function assertDispatchMatchesCurrentSnapshot[\s\S]{0,900}dispatch\.head_ref_oid\s*!==\s*snapshot\.reviewedHeadRefOid/,
      "assertDispatchMatchesCurrentSnapshot must compare against reviewedHeadRefOid"
    );

    const completionIndex = POST_PR_COMPLETION_SOURCE.indexOf("const completion = verifiedEvidence.completion;");
    assert.ok(completionIndex >= 0, "completion evidence read not found");
    const completionWindow = POST_PR_COMPLETION_SOURCE.slice(completionIndex, completionIndex + 1500);
    assert.match(
      completionWindow,
      /completion\.sticky_last_reviewed_sha\s*!==\s*snapshot\.reviewedHeadRefOid/,
      "completion-receipt consistency check must compare against reviewedHeadRefOid"
    );
  });

  test("PDP-18: identical (lastReviewedSha, headRefOid, repoSlug) triple yields identical judgement regardless of caller shape", () => {
    const fixture = loadFixture("path-d-prime-positive");
    const direct = withFixtureCompareEnv(fixture, () =>
      evaluateFreshEquivalent({
        lastReviewedSha: fixture.sticky.last_reviewed_sha,
        headRefOid: fixture.prData.headRefOid,
        repoSlug: "devpro-tw/devpro-agent-rules",
        cwd: process.cwd(),
      })
    );
    // Simulate the post-pr-completion-check.mjs call shape: same triple, same
    // shared export, invoked a second time with the same mock env applied the
    // same way a second call site would.
    const viaCompletionShape = withFixtureCompareEnv(fixture, () =>
      evaluateFreshEquivalent({
        lastReviewedSha: fixture.sticky.last_reviewed_sha,
        headRefOid: fixture.prData.headRefOid,
        repoSlug: "devpro-tw/devpro-agent-rules",
        cwd: process.cwd(),
      })
    );
    assert.deepEqual(direct, viaCompletionShape);
    assert.equal(direct.fresh_equivalent, true);
  });
});
