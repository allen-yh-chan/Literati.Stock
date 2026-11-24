/**
 * Integration prove-it for R4 full-fallback CLI degrade.
 *
 * Spawns real git + the run-test-suite CLI; must stay off the unit tier so
 * lintManifest does not flag child_process:spawnSync in run-test-suite.test.mjs.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUN_TEST_SUITE_SCRIPT } from "../check-suite-runtime-budget.mjs";
import * as runner from "../run-test-suite.mjs";

const { EXIT_FULL_FALLBACK } = runner;
// The fixed repo-sweep guards ride along on every scoped plan; the fixture
// stubs every manifest integration test, so they are present here too.
const repoSweepCount = () => {
  assert.ok(Array.isArray(runner.REPO_SWEEP_INTEGRATION_TESTS), "REPO_SWEEP_INTEGRATION_TESTS must be exported");
  return runner.REPO_SWEEP_INTEGRATION_TESTS.length;
};
import { listFiles, TIER_INTEGRATION } from "../test-suite-manifest.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

function makeGitHelper(root) {
  return (args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
}

function initEmptyGitRepo(root) {
  const git = makeGitHelper(root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
  // This is a bounded synthetic runner fixture, not a source checkout.
  // Identify it before testing unknown-path fallback so preflight remains on.
  writeFileSync(path.join(root, ".devpro-synthetic-test-root"), "devpro-test-fixture-v1");
  return git;
}

function makeUnknownChangedRepo() {
  const root = makeTempDir("rts-ff-");
  const git = initEmptyGitRepo(root);
  writeFileSync(path.join(root, "mystery.bin"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  writeFileSync(path.join(root, "mystery2.bin"), "y\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "second"]);
  return root;
}

/** D-only changed set: one git-confirmed deleted suite-test-shaped path, nothing else. */
function makeDeletedSuiteTestOnlyRepo() {
  const root = makeTempDir("rts-ff-del-");
  const git = initEmptyGitRepo(root);
  const suiteTestPath = path.join(root, ".devpro", "scripts", "tests", "removed-example.test.mjs");
  mkdirSync(path.dirname(suiteTestPath), { recursive: true });
  writeFileSync(suiteTestPath, "export const removed = true;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  rmSync(suiteTestPath);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "delete suite test"]);
  return root;
}

/** D + unknown: a deleted suite test alongside an unrelated unclassifiable path. */
function makeDeletedSuiteTestPlusUnknownRepo() {
  const root = makeTempDir("rts-ff-del-unknown-");
  const git = initEmptyGitRepo(root);
  const suiteTestPath = path.join(root, ".devpro", "scripts", "tests", "removed-example.test.mjs");
  mkdirSync(path.dirname(suiteTestPath), { recursive: true });
  writeFileSync(suiteTestPath, "export const removed = true;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  rmSync(suiteTestPath);
  writeFileSync(path.join(root, "mystery.bin"), "z\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "delete suite test and add unknown carrier"]);
  return root;
}

test("CLI unknown-path full-fallback exits 75 without --allow-full-fallback", () => {
  const root = makeUnknownChangedRepo();
  const r = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, RUN_TEST_SUITE_SCRIPT), "--changed", "HEAD~1", "--root", root],
    { encoding: "utf8", cwd: root },
  );
  assert.equal(
    r.status,
    EXIT_FULL_FALLBACK,
    `expected ${EXIT_FULL_FALLBACK}; got ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`,
  );
  assert.match(`${r.stdout}\n${r.stderr}`, /full-fallback|FULL-FALLBACK/);
});

test("CLI: a git-confirmed deleted suite test alone stays scoped with only the repo-sweep guards (D4/D5, no full-fallback)", () => {
  const root = makeDeletedSuiteTestOnlyRepo();
  const r = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, RUN_TEST_SUITE_SCRIPT), "--changed", "HEAD~1", "--root", root],
    { encoding: "utf8", cwd: root },
  );
  const output = `${r.stdout}\n${r.stderr}`;
  // The fixture root is not the real source root, so the subsequent unit-tier
  // spawn result (it has no real .devpro/scripts/tests/*.test.mjs files) is
  // intentionally not asserted here (design.md D10) — only the `--changed`
  // selection summary printed before tiers run. The deleted test selects
  // nothing of its own; only the fixed repo-sweep guards are carried.
  assert.match(output, new RegExp(`integration_files=${repoSweepCount()}/\\d+ selection=scoped`), output);
  assert.doesNotMatch(output, /FULL-FALLBACK/, output);
});

test("Scenario: Deleted-test exemption does not mask other unknown paths", () => {
  const root = makeDeletedSuiteTestPlusUnknownRepo();
  const r = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, RUN_TEST_SUITE_SCRIPT), "--changed", "HEAD~1", "--root", root],
    { encoding: "utf8", cwd: root },
  );
  assert.equal(
    r.status,
    EXIT_FULL_FALLBACK,
    `expected ${EXIT_FULL_FALLBACK}; got ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`,
  );
  assert.match(`${r.stdout}\n${r.stderr}`, /full-fallback:unknown-path/);
});

/**
 * Script-reference fixture: a tracked script, a stub for every manifest
 * integration test (the CLI reads each one's source when a script changed), and
 * optionally one stub that names the script by its full repo-relative path.
 * The second commit renames the script to `.cjs`, so the old path is only
 * visible through the rename query (design.md D2).
 */
function makeScriptReferenceRepo({ namedByTest }) {
  const root = makeTempDir("rts-ff-ref-");
  const git = initEmptyGitRepo(root);
  const oldScript = ".devpro/scripts/lib/cli-ref-script.mjs";
  const newScript = ".devpro/scripts/lib/cli-ref-script.cjs";
  const integrationFiles = listFiles(TIER_INTEGRATION);
  integrationFiles.forEach((file, index) => {
    const stubPath = path.join(root, file);
    mkdirSync(path.dirname(stubPath), { recursive: true });
    writeFileSync(
      stubPath,
      index === 0 && namedByTest ? `// names ${oldScript}\n` : "// stub integration test\n",
    );
  });
  mkdirSync(path.join(root, path.dirname(oldScript)), { recursive: true });
  writeFileSync(path.join(root, oldScript), "export const marker = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  git(["mv", oldScript, newScript]);
  git(["commit", "-q", "-m", "rename script to .cjs"]);
  return { root, oldScript, integrationCount: integrationFiles.length, referencingTest: integrationFiles[0] };
}

test("Scenario: Deleted or renamed script selects the integration tests that still name its old path (CLI)", () => {
  const { root, integrationCount } = makeScriptReferenceRepo({ namedByTest: true });
  const r = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, RUN_TEST_SUITE_SCRIPT), "--changed", "HEAD~1", "--root", root],
    { encoding: "utf8", cwd: root },
  );
  const output = `${r.stdout}\n${r.stderr}`;
  // Only the selection summary printed before the tiers run is asserted: the
  // fixture root is not a real source root, so the later tier spawns are not
  // part of this prove-it.
  assert.match(output, new RegExp(`integration_files=${1 + repoSweepCount()}/${integrationCount} selection=scoped`), output);
  assert.match(output, new RegExp(`\\[test-suite\\] repo_sweep files=${repoSweepCount()} paths=`), output);
  assert.match(output, /\[test-suite\] script_references carriers=1 referencing_files=1 unreferenced=0\r?\n/, output);
  assert.doesNotMatch(output, /FULL-FALLBACK/, output);
});

test("Scenario: Changed script that no integration test names selects nothing and does not fall back (CLI)", () => {
  const { root, oldScript, integrationCount } = makeScriptReferenceRepo({ namedByTest: false });
  const r = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, RUN_TEST_SUITE_SCRIPT), "--changed", "HEAD~1", "--root", root],
    { encoding: "utf8", cwd: root },
  );
  const output = `${r.stdout}\n${r.stderr}`;
  assert.match(output, new RegExp(`integration_files=${repoSweepCount()}/${integrationCount} selection=scoped`), output);
  assert.match(
    output,
    new RegExp(
      `\\[test-suite\\] script_references carriers=1 referencing_files=0 unreferenced=1 unreferenced_paths=${oldScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n`,
    ),
    output,
  );
  assert.doesNotMatch(output, /FULL-FALLBACK/, output);
});
