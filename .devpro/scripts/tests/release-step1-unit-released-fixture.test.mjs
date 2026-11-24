/**
 * release-step1-unit-released-fixture.test.mjs
 *
 * Real-git fixture test for the `unit_released` bash function embedded in
 * `release-step-1-7.md` Step 1 (design.md D3, F-rmbc-pr1-01 remediation).
 *
 * The function is extracted verbatim from the rule leaf's fenced code block
 * (the block whose first line is the `# unit_released: 已上線判定（Step 1
 * SSOT）` marker) and executed against a real temporary git repository via
 * `bash -c`, under `set -euo pipefail`, calling the function directly (not
 * inside `$(...)`) so a bug that trips `errexit` on a normal `is-ancestor`
 * exit-1 result would fail this test the same way it would fail a real
 * Step 1 run.
 *
 * Four fixtures:
 *   (a) regular merge, already released           -> stdout "released"
 *   (b) regular merge, not yet released            -> stdout "unreleased"
 *   (c) squash merge, released, tip object missing -> stdout "released"
 *       (never touches the tip because the merge-commit check short-circuits)
 *   (d) merge-commit object missing                -> fail closed (exit != 0)
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSourceFile as read } from "./lib/read.mjs";
import { git, initRepo } from "./lib/git.mjs";

const MARKER = "# unit_released: 已上線判定（Step 1 SSOT）";

function extractUnitReleasedFunction() {
  const text = read(".devpro/agent-rules/release-step-1-7.md");
  const fenceRe = /```bash\n([\s\S]*?)```/g;
  const matches = [];
  let m;
  while ((m = fenceRe.exec(text))) {
    if (m[1].trimStart().startsWith(MARKER)) matches.push(m[1]);
  }
  assert.equal(
    matches.length,
    1,
    `expected exactly one fenced bash block in release-step-1-7.md starting with the unit_released marker; found ${matches.length}`,
  );
  return matches[0];
}

function runUnitReleased(cwd, functionSrc, tip, mergeCommit, anchor) {
  // Call the function as a plain top-level statement (not `$(...)`), so
  // `set -e` semantics apply the same way they would in a copy-pasted
  // Step 1 script.
  const script = `set -euo pipefail\n${functionSrc}\nunit_released "$1" "$2" "$3"\n`;
  return spawnSync("bash", ["-c", script, "bash", tip, mergeCommit, anchor], {
    cwd,
    encoding: "utf8",
  });
}

function buildFixtureRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "unit-released-fixture-"));
  initRepo(dir, { branch: "main", commit: true, userName: "t", userEmail: "t@t.com" });

  // (a)/(b) share one anchor: a commit on `main` right after regular-merging
  // feature/a. That anchor is a descendant of mcA (released) but predates
  // mcB, which is merged afterwards (unreleased against this anchor).
  git(dir, "checkout", "-b", "feature/a");
  git(dir, "commit", "--allow-empty", "-q", "-m", "feature a commit");
  const tipA = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "main");
  git(dir, "merge", "--no-ff", "feature/a", "-m", "merge a");
  const mcA = git(dir, "rev-parse", "HEAD");
  git(dir, "commit", "--allow-empty", "-q", "-m", "anchor point a");
  const anchorA = git(dir, "rev-parse", "HEAD");

  git(dir, "checkout", "-b", "feature/b");
  git(dir, "commit", "--allow-empty", "-q", "-m", "feature b commit");
  const tipB = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "main");
  git(dir, "merge", "--no-ff", "feature/b", "-m", "merge b");
  const mcB = git(dir, "rev-parse", "HEAD");

  // (c) squash merge: the squash commit's only parent is main's prior tip
  // (mcB), never feature/c's own commit — that's exactly what makes a
  // squash-merged unit's real headRefOid unrecoverable as an ancestor.
  git(dir, "checkout", "-b", "feature/c");
  writeFileSync(path.join(dir, "c.txt"), "feature c\n");
  git(dir, "add", "c.txt");
  git(dir, "commit", "-q", "-m", "feature c commit");
  git(dir, "checkout", "main");
  git(dir, "merge", "--squash", "feature/c");
  git(dir, "commit", "-q", "-m", "squash c");
  const mcC = git(dir, "rev-parse", "HEAD");
  git(dir, "commit", "--allow-empty", "-q", "-m", "anchor point c");
  const anchorC = git(dir, "rev-parse", "HEAD");

  return { dir, tipA, mcA, anchorA, tipB, mcB, mcC, anchorC };
}

const FAKE_TIP = "a".repeat(40);
const FAKE_MC = "b".repeat(40);

test("unit_released fixture: extracts exactly one fenced function", () => {
  const fn = extractUnitReleasedFunction();
  assert.ok(fn.includes("unit_released()"), "extracted block must define unit_released()");
});

test("unit_released fixture (a): regular merge already released -> released", () => {
  const fn = extractUnitReleasedFunction();
  const fixture = buildFixtureRepo();
  try {
    const result = runUnitReleased(fixture.dir, fn, fixture.tipA, fixture.mcA, fixture.anchorA);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), "released");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("unit_released fixture (b): regular merge not yet released -> unreleased", () => {
  const fn = extractUnitReleasedFunction();
  const fixture = buildFixtureRepo();
  try {
    // anchorA predates mcB entirely, so neither mcB nor tipB is its ancestor.
    const result = runUnitReleased(fixture.dir, fn, fixture.tipB, fixture.mcB, fixture.anchorA);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), "unreleased");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("unit_released fixture (c): squash merge released, tip object missing -> released", () => {
  const fn = extractUnitReleasedFunction();
  const fixture = buildFixtureRepo();
  try {
    // FAKE_TIP stands in for a squash-merged unit's original headRefOid,
    // which is never fetched/reachable once the branch is gone; the
    // merge-commit check alone must decide this case.
    const result = runUnitReleased(fixture.dir, fn, FAKE_TIP, fixture.mcC, fixture.anchorC);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), "released");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("unit_released fixture (d): merge-commit object missing -> fail closed (non-zero, no stdout verdict)", () => {
  const fn = extractUnitReleasedFunction();
  const fixture = buildFixtureRepo();
  try {
    const result = runUnitReleased(fixture.dir, fn, fixture.tipA, FAKE_MC, fixture.anchorA);
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
    assert.equal(result.stdout.trim(), "", "fail-closed path must not print a released/unreleased verdict");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
