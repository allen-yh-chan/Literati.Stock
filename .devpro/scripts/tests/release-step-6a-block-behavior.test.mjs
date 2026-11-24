import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { stepSixABlocks } from "./lib/step-6a-blocks.mjs";

// The Step 6A copy-execute blocks in release-back-merge-completion.md are run here against a throwaway repository with a
// bare origin: every route that is not the graph-only back-merge must stop before any push or PR. The static
// anchors for the same section live in release-back-merge-completion-grep.test.mjs (unit tier).

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture",
  // Git for Windows accepts its POSIX null path, not Node's device namespace.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const TAG = "production-fixture";
const BRANCH = "release/x";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitFile(cwd, file, message) {
  writeFileSync(path.join(cwd, file), `${message}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
}

// shape: "graph-only"  production = main's content merged in (zero tree delta)
//        "content"     production carries a commit main does not have
//        "no-op"       the promoted tag is already main's tip
// releaseBranch: "behind-tag" (normal), "diverged" (extra commit not in the tag), "ahead" (tag plus an extra commit)
function makeFixture({ shape, releaseBranch = "behind-tag", checkedOut = BRANCH }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "step6a-fixture-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  commitFile(work, "base.txt", "c0");
  git(work, "push", "-q", "origin", "main");
  git(work, "branch", "production");
  git(work, "push", "-q", "origin", "production");
  commitFile(work, "feature.txt", "c1");
  git(work, "push", "-q", "origin", "main");
  git(work, "branch", BRANCH);
  if (shape === "no-op") {
    git(work, "tag", TAG, "main");
  } else {
    git(work, "checkout", "-q", "production");
    if (shape === "content") commitFile(work, "hotfix.txt", "production-only");
    git(work, "merge", "-q", "--no-ff", "-m", "merge release", BRANCH);
    git(work, "tag", TAG);
    git(work, "push", "-q", "origin", "production");
  }
  git(work, "push", "-q", "origin", `refs/tags/${TAG}`);
  if (releaseBranch === "diverged") {
    git(work, "checkout", "-q", BRANCH);
    commitFile(work, "extra.txt", "release-only");
  } else if (releaseBranch === "ahead") {
    git(work, "checkout", "-q", "-B", BRANCH, TAG);
    commitFile(work, "extra.txt", "release-only");
  }
  git(work, "checkout", "-q", checkedOut);
  return {
    root,
    origin,
    work,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    originRef: (ref) => {
      const probe = spawnSync("git", ["rev-parse", "--verify", "-q", ref], { cwd: origin, env: GIT_ENV, encoding: "utf8" });
      return probe.status === 0 ? probe.stdout.trim() : null;
    },
  };
}

function runBlock(fixture, script, { env = {}, unset = [], bin } = {}) {
  // The paths are pasted into bash source, where a Windows backslash is an escape character.
  const forBash = (file) => file.split(path.sep).join("/");
  const realScript = path.join(REPO_ROOT, ".devpro/scripts/detect-branch-base.mjs");
  const body = fixture.bodyFile ?? path.join(fixture.root, "body.md");
  writeFileSync(body, "body\n");
  const source = script
    .replaceAll(".devpro/scripts/detect-branch-base.mjs", forBash(realScript))
    .replaceAll("<main-checkout-root>/notes/tmp/step6a-back-merge-<unique>.md", forBash(body));
  const childEnv = { ...GIT_ENV, PROMOTED_PRODUCTION_TAG: TAG, RELEASE_BRANCH: BRANCH, ...env };
  for (const key of unset) delete childEnv[key];
  if (bin) childEnv.PATH = `${bin}${path.delimiter}${childEnv.PATH}`;
  return spawnSync("bash", ["-c", source], { cwd: fixture.work, env: childEnv, encoding: "utf8" });
}

function withFixture(options, body) {
  const fixture = makeFixture(options);
  try {
    return body(fixture);
  } finally {
    fixture.cleanup();
  }
}

function stubGh(fixture) {
  const bin = path.join(fixture.root, "bin");
  mkdirSync(bin);
  const log = path.join(fixture.root, "gh.log");
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  chmodSync(path.join(bin, "gh"), 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

test("Step 6A first block, graph-only route: fast-forwards the release branch to the tag and pushes it", () => {
  withFixture({ shape: "graph-only" }, (fixture) => {
    const [push] = stepSixABlocks();
    const run = runBlock(fixture, push);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /STEP6A_RESULT=release-branch-pushed/);
    const tagCommit = git(fixture.work, "rev-parse", `${TAG}^{commit}`);
    assert.equal(fixture.originRef(`refs/heads/${BRANCH}`), tagCommit);
  });
});

test("Step 6A first block, gate already exit 0: reports no-op and neither pushes nor changes the release branch", () => {
  withFixture({ shape: "no-op" }, (fixture) => {
    const before = git(fixture.work, "rev-parse", "HEAD");
    const run = runBlock(fixture, stepSixABlocks()[0]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /STEP6A_RESULT=no-op-complete/);
    assert.doesNotMatch(run.stdout, /release-branch-pushed/);
    assert.equal(fixture.originRef(`refs/heads/${BRANCH}`), null, "no release branch pushed");
    assert.equal(git(fixture.work, "rev-parse", "HEAD"), before, "no fast-forward");
  });
});

test("Step 6A first block, content-review-required: stops before the ff and the push", () => {
  withFixture({ shape: "content" }, (fixture) => {
    const before = git(fixture.work, "rev-parse", "HEAD");
    const run = runBlock(fixture, stepSixABlocks()[0]);
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /STEP6A_RESULT=stop（recommendedRoute=production-ancestry-repair/, `${run.stdout}\n--stderr--\n${run.stderr}`);
    assert.equal(fixture.originRef(`refs/heads/${BRANCH}`), null, "nothing pushed");
    assert.equal(git(fixture.work, "rev-parse", "HEAD"), before, "no fast-forward");
  });
});

test("Step 6A first block, release branch diverged from the tag: the ff failure stops before the push", () => {
  withFixture({ shape: "graph-only", releaseBranch: "diverged" }, (fixture) => {
    const before = git(fixture.work, "rev-parse", "HEAD");
    const run = runBlock(fixture, stepSixABlocks()[0]);
    assert.notEqual(run.status, 0);
    assert.doesNotMatch(run.stdout, /release-branch-pushed/);
    assert.equal(fixture.originRef(`refs/heads/${BRANCH}`), null, "nothing pushed");
    assert.equal(git(fixture.work, "rev-parse", "HEAD"), before, "release branch untouched");
  });
});

test("Step 6A first block, release branch already ahead of the tag: stops because HEAD is not the tag, before the push", () => {
  withFixture({ shape: "graph-only", releaseBranch: "ahead" }, (fixture) => {
    const run = runBlock(fixture, stepSixABlocks()[0]);
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /STEP6A_RESULT=stop（ff 後 HEAD 不等於 promoted tag/);
    assert.equal(fixture.originRef(`refs/heads/${BRANCH}`), null, "nothing pushed");
  });
});

test("Step 6A first block, wrong branch checked out: stops before merging into it or pushing", () => {
  withFixture({ shape: "graph-only", checkedOut: "main" }, (fixture) => {
    const before = git(fixture.work, "rev-parse", "HEAD");
    const run = runBlock(fixture, stepSixABlocks()[0]);
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /STEP6A_RESULT=stop（目前不在 release\/x 的 checkout/);
    assert.equal(fixture.originRef(`refs/heads/${BRANCH}`), null, "nothing pushed");
    assert.equal(git(fixture.work, "rev-parse", "HEAD"), before, "main untouched");
  });
});

test("Step 6A first block, Step 6 values not brought in: fails closed before touching anything", () => {
  withFixture({ shape: "graph-only" }, (fixture) => {
    for (const missing of ["PROMOTED_PRODUCTION_TAG", "RELEASE_BRANCH"]) {
      const run = runBlock(fixture, stepSixABlocks()[0], { unset: [missing] });
      assert.notEqual(run.status, 0, `${missing} unset`);
      assert.equal(fixture.originRef(`refs/heads/${BRANCH}`), null, `${missing} unset: nothing pushed`);
    }
  });
});

test("Step 6A second block: opens the PR only when the remote release branch equals the promoted tag", () => {
  withFixture({ shape: "graph-only" }, (fixture) => {
    const gh = stubGh(fixture);
    const [push, pr] = stepSixABlocks();
    const premature = runBlock(fixture, pr, { bin: gh.bin });
    assert.notEqual(premature.status, 0, "release branch not pushed yet");
    assert.deepEqual(gh.calls(), [], "no PR before the release branch is on the tag");
    assert.equal(runBlock(fixture, push).status, 0);
    const opened = runBlock(fixture, pr, { bin: gh.bin });
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(gh.calls().length, 1);
    assert.match(gh.calls()[0], /^pr create --base main --head release\/x --title Step 6A: back-merge production-fixture into main --body-file /);
  });
});

test("Step 6A second block: a release branch pushed ahead of the tag does not get a PR", () => {
  withFixture({ shape: "graph-only", releaseBranch: "ahead" }, (fixture) => {
    const gh = stubGh(fixture);
    git(fixture.work, "push", "-q", "origin", BRANCH);
    const run = runBlock(fixture, stepSixABlocks()[1], { bin: gh.bin });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /STEP6A_RESULT=stop（origin\/release\/x 不等於 production-fixture/, `${run.stdout}\n--stderr--\n${run.stderr}`);
    assert.deepEqual(gh.calls(), []);
  });
});

test("Step 6A second block, the back-merge reached main after the first block: re-checks and opens no PR", () => {
  withFixture({ shape: "graph-only" }, (fixture) => {
    const gh = stubGh(fixture);
    const [push, pr] = stepSixABlocks();
    assert.equal(runBlock(fixture, push).status, 0);
    git(fixture.work, "push", "-q", "origin", `${TAG}^{commit}:refs/heads/main`);
    const run = runBlock(fixture, pr, { bin: gh.bin });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /STEP6A_RESULT=no-op-complete/);
    assert.deepEqual(gh.calls(), [], "main already has the tag, so no PR");
  });
});

test("Step 6A second block, gate already exit 0 with the remote release branch on the tag: opens no PR", () => {
  withFixture({ shape: "no-op" }, (fixture) => {
    const gh = stubGh(fixture);
    git(fixture.work, "push", "-q", "origin", BRANCH);
    assert.equal(fixture.originRef(`refs/heads/${BRANCH}`), git(fixture.work, "rev-parse", `${TAG}^{commit}`));
    const run = runBlock(fixture, stepSixABlocks()[1], { bin: gh.bin });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /STEP6A_RESULT=no-op-complete/);
    assert.deepEqual(gh.calls(), []);
  });
});

test("Step 6A second block, content-review-required with the remote release branch on the tag: opens no PR", () => {
  withFixture({ shape: "content" }, (fixture) => {
    const gh = stubGh(fixture);
    git(fixture.work, "push", "-q", "origin", `${TAG}^{commit}:refs/heads/${BRANCH}`);
    const run = runBlock(fixture, stepSixABlocks()[1], { bin: gh.bin });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /STEP6A_RESULT=stop（recommendedRoute=production-ancestry-repair/, `${run.stdout}\n--stderr--\n${run.stderr}`);
    assert.deepEqual(gh.calls(), []);
  });
});

test("Step 6A third block: the endpoint gate fails before the back-merge reaches main and exits 0 after", () => {
  withFixture({ shape: "graph-only" }, (fixture) => {
    const [push, , verify] = stepSixABlocks();
    assert.equal(runBlock(fixture, push).status, 0);
    assert.notEqual(runBlock(fixture, verify).status, 0, "tag is not yet a main ancestor");
    git(fixture.work, "push", "-q", "origin", `${TAG}^{commit}:refs/heads/main`);
    assert.equal(runBlock(fixture, verify).status, 0, "tag is a main ancestor once the back-merge lands");
  });
});
