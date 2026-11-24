import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import {
  blockingCostThresholds,
  deriveChangeNameFromBranch,
  evaluatePostPrCostBudget,
  evaluateOverrideDisclosure,
  formatExpectedOverrideDisclosureLines,
  reportedCostThresholds,
} from "../hooks/lib/post-pr-cost-circuit-breaker.mjs";
import { resolveExactOneChangeWorktreeBinding } from "../hooks/lib/admission-record.mjs";
import { evaluateCostBudget } from "../lib/cost-budget.mjs";
import { parseCostBudgetOverride } from "../lib/cost-budget-override.mjs";
import { appendChangeUsageOverride } from "../hooks/lib/change-usage-checkpoint.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import {
  withChangeUsageStateDir,
  seedResolvableChangeCostUsage,
} from "./lib/change-usage-fixtures.mjs";

function makeCwdWithActiveChangeFolder(changeName) {
  const cwd = makeTempDir("devpro-post-pr-ccb-cwd-");
  mkdirSync(path.join(cwd, "openspec", "changes", changeName), { recursive: true });
  return cwd;
}

// ---- deriveChangeNameFromBranch --------------------------------------------

test("deriveChangeNameFromBranch: strips each of the five known prefixes", () => {
  assert.equal(deriveChangeNameFromBranch("feature/foo"), "foo");
  assert.equal(deriveChangeNameFromBranch("bugfix/foo"), "foo");
  assert.equal(deriveChangeNameFromBranch("chore/foo"), "foo");
  assert.equal(deriveChangeNameFromBranch("hotfix/foo"), "foo");
  assert.equal(deriveChangeNameFromBranch("rules/foo"), "foo");
});

test("deriveChangeNameFromBranch: unrecognized prefix or no slash passes through unstripped", () => {
  assert.equal(deriveChangeNameFromBranch("release/foo"), "release/foo");
  assert.equal(deriveChangeNameFromBranch("mainlikebranch"), "mainlikebranch");
});

test("deriveChangeNameFromBranch: non-string or empty input resolves empty string", () => {
  assert.equal(deriveChangeNameFromBranch(undefined), "");
  assert.equal(deriveChangeNameFromBranch(null), "");
  assert.equal(deriveChangeNameFromBranch(""), "");
});

// ---- evaluatePostPrCostBudget ----------------------------------------------

test("evaluatePostPrCostBudget: malformed branch-derived change_name resolves unavailable thresholds, not exceeded", () => {
  const cwd = makeTempDir("devpro-post-pr-ccb-cwd-");
  const { result } = evaluatePostPrCostBudget({ branch: "chore/Has-Uppercase", prNumber: "1", cwd });
  assert.equal(result.exceeded, false);
  assert.equal(result.thresholds.output.state, "unavailable");
});

test("evaluatePostPrCostBudget: valid grammar but no matching change folder resolves unavailable, not exceeded", () => {
  const cwd = makeTempDir("devpro-post-pr-ccb-cwd-");
  const { result } = evaluatePostPrCostBudget({ branch: "chore/no-such-change", prNumber: "1", cwd });
  assert.equal(result.exceeded, false);
  assert.equal(result.thresholds.output.state, "unavailable");
});

test("evaluatePostPrCostBudget: resolvable change under threshold resolves ok, not exceeded", () => {
  withChangeUsageStateDir(() => {
    const changeName = "under-threshold-change";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "11111111-1111-1111-1111-111111111111",
      outputTokens: 10,
    });
    const { result } = evaluatePostPrCostBudget({
      branch: `chore/${changeName}`,
      prNumber: "1",
      cwd,
      env: { HOME: cwd, DEVPRO_TEST_CLAUDE_ROOT: claudeRoot },
    });
    assert.equal(result.exceeded, false);
    assert.equal(result.thresholds.output.state, "ok");
  });
});

test("evaluatePostPrCostBudget: resolvable change over threshold resolves exceeded with output in exceeded_thresholds", () => {
  withChangeUsageStateDir(() => {
    const changeName = "over-threshold-change";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "22222222-2222-2222-2222-222222222222",
      outputTokens: 900_000, // clears COST_BUDGET_THRESHOLDS.output (see cost-budget.mjs)
    });
    const { changeName: resolvedChangeName, result } = evaluatePostPrCostBudget({
      branch: `chore/${changeName}`,
      prNumber: "1",
      cwd,
      env: { HOME: cwd, DEVPRO_TEST_CLAUDE_ROOT: claudeRoot },
    });
    assert.equal(resolvedChangeName, changeName);
    assert.equal(result.exceeded, true);
    assert.equal(result.exceeded_thresholds.includes("output"), true);
  });
});

// ---- evaluateOverrideDisclosure ---------------------------------------------

test("evaluateOverrideDisclosure: malformed change_name resolves unavailable without a folder check (D12 F-5-5)", () => {
  // Folder exists (created below) — proves the grammar failure short-circuits
  // BEFORE the folder existence check is even attempted, not merely that the
  // outcome happens to coincide with a missing-folder case.
  const cwd = makeCwdWithActiveChangeFolder("Has-Uppercase");
  const result = evaluateOverrideDisclosure({ branch: "chore/Has-Uppercase", prBody: "N/A", cwd });
  assert.equal(result.status, "unavailable");
});

test("evaluateOverrideDisclosure: valid grammar but folder does not exist resolves unavailable", () => {
  const cwd = makeTempDir("devpro-post-pr-ccb-cwd-");
  const result = evaluateOverrideDisclosure({ branch: "chore/no-such-change", prBody: "N/A", cwd });
  assert.equal(result.status, "unavailable");
});

test("evaluateOverrideDisclosure: folder exists but checkpoint was never written resolves unavailable", () => {
  const cwd = makeCwdWithActiveChangeFolder("no-checkpoint-change");
  const result = evaluateOverrideDisclosure({ branch: "chore/no-checkpoint-change", prBody: "N/A", cwd });
  assert.equal(result.status, "unavailable");
});

test("evaluateOverrideDisclosure: prBody undefined/null resolves unavailable, not block (F-c3472c23)", () => {
  // Checkpoint is genuinely resolvable (folder + written checkpoint) — proves
  // the prBody==null short-circuit fires on its own axis, not as a
  // coincidental side effect of an unrelated unavailable path above.
  withChangeUsageStateDir(() => {
    const changeName = "prbody-unavailable-change";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "44444444-4444-4444-4444-444444444444",
      outputTokens: 1,
    });
    const undefinedResult = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: undefined, cwd });
    assert.equal(undefinedResult.status, "unavailable");
    const nullResult = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: null, cwd });
    assert.equal(nullResult.status, "unavailable");
  });
});

test("evaluateOverrideDisclosure: prBody genuinely empty string (fetched, not missing) still resolves block, not unavailable", () => {
  // Locks in the F-c3472c23 fix boundary: `prBody == null` is unavailable,
  // but a successfully fetched, verifiably empty body is a known state the
  // gate must still enforce against — it MUST NOT be widened to falsy.
  withChangeUsageStateDir(() => {
    const changeName = "prbody-empty-string-change";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "55555555-5555-5555-5555-555555555555",
      outputTokens: 1,
    });
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: "", cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: empty overrides[] (checkpoint exists, never appended) + N/A body resolves ok", () => {
  withChangeUsageStateDir(() => {
    const changeName = "true-empty-overrides-na";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "33333333-3333-3333-3333-333333333333",
      outputTokens: 1,
    });
    const body = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "ok");
  });
});

test("evaluateOverrideDisclosure: empty overrides[] + N/A: <reason> body resolves ok (ledger-style)", () => {
  withChangeUsageStateDir(() => {
    const changeName = "true-empty-overrides-na-reason";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "33333333-3333-3333-3333-333333333334",
      outputTokens: 1,
    });
    const body = "## Cost Circuit Breaker Overrides\nN/A: no overrides this change cycle\n";
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "ok");
  });
});

test("evaluateOverrideDisclosure: empty overrides[] + - N/A: <reason> body resolves ok", () => {
  withChangeUsageStateDir(() => {
    const changeName = "true-empty-overrides-dash-na-reason";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "33333333-3333-3333-3333-333333333335",
      outputTokens: 1,
    });
    const body = "## Cost Circuit Breaker Overrides\n- N/A: no overrides this change cycle\n";
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "ok");
  });
});

test("evaluateOverrideDisclosure: empty overrides[] + bare N/A: (no reason) resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "true-empty-overrides-na-colon-empty";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "33333333-3333-3333-3333-333333333336",
      outputTokens: 1,
    });
    const body = "## Cost Circuit Breaker Overrides\nN/A:\n";
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: empty overrides[] + -N/A (no space after hyphen) resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "true-empty-overrides-tight-dash-na";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "33333333-3333-3333-3333-333333333337",
      outputTokens: 1,
    });
    const body = "## Cost Circuit Breaker Overrides\n-N/A\n";
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: empty overrides[] + N/A: next-line reason resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "true-empty-overrides-na-next-line-reason";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "33333333-3333-3333-3333-333333333338",
      outputTokens: 1,
    });
    const body = "## Cost Circuit Breaker Overrides\nN/A:\nno overrides\n";
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: empty overrides[] + N/A: whitespace-only reason resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "true-empty-overrides-na-ws-reason";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "33333333-3333-3333-3333-333333333339",
      outputTokens: 1,
    });
    const body = "## Cost Circuit Breaker Overrides\nN/A:   \t  \n";
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: shipped PR template verbatim (empty overrides[]) resolves ok (F-69e4833c regression)", () => {
  withChangeUsageStateDir(() => {
    const changeName = "shipped-template-empty-overrides";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "66666666-6666-6666-6666-666666666666",
      outputTokens: 1,
    });
    const template = readFileSync(repoPath(".github/PULL_REQUEST_TEMPLATE.md"), "utf8");
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: template, cwd });
    assert.equal(result.status, "ok");
  });
});

test("evaluateOverrideDisclosure: empty overrides[] + section missing entirely resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "empty-overrides-missing-section";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "44444444-4444-4444-4444-444444444444",
      outputTokens: 1,
    });
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: "## Some Other Section\nhi\n", cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: empty overrides[] + section present but not exactly N/A resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "empty-overrides-not-na";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "55555555-5555-5555-5555-555555555555",
      outputTokens: 1,
    });
    const body = "## Cost Circuit Breaker Overrides\nsome stray note\n";
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "block");
  });
});

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

test("evaluateOverrideDisclosure: non-empty overrides[] + missing section resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "nonempty-overrides-missing-section";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: "## Some Other Section\nhi\n", cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: non-empty overrides[] + N/A section resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "nonempty-overrides-na-section";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: "## Cost Circuit Breaker Overrides\nN/A\n", cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: exact single-triple match resolves ok", () => {
  withChangeUsageStateDir(() => {
    const changeName = "single-triple-match";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const body = `## Cost Circuit Breaker Overrides\n- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_A}\n`;
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "ok");
  });
});

test("evaluateOverrideDisclosure: non-empty overrides[] with the shipped template's comment left above real entries resolves ok (F-69e4833c regression)", () => {
  withChangeUsageStateDir(() => {
    const changeName = "shipped-template-nonempty-overrides";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const template = readFileSync(repoPath(".github/PULL_REQUEST_TEMPLATE.md"), "utf8");
    // Isolate the shipped section's own comment via plain string ops (not a
    // document-wide regex, which backtracks across unrelated `<!-- -->`
    // blocks elsewhere in the template and grabs the wrong one).
    const afterHeading = template.split("## Cost Circuit Breaker Overrides\n")[1];
    const shippedComment = afterHeading ? afterHeading.split("\n- N/A")[0] : "";
    assert.ok(
      shippedComment.startsWith("<!--") && shippedComment.trimEnd().endsWith("-->"),
      "shipped template must still contain the Cost Circuit Breaker Overrides instructional comment",
    );
    const body = `## Cost Circuit Breaker Overrides\n${shippedComment}\n- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_A}\n`;
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "ok");
  });
});

test("evaluateOverrideDisclosure: millisecond/offset formatting differences on `at` do not cause a false mismatch (F-3-4 seconds-precision normalization)", () => {
  withChangeUsageStateDir(() => {
    const changeName = "at-formatting-tolerant";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.123Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const body = `## Cost Circuit Breaker Overrides\n- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_A}\n`;
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "ok");
  });
});

test("evaluateOverrideDisclosure: thresholds listed in a different order than the checkpoint still match (order-insensitive comparison)", () => {
  withChangeUsageStateDir(() => {
    const changeName = "thresholds-order-insensitive";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output", "cache_read"], head_ref_oid: HEAD_A });
    const body = `## Cost Circuit Breaker Overrides\n- at=2026-01-01T00:00:00Z thresholds=cache_read,output head_ref_oid=${HEAD_A}\n`;
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "ok");
  });
});

test("evaluateOverrideDisclosure: multiple distinct matching triples resolve ok", () => {
  withChangeUsageStateDir(() => {
    const changeName = "multi-triple-match";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    appendChangeUsageOverride({ cwd, changeName, session_id: "s2", at: "2026-01-02T00:00:00.000Z", thresholds: ["cache_read", "model_time"], head_ref_oid: HEAD_B });
    const body = [
      "## Cost Circuit Breaker Overrides",
      `- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_A}`,
      `- at=2026-01-02T00:00:00Z thresholds=cache_read,model_time head_ref_oid=${HEAD_B}`,
      "",
    ].join("\n");
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "ok");
  });
});

test("evaluateOverrideDisclosure: mismatched `at` resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "mismatch-at";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const body = `## Cost Circuit Breaker Overrides\n- at=2026-01-02T00:00:00Z thresholds=output head_ref_oid=${HEAD_A}\n`;
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: mismatched thresholds set resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "mismatch-thresholds";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const body = `## Cost Circuit Breaker Overrides\n- at=2026-01-01T00:00:00Z thresholds=cache_read head_ref_oid=${HEAD_A}\n`;
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: mismatched head_ref_oid resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "mismatch-head-ref-oid";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const body = `## Cost Circuit Breaker Overrides\n- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_B}\n`;
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: unparseable line resolves block", () => {
  withChangeUsageStateDir(() => {
    const changeName = "unparseable-line";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const body = "## Cost Circuit Breaker Overrides\n- this is not the canonical format at all\n";
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: multiplicity mismatch — checkpoint has two identical triples, PR body lists one, resolves block (F-4-2)", () => {
  withChangeUsageStateDir(() => {
    const changeName = "multiplicity-mismatch-checkpoint-heavy";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    appendChangeUsageOverride({ cwd, changeName, session_id: "s2", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const body = `## Cost Circuit Breaker Overrides\n- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_A}\n`;
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "block");
  });
});

test("evaluateOverrideDisclosure: multiplicity mismatch — checkpoint has one triple, PR body lists it twice, resolves block (F-4-2)", () => {
  withChangeUsageStateDir(() => {
    const changeName = "multiplicity-mismatch-body-heavy";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const line = `- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_A}`;
    const body = `## Cost Circuit Breaker Overrides\n${line}\n${line}\n`;
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
    assert.equal(result.status, "block");
  });
});

// ---- evaluateOverrideDisclosure: a block names the lines the PR body should hold ----
//
// A block that only says "does not match" leaves the author to rebuild the canonical lines by hand:
// `at` as UTC ISO8601 seconds, `thresholds` ASCII-ascending, rows ascending by `at`. The block carries
// `expectedLines`, derived from the checkpoint with the same normalizers the comparison uses, so the
// stop point can print what to write instead of only what is wrong.

test("evaluateOverrideDisclosure: every non-empty-overrides block carries the canonical lines the PR body should hold", () => {
  const bodies = [
    ["section missing", "## Some Other Section\nhi\n"],
    ["N/A section", "## Cost Circuit Breaker Overrides\nN/A\n"],
    ["unparseable line", "## Cost Circuit Breaker Overrides\n- this is not the canonical format at all\n"],
    ["mismatched triple", `## Cost Circuit Breaker Overrides\n- at=2026-01-02T00:00:00Z thresholds=output head_ref_oid=${HEAD_A}\n`],
  ];
  bodies.forEach(([label, body], index) => {
    withChangeUsageStateDir(() => {
      const changeName = `expected-lines-${index}`;
      const cwd = makeCwdWithActiveChangeFolder(changeName);
      appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
      const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd });
      assert.equal(result.status, "block", label);
      assert.deepEqual(result.expectedLines, [`- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_A}`], label);
    });
  });
});

test("evaluateOverrideDisclosure: expectedLines are sorted and normalized, and the same gate accepts them verbatim", () => {
  withChangeUsageStateDir(() => {
    const changeName = "expected-lines-round-trip";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    // Appended out of order, with milliseconds and thresholds the author would have to re-sort.
    appendChangeUsageOverride({ cwd, changeName, session_id: "s2", at: "2026-01-02T03:04:05.678Z", thresholds: ["output", "cache_read"], head_ref_oid: HEAD_B });
    appendChangeUsageOverride({ cwd, changeName, session_id: "s1", at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A });
    const blocked = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: "## Cost Circuit Breaker Overrides\nN/A\n", cwd });
    assert.equal(blocked.status, "block");
    assert.deepEqual(blocked.expectedLines, [
      `- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_A}`,
      `- at=2026-01-02T03:04:05Z thresholds=cache_read,output head_ref_oid=${HEAD_B}`,
    ]);
    const body = `## Cost Circuit Breaker Overrides\n${blocked.expectedLines.join("\n")}\n`;
    assert.equal(evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: body, cwd }).status, "ok");
  });
});

test("evaluateOverrideDisclosure: an empty-overrides block carries no expectedLines (the only valid body is N/A)", () => {
  withChangeUsageStateDir(() => {
    const changeName = "expected-lines-empty-overrides";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "66666666-6666-6666-6666-666666666666",
      outputTokens: 1,
    });
    const result = evaluateOverrideDisclosure({ branch: `chore/${changeName}`, prBody: "## Cost Circuit Breaker Overrides\nsome stray note\n", cwd });
    assert.equal(result.status, "block");
    assert.equal(Object.hasOwn(result, "expectedLines"), false);
  });
});

test("formatExpectedOverrideDisclosureLines: returns null when an entry cannot be written in the canonical format", () => {
  const entry = { at: "2026-01-01T00:00:00.000Z", thresholds: ["output"], head_ref_oid: HEAD_A };
  assert.deepEqual(formatExpectedOverrideDisclosureLines([entry]), [`- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_A}`]);
  assert.equal(formatExpectedOverrideDisclosureLines([]), null);
  assert.equal(formatExpectedOverrideDisclosureLines(undefined), null);
  assert.equal(formatExpectedOverrideDisclosureLines([{ ...entry, at: "not-a-date" }]), null);
  assert.equal(formatExpectedOverrideDisclosureLines([{ ...entry, head_ref_oid: "short" }]), null);
  assert.equal(formatExpectedOverrideDisclosureLines([{ ...entry, thresholds: [] }]), null);
  assert.equal(formatExpectedOverrideDisclosureLines([entry, { ...entry, at: "not-a-date" }]), null);
});

// ---- T12: the stall signal, and which states stop this hook ----------------
//
// notes item `## 109.` in one sentence: the circuit breaker measured change
// size (cumulative token totals) and called it waste. T4 took the totals'
// gate away in every consumer; T12 gives this one the signal that actually
// means "not converging" — consecutive review rounds whose open finding set
// never shrank. D19 row 3 keeps the stop point and swaps only the signal, and
// D20 fixes which states of that signal stop.

function makeRepoCwdWithActiveChangeFolder(changeName) {
  const cwd = makeCwdWithActiveChangeFolder(changeName);
  const run = (args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  return cwd;
}

// The receipt the stall loader would read, with bytes it cannot parse. This is
// D20's `unavailable` reached for real, not simulated: a receipt exists, so
// something SHOULD have been read, and it could not be.
function seedUnreadableReceipt(cwd, changeName) {
  const notes = path.join(cwd, "notes");
  mkdirSync(notes, { recursive: true });
  const file = path.join(notes, `review-${changeName}-receipt-r1.json`);
  writeFileSync(file, "this is not a sealed receipt\n");
  return file;
}

const STALL_STATES = ["not-applicable", "ok", "exhausted", "unavailable"];

test("blockingCostThresholds: the three cumulative totals do not stop this hook, whatever their values", () => {
  // The T4/S9 regression at the decision level rather than through a spawned
  // hook: all three totals over at once, nothing else, and the answer is still
  // "nothing blocks". If a later change re-adds one of them to the blocking
  // set, this fails here first.
  const result = evaluateCostBudget({
    usage: { totals: { output: 9_000_000, cache_read: 900_000_000, model_time_ms: 99_999_999 } },
    prNumber: "none",
  });
  assert.deepEqual(result.exceeded_thresholds, ["output", "cache_read", "model_time"],
    "precondition: all three really are exceeded, so the empty verdict below is not vacuous");
  assert.deepEqual(blockingCostThresholds(result), []);
  assert.deepEqual(reportedCostThresholds(result), ["output", "cache_read", "model_time"],
    "they stop blocking, they do not stop being reported (D14)");
});

test("blockingCostThresholds: stalled_rounds stops on exhausted AND on unavailable", () => {
  const forStall = (state, streak = null) =>
    blockingCostThresholds(evaluateCostBudget({ reviewStall: { state, streak } }));

  // D20's table, read straight down.
  assert.deepEqual(forStall("not-applicable"), [], "a change that never ran a review round has no stall to stop for");
  assert.deepEqual(forStall("ok", 1), [], "a chain that read and is converging does not stop anything");
  assert.deepEqual(forStall("exhausted", 2), ["stalled_rounds"]);
  assert.deepEqual(forStall("unavailable"), ["stalled_rounds"],
    "receipts exist but the chain would not load: the gate's own input is damaged, so it must not read as clean");
});

test("reportedCostThresholds: an unavailable stall is declarable, so the block it causes has the same exit as every other", () => {
  // D20 promises "出口與 exhausted 完全相同——既有的具名 override". The override
  // match is EXACT-SET (D11) against whatever the caller passes as the
  // exceeded set. An `unavailable` stall exceeds nothing, so passing
  // `exceeded_thresholds` would hand the resolver an empty set — which no
  // non-empty declaration can ever equal, making the block unclearable. This
  // test is that promise, not a shape assertion.
  const result = evaluateCostBudget({ prNumber: "none", reviewStall: { state: "unavailable", streak: null } });
  assert.deepEqual(result.exceeded_thresholds, [], "precondition: nothing is exceeded, which is what makes the union necessary");
  assert.deepEqual(blockingCostThresholds(result), ["stalled_rounds"], "precondition: it does block");

  const declarable = reportedCostThresholds(result);
  assert.deepEqual(declarable, ["stalled_rounds"]);
  assert.deepEqual(
    parseCostBudgetOverride("some-change:stalled_rounds", { changeName: "some-change", exceededThresholds: declarable }),
    { authorized: true, reason: "authorized", declared_thresholds: ["stalled_rounds"] },
    "the user can name the key that stopped them",
  );
  assert.equal(
    parseCostBudgetOverride("some-change:stalled_rounds", { changeName: "some-change", exceededThresholds: result.exceeded_thresholds }).reason,
    "not_exact_set",
    "and against the exceeded set alone they could not — this is the failure the union removes",
  );
});

test("reportedCostThresholds: an already-declared output,stalled_rounds override still matches exactly (T4's pin)", () => {
  // The other direction. Narrowing the resolver's input to the blocking subset
  // would turn a user's existing `output,stalled_rounds` declaration into a
  // mismatch and block someone who was previously let through — demoting a
  // threshold takes away its gate, not the meaning of an existing declaration.
  const result = {
    exceeded_thresholds: ["output", "stalled_rounds"],
    thresholds: { output: { state: "exceeded" }, stalled_rounds: { state: "exceeded" } },
  };
  assert.deepEqual(reportedCostThresholds(result), ["output", "stalled_rounds"], "table order, and unchanged by the union");
  assert.equal(
    parseCostBudgetOverride("c:output,stalled_rounds", { changeName: "c", exceededThresholds: reportedCostThresholds(result) }).authorized,
    true,
  );
});

test("reportedCostThresholds: an exhausted stall needs no union — it is already exceeded", () => {
  const result = evaluateCostBudget({ prNumber: "none", reviewStall: { state: "exhausted", streak: 2 } });
  assert.deepEqual(result.exceeded_thresholds, ["stalled_rounds"]);
  assert.deepEqual(reportedCostThresholds(result), ["stalled_rounds"],
    "identical to the exceeded set, which is what makes the two blocking states share one exit");
});

test("evaluatePostPrCostBudget: a cwd outside any repo resolves the stall not-applicable, not unavailable", () => {
  // This is the premise every other test in this file and in
  // hook-post-pr-completion-cost-circuit-breaker.test.mjs runs on: their temp
  // cwds are not repos. Before T12's core-loader split the loader answered
  // `unavailable` here, which D19 row 3 blocks on — every one of those turns
  // would have stopped, and a real Stop taken outside a repo with it. Nothing
  // should have been read, so nothing failed to be read (D20 row 1).
  const cwd = makeTempDir("devpro-post-pr-ccb-nonrepo-");
  const { result } = evaluatePostPrCostBudget({ branch: "chore/some-change", prNumber: "1", cwd });
  assert.deepEqual(result.thresholds.stalled_rounds, { value: null, limit: null, state: "not-applicable" });
  assert.deepEqual(blockingCostThresholds(result), []);
});

test("evaluatePostPrCostBudget: a real repo whose change has sealed no receipt resolves not-applicable", () => {
  const changeName = "stall-no-receipts";
  const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
  const { result } = evaluatePostPrCostBudget({ branch: `chore/${changeName}`, prNumber: "1", cwd });
  assert.deepEqual(result.thresholds.stalled_rounds, { value: null, limit: null, state: "not-applicable" });
  assert.deepEqual(blockingCostThresholds(result), [],
    "a gate about review rounds must not stop a change that has never run one");
});

test("evaluatePostPrCostBudget: a real repo whose only receipt cannot be read resolves unavailable and blocks", () => {
  // The default resolver, end to end, with no injection: this proves the
  // production wiring reaches the real loader over the real notes root that
  // `derivedNotesRoot` computes from the repo — not just that an injected
  // stub is passed through.
  const changeName = "stall-unreadable-receipt";
  const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
  seedUnreadableReceipt(cwd, changeName);
  const { result } = evaluatePostPrCostBudget({ branch: `chore/${changeName}`, prNumber: "1", cwd });
  assert.equal(result.thresholds.stalled_rounds.state, "unavailable");
  assert.equal(result.thresholds.stalled_rounds.value, null, "no streak was measured, and 0 would claim one was");
  assert.deepEqual(blockingCostThresholds(result), ["stalled_rounds"]);
  assert.equal(result.exceeded, false, "and it is still not `exceeded` — which is exactly why the reported set is a union");
});

test("evaluatePostPrCostBudget: a branch that is not a change name never asks about a stall", () => {
  // `release/foo` passes through `deriveChangeNameFromBranch` unstripped, so
  // the derived id is not a change name at all. Asking the loader would answer
  // `not-applicable` anyway; the guard is what keeps a git+readdir probe off
  // every marker of every Stop turn for names that cannot have receipts.
  const cwd = makeRepoCwdWithActiveChangeFolder("unused-change");
  const { result } = evaluatePostPrCostBudget({ branch: "release/foo", prNumber: "1", cwd });
  assert.deepEqual(result.thresholds.stalled_rounds, { value: null, limit: null, state: "not-applicable" });
});

test("evaluatePostPrCostBudget: the loader's verdict is what reaches the threshold table, for all four states", () => {
  // The seam between the loader and the evaluator, driven from this side. The
  // loader's own four states are proven against real sealed chains in
  // review-remediation-evidence.test.mjs; what is proven here is that this
  // function hands them over unaltered, including the streak.
  const cwd = makeTempDir("devpro-post-pr-ccb-stub-");
  const expected = {
    "not-applicable": { value: null, limit: null, state: "not-applicable" },
    ok: { value: 1, limit: null, state: "ok" },
    exhausted: { value: 2, limit: null, state: "exceeded" },
    unavailable: { value: null, limit: null, state: "unavailable" },
  };
  for (const state of STALL_STATES) {
    const streak = state === "ok" ? 1 : state === "exhausted" ? 2 : null;
    let asked = null;
    const { result } = evaluatePostPrCostBudget({
      branch: "chore/stub-change",
      prNumber: "1",
      cwd,
      resolveReviewStall: (input) => {
        asked = input;
        return { state, streak };
      },
    });
    assert.equal(asked?.changeName, "stub-change", `${state}: the resolver is asked about the branch-derived change name`);
    assert.deepEqual(result.thresholds.stalled_rounds, expected[state], `${state}: reaches the table unaltered`);
  }
});

// fix-second-review-loop-friction T1 prove-it (D13 P5, half 2; design.md D3;
// workflow-cost-controls ADDED "Pr-Sticky Round Extension Has A Single
// Unlock", scenario "Cost evaluation never reports a round threshold"): RED
// against base — `POST_PR_BLOCKING_COST_THRESHOLD_STATES` still keys `round`
// to `["exceeded"]` (line 169 of post-pr-cost-circuit-breaker.mjs), so an
// exceeded round threshold still blocks the post-PR Stop hook. Built as a
// hand-crafted `result` object, the same style as the adjacent "round only on
// exceeded" test above — no sidecar fixture needed.
test("Scenario: Cost evaluation never reports a round threshold (post-PR blockingCostThresholds set)", () => {
  const result = { thresholds: { round: { state: "exceeded" }, stalled_rounds: { state: "ok" } } };
  assert.deepEqual(blockingCostThresholds(result), [], "an exceeded round threshold must not block the post-PR hook; round is not a blocking key at all");
});

// fix-codex-reviewer-intent-candidate-cap T2e (prove-it, R6): the stall observation this hook feeds into the Cost
// Circuit Breaker. Over-cap fixtures need no production seam and no constant edit: a test-process wrapper around
// child_process.spawnSync("git", ...) pads the `git worktree list --porcelain -z` output with duplicate main-checkout
// entries up to 129 (a path without a `.worktree/` segment) and forwards every other git call; it is always restored.
function withPaddedWorktreeList({ padListTo, padPath }, run) {
  const original = childProcess.spawnSync;
  let listCalls = 0;
  childProcess.spawnSync = function shimmedSpawnSync(file, args, options) {
    const result = original.apply(this, arguments);
    if (file === "git" && Array.isArray(args) && args[0] === "worktree" && args[1] === "list" && args.includes("-z") && result.status === 0) {
      listCalls += 1;
      const raw = String(result.stdout);
      const have = (raw.match(/\0\0/gu) ?? []).length;
      return { ...result, stdout: raw + `worktree ${padPath}\0HEAD ${"a".repeat(40)}\0\0`.repeat(Math.max(0, padListTo - have)) };
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    return { value: run(), listCalls: () => listCalls };
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
}

test("Over-Cap Worktree Enumeration Maps To Unavailable: an over-cap worktree list makes the post-PR stalled_rounds threshold unavailable and blocking", () => {
  const changeName = "stall-over-cap-ccb";
  const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
  const control = evaluatePostPrCostBudget({ branch: `chore/${changeName}`, prNumber: "1", cwd });
  assert.equal(control.result.thresholds.stalled_rounds.state, "not-applicable", "control: inside the cap a change without receipts is not-applicable");

  const over = withPaddedWorktreeList({ padListTo: 129, padPath: realpathSync(cwd) }, () => (
    evaluatePostPrCostBudget({ branch: `chore/${changeName}`, prNumber: "1", cwd })
  ));
  assert.equal(over.listCalls(), 1, "the 129-entry worktree list was really consumed");
  assert.deepEqual(over.value.result.thresholds.stalled_rounds, { value: null, limit: null, state: "unavailable" },
    "an unknown receipt location is not an absence of receipts");
  assert.deepEqual(blockingCostThresholds(over.value.result), ["stalled_rounds"]);
});

test("Other Binding Resolution Faults Stay Not-Applicable: a worktree scan fault does not block the post-PR stall threshold", () => {
  const changeName = "stall-scan-fault-ccb";
  const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
  spawnSync("git", ["-C", cwd, "commit", "-q", "--allow-empty", "-m", "seed"], { encoding: "utf8" });
  // A registered but deleted, unpruned worktree makes the enumeration incomplete (intent-scan-failed).
  const linked = path.join(cwd, ".worktree", changeName);
  mkdirSync(path.dirname(linked), { recursive: true });
  const added = spawnSync("git", ["-C", cwd, "worktree", "add", "-q", "-b", "stall-scan-fault-linked", linked, "HEAD"], { encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  rmSync(linked, { recursive: true, force: true });
  assert.deepEqual(resolveExactOneChangeWorktreeBinding({ cwd, changeId: changeName }), { ok: false, code: "intent-scan-failed" },
    "fixture: the binding resolution really fails with the scan fault");
  const { result } = evaluatePostPrCostBudget({ branch: `chore/${changeName}`, prNumber: "1", cwd });
  assert.deepEqual(result.thresholds.stalled_rounds, { value: null, limit: null, state: "not-applicable" },
    "only the candidate cap became unavailable; the scan fault keeps its existing mapping");
  assert.deepEqual(blockingCostThresholds(result), []);
});
