// TD1 (strengthen-cross-review-loop-termination R8/D8): advisory-only
// review-ledger compactness lint — over-threshold prints an advisory line and
// STILL exits 0; a missing sidecar round_count counts as 1 round and is
// flagged `round_count_unavailable`; probe failures degrade to "skipped",
// never to a nonzero exit.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { recordReviewRoundDispatch } from "../hooks/lib/review-round-budget.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const LINT = repoPath(".devpro/scripts/lint-review-ledger-compactness.mjs");
const tmpRoot = makeTempDir("ledger-compactness-test-");
let counter = 0;

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function git(repo, ...args) {
  const result = spawnSync(
    "git",
    ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const CHANGE_REL = "openspec/changes/archive/2026-08-30-fixture-change";

function makeFixtureRepo({ addedLines }) {
  const repo = path.join(tmpRoot, `repo-${counter++}`);
  const changeDir = path.join(repo, CHANGE_REL);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(path.join(changeDir, "decisions.md"), "# Decisions\n");
  writeFileSync(path.join(changeDir, "tasks.md"), "# Tasks\n");
  const init = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  for (let i = 0; i < addedLines; i += 1) {
    appendFileSync(path.join(changeDir, "decisions.md"), `- post-archive ledger line ${i}\n`);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "post-archive growth");
  return { repo, base };
}

function runLint(repo, args, extraEnv = {}) {
  return spawnSync(process.execPath, [LINT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

test("TD1-1: over-threshold growth prints the advisory line and still exits 0", () => {
  const { repo, base } = makeFixtureRepo({ addedLines: 70 });
  const result = runLint(repo, [CHANGE_REL, "--base", base]);
  assert.equal(result.status, 0, "advisory lint MUST NOT block (exit 0)");
  assert.match(
    result.stdout,
    /Review ledger compactness advisory: 70 lines over 1 round\(s\) = 70\/round \(threshold 30\)/
  );
  assert.match(result.stdout, /round_count_unavailable/);
});

test("TD1-2: sidecar round_count is the denominator; under-threshold prints ok, no advisory", () => {
  const { repo, base } = makeFixtureRepo({ addedLines: 70 });
  const stateDir = path.join(tmpRoot, `state-${counter++}`);
  const prev = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  try {
    for (let round = 0; round < 3; round += 1) {
      recordReviewRoundDispatch({
        cwd: repo,
        prNumber: "55",
        attempt: "initial",
        dispatchId: `dispatch-${round}`,
        headRefOid: "b".repeat(40),
        reviewScope: "commit-range",
      });
    }
  } finally {
    if (prev === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prev;
  }
  const result = runLint(repo, [CHANGE_REL, "--base", base, "--pr", "55"], {
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Review ledger compactness: 70 lines over 3 round\(s\) .*— ok/);
  assert.doesNotMatch(result.stdout, /advisory:/);
  assert.doesNotMatch(result.stdout, /round_count_unavailable/);
});

test("TD1-3: unresolvable base degrades to skipped, exit 0", () => {
  const { repo } = makeFixtureRepo({ addedLines: 5 });
  const result = runLint(repo, [CHANGE_REL, "--base", "not-a-ref"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Review ledger compactness: skipped \(git diff --numstat failed/);
});

test("compactness takes its round denominator from the checkout repository", () => {
  const { repo, base } = makeFixtureRepo({ addedLines: 70 });
  git(repo, "remote", "add", "origin", "https://github.com/fixture/local.git");
  const stateDir = path.join(tmpRoot, `state-${counter++}`);
  const prev = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  try {
    recordReviewRoundDispatch({ cwd: repo, prNumber: "55", attempt: "initial", repositorySlug: "fixture/local" });
    for (let round = 0; round < 3; round++) {
      recordReviewRoundDispatch({ cwd: repo, prNumber: "55", attempt: "initial", repositorySlug: "fixture/foreign" });
    }
  } finally {
    if (prev === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prev;
  }
  const result = runLint(repo, [CHANGE_REL, "--base", base, "--pr", "55"], {
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /70 lines over 1 round/);
  assert.doesNotMatch(result.stdout, /round_count_unavailable/);
});

test("compactness flags an unowned legacy round count as unavailable", () => {
  const { repo, base } = makeFixtureRepo({ addedLines: 70 });
  git(repo, "remote", "add", "origin", "https://github.com/fixture/local.git");
  const stateDir = path.join(tmpRoot, `state-${counter++}`);
  mkdirSync(stateDir);
  const sidecar = path.join(stateDir, "review-round-55.json");
  const original = JSON.stringify({ schema_version: 1, pr_number: "55", round_count: 3, dispatch_lineage: [] });
  writeFileSync(sidecar, original);

  const result = runLint(repo, [CHANGE_REL, "--base", base, "--pr", "55"], {
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /advisory: 70 lines over 1 round.*round_count_unavailable/);
  assert.equal(readFileSync(sidecar, "utf8"), original);
});

test("TD1-4: missing arguments degrade to skipped usage line, exit 0", () => {
  const { repo } = makeFixtureRepo({ addedLines: 1 });
  const result = runLint(repo, []);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Review ledger compactness: skipped \(usage:/);
});
