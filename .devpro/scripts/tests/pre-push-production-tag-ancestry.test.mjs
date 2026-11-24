/**
 * pre-push-production-tag-ancestry.test.mjs
 *
 * The git-native pre-push hook rejects a pushed production-* tag unless it peels
 * to a commit on the pushed remote's production branch (local tracking ref, no
 * fetch). Every case runs a real `git push` through core.hooksPath against a
 * bare origin, so the stdin lines, remote argument and cwd are git's own.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const HOOKS_GIT_DIR = repoPath(".devpro/scripts/hooks-git");
const PRE_PUSH_JS = repoPath(".devpro/scripts/hooks-git/pre-push.mjs");
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function env() {
  const e = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  delete e.DEVPRO_PRUNE_REMOTE_DELETE;
  return e;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: env() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return (result.stdout || "").trim();
}

function push(cwd, args) {
  const result = spawnSync("git", ["push", ...args], { cwd, encoding: "utf8", env: env(), timeout: 60_000 });
  return { status: result.status, stderr: result.stderr || "" };
}

function commit(cwd, file, message) {
  writeFileSync(path.join(cwd, file), `${message}\n`);
  git(cwd, ["add", file]);
  git(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * origin has main and production; production holds a release merge commit P
 * that main does not. The work clone has fetched both and carries an unpushed
 * main commit M. The hook is armed only in the work clone.
 */
function makeFixture() {
  const root = makeTempDir("prodtag-");
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(seed);
  git(seed, ["init", "-q", "-b", "main"]);
  commit(seed, "README.md", "seed");
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "origin", "main"]);
  git(seed, ["checkout", "-q", "-b", "production"]);
  const productionSha = commit(seed, "release.txt", "release merge");
  git(seed, ["push", "-q", "origin", "production"]);
  git(root, ["clone", "-q", origin, work]);
  git(work, ["config", "core.hooksPath", HOOKS_GIT_DIR]);
  git(work, ["config", "user.name", "t"]);
  git(work, ["config", "user.email", "t@example.invalid"]);
  const mainSha = commit(work, "feature.txt", "main only");
  return { root, origin, seed, work, productionSha, mainSha };
}

const remoteTag = (fx, tag) => spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
  cwd: fx.origin, encoding: "utf8",
}).status === 0;

test("a production tag on a main commit is rejected and not created on the remote", () => {
  const fx = makeFixture();
  git(fx.work, ["tag", "production-20261114-9", fx.mainSha]);
  const r = push(fx.work, ["origin", "refs/tags/production-20261114-9"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /production tag must point at a commit on origin\/production/);
  assert.match(r.stderr, new RegExp(`production-20261114-9: ${fx.mainSha.slice(0, 12)} is not on origin/production`));
  assert.match(r.stderr, /release-step-1-7\.md Step 6/);
  assert.match(r.stderr, /does not fetch[\s\S]*git fetch origin/);
  assert.equal(remoteTag(fx, "production-20261114-9"), false);
});

test("lightweight and annotated production tags on the production commit are pushed", () => {
  const fx = makeFixture();
  git(fx.work, ["tag", "production-20261114-1", fx.productionSha]);
  git(fx.work, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "tag", "-a", "-m", "release", "production-v9.9.9", fx.productionSha]);
  const r = push(fx.work, ["origin", "production-20261114-1", "production-v9.9.9"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTag(fx, "production-20261114-1"), true);
  assert.equal(remoteTag(fx, "production-v9.9.9"), true);
});

test("an older production commit is also accepted (a release with no repo change)", () => {
  const fx = makeFixture();
  const seedSha = git(fx.work, ["rev-parse", "origin/main"]);
  git(fx.work, ["tag", "production-20261114-2", seedSha]);
  const r = push(fx.work, ["origin", "production-20261114-2"]);
  assert.equal(r.status, 0, r.stderr);
});

test("a missing remote-tracking production ref rejects as production target absent", () => {
  const fx = makeFixture();
  git(fx.work, ["update-ref", "-d", "refs/remotes/origin/production"]);
  git(fx.work, ["tag", "production-20261114-3", fx.productionSha]);
  const r = push(fx.work, ["origin", "production-20261114-3"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /production target absent: refs\/remotes\/origin\/production does not exist/);
  assert.match(r.stderr, /- production-20261114-3/);
  assert.equal(remoteTag(fx, "production-20261114-3"), false);
});

test("a stale tracking ref rejects a new production commit until it is fetched", () => {
  const fx = makeFixture();
  git(fx.seed, ["checkout", "-q", "production"]);
  const newer = commit(fx.seed, "release2.txt", "second release merge");
  git(fx.seed, ["push", "-q", "origin", "production"]);
  // Get the object without moving refs/remotes/origin/production.
  git(fx.work, ["fetch", "-q", fx.origin, "+refs/heads/production:refs/heads/copied-production"]);
  git(fx.work, ["tag", "production-20261114-4", newer]);
  const stale = push(fx.work, ["origin", "production-20261114-4"]);
  assert.notEqual(stale.status, 0, "the hook does not fetch; the old tracking ref decides");
  assert.match(stale.stderr, /is not on origin\/production/);
  git(fx.work, ["fetch", "-q", "origin"]);
  const fresh = push(fx.work, ["origin", "production-20261114-4"]);
  assert.equal(fresh.status, 0, fresh.stderr);
});

test("one bad production tag rejects the whole batch, including a branch and a good tag", () => {
  const fx = makeFixture();
  git(fx.work, ["checkout", "-q", "-b", "feature/x"]);
  git(fx.work, ["tag", "production-20261114-5", fx.productionSha]);
  git(fx.work, ["tag", "production-20261114-6", fx.mainSha]);
  const r = push(fx.work, ["origin", "feature/x", "production-20261114-5", "production-20261114-6"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /production-20261114-6:/);
  assert.doesNotMatch(r.stderr, /production-20261114-5:/, "only the failing tag is listed");
  assert.equal(remoteTag(fx, "production-20261114-5"), false);
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/feature/x"], { cwd: fx.origin }).status, 1);
});

test("tags already on the remote are not checked; non-production tags are not checked", () => {
  const fx = makeFixture();
  git(fx.work, ["tag", "production-20261113-1", fx.mainSha]);
  assert.equal(push(fx.work, ["--no-verify", "origin", "production-20261113-1"]).status, 0);
  git(fx.work, ["tag", "production-20261114-7", fx.productionSha]);
  git(fx.work, ["tag", "v1.0.0", fx.mainSha]);
  const r = push(fx.work, ["origin", "--tags"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTag(fx, "production-20261114-7"), true);
  assert.equal(remoteTag(fx, "v1.0.0"), true);
});

test("a production tag that does not peel to a commit is rejected", () => {
  const fx = makeFixture();
  const blob = git(fx.work, ["rev-parse", `${fx.productionSha}:release.txt`]);
  git(fx.work, ["tag", "production-20261114-8", blob]);
  const r = push(fx.work, ["origin", "production-20261114-8"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`production-20261114-8: ${blob.slice(0, 12)} does not resolve to a commit`));
});

test("the pushed remote's tracking ref is used when the remote is not named origin", () => {
  const fx = makeFixture();
  git(fx.work, ["remote", "rename", "origin", "upstream"]);
  git(fx.work, ["tag", "production-20261114-10", fx.mainSha]);
  const bad = push(fx.work, ["upstream", "production-20261114-10"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /is not on upstream\/production/);
  git(fx.work, ["tag", "production-20261114-11", fx.productionSha]);
  assert.equal(push(fx.work, ["upstream", "production-20261114-11"]).status, 0);
});

test("origin/production decides when origin exists, for a second remote and for a push by URL", () => {
  const fx = makeFixture();
  const mirror = path.join(fx.root, "mirror.git");
  git(fx.root, ["clone", "-q", "--bare", fx.origin, mirror]);
  git(fx.work, ["remote", "add", "mirror", mirror]);
  // No refs/remotes/mirror/* exist: the check still uses origin/production.
  git(fx.work, ["tag", "production-20261114-13", fx.productionSha]);
  assert.equal(push(fx.work, ["mirror", "production-20261114-13"]).status, 0);
  git(fx.work, ["tag", "production-20261114-14", fx.mainSha]);
  const bad = push(fx.work, ["mirror", "production-20261114-14"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /is not on origin\/production/);
  const byUrl = push(fx.work, [mirror, "production-20261114-14"]);
  assert.notEqual(byUrl.status, 0);
  assert.match(byUrl.stderr, /is not on origin\/production/);
  git(fx.work, ["tag", "production-20261114-15", fx.productionSha]);
  assert.equal(push(fx.work, [mirror, "production-20261114-15"]).status, 0);
});

test("with no origin, a push by URL is rejected without printing the URL", () => {
  const fx = makeFixture();
  git(fx.work, ["remote", "rename", "origin", "upstream"]);
  git(fx.work, ["tag", "production-20261114-16", fx.productionSha]);
  const zero = "0".repeat(40);
  const secretUrl = "https://user:secret-token@example.invalid/repo.git";
  const r = spawnSync(process.execPath, [PRE_PUSH_JS, secretUrl, secretUrl], {
    cwd: fx.work,
    input: `refs/tags/production-20261114-16 ${fx.productionSha} refs/tags/production-20261114-16 ${zero}\n`,
    encoding: "utf8",
    env: env(),
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /production target absent: no remote named origin, and the push target is not a configured remote/);
  assert.doesNotMatch(r.stderr, /secret-token|example\.invalid/);
});

test("the check works from a lone copy of pre-push.mjs with no lib tree", () => {
  const fx = makeFixture();
  const lone = path.join(fx.root, "lone");
  mkdirSync(lone);
  copyFileSync(PRE_PUSH_JS, path.join(lone, "pre-push.mjs"));
  const zero = "0".repeat(40);
  const run = (sha) => spawnSync(process.execPath, [path.join(lone, "pre-push.mjs"), "origin", fx.origin], {
    cwd: fx.work,
    input: `refs/tags/production-20261114-12 ${sha} refs/tags/production-20261114-12 ${zero}\n`,
    encoding: "utf8",
    env: env(),
  });
  const bad = run(fx.mainSha);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /is not on origin\/production/);
  const good = run(fx.productionSha);
  assert.equal(good.status, 0, good.stderr);
});

test("the release runbook documents the push-time tag check where the tag is pushed", () => {
  const step = readFileSync(repoPath(".devpro/agent-rules/release-step-1-7.md"), "utf8");
  const para = step.split("\n").find((line) => line.startsWith("**推送時檢查 tag 目標**"));
  assert.ok(para, "Step 6 names the push-time tag check");
  for (const needle of ["hooks-git/pre-push.mjs", "refs/remotes/origin/production", "hook 不 fetch", "production target absent", "沒有 repo 變更的發版", "--no-verify"]) {
    assert.ok(para.includes(needle), needle);
  }
});

test("the incident backfill recipe fetches origin/production before tagging the tip", () => {
  const leaf = readFileSync(repoPath(".devpro/agent-rules/release-already-live-backfill.md"), "utf8");
  const step = leaf.split("\n").find((line) => line.startsWith("1. **補事故 tag"));
  assert.ok(step, "backfill §3 step 1 exists");
  const fetchAt = step.indexOf("git fetch origin +refs/heads/production:refs/remotes/origin/production --tags");
  assert.ok(fetchAt >= 0, "step 1 fetches origin/production");
  assert.ok(fetchAt < step.indexOf("補打事故"), "the fetch comes before tagging");
});
