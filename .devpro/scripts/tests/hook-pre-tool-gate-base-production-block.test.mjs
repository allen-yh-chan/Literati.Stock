import "./lib/isolated-control-evidence-state.mjs";
/**
 * hook-pre-tool-gate-base-production-block.test.mjs
 *
 * TDD tests for the base=production block path in checkCrossModelMergeGate.
 *
 * Design rationale:
 *   Path BP fires BEFORE Path A when prData.baseRefName === "production" and
 *   the head is not a legitimate production route.
 *   - Only the three release-carrier SSOT patterns are exempt (source SemVer
 *     release/v*, consumer date release, rules-lane release); source and
 *     consumer are symmetric (enforce-hotfix-release-carrier D1).
 *   - hotfix/* and chore/bump-v* are blocked in both repo kinds; they reach
 *     production only through a release carrier.
 *
 *   Orthogonal to cross-model review axis:
 *   - cross-model axis: hotfix/* is NEVER exempt
 *   - base-production axis: hotfix/* is NEVER exempt either (BP-5b flipped)
 *
 *   fail-open (C3): if baseRefName is absent/non-string, this path does NOT
 *   block; the PR falls through to the existing B–F sticky checks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import "./lib/owned-friction-log.mjs";
import {
  checkCrossModelMergeGate,
  hasProductionTagAt,
  isBaseProductionBlockExempt,
  isCrossModelExempt,
  isSourceRepo,
} from "../hooks/pre-tool-gate.mjs";
// Namespace import for the create-surface gate (checkProductionBasePrCreate,
// design D2): accessed as a property (never destructured as a named import) so
// this test file does NOT hard-crash at module-load time before T6 lands the
// export (ESM throws SyntaxError on a named import of a non-existent export,
// which would fail the ENTIRE file — including untouched existing HB cases —
// rather than RED just the new create-surface assertions).
import * as preToolGateNs from "../hooks/pre-tool-gate.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import childProcess, { spawnSync } from "node:child_process";
import { markSourceCheckout } from "./lib/identity-fixtures.mjs";

// ── Constants ─────────────────────────────────────────────────────────────

const PR_NUMBER = "9999";
const CURRENT_SHA = "abc1234def5678901234567890abcdef01234567";
const preToolGateSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../hooks/pre-tool-gate.mjs"),
  "utf8"
);

test("hotfix production-tag lookup passes the ref and wildcard as exact argv", () => {
  assert.doesNotMatch(preToolGateSource, /execSync\(`git tag --points-at/);
  assert.match(
    preToolGateSource,
    /spawnSync\("git", \["tag", "--points-at", ref, "production-\*"\]/
  );
  assert.match(preToolGateSource, /String\(result\.stdout \?\? ""\)\.trim\(\)/);
});

function withFakeGit(exitCode, callback) {
  const originalSpawnSync = childProcess.spawnSync;
  const calls = [];
  try {
    childProcess.spawnSync = (command, args) => {
      assert.equal(command, "git");
      calls.push(args);
      return { status: exitCode, stdout: exitCode === 0 ? "production-v-test\n" : "", stderr: "" };
    };
    syncBuiltinESMExports();
    callback({ calls });
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
}

test("production-tag lookup preserves metacharacter ref and wildcard byte-for-byte", () => {
  const ref = `ref with spaces 'double\" $(not-executed); glob*[x]`;
  withFakeGit(0, ({ calls }) => {
    assert.equal(hasProductionTagAt(ref, process.cwd()), true);
    assert.deepEqual(
      calls,
      [["tag", "--points-at", ref, "production-*"]],
    );
  });
});

test("production-tag lookup fails closed on non-zero and spawn failure", () => {
  withFakeGit(9, () => {
    assert.equal(hasProductionTagAt("HEAD", process.cwd()), false);
  });

  const emptyPath = makeTempDir("pre-tool-missing-git-");
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = emptyPath;
    assert.equal(hasProductionTagAt("HEAD", process.cwd()), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(emptyPath, { recursive: true, force: true });
  }
});

// A proposal.md path is required so that chore-A class exemption is NOT
// triggered and the gate proceeds all the way through to base-production
// block logic (or, for non-production base tests, to the sticky check).
const PROPOSAL_PATH = "openspec/changes/test-change/proposal.md";
const DIFF_WITH_PROPOSAL = PROPOSAL_PATH;

// ── Env key management ────────────────────────────────────────────────────

const CM_MOCK_ENV_KEYS = [
  "CROSS_MODEL_MERGE_GATE_MOCK_BRANCH",
  "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES",
  "CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT",
];

/**
 * Build full gh pr view JSON including baseRefName and headRefName.
 * This is local to this test file — do NOT modify the existing buildPrJson
 * in cross-model-merge.test.mjs.
 */
function buildPrJsonFull({
  baseRefName = "main",
  headRefName = "feature/foo",
  headRefOid = CURRENT_SHA,
  comments = [],
} = {}) {
  return JSON.stringify({
    baseRefName,
    headRefName,
    headRefOid,
    comments: comments.map((c, i) => ({
      id: c.id || `C_${i}`,
      url: c.url || `https://github.com/example/repo/pull/${PR_NUMBER}#issuecomment-${i}`,
      body: c.body,
    })),
  });
}

/**
 * Build a valid sticky comment body with PASS verdict and aligned sha.
 * Used to verify base-production block fires independently of sticky state.
 */
function buildPassStickyBody(sha = CURRENT_SHA) {
  return [
    "<!-- cross-model-second-opinion:sticky -->",
    "## Cross-Model Second Opinion Review",
    "",
    "Review content.",
    "",
    `verdict: PASS`,
    `last_reviewed_sha: ${sha}`,
    "dispatch_id: test-base-production-pass",
    "reason: Test fixture confirms the reviewed pull request head is approved.",
    "Rules: v1.0.0 · Tool: Claude Code · Model: claude-test",
  ].join("\n");
}

/**
 * In-process gate runner: sets mocks, calls checkCrossModelMergeGate,
 * restores env. Returns { json } where json is null (pass) or
 * { decision: "block", reason }.
 */
function runHook(command, {
  ghOutput = null,
  branch = "feature/foo",
  diffFiles = DIFF_WITH_PROPOSAL,
  extraEnv = {},
  cwd = process.cwd(),
} = {}) {
  const saved = {};
  for (const k of CM_MOCK_ENV_KEYS) saved[k] = process.env[k];
  for (const k of Object.keys(extraEnv)) {
    if (!(k in saved)) saved[k] = process.env[k];
  }
  try {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_BRANCH = branch;
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES = diffFiles;
    if (ghOutput !== null) {
      process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = ghOutput;
    } else {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT;
    }
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    const result = checkCrossModelMergeGate(command, cwd);
    const json =
      result && result.block
        ? { decision: "block", reason: result.reason }
        : null;
    return { code: 0, json };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeConsumerRepoCwd() {
  const dir = makeTempDir("bp-consumer-");
  const init = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(path.join(dir, ".gitmodules"), "[submodule \"x\"]\npath = x\nurl = ./x\n");
  writeFileSync(path.join(dir, "README"), "consumer\n");
  spawnSync("git", ["add", "."], { cwd: dir, encoding: "utf8" });
  const commit = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(isSourceRepo(dir), false, "fixture must be non-source");
  return dir;
}

function makeSourceRepoCwd() {
  const dir = makeTempDir("bp-source-");
  const init = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(path.join(dir, "README"), "source\n");
  spawnSync("git", ["add", "."], { cwd: dir, encoding: "utf8" });
  const commit = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(commit.status, 0, commit.stderr);
  markSourceCheckout(dir);
  assert.equal(isSourceRepo(dir), true, "fixture must be source (positive source identity)");
  return dir;
}

// ── Test cases ────────────────────────────────────────────────────────────

/**
 * BP-1: base=production + head=feature/foo + sticky PASS → block.
 * Base-production block fires before Path A; sticky PASS is irrelevant.
 * reason must mention both release and bypass hints.
 */
test("BP-1: base=production + head=feature/foo + sticky PASS → block (base-production path)", () => {
  const ghOutput = buildPrJsonFull({
    baseRefName: "production",
    headRefName: "feature/foo",
    headRefOid: CURRENT_SHA,
    comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    branch: "feature/foo",
    diffFiles: DIFF_WITH_PROPOSAL,
  });
  assert.equal(r.json?.decision, "block",
    `BP-1: base=production + head=feature/foo must be blocked, got: ${JSON.stringify(r.json)}`);
  // reason should mention release (the correct path to production)
  assert.match(r.json.reason, /release/i,
    `BP-1: reason should mention release/* path, got: ${r.json?.reason}`);
  // reason should mention bypass hint (hook bypass option)
  assert.match(r.json.reason, /bypass/i,
    `BP-1: reason should mention bypass option, got: ${r.json?.reason}`);
});

/**
 * BP-2: base=production + head=release/v1.2.3 → pass.
 * Source-repo release form is exempt per isSourceRepoReleaseBranchExempt.
 */
test("BP-2: base=production + head=release/v1.2.3 → pass (legitimate source release)", () => {
  const ghOutput = buildPrJsonFull({
    baseRefName: "production",
    headRefName: "release/v1.2.3",
    headRefOid: CURRENT_SHA,
    comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    branch: "release/v1.2.3",
    diffFiles: DIFF_WITH_PROPOSAL,
  });
  assert.ok(
    r.json?.decision !== "block",
    `BP-2: base=production + head=release/v1.2.3 should pass (exempt), got: ${JSON.stringify(r.json)}`
  );
});

/**
 * BP-3: base=production + head=release/20260610-abc1234 → pass.
 * Consumer-subset release form (YYYYMMDD-<7-hex>) is exempt.
 */
test("BP-3: base=production + head=release/20260610-abc1234 → pass (consumer release form)", () => {
  const ghOutput = buildPrJsonFull({
    baseRefName: "production",
    headRefName: "release/20260610-abc1234",
    headRefOid: CURRENT_SHA,
    comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    branch: "release/20260610-abc1234",
    diffFiles: DIFF_WITH_PROPOSAL,
  });
  assert.ok(
    r.json?.decision !== "block",
    `BP-3: head=release/20260610-abc1234 should pass (consumer subset release), got: ${JSON.stringify(r.json)}`
  );
});

/**
 * BP-4: base=production + head=release/garbage → block (C1: pseudo-release not exempt).
 * "release/garbage" does not match any SSOT pattern; bare /^release\// is NOT used.
 */
test("BP-4: base=production + head=release/garbage → block (C1: pseudo-release not in SSOT)", () => {
  const ghOutput = buildPrJsonFull({
    baseRefName: "production",
    headRefName: "release/garbage",
    headRefOid: CURRENT_SHA,
    comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    branch: "release/garbage",
    diffFiles: DIFF_WITH_PROPOSAL,
  });
  assert.equal(r.json?.decision, "block",
    `BP-4: release/garbage must be blocked (not a valid SSOT release pattern), got: ${JSON.stringify(r.json)}`);
});

/**
 * BP-5: source repo + base=production + head=hotfix/urgent → block.
 * Source SemVer must assemble via release/v*; hotfix/* is not Path BP exempt.
 */
test("BP-5: source base=production + head=hotfix/urgent → block (source Path BP)", () => {
  const sourceCwd = makeSourceRepoCwd();
  try {
    assert.equal(isBaseProductionBlockExempt("hotfix/urgent", sourceCwd), false);
    const ghOutput = buildPrJsonFull({
      baseRefName: "production",
      headRefName: "hotfix/urgent",
      headRefOid: CURRENT_SHA,
      comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
    });
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput,
      branch: "hotfix/urgent",
      diffFiles: DIFF_WITH_PROPOSAL,
      cwd: sourceCwd,
    });
    assert.equal(r.json?.decision, "block",
      `BP-5: source hotfix/urgent must be blocked, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /release\/v|base=production|組裝/i,
      `BP-5: reason should point to release/v* assemble, got: ${r.json?.reason}`);
    assert.match(r.json.reason, /MUST NOT 以 hook bypass 合理化/,
      `BP-5: source hotfix block must forbid bypass-rationalized direct merge, got: ${r.json?.reason}`);
    assert.doesNotMatch(r.json.reason, /確需此分支直進 production/,
      `BP-5: must not prescribe direct production entry via bypass, got: ${r.json?.reason}`);
  } finally {
    rmSync(sourceCwd, { recursive: true, force: true });
  }
});

/**
 * BP-5b (flipped, enforce-hotfix-release-carrier D1): consumer + hotfix/urgent
 * → Path BP now BLOCKS. hotfix/* no longer has a direct production route on
 * ANY repo — it must land via a frozen release carrier (isBaseProductionBlockExempt
 * is now a pure head-name predicate; no cwd/isSourceRepo branch remains).
 */
test("BP-5b (flipped): consumer base=production + head=hotfix/urgent → Path BP block", () => {
  const consumerCwd = makeConsumerRepoCwd();
  try {
    assert.equal(isBaseProductionBlockExempt("hotfix/urgent"), false);
    const ghOutput = buildPrJsonFull({
      baseRefName: "production",
      headRefName: "hotfix/urgent",
      headRefOid: CURRENT_SHA,
      comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
    });
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput,
      branch: "hotfix/urgent",
      diffFiles: DIFF_WITH_PROPOSAL,
      cwd: consumerCwd,
    });
    assert.equal(r.json?.decision, "block",
      `BP-5b (flipped): consumer hotfix/urgent must now block (no direct production route), got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /MUST NOT 以 hook bypass 合理化/,
      `BP-5b (flipped): consumer hotfix block must forbid bypass-rationalized direct merge, got: ${r.json?.reason}`);
  } finally {
    rmSync(consumerCwd, { recursive: true, force: true });
  }
});

/**
 * BP-5c: chore/bump-v* never Path BP exempt (source or consumer).
 */
test("BP-5c: base=production + head=chore/bump-v6.94.0 → block", () => {
  const sourceCwd = makeSourceRepoCwd();
  try {
    assert.equal(isBaseProductionBlockExempt("chore/bump-v6.94.0", sourceCwd), false);
    const ghOutput = buildPrJsonFull({
      baseRefName: "production",
      headRefName: "chore/bump-v6.94.0",
      headRefOid: CURRENT_SHA,
      comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
    });
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput,
      branch: "chore/bump-v6.94.0",
      diffFiles: DIFF_WITH_PROPOSAL,
      cwd: sourceCwd,
    });
    assert.equal(r.json?.decision, "block",
      `BP-5c: bump→production must be blocked, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /MUST NOT 以 hook bypass 合理化/,
      `BP-5c: source bump block must forbid bypass-rationalized direct merge, got: ${r.json?.reason}`);
  } finally {
    rmSync(sourceCwd, { recursive: true, force: true });
  }
});

/**
 * BP-6: C2 cross-axis assertion — isCrossModelExempt("hotfix/urgent") is false.
 * Proves axes remain independent even after source Path BP hard-block.
 */
test("BP-6: C2 cross-axis — isCrossModelExempt('hotfix/urgent') returns false (two axes independent)", () => {
  // hotfix/urgent with a proposal.md in diff — cross-model axis must NOT exempt
  const changedFiles = [PROPOSAL_PATH];
  const result = isCrossModelExempt("hotfix/urgent", changedFiles, process.cwd());
  assert.equal(result, false,
    `BP-6: isCrossModelExempt('hotfix/urgent') must be false (cross-model axis hotfix NOT exempt), got: ${result}`);
});

/**
 * BP-7: base=main + head=feature/foo → not blocked by base-production path.
 * The block reason must NOT mention "production" in a base-production-path context.
 * This test verifies base=main goes through existing B-F logic (Path B block: no sticky).
 */
test("BP-7: base=main + head=feature/foo → Path B block (base-production path not triggered)", () => {
  const ghOutput = buildPrJsonFull({
    baseRefName: "main",
    headRefName: "feature/foo",
    headRefOid: CURRENT_SHA,
    comments: [],  // no sticky → Path B block
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    branch: "feature/foo",
    diffFiles: DIFF_WITH_PROPOSAL,
  });
  assert.equal(r.json?.decision, "block",
    `BP-7: base=main + no sticky should block at Path B, got: ${JSON.stringify(r.json)}`);
  // Must NOT mention base=production block (the block came from Path B)
  assert.ok(
    !r.json.reason.includes("base 為 production"),
    `BP-7: block reason must not come from base-production path, got: ${r.json?.reason}`
  );
  // Path B reason contains cross-review or dp:cross-review
  assert.match(r.json.reason, /cross-review|dp:cross-review/i,
    `BP-7: block reason should be from Path B (cross-review), got: ${r.json?.reason}`);
});

/**
 * BP-8a: baseRefName absent (key missing from gh JSON) + head=feature/foo + no sticky
 * → block from Path B (fail-open: base-production path does not trigger).
 * Verifies C3: missing baseRefName → base-block does not fire; downstream blocks.
 */
test("BP-8a: baseRefName absent + head=feature/foo + no sticky → Path B block (fail-open, not base-production)", () => {
  // JSON without baseRefName key — simulates gh occasionally not returning it
  const ghOutput = JSON.stringify({
    headRefName: "feature/foo",
    headRefOid: CURRENT_SHA,
    comments: [],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    branch: "feature/foo",
    diffFiles: DIFF_WITH_PROPOSAL,
  });
  assert.equal(r.json?.decision, "block",
    `BP-8a: missing baseRefName + no sticky must still block (Path B), got: ${JSON.stringify(r.json)}`);
  // Must be Path B (cross-review), NOT base-production block
  assert.ok(
    !r.json.reason.includes("base 為 production"),
    `BP-8a: block must come from Path B, not base-production path, got: ${r.json?.reason}`
  );
});

/**
 * BP-8b: baseRefName absent + sticky PASS + base not actually production
 * → pass (fail-open does not cause false block).
 * Verifies that missing baseRefName never misidentifies a PR as base=production.
 */
test("BP-8b: baseRefName absent + sticky PASS → pass (fail-open: no false production block)", () => {
  // JSON without baseRefName — sticky PASS aligned
  const ghOutput = JSON.stringify({
    headRefName: "feature/foo",
    headRefOid: CURRENT_SHA,
    comments: [
      {
        id: "C_0",
        url: `https://github.com/example/repo/pull/${PR_NUMBER}#issuecomment-0`,
        body: buildPassStickyBody(CURRENT_SHA),
      },
    ],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    branch: "feature/foo",
    diffFiles: DIFF_WITH_PROPOSAL,
  });
  assert.ok(
    r.json?.decision !== "block",
    `BP-8b: missing baseRefName + sticky PASS should pass (fail-open), got: ${JSON.stringify(r.json)}`
  );
});

// ── enforce-hotfix-release-carrier D1/D2/D3 matrix (design §U7 HB rows) ─────
//
// D1: isBaseProductionBlockExempt(headRefName) — pure head-name predicate,
//     only the 3 release SSOT helpers exempt. hotfix/*（含 hotfix/revert-rules-*）
//     and chore/bump-v* are NEVER exempt on this axis, on ANY repo.
// D2: production-base-pr-create — same predicate, create-time counterpart.
// D3: isConsumerSubsetReleaseBranchExempt gains `[-<n>]` (same-day ordinal).

function checkoutBranch(dir, name) {
  const r = spawnSync("git", ["checkout", "-b", name], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

/**
 * Calls the create-surface gate via namespace access (see import comment
 * above). Pre-T6 (function not yet exported) this always returns null (pass)
 * — block-expected assertions below RED against that; pass-expected
 * assertions trivially hold both before and after T6.
 */
function runCreateGate(cmd, cwd) {
  const fn = preToolGateNs.checkProductionBasePrCreate;
  const result = typeof fn === "function" ? fn(cmd, cwd, cwd) : null;
  return result && result.block ? { decision: "block", reason: result.reason } : null;
}

// N1/N3/N4: heads with no direct production route (D1) — must block on both
// gh pr create and gh pr merge, on both source and consumer repos.
const NON_CARRIER_HEADS = [
  "hotfix/urgent", // N1
  "chore/bump-v6.94.0", // N3
  "hotfix/revert-rules-20260926", // N4
];

for (const repoKind of ["source", "consumer"]) {
  const makeRepo = repoKind === "source" ? makeSourceRepoCwd : makeConsumerRepoCwd;

  for (const head of NON_CARRIER_HEADS) {
    test(`N (${repoKind}, merge): base=production + head=${head} → gh pr merge block`, () => {
      const cwd = makeRepo();
      try {
        assert.equal(isBaseProductionBlockExempt(head), false,
          `isBaseProductionBlockExempt("${head}") must be false (D1 — no direct production route)`);
        const ghOutput = buildPrJsonFull({
          baseRefName: "production",
          headRefName: head,
          headRefOid: CURRENT_SHA,
          comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
        });
        const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
          ghOutput, branch: head, diffFiles: DIFF_WITH_PROPOSAL, cwd,
        });
        assert.equal(r.json?.decision, "block",
          `expected block for ${repoKind} head=${head}, got: ${JSON.stringify(r.json)}`);
        assert.match(r.json.reason, /MUST NOT 以 hook bypass 合理化/,
          `block reason must forbid bypass-rationalized direct merge, got: ${r.json?.reason}`);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test(`N (${repoKind}, create, literal --head): gh pr create --base production --head ${head} → block`, () => {
      const cwd = makeRepo();
      try {
        const r = runCreateGate(`gh pr create --base production --head ${head}`, cwd);
        assert.equal(r?.decision, "block",
          `expected block for ${repoKind} literal --head=${head}, got: ${JSON.stringify(r)}`);
        assert.match(r.reason, /MUST NOT 以 hook bypass 合理化/,
          `create-surface block reason must forbid bypass-rationalized direct merge, got: ${r?.reason}`);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test(`N (${repoKind}, create, current-branch head): checked out ${head}, gh pr create --base production → block`, () => {
      const cwd = makeRepo();
      try {
        checkoutBranch(cwd, head);
        const r = runCreateGate(`gh pr create --base production`, cwd);
        assert.equal(r?.decision, "block",
          `expected block for ${repoKind} current-branch head=${head} (no --head), got: ${JSON.stringify(r)}`);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
}

// N1: 3 base-flag writing forms (`--base`/`-B`/`--base=`) must each be parsed
// identically by the create-surface gate.
for (const baseFlag of ["--base production", "-B production", "--base=production"]) {
  test(`N (source, create, base-flag-form "${baseFlag}"): gh pr create ${baseFlag} --head hotfix/urgent → block`, () => {
    const cwd = makeSourceRepoCwd();
    try {
      const r = runCreateGate(`gh pr create ${baseFlag} --head hotfix/urgent`, cwd);
      assert.equal(r?.decision, "block",
        `expected block for base flag form "${baseFlag}", got: ${JSON.stringify(r)}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// P2: legitimate release-carrier heads pass on BOTH surfaces. Includes the D3
// `[-<n>]` same-day-ordinal consumer form (release/20260926-abc1234-2), which
// is the genuine RED case for D3 (current regex lacks `-<n>` support).
test("P2 (source, create): gh pr create --base production --head release/v1.2.3 → pass", () => {
  const cwd = makeSourceRepoCwd();
  try {
    const r = runCreateGate("gh pr create --base production --head release/v1.2.3", cwd);
    assert.equal(r, null, `expected pass, got: ${JSON.stringify(r)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const head of [
  "release/20260926-abc1234",
  "release/20260926-abc1234-2",
  "release/rules-20260926",
]) {
  test(`P2 (consumer, create): gh pr create --base production --head ${head} → pass`, () => {
    const cwd = makeConsumerRepoCwd();
    try {
      const r = runCreateGate(`gh pr create --base production --head ${head}`, cwd);
      assert.equal(r, null, `expected pass for head=${head}, got: ${JSON.stringify(r)}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test(`P2 (consumer, merge): base=production + head=${head} → pass`, () => {
    const cwd = makeConsumerRepoCwd();
    try {
      const ghOutput = buildPrJsonFull({
        baseRefName: "production",
        headRefName: head,
        headRefOid: CURRENT_SHA,
        comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
      });
      const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
        ghOutput, branch: head, diffFiles: DIFF_WITH_PROPOSAL, cwd,
      });
      assert.ok(r.json?.decision !== "block",
        `expected pass for head=${head}, got: ${JSON.stringify(r.json)}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// P1: hotfix PR base=carrier (NOT production) — the base-production face must
// not fire (a different axis — cross-model sticky review — still governs the
// merge surface; exercised together with P4 below).
test("P1 (create): gh pr create --base release/20260926-abc1234 --head hotfix/urgent → base-production face passes", () => {
  const cwd = makeConsumerRepoCwd();
  try {
    const r = runCreateGate(
      "gh pr create --base release/20260926-abc1234 --head hotfix/urgent",
      cwd
    );
    assert.equal(r, null,
      `base-production face must not fire for a non-production base, got: ${JSON.stringify(r)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("P1 (merge): base=release/20260926-abc1234 + head=hotfix/urgent + sticky PASS aligned → pass", () => {
  const cwd = makeConsumerRepoCwd();
  try {
    const ghOutput = buildPrJsonFull({
      baseRefName: "release/20260926-abc1234",
      headRefName: "hotfix/urgent",
      headRefOid: CURRENT_SHA,
      comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
    });
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput, branch: "hotfix/urgent", diffFiles: DIFF_WITH_PROPOSAL, cwd,
    });
    assert.ok(r.json?.decision !== "block", `expected pass, got: ${JSON.stringify(r.json)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// P3b: bump PR base=carrier (NOT production) — base-production face passes on
// both surfaces (bump is separately cross-model exempt on the merge surface —
// unaffected by D1/D2/D3, asserted here for completeness).
test("P3b (source, create): gh pr create --base release/v1.2.3 --head chore/bump-v6.94.0 → pass", () => {
  const cwd = makeSourceRepoCwd();
  try {
    const r = runCreateGate(
      "gh pr create --base release/v1.2.3 --head chore/bump-v6.94.0",
      cwd
    );
    assert.equal(r, null, `expected pass, got: ${JSON.stringify(r)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("P3b (source, merge): base=release/v1.2.3 + head=chore/bump-v6.94.0 → pass", () => {
  const cwd = makeSourceRepoCwd();
  try {
    const ghOutput = buildPrJsonFull({
      baseRefName: "release/v1.2.3",
      headRefName: "chore/bump-v6.94.0",
      headRefOid: CURRENT_SHA,
      comments: [],
    });
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput, branch: "chore/bump-v6.94.0", diffFiles: DIFF_WITH_PROPOSAL, cwd,
    });
    assert.ok(r.json?.decision !== "block", `expected pass, got: ${JSON.stringify(r.json)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// P4: bump already merged into carrier; a SEPARATE hotfix PR into the SAME
// carrier with a stale sticky (last_reviewed_sha ≠ headRefOid) must still
// block — via the EXISTING Path D sticky check, not the base-production face
// (base here is the carrier, not "production").
test("P4: base=release/20260926-abc1234 + head=hotfix/urgent + stale sticky sha → block via Path D (not base-production face)", () => {
  const cwd = makeConsumerRepoCwd();
  const STALE_SHA = "1111111111111111111111111111111111111111";
  try {
    const ghOutput = buildPrJsonFull({
      baseRefName: "release/20260926-abc1234",
      headRefName: "hotfix/urgent",
      headRefOid: CURRENT_SHA,
      comments: [{ body: buildPassStickyBody(STALE_SHA) }],
    });
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput, branch: "hotfix/urgent", diffFiles: DIFF_WITH_PROPOSAL, cwd,
    });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.ok(!r.json.reason.includes("base 為 production"),
      `P4 block must come from Path D (stale sticky), not base-production face, got: ${r.json?.reason}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// C3: grandfather completion path (PR #2 hotfix/*→main, per D13) is out of
// scope for this hook — base=main never triggers the base-production face.
// hotfix/* is still never cross-model exempt, so the merge still blocks via
// the pre-existing Path B (sticky absent); the assertion is that the block
// does NOT come from the base-production face.
test("C3: base=main + head=hotfix/legacy → base-production face does not fire (grandfather completion path)", () => {
  const cwd = makeConsumerRepoCwd();
  try {
    const ghOutput = buildPrJsonFull({
      baseRefName: "main",
      headRefName: "hotfix/legacy",
      headRefOid: CURRENT_SHA,
      comments: [],
    });
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput, branch: "hotfix/legacy", diffFiles: DIFF_WITH_PROPOSAL, cwd,
    });
    assert.equal(r.json?.decision, "block");
    assert.ok(!r.json.reason.includes("base 為 production"),
      `C3: base=main must not trigger base-production face, got: ${r.json?.reason}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// D2 point 4: a non-literal --head (contains `$`/backtick — the canonical
// production-PR recipe's `--head "$RELEASE_BRANCH"`) fails OPEN at the
// create surface, even when the actual current branch checked out IS a
// non-carrier head — the merge-time gate (Path BP) remains authoritative.
// Scenario title (spec pre-tool-mechanical-gates, ADDED requirement):
// "Non-literal head fails open on create, merge remains authoritative"
test("Non-literal head fails open on create, merge remains authoritative", () => {
  const cwd = makeConsumerRepoCwd();
  try {
    checkoutBranch(cwd, "hotfix/urgent");
    const r = runCreateGate(
      'gh pr create --base production --head "$RELEASE_BRANCH"',
      cwd
    );
    assert.equal(r, null,
      `non-literal --head must fail OPEN at create-surface, got: ${JSON.stringify(r)}`);

    // "merge remains authoritative": the SAME head, once GitHub actually
    // records it as the PR's headRefName, still blocks at merge time via the
    // fail-closed Path BP check — the create-surface fail-open never lets the
    // PR itself escape enforcement.
    const ghOutput = buildPrJsonFull({
      baseRefName: "production",
      headRefName: "hotfix/urgent",
      headRefOid: CURRENT_SHA,
      comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
    });
    const merged = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput, branch: "hotfix/urgent", diffFiles: DIFF_WITH_PROPOSAL, cwd,
    });
    assert.equal(merged.json?.decision, "block",
      `merge-time Path BP must remain authoritative for the actual GitHub-recorded head, got: ${JSON.stringify(merged.json)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Scenario title: "Unspecified or non-production base never blocks on create"
test("Unspecified or non-production base never blocks on create", () => {
  const cwd = makeSourceRepoCwd();
  try {
    checkoutBranch(cwd, "hotfix/urgent");
    assert.equal(
      runCreateGate("gh pr create --head hotfix/urgent", cwd),
      null,
      "no --base flag (repository default) must not block"
    );
    assert.equal(
      runCreateGate("gh pr create --base main --head hotfix/urgent", cwd),
      null,
      "--base main must not block"
    );
    assert.equal(
      runCreateGate("gh pr create --base release/v6.94.0 --head hotfix/urgent", cwd),
      null,
      "--base release/v6.94.0 (non-production) must not block"
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Scenario title: "Literal hotfix head into production is blocked on create"
test("Literal hotfix head into production is blocked on create", () => {
  const cwd = makeConsumerRepoCwd();
  try {
    assert.equal(isBaseProductionBlockExempt("hotfix/urgent"), false);
    const r = runCreateGate("gh pr create --base production --head hotfix/urgent", cwd);
    assert.equal(r?.decision, "block", `expected block, got: ${JSON.stringify(r)}`);
    assert.doesNotMatch(r.reason, /DEVPRO_HOOK_BYPASS/,
      `must not suggest a bypass, got: ${r.reason}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Scenario title: "Current-branch head into production is blocked on create"
test("Current-branch head into production is blocked on create", () => {
  const cwd = makeSourceRepoCwd();
  try {
    checkoutBranch(cwd, "chore/bump-v6.94.0");
    const r = runCreateGate("gh pr create --base production", cwd);
    assert.equal(r?.decision, "block",
      `current-branch head (no --head) must resolve and block identically to an explicit --head, got: ${JSON.stringify(r)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Scenario title: "Legitimate carrier head into production passes create"
test("Legitimate carrier head into production passes create", () => {
  const cwd = makeSourceRepoCwd();
  try {
    for (const head of [
      "release/v6.94.0",
      "release/20260518-abc1234",
      "release/20260518-abc1234-2",
      "release/rules-20260518",
    ]) {
      assert.equal(isBaseProductionBlockExempt(head), true,
        `isBaseProductionBlockExempt("${head}") must be true`);
      const r = runCreateGate(`gh pr create --base production --head ${head}`, cwd);
      assert.equal(r, null, `expected pass for head=${head}, got: ${JSON.stringify(r)}`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// D2: `gh pr edit --base production` (retarget) is explicitly out of scope —
// the create-surface gate must not match it at all.
// Scenario title: "PR retarget via gh pr edit is not intercepted on create"
test("PR retarget via gh pr edit is not intercepted on create", () => {
  const cwd = makeConsumerRepoCwd();
  try {
    const r = runCreateGate(`gh pr edit ${PR_NUMBER} --base production`, cwd);
    assert.equal(r, null, `gh pr edit must not be matched, got: ${JSON.stringify(r)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Block-message content (hook follow-up): no bypass suggestion, no stale
// "hotfix/* is a legitimate consumer route" wording, points to the
// release-carrier lane. Both surfaces share buildBaseProductionBlockReason.
for (const surface of ["merge", "create"]) {
  test(`Message content (${surface} surface): forbids bypass suggestion, does not list hotfix/* as a legitimate production route, points to release-carrier lane`, () => {
    const reason = preToolGateNs.buildBaseProductionBlockReason("hotfix/urgent", surface, {
      prNumber: PR_NUMBER,
    });
    assert.doesNotMatch(reason, /DEVPRO_HOOK_BYPASS/,
      `${surface}-surface block message must not suggest DEVPRO_HOOK_BYPASS, got: ${reason}`);
    assert.doesNotMatch(reason, /或\s*`?hotfix\/\*`?/,
      `${surface}-surface block message must not list hotfix/* as a legitimate production route, got: ${reason}`);
    assert.match(reason, /release-carrier lane/i,
      `${surface}-surface block message must direct the operator to the release-carrier lane, got: ${reason}`);
  });
}

// ── Scenario title: "Create-gate is skipped under rigor off, consistent
// with Path BP" — the gate must be evaluated through the FULL BASH_BLOCKING_GATES
// inventory (rigor-level filtering lives in runGateInventory/shouldSkipGate,
// not inside checkProductionBasePrCreate itself), so this drives the real
// pre-tool-gate.mjs process end-to-end rather than calling the gate function
// directly (mirrors rules-rigor-level.test.mjs's runGateDirect pattern).
const HOOK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

function runFullHookAtRigorLevel(cmd, cwd, level) {
  const env = { ...process.env, PWD: cwd, DEVPRO_AGENT_RULES_LEVEL: level };
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }),
    encoding: "utf8",
    cwd,
    env,
  });
  let json = null;
  if (result.stdout && result.stdout.trim()) {
    try { json = JSON.parse(result.stdout); } catch {}
  }
  return { status: result.status, stderr: result.stderr, json };
}

test("Create-gate is skipped under rigor off, consistent with Path BP", () => {
  const cwd = makeConsumerRepoCwd();
  try {
    const cmd = "gh pr create --base production --head hotfix/urgent";

    const full = runFullHookAtRigorLevel(cmd, cwd, "full");
    assert.equal(full.json?.decision, "block",
      `sanity: rigor=full must block via production-base-pr-create, got: ${JSON.stringify(full.json)}`);
    assert.doesNotMatch(full.json.reason, /DEVPRO_HOOK_BYPASS/,
      `sanity block message must not suggest a bypass, got: ${full.json.reason}`);

    const off = runFullHookAtRigorLevel(cmd, cwd, "off");
    assert.notEqual(off.json?.decision, "block",
      `rigor=off must skip production-base-pr-create (non-baseline gate), got: ${JSON.stringify(off.json)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("production-base-pr-create is NOT in lib/rigor-level.mjs BASELINE_GATE_IDS", async () => {
  const { BASELINE_GATE_IDS } = await import("../hooks/lib/rigor-level.mjs");
  assert.ok(
    !BASELINE_GATE_IDS.includes("production-base-pr-create"),
    `production-base-pr-create must stay non-baseline so rigor=off skips it, got BASELINE_GATE_IDS: ${JSON.stringify(BASELINE_GATE_IDS)}`
  );
});

// F-ehrc-r1-11: done_when 1 claims the `[-<n>]` consumer-form carrier passes
// on the source fixture too, on both surfaces — pin the merge surface here.
test("P2 (source, merge): base=production + head=release/20260926-abc1234-2 → pass", () => {
  const cwd = makeSourceRepoCwd();
  try {
    const head = "release/20260926-abc1234-2";
    const ghOutput = buildPrJsonFull({
      baseRefName: "production",
      headRefName: head,
      headRefOid: CURRENT_SHA,
      comments: [{ body: buildPassStickyBody(CURRENT_SHA) }],
    });
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput, branch: head, diffFiles: DIFF_WITH_PROPOSAL, cwd,
    });
    assert.ok(r.json?.decision !== "block",
      `expected pass for head=${head}, got: ${JSON.stringify(r.json)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// F-ehrc-r1-09 (design-core §11 axis B q2): when the current branch cannot be
// trusted — cwd unresolvable, or a checkout/switch earlier in the same command
// that PreToolUse cannot observe — the create gate fails open; the merge
// surface stays the authoritative block point.
test("Create gate fails open when the current branch is unresolvable", () => {
  const cwd = makeSourceRepoCwd();
  try {
    checkoutBranch(cwd, "hotfix/urgent");
    // The checkout is read at the gh pr create position: a variable operand or a missing directory leaves it unresolved.
    for (const cmd of [
      'cd "$SOME_VAR" && gh pr create --base production --fill',
      "cd /nonexistent-dir-for-production-base-test && gh pr create --base production --fill",
    ]) {
      const r = runCreateGate(cmd, cwd);
      assert.equal(r, null, `expected fail-open for ${cmd}, got: ${JSON.stringify(r)}`);
    }
    // Control: the same checkout with a plain command blocks (hotfix/* has no direct production route).
    assert.equal(runCreateGate("gh pr create --base production --fill", cwd)?.decision, "block");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Create gate fails open when a branch switch precedes gh pr create", () => {
  const cwd = makeSourceRepoCwd();
  try {
    checkoutBranch(cwd, "chore/bump-v6.94.0");
    for (const cmd of [
      "git switch release/v6.94.0 && gh pr create --base production --fill",
      "git checkout release/v6.94.0; gh pr create --base production --fill",
    ]) {
      const r = runCreateGate(cmd, cwd);
      assert.equal(r, null, `expected fail-open for ${cmd}, got: ${JSON.stringify(r)}`);
    }
    const blocked = runCreateGate("gh pr create --base production --fill", cwd);
    assert.equal(blocked?.decision, "block", "control: no switch → current bump head still blocks");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The branch-switch detection reads the raw text before the gh pr create position. A checkout or switch spelled in a
// quoted string still counts as a switch, so the gate fails open: a switch hidden in `sh -c '...'` moves HEAD too, and
// the merge gate stays the authoritative block point (brd FR17; review round 7 F-r7-04).
test("Create gate treats a git checkout spelled in a quoted string as a switch (fail-open, documented)", () => {
  const cwd = makeSourceRepoCwd();
  try {
    checkoutBranch(cwd, "hotfix/urgent");
    for (const cmd of [
      'echo "git checkout x" && gh pr create --base production --fill',
      "sh -c 'git checkout release/v6.94.0' && gh pr create --base production --fill",
    ]) {
      const r = runCreateGate(cmd, cwd);
      assert.equal(r, null, `expected fail-open for ${cmd}, got: ${JSON.stringify(r)}`);
    }
    // Control: without the switch wording the same checkout blocks.
    assert.equal(runCreateGate('echo "plain text" && gh pr create --base production --fill', cwd)?.decision, "block");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Scope change 1 (R17): the head is the branch of the checkout gh pr create itself runs in ──
//
// Two source checkouts: one on a feature branch (no direct production route, the create gate blocks) and one on a
// source release branch (exempt). The gate runner's first-git/gh position and a raw string search used to decide
// which checkout was read; these cases tell them apart through the real hook process.

const PRODUCTION_CARRIER_BRANCH = "release/20260926-abc1234";

function makeFeatureAndReleaseCheckouts() {
  const featureRepo = makeSourceRepoCwd();
  checkoutBranch(featureRepo, "feature/needs-review");
  const releaseRepo = makeSourceRepoCwd();
  checkoutBranch(releaseRepo, PRODUCTION_CARRIER_BRANCH);
  return { featureRepo, releaseRepo };
}

const blockedByProductionBase = (r) =>
  r.json?.decision === "block" && /release-carrier lane/i.test(r.json.reason || "");

test("Scenario: The production base gate reads the branch at the gh pr create position (through the hook)", () => {
  const { featureRepo, releaseRepo } = makeFeatureAndReleaseCheckouts();
  try {
    const create = "gh pr create --base production --fill";
    // [label, session checkout, text before gh pr create, whether the gate must block]
    const cases = [
      ["git -C into the release checkout does not move gh pr create", featureRepo, `git -C ${releaseRepo} status && `, true],
      ["git -C into the feature checkout does not move gh pr create", releaseRepo, `git -C ${featureRepo} status && `, false],
      ["a cd after the first git command moves gh pr create into the release checkout", featureRepo, `git fetch && cd ${releaseRepo} && `, false],
      ["a cd after the first git command moves gh pr create into the feature checkout", releaseRepo, `git fetch && cd ${featureRepo} && `, true],
      ["a redirect between the cd and gh pr create keeps the feature checkout", releaseRepo, `cd ${featureRepo} && echo ok 2>&1 && `, true],
      ["a redirect between the cd and gh pr create keeps the release checkout", featureRepo, `cd ${releaseRepo} && echo ok 2>&1 && `, false],
      ["a pipeline between the cd and gh pr create keeps the feature checkout", releaseRepo, `cd ${featureRepo} && echo ok | cat && `, true],
      ["a quoted environment value does not hide gh pr create in the feature checkout", featureRepo, 'V="a b c" ', true],
      ["a quoted environment value does not hide gh pr create in the release checkout", releaseRepo, 'V="a b c" ', false],
      ["a long quoted environment value after a cd into the feature checkout", releaseRepo, `cd ${featureRepo} && VAR='a quoted value longer than the opaque placeholder' `, true],
    ];
    for (const [label, session, prefix, shouldBlock] of cases) {
      const r = runFullHookAtRigorLevel(`${prefix}${create}`, session, "full");
      assert.equal(
        blockedByProductionBase(r),
        shouldBlock,
        `${label}: expected ${shouldBlock ? "block" : "no production-base block"}, got ${JSON.stringify(r.json)} stderr=${r.stderr}`,
      );
    }
  } finally {
    rmSync(featureRepo, { recursive: true, force: true });
    rmSync(releaseRepo, { recursive: true, force: true });
  }
});

test("Scenario: The production base gate fails open when the gh pr create position or its cwd cannot be resolved (through the hook)", () => {
  const { featureRepo, releaseRepo } = makeFeatureAndReleaseCheckouts();
  try {
    const create = "gh pr create --base production --fill";
    const unresolved = [
      `cd "$SOME_VAR" && ${create}`,
      `cd /nonexistent-dir-for-production-base-test && ${create}`,
      `echo ok | cd ${releaseRepo} && ${create}`,
      `(cd ${releaseRepo} && ${create} )`,
    ];
    for (const cmd of unresolved) {
      const r = runFullHookAtRigorLevel(cmd, featureRepo, "full");
      assert.equal(blockedByProductionBase(r), false, `${cmd}: must fail open, got ${JSON.stringify(r.json)} stderr=${r.stderr}`);
    }
    // Control: the same session and a plain command blocks, so the cases above are not passing for another reason.
    assert.equal(blockedByProductionBase(runFullHookAtRigorLevel(create, featureRepo, "full")), true);
    // A readable assignment preserves the command's checkout.
    for (const prefix of ["GH_TOKEN=token ", "GH_TOKEN=$TOKEN ", "GH_TOKEN=${TOKEN} "]) {
      assert.equal(blockedByProductionBase(runFullHookAtRigorLevel(`${prefix}${create}`, featureRepo, "full")), true, prefix);
    }
    for (const prefix of ["GH_TOKEN=$(echo token) ", "GH_TOKEN=`echo token` ", "GH_TOKEN=$(echo $(echo token)) "]) {
      const result = runFullHookAtRigorLevel(`${prefix}${create}`, featureRepo, "full");
      assert.equal(result.json?.decision, "block", prefix);
      assert.match(result.json.reason, /^PR checkout gate: cannot read the assignment prefix/, prefix);
    }
  } finally {
    rmSync(featureRepo, { recursive: true, force: true });
    rmSync(releaseRepo, { recursive: true, force: true });
  }
});

test("The production base gate keeps judging a literal --head without any cwd", () => {
  const { featureRepo, releaseRepo } = makeFeatureAndReleaseCheckouts();
  try {
    // The literal head decides in both directions, whichever checkout the session or a cd is in.
    const blocking = runFullHookAtRigorLevel("gh pr create --base production --head feature/other --fill", releaseRepo, "full");
    assert.equal(blockedByProductionBase(blocking), true, JSON.stringify(blocking.json));
    const passing = runFullHookAtRigorLevel(
      `gh pr create --base production --head ${PRODUCTION_CARRIER_BRANCH} --fill`,
      featureRepo,
      "full",
    );
    assert.equal(blockedByProductionBase(passing), false, JSON.stringify(passing.json));
    // Even where the checkout cannot be resolved, a literal non-carrier head still blocks.
    const unresolvedCwd = runFullHookAtRigorLevel(
      'cd "$SOME_VAR" && gh pr create --base production --head feature/other --fill',
      releaseRepo,
      "full",
    );
    assert.equal(blockedByProductionBase(unresolvedCwd), true, JSON.stringify(unresolvedCwd.json));
  } finally {
    rmSync(featureRepo, { recursive: true, force: true });
    rmSync(releaseRepo, { recursive: true, force: true });
  }
});
