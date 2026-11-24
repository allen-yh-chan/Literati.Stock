/**
 * hook-pre-tool-gate-archive-before-push.test.mjs
 *
 * Integration tests for Gate 3b: checkArchiveBeforePushOrPRCreate in pre-tool-gate.mjs.
 * Spawns pre-tool-gate.mjs with PreToolUse Bash payloads and asserts advisory/pass.
 *
 * 8 assertions:
 *   1. git push + active openspec/changes/<name>/ folder → advisory
 *   2. gh pr create + active openspec/changes/<name>/ folder → advisory
 *   3. git push + no active folder (only archive/) → pass (positive assertion: exit 0, no block)
 *   4. git push --dry-run + active folder → pass (dry-run bypass)
 *   5. git push + active folder + gate script missing → pass (fail-open)
 *   6. missing node runtime produces a named probe-failed advisory
 *   7. git -C <worktree> push uses worktree archive state, not main cwd debt
 *   8. gh pr create --head <branch> uses that branch's local worktree archive state
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { resolveNativeExecutableOnPath } from "./lib/resolve-native-executable.mjs";
import { advisoryText } from "./lib/hook-harness.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const HOOK = path.resolve(SCRIPT_DIR, "../hooks/pre-tool-gate.mjs");

// Real rule files — needed so archive/rules helpers can run inside fixtures.
const REAL_PREFLIGHT = readFileSync(
  path.resolve(SCRIPT_DIR, "../../agent-rules/preflight-checklist.md"),
  "utf8"
);
const REAL_ANCHOR_RULE = readFileSync(
  path.resolve(SCRIPT_DIR, "../../agent-rules/git-branch-naming-and-anchor.md"),
  "utf8"
);
// Real gate script — copied into each fixture so gate path resolves correctly
const GATE_SCRIPT_CONTENT = readFileSync(
  path.resolve(SCRIPT_DIR, "../pre-pr-archive-gate.mjs"),
  "utf8"
);
// Sibling dependency of pre-pr-archive-gate.mjs — check (o) imports
// lintProposalTasksChecked from this module (task-checkbox execution-state gate).
const LINT_TASKS_CHECKED_CONTENT = readFileSync(
  path.resolve(SCRIPT_DIR, "../lint-proposal-tasks-checked.mjs"),
  "utf8"
);

// Consumer and unknown checkouts must carry a DEV deploy-verify line; these tests cover the archive gate, not that gate.
const DEV_BODY = `## Test Evidence\n- DEV deploy-verify: HEAD ${"0".repeat(40)}; N/A: test fixture`;

const PRODUCTION_SCRIPTS_DIR = path.resolve(SCRIPT_DIR, "..");
const PRODUCTION_LIB_DIR = path.join(PRODUCTION_SCRIPTS_DIR, "lib");
const PRODUCTION_HOOKS_LIB_DIR = path.join(PRODUCTION_SCRIPTS_DIR, "hooks", "lib");

/**
 * Install archive-gate scripts into a fixture by whole-directory lib copy.
 * MUST NOT hand-maintain *_LIB_CONTENT constants as the sole dependency path
 * (fix-false-green-signals D6 / pending #21).
 */
function installArchiveGateScripts(targetDir, { skipGateScript = false } = {}) {
  mkdirSync(path.join(targetDir, ".devpro/scripts"), { recursive: true });
  cpSync(PRODUCTION_LIB_DIR, path.join(targetDir, ".devpro/scripts/lib"), { recursive: true });
  cpSync(PRODUCTION_HOOKS_LIB_DIR, path.join(targetDir, ".devpro/scripts/hooks/lib"), { recursive: true });
  if (!skipGateScript) {
    writeFileSync(path.join(targetDir, ".devpro/scripts/pre-pr-archive-gate.mjs"), GATE_SCRIPT_CONTENT);
    writeFileSync(path.join(targetDir, ".devpro/scripts/lint-proposal-tasks-checked.mjs"), LINT_TASKS_CHECKED_CONTENT);
  }
}

const tmpRoot = makeTempDir("archive-before-push-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

let counter = 0;

function git(repo, ...args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

/**
 * Create a minimal git repo fixture.
 *
 * @param {object} opts
 * @param {string|null} opts.activeFolder — name of active openspec/changes folder to create
 * @param {boolean} opts.archiveOnly — if true, only create an archive folder (no active)
 * @param {string} opts.branchName — git branch for the fixture repo
 * @param {boolean} opts.skipGateScript — if true, do NOT install pre-pr-archive-gate.mjs
 */
function setupFixture({
  activeFolder = null,
  archiveOnly = false,
  branchName = "chore/enforce-archive-gate",
  skipGateScript = false,
} = {}) {
  const dir = path.join(tmpRoot, `fixture-${counter++}`);
  mkdirSync(dir, { recursive: true });

  // Init git repo
  git(dir, "init", "-q", "-b", branchName);
  git(dir, "config", "user.email", "t@t.com");
  git(dir, "config", "user.name", "t");

  // Install rule files so archive/rules helpers can read them.
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), REAL_PREFLIGHT);
  writeFileSync(path.join(dir, ".devpro/agent-rules/git-branch-naming-and-anchor.md"), REAL_ANCHOR_RULE);

  // Install the archive gate script via whole-lib copy (D6).
  installArchiveGateScripts(dir, { skipGateScript });

  if (activeFolder) {
    // Create an active change folder with a proposal-mini.md
    mkdirSync(path.join(dir, `openspec/changes/${activeFolder}`), { recursive: true });
    writeFileSync(
      path.join(dir, `openspec/changes/${activeFolder}/proposal-mini.md`),
      "# Proposal Mini: test\n"
    );
  }

  if (archiveOnly) {
    // Create only an archived folder (no active changes)
    const archiveName = `2026-05-20-foo`;
    mkdirSync(path.join(dir, `openspec/changes/archive/${archiveName}`), { recursive: true });
    writeFileSync(
      path.join(dir, `openspec/changes/archive/${archiveName}/proposal-mini.md`),
      "# Proposal Mini: foo (archived)\n\n## Why\n\nTest reason.\n\n## What Changes\n\nTest changes.\n"
    );
  }

  // Initial commit
  writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");

  return dir;
}

function runHook(command, fixtureDir, envOverrides = {}) {
  const payload = {
    tool_name: "Bash",
    tool_input: { command },
  };
  const sentinelDir = makeTempDir("archive-push-sentinel-");
  // Spawn via process.execPath (absolute) rather than the bare "node" name so
  // this outer spawn's own command lookup is unaffected by a caller-supplied
  // PATH override in envOverrides (F2 probe-failed test needs to strip "node"
  // from the INNER hook process's PATH without breaking this OUTER spawn).
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: fixtureDir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
      // Keep archive-specific checks out of these hook-routing fixtures.
      DEVPRO_RELEVANT_ARCHIVES: "",
      PWD: fixtureDir,
      ...envOverrides,
    },
  });
  let json = null;
  try {
    json = r.stdout ? JSON.parse(r.stdout) : null;
  } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function writeArchiveProposal(dir, { valid = true } = {}) {
  const archiveName = `2026-05-30-worktree-cwd`;
  const archiveDir = path.join(dir, `openspec/changes/archive/${archiveName}`);
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    path.join(archiveDir, "proposal-mini.md"),
    valid
      ? "# Proposal Mini: worktree-cwd\n\n## Why\n\nTest reason.\n\n## What Changes\n\nTest changes.\n"
      : "# Proposal Mini: worktree-cwd\n\n## Why\n\nTest reason.\n"
  );
}

function setupMainDebtWorktreeFixFixture({
  branchName = "chore/enforce-archive-gate",
} = {}) {
  const mainDir = path.join(tmpRoot, `fixture-${counter++}`);
  const wtDir = path.join(tmpRoot, `fixture-${counter++}-wt`);
  mkdirSync(mainDir, { recursive: true });

  git(mainDir, "init", "-q", "-b", "main");
  git(mainDir, "config", "user.email", "t@t.com");
  git(mainDir, "config", "user.name", "t");

  mkdirSync(path.join(mainDir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(mainDir, ".devpro/agent-rules/preflight-checklist.md"), REAL_PREFLIGHT);
  writeFileSync(path.join(mainDir, ".devpro/agent-rules/git-branch-naming-and-anchor.md"), REAL_ANCHOR_RULE);

  installArchiveGateScripts(mainDir);

  writeArchiveProposal(mainDir, { valid: false });
  writeFileSync(path.join(mainDir, "README.md"), "fixture\n");
  git(mainDir, "add", "-A");
  git(mainDir, "commit", "-q", "-m", "init");
  git(mainDir, "update-ref", "refs/remotes/origin/main", "HEAD");

  git(mainDir, "worktree", "add", "-q", "-b", branchName, wtDir);
  writeArchiveProposal(wtDir, { valid: true });

  return { mainDir, wtDir, branchName };
}

test("Archive-before-push gate: git push + active change folder → advisory", () => {
  // Branch name must use a whitelisted verb so other gates don't interfere.
  // issue #848 Gap 3: gate (a) is scope-bound — the active folder must be OWNED
  // by the branch to block. Name it = branch suffix so it is owned without
  // needing git-diff.
  const dir = setupFixture({ activeFolder: "enforce-archive-gate", branchName: "chore/enforce-archive-gate" });
  const r = runHook("git push origin chore/enforce-archive-gate", dir);
  assert.notEqual(
    r.json?.decision,
    "block",
    `expected advisory, got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.match(
    advisoryText(r.json),
    /Active change folder/,
    `advisory should mention "Active change folder"; got: ${advisoryText(r.json)}`
  );
});

test("Archive-before-push gate: gh pr create + active change folder → advisory", () => {
  // issue #848 Gap 3: active folder must be OWNED (= branch suffix) to block.
  const dir = setupFixture({ activeFolder: "enforce-archive-gate", branchName: "chore/enforce-archive-gate" });
  const r = runHook(
    `gh pr create --base main --head chore/enforce-archive-gate --title 'test' --body '${DEV_BODY}'`,
    dir
  );
  assert.notEqual(
    r.json?.decision,
    "block",
    `expected advisory, got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.match(
    advisoryText(r.json),
    /Active change folder/,
    `advisory should mention "Active change folder"; got: ${advisoryText(r.json)}`
  );
});

test("Archive-before-push gate: git push + only archive folder (no active) → pass", () => {
  const dir = setupFixture({ archiveOnly: true, branchName: "chore/enforce-archive-gate" });
  const r = runHook("git push origin chore/enforce-archive-gate", dir);
  // Positive assertion: hook must exit 0 and must not emit a block decision
  assert.equal(r.code, 0, `Expected hook exit 0 for archive-only fixture; stderr: ${r.stderr}`);
  assert.notEqual(
    r.json?.decision,
    "block",
    `archive gate must not fire when no active folder; got: ${JSON.stringify(r.json)}`
  );
});

test("Archive-before-push gate: git push --dry-run + active folder → pass (dry-run bypass)", () => {
  const dir = setupFixture({ activeFolder: "test-archive-gate", branchName: "chore/enforce-archive-gate" });
  const r = runHook("git push --dry-run origin chore/enforce-archive-gate", dir);
  // git push --dry-run does not write to remote — gate must not block it
  assert.equal(r.code, 0, `Expected hook exit 0 for --dry-run push; stderr: ${r.stderr}`);
  assert.notEqual(
    r.json?.decision,
    "block",
    `archive gate must not fire for --dry-run push; got: ${JSON.stringify(r.json)}`
  );
});

test("Archive-before-push gate: git push + active folder + gate script missing → pass (fail-open), named gate-script-absent", () => {
  const dir = setupFixture({
    activeFolder: "test-archive-gate",
    branchName: "chore/enforce-archive-gate",
    skipGateScript: true,
  });
  const r = runHook("git push origin chore/enforce-archive-gate", dir);
  // Fail-open: when gate script is absent, hook must not block (existsSync → return null)
  assert.equal(r.code, 0, `Expected hook exit 0 when gate script is missing; stderr: ${r.stderr}`);
  assert.notEqual(
    r.json?.decision,
    "block",
    `archive gate must fail-open when gate script missing; got: ${JSON.stringify(r.json)}`
  );
  // round-1 dp-reviewer F2: the fail-open pass MUST still be named via the
  // shared not-checked taxonomy (T10 `gate-script-absent`), not just silent.
  assert.match(
    advisoryText(r.json),
    /reason=gate-script-absent/,
    `expected a named gate-script-absent advisory; got: ${JSON.stringify(r.json)}`
  );
});

test("Archive-before-push gate (F2): git push + active folder + node unresolvable → probe-failed advisory", () => {
  // `checkArchiveBeforePushOrPRCreate` spawns `node <gatePath> <archiveCwd>`
  // via spawnSync — `probe-failed` fires when that spawn itself cannot start
  // (r.error), not merely when the spawned script exits non-zero. Simulate a
  // real ENOENT-shaped spawn failure by giving the INNER hook process a PATH
  // that resolves `git` (needed by the OTHER gates this push command also
  // runs through) but not `node` (the archive gate's own probe target).
  const dir = setupFixture({ activeFolder: "test-archive-gate", branchName: "chore/enforce-archive-gate" });
  const gitPath = resolveNativeExecutableOnPath("git");
  const nodeSuffixes = process.platform === "win32" ? [".exe", ".com"] : [""];
  const pathEntries = (process.env.PATH || "")
    .split(path.delimiter)
    .filter((entry) => {
      const directory = entry.replace(/^"|"$/gu, "");
      return !nodeSuffixes.some((suffix) => existsSync(path.join(directory, `node${suffix}`)));
    });
  assert.ok(
    !nodeSuffixes.some((suffix) => existsSync(path.join(path.dirname(gitPath), `node${suffix}`))),
    "real Git's PATH directory must not also expose Node for this probe-failure fixture"
  );
  const isolatedPath = [path.dirname(gitPath), ...pathEntries].join(path.delimiter);

  const r = runHook("git push origin chore/enforce-archive-gate", dir, { PATH: isolatedPath });

  assert.equal(r.code, 0, `Expected hook exit 0 (fail-open) when the gate's probe subprocess fails to spawn; stderr: ${r.stderr}`);
  assert.notEqual(r.json?.decision, "block", `probe-failed must fail-open, not block; got: ${JSON.stringify(r.json)}`);
  assert.match(
    advisoryText(r.json),
    /reason=probe-failed/,
    `expected a named probe-failed advisory; got: ${JSON.stringify(r.json)}`
  );
});

test("Archive-before-push gate: git -C worktree push uses worktree archive state, not main cwd debt", () => {
  const { mainDir, wtDir, branchName } = setupMainDebtWorktreeFixFixture();
  const r = runHook(`git -C ${JSON.stringify(wtDir)} push origin ${branchName}`, mainDir);
  assert.equal(
    r.code,
    0,
    `expected pass from worktree archive state; stdout: ${r.stdout}\nstderr: ${r.stderr}`
  );
  assert.notEqual(
    r.json?.decision,
    "block",
    `must not block on stale main archive debt when git -C targets fixed worktree; got: ${JSON.stringify(r.json)}`
  );
});

test("Archive-before-push gate: gh pr create --head uses branch worktree archive state, not main cwd debt", () => {
  const { mainDir, branchName } = setupMainDebtWorktreeFixFixture();
  const r = runHook(
    `gh pr create --base main --head ${branchName} --title 'test' --body '${DEV_BODY}'`,
    mainDir
  );
  assert.equal(
    r.code,
    0,
    `expected pass from --head branch worktree archive state; stdout: ${r.stdout}\nstderr: ${r.stderr}`
  );
  assert.notEqual(
    r.json?.decision,
    "block",
    `must not block on stale main archive debt when --head branch has a fixed worktree; got: ${JSON.stringify(r.json)}`
  );
});

test("Archive-before-push fixture copies whole scripts/lib (not hand *_LIB_CONTENT sole path)", () => {
  // Scenario: Whole-lib copy loads without hand LIB_CONTENT list
  // Scenario: New transitive lib module does not require hand-list update

  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /_LIB_CONTENT\s*=/,
    "fixture must not reintroduce hand *_LIB_CONTENT constants as the sole lib carrier",
  );
  assert.match(source, /cpSync\(\s*PRODUCTION_LIB_DIR/);
  assert.match(source, /cpSync\(\s*PRODUCTION_HOOKS_LIB_DIR/);

  const dir = setupFixture({ activeFolder: "enforce-archive-gate", branchName: "chore/enforce-archive-gate" });
  const fixtureLib = path.join(dir, ".devpro/scripts/lib");
  const productionNames = new Set(readdirSync(PRODUCTION_LIB_DIR));
  const fixtureNames = new Set(readdirSync(fixtureLib));
  assert.deepEqual(
    [...fixtureNames].sort(),
    [...productionNames].sort(),
    "fixture lib tree must match production lib wholesale",
  );
  // Deterministic assert: a production module outside the old hand list still lands.
  assert.equal(
    existsSync(path.join(fixtureLib, "find-root.mjs")),
    true,
    "whole-lib copy must include transitive modules without hand-list updates",
  );
});

// Scope change 1 (R17): with no worktree named by a head, the archive gate runs in the checkout gh pr create itself
// runs in, also when a redirect or a pipeline sits between the cd and the command.
test("Archive-before-push gate: a redirect between cd and gh pr create reads the cd target checkout", () => {
  const withActive = setupFixture({ activeFolder: "enforce-archive-gate", branchName: "chore/enforce-archive-gate" });
  const archiveOnly = setupFixture({ archiveOnly: true, branchName: "chore/enforce-archive-gate" });
  const create = `gh pr create --base main --title 'test' --body '${DEV_BODY}'`;
  for (const between of ["echo ok 2>&1", "echo ok | cat"]) {
    const toActive = runHook(`cd ${withActive} && ${between} && ${create}`, archiveOnly);
    assert.match(
      advisoryText(toActive.json),
      /Active change folder/,
      `[${between}] the cd target has an active change folder; got: ${advisoryText(toActive.json)}\nstderr: ${toActive.stderr}`
    );
    const toArchiveOnly = runHook(`cd ${archiveOnly} && ${between} && ${create}`, withActive);
    assert.doesNotMatch(
      advisoryText(toArchiveOnly.json),
      /Active change folder/,
      `[${between}] the cd target has no active change folder; got: ${advisoryText(toArchiveOnly.json)}\nstderr: ${toArchiveOnly.stderr}`
    );
  }
});
