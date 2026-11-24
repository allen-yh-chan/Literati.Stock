/**
 * prune-rules-lane.test.mjs — prove-it for #2726
 *
 * Rules lane products must be deletable without sweeping feature/*.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { promises as fs, cpSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const pruneRules = path.join(REPO_ROOT, ".devpro", "scripts", "prune-rules-lane.mjs");
const pruneMerged = path.join(REPO_ROOT, ".devpro", "scripts", "prune-merged-local.mjs");

function git(cwd, args) {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function buildBaseRepoTemplate() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "prune-rules-lane-template-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");

  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  await fs.writeFile(path.join(work, "a.txt"), "init\n");
  git(work, "add .");
  git(work, 'commit -q -m "init"');

  execSync(`git init -q --bare "${bare}"`);
  git(work, `remote add origin "${bare}"`);
  git(work, "push -q origin main");
  git(work, "branch -f production");
  git(work, "push -q origin production");

  return { tmp, work, bare };
}

let baseRepoTemplatePromise;

async function ensureBaseRepoTemplate() {
  if (!baseRepoTemplatePromise) {
    baseRepoTemplatePromise = buildBaseRepoTemplate();
  }
  return baseRepoTemplatePromise;
}

async function createBaseRepo() {
  const template = await ensureBaseRepoTemplate();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "prune-rules-lane-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");

  cpSync(template.bare, bare, { recursive: true });
  cpSync(template.work, work, { recursive: true });
  git(work, `remote set-url origin "${bare}"`);

  return { tmp, work, bare };
}

function run(script, cwd, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function eligibleNames(stdout, kind) {
  const match = stdout.match(
    new RegExp(`Eligible ${kind} \\(\\d+\\):\\n([\\s\\S]*?)(?=\\n(?:Eligible|Ineligible|Skipped|No deletions))`),
  );
  return (match?.[1] ?? "")
    .split("\n")
    .map((line) => line.match(/^\s+- (?:origin\/)?(\S+)/)?.[1])
    .filter(Boolean);
}

describe("prune-rules-lane: isolates rules/* from feature/*", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    const prodBase = git(work, "rev-parse HEAD");

    // rules/* merged to main only (simulates cherry-pick gap on production)
    git(work, "checkout -q -b rules/agent-rules-v6.93.0 main");
    await fs.writeFile(path.join(work, "rules.txt"), "rules sync\n");
    git(work, "add .");
    git(work, 'commit -q -m "chore: sync devpro-agent-rules"');
    const rulesTip = git(work, "rev-parse HEAD");
    git(work, "push -q -u origin rules/agent-rules-v6.93.0");
    git(work, "checkout -q main");
    git(work, `merge --ff-only ${rulesTip}`);
    git(work, "push -q origin main");

    // feature/* also on main, not on production — must NOT be touched
    git(work, "checkout -q -b feature/add-fafp-next-week main");
    await fs.writeFile(path.join(work, "feature.txt"), "feature\n");
    git(work, "add .");
    git(work, 'commit -q -m "feat: next week"');
    const featureTip = git(work, "rev-parse HEAD");
    git(work, "checkout -q main");
    git(work, `merge --ff-only ${featureTip}`);
    git(work, "push -q origin main");

    // keep production at pre-rules tip (cherry-pick world)
    git(work, `branch -f production ${prodBase}`);
    git(work, "push -q -f origin production");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("dry-run lists rules/* and never feature/* — Scenario: Rules Branch Eligible After Main Merge", () => {
    const result = run(pruneRules, work);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /DRY-RUN ONLY/);
    assert.match(result.stdout, /rules\/agent-rules-v6\.93\.0/);
    assert.doesNotMatch(result.stdout, /feature\/add-fafp-next-week/);
  });

  it("canonical local and remote selection excludes main and production while retaining an ordinary candidate", () => {
    const result = run(pruneRules, work);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const local = eligibleNames(result.stdout, "local");
    const remote = eligibleNames(result.stdout, "remote");
    assert.ok(local.includes("rules/agent-rules-v6.93.0"), `ordinary local candidate missing: ${local}`);
    assert.ok(remote.includes("rules/agent-rules-v6.93.0"), `ordinary remote candidate missing: ${remote}`);
    for (const protectedName of ["main", "production"]) {
      assert.ok(!local.includes(protectedName), `${protectedName} must not be selected locally: ${local}`);
      assert.ok(!remote.includes(protectedName), `${protectedName} must not be selected remotely: ${remote}`);
    }
  });

  it("--exec deletes rules/* and leaves feature/*", () => {
    const result = run(pruneRules, work, ["--exec"]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(git(work, "branch --list rules/agent-rules-v6.93.0"), "");
    assert.match(git(work, "branch --list feature/add-fafp-next-week"), /feature\/add-fafp-next-week/);
  });
});

describe("prune-rules-lane: dirty worktree is skipped without --force", () => {
  let tmp, work, wtPath;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    git(work, "checkout -q -b rules/agent-rules-v6.94.0 main");
    await fs.writeFile(path.join(work, "rules2.txt"), "rules\n");
    git(work, "add .");
    git(work, 'commit -q -m "chore: sync"');
    const tip = git(work, "rev-parse HEAD");
    git(work, "checkout -q main");
    git(work, `merge --ff-only ${tip}`);
    git(work, "push -q origin main");

    wtPath = path.join(tmp, "rules-wt");
    git(work, `worktree add "${wtPath}" rules/agent-rules-v6.94.0`);
    await fs.writeFile(path.join(wtPath, "dirty.txt"), "uncommitted\n");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("--exec skips dirty worktree and retains branch — Scenario: Dirty Worktree Is Skipped", () => {
    const result = run(pruneRules, work, ["--exec"]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /dirty worktree/i);
    assert.doesNotMatch(result.stdout, /worktree remove --force/);
    assert.match(git(work, "branch --list rules/agent-rules-v6.94.0"), /rules\/agent-rules-v6\.94\.0/);
    assert.match(git(work, "worktree list"), /rules-wt/);
  });
});

// A rules lane worktree always carries the initialised `.devpro-agent-rules` submodule, and
// git refuses a plain `git worktree remove` on such a worktree (#2840).
async function createSubmoduleWorktreeRepo(branch, { ignoreSubmoduleChanges = false } = {}) {
  const { tmp, work } = await createBaseRepo();
  const subSource = path.join(tmp, "sub-source");
  await fs.mkdir(subSource);
  git(subSource, "init -q -b main");
  git(subSource, "config user.email t@e.x");
  git(subSource, "config user.name test");
  await fs.writeFile(path.join(subSource, "rule.md"), "rule\n");
  git(subSource, "add .");
  git(subSource, 'commit -q -m "init"');

  git(work, `checkout -q -b ${branch} main`);
  git(work, `-c protocol.file.allow=always submodule add -q "${subSource}" sub`);
  git(work, 'commit -q -m "chore: sync devpro-agent-rules"');
  const tip = git(work, "rev-parse HEAD");
  git(work, "checkout -q main");
  git(work, `merge --ff-only ${tip}`);
  git(work, "push -q origin main");

  const wtPath = path.join(tmp, "rules-wt");
  git(work, `worktree add "${wtPath}" ${branch}`);
  git(wtPath, "-c protocol.file.allow=always submodule update --init");
  // `submodule.<name>.ignore=all` makes a plain `git status` blind to submodule changes.
  if (ignoreSubmoduleChanges) git(work, "config submodule.sub.ignore all");
  return { tmp, work, wtPath };
}

describe("prune-rules-lane: clean worktree with a submodule is removed (#2840)", () => {
  let tmp, work, wtPath;

  before(async () => {
    ({ tmp, work, wtPath } = await createSubmoduleWorktreeRepo("rules/agent-rules-v6.95.0"));
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("precondition: git itself refuses a plain remove of this worktree", () => {
    const plain = spawnSync("git", ["worktree", "remove", wtPath], { cwd: work, encoding: "utf8" });
    assert.notEqual(plain.status, 0);
    assert.match(plain.stderr, /working trees containing submodules cannot be moved or removed/);
  });

  it("--exec removes the clean submodule worktree and its branch, saying why --force was needed", () => {
    const result = run(pruneRules, work, ["--exec"]);
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /worktree remove --force .*contains a submodule/);
    assert.doesNotMatch(git(work, "worktree list"), /rules-wt/);
    assert.equal(git(work, "branch --list rules/agent-rules-v6.95.0"), "");
  });
});

describe("prune-rules-lane: worktree with a dirty submodule is skipped, never forced (#2840)", () => {
  let tmp, work, wtPath;

  before(async () => {
    ({ tmp, work, wtPath } = await createSubmoduleWorktreeRepo("rules/agent-rules-v6.96.0"));
    await fs.writeFile(path.join(wtPath, "sub", "uncommitted.txt"), "work in progress\n");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("--exec skips it, keeps the worktree, its branch and the submodule file", async () => {
    const result = run(pruneRules, work, ["--exec"]);
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /dirty worktree/i);
    assert.doesNotMatch(result.stdout, /worktree remove --force/);
    assert.match(git(work, "worktree list"), /rules-wt/);
    assert.match(git(work, "branch --list rules/agent-rules-v6.96.0"), /rules\/agent-rules-v6\.96\.0/);
    await fs.access(path.join(wtPath, "sub", "uncommitted.txt"));
  });
});

describe("prune-rules-lane: dirty submodule hidden by submodule.<name>.ignore=all is still never forced (#2840)", () => {
  let tmp, work, wtPath;

  before(async () => {
    ({ tmp, work, wtPath } = await createSubmoduleWorktreeRepo("rules/agent-rules-v6.97.0", {
      ignoreSubmoduleChanges: true,
    }));
    await fs.writeFile(path.join(wtPath, "sub", "uncommitted.txt"), "work in progress\n");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("precondition: a plain git status cannot see the dirty submodule", () => {
    assert.equal(git(wtPath, "status --porcelain"), "");
    assert.match(git(wtPath, "status --porcelain --ignore-submodules=none"), /sub/);
  });

  it("--exec skips it, keeps the worktree, its branch and the submodule file", async () => {
    const result = run(pruneRules, work, ["--exec"]);
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /dirty worktree/i);
    assert.doesNotMatch(result.stdout, /worktree remove --force/);
    assert.match(git(work, "worktree list"), /rules-wt/);
    assert.match(git(work, "branch --list rules/agent-rules-v6.97.0"), /rules\/agent-rules-v6\.97\.0/);
    await fs.access(path.join(wtPath, "sub", "uncommitted.txt"));
  });
});

describe("prune-rules-lane: remote delete is leased to the classified tip", () => {
  let tmp, work, bare;

  before(async () => {
    ({ tmp, work, bare } = await createBaseRepo());
    git(work, "checkout -q -b rules/agent-rules-v6.95.0 main");
    await fs.writeFile(path.join(work, "rules3.txt"), "rules\n");
    git(work, "add .");
    git(work, 'commit -q -m "chore: sync devpro-agent-rules"');
    const tip = git(work, "rev-parse HEAD");
    git(work, "push -q -u origin rules/agent-rules-v6.95.0");
    git(work, "checkout -q main");
    git(work, `merge --ff-only ${tip}`);
    git(work, "push -q origin main");

    // Someone else advances the remote branch; this clone still holds the old origin/rules/* tip (no fetch).
    const other = path.join(tmp, "other");
    git(tmp, `clone -q "${bare}" other`);
    git(other, "config user.email o@e.x");
    git(other, "config user.name other");
    git(other, "checkout -q rules/agent-rules-v6.95.0");
    await fs.writeFile(path.join(other, "theirs.txt"), "new work\n");
    git(other, "add .");
    git(other, 'commit -q -m "theirs"');
    git(other, "push -q origin rules/agent-rules-v6.95.0");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("--include-remote --exec fetches first, so a remote branch another clone advanced is not deleted", () => {
    const remoteTipBefore = git(work, "ls-remote origin refs/heads/rules/agent-rules-v6.95.0");
    const result = run(pruneRules, work, ["--include-remote", "--exec"]);
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /origin\/rules\/agent-rules-v6\.95\.0: tip not ancestor of origin\/main/);
    assert.equal(
      git(work, "ls-remote origin refs/heads/rules/agent-rules-v6.95.0"),
      remoteTipBefore,
      "the remote branch (with the other actor's commit) must survive",
    );
  });

  it("the remote delete still leases on the classified tip (covers a push between fetch and delete)", async () => {
    const source = await fs.readFile(pruneRules, "utf8");
    assert.match(source, /\["push", `--force-with-lease=refs\/heads\/\$\{b\.name\}:\$\{b\.tip\}`, "origin", "--delete", b\.name\]/);
  });
});

describe("prune-rules-lane: release/rules-* needs tag + back-merge", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    git(work, "checkout -q -b release/rules-20260918 production");
    await fs.writeFile(path.join(work, "lane.txt"), "lane\n");
    git(work, "add .");
    git(work, 'commit -q -m "chore: rules lane"');
    const tip = git(work, "rev-parse HEAD");
    git(work, "checkout -q production");
    git(work, `merge --ff-only ${tip}`);
    git(work, "push -q origin production");
    git(work, `tag production-20260918-rules ${tip}`);
    // back-merge tag into main
    git(work, "checkout -q main");
    git(work, `merge --ff-only ${tip}`);
    git(work, "push -q origin main");
    git(work, "push -q origin --tags");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("lists release/rules-* when tag exists and is on main", () => {
    const result = run(pruneRules, work);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /release\/rules-20260918/);
  });
});

describe("prune-merged-local: no longer scans rules/* prefix", () => {
  it("source drops rules/ from scan prefixes", async () => {
    // The scan prefixes live in lib/prune-argv.mjs (shared with the batch-owner check).
    const src = await fs.readFile(pruneMerged, "utf8");
    assert.match(
      src,
      /const prefixes = PRUNE_BRANCH_PREFIXES;/,
      "prune-merged-local must scan the shared PRUNE_BRANCH_PREFIXES list",
    );
    const { PRUNE_BRANCH_PREFIXES } = await import("../lib/prune-argv.mjs");
    assert.deepEqual(
      [...PRUNE_BRANCH_PREFIXES],
      ["feature/", "bugfix/", "chore/", "hotfix/", "release/"],
      "prune-merged-local must drop rules/ from scan prefixes (owned by prune-rules-lane)",
    );
  });
});

describe("pre-push advisory lists prune-rules-lane", () => {
  it("advisory text includes prune-rules-lane.mjs --include-remote --exec", async () => {
    const src = await fs.readFile(
      path.join(REPO_ROOT, ".devpro", "scripts", "hooks-git", "pre-push.mjs"),
      "utf8",
    );
    assert.match(src, /prune-rules-lane\.mjs --include-remote --exec/);
  });
});
