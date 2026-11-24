import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const checker = repoPath(".devpro/scripts/check-committed-diff-whitespace.mjs");

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function mustRun(cmd, args, cwd) {
  const result = run(cmd, args, cwd);
  assert.equal(
    result.status,
    0,
    `${cmd} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

function createRepo({ tags = ["production-v1.0.0"] } = {}) {
  const dir = makeTempDir("committed-diff-whitespace-");
  mustRun("git", ["init", "-b", "main"], dir);
  mustRun("git", ["config", "user.email", "test@example.invalid"], dir);
  mustRun("git", ["config", "user.name", "Test User"], dir);
  writeFileSync(path.join(dir, "sample.md"), "line\n");
  mustRun("git", ["add", "sample.md"], dir);
  mustRun("git", ["commit", "-m", "initial"], dir);
  for (const tag of tags) mustRun("git", ["tag", tag], dir);
  return dir;
}

// A clean commit after the tagged one, returned as the selected main SHA.
function commitSelectedMain(dir) {
  writeFileSync(path.join(dir, "sample.md"), "line\nclean\n");
  mustRun("git", ["add", "sample.md"], dir);
  mustRun("git", ["commit", "-m", "selected main"], dir);
  return mustRun("git", ["rev-parse", "HEAD"], dir).stdout.trim();
}

test("fails on whitespace errors already committed in an explicit range", () => {
  const dir = createRepo();
  writeFileSync(path.join(dir, "sample.md"), "line\n\n");
  mustRun("git", ["add", "sample.md"], dir);
  mustRun("git", ["commit", "-m", "add blank eof"], dir);

  const result = run(process.execPath, [checker, "--range", "production-v1.0.0..HEAD"], dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Committed diff whitespace gate failed/);
  assert.match(result.stderr, /new blank line at EOF|blank line at EOF/);
});

test("passes clean committed ranges", () => {
  const dir = createRepo();
  writeFileSync(path.join(dir, "sample.md"), "line\nnext\n");
  mustRun("git", ["add", "sample.md"], dir);
  mustRun("git", ["commit", "-m", "clean change"], dir);

  const result = run(process.execPath, [checker, "--range", "production-v1.0.0..HEAD"], dir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Committed diff whitespace gate: pass/);
});

test("--release-main requires selected main SHA", () => {
  const dir = createRepo();

  const result = run(process.execPath, [checker, "--release-main"], dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--release-main requires the selected main SHA/);
});

test("--release-main rejects moving branch refs", () => {
  const dir = createRepo();

  const result = run(process.execPath, [checker, "--release-main", "main"], dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires an immutable selected main SHA, not a branch\/ref/);
});

test("--release-main checks latest production-v tag to selected main SHA", () => {
  const dir = createRepo();
  writeFileSync(path.join(dir, "sample.md"), "line\n\n");
  mustRun("git", ["add", "sample.md"], dir);
  mustRun("git", ["commit", "-m", "release whitespace blocker"], dir);
  const selectedMain = mustRun("git", ["rev-parse", "HEAD"], dir).stdout.trim();

  const result = run(process.execPath, [checker, "--release-main", selectedMain], dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`production-v1\\.0\\.0\\.\\.${selectedMain}`));
});

test("--release-main selected SHA is stable when main moves later", () => {
  const dir = createRepo();
  writeFileSync(path.join(dir, "sample.md"), "line\nclean\n");
  mustRun("git", ["add", "sample.md"], dir);
  mustRun("git", ["commit", "-m", "selected clean main"], dir);
  const selectedMain = mustRun("git", ["rev-parse", "HEAD"], dir).stdout.trim();

  writeFileSync(path.join(dir, "sample.md"), "line\nclean\n\n");
  mustRun("git", ["add", "sample.md"], dir);
  mustRun("git", ["commit", "-m", "later main whitespace"], dir);

  const result = run(process.execPath, [checker, "--release-main", selectedMain], dir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`production-v1\\.0\\.0\\.\\.${selectedMain}`));
});

// [Scenario: openspec-flow :: Consumer Full-Main Release Checks Main Whitespace From Its Latest Production Tag]
for (const [label, tags, expected] of [
  ["a consumer date tag", ["production-20261107"], "production-20261107"],
  ["a consumer rules tag", ["production-20261107-rules"], "production-20261107-rules"],
  [
    "consumer date and rules tags, newest by date then ordinal",
    ["production-20261106", "production-20261107-rules", "production-20261107", "production-20261107-2"],
    "production-20261107-2",
  ],
  ["source SemVer tags, compared as numbers", ["production-v1.9.0", "production-v1.10.0"], "production-v1.10.0"],
  ["a source SemVer tag newer than an old date tag", ["production-20200101", "production-v1.0.0"], "production-v1.0.0"],
  ["a malformed production tag beside a valid one", ["production-20261107", "production-latest"], "production-20261107"],
]) {
  test(`--release-main starts from the latest production tag: ${label}`, () => {
    const dir = createRepo({ tags });
    const selectedMain = commitSelectedMain(dir);

    const result = run(process.execPath, [checker, "--release-main", selectedMain], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`(${expected}..${selectedMain})`), result.stdout);
  });
}

for (const [label, tags] of [
  ["no production tag", []],
  ["only a malformed production tag", ["production-latest"]],
]) {
  test(`--release-main fails closed with ${label}`, () => {
    const dir = createRepo({ tags });
    const selectedMain = commitSelectedMain(dir);

    const result = run(process.execPath, [checker, "--release-main", selectedMain], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no production tag found/);
    assert.match(result.stderr, /production-vX\.Y\.Z, production-YYYYMMDD\[-n\] or production-YYYYMMDD-rules\[-n\]/);
    assert.doesNotMatch(result.stderr, /\n\s+at /, "the reason is printed, not a stack trace");
    assert.doesNotMatch(result.stdout, /pass/);
  });
}

test("--release-main with a selected SHA that does not exist still fails", () => {
  const dir = createRepo();

  const result = run(process.execPath, [checker, "--release-main", "f".repeat(40)], dir);

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /pass/);
});

test("pre-pr and release docs require committed-diff whitespace gate", () => {
  const prePr = readFileSync(repoPath(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md"), "utf8");
  const release = readFileSync(repoPath(".devpro/agent-rules/release-sit-uat-pat-prod.md"), "utf8");
  const releaseSteps = readFileSync(repoPath(".devpro/agent-rules/release-step-1-7.md"), "utf8");

  assert.match(prePr, /check-committed-diff-whitespace\.mjs --base <target-base-ref>/);
  assert.match(prePr, /git diff --check <target-base-ref>\.\.\.HEAD/);
  assert.match(release, /check-committed-diff-whitespace\.mjs --release-main <selected-main-sha>/);
  assert.match(releaseSteps, /check-committed-diff-whitespace\.mjs --release-main <selected-main-sha>/);
  assert.match(releaseSteps, /等價 `git diff --check <latest-production-tag>\.\.<selected-main-sha>`/);
  assert.doesNotMatch(releaseSteps, /<latest-production-v-tag>\.\.<selected-main-sha>/);
});
