/**
 * hook-pre-tool-gate-cross-model-skip-rules.test.mjs
 *
 * Tests for the rules-sync branch exemption in checkCrossModelMergeGate (Gate T5).
 *
 * Background: consumer-repo rules-sync PRs (branch pattern `rules/<whitelisted-source>-v<X.Y.Z>`)
 * are mechanical content syncs from the source repo where cross-model review already
 * ran; re-reviewing on the consumer side is redundant. This exemption mirrors the
 * existing `chore/bump-v*` exemption (Path A variant).
 *
 * isRulesSyncExemptFromCrossModel is exported from lib/branch-naming.mjs (SSOT shared
 * with validateRulesBranch) — enforces both SemVer format AND whitelist binding.
 *
 * Default-on design (T1):
 *   The gate is now DEFAULT-ON. Cases R3, R5, R7 use TRIGGER_PATH_WITH_PROPOSAL
 *   to exercise the block path without any diff-shape exemption ambiguity.
 *   Cases R1, R4 use TRIGGER_PATH (branch-pattern exempt applies regardless of diff shape).
 *   R2 uses NON_TRIGGER_PATH to prove rules-sync branch-pattern exemption still applies when no proposal is present.
 *
 * Cases:
 *   R1 — PR headRefName `rules/agent-rules-v6.50.0` + diff has proposal → pass (rules-sync branch exempt)
 *   R2 — PR headRefName `rules/agent-rules-v6.50.0` + diff no proposal → pass (rules-sync branch exempt)
 *   R3 — PR headRefName `rules/foo` (non-sync naming) + diff has proposal + sticky absent → block
 *   R4 — PR headRefName `chore/bump-v6.50.0` + diff has proposal → pass (bump exempt, regression backstop)
 *   R5 — PR headRefName `release/foo` (unrelated) + diff has proposal + sticky absent → block
 *   R6 — isRulesSyncExemptFromCrossModel helper unit tests (format + whitelist binding)
 *   R7 — PR headRefName `rules/fake-source-v1.0.0` (non-whitelisted) + diff has proposal + sticky absent → block
 *
 * Mock strategy: identical to hook-pre-tool-gate-cross-model-merge.test.mjs —
 *   CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT          — JSON for gh pr view
 *   CROSS_MODEL_MERGE_GATE_MOCK_BRANCH             — current branch
 *   CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES         — newline-separated changed file list
 *
 * All tests use fictitious PR #9999.
 */

import "./lib/isolated-control-evidence-state.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCrossModelMergeGate } from "../hooks/pre-tool-gate.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

// cwd-independent repo root (SSOT in tests/lib/repo-root.mjs): tests relying on
// the gate reading the REAL preflight-checklist.md (R1/R2/R7) pass this, not
// process.cwd() — otherwise running from .devpro/scripts/ makes the gate look
// for .devpro/scripts/.devpro/agent-rules/... (ENOENT).
import { REPO_ROOT } from "./lib/repo-root.mjs";

// Import helper from lib (SSOT — shared with validateRulesBranch)
import { isRulesSyncExemptFromCrossModel, RULES_SYNC_SEMVER_RE } from "../hooks/lib/branch-naming.mjs";

// ── Setup / teardown ──────────────────────────────────────────────────────

const tmpRoot = makeTempDir("cm-skip-rules-test-");

// Transcript-shaped payload fixture; merge readiness no longer reads transcript text.
const FAKE_TRANSCRIPT_PATH = path.join(tmpRoot, "fake-transcript.txt");
writeFileSync(FAKE_TRANSCRIPT_PATH, "Totals: 42 passed, 0 failed\n");

// Clean up temp dir after all tests finish (best-effort)
process.on("exit", () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// ── Constants ─────────────────────────────────────────────────────────────

const MAGIC_MARKER = "<!-- cross-model-second-opinion:sticky -->";
const TRIGGER_PATH = ".devpro/agent-rules/foo.md";   // any agent-rules file triggers the gate
const NON_TRIGGER_PATH = "unrelated.txt";
const PR_NUMBER = "9999";
const CURRENT_SHA = "abc1234def5678901234567890abcdef01234567";

// Default-on reframe: these cases include proposal.md when they need to avoid
// any diff-shape exemption ambiguity and exercise the sticky-check block path.
const PROPOSAL_PATH = "openspec/changes/test-change/proposal.md";
const TRIGGER_PATH_WITH_PROPOSAL = `${TRIGGER_PATH}\n${PROPOSAL_PATH}`;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a `gh pr view` JSON response with an explicit headRefName.
 */
function buildPrJson({ headRefName, comments = [], headRefOid = CURRENT_SHA } = {}) {
  return JSON.stringify({
    headRefOid,
    headRefName,
    comments: comments.map((c, i) => ({
      id: c.id || `C_${i}`,
      url: c.url || `https://github.com/example/repo/pull/${PR_NUMBER}#issuecomment-${i}`,
      body: c.body,
    })),
  });
}

// Env keys the cross-model merge gate reads from process.env. The in-process
// path sets these before calling the gate and restores them afterwards so a
// shared process.env never leaks mocks across tests.
const CM_MOCK_ENV_KEYS = [
  "CROSS_MODEL_MERGE_GATE_MOCK_BRANCH",
  "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES",
  "CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT",
];

/**
 * In-process fast path: set the gate's env mocks, call checkCrossModelMergeGate
 * directly, then restore env. Returns the same shape as the spawn path so test
 * assertions (r.json?.decision / r.json?.reason) are unchanged:
 *   gate returns null            → pass  → { json: null }
 *   gate returns {block, reason} → block → { json: { decision: "block", reason } }
 *
 * Use runHookSpawn() instead when a test must assert the end-to-end hook
 * contract (process exit code, stdout JSON emission).
 */
function runHook(command, {
  ghOutput = null,
  branch = "chore/some-feature",
  diffFiles = TRIGGER_PATH,
  extraEnv = {},
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

    const result = checkCrossModelMergeGate(command, REPO_ROOT);
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

/**
 * Spawn path (end-to-end). Runs the full hook in a child process so a test can
 * assert the hook contract: always exit 0, decision delivered via stdout JSON.
 */
function runHookSpawn(command, {
  ghOutput = null,
  branch = "chore/some-feature",
  diffFiles = TRIGGER_PATH,
  transcriptPath = FAKE_TRANSCRIPT_PATH,
  extraEnv = {},
} = {}) {
  const env = {
    ...process.env,
    CODEX_CI: "",
    CODEX_THREAD_ID: "",
    DEVPRO_SENTINEL_STATE_DIR: makeTempDir("sentinel-skip-rules-"),
    CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
    CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: diffFiles,
    ...extraEnv,
  };
  if (ghOutput !== null) {
    env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = ghOutput;
  }

  const payload = {
    tool_name: "Bash",
    tool_input: { command },
    transcript_path: transcriptPath,
  };

  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
  });

  let json = null;
  if (result.stdout && result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      // not JSON — hook exited cleanly without output
    }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

/**
 * Build a fake repo root with preflight-checklist.md containing a
 * rules-source-whitelist marker block listing the given sources.
 *
 * @param {string[]} sources — list of source names to include in whitelist (e.g. ["agent-rules"])
 * @returns {string} path to the fake repo root
 */
function setupFakeRepoWithWhitelist(sources) {
  const dir = makeTempDir("rules-whitelist-test-");
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  const items = sources.map((s) => `- \`${s}\` — test source`).join("\n");
  writeFileSync(
    path.join(dir, ".devpro/agent-rules/preflight-checklist.md"),
    `# preflight\n\n<!-- rules-source-whitelist:start -->\n${items}\n<!-- rules-source-whitelist:end -->\n`
  );
  return dir;
}

// ── Test cases ────────────────────────────────────────────────────────────

// R1: rules-sync PR headRefName + diff has proposal → pass (branch-pattern exempt fires before chore-A check).
// (default-on reframe: diff includes proposal.md so chore-A does NOT exempt; instead the
//  rules-sync branch pattern exempt applies — agent-rules is whitelisted in real preflight-checklist.md)
// NOTE: R1 uses the real repo root (hook subprocess reads real preflight-checklist.md).
test("R1: PR headRefName rules/agent-rules-v6.50.0 + diff has proposal → pass (rules-sync branch exempt)", () => {
  const ghOutput = buildPrJson({
    headRefName: "rules/agent-rules-v6.50.0",
    comments: [],        // no sticky — would block if exemption not applied
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present but branch-pattern exempt fires first
    branch: "rules/agent-rules-v6.50.0",
  });
  assert.ok(
    r.json?.decision !== "block",
    `R1: rules-sync PR should be exempt from cross-model gate, got: ${JSON.stringify(r.json)}`
  );
});

// R2: rules-sync PR headRefName + diff has no proposal → pass (rules-sync branch-pattern exempt).
// (default-on reframe: branch-pattern exemption applies before diff-shape classification.)
test("R2: PR headRefName rules/agent-rules-v6.50.0 + diff no proposal → pass (rules-sync branch exempt)", () => {
  const ghOutput = buildPrJson({
    headRefName: "rules/agent-rules-v6.50.0",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: NON_TRIGGER_PATH,   // no proposal.md, but branch-pattern exemption is the reason for pass
    branch: "rules/agent-rules-v6.50.0",
  });
  assert.ok(
    r.json?.decision !== "block",
    `R2: rules-sync branch should be exempt even with no proposal, got: ${JSON.stringify(r.json)}`
  );
});

// R3: PR headRefName rules/foo (no version suffix — not a valid sync branch) + diff has proposal + no sticky → block.
// (default-on reframe: diff includes proposal.md → not chore-A exempt; branch rules/foo not in exempt set → Path B block)
test("R3: PR headRefName rules/foo (non-sync naming) + diff has proposal + sticky absent → block (Path B)", () => {
  const ghOutput = buildPrJson({
    headRefName: "rules/foo",     // missing -v<X.Y.Z> suffix
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "rules/foo",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `R3: rules/foo (non-sync) should still block when sticky absent, got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json?.reason ?? "",
    /Path B/,
    `R3: block reason should mention Path B, got: ${r.json?.reason}`
  );
});

// R4: chore/bump-v6.50.0 PR headRefName + diff has proposal → pass (branch-pattern exempt fires before chore-A).
// (default-on reframe: proposal.md in diff means chore-A does NOT exempt; bump-v* branch-pattern exempt applies)
test("R4: PR headRefName chore/bump-v6.50.0 + diff has proposal → pass (bump exemption regression backstop)", () => {
  const ghOutput = buildPrJson({
    headRefName: "chore/bump-v6.50.0",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present but branch-pattern exempt fires first
    branch: "chore/bump-v6.50.0",
  });
  assert.ok(
    r.json?.decision !== "block",
    `R4: chore/bump-v* PR should still be exempt (no regression), got: ${JSON.stringify(r.json)}`
  );
});

// R5: release/foo PR headRefName + diff has proposal + no sticky → block (exemption not widened).
// (default-on reframe: diff includes proposal.md → not chore-A exempt; release/foo not in exempt set → Path B block)
test("R5: PR headRefName release/foo + diff has proposal + sticky absent → block (exemption not widened)", () => {
  const ghOutput = buildPrJson({
    headRefName: "release/foo",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "release/foo",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `R5: release/foo should block — exemption must not be widened, got: ${JSON.stringify(r.json)}`
  );
});

// R6: isRulesSyncExemptFromCrossModel helper unit tests
// Tests both format (via RULES_SYNC_SEMVER_RE) AND whitelist binding.
test("R6: isRulesSyncExemptFromCrossModel helper — format + whitelist binding", () => {
  // Build fake repos with controlled whitelists
  const dirWithAgentRules = setupFakeRepoWithWhitelist(["agent-rules"]);
  const dirEmpty = setupFakeRepoWithWhitelist([]);

  try {
    // --- Valid format + whitelisted source ---
    assert.strictEqual(
      isRulesSyncExemptFromCrossModel("rules/agent-rules-v6.50.0", dirWithAgentRules),
      true,
      "valid + whitelisted: rules/agent-rules-v6.50.0 with agent-rules in whitelist"
    );

    // --- Valid format + NON-whitelisted source → false (whitelist binding) ---
    assert.strictEqual(
      isRulesSyncExemptFromCrossModel("rules/fake-source-v1.0.0", dirWithAgentRules),
      false,
      "valid format but non-whitelisted: rules/fake-source-v1.0.0 (agent-rules whitelist only)"
    );

    // --- Retired date+SHA format must not be exempted ---
    assert.strictEqual(
      isRulesSyncExemptFromCrossModel("rules/agent-rules-20260509-9f82ed5", dirWithAgentRules),
      false,
      "retired date+SHA naming is not exempted"
    );

    // --- Non-rules prefix → false ---
    assert.strictEqual(
      isRulesSyncExemptFromCrossModel("chore/bump-v6.50.0", dirWithAgentRules),
      false,
      "non-rules prefix: chore/bump-v6.50.0"
    );

    // --- Empty whitelist marker → false (fail-closed) ---
    assert.strictEqual(
      isRulesSyncExemptFromCrossModel("rules/agent-rules-v6.50.0", dirEmpty),
      false,
      "empty whitelist marker → false (fail-closed)"
    );

    // --- Falsy inputs → false ---
    assert.strictEqual(
      isRulesSyncExemptFromCrossModel("", dirWithAgentRules),
      false,
      "falsy input: empty string"
    );
    assert.strictEqual(
      isRulesSyncExemptFromCrossModel(null, dirWithAgentRules),
      false,
      "falsy input: null"
    );
    assert.strictEqual(
      isRulesSyncExemptFromCrossModel(undefined, dirWithAgentRules),
      false,
      "falsy input: undefined"
    );

    // --- RULES_SYNC_SEMVER_RE: additional format assertions ---
    assert.ok(
      RULES_SYNC_SEMVER_RE.test("rules/my-source-v1.0.0"),
      "RULES_SYNC_SEMVER_RE: rules/my-source-v1.0.0 matches"
    );
    assert.ok(
      !RULES_SYNC_SEMVER_RE.test("rules/agent-rules"),
      "RULES_SYNC_SEMVER_RE: rules/agent-rules (no version) does not match"
    );
    assert.ok(
      !RULES_SYNC_SEMVER_RE.test("rules/agent-rules-vX.Y.Z"),
      "RULES_SYNC_SEMVER_RE: non-numeric version does not match"
    );
    assert.ok(
      !RULES_SYNC_SEMVER_RE.test("rules/agent-rules-20260509-9f82ed5"),
      "RULES_SYNC_SEMVER_RE: retired date+SHA form does not match"
    );
  } finally {
    rmSync(dirWithAgentRules, { recursive: true, force: true });
    rmSync(dirEmpty, { recursive: true, force: true });
  }
});

// R7: PR headRefName rules/fake-source-v1.0.0 (valid format, but non-whitelisted source)
// + diff has proposal + sticky absent → block (Path B).
// (default-on reframe: diff includes proposal.md → not chore-A exempt; fake-source not in whitelist
//  → isRulesSyncExemptFromCrossModel returns false → no branch-pattern exempt → Path B block)
// The hook subprocess reads the real preflight-checklist.md; fake-source is NOT in the
// whitelist (only agent-rules is).
test("R7: PR headRefName rules/fake-source-v1.0.0 (non-whitelisted) + diff has proposal + sticky absent → block (Path B)", () => {
  const ghOutput = buildPrJson({
    headRefName: "rules/fake-source-v1.0.0",   // valid SemVer format, but fake-source NOT in whitelist
    comments: [],                                // no sticky comment
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "rules/fake-source-v1.0.0",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `R7: non-whitelisted rules/fake-source-v1.0.0 must NOT be exempt — should block at Path B, got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json?.reason ?? "",
    /Path B/,
    `R7: block reason should mention Path B (no sticky), got: ${r.json?.reason}`
  );
});
