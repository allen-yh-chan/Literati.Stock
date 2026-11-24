// Zero-diff production ancestry repair exemption (fix-zero-diff-ancestry-review): the predicate in
// hooks/lib/zero-diff-ancestry-repair.mjs and its place in isCrossModelExempt / crossModelExemptionReason.
// Real temporary git repos build the merge shapes, so the parent and tag reads run for real.
import "./lib/isolated-control-evidence-state.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTempDir } from "./lib/tmp.mjs";
import {
  isZeroDiffAncestryRepair,
  ZERO_DIFF_ANCESTRY_REPAIR_REASON,
} from "../hooks/lib/zero-diff-ancestry-repair.mjs";
import {
  isCrossModelExempt,
  crossModelExemptionReason,
  checkCrossModelMergeGate,
  checkCrossModelExemptionNotice,
} from "../hooks/pre-tool-gate.mjs";
import { __testSnapshotFromGhData as snapshotFromGhData } from "../hooks/post-pr-completion-check.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "tester",
  GIT_AUTHOR_EMAIL: "tester.local",
  GIT_COMMITTER_NAME: "tester",
  GIT_COMMITTER_EMAIL: "tester.local",
};
const roots = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(cwd, name, content, message) {
  writeFileSync(path.join(cwd, name), content, "utf8");
  git(cwd, ["add", "--", name]);
  git(cwd, ["commit", "-q", "--no-verify", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const REPAIR_BRANCH = "bugfix/fix-production-ancestry-production-20260101-rules-1";

/**
 * main and a production line that made the same change separately, so merging the production commit into main
 * leaves main's tree unchanged (the zero-diff repair shape). `tag` is "lightweight", "annotated", "other" (a tag
 * outside production-*) or "none".
 */
function makeRepairRepo({ tag = "lightweight", branch = REPAIR_BRANCH } = {}) {
  const cwd = makeTempDir("zero-diff-ancestry-");
  roots.push(cwd);
  git(cwd, ["init", "-q", "-b", "main"]);
  const root = commitFile(cwd, "base.txt", "base\n", "base");
  git(cwd, ["checkout", "-q", "-b", "production-line", root]);
  const production = commitFile(cwd, "shared.txt", "same change\n", "production fix");
  if (tag === "lightweight") git(cwd, ["tag", "production-20260101-rules-1", production]);
  if (tag === "annotated") git(cwd, ["tag", "-a", "-m", "release", "production-20260101-rules-1", production]);
  if (tag === "other") git(cwd, ["tag", "v1.0.0", production]);
  git(cwd, ["checkout", "-q", "main"]);
  const mainTip = commitFile(cwd, "shared.txt", "same change\n", "main has the same change");
  git(cwd, ["checkout", "-q", "-b", branch]);
  git(cwd, ["merge", "-q", "--no-ff", "--no-edit", production]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  assert.equal(git(cwd, ["rev-parse", `${head}^{tree}`]), git(cwd, ["rev-parse", `${mainTip}^{tree}`]), "fixture: zero diff");
  return { cwd, head, mainTip, production, branch };
}

// The two bases a zero-diff repair may target: main (git-branch-production-ancestry-repair.md) and a
// release/rules-* carrier (release-rules-lane.md §Carrier ancestry repair).
const ALLOWED_BASES = ["main", "release/rules-20260101", "release/rules-20260101-2"];

test("Scenario: A zero-diff merge of an exact production tag is a zero-diff ancestry repair", () => {
  for (const tag of ["lightweight", "annotated"]) {
    const repo = makeRepairRepo({ tag });
    assert.equal(
      isZeroDiffAncestryRepair({ headRefName: repo.branch, baseRefName: "main", changedFiles: [], headSha: repo.head, cwd: repo.cwd }),
      true,
      `${tag} production tag`,
    );
  }
});

test("Scenario: A zero-diff repair is exempt only into main or a release/rules-* carrier", () => {
  const repo = makeRepairRepo();
  const shape = { headRefName: repo.branch, changedFiles: [], headSha: repo.head, cwd: repo.cwd };
  for (const baseRefName of ALLOWED_BASES) {
    assert.equal(isZeroDiffAncestryRepair({ ...shape, baseRefName }), true, baseRefName);
  }
  // Any other base, or a base the caller could not read, is not exempt: the PR falls back to a second review.
  for (const baseRefName of ["production", "release/v1.2.3", "release/20260101-abcdef0", "release/rules-2026", "integration", "feature/x", "origin/main", "", null, undefined]) {
    assert.equal(isZeroDiffAncestryRepair({ ...shape, baseRefName }), false, String(baseRefName));
  }
});

test("Scenario: An unknown or non-empty changed-file list is never a zero-diff ancestry repair", () => {
  const repo = makeRepairRepo();
  const base = { headRefName: repo.branch, baseRefName: "main", headSha: repo.head, cwd: repo.cwd };
  for (const changedFiles of [null, undefined, "", {}, ["shared.txt"]]) {
    assert.equal(isZeroDiffAncestryRepair({ ...base, changedFiles }), false, JSON.stringify(changedFiles));
  }
});

test("Scenario: Only a bugfix/fix-production-ancestry-* branch can be a zero-diff ancestry repair", () => {
  const repo = makeRepairRepo();
  for (const headRefName of ["bugfix/other-fix", "feature/fix-production-ancestry-x", "hotfix/fix-production-ancestry-x", "chore/fix-production-ancestry-x", "bugfix/fix-production-ancestry-", ""]) {
    assert.equal(isZeroDiffAncestryRepair({ headRefName, baseRefName: "main", changedFiles: [], headSha: repo.head, cwd: repo.cwd }), false, headRefName);
  }
});

test("Scenario: A head that does not merge a production tag is not a zero-diff ancestry repair", () => {
  for (const tag of ["other", "none"]) {
    const repo = makeRepairRepo({ tag });
    assert.equal(isZeroDiffAncestryRepair({ headRefName: repo.branch, baseRefName: "main", changedFiles: [], headSha: repo.head, cwd: repo.cwd }), false, `${tag} tag`);
  }
  // A production tag on the first parent (main) does not count: the merged parent must be the tag.
  const firstParentTagged = makeRepairRepo({ tag: "none" });
  git(firstParentTagged.cwd, ["tag", "production-20260102", firstParentTagged.mainTip]);
  assert.equal(
    isZeroDiffAncestryRepair({ headRefName: firstParentTagged.branch, baseRefName: "main", changedFiles: [], headSha: firstParentTagged.head, cwd: firstParentTagged.cwd }),
    false,
    "tag on the first parent only",
  );
  // A single-parent head is not a merge, even with an empty diff on top of the repair merge.
  const single = makeRepairRepo();
  git(single.cwd, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "empty"]);
  const emptyHead = git(single.cwd, ["rev-parse", "HEAD"]);
  assert.equal(isZeroDiffAncestryRepair({ headRefName: single.branch, baseRefName: "main", changedFiles: [], headSha: emptyHead, cwd: single.cwd }), false, "single parent");
});

test("Scenario: A head that cannot be read locally is not a zero-diff ancestry repair", () => {
  const repo = makeRepairRepo();
  for (const headSha of ["f".repeat(40), "HEAD", repo.head.slice(0, 12), ""]) {
    assert.equal(isZeroDiffAncestryRepair({ headRefName: repo.branch, baseRefName: "main", changedFiles: [], headSha, cwd: repo.cwd }), false, headSha);
  }
  const notGit = makeTempDir("zero-diff-ancestry-norepo-");
  roots.push(notGit);
  assert.equal(isZeroDiffAncestryRepair({ headRefName: repo.branch, baseRefName: "main", changedFiles: [], headSha: repo.head, cwd: notGit }), false, "not a git directory");
});

test("Scenario: The cross-model exemption and its reason name the zero-diff ancestry repair", () => {
  const repo = makeRepairRepo();
  for (const baseRefName of ALLOWED_BASES) {
    assert.equal(isCrossModelExempt(repo.branch, [], repo.cwd, new Map(), repo.head, baseRefName), true, baseRefName);
    assert.equal(crossModelExemptionReason(repo.branch, [], repo.cwd, new Map(), repo.head, baseRefName), ZERO_DIFF_ANCESTRY_REPAIR_REASON, baseRefName);
  }
  // Without a head SHA the merge shape cannot be proven: not exempt, the same answer as before this change.
  assert.equal(isCrossModelExempt(repo.branch, [], repo.cwd, new Map()), false);
  assert.equal(crossModelExemptionReason(repo.branch, [], repo.cwd, new Map()), null);
  // Without a base, or into another base, the repair is not exempt.
  for (const baseRefName of [undefined, "production", "release/v1.2.3"]) {
    assert.equal(isCrossModelExempt(repo.branch, [], repo.cwd, new Map(), repo.head, baseRefName), false, String(baseRefName));
    assert.equal(crossModelExemptionReason(repo.branch, [], repo.cwd, new Map(), repo.head, baseRefName), null, String(baseRefName));
  }
  // A non-empty diff on the same branch still needs a second review.
  assert.equal(isCrossModelExempt(repo.branch, ["shared.txt"], repo.cwd, new Map(), repo.head, "main"), false);
  // hotfix/* is never exempt, whatever the head.
  assert.equal(isCrossModelExempt("hotfix/fix-production-ancestry-x", [], repo.cwd, new Map(), repo.head, "main"), false);
});

test("Scenario: The post-PR completion snapshot carries the PR base for the exemption check", () => {
  // The Stop hook passes snapshot.baseRefName to isCrossModelExempt; a snapshot without it would never exempt.
  assert.equal(snapshotFromGhData({ baseRefName: "release/rules-20260101" }).baseRefName, "release/rules-20260101");
  assert.equal(snapshotFromGhData({}).baseRefName, "");
});

// The merge gate reads the PR through the documented env mocks (gh pr view JSON and the changed-file list) and the
// local git objects of `cwd`, here the fixture repo. `baseRefName: null` drops the field from the gh output.
function runMergeGate(repo, { headRefName = repo.branch, headRefOid = repo.head, baseRefName = "main", diffFiles = "" } = {}) {
  const base = baseRefName === null ? {} : { baseRefName };
  const mocks = {
    CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({ headRefOid, headRefName, ...base, state: "OPEN", body: "", comments: [] }),
    CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: diffFiles,
  };
  const saved = Object.fromEntries(Object.keys(mocks).map((key) => [key, process.env[key]]));
  Object.assign(process.env, mocks);
  try {
    const command = "gh pr merge 4242 --merge";
    return { gate: checkCrossModelMergeGate(command, repo.cwd), notice: checkCrossModelExemptionNotice(command, repo.cwd) };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Scenario: The merge gate lets a zero-diff ancestry repair through with a non-silent notice", () => {
  const repo = makeRepairRepo();
  for (const baseRefName of ALLOWED_BASES) {
    const { gate, notice } = runMergeGate(repo, { baseRefName });
    assert.equal(gate, null, `${baseRefName}: the merge gate must not block: ${JSON.stringify(gate)}`);
    assert.ok(notice?.advisory, `${baseRefName}: the exemption is announced`);
    assert.ok(notice.advisory.includes(ZERO_DIFF_ANCESTRY_REPAIR_REASON), notice.advisory);
  }
});

test("Scenario: The merge gate still requires a second review when any condition is missing", () => {
  const repo = makeRepairRepo();
  const untagged = makeRepairRepo({ tag: "none" });
  const cases = [
    ["non-empty diff", runMergeGate(repo, { diffFiles: "M\tshared.txt" })],
    ["head not local", runMergeGate(repo, { headRefOid: "e".repeat(40) })],
    ["merged parent is not a production tag", runMergeGate(untagged)],
    ["another bugfix branch", runMergeGate(repo, { headRefName: "bugfix/other-fix" })],
    ["base is not main or a release/rules-* carrier", runMergeGate(repo, { baseRefName: "release/v1.2.3" })],
    ["base missing from the PR data", runMergeGate(repo, { baseRefName: null })],
  ];
  for (const [label, { gate, notice }] of cases) {
    assert.equal(gate?.block, true, `${label}: must block without a sticky`);
    assert.equal(notice, null, `${label}: no exemption notice`);
  }
});

// release-rules-lane.md §Carrier ancestry repair: the detection commands, run on real graphs. `classifyCarrier`
// mirrors the section's decision order; the test proves the table tells a stale carrier from a Production PR-only
// violation (second review F2) and that a production tip that moves during the repair is not reported repaired (F1).
function isAncestor(cwd, ancestor, descendant) {
  try {
    git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function classifyCarrier(cwd, { tag, carrierTip, prodTip }) {
  if (isAncestor(cwd, prodTip, carrierTip)) return "no-repair";
  if (git(cwd, ["tag", "--points-at", prodTip, "--list", "production-*"]) === "") return "untagged";
  return isAncestor(cwd, tag, prodTip) ? "stale" : "violation";
}

function initRepo(prefix) {
  const cwd = makeTempDir(prefix);
  roots.push(cwd);
  git(cwd, ["init", "-q", "-b", "main"]);
  return { cwd, root: commitFile(cwd, "base.txt", "base\n", "base") };
}

test("Scenario: The carrier ancestry repair detection tells a stale carrier from a Production PR-only violation", () => {
  // Violation: a business release tagged on main, while production holds a rules release main's tag does not contain.
  const v = initRepo("carrier-violation-");
  git(v.cwd, ["checkout", "-q", "-b", "production", v.root]);
  const prodTip = commitFile(v.cwd, "shared.txt", "rules v1\n", "production rules release");
  git(v.cwd, ["tag", "production-20261113-rules-2", prodTip]);
  git(v.cwd, ["checkout", "-q", "main"]);
  const businessTag = commitFile(v.cwd, "shared.txt", "rules v1\n", "business release on main");
  git(v.cwd, ["tag", "production-20261114-8", businessTag]);
  git(v.cwd, ["checkout", "-q", "-b", "release/rules-20261114", businessTag]);
  const carrierTip = commitFile(v.cwd, "sync.txt", "rules v2\n", "chore: sync devpro-agent-rules (abcdef1)");
  assert.equal(classifyCarrier(v.cwd, { tag: "production-20261114-8", carrierTip, prodTip }), "violation");

  // The repair keeps the carrier tree, then production advances before the carrier reaches the production PR.
  git(v.cwd, ["checkout", "-q", "-b", "bugfix/fix-production-ancestry-production-20261113-rules-2-carrier", carrierTip]);
  git(v.cwd, ["merge", "-q", "--no-ff", "--no-edit", "production-20261113-rules-2"]);
  const repaired = git(v.cwd, ["rev-parse", "HEAD"]);
  assert.equal(git(v.cwd, ["rev-parse", `${repaired}^{tree}`]), git(v.cwd, ["rev-parse", `${carrierTip}^{tree}`]), "zero tree delta");
  git(v.cwd, ["checkout", "-q", "production"]);
  const advanced = commitFile(v.cwd, "later.txt", "later\n", "later production release");
  // The check against the tip saved before the repair passes; the freshly read tip does not.
  assert.equal(isAncestor(v.cwd, prodTip, repaired), true, "saved tip");
  assert.equal(isAncestor(v.cwd, advanced, repaired), false, "fresh tip: not repaired, rerun the detection");

  // Stale: the carrier's base tag is in production history and a later legitimate production release moved past it.
  const s = initRepo("carrier-stale-");
  git(s.cwd, ["checkout", "-q", "-b", "production", s.root]);
  const firstRelease = commitFile(s.cwd, "shared.txt", "release 1\n", "production release 1");
  git(s.cwd, ["tag", "production-20261113-rules", firstRelease]);
  git(s.cwd, ["checkout", "-q", "-b", "release/rules-20261114", firstRelease]);
  const staleCarrierTip = commitFile(s.cwd, "sync.txt", "rules v2\n", "chore: sync devpro-agent-rules (abcdef1)");
  git(s.cwd, ["checkout", "-q", "production"]);
  const secondRelease = commitFile(s.cwd, "other.txt", "release 2\n", "production release 2");
  git(s.cwd, ["tag", "production-20261114", secondRelease]);
  assert.equal(classifyCarrier(s.cwd, { tag: "production-20261113-rules", carrierTip: staleCarrierTip, prodTip: secondRelease }), "stale");

  // An untagged production tip is the incident route, and a carrier that already contains the tip needs nothing.
  git(s.cwd, ["checkout", "-q", "production"]);
  const untagged = commitFile(s.cwd, "direct.txt", "direct\n", "direct merge");
  assert.equal(classifyCarrier(s.cwd, { tag: "production-20261113-rules", carrierTip: staleCarrierTip, prodTip: untagged }), "untagged");
  assert.equal(classifyCarrier(s.cwd, { tag: "production-20261113-rules", carrierTip: staleCarrierTip, prodTip: firstRelease }), "no-repair");
});
