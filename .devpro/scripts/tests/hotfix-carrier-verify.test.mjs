import "./lib/portable-command-shims.cjs";
// hotfix-carrier-verify.test.mjs
//
// Fixture + injected-GitHub-record coverage for every VF row in
// openspec/changes/enforce-hotfix-release-carrier/design.md §U7 Acceptance
// Matrix (git fixtures in temp dirs; a local bare remote stands in for
// GitHub's git storage; a fake `ghRunner` — or, for a handful of CLI
// end-to-end cases, a PATH-shim `gh` — stands in for GitHub's PR record).
//
// Row IDs are named in each test title so failures are traceable back to the
// matrix. Scenario titles from the ADDED requirement "Hotfix Reaches
// Production Only Through A Frozen Release Carrier"
// (specs/source-hotfix-semver-assemble/spec.md) are cited verbatim in
// `// Scenario: <title>` comments next to the tests that assert them.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(HERE, "..", "hotfix-carrier-verify.mjs");
const SCRIPT_URL = pathToFileURL(SCRIPT_PATH).href;

// Collaborator permissions the fixture GitHub reports for review-binding
// comment authors; any other login reads as "none". Every in-process run()
// gets this runner unless a test passes its own ghPermissionRunner.
const FIXTURE_PERMISSIONS = { "fixture-maintainer": "write", "fixture-owner": "admin", "fixture-reader": "read" };
function fixturePermissionRunner({ login }) {
  return FIXTURE_PERMISSIONS[login] ?? "none";
}

async function loadMod() {
  const mod = await import(SCRIPT_URL);
  return { ...mod, run: (argv, options = {}) => mod.run(argv, { ghPermissionRunner: fixturePermissionRunner, ...options }) };
}

// ---------------------------------------------------------------------------
// git fixture plumbing — isolated from the developer's own global gitconfig
// and any repo-local core.hooksPath, per test-performance-patterns.md (d).
// ---------------------------------------------------------------------------

let EMPTY_GITCONFIG;
const cleanupDirs = [];

before(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hcv-gitconfig-"));
  cleanupDirs.push(dir);
  EMPTY_GITCONFIG = path.join(dir, "gitconfig");
  await fsp.writeFile(EMPTY_GITCONFIG, "");
});

after(async () => {
  for (const dir of cleanupDirs) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

function gitEnv() {
  return { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: "1" };
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() });
}

function gitOk(cwd, args, label) {
  const r = git(cwd, args);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} failed${label ? ` (${label})` : ""}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function writeFile(work, rel, content) {
  const p = path.join(work, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function commitAll(work, message, files) {
  for (const [rel, content] of Object.entries(files)) writeFile(work, rel, content);
  gitOk(work, ["add", "-A"]);
  gitOk(work, ["commit", "-q", "-m", message]);
  return gitOk(work, ["rev-parse", "HEAD"]);
}

function deleteAndCommit(work, message, rels) {
  for (const rel of rels) fs.rmSync(path.join(work, rel), { force: true });
  gitOk(work, ["add", "-A"]);
  gitOk(work, ["commit", "-q", "-m", message]);
  return gitOk(work, ["rev-parse", "HEAD"]);
}

async function mkRepo(prefix) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(tmp);
  const work = path.join(tmp, "work");
  const bare = path.join(tmp, "remote.git");
  fs.mkdirSync(work, { recursive: true });
  gitOk(work, ["init", "-q", "-b", "main"]);
  gitOk(work, ["config", "user.email", "t@example.com"]);
  gitOk(work, ["config", "user.name", "Test"]);
  gitOk(work, ["config", "commit.gpgsign", "false"]);
  const bareRes = spawnSync("git", ["init", "-q", "--bare", bare], { env: gitEnv() });
  if (bareRes.status !== 0) throw new Error(`git init --bare failed: ${bareRes.stderr}`);
  gitOk(work, ["remote", "add", "origin", bare]);
  return { tmp, work, bare };
}

function push(work, refs) {
  gitOk(work, ["push", "-q", "origin", ...refs]);
}

function pushForce(work, refs) {
  gitOk(work, ["push", "-q", "-f", "origin", ...refs]);
}

function fetchAll(work) {
  gitOk(work, ["fetch", "-q", "origin", "--prune", "--tags"]);
}

function checkoutNew(work, branch, startPoint) {
  gitOk(work, ["checkout", "-q", "-b", branch, startPoint]);
}

function checkout(work, ref) {
  gitOk(work, ["checkout", "-q", ref]);
}

function mergeNoFF(work, ref, message) {
  gitOk(work, ["merge", "--no-ff", "-m", message, ref]);
  return gitOk(work, ["rev-parse", "HEAD"]);
}

function mergeOurs(work, ref, message) {
  gitOk(work, ["merge", "-s", "ours", "--no-ff", "-m", message, ref]);
  return gitOk(work, ["rev-parse", "HEAD"]);
}

function tag(work, name, ref) {
  gitOk(work, ["tag", name, ref ?? "HEAD"]);
}

function mergeFFOnly(work, ref) {
  gitOk(work, ["merge", "--ff-only", ref]);
  return gitOk(work, ["rev-parse", "HEAD"]);
}

function revertMergeCommit(work, mergeSha) {
  gitOk(work, ["revert", "-m", "1", "--no-edit", mergeSha]);
  return gitOk(work, ["rev-parse", "HEAD"]);
}

// ---------------------------------------------------------------------------
// Fake GitHub PR records
// ---------------------------------------------------------------------------

function makeGhRunner(records) {
  return ({ prNumber, fields }) => {
    const rec = records[prNumber];
    if (!rec) throw new Error(`no fixture PR record for #${prNumber}`);
    const out = {};
    for (const f of fields) out[f] = f in rec ? rec[f] : undefined;
    return out;
  };
}

function mc(oid) {
  return oid ? { oid } : null;
}

// ---------------------------------------------------------------------------
// review-binding PR comments (N44) — generated from the same
// {head, baseRefOid, mergeBaseSha} object that produces a body's `unit:`
// line, so the two cannot drift. Format per
// release-sit-uat-pat-prod.md#review-binding.
// ---------------------------------------------------------------------------

function reviewBindingCommentBody({ head, baseRefOid, mergeBaseSha }) {
  return [
    `hotfix-review-binding: head=${head} base_ref_oid=${baseRefOid} merge_base_sha=${mergeBaseSha}`,
    "",
    "Rules: v6.98.0 · Tool: dp-programmer · Model: fixture",
  ].join("\n");
}

// Write-access author, never edited, posted before every fixture mergedAt (2026-09-26T…)
// by default; override per test to exercise hotfix-review-binding-forgery.
function reviewBindingComment(args, { login = "fixture-maintainer", includesCreatedEdit = false, createdAt = "2026-09-25T00:00:00Z" } = {}) {
  return { body: reviewBindingCommentBody(args), author: { login }, includesCreatedEdit, createdAt };
}

// ---------------------------------------------------------------------------
// Provenance body-file helper
// ---------------------------------------------------------------------------

function provenanceBody({ lane, anchorTag, anchorCommit, carrier, carrierSha, bump, units, artifactId = "ci-run-1", builtAt = "2026-09-26T12:00:00Z", gates = "full=pass, smoke=pass" }) {
  const lines = [
    "```hotfix-carrier-provenance",
    `lane: ${lane}`,
    `anchor_tag: ${anchorTag}`,
    `anchor_commit: ${anchorCommit}`,
    `carrier: ${carrier}`,
    `carrier_sha: ${carrierSha}`,
    `bump: ${bump}`,
    ...units,
    `artifact_id: ${artifactId}`,
    `built_at: ${builtAt}`,
    `gates: ${gates}`,
    "```",
  ];
  return lines.join("\n");
}

async function writeBodyFile(dir, content) {
  const p = path.join(dir, `body-${Math.random().toString(36).slice(2)}.md`);
  await fsp.writeFile(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// Golden source-lane repo: anchor -> bump -> unit1 -> unit2 -> [frozen]
//                          -> production merge -> tag -> ff carrier -> back-merge
// ---------------------------------------------------------------------------

let G; // golden fixture state

async function buildGolden() {
  const { tmp, work, bare } = await mkRepo("hcv-golden-");
  const sha0 = commitAll(work, "init", { "README.md": "golden\n" });
  push(work, ["main"]);
  tag(work, "production-v1.0.0", sha0);
  push(work, ["production-v1.0.0"]);

  // `production` is created and pushed to the (still-live) bare remote HERE,
  // before the carrier work below, so that the frozen snapshot taken further
  // down already has an `origin/production` to resolve against.
  checkoutNew(work, "production", "production-v1.0.0");
  push(work, ["production"]);
  checkout(work, "main");

  checkoutNew(work, "release/v1.0.1", "production-v1.0.0");
  checkoutNew(work, "chore/bump-v1.0.1", "release/v1.0.1");
  const bumpHead = commitAll(work, "bump to 1.0.1", { "Directory.Build.props": "<Version>1.0.1</Version>\n" });
  checkout(work, "release/v1.0.1");
  const bumpMcSha = mergeNoFF(work, "chore/bump-v1.0.1", "bump-first merge");
  push(work, ["release/v1.0.1", "chore/bump-v1.0.1"]);

  // hotfix/fix-one is opened for review (pushed) but NOT yet merged into the
  // carrier — this is the true "review time" state for pre-merge unit1 checks:
  // carrier tip == bumpMcSha, AND the PR head commit object is reachable.
  checkoutNew(work, "hotfix/fix-one", "release/v1.0.1");
  const unit1Head = commitAll(work, "fix one", { "fix1.txt": "fix-one\n" });
  push(work, ["hotfix/fix-one"]);

  const beforeUnit1MergeTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "hcv-golden-beforeunit1-"));
  cleanupDirs.push(beforeUnit1MergeTmp);
  fs.cpSync(tmp, beforeUnit1MergeTmp, { recursive: true });
  const beforeUnit1MergeWork = path.join(beforeUnit1MergeTmp, "work");
  const beforeUnit1MergeBare = path.join(beforeUnit1MergeTmp, "remote.git");
  gitOk(beforeUnit1MergeWork, ["remote", "set-url", "origin", beforeUnit1MergeBare]);
  fetchAll(beforeUnit1MergeWork);

  checkout(work, "release/v1.0.1");
  const unit1Mc = mergeNoFF(work, "hotfix/fix-one", "merge fix one");

  checkoutNew(work, "hotfix/fix-two", "release/v1.0.1");
  const unit2Head = commitAll(work, "fix two", { "fix2.txt": "fix-two\n" });
  checkout(work, "release/v1.0.1");
  const unit2Mc = mergeNoFF(work, "hotfix/fix-two", "merge fix two");
  const carrierSha = unit2Mc; // frozen tip

  push(work, ["release/v1.0.1", "chore/bump-v1.0.1", "hotfix/fix-one", "hotfix/fix-two"]);

  // Snapshot the FROZEN state (before production merge) for pre-promote --body-file tests.
  // `git remote` URLs are absolute paths, so a raw directory copy still points
  // `origin` at the ORIGINAL (still-mutating) bare; repoint it at the frozen
  // bare copy so `fetchAll(frozenWork)` below is truly isolated.
  const frozenTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "hcv-golden-frozen-"));
  cleanupDirs.push(frozenTmp);
  fs.cpSync(tmp, frozenTmp, { recursive: true });
  const frozenWork = path.join(frozenTmp, "work");
  const frozenBare = path.join(frozenTmp, "remote.git");
  gitOk(frozenWork, ["remote", "set-url", "origin", frozenBare]);

  checkout(work, "production");
  const mergeSha = mergeNoFF(work, "release/v1.0.1", "production merge");
  push(work, ["production"]);
  tag(work, "production-v1.0.1", mergeSha);
  push(work, ["production-v1.0.1"]);

  checkout(work, "release/v1.0.1");
  mergeFFOnly(work, "production-v1.0.1"); // carrier advances to mergeSha
  push(work, ["release/v1.0.1"]);

  checkout(work, "main");
  const backMergeSha = mergeNoFF(work, "release/v1.0.1", "back-merge to main");
  push(work, ["main"]);

  // Extra stale back-merge-shaped commit reachable on main's first-parent
  // chain whose ^2 is deliberately NOT the synced carrier tip (N35b). Must be
  // a genuinely NEW merge commit — merging an already-ancestor ref is a
  // silent no-op ("Already up to date"), so the side branch is cut from the
  // anchor (a point main's tip does not yet contain).
  checkoutNew(work, "hcv-stale-side-branch", sha0);
  const staleSideHead = commitAll(work, "unrelated side content (fixture only)", { "stale-side.txt": "1\n" });
  checkout(work, "main");
  const bmStaleSha = mergeNoFF(work, staleSideHead, "stale back-merge (fixture only)");
  push(work, ["main"]);

  fetchAll(work);
  fetchAll(frozenWork);

  // F-ehrc-r1-03: a dedicated post-production snapshot (own bare remote,
  // like frozen/beforeUnit1 above) in which the carrier is pushed ONE commit
  // past `mergeSha` -- used to reach post-promote's 5c/carrier-advanced
  // branch with a genuinely correct `--carrier-sha`, instead of N16's old
  // (unintentional) trip through `production-pr-head-oid` via a wrong sha.
  const carrierAdvancedTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "hcv-golden-carrieradv-"));
  cleanupDirs.push(carrierAdvancedTmp);
  fs.cpSync(tmp, carrierAdvancedTmp, { recursive: true });
  const carrierAdvancedWork = path.join(carrierAdvancedTmp, "work");
  const carrierAdvancedBare = path.join(carrierAdvancedTmp, "remote.git");
  gitOk(carrierAdvancedWork, ["remote", "set-url", "origin", carrierAdvancedBare]);
  checkout(carrierAdvancedWork, "release/v1.0.1");
  const carrierAdvancedSha = commitAll(carrierAdvancedWork, "carrier advances past the production merge (fixture only)", { "carrier-advanced.txt": "1\n" });
  push(carrierAdvancedWork, ["release/v1.0.1"]);

  return {
    tmp, work, bare,
    frozenTmp, frozenWork, frozenBare,
    beforeUnit1MergeTmp, beforeUnit1MergeWork, beforeUnit1MergeBare,
    carrierAdvancedTmp, carrierAdvancedWork, carrierAdvancedBare, carrierAdvancedSha,
    sha0, bumpHead, bumpMcSha, unit1Head, unit1Mc, unit2Head, unit2Mc, carrierSha,
    mergeSha, backMergeSha, bmStaleSha,
    carrier: "release/v1.0.1",
    anchorTag: "production-v1.0.0",
  };
}

function goldenGhRecords(G_) {
  return {
    101: { number: 101, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "chore/bump-v1.0.1", headRefOid: G_.bumpHead, baseRefName: G_.carrier, mergeCommit: mc(G_.bumpMcSha) },
    102: { number: 102, state: "MERGED", mergedAt: "2026-09-26T00:01:00Z", headRefName: "hotfix/fix-one", headRefOid: G_.unit1Head, baseRefName: G_.carrier, mergeCommit: mc(G_.unit1Mc), comments: [reviewBindingComment({ head: G_.unit1Head, baseRefOid: G_.bumpMcSha, mergeBaseSha: G_.bumpMcSha })] },
    103: { number: 103, state: "MERGED", mergedAt: "2026-09-26T00:02:00Z", headRefName: "hotfix/fix-two", headRefOid: G_.unit2Head, baseRefName: G_.carrier, mergeCommit: mc(G_.unit2Mc), comments: [reviewBindingComment({ head: G_.unit2Head, baseRefOid: G_.unit1Mc, mergeBaseSha: G_.unit1Mc })] },
    104: { number: 104, state: "MERGED", mergedAt: "2026-09-26T00:03:00Z", headRefName: G_.carrier, headRefOid: G_.carrierSha, baseRefName: "production", mergeCommit: mc(G_.mergeSha), body: goldenProvenanceBody(G_) },
    105: { number: 105, state: "MERGED", mergedAt: "2026-09-26T00:04:00Z", headRefName: G_.carrier, headRefOid: G_.mergeSha, baseRefName: "main", mergeCommit: mc(G_.backMergeSha) },
  };
}

function goldenProvenanceBody(G_) {
  return provenanceBody({
    lane: "source",
    anchorTag: G_.anchorTag,
    anchorCommit: G_.sha0,
    carrier: G_.carrier,
    carrierSha: G_.carrierSha,
    bump: `pr=101 head=${G_.bumpHead} mc=${G_.bumpMcSha}`,
    units: [
      `unit: pr=102 approved_tip=${G_.unit1Head} base_ref_oid=${G_.bumpMcSha} merge_base_sha=${G_.bumpMcSha} mc=${G_.unit1Mc} shape=merge`,
      `unit: pr=103 approved_tip=${G_.unit2Head} base_ref_oid=${G_.unit1Mc} merge_base_sha=${G_.unit1Mc} mc=${G_.unit2Mc} shape=merge`,
    ],
  });
}

// post-promote --provenance-sha256 for the golden production PR body; tests
// that fail before the provenance checks pass UNUSED_PROVENANCE_DIGEST.
function provenanceDigestOf(body) {
  const block = body.replace(/\r\n?/g, "\n").match(/```hotfix-carrier-provenance\n([\s\S]*?)\n```/)[1];
  return createHash("sha256").update(block.split("\n").map((l) => l.trim()).filter(Boolean).join("\n"), "utf8").digest("hex");
}
function goldenProvenanceDigest() {
  return provenanceDigestOf(goldenProvenanceBody(G));
}
const UNUSED_PROVENANCE_DIGEST = "0".repeat(64);

function checkIds(checks) {
  return checks.map((c) => c.id);
}
function findCheck(checks, id) {
  return checks.find((c) => c.id === id);
}
function assertFailedCheck(result, id) {
  const c = findCheck(result.checks, id);
  assert.ok(c, `expected a check with id ${id}; got ids: ${checkIds(result.checks).join(", ")}`);
  assert.equal(c.ok, false, `expected check ${id} to be ok:false; detail=${c.detail}`);
}

// ---------------------------------------------------------------------------
// Content-integrity repo: hotfix/-bump "-s ours" corruption + real conflict
// ---------------------------------------------------------------------------

let CI;

async function buildContentIntegrityRepo() {
  const { tmp, work, bare } = await mkRepo("hcv-ci-");
  const sha0 = commitAll(work, "init", { "base.txt": "base\n" });
  push(work, ["main"]);
  tag(work, "production-v2.0.0", sha0);
  push(work, ["production-v2.0.0"]);

  checkoutNew(work, "release/v2.0.1", "production-v2.0.0");
  // Carrier's own progression before the hotfix unit (plays the role of
  // "base_ref_oid" for the corrupted-hotfix-merge case).
  const carrierBeforeUnit = commitAll(work, "carrier progression", { "carrier.txt": "carrier-content\n" });

  checkoutNew(work, "hotfix/fix-corrupt", "release/v2.0.1");
  const hotfixHead = commitAll(work, "hotfix change", { "hotfix.txt": "hotfix-content\n" });
  checkout(work, "release/v2.0.1");
  const corruptHotfixMc = mergeOurs(work, "hotfix/fix-corrupt", "corrupt hotfix merge (-s ours)"); // N30

  // Real conflict, hand-resolved inside the merge commit (N32).
  checkoutNew(work, "hotfix/fix-conflict", "release/v2.0.1");
  writeFile(work, "carrier.txt", "conflicting-hotfix-content\n");
  gitOk(work, ["add", "-A"]);
  gitOk(work, ["commit", "-q", "-m", "conflicting change"]);
  const conflictHead = gitOk(work, ["rev-parse", "HEAD"]);
  checkout(work, "release/v2.0.1");
  writeFile(work, "carrier.txt", "carrier-own-change\n");
  gitOk(work, ["add", "-A"]);
  gitOk(work, ["commit", "-q", "-m", "carrier own change (creates conflict base)"]);
  const carrierBeforeConflict = gitOk(work, ["rev-parse", "HEAD"]);
  const mergeArgs = ["merge", "--no-ff", "-m", "hand-resolved conflict merge", "hotfix/fix-conflict"];
  const conflictResult = git(work, mergeArgs);
  assert.notEqual(conflictResult.status, 0, "precondition: merge must actually conflict");
  writeFile(work, "carrier.txt", "hand-resolved\n");
  gitOk(work, ["add", "-A"]);
  gitOk(work, ["commit", "-q", "-m", "hand-resolved conflict merge"]);
  const conflictMc = gitOk(work, ["rev-parse", "HEAD"]);

  // Bump equivalent corruption (N31): a bump merged with -s ours from anchor.
  checkout(work, "release/v2.0.1");
  checkoutNew(work, "release/v2.0.2-bump-lane", "production-v2.0.0");
  checkoutNew(work, "chore/bump-v2.0.2", "release/v2.0.2-bump-lane");
  const bumpHead = commitAll(work, "bump", { "Directory.Build.props": "<Version>2.0.2</Version>\n" });
  checkout(work, "release/v2.0.2-bump-lane");
  const corruptBumpMc = mergeOurs(work, "chore/bump-v2.0.2", "corrupt bump merge (-s ours)");

  // N33b: re-purpose corruptHotfixMc (parents [carrierBeforeUnit, hotfixHead],
  // tree missing hotfix.txt due to -s ours) as a stand-in "production merge"
  // commit — tag it and give it a `production` branch so post-promote's
  // topology/GitHub checks are satisfiable, leaving only the tree-equality
  // check to fail.
  tag(work, "production-v2.0.1", corruptHotfixMc);
  checkoutNew(work, "production", corruptHotfixMc);
  push(work, ["production-v2.0.1", "production"]);

  push(work, ["release/v2.0.1", "release/v2.0.2-bump-lane", "hotfix/fix-corrupt", "hotfix/fix-conflict", "chore/bump-v2.0.2"]);
  fetchAll(work);

  return {
    tmp, work, bare,
    anchor: sha0,
    carrier: "release/v2.0.1",
    carrierBeforeUnit, hotfixHead, corruptHotfixMc,
    carrierBeforeConflict, conflictHead, conflictMc,
    bumpCarrier: "release/v2.0.2-bump-lane", bumpHead, corruptBumpMc,
  };
}

// ---------------------------------------------------------------------------
// Freshness-family repos
// ---------------------------------------------------------------------------

async function buildTagAdvancedRepo() {
  // N20a / C4-negative: an extra production-* tag descends from the anchor
  // (already-advanced tag) while origin/production still sits at the anchor.
  const { tmp, work, bare } = await mkRepo("hcv-tagadv-");
  const sha0 = commitAll(work, "init", { "a.txt": "1\n" });
  tag(work, "production-v1.0.0", sha0);
  const sha1 = commitAll(work, "advance", { "a.txt": "2\n" });
  tag(work, "production-v1.0.1", sha1);
  checkoutNew(work, "production", "production-v1.0.0");
  push(work, ["main", "production", "production-v1.0.0", "production-v1.0.1"]);
  fetchAll(work);
  return { tmp, work, bare, sha0, sha1 };
}

async function buildWrongBaseRepo() {
  // N5 (second detection path): the hotfix carrier was cut from a commit that
  // is NOT an ancestor of the (single) recorded production-* tag at all --
  // the operator branched from the wrong base entirely. Unlike N20a/N20b (a
  // *stale* but still-ancestor anchor), there is only ONE production-* tag
  // here, so freshness's own checks all pass cleanly; the defect is caught
  // exclusively by pre-promote's own chain-anchoring check.
  const { tmp, work, bare } = await mkRepo("hcv-wrongbase-");
  const root = commitAll(work, "root", { "a.txt": "0\n" });
  const sha0 = commitAll(work, "anchor", { "a.txt": "1\n" });
  tag(work, "production-v1.0.0", sha0);
  checkoutNew(work, "production", "production-v1.0.0");
  checkout(work, "main");

  // Sibling of sha0 (both children of root) -- neither ancestor nor
  // descendant of the real anchor.
  checkoutNew(work, "wrong-base", root);
  commitAll(work, "wrong base content", { "wrong.txt": "1\n" });

  checkoutNew(work, "release/v1.0.1", "wrong-base");
  checkoutNew(work, "hotfix/fix-one", "release/v1.0.1");
  const unitHead = commitAll(work, "fix", { "fix.txt": "1\n" });
  checkout(work, "release/v1.0.1");
  const unitMc = mergeNoFF(work, "hotfix/fix-one", "merge fix");

  push(work, ["main", "production", "production-v1.0.0", "wrong-base", "release/v1.0.1", "hotfix/fix-one"]);
  fetchAll(work);
  return { tmp, work, bare, root, sha0, unitHead, unitMc, carrier: "release/v1.0.1" };
}

async function buildProductionAdvancedNoTagRepo() {
  // N14 / N20b: origin/production has moved past the anchor with no new tag.
  const { tmp, work, bare } = await mkRepo("hcv-prodadv-");
  const sha0 = commitAll(work, "init", { "a.txt": "1\n" });
  tag(work, "production-v1.0.0", sha0);
  checkoutNew(work, "production", "production-v1.0.0");
  push(work, ["main", "production", "production-v1.0.0"]);

  checkoutNew(work, "release/v1.0.1", "production-v1.0.0");
  checkoutNew(work, "hotfix/fix-one", "release/v1.0.1");
  const unitHead = commitAll(work, "fix", { "fix.txt": "1\n" });
  checkout(work, "release/v1.0.1");
  const unitMc = mergeNoFF(work, "hotfix/fix-one", "merge fix");
  push(work, ["release/v1.0.1", "hotfix/fix-one"]);

  // Simulate a concurrent, already-promoted lane advancing production without a tag.
  checkout(work, "production");
  const productionAdvanced = commitAll(work, "concurrent promotion (no tag yet)", { "other.txt": "1\n" });
  push(work, ["production"]);
  fetchAll(work);

  return { tmp, work, bare, sha0, carrier: "release/v1.0.1", unitHead, unitMc, productionAdvanced };
}

async function buildTwoTagsSameCommitRepo() {
  // C4 positive: date-lane and rules-lane tags at the SAME commit.
  const { tmp, work, bare } = await mkRepo("hcv-twotags-");
  const sha0 = commitAll(work, "init", { "a.txt": "1\n" });
  tag(work, "production-20260101", sha0);
  tag(work, "production-20260101-rules", sha0);
  checkoutNew(work, "production", "production-20260101");
  push(work, ["main", "production", "production-20260101", "production-20260101-rules"]);
  fetchAll(work);
  return { tmp, work, bare, sha0 };
}

// ---------------------------------------------------------------------------
// Consumer-lane repos (bump applicability / version-metadata-files)
// ---------------------------------------------------------------------------

async function buildConsumerBumpRepo() {
  // C1: consumer with a version file, bump present and provable.
  const { tmp, work, bare } = await mkRepo("hcv-consumer-bump-");
  const sha0 = commitAll(work, "init", { "package.json": '{"version":"1.0.0"}\n' });
  tag(work, "production-20260201", sha0);
  checkoutNew(work, "production", "production-20260201");
  push(work, ["main", "production", "production-20260201"]);

  const carrier = "release/20260201-1234567";
  checkoutNew(work, carrier, "production-20260201");
  checkoutNew(work, "chore/bump-v1.0.1", carrier);
  const bumpHead = commitAll(work, "bump", { "package.json": '{"version":"1.0.1"}\n' });
  checkout(work, carrier);
  const bumpMc = mergeNoFF(work, "chore/bump-v1.0.1", "bump-first merge");

  checkoutNew(work, "hotfix/fix-y", carrier);
  const unitHead = commitAll(work, "fix", { "fix.txt": "1\n" });
  checkout(work, carrier);
  const unitMc = mergeNoFF(work, "hotfix/fix-y", "merge fix");

  push(work, [carrier, "chore/bump-v1.0.1", "hotfix/fix-y"]);
  fetchAll(work);
  return { tmp, work, bare, sha0, carrier, bumpHead, bumpMc, unitHead, unitMc };
}

async function buildConsumerNoVersionFileRepo() {
  // C2: consumer with no version-metadata files anywhere; bump: N/A accepted.
  const { tmp, work, bare } = await mkRepo("hcv-consumer-nover-");
  const sha0 = commitAll(work, "init", { "README.md": "1\n" });
  tag(work, "production-20260202", sha0);
  checkoutNew(work, "production", "production-20260202");
  push(work, ["main", "production", "production-20260202"]);

  const carrier = "release/20260202-89abcde";
  checkoutNew(work, carrier, "production-20260202");
  checkoutNew(work, "hotfix/fix-z", carrier);
  const unitHead = commitAll(work, "fix", { "fix.txt": "1\n" });
  checkout(work, carrier);
  const unitMc = mergeNoFF(work, "hotfix/fix-z", "merge fix");
  push(work, [carrier, "hotfix/fix-z"]);
  fetchAll(work);
  return { tmp, work, bare, sha0, carrier, unitHead, unitMc };
}

async function buildConsumerFfUnitRepo() {
  // F-ehrc-r1-14: a ff-shape unit -- the carrier advances via
  // `git merge --ff-only` straight to the hotfix head commit (no merge
  // commit at all) -- used to exercise pre-promote's ff-shape branch, which
  // had no fixture coverage whatsoever before this change.
  const { tmp, work, bare } = await mkRepo("hcv-consumer-ff-");
  // History before the anchor: an ancestor of approved_tip that is NOT the
  // preceding chain point -- the stale review base for N48.
  const preAnchor = commitAll(work, "pre-anchor history", { "history.txt": "1\n" });
  const sha0 = commitAll(work, "init", { "README.md": "1\n" });
  tag(work, "production-20260206", sha0);
  checkoutNew(work, "production", "production-20260206");
  push(work, ["main", "production", "production-20260206"]);

  const carrier = "release/20260206-1122334";
  checkoutNew(work, carrier, "production-20260206");
  checkoutNew(work, "hotfix/fix-ff", carrier);
  const unitHead = commitAll(work, "fix (ff)", { "fix.txt": "1\n" });
  checkout(work, carrier);
  mergeFFOnly(work, "hotfix/fix-ff"); // carrier advances to unitHead; no merge commit
  push(work, [carrier, "hotfix/fix-ff"]);

  // Unrelated sibling commit off the SAME anchor -- a real, valid 40-hex
  // commit that is neither an ancestor nor a descendant of unitHead, used
  // as a deliberately wrong `base_ref_oid` for the ancestor-check negative.
  checkoutNew(work, "unrelated-sibling", sha0);
  const siblingHead = commitAll(work, "unrelated sibling content (fixture only)", { "sibling.txt": "1\n" });
  checkout(work, carrier);

  fetchAll(work);
  return { tmp, work, bare, preAnchor, sha0, carrier, unitHead, siblingHead };
}

async function buildDirectCommitBumpRepo() {
  // N25: the carrier has a real intermediate commit at the chain position a
  // bump would occupy, but it is a plain single-parent commit, not a merged
  // `chore/bump-v*` PR — the chain length/position matches, so the failure
  // must surface inside bump-provenance verification (git-two-parents), not
  // at the chain-length-mismatch check.
  const { tmp, work, bare } = await mkRepo("hcv-directbump-");
  const sha0 = commitAll(work, "init", { "README.md": "1\n" });
  tag(work, "production-20260205", sha0);
  checkoutNew(work, "production", "production-20260205");
  push(work, ["main", "production", "production-20260205"]);

  const carrier = "release/20260205-aabbccd";
  checkoutNew(work, carrier, "production-20260205");
  const directCommit = commitAll(work, "direct commit masquerading as a bump", { "package.json": '{"version":"9.9.9"}\n' });

  checkoutNew(work, "hotfix/fix-direct", carrier);
  const unitHead = commitAll(work, "fix", { "fix.txt": "1\n" });
  checkout(work, carrier);
  const unitMc = mergeNoFF(work, "hotfix/fix-direct", "merge fix");
  push(work, [carrier, "hotfix/fix-direct"]);
  fetchAll(work);
  return { tmp, work, bare, sha0, carrier, directCommit, unitHead, unitMc };
}

async function buildSourceNoBumpRepo() {
  // "source lane MUST always bump" fixture: a single hotfix unit merged
  // directly onto the anchor on a SemVer-named (source-style) carrier, with
  // no bump anywhere in the chain — used to prove `bump: N/A` is rejected on
  // lane=source even when the topology would otherwise be unremarkable.
  const { tmp, work, bare } = await mkRepo("hcv-source-nobump-");
  const sha0 = commitAll(work, "init", { "README.md": "1\n" });
  tag(work, "production-v3.0.0", sha0);
  checkoutNew(work, "production", "production-v3.0.0");
  push(work, ["main", "production", "production-v3.0.0"]);

  const carrier = "release/v3.0.1";
  checkoutNew(work, carrier, "production-v3.0.0");
  checkoutNew(work, "hotfix/fix-nobump", carrier);
  const unitHead = commitAll(work, "fix", { "fix.txt": "1\n" });
  checkout(work, carrier);
  const unitMc = mergeNoFF(work, "hotfix/fix-nobump", "merge fix");
  push(work, [carrier, "hotfix/fix-nobump"]);
  fetchAll(work);
  return { tmp, work, bare, sha0, carrier, unitHead, unitMc, anchorTag: "production-v3.0.0" };
}

async function buildConsumerVersionFileIntroducedRepo() {
  // N27: no version file at anchor, but the unit itself introduces one and
  // the carrier tree ends up with it — bump: N/A must still fail.
  const { tmp, work, bare } = await mkRepo("hcv-consumer-introduced-");
  const sha0 = commitAll(work, "init", { "README.md": "1\n" });
  tag(work, "production-20260203", sha0);
  checkoutNew(work, "production", "production-20260203");
  push(work, ["main", "production", "production-20260203"]);

  const carrier = "release/20260203-fedcba1";
  checkoutNew(work, carrier, "production-20260203");
  checkoutNew(work, "hotfix/fix-w", carrier);
  const unitHead = commitAll(work, "adds package.json incidentally", { "package.json": '{"version":"0.0.1"}\n' });
  checkout(work, carrier);
  const unitMc = mergeNoFF(work, "hotfix/fix-w", "merge fix");
  push(work, [carrier, "hotfix/fix-w"]);
  fetchAll(work);
  return { tmp, work, bare, sha0, carrier, unitHead, unitMc };
}

async function buildConsumerAnchorHasFileCarrierDeletesRepo() {
  // N40: anchor HAS a version file; the unit deletes it from the carrier tree.
  // bump: N/A must still fail because the check considers the anchor tree too.
  const { tmp, work, bare } = await mkRepo("hcv-consumer-deleted-");
  const sha0 = commitAll(work, "init", { "package.json": '{"version":"1.0.0"}\n' });
  tag(work, "production-20260204", sha0);
  checkoutNew(work, "production", "production-20260204");
  push(work, ["main", "production", "production-20260204"]);

  const carrier = "release/20260204-0011223";
  checkoutNew(work, carrier, "production-20260204");
  checkoutNew(work, "hotfix/fix-v", carrier);
  const unitHead = deleteAndCommit(work, "delete package.json", ["package.json"]);
  checkout(work, carrier);
  const unitMc = mergeNoFF(work, "hotfix/fix-v", "merge fix (deletes package.json)");
  push(work, [carrier, "hotfix/fix-v"]);
  fetchAll(work);
  return { tmp, work, bare, sha0, carrier, unitHead, unitMc };
}

const VERSION_METADATA_MARKER_OPEN = "<!-- version-metadata-files:";
const VERSION_METADATA_MARKER_CLOSE = " -->";

function writeMarkerFile(dir, patternLines) {
  const md = [
    "# release-sit-uat-pat-prod (fixture)",
    "",
    "版本欄位（`hotfix-carrier-verify.mjs` 讀取本清單；Go 以 tag 為版本、無版本檔）：",
    `${VERSION_METADATA_MARKER_OPEN}start${VERSION_METADATA_MARKER_CLOSE}`,
    ...patternLines,
    `${VERSION_METADATA_MARKER_OPEN}end${VERSION_METADATA_MARKER_CLOSE}`,
    "",
  ].join("\n");
  const repoRoot = path.join(dir, "fixture-repo-root");
  fs.mkdirSync(path.join(repoRoot, ".devpro", "agent-rules"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".devpro", "agent-rules", "release-sit-uat-pat-prod.md"), md);
  return repoRoot;
}

const VALID_MARKER_LINES = [
  "- `Directory.Build.props` — .NET",
  "- `*.csproj` — .NET",
  "- `package.json` — Node",
  "- `pyproject.toml` — Python",
  "- `Cargo.toml` — Rust",
  "- `AGENTS.md` — source-only：頂部 `版本：`",
];

// ---------------------------------------------------------------------------
// Consumer-rules lane repo (revert-shape family: P5, P7, N37, N38, N39)
// ---------------------------------------------------------------------------

async function buildConsumerRulesRepo() {
  const { tmp, work, bare } = await mkRepo("hcv-rules-");
  const sha0 = commitAll(work, "init", { "rules.md": "v1\n" });
  push(work, ["main"]);
  tag(work, "production-20260301-rules", sha0);
  push(work, ["production-20260301-rules"]);
  checkoutNew(work, "production", "production-20260301-rules");
  push(work, ["production"]);

  // F-ehrc-r1-02: an ordinary (non rules-lane) production merge, ancestor of
  // the eventual anchor, deliberately left WITHOUT a `production-*-rules`
  // tag -- used as a `reverts=` target to prove revert-M-has-rules-tag
  // actually distinguishes a rules-lane production merge from a clean revert
  // of a plain application release merge.
  checkoutNew(work, "app-change-branch", "production-20260301-rules");
  const appChangeHead = commitAll(work, "regular application content change", { "app-early.txt": "1\n" });
  checkout(work, "production");
  const noRulesTagMergeSha = mergeNoFF(work, "app-change-branch", "regular production merge (no rules tag)");
  push(work, ["production"]);

  // A prior rules-lane production merge (2-parent) on origin/production's
  // first-parent chain, which the revert will name in `reverts=`.
  checkoutNew(work, "rules-change-branch", "production-20260301-rules");
  const rulesChangeHead = commitAll(work, "rules content change", { "rules.md": "v2 (drifted)\n" });
  checkout(work, "production");
  const priorRulesMergeSha = mergeNoFF(work, "rules-change-branch", "rules-lane production merge (to be reverted)");
  push(work, ["production"]);
  tag(work, "production-20260302-rules", priorRulesMergeSha);
  push(work, ["production-20260302-rules"]);

  // ---- clean revert path (P5): unit sits directly on the (new) anchor and
  // is exactly `git revert -m 1 <priorRulesMergeSha>`.
  const cleanCarrier = "release/rules-20260303";
  checkoutNew(work, cleanCarrier, "production-20260302-rules");
  checkoutNew(work, "hotfix/revert-rules-20260303", cleanCarrier);
  const cleanRevertHead = revertMergeCommit(work, priorRulesMergeSha);
  checkout(work, cleanCarrier);
  const cleanUnitMc = mergeNoFF(work, "hotfix/revert-rules-20260303", "merge clean revert");
  push(work, [cleanCarrier, "hotfix/revert-rules-20260303"]);

  // ---- hand-resolved path (P7): unit's content is NOT a clean revert
  // (extra application change folded in) — must go through a bump instead.
  const dirtyCarrier = "release/rules-20260304";
  checkoutNew(work, dirtyCarrier, "production-20260302-rules");
  checkoutNew(work, "hotfix/revert-rules-20260304", dirtyCarrier);
  revertMergeCommit(work, priorRulesMergeSha);
  const dirtyRevertHead = commitAll(work, "extra app change folded into the revert", { "app.txt": "extra\n" });
  checkout(work, dirtyCarrier);
  const dirtyUnitMc = mergeNoFF(work, "hotfix/revert-rules-20260304", "merge hand-resolved revert");
  // Emulate a bump-equivalent PR merged first on the dirty carrier lane too,
  // so `pre-promote` can validate a real bump provenance chain for P7.
  checkout(work, "production");
  // no-op: bump chain for consumer-rules just needs a real merged PR shape,
  // built directly below relative to the dirty carrier's own anchor.
  checkout(work, dirtyCarrier);

  push(work, [dirtyCarrier, "hotfix/revert-rules-20260304"]);

  // ---- content-dirty single-commit path (N37): exactly ONE commit directly
  // on the anchor (passes the parent-count/anchor checks) whose content is
  // NOT a clean `git revert -m 1` — an extra change is folded into the SAME
  // commit via amend, so only the tree-equality check can catch it.
  const contentDirtyCarrier = "release/rules-20260305";
  checkoutNew(work, contentDirtyCarrier, "production-20260302-rules");
  checkoutNew(work, "hotfix/revert-rules-20260305", contentDirtyCarrier);
  revertMergeCommit(work, priorRulesMergeSha);
  writeFile(work, "app.txt", "extra-folded-in\n");
  gitOk(work, ["add", "-A"]);
  gitOk(work, ["commit", "-q", "--amend", "--no-edit"]);
  const contentDirtyRevertHead = gitOk(work, ["rev-parse", "HEAD"]);
  checkout(work, contentDirtyCarrier);
  const contentDirtyUnitMc = mergeNoFF(work, "hotfix/revert-rules-20260305", "merge single-commit dirty revert");
  push(work, [contentDirtyCarrier, "hotfix/revert-rules-20260305"]);

  // ---- bump-rescue path (P7): a real bump merge lands first, THEN the
  // hand-resolved (non-clean-revert) unit merges on top of it — D11's
  // documented "manual conflict resolution -> go through a bump instead"
  // recovery path. `bump:` names the bump merge; `unit:` still names the
  // revert unit (verified normally, just skipping revert-shape per D4/F-3-1).
  const bumpRescueCarrier = "release/rules-20260306";
  checkoutNew(work, bumpRescueCarrier, "production-20260302-rules");
  checkoutNew(work, "chore/bump-v0.0.1", bumpRescueCarrier);
  const bumpRescueHead = commitAll(work, "version bump (rescue lane)", { "VERSION": "0.0.1\n" });
  checkout(work, bumpRescueCarrier);
  const bumpRescueMc = mergeNoFF(work, "chore/bump-v0.0.1", "bump-first merge (rescue lane)");

  checkoutNew(work, "hotfix/revert-rules-20260306", bumpRescueCarrier);
  revertMergeCommit(work, priorRulesMergeSha);
  const bumpRescueRevertHead = commitAll(work, "extra app change folded into the hand-resolved revert", { "app.txt": "extra\n" });
  checkout(work, bumpRescueCarrier);
  const bumpRescueUnitMc = mergeNoFF(work, "hotfix/revert-rules-20260306", "merge hand-resolved revert (bump-rescued)");
  push(work, [bumpRescueCarrier, "chore/bump-v0.0.1", "hotfix/revert-rules-20260306"]);

  // ---- approved_tip that is ITSELF a 2-parent merge commit (F-ehrc-r1-02):
  // proves revert-unit-one-parent actually fires when the unit head is not a
  // single commit, independent of N39 (single commit, but its parent is not
  // the anchor directly).
  const mergeHeadCarrier = "release/rules-20260307";
  checkoutNew(work, mergeHeadCarrier, "production-20260302-rules");
  checkoutNew(work, "hotfix/revert-rules-20260307", mergeHeadCarrier);
  checkoutNew(work, "hotfix/revert-rules-20260307-side", "hotfix/revert-rules-20260307");
  commitAll(work, "side content merged into the revert unit head", { "side.txt": "1\n" });
  checkout(work, "hotfix/revert-rules-20260307");
  const mergeHeadApprovedTip = mergeNoFF(work, "hotfix/revert-rules-20260307-side", "nested merge inside the revert unit (approved_tip is itself a merge)");
  checkout(work, mergeHeadCarrier);
  const mergeHeadUnitMc = mergeNoFF(work, "hotfix/revert-rules-20260307", "merge revert unit whose approved_tip is a merge commit");
  push(work, [mergeHeadCarrier, "hotfix/revert-rules-20260307", "hotfix/revert-rules-20260307-side"]);

  fetchAll(work);

  return {
    tmp, work, bare,
    anchor: priorRulesMergeSha,
    priorRulesMergeSha,
    noRulesTagMergeSha,
    mergeHeadCarrier, mergeHeadApprovedTip, mergeHeadUnitMc,
    cleanCarrier, cleanRevertHead, cleanUnitMc,
    dirtyCarrier, dirtyRevertHead, dirtyUnitMc,
    contentDirtyCarrier, contentDirtyRevertHead, contentDirtyUnitMc,
    bumpRescueCarrier, bumpRescueHead, bumpRescueMc, bumpRescueRevertHead, bumpRescueUnitMc,
  };
}

// ---------------------------------------------------------------------------
// before() — build all fixtures once
// ---------------------------------------------------------------------------

let TAGADV, PRODADV, TWOTAGS, C1REPO, C2REPO, CFFREPO, N25REPO, SRCNOBUMP, N27REPO, N40REPO, RULESREPO, WRONGBASE;

before(async () => {
  G = await buildGolden();
  CI = await buildContentIntegrityRepo();
  TAGADV = await buildTagAdvancedRepo();
  WRONGBASE = await buildWrongBaseRepo();
  PRODADV = await buildProductionAdvancedNoTagRepo();
  TWOTAGS = await buildTwoTagsSameCommitRepo();
  C1REPO = await buildConsumerBumpRepo();
  C2REPO = await buildConsumerNoVersionFileRepo();
  CFFREPO = await buildConsumerFfUnitRepo();
  N25REPO = await buildDirectCommitBumpRepo();
  SRCNOBUMP = await buildSourceNoBumpRepo();
  N27REPO = await buildConsumerVersionFileIntroducedRepo();
  N40REPO = await buildConsumerAnchorHasFileCarrierDeletesRepo();
  RULESREPO = await buildConsumerRulesRepo();
});

const GIT_OK_VERSION = "git version 2.50.1";

// ===========================================================================
// --help / usage
// ===========================================================================

describe("CLI --help / usage", () => {
  test("--help exits 0 and prints usage (in-process)", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(["--help"], { cwd: process.cwd() });
    assert.equal(exitCode, 0);
    assert.match(result.usage, /freshness/);
  });

  test("--help exits 0 (CLI end-to-end)", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /freshness/);
  });

  test("missing subcommand exits 2 (usage error)", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run([], { cwd: process.cwd() });
    assert.equal(exitCode, 2);
    assert.equal(result.ok, false);
  });

  test("unknown subcommand exits 2", async () => {
    const { run } = await loadMod();
    const { exitCode } = run(["bogus-subcommand"], { cwd: process.cwd(), gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 2);
  });
});

// ===========================================================================
// N46: `--no-fetch` is not a supported CLI flag
// Scenario: Provenance gates follow the recorded pass format (the AND clause:
// "the verifier's CLI MUST NOT expose any flag that skips fetching remote
// refs before these checks")
// ===========================================================================

describe("N46: --no-fetch has no CLI-flag spelling", () => {
  test("N46a: `freshness --no-fetch` exits 2, not treated as fixture isolation", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", G.anchorTag, "--anchor-commit", G.sha0, "--no-fetch"],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 2, JSON.stringify(result, null, 2));
    assert.match(result.reason, /--no-fetch/);
  });

  test("N46b: `--no-fetch=true` (eq-form) is rejected the same way", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", G.anchorTag, "--anchor-commit", G.sha0, "--no-fetch=true"],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 2, JSON.stringify(result, null, 2));
    assert.match(result.reason, /--no-fetch/);
  });

  test("N46c: e2e via the real CLI process also exits 2", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, "freshness", "--anchor-tag", G.anchorTag, "--anchor-commit", G.sha0, "--no-fetch"], {
      cwd: G.frozenWork,
      encoding: "utf8",
      env: gitEnv(),
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
  });
});

// ===========================================================================
// git version gate — N41
// ===========================================================================

describe("git version gate", () => {
  test("parseGitVersion handles trailing platform suffixes", async () => {
    const { parseGitVersion } = await loadMod();
    assert.deepEqual(parseGitVersion("git version 2.50.1"), [2, 50, 1]);
    assert.deepEqual(parseGitVersion("git version 2.39.5 (Apple Git-154)"), [2, 39, 5]);
    assert.deepEqual(parseGitVersion("git version 2.50.1.windows.1"), [2, 50, 1]);
    assert.equal(parseGitVersion("not a git version"), null);
  });

  test("N41: git 2.39.x exits 2 with a git-version check", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", G.anchorTag, "--anchor-commit", G.sha0],
      { cwd: G.work, gitVersionText: "git version 2.39.5 (Apple Git-154)", skipFetch: true },
    );
    assert.equal(exitCode, 2);
    assertFailedCheck(result, "git-version");
  });

  test("N41: unparseable git version text exits 2", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", G.anchorTag, "--anchor-commit", G.sha0],
      { cwd: G.work, gitVersionText: "garbage", skipFetch: true },
    );
    assert.equal(exitCode, 2);
    assertFailedCheck(result, "git-version");
  });

  test("git >= 2.40 passes the gate (golden repo, real installed git)", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", G.anchorTag, "--anchor-commit", G.sha0],
      { cwd: G.frozenWork, skipFetch: true },
    );
    assert.equal(exitCode, 0, JSON.stringify(result));
  });
});

// ===========================================================================
// freshness — N5 (via pre-promote later), N20, C4
// Scenario: Freshness gate fails closed with no lock exception
// ===========================================================================

describe("freshness subcommand", () => {
  test("positive: anchor unchanged and origin/production matches anchor", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", G.anchorTag, "--anchor-commit", G.sha0],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION, skipFetch: true },
    );
    assert.equal(exitCode, 0, JSON.stringify(result));
  });

  // F-ehrc-r1-10: --anchor-tag must name an actual tag, not a branch that
  // happens to resolve via git's generic ref-type fallback.
  test("F-ehrc-r1-10a: --anchor-tag names a branch, not a tag -> freshness.anchor-tag-is-production-tag", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", "production", "--anchor-commit", G.sha0],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION, skipFetch: true },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "freshness.anchor-tag-is-production-tag");
  });

  // Scenario: Freshness gate fails closed with no lock exception
  test("N20a: a production-* tag already advanced past the anchor -> exit 1, no lock exception", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", "production-v1.0.0", "--anchor-commit", TAGADV.sha0],
      { cwd: TAGADV.work, gitVersionText: GIT_OK_VERSION, skipFetch: true },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "freshness.no-unmerged-production-tags");
  });

  test("N20b: origin/production advanced past the anchor without a new tag -> exit 1", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", "production-v1.0.0", "--anchor-commit", PRODADV.sha0],
      { cwd: PRODADV.work, gitVersionText: GIT_OK_VERSION, skipFetch: true },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "freshness.origin-production-matches-anchor");
  });

  test("C4: two production-* tags (date + rules) at the same commit both pass", async () => {
    const { run } = await loadMod();
    const r1 = run(["freshness", "--anchor-tag", "production-20260101", "--anchor-commit", TWOTAGS.sha0], { cwd: TWOTAGS.work, gitVersionText: GIT_OK_VERSION, skipFetch: true });
    const r2 = run(["freshness", "--anchor-tag", "production-20260101-rules", "--anchor-commit", TWOTAGS.sha0], { cwd: TWOTAGS.work, gitVersionText: GIT_OK_VERSION, skipFetch: true });
    assert.equal(r1.exitCode, 0, JSON.stringify(r1.result));
    assert.equal(r2.exitCode, 0, JSON.stringify(r2.result));
  });

  test("C4: divergent two-family tags fail closed (no unmerged tolerance)", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", "production-v1.0.0", "--anchor-commit", TAGADV.sha0],
      { cwd: TAGADV.work, gitVersionText: GIT_OK_VERSION, skipFetch: true },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "freshness.no-unmerged-production-tags");
  });

  test("anchor tag moved (does not resolve to recorded commit) -> exit 1", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", G.anchorTag, "--anchor-commit", G.unit1Mc],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION, skipFetch: true },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "freshness.anchor-tag-unchanged");
  });
});

// ===========================================================================
// N43: a production-* tag resolved locally MUST also exist identically on
// the remote (freshness anchor tag / post-promote promoted tag).
// Scenario: Verifier accepts only production tags that exist on the remote
// ===========================================================================

describe("N43: remote tag existence/peel verification", () => {
  async function buildTagRemoteRepo() {
    const { tmp, work, bare } = await mkRepo("hcv-tagremote-");
    const sha0 = commitAll(work, "init", { "a.txt": "1\n" });
    tag(work, "production-v9.0.0", sha0);
    checkoutNew(work, "production", "production-v9.0.0");
    push(work, ["main", "production", "production-v9.0.0"]);

    const carrier = "release/v9.0.1";
    checkoutNew(work, carrier, "production-v9.0.0");
    checkoutNew(work, "hotfix/fix-remote", carrier);
    const unitHead = commitAll(work, "fix", { "fix.txt": "1\n" });
    checkout(work, carrier);
    const unitMc = mergeNoFF(work, "hotfix/fix-remote", "merge fix");
    push(work, [carrier, "hotfix/fix-remote"]);

    checkout(work, "production");
    const mergeSha = mergeNoFF(work, carrier, "production merge");
    push(work, ["production"]);
    tag(work, "production-v9.0.1", mergeSha);
    push(work, ["production-v9.0.1"]);

    fetchAll(work);
    return { tmp, work, bare, sha0, carrier, unitHead, unitMc, mergeSha };
  }

  // Anchored on production-v9.0.1 (the NEWEST tag, at mergeSha), not
  // production-v9.0.0 -- with two production-* tags present, anchoring on
  // the older one would trip `no-unmerged-production-tags` first (the newer
  // tag is a descendant, not an ancestor) before ever reaching the new check.
  test("N43a: freshness anchor tag exists only locally -> freshness.anchor-tag-on-remote", async () => {
    const { run } = await loadMod();
    const base = await buildTagRemoteRepo();
    gitOk(base.work, ["push", "-q", "origin", ":refs/tags/production-v9.0.1"]);
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", "production-v9.0.1", "--anchor-commit", base.mergeSha],
      { cwd: base.work, gitVersionText: GIT_OK_VERSION, skipFetch: true },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "freshness.anchor-tag-on-remote");
  });

  test("N43b: freshness anchor tag on remote peels to a different commit -> freshness.anchor-tag-on-remote", async () => {
    const { run } = await loadMod();
    const base = await buildTagRemoteRepo();
    gitOk(base.work, ["push", "-q", "-f", "origin", `${base.unitMc}:refs/tags/production-v9.0.1`]);
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", "production-v9.0.1", "--anchor-commit", base.mergeSha],
      { cwd: base.work, gitVersionText: GIT_OK_VERSION, skipFetch: true },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "freshness.anchor-tag-on-remote");
  });

  test("N43c: post-promote promoted tag exists only locally -> post-promote.tag-on-remote", async () => {
    const { run } = await loadMod();
    const base = await buildTagRemoteRepo();
    gitOk(base.work, ["push", "-q", "origin", ":refs/tags/production-v9.0.1"]);
    const ghRunner = makeGhRunner({
      104: { number: 104, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: base.carrier, headRefOid: base.unitMc, baseRefName: "production", mergeCommit: mc(base.mergeSha) },
    });
    const { exitCode, result } = run(
      ["post-promote", "--tag", "production-v9.0.1", "--carrier", base.carrier, "--carrier-sha", base.unitMc, "--anchor-commit", base.sha0, "--production-pr", "104", "--provenance-sha256", UNUSED_PROVENANCE_DIGEST],
      { cwd: base.work, ghRunner, gitVersionText: GIT_OK_VERSION, skipFetch: true },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "post-promote.tag-on-remote");
  });

  test("N43d: post-promote promoted tag on remote peels to a different commit -> post-promote.tag-on-remote", async () => {
    const { run } = await loadMod();
    const base = await buildTagRemoteRepo();
    gitOk(base.work, ["push", "-q", "-f", "origin", `${base.sha0}:refs/tags/production-v9.0.1`]);
    const ghRunner = makeGhRunner({
      104: { number: 104, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: base.carrier, headRefOid: base.unitMc, baseRefName: "production", mergeCommit: mc(base.mergeSha) },
    });
    const { exitCode, result } = run(
      ["post-promote", "--tag", "production-v9.0.1", "--carrier", base.carrier, "--carrier-sha", base.unitMc, "--anchor-commit", base.sha0, "--production-pr", "104", "--provenance-sha256", UNUSED_PROVENANCE_DIGEST],
      { cwd: base.work, ghRunner, gitVersionText: GIT_OK_VERSION, skipFetch: true },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "post-promote.tag-on-remote");
  });

  // Scenario: Verifier accepts only production tags that exist on the remote
  test("N43e positive: an annotated tag that peels to the same commit locally and on the remote passes", async () => {
    const { run } = await loadMod();
    const { work } = await mkRepo("hcv-tagremote-annotated-");
    const sha0 = commitAll(work, "init", { "a.txt": "1\n" });
    gitOk(work, ["tag", "-a", "production-v9.5.0", "-m", "annotated", sha0]);
    checkoutNew(work, "production", "production-v9.5.0");
    push(work, ["main", "production", "production-v9.5.0"]);
    fetchAll(work);
    const { exitCode, result } = run(
      ["freshness", "--anchor-tag", "production-v9.5.0", "--anchor-commit", sha0],
      { cwd: work, gitVersionText: GIT_OK_VERSION, skipFetch: true },
    );
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
    assert.equal(findCheck(result.checks, "freshness.anchor-tag-on-remote").ok, true);
  });
});

// ===========================================================================
// pre-merge — N6b, N7
// Scenario: Hotfix units serialize behind a single in-flight PR with review-binding evidence
// ===========================================================================

describe("pre-merge subcommand", () => {
  function positiveArgs() {
    return ["pre-merge", "--pr", "102", "--carrier", G.carrier, "--approved-tip", G.unit1Head, "--base-ref-oid", G.bumpMcSha, "--merge-base", G.bumpMcSha];
  }

  test("positive: OPEN PR, matching head/base/tip", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier, comments: [reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha })] } });
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 0, JSON.stringify(result));
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("positive: review-binding tolerates an exact duplicate, a stale-head binding, uppercase hex, CRLF, and a footer line", async () => {
    const { run } = await loadMod();
    const duplicateAndNoise = [
      reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha }),
      // Exact duplicate of the same binding -- MUST collapse under dedup, not count as a conflict.
      reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha }),
      // A binding for a DIFFERENT head (stale, from a prior review round) -- MUST be filtered out, not counted at all.
      reviewBindingComment({ head: G.unit2Head, baseRefOid: G.sha0, mergeBaseSha: G.sha0 }),
      // Uppercase hex, surrounding whitespace, and a CRLF line ending -- MUST still parse and lowercase-compare equal.
      { author: { login: "fixture-owner" }, includesCreatedEdit: false, createdAt: "2026-09-25T00:00:00Z", body: `   hotfix-review-binding: head=${G.unit1Head.toUpperCase()} base_ref_oid=${G.bumpMcSha.toUpperCase()} merge_base_sha=${G.bumpMcSha.toUpperCase()}   \r\n\r\nRules: v6.98.0 · Tool: dp-programmer · Model: fixture` },
    ];
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier, comments: duplicateAndNoise } });
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
  });

  // Scenario: Hotfix units serialize behind a single in-flight PR with review-binding evidence
  // F-ehrc-r1-06: a stale LOCAL `origin/<carrier>` tracking ref must not mask
  // a carrier tip that has genuinely moved on the remote. Builds a dedicated
  // copy of the beforeUnit1 snapshot, advances its bare remote's carrier by
  // one commit, pushes (which updates the tracking ref to the new tip), then
  // rewinds ONLY the local tracking ref back to the old tip -- simulating an
  // operator invoking pre-merge from a clone that has not re-fetched.
  test("F-ehrc-r1-06: stale local origin/<carrier> tracking ref does not mask a moved carrier tip", async () => {
    const { run } = await loadMod();
    const staleTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "hcv-stale-premerge-"));
    cleanupDirs.push(staleTmp);
    fs.cpSync(G.beforeUnit1MergeTmp, staleTmp, { recursive: true });
    const staleWork = path.join(staleTmp, "work");
    const staleBare = path.join(staleTmp, "remote.git");
    gitOk(staleWork, ["remote", "set-url", "origin", staleBare]);
    checkout(staleWork, G.carrier);
    commitAll(staleWork, "carrier advances after the local clone last fetched (fixture only)", { "stale-advance.txt": "1\n" });
    push(staleWork, [G.carrier]); // updates the local tracking ref to the new tip
    gitOk(staleWork, ["update-ref", `refs/remotes/origin/${G.carrier}`, G.bumpMcSha]); // rewind ONLY the tracking ref

    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier } });
    const { exitCode, result } = run(positiveArgs(), { cwd: staleWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-merge.git-carrier-tip");
  });

  test("N6b: GitHub headRefOid != approved-tip at merge time -> exit 1", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit2Head, baseRefName: G.carrier } });
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-merge.gh-head-oid");
  });

  test("N7a: review-time base moved — carrier tip no longer equals base_ref_oid", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier } });
    const args = ["pre-merge", "--pr", "102", "--carrier", G.carrier, "--approved-tip", G.unit1Head, "--base-ref-oid", G.sha0, "--merge-base", G.bumpMcSha];
    const { exitCode, result } = run(args, { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-merge.git-carrier-tip");
  });

  test("N7b: recorded merge-base no longer matches actual merge-base", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier } });
    const args = ["pre-merge", "--pr", "102", "--carrier", G.carrier, "--approved-tip", G.unit1Head, "--base-ref-oid", G.bumpMcSha, "--merge-base", G.sha0];
    const { exitCode, result } = run(args, { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-merge.git-merge-base");
  });

  test("PR not OPEN (e.g. MERGED already) -> exit 1", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "MERGED", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier } });
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-merge.gh-state-open");
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("N44a: no hotfix-review-binding comment for the approved head -> pre-merge.review-binding-present", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier, comments: [] } });
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-merge.review-binding-present");
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("N44b: two conflicting hotfix-review-binding comments for the same head -> pre-merge.review-binding-unique", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({
      102: {
        number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier,
        comments: [
          reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha }),
          reviewBindingComment({ head: G.unit1Head, baseRefOid: G.sha0, mergeBaseSha: G.sha0 }),
        ],
      },
    });
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-merge.review-binding-unique");
    assert.equal(findCheck(result.checks, "pre-merge.review-binding-present").ok, true);
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("N44c: carrier advanced after review; caller-supplied base no longer matches the recorded review binding -> pre-merge.review-binding-base-ref-oid", async () => {
    const { run } = await loadMod();
    const advTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "hcv-n44-premerge-adv-"));
    cleanupDirs.push(advTmp);
    fs.cpSync(G.beforeUnit1MergeTmp, advTmp, { recursive: true });
    const advWork = path.join(advTmp, "work");
    const advBare = path.join(advTmp, "remote.git");
    gitOk(advWork, ["remote", "set-url", "origin", advBare]);
    checkout(advWork, G.carrier);
    const newTip = commitAll(advWork, "carrier advances after review (fixture only)", { "n44-advance.txt": "1\n" });
    push(advWork, [G.carrier]); // local tracking ref reflects the new (real) tip, unlike F-ehrc-r1-06
    const newMergeBase = gitOk(advWork, ["merge-base", newTip, G.unit1Head]);

    const ghRunner = makeGhRunner({
      102: {
        number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier,
        // Binding recorded at REVIEW time, still pinned to the OLD base -- the
        // carrier has genuinely moved since, and the caller (correctly)
        // supplies the NEW base/merge-base, which the binding must reject.
        comments: [reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha })],
      },
    });
    const args = ["pre-merge", "--pr", "102", "--carrier", G.carrier, "--approved-tip", G.unit1Head, "--base-ref-oid", newTip, "--merge-base", newMergeBase];
    const { exitCode, result } = run(args, { cwd: advWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-merge.review-binding-base-ref-oid");
    // The topology checks against the caller-supplied (moved) base still hold.
    assert.equal(findCheck(result.checks, "pre-merge.git-carrier-tip").ok, true);
    assert.equal(findCheck(result.checks, "pre-merge.git-merge-base").ok, true);
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("N44d: review binding merge_base_sha disagrees even though base_ref_oid matches -> pre-merge.review-binding-merge-base", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({
      102: {
        number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier,
        comments: [reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.sha0 })],
      },
    });
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-merge.review-binding-merge-base");
    assert.equal(findCheck(result.checks, "pre-merge.review-binding-base-ref-oid").ok, true);
  });

  // Scenario: Review binding counts only from a trusted, unedited, pre-merge comment
  // hotfix-review-binding-forgery: a binding line from an author without write access never counts.
  test("N47a: binding comment from an author without write access -> pre-merge.review-binding-present", async () => {
    const { run } = await loadMod();
    const trustedShape = reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha });
    // read permission, no permission, unknown author, and a read-only account
    // whose authorAssociation claims MEMBER (association alone is not trusted).
    const comments = [
      { ...trustedShape, author: { login: "fixture-reader" } },
      { ...trustedShape, author: { login: "drive-by" } },
      { ...trustedShape, author: undefined },
      { ...trustedShape, author: { login: "fixture-reader" }, authorAssociation: "MEMBER" },
    ];
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier, comments } });
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-merge.review-binding-present");
    const detail = findCheck(result.checks, "pre-merge.review-binding-present").detail;
    assert.match(detail, /author without write access/);
    assert.match(detail, /author unknown/);
  });

  // Scenario: Review binding counts only from a trusted, unedited, pre-merge comment
  test("N47g: a failed permission lookup leaves the binding untrusted, never trusted", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier, comments: [reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha })] } });
    const ghPermissionRunner = () => { throw new Error("gh api exited 1"); };
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, ghPermissionRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assert.match(findCheck(result.checks, "pre-merge.review-binding-present").detail, /author permission lookup failed/);
  });

  // Scenario: Review binding counts only from a trusted, unedited, pre-merge comment
  test("N47h positive: a binding whose only author holds admin permission is trusted", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier, comments: [reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha }, { login: "fixture-owner" })] } });
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
  });

  // Scenario: Review binding counts only from a trusted, unedited, pre-merge comment
  test("N47b: trusted binding comment that was edited after posting -> pre-merge.review-binding-present", async () => {
    const { run } = await loadMod();
    const edited = reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha }, { includesCreatedEdit: true });
    const unknownEdit = { ...reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha }), includesCreatedEdit: undefined };
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier, comments: [edited, unknownEdit] } });
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-merge.review-binding-present");
    assert.match(findCheck(result.checks, "pre-merge.review-binding-present").detail, /edited after posting/);
  });

  // Scenario: Review binding counts only from a trusted, unedited, pre-merge comment
  test("N47c positive: a forged conflicting binding from an untrusted author is ignored, not counted as a conflict", async () => {
    const { run } = await loadMod();
    const trusted = reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha });
    const forged = reviewBindingComment({ head: G.unit1Head, baseRefOid: G.sha0, mergeBaseSha: G.sha0 }, { login: "drive-by" });
    const ghRunner = makeGhRunner({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier, comments: [trusted, forged] } });
    const { exitCode, result } = run(positiveArgs(), { cwd: G.beforeUnit1MergeWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
    assert.equal(findCheck(result.checks, "pre-merge.review-binding-unique").ok, true);
  });
});

// ===========================================================================
// merge-proof — N9, N10, N11 (chain angle covered under pre-promote), N24-N26, N30-N32
// Scenario: GitHub pull request records are cross-checked, not only git topology
// Scenario: Merge content integrity proves the merge result, not only its shape
// ===========================================================================

describe("merge-proof subcommand", () => {
  function unit1Args(overrides = {}) {
    return [
      "merge-proof", "--kind", "hotfix", "--pr", "102", "--carrier", G.carrier,
      "--anchor-commit", G.sha0,
      "--approved-tip", overrides.approvedTip ?? G.unit1Head,
      "--base-ref-oid", overrides.baseRefOid ?? G.bumpMcSha,
    ];
  }

  test("positive: hotfix merge-proof passes on the golden repo", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(unit1Args(), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 0, JSON.stringify(result));
  });

  test("P3: bump merges into the carrier before any hotfix review completes", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(
      ["merge-proof", "--kind", "bump", "--pr", "101", "--carrier", G.carrier, "--anchor-commit", G.sha0],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 0, JSON.stringify(result));
  });

  // Scenario: GitHub pull request records are cross-checked, not only git topology
  test("N9: web conflict resolution advanced the PR head past the recorded approved-tip", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G)); // headRefOid == real unit1Head (matches mc^2)
    const { exitCode, result } = run(unit1Args({ approvedTip: G.bumpHead }), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "merge-proof.git-mc-parent2-eq-approved-tip");
    // GitHub-vs-head cross-check itself still holds even though approved-tip diverges.
    assert.equal(findCheck(result.checks, "merge-proof.git-mc-parent2-eq-head").ok, true);
  });

  test("N10: wrong merge parent (base_ref_oid does not match mc^1)", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(unit1Args({ baseRefOid: G.sha0 }), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "merge-proof.git-mc-parent1-eq-base-ref-oid");
  });

  // Scenario: GitHub pull request records are cross-checked, not only git topology
  test("N21: PR record not MERGED despite matching local parent topology -> exit 1", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], state: "OPEN", mergedAt: null };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(unit1Args(), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "merge-proof.gh-state-merged");
  });

  test("N22a: GitHub mergeCommit.oid != recorded mc", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], mergeCommit: mc(G.unit2Mc) };
    const ghRunner = makeGhRunner(records);
    // Ask merge-proof to prove PR #102's merge against the WRONG mc (unit2Mc):
    // that commit's parents don't match approved_tip/base_ref_oid for unit1.
    const { exitCode, result } = run(unit1Args(), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assert.ok(!result.ok);
  });

  test("N22b: GitHub headRefOid != approved_tip", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], headRefOid: G.unit2Head };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(unit1Args(), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    // The actual merge commit's ^2 (approved_tip) disagrees with the mutated
    // GitHub headRefOid, so the GitHub-vs-git cross-check fails first.
    assertFailedCheck(result, "merge-proof.git-mc-parent2-eq-head");
  });

  test("N22c: GitHub baseRefName != carrier", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], baseRefName: "release/other" };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(unit1Args(), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "merge-proof.gh-base");
  });

  test("N24a: gh runner throws (not found / not authenticated / non-zero) -> exit 2", async () => {
    const { run } = await loadMod();
    const ghRunner = () => { throw new Error("gh: command not found"); };
    const { exitCode, result } = run(unit1Args(), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 2);
    assert.ok(!result.ok);
  });

  test("N24b: gh response missing a required field -> exit 2", async () => {
    const { run } = await loadMod();
    const ghRunner = () => ({ number: 102, state: "MERGED" }); // missing headRefOid etc.
    const { exitCode } = run(unit1Args(), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 2);
  });

  test("N26: bump PR not bump-first (mc^1 != anchor-commit)", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(
      ["merge-proof", "--kind", "bump", "--pr", "101", "--carrier", G.carrier, "--anchor-commit", G.unit1Mc],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "merge-proof.git-mc-parent1-eq-anchor");
  });

  // F-ehrc-r1-01: merge-proof --kind bump head-shape negative (previously
  // untested -- deleting the check left the whole file green).
  test("F-ehrc-r1-01g: bump PR headRefName does not match ^chore/bump-v\\d+\\.\\d+\\.\\d+$ -> merge-proof.gh-head-shape", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[101] = { ...records[101], headRefName: "hotfix/not-a-bump" };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["merge-proof", "--kind", "bump", "--pr", "101", "--carrier", G.carrier, "--anchor-commit", G.sha0],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "merge-proof.gh-head-shape");
  });

  // Scenario: Merge content integrity proves the merge result, not only its shape
  test("N30: hotfix merged with -s ours (content-discarding) -> exit 1 on content-integrity", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({
      201: { number: 201, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-corrupt", headRefOid: CI.hotfixHead, baseRefName: CI.carrier, mergeCommit: mc(CI.corruptHotfixMc) },
    });
    const { exitCode, result } = run(
      ["merge-proof", "--kind", "hotfix", "--pr", "201", "--carrier", CI.carrier, "--anchor-commit", CI.anchor, "--approved-tip", CI.hotfixHead, "--base-ref-oid", CI.carrierBeforeUnit],
      { cwd: CI.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "merge-proof.content-integrity.tree-eq");
    assert.equal(findCheck(result.checks, "merge-proof.content-integrity.clean").ok, true);
  });

  // Scenario: Merge content integrity proves the merge result, not only its shape
  test("N31: bump merged with -s ours -> exit 1 on content-integrity", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({
      202: { number: 202, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "chore/bump-v2.0.2", headRefOid: CI.bumpHead, baseRefName: CI.bumpCarrier, mergeCommit: mc(CI.corruptBumpMc) },
    });
    const { exitCode, result } = run(
      ["merge-proof", "--kind", "bump", "--pr", "202", "--carrier", CI.bumpCarrier, "--anchor-commit", CI.anchor],
      { cwd: CI.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "merge-proof.content-integrity.tree-eq");
  });

  // Scenario: Merge content integrity proves the merge result, not only its shape
  test("N32: real conflict hand-resolved inside the merge commit -> exit 1 (non-clean merge-tree)", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({
      203: { number: 203, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-conflict", headRefOid: CI.conflictHead, baseRefName: CI.carrier, mergeCommit: mc(CI.conflictMc) },
    });
    const { exitCode, result } = run(
      ["merge-proof", "--kind", "hotfix", "--pr", "203", "--carrier", CI.carrier, "--anchor-commit", CI.anchor, "--approved-tip", CI.conflictHead, "--base-ref-oid", CI.carrierBeforeConflict],
      { cwd: CI.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "merge-proof.content-integrity.clean");
  });

  test("ff shape: mergeCommit.oid must equal approved-tip", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({
      301: { number: 301, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier, mergeCommit: mc(G.unit2Head) },
    });
    const { exitCode, result } = run(
      // --base-ref-oid is a real ancestor of --approved-tip here so this
      // test still isolates ff-eq-tip (F-ehrc-r1-14 added a second,
      // independently-testable ff check below).
      ["merge-proof", "--kind", "hotfix", "--pr", "301", "--carrier", G.carrier, "--anchor-commit", G.sha0, "--approved-tip", G.unit1Head, "--base-ref-oid", G.bumpMcSha, "--shape", "ff"],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "merge-proof.git-shape-ff-eq-tip");
  });

  // F-ehrc-r1-14: ff shape requires base_ref_oid to be an ancestor of
  // approved_tip (D4). mergeCommit.oid == approved_tip here so ff-eq-tip
  // passes and this check is isolated; G.unit2Head is a real commit but NOT
  // an ancestor of G.unit1Head (both are siblings on top of the bump).
  test("F-ehrc-r1-14a: ff shape base_ref_oid is not an ancestor of approved-tip -> merge-proof.git-shape-ff-base-ref-oid-ancestor", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({
      301: { number: 301, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier, mergeCommit: mc(G.unit1Head) },
    });
    const { exitCode, result } = run(
      ["merge-proof", "--kind", "hotfix", "--pr", "301", "--carrier", G.carrier, "--anchor-commit", G.sha0, "--approved-tip", G.unit1Head, "--base-ref-oid", G.unit2Head, "--shape", "ff"],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "merge-proof.git-shape-ff-base-ref-oid-ancestor");
    assert.equal(findCheck(result.checks, "merge-proof.git-shape-ff-eq-tip").ok, true);
  });

  // N51 (D19, post-PR cross-model F-ehrc-p2-01): an ff merge proves the
  // reviewed tip only if the GitHub PR head is that tip. CFFREPO is a real
  // ff topology (the carrier fast-forwarded to unitHead), so with a trusted
  // binding every other merge-proof check holds and N51b shows exit 0; N51a
  // changes only headRefOid, so only the PR head binding can reject it.
  const ffMergeProofArgs = () => ["merge-proof", "--kind", "hotfix", "--pr", "751", "--carrier", CFFREPO.carrier, "--anchor-commit", CFFREPO.sha0, "--approved-tip", CFFREPO.unitHead, "--base-ref-oid", CFFREPO.sha0, "--shape", "ff"];
  const ffMergeProofRecord = (headRefOid) => ({
    751: { number: 751, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-ff", headRefOid, baseRefName: CFFREPO.carrier, mergeCommit: mc(CFFREPO.unitHead), comments: [reviewBindingComment({ head: CFFREPO.unitHead, baseRefOid: CFFREPO.sha0, mergeBaseSha: CFFREPO.sha0 })] },
  });

  test("N51a: ff shape with PR headRefOid != approved-tip -> merge-proof.gh-head-oid-eq-approved-tip", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(ffMergeProofArgs(), { cwd: CFFREPO.work, ghRunner: makeGhRunner(ffMergeProofRecord(CFFREPO.siblingHead)), gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "merge-proof.gh-head-oid-eq-approved-tip");
    assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.id), ["merge-proof.gh-head-oid-eq-approved-tip"]);
  });

  test("N51b: ff shape with PR headRefOid == approved-tip on a real ff carrier -> exit 0", async () => {
    const { run } = await loadMod();
    const { exitCode, result } = run(ffMergeProofArgs(), { cwd: CFFREPO.work, ghRunner: makeGhRunner(ffMergeProofRecord(CFFREPO.unitHead)), gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
    assert.equal(findCheck(result.checks, "merge-proof.gh-head-oid-eq-approved-tip").ok, true);
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("N44e: --kind hotfix with both --approved-tip/--base-ref-oid but no matching review binding -> merge-proof.review-binding-present", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], comments: [] };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(unit1Args(), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "merge-proof.review-binding-present");
    // Every topology/GitHub-record check up to and including the
    // first-parent-chain membership still holds; only binding fails.
    assert.equal(findCheck(result.checks, "merge-proof.git-mc-on-carrier-first-parent-chain").ok, true);
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("N44f: review binding disagrees with the actual base_ref_oid -> merge-proof.review-binding-base-ref-oid", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], comments: [reviewBindingComment({ head: G.unit1Head, baseRefOid: G.sha0, mergeBaseSha: G.sha0 })] };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(unit1Args(), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "merge-proof.review-binding-base-ref-oid");
    assert.equal(findCheck(result.checks, "merge-proof.review-binding-present").ok, true);
  });

  // Scenario: Review binding counts only from a trusted, unedited, pre-merge comment
  test("N47d: binding comment created after the PR merged -> merge-proof.review-binding-present", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], comments: [reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha }, { createdAt: "2026-09-26T00:01:01Z" })] };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(unit1Args(), { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "merge-proof.review-binding-present");
    assert.match(findCheck(result.checks, "merge-proof.review-binding-present").detail, /posted after the merge/);
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("N44g: --kind bump never reads/requires a review binding", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G)); // PR 101 (bump) has no comments field at all
    const { exitCode, result } = run(
      ["merge-proof", "--kind", "bump", "--pr", "101", "--carrier", G.carrier, "--anchor-commit", G.sha0],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
    assert.ok(!result.checks.some((c) => c.id.startsWith("merge-proof.review-binding")), JSON.stringify(result.checks));
  });
});

// ===========================================================================
// pre-promote — N5, N11-N18, N20 (via freshness re-run), N23, N25, N27-N29, N33 (chain),
//               N37-N40, P3, P5, P7, C1, C2
// Scenario: Production pull request body persists the provenance block
// Scenario: Artifact state machine governs freeze through back-merge
// Scenario: Bump provenance and version-file applicability gate promotion
// Scenario: Consumer-rules rollback proves revert shape before claiming no bump
// ===========================================================================

describe("pre-promote subcommand — source lane (golden repo)", () => {
  test("positive: --body-file passes on the frozen golden repo", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
  });

  test("positive: --production-pr (OPEN) passes on the frozen golden repo", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], state: "OPEN", mergedAt: null, body: goldenProvenanceBody(G) };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--production-pr", "104"],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
  });

  // Scenario: Production pull request body persists the provenance block
  test("N17a: missing hotfix-carrier-provenance block", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, "no provenance block here");
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.provenance-block-parsed");
  });

  // Scenario: Production pull request body persists the provenance block
  test("N17b: duplicated hotfix-carrier-provenance block", async () => {
    const { run } = await loadMod();
    const body = goldenProvenanceBody(G);
    const bodyFile = await writeBodyFile(G.tmp, `${body}\n\n${body}`);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.provenance-block-parsed");
  });

  // Scenario: Production pull request body persists the provenance block
  test("N17c: block missing a required key", async () => {
    const { run } = await loadMod();
    const body = goldenProvenanceBody(G).replace(/artifact_id: [^\n]+\n/, "");
    const bodyFile = await writeBodyFile(G.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.provenance-block-parsed");
  });

  // Scenario: Production pull request body persists the provenance block
  test("N17d: anchor_commit is not 40-hex", async () => {
    const { run } = await loadMod();
    const body = goldenProvenanceBody(G).replace(`anchor_commit: ${G.sha0}`, "anchor_commit: not-a-sha");
    const bodyFile = await writeBodyFile(G.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.provenance-block-parsed");
  });

  // F-ehrc-r1-07: parseProvenanceBlock only validates that these keys are
  // PRESENT; their content is validated separately in cmdPrePromote (where
  // --carrier is in scope). Previously untested -- deleting the check left
  // the whole file green.
  test("F-ehrc-r1-07a: artifact_id is empty -> pre-promote.provenance-artifact-id-nonempty", async () => {
    const { run } = await loadMod();
    const body = goldenProvenanceBody(G).replace("artifact_id: ci-run-1", "artifact_id: ");
    const bodyFile = await writeBodyFile(G.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.provenance-artifact-id-nonempty");
  });

  test("F-ehrc-r1-07b: built_at is not a UTC instant ending in Z -> pre-promote.provenance-built-at-utc-z", async () => {
    const { run } = await loadMod();
    const body = goldenProvenanceBody(G).replace("built_at: 2026-09-26T12:00:00Z", "built_at: 2026-09-26 12:00:00");
    const bodyFile = await writeBodyFile(G.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.provenance-built-at-utc-z");
  });

  test("F-ehrc-r1-07c: gates is empty -> pre-promote.provenance-gates-nonempty", async () => {
    const { run } = await loadMod();
    const body = goldenProvenanceBody(G).replace("gates: full=pass, smoke=pass", "gates: ");
    const bodyFile = await writeBodyFile(G.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.provenance-gates-nonempty");
  });

  test("F-ehrc-r1-07d: provenance carrier != --carrier -> pre-promote.provenance-carrier-matches", async () => {
    const { run } = await loadMod();
    const body = goldenProvenanceBody(G).replace(`carrier: ${G.carrier}`, "carrier: release/other");
    const bodyFile = await writeBodyFile(G.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.provenance-carrier-matches");
  });

  // Scenario: Consumer-rules rollback proves revert shape before claiming no bump
  test("N29a: lane/carrier naming mismatch", async () => {
    const { run } = await loadMod();
    const body = goldenProvenanceBody(G).replace("lane: source", "lane: consumer");
    const bodyFile = await writeBodyFile(G.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.lane-carrier-naming");
  });

  // Scenario: Consumer-rules rollback proves revert shape before claiming no bump
  test("N29b: consumer-rules unit head does not match hotfix/revert-rules-* shape", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer-rules",
      anchorTag: "production-20260302-rules",
      anchorCommit: RULESREPO.priorRulesMergeSha,
      carrier: RULESREPO.cleanCarrier,
      carrierSha: RULESREPO.cleanUnitMc,
      bump: "N/A",
      units: [`unit: pr=1001 approved_tip=${RULESREPO.cleanRevertHead} base_ref_oid=${RULESREPO.priorRulesMergeSha} merge_base_sha=${RULESREPO.priorRulesMergeSha} mc=${RULESREPO.cleanUnitMc} shape=merge reverts=${RULESREPO.priorRulesMergeSha}`],
    });
    const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
    // Real merge/topology is the clean P5 revert; only the GitHub-recorded
    // headRefName is fabricated to violate the consumer-rules naming shape.
    const ghRunner = makeGhRunner({
      1001: { number: 1001, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-not-a-revert", headRefOid: RULESREPO.cleanRevertHead, baseRefName: RULESREPO.cleanCarrier, mergeCommit: mc(RULESREPO.cleanUnitMc) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", RULESREPO.cleanCarrier, "--body-file", bodyFile],
      { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.unit-gh-head-shape");
  });

  // Scenario: Freshness gate fails closed with no lock exception
  test("N5: carrier cut from a commit that is not an ancestor of the anchor tag -> pre-promote exit 1 (chain not anchored)", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "source",
      anchorTag: "production-v1.0.0",
      anchorCommit: WRONGBASE.sha0,
      carrier: WRONGBASE.carrier,
      carrierSha: WRONGBASE.unitMc,
      bump: "N/A",
      units: [`unit: pr=901 approved_tip=${WRONGBASE.unitHead} base_ref_oid=${WRONGBASE.sha0} merge_base_sha=${WRONGBASE.sha0} mc=${WRONGBASE.unitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(WRONGBASE.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", WRONGBASE.carrier, "--body-file", bodyFile],
      { cwd: WRONGBASE.work, gitVersionText: GIT_OK_VERSION },
    );
    // freshness passes cleanly (single production-* tag, origin/production at
    // the anchor) -- only pre-promote's own chain-anchoring check catches the
    // wrong-base carrier, since the anchor is not an ancestor of carrier_sha.
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.chain-anchored-at-anchor-commit");
  });

  // Scenario: Artifact state machine governs freeze through back-merge
  test("N13: FROZEN carrier content changed after freeze (carrier_sha != tip)", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G)); // recorded carrier_sha = unit2Mc (stale)
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION }, // promoted work dir: carrier already advanced
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.carrier-sha-matches-tip");
  });

  test("N15c: production PR base mismatch (merge-before mode)", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], state: "OPEN", mergedAt: null, baseRefName: "main", body: goldenProvenanceBody(G) };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--production-pr", "104"],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.production-pr-base");
  });

  // F-ehrc-r1-03: production PR head/head-oid mismatch (merge-before mode) --
  // previously N15b was titled "head/base mismatch" but only ever mutated
  // base; these two are the actual head-name and head-oid negatives.
  test("F-ehrc-r1-03a: production PR headRefName != carrier (merge-before mode) -> pre-promote.production-pr-head", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], state: "OPEN", mergedAt: null, headRefName: "release/other", body: goldenProvenanceBody(G) };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--production-pr", "104"],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.production-pr-head");
  });

  test("F-ehrc-r1-03b: production PR headRefOid != carrier_sha (merge-before mode) -> pre-promote.production-pr-head-oid", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], state: "OPEN", mergedAt: null, headRefOid: G.unit1Mc, body: goldenProvenanceBody(G) };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--production-pr", "104"],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.production-pr-head-oid");
  });

  test("N15d: production PR not OPEN in merge-before mode", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], state: "CLOSED", mergedAt: null, body: goldenProvenanceBody(G) };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--production-pr", "104"],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.production-pr-state-open");
  });

  // Scenario: Artifact state machine governs freeze through back-merge (freshness re-run)
  test("N14: freshness re-run fails inside pre-promote when production advanced without a tag", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      // lane matches the carrier's own naming (release/v1.0.1 is source-style);
      // bump: N/A would itself fail on lane=source, but freshness re-runs
      // BEFORE bump verification in pre-promote, so this exercises N14 cleanly.
      lane: "source",
      anchorTag: "production-v1.0.0",
      anchorCommit: PRODADV.sha0,
      carrier: PRODADV.carrier,
      carrierSha: PRODADV.unitMc,
      bump: "N/A",
      units: [`unit: pr=401 approved_tip=${PRODADV.unitHead} base_ref_oid=${PRODADV.sha0} merge_base_sha=${PRODADV.sha0} mc=${PRODADV.unitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(PRODADV.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", PRODADV.carrier, "--body-file", bodyFile],
      { cwd: PRODADV.work, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "freshness.origin-production-matches-anchor");
  });

  test("N11: chain contains an unrecorded sibling commit (omitted unit)", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "source",
      anchorTag: G.anchorTag,
      anchorCommit: G.sha0,
      carrier: G.carrier,
      carrierSha: G.carrierSha,
      bump: `pr=101 head=${G.bumpHead} mc=${G.bumpMcSha}`,
      units: [`unit: pr=102 approved_tip=${G.unit1Head} base_ref_oid=${G.bumpMcSha} merge_base_sha=${G.bumpMcSha} mc=${G.unit1Mc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(G.tmp, body);
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.chain-matches-record");
  });

  test("N12: swapped unit order fails the order-sensitive chain-equality check", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "source",
      anchorTag: G.anchorTag,
      anchorCommit: G.sha0,
      carrier: G.carrier,
      carrierSha: G.carrierSha,
      bump: `pr=101 head=${G.bumpHead} mc=${G.bumpMcSha}`,
      units: [
        `unit: pr=103 approved_tip=${G.unit2Head} base_ref_oid=${G.unit1Mc} merge_base_sha=${G.unit1Mc} mc=${G.unit2Mc} shape=merge`,
        `unit: pr=102 approved_tip=${G.unit1Head} base_ref_oid=${G.bumpMcSha} merge_base_sha=${G.bumpMcSha} mc=${G.unit1Mc} shape=merge`,
      ],
    });
    const bodyFile = await writeBodyFile(G.tmp, body);
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.chain-matches-record");
  });

  test("N12 positive: correctly ordered multi-hotfix chain passes", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 0);
  });

  // Scenario: GitHub pull request records are cross-checked, not only git topology
  test("N23a: production PR (merge-after mode) not MERGED", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], state: "OPEN", mergedAt: null };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["post-promote", "--tag", "production-v1.0.1", "--carrier", G.carrier, "--carrier-sha", G.carrierSha, "--anchor-commit", G.sha0, "--production-pr", "104", "--provenance-sha256", goldenProvenanceDigest()],
      { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "post-promote.production-pr-state-merged");
  });

  test("N25: direct carrier commit masquerading as a bump (single parent)", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer",
      anchorTag: "production-20260205",
      anchorCommit: N25REPO.sha0,
      carrier: N25REPO.carrier,
      carrierSha: N25REPO.unitMc,
      bump: `pr=501 head=${N25REPO.directCommit} mc=${N25REPO.directCommit}`, // a single-parent commit, not a merge
      units: [`unit: pr=502 approved_tip=${N25REPO.unitHead} base_ref_oid=${N25REPO.directCommit} merge_base_sha=${N25REPO.directCommit} mc=${N25REPO.unitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(N25REPO.tmp, body);
    const ghRunner = makeGhRunner({
      501: { number: 501, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "chore/bump-v9.9.9", headRefOid: N25REPO.directCommit, baseRefName: N25REPO.carrier, mergeCommit: mc(N25REPO.directCommit) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", N25REPO.carrier, "--body-file", bodyFile],
      { cwd: N25REPO.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.bump-git-two-parents");
  });

  // F-ehrc-r1-01: bump PR GitHub-record negatives (previously untested --
  // deleting the corresponding check left the whole file green). Each
  // mutates exactly one field of the bump PR #101 GitHub record on top of
  // the otherwise-golden provenance body.
  test("F-ehrc-r1-01a: bump PR not MERGED -> pre-promote.bump-gh-state-merged", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const records = goldenGhRecords(G);
    records[101] = { ...records[101], state: "OPEN", mergedAt: null };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.bump-gh-state-merged");
  });

  test("F-ehrc-r1-01b: bump PR headRefName != chore/bump-v<carrier version> -> pre-promote.bump-gh-head-shape", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const records = goldenGhRecords(G);
    records[101] = { ...records[101], headRefName: "chore/bump-v9.9.9" };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.bump-gh-head-shape");
  });

  test("F-ehrc-r1-01c: bump PR baseRefName != carrier -> pre-promote.bump-gh-base", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const records = goldenGhRecords(G);
    records[101] = { ...records[101], baseRefName: "release/other" };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.bump-gh-base");
  });

  test("F-ehrc-r1-01d: bump PR headRefOid != recorded bump head -> pre-promote.bump-gh-head-oid", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const records = goldenGhRecords(G);
    records[101] = { ...records[101], headRefOid: G.unit1Head };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.bump-gh-head-oid");
  });

  test("F-ehrc-r1-01e: bump PR mergeCommit.oid != recorded bump mc -> pre-promote.bump-gh-mc", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const records = goldenGhRecords(G);
    records[101] = { ...records[101], mergeCommit: mc(G.unit1Mc) };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.bump-gh-mc");
  });

  test("F-ehrc-r1-01f: bump mc^2 != recorded bump head -> pre-promote.bump-git-parent2-eq-head", async () => {
    const { run } = await loadMod();
    // The recorded bump `head` is fabricated to G.unit1Head (a real, valid
    // commit but NOT the real bump merge's actual second parent). The
    // GitHub record's headRefOid is mutated to the SAME fabricated value so
    // that bump-gh-head-oid still passes and this check is isolated.
    const body = provenanceBody({
      lane: "source",
      anchorTag: G.anchorTag,
      anchorCommit: G.sha0,
      carrier: G.carrier,
      carrierSha: G.carrierSha,
      bump: `pr=101 head=${G.unit1Head} mc=${G.bumpMcSha}`,
      units: [
        `unit: pr=102 approved_tip=${G.unit1Head} base_ref_oid=${G.bumpMcSha} merge_base_sha=${G.bumpMcSha} mc=${G.unit1Mc} shape=merge`,
        `unit: pr=103 approved_tip=${G.unit2Head} base_ref_oid=${G.unit1Mc} merge_base_sha=${G.unit1Mc} mc=${G.unit2Mc} shape=merge`,
      ],
    });
    const bodyFile = await writeBodyFile(G.tmp, body);
    const records = goldenGhRecords(G);
    records[101] = { ...records[101], headRefOid: G.unit1Head };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.bump-git-parent2-eq-head");
  });

  // Scenario: Provenance gates follow the recorded pass format
  test("N45a: gates entry not <name>=pass -> pre-promote.provenance-gates-format", async () => {
    const { run } = await loadMod();
    const body = goldenProvenanceBody(G).replace("gates: full=pass, smoke=pass", "gates: full=fail, smoke=pass");
    const bodyFile = await writeBodyFile(G.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.provenance-gates-format");
  });

  // Scenario: Provenance gates follow the recorded pass format
  test("N45b: gates entry missing the '=pass' suffix -> pre-promote.provenance-gates-format", async () => {
    const { run } = await loadMod();
    const body = goldenProvenanceBody(G).replace("gates: full=pass, smoke=pass", "gates: smoke");
    const bodyFile = await writeBodyFile(G.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.provenance-gates-format");
  });

  // Scenario: Provenance gates follow the recorded pass format
  test("N45c: gates well-formed but missing smoke=pass -> pre-promote.provenance-gates-smoke", async () => {
    const { run } = await loadMod();
    const body = goldenProvenanceBody(G).replace("gates: full=pass, smoke=pass", "gates: full=pass");
    const bodyFile = await writeBodyFile(G.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.provenance-gates-smoke");
    assert.equal(findCheck(result.checks, "pre-promote.provenance-gates-format").ok, true);
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("N44h: unit PR has no matching review binding -> pre-promote.unit-review-binding-present", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], comments: [] };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.unit-review-binding-present");
  });

  // Scenario: Review binding counts only from a trusted, unedited, pre-merge comment
  test("N47e: unit PR binding only from an untrusted author -> pre-promote.unit-review-binding-present", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], comments: [reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha }, { login: "fixture-reader" })] };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.unit-review-binding-present");
  });

  // Scenario: Review binding counts only from a trusted, unedited, pre-merge comment
  test("N47f: unit binding created after the unit PR merged -> pre-promote.unit-review-binding-present", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], comments: [reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha }, { createdAt: "2026-09-26T00:01:01Z" })] };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.unit-review-binding-present");
    assert.match(findCheck(result.checks, "pre-promote.unit-review-binding-present").detail, /posted after the merge/);
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("N44i: two conflicting review bindings for a unit's approved_tip -> pre-promote.unit-review-binding-unique", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const records = goldenGhRecords(G);
    records[102] = {
      ...records[102],
      comments: [
        reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha }),
        reviewBindingComment({ head: G.unit1Head, baseRefOid: G.sha0, mergeBaseSha: G.sha0 }),
      ],
    };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.unit-review-binding-unique");
    assert.equal(findCheck(result.checks, "pre-promote.unit-review-binding-present").ok, true);
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("N44j: unit review binding base_ref_oid disagrees with the recorded provenance value -> pre-promote.unit-review-binding-base-ref-oid", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], comments: [reviewBindingComment({ head: G.unit1Head, baseRefOid: G.sha0, mergeBaseSha: G.sha0 })] };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.unit-review-binding-base-ref-oid");
  });

  // Scenario: Review-time binding pins the carrier base the hotfix was approved against
  test("N44k: unit review binding merge_base_sha disagrees even though base_ref_oid matches -> pre-promote.unit-review-binding-merge-base", async () => {
    const { run } = await loadMod();
    const bodyFile = await writeBodyFile(G.tmp, goldenProvenanceBody(G));
    const records = goldenGhRecords(G);
    records[102] = { ...records[102], comments: [reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.sha0 })] };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", G.carrier, "--body-file", bodyFile],
      { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.unit-review-binding-merge-base");
    assert.equal(findCheck(result.checks, "pre-promote.unit-review-binding-base-ref-oid").ok, true);
  });
});

describe("pre-promote subcommand — consumer lane (version-metadata-files applicability)", () => {
  let repoRoot;
  before(() => {
    repoRoot = writeMarkerFile(fs.mkdtempSync(path.join(os.tmpdir(), "hcv-marker-")), VALID_MARKER_LINES);
  });

  // Scenario: Bump provenance and version-file applicability gate promotion
  test("C1: consumer with a version file and a real bump PR passes", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer",
      anchorTag: "production-20260201",
      anchorCommit: C1REPO.sha0,
      carrier: C1REPO.carrier,
      carrierSha: C1REPO.unitMc,
      bump: `pr=601 head=${C1REPO.bumpHead} mc=${C1REPO.bumpMc}`,
      units: [`unit: pr=602 approved_tip=${C1REPO.unitHead} base_ref_oid=${C1REPO.bumpMc} merge_base_sha=${C1REPO.bumpMc} mc=${C1REPO.unitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(C1REPO.tmp, body);
    const ghRunner = makeGhRunner({
      601: { number: 601, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "chore/bump-v1.0.1", headRefOid: C1REPO.bumpHead, baseRefName: C1REPO.carrier, mergeCommit: mc(C1REPO.bumpMc) },
      602: { number: 602, state: "MERGED", mergedAt: "2026-09-26T00:01:00Z", headRefName: "hotfix/fix-y", headRefOid: C1REPO.unitHead, baseRefName: C1REPO.carrier, mergeCommit: mc(C1REPO.unitMc), comments: [reviewBindingComment({ head: C1REPO.unitHead, baseRefOid: C1REPO.bumpMc, mergeBaseSha: C1REPO.bumpMc })] },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", C1REPO.carrier, "--body-file", bodyFile],
      { cwd: C1REPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, repoRoot },
    );
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
  });

  // Scenario: Bump provenance and version-file applicability gate promotion
  test("C2: consumer with no version-metadata file anywhere accepts bump: N/A", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer",
      anchorTag: "production-20260202",
      anchorCommit: C2REPO.sha0,
      carrier: C2REPO.carrier,
      carrierSha: C2REPO.unitMc,
      bump: "N/A",
      units: [`unit: pr=701 approved_tip=${C2REPO.unitHead} base_ref_oid=${C2REPO.sha0} merge_base_sha=${C2REPO.sha0} mc=${C2REPO.unitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(C2REPO.tmp, body);
    const ghRunner = makeGhRunner({
      701: { number: 701, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-z", headRefOid: C2REPO.unitHead, baseRefName: C2REPO.carrier, mergeCommit: mc(C2REPO.unitMc), comments: [reviewBindingComment({ head: C2REPO.unitHead, baseRefOid: C2REPO.sha0, mergeBaseSha: C2REPO.sha0 })] },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", C2REPO.carrier, "--body-file", bodyFile],
      { cwd: C2REPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, repoRoot },
    );
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
  });

  // F-ehrc-r1-14: ff-shape unit -- pre-promote's ff branch had no fixture
  // coverage at all before this change (positive AND negative).
  test("F-ehrc-r1-14b: ff-shape unit with base_ref_oid an ancestor of approved_tip passes", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer",
      anchorTag: "production-20260206",
      anchorCommit: CFFREPO.sha0,
      carrier: CFFREPO.carrier,
      carrierSha: CFFREPO.unitHead,
      bump: "N/A",
      units: [`unit: pr=751 approved_tip=${CFFREPO.unitHead} base_ref_oid=${CFFREPO.sha0} merge_base_sha=${CFFREPO.sha0} mc=${CFFREPO.unitHead} shape=ff`],
    });
    const bodyFile = await writeBodyFile(CFFREPO.tmp, body);
    const ghRunner = makeGhRunner({
      751: { number: 751, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-ff", headRefOid: CFFREPO.unitHead, baseRefName: CFFREPO.carrier, mergeCommit: mc(CFFREPO.unitHead), comments: [reviewBindingComment({ head: CFFREPO.unitHead, baseRefOid: CFFREPO.sha0, mergeBaseSha: CFFREPO.sha0 })] },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", CFFREPO.carrier, "--body-file", bodyFile],
      { cwd: CFFREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, repoRoot },
    );
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
  });

  test("F-ehrc-r1-14c: ff-shape unit with base_ref_oid NOT an ancestor of approved_tip -> pre-promote.unit-shape-ff-base-ref-oid-ancestor", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer",
      anchorTag: "production-20260206",
      anchorCommit: CFFREPO.sha0,
      carrier: CFFREPO.carrier,
      carrierSha: CFFREPO.unitHead,
      bump: "N/A",
      // base_ref_oid is a real commit (an unrelated sibling of the anchor)
      // but NOT an ancestor of approved_tip.
      units: [`unit: pr=751 approved_tip=${CFFREPO.unitHead} base_ref_oid=${CFFREPO.siblingHead} merge_base_sha=${CFFREPO.sha0} mc=${CFFREPO.unitHead} shape=ff`],
    });
    const bodyFile = await writeBodyFile(CFFREPO.tmp, body);
    const ghRunner = makeGhRunner({
      751: { number: 751, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-ff", headRefOid: CFFREPO.unitHead, baseRefName: CFFREPO.carrier, mergeCommit: mc(CFFREPO.unitHead) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", CFFREPO.carrier, "--body-file", bodyFile],
      { cwd: CFFREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, repoRoot },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.unit-shape-ff-base-ref-oid-ancestor");
    assert.equal(findCheck(result.checks, "pre-promote.unit-shape-ff").ok, true);
  });

  // Scenario: Fast-forward unit review base equals the preceding carrier chain point
  // hotfix-ff-stale-base: an ancestor base that is NOT the preceding chain
  // point means the review never saw the carrier state the ff lands on.
  test("N48: ff-shape unit reviewed against a stale (older ancestor) base -> pre-promote.unit-shape-ff-base-ref-oid-eq-previous-mc", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer",
      anchorTag: "production-20260206",
      anchorCommit: CFFREPO.sha0,
      carrier: CFFREPO.carrier,
      carrierSha: CFFREPO.unitHead,
      bump: "N/A",
      units: [`unit: pr=751 approved_tip=${CFFREPO.unitHead} base_ref_oid=${CFFREPO.preAnchor} merge_base_sha=${CFFREPO.preAnchor} mc=${CFFREPO.unitHead} shape=ff`],
    });
    const bodyFile = await writeBodyFile(CFFREPO.tmp, body);
    const ghRunner = makeGhRunner({
      751: { number: 751, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-ff", headRefOid: CFFREPO.unitHead, baseRefName: CFFREPO.carrier, mergeCommit: mc(CFFREPO.unitHead), comments: [reviewBindingComment({ head: CFFREPO.unitHead, baseRefOid: CFFREPO.preAnchor, mergeBaseSha: CFFREPO.preAnchor })] },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", CFFREPO.carrier, "--body-file", bodyFile],
      { cwd: CFFREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, repoRoot },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assert.equal(findCheck(result.checks, "pre-promote.unit-shape-ff-base-ref-oid-ancestor").ok, true);
    assertFailedCheck(result, "pre-promote.unit-shape-ff-base-ref-oid-eq-previous-mc");
  });

  // Scenario: Bump provenance and version-file applicability gate promotion
  test("N27: consumer claims bump: N/A but the unit itself introduced a version file", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer",
      anchorTag: "production-20260203",
      anchorCommit: N27REPO.sha0,
      carrier: N27REPO.carrier,
      carrierSha: N27REPO.unitMc,
      bump: "N/A",
      units: [`unit: pr=801 approved_tip=${N27REPO.unitHead} base_ref_oid=${N27REPO.sha0} merge_base_sha=${N27REPO.sha0} mc=${N27REPO.unitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(N27REPO.tmp, body);
    const ghRunner = makeGhRunner({
      801: { number: 801, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-w", headRefOid: N27REPO.unitHead, baseRefName: N27REPO.carrier, mergeCommit: mc(N27REPO.unitMc) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", N27REPO.carrier, "--body-file", bodyFile],
      { cwd: N27REPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, repoRoot },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.bump-na-consumer-no-version-files");
  });

  // Scenario: Bump provenance and version-file applicability gate promotion
  test("N40: anchor has a version file that the unit deletes from the carrier tree — N/A still fails", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer",
      anchorTag: "production-20260204",
      anchorCommit: N40REPO.sha0,
      carrier: N40REPO.carrier,
      carrierSha: N40REPO.unitMc,
      bump: "N/A",
      units: [`unit: pr=901 approved_tip=${N40REPO.unitHead} base_ref_oid=${N40REPO.sha0} merge_base_sha=${N40REPO.sha0} mc=${N40REPO.unitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(N40REPO.tmp, body);
    const ghRunner = makeGhRunner({
      901: { number: 901, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-v", headRefOid: N40REPO.unitHead, baseRefName: N40REPO.carrier, mergeCommit: mc(N40REPO.unitMc) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", N40REPO.carrier, "--body-file", bodyFile],
      { cwd: N40REPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, repoRoot },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.bump-na-consumer-no-version-files");
  });

  // Scenario: Bump provenance and version-file applicability gate promotion
  test("source lane MUST always bump: bump: N/A is rejected even with no version-metadata files", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "source",
      anchorTag: SRCNOBUMP.anchorTag,
      anchorCommit: SRCNOBUMP.sha0,
      carrier: SRCNOBUMP.carrier,
      carrierSha: SRCNOBUMP.unitMc,
      bump: "N/A",
      units: [`unit: pr=102 approved_tip=${SRCNOBUMP.unitHead} base_ref_oid=${SRCNOBUMP.sha0} merge_base_sha=${SRCNOBUMP.sha0} mc=${SRCNOBUMP.unitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(SRCNOBUMP.tmp, body);
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", SRCNOBUMP.carrier, "--body-file", bodyFile],
      { cwd: SRCNOBUMP.work, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.bump-na-source-forbidden");
  });

  test("N28a: version-metadata-files marker missing entirely -> exit 2", async () => {
    const { run } = await loadMod();
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hcv-noleaf-"));
    fs.mkdirSync(path.join(emptyRoot, ".devpro", "agent-rules"), { recursive: true });
    const body = provenanceBody({
      lane: "consumer", anchorTag: "production-20260202", anchorCommit: C2REPO.sha0, carrier: C2REPO.carrier, carrierSha: C2REPO.unitMc, bump: "N/A",
      units: [`unit: pr=701 approved_tip=${C2REPO.unitHead} base_ref_oid=${C2REPO.sha0} merge_base_sha=${C2REPO.sha0} mc=${C2REPO.unitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(C2REPO.tmp, body);
    const ghRunner = makeGhRunner({
      701: { number: 701, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-z", headRefOid: C2REPO.unitHead, baseRefName: C2REPO.carrier, mergeCommit: mc(C2REPO.unitMc) },
    });
    const { exitCode } = run(
      ["pre-promote", "--carrier", C2REPO.carrier, "--body-file", bodyFile],
      { cwd: C2REPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, repoRoot: emptyRoot },
    );
    assert.equal(exitCode, 2);
  });

  test("N28b: version-metadata-files pattern uses '*' outside basename-prefix position -> exit 2", async () => {
    const { run } = await loadMod();
    const badRoot = writeMarkerFile(fs.mkdtempSync(path.join(os.tmpdir(), "hcv-badmarker-"))
      , ["- `weird*name.txt` — bad glob"]);
    const body = provenanceBody({
      lane: "consumer", anchorTag: "production-20260202", anchorCommit: C2REPO.sha0, carrier: C2REPO.carrier, carrierSha: C2REPO.unitMc, bump: "N/A",
      units: [`unit: pr=701 approved_tip=${C2REPO.unitHead} base_ref_oid=${C2REPO.sha0} merge_base_sha=${C2REPO.sha0} mc=${C2REPO.unitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(C2REPO.tmp, body);
    const ghRunner = makeGhRunner({
      701: { number: 701, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-z", headRefOid: C2REPO.unitHead, baseRefName: C2REPO.carrier, mergeCommit: mc(C2REPO.unitMc) },
    });
    const { exitCode } = run(
      ["pre-promote", "--carrier", C2REPO.carrier, "--body-file", bodyFile],
      { cwd: C2REPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, repoRoot: badRoot },
    );
    assert.equal(exitCode, 2);
  });

  test("N28c: version-metadata-files block parses empty -> exit 2", async () => {
    const { run } = await loadMod();
    const emptyListRoot = writeMarkerFile(fs.mkdtempSync(path.join(os.tmpdir(), "hcv-emptymarker-")), []);
    const body = provenanceBody({
      lane: "consumer", anchorTag: "production-20260202", anchorCommit: C2REPO.sha0, carrier: C2REPO.carrier, carrierSha: C2REPO.unitMc, bump: "N/A",
      units: [`unit: pr=701 approved_tip=${C2REPO.unitHead} base_ref_oid=${C2REPO.sha0} merge_base_sha=${C2REPO.sha0} mc=${C2REPO.unitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(C2REPO.tmp, body);
    const ghRunner = makeGhRunner({
      701: { number: 701, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/fix-z", headRefOid: C2REPO.unitHead, baseRefName: C2REPO.carrier, mergeCommit: mc(C2REPO.unitMc) },
    });
    const { exitCode } = run(
      ["pre-promote", "--carrier", C2REPO.carrier, "--body-file", bodyFile],
      { cwd: C2REPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, repoRoot: emptyListRoot },
    );
    assert.equal(exitCode, 2);
  });

  test("loadVersionMetadataFiles: parses the exact marker format (unit)", async () => {
    const { loadVersionMetadataFiles } = await loadMod();
    const patterns = loadVersionMetadataFiles(repoRoot);
    assert.equal(patterns.length, 6);
    assert.ok(patterns.some((p) => p.pattern === "package.json" && !p.sourceOnly));
    assert.ok(patterns.some((p) => p.pattern === "*.csproj" && !p.sourceOnly));
    assert.ok(patterns.some((p) => p.pattern === "AGENTS.md" && p.sourceOnly));
  });
});

describe("pre-promote subcommand — consumer-rules lane (revert shape)", () => {
  // Scenario: Consumer-rules rollback proves revert shape before claiming no bump
  test("P5: clean single-commit revert of the exact rules-lane production merge accepts bump: N/A", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer-rules",
      anchorTag: "production-20260302-rules",
      anchorCommit: RULESREPO.priorRulesMergeSha,
      carrier: RULESREPO.cleanCarrier,
      carrierSha: RULESREPO.cleanUnitMc,
      bump: "N/A",
      units: [`unit: pr=1001 approved_tip=${RULESREPO.cleanRevertHead} base_ref_oid=${RULESREPO.priorRulesMergeSha} merge_base_sha=${RULESREPO.priorRulesMergeSha} mc=${RULESREPO.cleanUnitMc} shape=merge reverts=${RULESREPO.priorRulesMergeSha}`],
    });
    const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
    const ghRunner = makeGhRunner({
      1001: { number: 1001, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/revert-rules-20260303", headRefOid: RULESREPO.cleanRevertHead, baseRefName: RULESREPO.cleanCarrier, mergeCommit: mc(RULESREPO.cleanUnitMc), comments: [reviewBindingComment({ head: RULESREPO.cleanRevertHead, baseRefOid: RULESREPO.priorRulesMergeSha, mergeBaseSha: RULESREPO.priorRulesMergeSha })] },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", RULESREPO.cleanCarrier, "--body-file", bodyFile],
      { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
  });

  // Scenario: Consumer-rules rollback proves revert shape before claiming no bump
  test("N37: hotfix/revert-rules-* branch name but non-clean revert content claims N/A -> exit 1", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer-rules",
      anchorTag: "production-20260302-rules",
      anchorCommit: RULESREPO.priorRulesMergeSha,
      carrier: RULESREPO.contentDirtyCarrier,
      carrierSha: RULESREPO.contentDirtyUnitMc,
      bump: "N/A",
      units: [`unit: pr=1004 approved_tip=${RULESREPO.contentDirtyRevertHead} base_ref_oid=${RULESREPO.priorRulesMergeSha} merge_base_sha=${RULESREPO.priorRulesMergeSha} mc=${RULESREPO.contentDirtyUnitMc} shape=merge reverts=${RULESREPO.priorRulesMergeSha}`],
    });
    const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
    const ghRunner = makeGhRunner({
      1004: { number: 1004, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/revert-rules-20260305", headRefOid: RULESREPO.contentDirtyRevertHead, baseRefName: RULESREPO.contentDirtyCarrier, mergeCommit: mc(RULESREPO.contentDirtyUnitMc) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", RULESREPO.contentDirtyCarrier, "--body-file", bodyFile],
      { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    // Parent-count and anchor checks pass (single commit, directly on anchor);
    // only the recomputed-revert tree-equality check catches the folded-in change.
    assertFailedCheck(result, "pre-promote.revert-shape.tree-eq");
  });

  // Scenario: Consumer-rules rollback proves revert shape before claiming no bump
  test("N38: reverts= missing on a consumer-rules bump: N/A unit -> exit 1", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer-rules",
      anchorTag: "production-20260302-rules",
      anchorCommit: RULESREPO.priorRulesMergeSha,
      carrier: RULESREPO.cleanCarrier,
      carrierSha: RULESREPO.cleanUnitMc,
      bump: "N/A",
      units: [`unit: pr=1001 approved_tip=${RULESREPO.cleanRevertHead} base_ref_oid=${RULESREPO.priorRulesMergeSha} merge_base_sha=${RULESREPO.priorRulesMergeSha} mc=${RULESREPO.cleanUnitMc} shape=merge`],
    });
    const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
    const ghRunner = makeGhRunner({
      1001: { number: 1001, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/revert-rules-20260303", headRefOid: RULESREPO.cleanRevertHead, baseRefName: RULESREPO.cleanCarrier, mergeCommit: mc(RULESREPO.cleanUnitMc) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", RULESREPO.cleanCarrier, "--body-file", bodyFile],
      { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "pre-promote.revert-reverts-present");
  });

  // Scenario: Consumer-rules rollback proves revert shape before claiming no bump
  test("N39: revert unit has more than one commit (not directly on anchor) -> exit 1", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer-rules",
      anchorTag: "production-20260302-rules",
      anchorCommit: RULESREPO.priorRulesMergeSha,
      carrier: RULESREPO.dirtyCarrier,
      carrierSha: RULESREPO.dirtyUnitMc,
      bump: "N/A",
      // dirtyRevertHead's parent is the revert commit, not the anchor directly: 2 commits on the unit.
      units: [`unit: pr=1002 approved_tip=${RULESREPO.dirtyRevertHead} base_ref_oid=${RULESREPO.priorRulesMergeSha} merge_base_sha=${RULESREPO.priorRulesMergeSha} mc=${RULESREPO.dirtyUnitMc} shape=merge reverts=${RULESREPO.priorRulesMergeSha}`],
    });
    const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
    const ghRunner = makeGhRunner({
      1002: { number: 1002, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/revert-rules-20260304", headRefOid: RULESREPO.dirtyRevertHead, baseRefName: RULESREPO.dirtyCarrier, mergeCommit: mc(RULESREPO.dirtyUnitMc) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", RULESREPO.dirtyCarrier, "--body-file", bodyFile],
      { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    // dirtyRevertHead's own immediate parent count is 1 (it's a plain linear
    // commit); what fails is that its parent is the earlier revert commit,
    // not the anchor directly.
    assertFailedCheck(result, "pre-promote.revert-unit-parent-eq-anchor");
  });

  // F-ehrc-r1-02: reverts= shape negatives that were previously untested --
  // deleting any one of these `cl.require` calls left the whole file green.
  // Each reuses the P5 clean-revert unit's GitHub record and topology and
  // varies ONLY the `reverts=` target, so the specific check under test is
  // isolated (every earlier revert-shape check still passes).
  test("F-ehrc-r1-02a: reverts= names a commit with only one parent -> pre-promote.revert-M-two-parents", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer-rules",
      anchorTag: "production-20260302-rules",
      anchorCommit: RULESREPO.priorRulesMergeSha,
      carrier: RULESREPO.cleanCarrier,
      carrierSha: RULESREPO.cleanUnitMc,
      bump: "N/A",
      // reverts= a single-parent commit (RULESREPO.cleanRevertHead itself), not a merge.
      units: [`unit: pr=1001 approved_tip=${RULESREPO.cleanRevertHead} base_ref_oid=${RULESREPO.priorRulesMergeSha} merge_base_sha=${RULESREPO.priorRulesMergeSha} mc=${RULESREPO.cleanUnitMc} shape=merge reverts=${RULESREPO.cleanRevertHead}`],
    });
    const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
    const ghRunner = makeGhRunner({
      1001: { number: 1001, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/revert-rules-20260303", headRefOid: RULESREPO.cleanRevertHead, baseRefName: RULESREPO.cleanCarrier, mergeCommit: mc(RULESREPO.cleanUnitMc) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", RULESREPO.cleanCarrier, "--body-file", bodyFile],
      { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.revert-M-two-parents");
  });

  test("F-ehrc-r1-02b: reverts= names a 2-parent merge never merged into production -> pre-promote.revert-M-on-production-first-parent", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer-rules",
      anchorTag: "production-20260302-rules",
      anchorCommit: RULESREPO.priorRulesMergeSha,
      carrier: RULESREPO.cleanCarrier,
      carrierSha: RULESREPO.cleanUnitMc,
      bump: "N/A",
      // reverts= RULESREPO.dirtyUnitMc: a real 2-parent merge commit, but one
      // that lives only on the (never-promoted) dirty carrier lane.
      units: [`unit: pr=1001 approved_tip=${RULESREPO.cleanRevertHead} base_ref_oid=${RULESREPO.priorRulesMergeSha} merge_base_sha=${RULESREPO.priorRulesMergeSha} mc=${RULESREPO.cleanUnitMc} shape=merge reverts=${RULESREPO.dirtyUnitMc}`],
    });
    const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
    const ghRunner = makeGhRunner({
      1001: { number: 1001, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/revert-rules-20260303", headRefOid: RULESREPO.cleanRevertHead, baseRefName: RULESREPO.cleanCarrier, mergeCommit: mc(RULESREPO.cleanUnitMc) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", RULESREPO.cleanCarrier, "--body-file", bodyFile],
      { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.revert-M-on-production-first-parent");
  });

  test("F-ehrc-r1-02c: reverts= names a plain application production merge with no rules tag -> pre-promote.revert-M-has-rules-tag", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer-rules",
      anchorTag: "production-20260302-rules",
      anchorCommit: RULESREPO.priorRulesMergeSha,
      carrier: RULESREPO.cleanCarrier,
      carrierSha: RULESREPO.cleanUnitMc,
      bump: "N/A",
      // reverts= RULESREPO.noRulesTagMergeSha: a real 2-parent production
      // merge, ancestor of the anchor, but never tagged production-*-rules --
      // this is the D14 threat this check exists to catch.
      units: [`unit: pr=1001 approved_tip=${RULESREPO.cleanRevertHead} base_ref_oid=${RULESREPO.priorRulesMergeSha} merge_base_sha=${RULESREPO.priorRulesMergeSha} mc=${RULESREPO.cleanUnitMc} shape=merge reverts=${RULESREPO.noRulesTagMergeSha}`],
    });
    const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
    const ghRunner = makeGhRunner({
      1001: { number: 1001, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/revert-rules-20260303", headRefOid: RULESREPO.cleanRevertHead, baseRefName: RULESREPO.cleanCarrier, mergeCommit: mc(RULESREPO.cleanUnitMc) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", RULESREPO.cleanCarrier, "--body-file", bodyFile],
      { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.revert-M-has-rules-tag");
  });

  // Scenario: Rules-lane revert target is proven by a published remote rules tag
  // rules-revert-local-tag-forgery: a production-*-rules tag that exists only
  // in the operator's clone MUST NOT make a plain production merge look rules-lane.
  test("N49: reverts= target carries a production-*-rules tag only in the local clone -> pre-promote.revert-M-has-rules-tag", async () => {
    const { run } = await loadMod();
    const localOnlyTag = "production-20260301-rules-9";
    tag(RULESREPO.work, localOnlyTag, RULESREPO.noRulesTagMergeSha);
    try {
      const body = provenanceBody({
        lane: "consumer-rules",
        anchorTag: "production-20260302-rules",
        anchorCommit: RULESREPO.priorRulesMergeSha,
        carrier: RULESREPO.cleanCarrier,
        carrierSha: RULESREPO.cleanUnitMc,
        bump: "N/A",
        units: [`unit: pr=1001 approved_tip=${RULESREPO.cleanRevertHead} base_ref_oid=${RULESREPO.priorRulesMergeSha} merge_base_sha=${RULESREPO.priorRulesMergeSha} mc=${RULESREPO.cleanUnitMc} shape=merge reverts=${RULESREPO.noRulesTagMergeSha}`],
      });
      const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
      const ghRunner = makeGhRunner({
        1001: { number: 1001, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/revert-rules-20260303", headRefOid: RULESREPO.cleanRevertHead, baseRefName: RULESREPO.cleanCarrier, mergeCommit: mc(RULESREPO.cleanUnitMc) },
      });
      const { exitCode, result } = run(
        ["pre-promote", "--carrier", RULESREPO.cleanCarrier, "--body-file", bodyFile],
        { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, skipFetch: true },
      );
      assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
      assertFailedCheck(result, "pre-promote.revert-M-has-rules-tag");
      assert.match(findCheck(result.checks, "pre-promote.revert-M-has-rules-tag").detail, /on remote origin/);
    } finally {
      gitOk(RULESREPO.work, ["tag", "-d", localOnlyTag]);
    }
  });

  // Scenario: Rules-lane revert target is proven by a published remote rules tag
  test("N49b positive: an annotated rules tag published on the remote peels to the reverts= target", async () => {
    const { run } = await loadMod();
    const annotated = "production-20260301-rules-8";
    gitOk(RULESREPO.work, ["tag", "-a", annotated, "-m", "annotated rules tag (fixture only)", RULESREPO.noRulesTagMergeSha]);
    gitOk(RULESREPO.work, ["push", "-q", "origin", `refs/tags/${annotated}`]);
    try {
      const body = provenanceBody({
        lane: "consumer-rules",
        anchorTag: "production-20260302-rules",
        anchorCommit: RULESREPO.priorRulesMergeSha,
        carrier: RULESREPO.cleanCarrier,
        carrierSha: RULESREPO.cleanUnitMc,
        bump: "N/A",
        units: [`unit: pr=1001 approved_tip=${RULESREPO.cleanRevertHead} base_ref_oid=${RULESREPO.priorRulesMergeSha} merge_base_sha=${RULESREPO.priorRulesMergeSha} mc=${RULESREPO.cleanUnitMc} shape=merge reverts=${RULESREPO.noRulesTagMergeSha}`],
      });
      const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
      const ghRunner = makeGhRunner({
        1001: { number: 1001, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/revert-rules-20260303", headRefOid: RULESREPO.cleanRevertHead, baseRefName: RULESREPO.cleanCarrier, mergeCommit: mc(RULESREPO.cleanUnitMc) },
      });
      const { result } = run(
        ["pre-promote", "--carrier", RULESREPO.cleanCarrier, "--body-file", bodyFile],
        { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION, skipFetch: true },
      );
      // The tag check passes via the ^{} peel line; the unit still fails later
      // (it is not a clean revert of this merge), which is not under test here.
      assert.equal(findCheck(result.checks, "pre-promote.revert-M-has-rules-tag").ok, true, JSON.stringify(result, null, 2));
    } finally {
      gitOk(RULESREPO.work, ["push", "-q", "origin", `:refs/tags/${annotated}`]);
      gitOk(RULESREPO.work, ["tag", "-d", annotated]);
    }
  });

  test("F-ehrc-r1-02d: approved_tip is itself a 2-parent merge commit -> pre-promote.revert-unit-one-parent", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer-rules",
      anchorTag: "production-20260302-rules",
      anchorCommit: RULESREPO.priorRulesMergeSha,
      carrier: RULESREPO.mergeHeadCarrier,
      carrierSha: RULESREPO.mergeHeadUnitMc,
      bump: "N/A",
      units: [`unit: pr=1005 approved_tip=${RULESREPO.mergeHeadApprovedTip} base_ref_oid=${RULESREPO.priorRulesMergeSha} merge_base_sha=${RULESREPO.priorRulesMergeSha} mc=${RULESREPO.mergeHeadUnitMc} shape=merge reverts=${RULESREPO.priorRulesMergeSha}`],
    });
    const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
    const ghRunner = makeGhRunner({
      1005: { number: 1005, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "hotfix/revert-rules-20260307", headRefOid: RULESREPO.mergeHeadApprovedTip, baseRefName: RULESREPO.mergeHeadCarrier, mergeCommit: mc(RULESREPO.mergeHeadUnitMc) },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", RULESREPO.mergeHeadCarrier, "--body-file", bodyFile],
      { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "pre-promote.revert-unit-one-parent");
  });

  // Scenario: Consumer-rules rollback proves revert shape before claiming no bump
  test("P7: hand-resolved revert with a valid recorded bump passes without running revert-shape", async () => {
    const { run } = await loadMod();
    const body = provenanceBody({
      lane: "consumer-rules",
      anchorTag: "production-20260302-rules",
      anchorCommit: RULESREPO.priorRulesMergeSha,
      carrier: RULESREPO.bumpRescueCarrier,
      carrierSha: RULESREPO.bumpRescueUnitMc,
      bump: `pr=1003 head=${RULESREPO.bumpRescueHead} mc=${RULESREPO.bumpRescueMc}`,
      // The unit is still recorded and verified normally (GitHub/topology/
      // content-integrity) — D11's "manual conflict resolution -> bump
      // instead" path does not drop the unit: line, it only skips the
      // revert-shape check because `bump:` is not N/A (D4/F-3-1).
      units: [`unit: pr=1004 approved_tip=${RULESREPO.bumpRescueRevertHead} base_ref_oid=${RULESREPO.bumpRescueMc} merge_base_sha=${RULESREPO.bumpRescueMc} mc=${RULESREPO.bumpRescueUnitMc} shape=merge reverts=${RULESREPO.priorRulesMergeSha}`],
    });
    const bodyFile = await writeBodyFile(RULESREPO.tmp, body);
    const ghRunner = makeGhRunner({
      1003: { number: 1003, state: "MERGED", mergedAt: "2026-09-26T00:00:00Z", headRefName: "chore/bump-v0.0.1", headRefOid: RULESREPO.bumpRescueHead, baseRefName: RULESREPO.bumpRescueCarrier, mergeCommit: mc(RULESREPO.bumpRescueMc) },
      1004: { number: 1004, state: "MERGED", mergedAt: "2026-09-26T00:01:00Z", headRefName: "hotfix/revert-rules-20260306", headRefOid: RULESREPO.bumpRescueRevertHead, baseRefName: RULESREPO.bumpRescueCarrier, mergeCommit: mc(RULESREPO.bumpRescueUnitMc), comments: [reviewBindingComment({ head: RULESREPO.bumpRescueRevertHead, baseRefOid: RULESREPO.bumpRescueMc, mergeBaseSha: RULESREPO.bumpRescueMc })] },
    });
    const { exitCode, result } = run(
      ["pre-promote", "--carrier", RULESREPO.bumpRescueCarrier, "--body-file", bodyFile],
      { cwd: RULESREPO.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
    // The decisive assertion: revert-shape is NOT invoked when bump is
    // present, even though the unit's content is a non-clean revert.
    assert.ok(!result.checks.some((c) => c.id.startsWith("pre-promote.revert-")), JSON.stringify(result.checks));
  });
});

// ===========================================================================
// post-promote — N16, N18, N23, N33-N36, P6
// Scenario: Tag must equal carrier tree or the exact merge commit
// Scenario: Back-merge completion requires a merged, ancestor-chained pull request
// ===========================================================================

describe("post-promote subcommand", () => {
  function positiveArgs(withBackMerge) {
    const args = ["post-promote", "--tag", "production-v1.0.1", "--carrier", G.carrier, "--carrier-sha", G.carrierSha, "--anchor-commit", G.sha0, "--production-pr", "104", "--provenance-sha256", goldenProvenanceDigest()];
    if (withBackMerge) args.push("--back-merge-pr", "105");
    return args;
  }

  test("positive: production merge only (no back-merge yet)", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(positiveArgs(false), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
  });

  // F-ehrc-r1-10: --tag must name an actual tag, not a branch that happens
  // to resolve via git's generic ref-type fallback.
  test("F-ehrc-r1-10b: --tag names a branch, not a tag -> post-promote.tag-is-production-tag", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const args = ["post-promote", "--tag", "production", "--carrier", G.carrier, "--carrier-sha", G.carrierSha, "--anchor-commit", G.sha0, "--production-pr", "104", "--provenance-sha256", goldenProvenanceDigest()];
    const { exitCode, result } = run(args, { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "post-promote.tag-is-production-tag");
  });

  // Scenario: Back-merge completion requires a merged, ancestor-chained pull request
  test("P6: back-merge PR MERGED, on origin/main first-parent chain, clean merge", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(positiveArgs(true), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
  });

  // Scenario: Tag must equal carrier tree or the exact merge commit
  test("N33a: MERGE_SHA^1 != anchor_commit (production advanced mid-promotion)", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(
      ["post-promote", "--tag", "production-v1.0.1", "--carrier", G.carrier, "--carrier-sha", G.carrierSha, "--anchor-commit", G.unit1Mc, "--production-pr", "104", "--provenance-sha256", goldenProvenanceDigest()],
      { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "post-promote.merge-parent1-eq-anchor");
  });

  // Scenario: Tag must equal carrier tree or the exact merge commit
  test("N33b: production merge used -s ours (MERGE_SHA^{tree} != carrier tree)", async () => {
    const { run } = await loadMod();
    // corruptHotfixMc is a real -s ours merge commit (parents [carrierBeforeUnit,
    // hotfixHead], tree missing hotfix.txt); re-purposed here as the production
    // merge commit: parent1=anchor, parent2=carrier_sha both check out fine, but
    // its own tree does not equal carrier_sha's tree.
    const ghRunner = makeGhRunner({
      104: { number: 104, state: "MERGED", mergedAt: "2026-09-26T00:03:00Z", headRefName: CI.carrier, headRefOid: CI.hotfixHead, baseRefName: "production", mergeCommit: mc(CI.corruptHotfixMc) },
    });
    const { exitCode, result } = run(
      ["post-promote", "--tag", "production-v2.0.1", "--carrier", CI.carrier, "--carrier-sha", CI.hotfixHead, "--anchor-commit", CI.carrierBeforeUnit, "--production-pr", "104", "--provenance-sha256", UNUSED_PROVENANCE_DIGEST],
      { cwd: CI.work, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "post-promote.production-content-integrity.tree-eq");
  });

  // F-ehrc-r1-03: the carrier has advanced PAST MERGE_SHA (a genuinely new
  // commit pushed to the carrier after the production merge landed), with a
  // CORRECT `--carrier-sha`. This is the actual 5c/"carrier advanced" branch
  // -- the old N16 body used a wrong `--carrier-sha` and, with the current
  // check ordering, never got past `production-pr-head-oid` to reach it.
  test("N16: carrier advanced past MERGE_SHA -> post-promote.carrier-advanced-eq-merge-sha", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const { exitCode, result } = run(
      ["post-promote", "--tag", "production-v1.0.1", "--carrier", G.carrier, "--carrier-sha", G.carrierSha, "--anchor-commit", G.sha0, "--production-pr", "104", "--provenance-sha256", goldenProvenanceDigest()],
      { cwd: G.carrierAdvancedWork, ghRunner, gitVersionText: GIT_OK_VERSION },
    );
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "post-promote.carrier-advanced-eq-merge-sha");
  });
  // (The positive counterpart -- carrier advanced exactly to MERGE_SHA -- is
  // already exercised by "positive: production merge only" above: G.work's
  // origin/<carrier> tip is mergeSha (via mergeFFOnly), != G.carrierSha, so
  // that test already walks the carrier-advanced-eq-merge-sha == true path.)

  // F-ehrc-r1-03: production PR headRefOid != carrier_sha (merge-after mode)
  // -- previously untested; N16 exercised this check only as an unintended
  // side effect of an unrelated (wrong) --carrier-sha value.
  test("F-ehrc-r1-03c: production PR headRefOid != carrier_sha -> post-promote.production-pr-head-oid", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], headRefOid: G.unit1Mc };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(false), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "post-promote.production-pr-head-oid");
  });

  // Scenario: GitHub pull request records are cross-checked, not only git topology
  test("N23b: production PR mergeCommit.oid != tag commit", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], mergeCommit: mc(G.backMergeSha) };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(false), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "post-promote.production-pr-mc-eq-tag");
  });

  // Scenario: GitHub pull request records are cross-checked, not only git topology
  test("N23c: production PR head != carrier", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], headRefName: "release/other" };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(false), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "post-promote.production-pr-head");
  });

  // Scenario: GitHub pull request records are cross-checked, not only git topology
  test("N23d: production PR base != production", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], baseRefName: "main" };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(false), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "post-promote.production-pr-base");
  });

  // Scenario: Back-merge completion requires a merged, ancestor-chained pull request
  test("N34: back-merge PR still OPEN -> Step 6A MUST NOT be declared complete", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[105] = { ...records[105], state: "OPEN", mergedAt: null };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(true), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "post-promote.back-merge-state-merged");
  });

  // Scenario: Back-merge completion requires a merged, ancestor-chained pull request
  test("N18: back-merge PR head does not match the (now-synced) carrier -> exit 1", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[105] = { ...records[105], headRefName: "release/other-branch" };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(true), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "post-promote.back-merge-head");
  });

  // Scenario: Back-merge completion requires a merged, ancestor-chained pull request
  test("N18: back-merge PR base does not match main -> exit 1", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[105] = { ...records[105], baseRefName: "release/v1.0.1" };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(true), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "post-promote.back-merge-base");
  });

  // Scenario: Back-merge completion requires a merged, ancestor-chained pull request
  test("N35a: back-merge mergeCommit.oid not on origin/main first-parent chain", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[105] = { ...records[105], mergeCommit: mc(G.unit1Mc) }; // real sha, lives on carrier not main
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(true), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "post-promote.back-merge-BM-on-main-first-parent");
  });

  // Scenario: Back-merge completion requires a merged, ancestor-chained pull request
  test("N35b: back-merge commit's second parent != synced carrier tip", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[105] = { ...records[105], mergeCommit: mc(G.bmStaleSha) }; // BM^2 == unit1Mc, not mergeSha
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(true), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    assertFailedCheck(result, "post-promote.back-merge-BM-parent2-eq-merge-sha");
  });

  // Scenario: Tag must equal carrier tree or the exact merge commit; back-merge content integrity
  test("N36: back-merge content-discarding merge (-s ours) fails only content integrity", async () => {
    const { run } = await loadMod();
    // Give this test its own remote so its main ref can start at the anchor.
    // The resulting -s ours merge has BM^2 == MERGE_SHA, while its actual tree
    // still drops all promoted carrier content from BM^2.
    const n36Tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "hcv-n36-"));
    cleanupDirs.push(n36Tmp);
    fs.cpSync(G.tmp, n36Tmp, { recursive: true });
    const n36Work = path.join(n36Tmp, "work");
    const n36Bare = path.join(n36Tmp, "remote.git");
    gitOk(n36Work, ["remote", "set-url", "origin", n36Bare]);
    gitOk(n36Work, ["checkout", "-q", "-B", "main", G.sha0]);
    const oursBackMerge = mergeOurs(n36Work, G.mergeSha, "content-discarding back-merge (-s ours, fixture only)");
    pushForce(n36Work, ["main"]);
    fetchAll(n36Work);

    const records = goldenGhRecords(G);
    records[105] = { ...records[105], headRefOid: G.mergeSha, mergeCommit: mc(oursBackMerge) };
    const ghRunner = makeGhRunner(records);
    const args = ["post-promote", "--tag", "production-v1.0.1", "--carrier", G.carrier, "--carrier-sha", G.carrierSha, "--anchor-commit", G.sha0, "--production-pr", "104", "--provenance-sha256", goldenProvenanceDigest(), "--back-merge-pr", "105"];
    const { exitCode, result } = run(args, { cwd: n36Work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1);
    const bmParent2Check = findCheck(result.checks, "post-promote.back-merge-BM-parent2-eq-merge-sha");
    assert.ok(bmParent2Check, "BM² topology check must be present");
    assert.equal(bmParent2Check.ok, true, bmParent2Check.detail);
    assert.deepEqual(
      result.checks.filter((check) => !check.ok).map((check) => check.id),
      ["post-promote.back-merge-content-integrity.tree-eq"],
    );
  });

  // Scenario: Post-promote rejects a provenance block edited after pre-promote
  // mutable-artifact-provenance: pre-promote reports the block digest; the
  // production PR body is editable, so post-promote re-hashes it.
  test("N50a: pre-promote reports the provenance digest post-promote pins", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner({ ...goldenGhRecords(G), 104: { ...goldenGhRecords(G)[104], state: "OPEN", mergedAt: null } });
    const { exitCode, result } = run(["pre-promote", "--carrier", G.carrier, "--production-pr", "104"], { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
    assert.equal(findCheck(result.checks, "pre-promote.provenance-sha256").detail, goldenProvenanceDigest());
  });

  test("N50b: provenance artifact_id edited on the production PR after pre-promote -> post-promote.provenance-sha256-unchanged", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], body: records[104].body.replace("artifact_id: ci-run-1", "artifact_id: ci-run-2") };
    assert.notEqual(records[104].body, goldenGhRecords(G)[104].body);
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(false), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "post-promote.provenance-sha256-unchanged");
  });

  test("N50c positive: edits outside the provenance block keep the digest", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], body: `Summary edited after merge.\n\n${records[104].body}` };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(false), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
    assert.equal(findCheck(result.checks, "post-promote.provenance-sha256-unchanged").ok, true);
  });

  test("N50d: production PR body lost its provenance block -> post-promote.provenance-block-present", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], body: "Release Target: N/A（hotfix lane）" };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(false), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assertFailedCheck(result, "post-promote.provenance-block-present");
  });

  test("N50e: --provenance-sha256 missing or not 64-hex -> exit 2", async () => {
    const { run } = await loadMod();
    const ghRunner = makeGhRunner(goldenGhRecords(G));
    const withoutFlag = positiveArgs(false).slice(0, -2);
    assert.equal(run(withoutFlag, { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION }).exitCode, 2);
    const badHex = [...withoutFlag, "--provenance-sha256", "abc"];
    assert.equal(run(badHex, { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION }).exitCode, 2);
  });

  test("N50f: a failed pre-promote reports no provenance digest", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], state: "OPEN", mergedAt: null, headRefOid: G.unit1Mc };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(["pre-promote", "--carrier", G.carrier, "--production-pr", "104"], { cwd: G.frozenWork, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 1, JSON.stringify(result, null, 2));
    assert.equal(findCheck(result.checks, "pre-promote.provenance-sha256"), undefined);
  });

  test("N50g positive: a CRLF production PR body (web editor) keeps the same digest", async () => {
    const { run } = await loadMod();
    const records = goldenGhRecords(G);
    records[104] = { ...records[104], body: records[104].body.replace(/\n/g, "\r\n") };
    const ghRunner = makeGhRunner(records);
    const { exitCode, result } = run(positiveArgs(false), { cwd: G.work, ghRunner, gitVersionText: GIT_OK_VERSION });
    assert.equal(exitCode, 0, JSON.stringify(result, null, 2));
  });

  test("N50h: provenance block (re-hashed) names a different carrier / carrier_sha / anchor_commit -> post-promote.provenance-*", async () => {
    const { run } = await loadMod();
    const golden = goldenGhRecords(G)[104].body;
    const cases = [
      ["post-promote.provenance-carrier", golden.replace(`carrier: ${G.carrier}`, "carrier: release/v9.9.9")],
      ["post-promote.provenance-carrier-sha", golden.replace(`carrier_sha: ${G.carrierSha}`, `carrier_sha: ${G.unit1Mc}`)],
      ["post-promote.provenance-anchor-commit", golden.replace(`anchor_commit: ${G.sha0}`, `anchor_commit: ${G.unit1Mc}`)],
    ];
    for (const [id, body] of cases) {
      assert.notEqual(body, golden, id);
      const records = goldenGhRecords(G);
      records[104] = { ...records[104], body };
      const args = positiveArgs(false).slice(0, -1).concat(provenanceDigestOf(body));
      const { exitCode, result } = run(args, { cwd: G.work, ghRunner: makeGhRunner(records), gitVersionText: GIT_OK_VERSION });
      assert.equal(exitCode, 1, `${id}: ${JSON.stringify(result, null, 2)}`);
      assert.equal(findCheck(result.checks, "post-promote.provenance-sha256-unchanged").ok, true, id);
      assertFailedCheck(result, id);
    }
  });
});

// ===========================================================================
// CLI end-to-end (PATH-shim `gh`) — a handful of representative cases
// ===========================================================================

describe("CLI end-to-end with a PATH-shim gh", () => {
  let shimDir;

  before(async () => {
    shimDir = await fsp.mkdtemp(path.join(os.tmpdir(), "hcv-ghshim-"));
    cleanupDirs.push(shimDir);
  });

  // `permissions` answers the review-binding author lookup; the shim only
  // accepts the exact argv defaultGhPermissionRunner sends.
  function writeGhShim(responsesByPr, permissions = {}) {
    const jsonPath = path.join(shimDir, "responses.json");
    fs.writeFileSync(jsonPath, JSON.stringify({ prs: responsesByPr, permissions }));
    const shimPath = path.join(shimDir, "gh");
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(jsonPath)}, "utf8"));
const perm = /^repos\\/\\{owner\\}\\/\\{repo\\}\\/collaborators\\/([^/]+)\\/permission$/.exec(args[1] || "");
if (args[0] === "api" && perm && args[2] === "--jq" && args[3] === ".permission" && args.length === 4) {
  process.stdout.write((responses.permissions[perm[1]] ?? "none") + "\\n");
  process.exit(0);
}
if (args[0] !== "pr" || args[1] !== "view") { process.exit(3); }
const prNumber = args[2];
const rec = responses.prs[prNumber];
if (!rec) { process.stderr.write("no fixture record\\n"); process.exit(4); }
process.stdout.write(JSON.stringify(rec));
`;
    fs.writeFileSync(shimPath, script);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
  }

  function runCli(cwd, args, { pathPrepend } = {}) {
    return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...gitEnv(), PATH: `${pathPrepend}${path.delimiter}${process.env.PATH}` },
    });
  }

  test("e2e positive: merge-proof against the golden repo via a shimmed gh", () => {
    writeGhShim(goldenGhRecords(G));
    // frozenWork: carrier ref not yet ff-advanced to the production tag, so
    // its first-parent chain still runs through bump/unit1/unit2 as expected.
    const r = runCli(G.frozenWork, ["merge-proof", "--kind", "bump", "--pr", "101", "--carrier", G.carrier, "--anchor-commit", G.sha0], { pathPrepend: shimDir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
  });

  test("N24c e2e: gh binary absent from complete PATH -> exit 2 with gh ENOENT, not silently treated as pass", () => {
    const gitBinaryName = process.platform === "win32" ? "git.exe" : "git";
    const gitBinary = process.env.PATH.split(path.delimiter)
      .map((dir) => path.join(dir, gitBinaryName))
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    assert.ok(gitBinary, `could not locate executable ${gitBinaryName} in the runner's initial PATH`);
    // git.exe needs its own install directories (its libraries and `sh`), so on Windows the controlled
    // PATH is the runner's PATH without any directory that holds a `gh`; elsewhere it is a fresh
    // directory holding only a link to git.
    let pathDir;
    if (process.platform === "win32") {
      pathDir = process.env.PATH.split(path.delimiter)
        .filter((dir) => dir && !["gh.exe", "gh.com", "gh.cmd", "gh.bat", "gh"].some((name) => fs.existsSync(path.join(dir, name))))
        .join(path.delimiter);
    } else {
      pathDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcv-git-only-path-"));
      cleanupDirs.push(pathDir);
      fs.symlinkSync(gitBinary, path.join(pathDir, gitBinaryName));
      assert.deepEqual(fs.readdirSync(pathDir), [gitBinaryName], "controlled PATH must contain only the git executable");
    }

    const env = { ...gitEnv(), PATH: pathDir };
    assert.equal(spawnSync("git", ["--version"], { env, encoding: "utf8" }).status, 0, "git must resolve in the controlled PATH");
    const missingGh = spawnSync("gh", ["--version"], { env, encoding: "utf8" });
    assert.equal(missingGh.error?.code, "ENOENT", "gh must be absent from the complete controlled PATH");

    const result = spawnSync(process.execPath, [SCRIPT_PATH, "merge-proof", "--kind", "bump", "--pr", "101", "--carrier", G.carrier, "--anchor-commit", G.sha0], {
      cwd: G.frozenWork,
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.reason, /\bgh\b.*\bENOENT\b|\bENOENT\b.*\bgh\b/, `expected gh ENOENT, got: ${payload.reason}`);
  });

  // Scenario: Review binding counts only from a trusted, unedited, pre-merge comment
  test("e2e: the default permission runner trusts an admin binding author and ignores a read-only one", () => {
    const binding = reviewBindingComment({ head: G.unit1Head, baseRefOid: G.bumpMcSha, mergeBaseSha: G.bumpMcSha }, { login: "repo-admin" });
    const record = { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit1Head, baseRefName: G.carrier, comments: [binding] };
    const args = ["pre-merge", "--pr", "102", "--carrier", G.carrier, "--approved-tip", G.unit1Head, "--base-ref-oid", G.bumpMcSha, "--merge-base", G.bumpMcSha];
    writeGhShim({ 102: record }, { "repo-admin": "admin" });
    const ok = runCli(G.beforeUnit1MergeWork, args, { pathPrepend: shimDir });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    writeGhShim({ 102: record }, { "repo-admin": "read" });
    const denied = runCli(G.beforeUnit1MergeWork, args, { pathPrepend: shimDir });
    assert.equal(denied.status, 1, denied.stdout + denied.stderr);
    const parsed = JSON.parse(denied.stdout);
    assertFailedCheck(parsed, "pre-merge.review-binding-present");
    assert.match(findCheck(parsed.checks, "pre-merge.review-binding-present").detail, /author without write access/);
  });

  // #3556: the literal production merge number names the back-merge PR, which
  // shares the carrier head but targets main -> the CLI exits non-zero before the merge.
  test("e2e merge-target: a same-head PR on another base exits 1, the carrier production PR exits 0", () => {
    writeGhShim({
      201: { state: "OPEN", isCrossRepository: false, headRefName: G.carrier, baseRefName: "production" },
      202: { state: "OPEN", isCrossRepository: false, headRefName: G.carrier, baseRefName: "main" },
    });
    const ok = runCli(G.work, ["merge-target", "--pr", "201", "--carrier", G.carrier, "--base", "production"], { pathPrepend: shimDir });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const wrong = runCli(G.work, ["merge-target", "--pr", "202", "--carrier", G.carrier, "--base", "production"], { pathPrepend: shimDir });
    assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
    assertFailedCheck(JSON.parse(wrong.stdout), "merge-target.base");
  });

  test("e2e predicate failure: pre-merge with a mismatched approved-tip exits 1", () => {
    writeGhShim({ 102: { number: 102, state: "OPEN", headRefName: "hotfix/fix-one", headRefOid: G.unit2Head, baseRefName: G.carrier, comments: [] } });
    const r = runCli(G.work, ["pre-merge", "--pr", "102", "--carrier", G.carrier, "--approved-tip", G.unit1Head, "--base-ref-oid", G.bumpMcSha, "--merge-base", G.bumpMcSha], { pathPrepend: shimDir });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const parsed = JSON.parse(r.stdout);
    assertFailedCheck(parsed, "pre-merge.gh-head-oid");
  });
});

describe("carrier regex parity with branch-naming SSOT", () => {
  test("laneMatchesCarrier accepts exactly the release carriers branch-naming exempts", async () => {
    const { laneMatchesCarrier } = await import(pathToFileURL(SCRIPT_PATH).href);
    const { validateBranchName } = await import(
      pathToFileURL(path.join(HERE, "..", "hooks", "lib", "branch-naming.mjs")).href
    );
    const names = [
      "release/v6.98.1",
      "release/20260926-abc1234",
      "release/20260926-abc1234-2",
      "release/rules-20260926",
      "release/rules-20260926-1",
      "release/rules-20260926-2",
      "release/rules-20260926-10",
      "release/rules-20260926-01",
      "release/v6.98",
      "hotfix/fix-x",
    ];
    for (const name of names) {
      const ssot = validateBranchName(name, new Set(), HERE).exempt === "release";
      const verifier = ["source", "consumer", "consumer-rules"].some((lane) => laneMatchesCarrier(lane, name));
      assert.equal(verifier, ssot, `carrier parity drift for ${name}`);
    }
  });
});

// ===========================================================================
// merge-target (#3556): binds the literal PR number of a Step 7 merge to the
// carrier PR for one base before `gh pr merge` runs.
// ===========================================================================

describe("merge-target subcommand", () => {
  const CARRIER = "release/v1.0.1";
  const records = {
    201: { state: "OPEN", isCrossRepository: false, headRefName: CARRIER, headRefOid: "a".repeat(40), baseRefName: "production" },
    202: { state: "OPEN", isCrossRepository: false, headRefName: CARRIER, headRefOid: "a".repeat(40), baseRefName: "main" },
    203: { state: "OPEN", isCrossRepository: false, headRefName: "hotfix/fix-one", baseRefName: "production" },
    204: { state: "MERGED", isCrossRepository: false, headRefName: CARRIER, baseRefName: "production" },
    // A fork PR matching #201 in state, head branch name, base and head SHA.
    205: { state: "OPEN", isCrossRepository: true, headRefName: CARRIER, headRefOid: "a".repeat(40), baseRefName: "production" },
  };
  async function mergeTarget(pr, base, ghRunner = makeGhRunner(records)) {
    const { run } = await loadMod();
    return run(["merge-target", "--pr", String(pr), "--carrier", CARRIER, "--base", base], { cwd: process.cwd(), ghRunner, gitVersionText: GIT_OK_VERSION });
  }

  test("the open carrier PR for the named base passes (production and main)", async () => {
    for (const [pr, base] of [[201, "production"], [202, "main"]]) {
      const { exitCode, result } = await mergeTarget(pr, base);
      assert.equal(exitCode, 0, JSON.stringify(result));
      assert.equal(result.ok, true);
    }
  });

  test("a PR with the same carrier head but another base fails merge-target.base", async () => {
    for (const [pr, base] of [[202, "production"], [201, "main"]]) {
      const { exitCode, result } = await mergeTarget(pr, base);
      assert.equal(exitCode, 1, JSON.stringify(result));
      assertFailedCheck(result, "merge-target.base");
    }
  });

  test("a PR whose head is not the carrier fails merge-target.head", async () => {
    const { exitCode, result } = await mergeTarget(203, "production");
    assert.equal(exitCode, 1, JSON.stringify(result));
    assertFailedCheck(result, "merge-target.head");
  });

  test("a fork PR with the same state, head branch, base and head SHA fails merge-target.same-repository", async () => {
    const { exitCode, result } = await mergeTarget(205, "production");
    assert.equal(exitCode, 1, JSON.stringify(result));
    assertFailedCheck(result, "merge-target.same-repository");
  });

  test("a PR that is no longer open fails merge-target.state-open", async () => {
    const { exitCode, result } = await mergeTarget(204, "production");
    assert.equal(exitCode, 1, JSON.stringify(result));
    assertFailedCheck(result, "merge-target.state-open");
  });

  test("a failed PR lookup or an unknown base exits 2", async () => {
    const lookup = await mergeTarget(299, "production");
    assert.equal(lookup.exitCode, 2, JSON.stringify(lookup.result));
    const badBase = await mergeTarget(201, "integration");
    assert.equal(badBase.exitCode, 2, JSON.stringify(badBase.result));
    assert.match(badBase.result.reason, /--base must be production\|main/);
  });
});
