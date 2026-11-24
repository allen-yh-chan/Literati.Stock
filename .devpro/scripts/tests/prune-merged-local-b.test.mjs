import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync, execFileSync } from "node:child_process";
import { promises as fs, cpSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const pruneScript = path.join(REPO_ROOT, ".devpro", "scripts", "prune-merged-local.mjs");

// Split the argument string here instead of handing it to a shell: cmd.exe does not treat single quotes
// as quoting, so `commit -m 'release commit'` reaches Git as different arguments there.
const splitGitArgs = (args) =>
  (args.match(/'[^']*'|"[^"]*"|\S+/g) || []).map((token) => (/^(['"])[\s\S]*\1$/.test(token) ? token.slice(1, -1) : token));

function git(cwd, args) {
  return execFileSync("git", splitGitArgs(args), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** One-shot git init + bare remote bootstrap (built once per test file). */
async function buildBaseRepoTemplate() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "prune-local-template-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");

  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  await fs.writeFile(path.join(work, "a.txt"), "init\n");
  git(work, "add .");
  git(work, "commit -q -m 'init'");

  execSync(`git init -q --bare "${bare}"`);
  git(work, `remote add origin "${bare}"`);
  git(work, "push -q origin main");

  return { tmp, work, bare };
}

let baseRepoTemplatePromise;

async function ensureBaseRepoTemplate() {
  if (!baseRepoTemplatePromise) {
    baseRepoTemplatePromise = buildBaseRepoTemplate();
  }
  return baseRepoTemplatePromise;
}

/** Fresh bare remote + work repo cloned from the shared template (fast fs copy). */
async function createBaseRepo() {
  const template = await ensureBaseRepoTemplate();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "prune-local-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");

  cpSync(template.bare, bare, { recursive: true });
  cpSync(template.work, work, { recursive: true });
  git(work, `remote set-url origin "${bare}"`);

  return { tmp, work, bare };
}

// ─── Scenario 0: dry-run CLI contract ─────────────────────────────────────

// ─── Scenario N: --force-delete accepts rules/* prefix ───────────────────────

describe("prune-merged-local: --force-delete accepts rules/* prefix", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    // rules/agent-rules-v0.1.0: never merged, abandoned
    git(work, "checkout -q -b rules/agent-rules-v0.1.0");
    await fs.writeFile(path.join(work, "abandoned-rules.txt"), "x\n");
    git(work, "add .");
    git(work, "commit -q -m 'wip'");
    git(work, "checkout -q main");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("deletes valid abandoned rules/ branch", () => {
    const r = spawnSync("node", [pruneScript, "--force-delete", "rules/agent-rules-v0.1.0"], { cwd: work, encoding: "utf8" });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /rules\/agent-rules-v0\.1\.0/);
    assert.match(r.stdout, /已刪除：rules\/agent-rules-v0\.1\.0/);
    const localList = git(work, "branch --list rules/agent-rules-v0.1.0");
    assert.equal(localList, "", "rules/agent-rules-v0.1.0 should be deleted");
  });
});

// ─── Scenario O: --exec preplans -D for production-only-merged branches ────

describe("prune-merged-local: --exec preplans -D for branches merged into production but not current", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // hotfix/prod-only reaches production (merged --no-ff) but not main, so
    // `git branch -d hotfix/prod-only` from main would fail with not-fully-merged.
    git(work, "checkout -q -b hotfix/prod-only");
    await fs.writeFile(path.join(work, "hotfix-only.txt"), "hotfix\n");
    git(work, "add .");
    git(work, "commit -q -m 'hotfix commit'");

    // release/v1.0.0 follows the release lifecycle: merged into production and
    // tagged, but Step 6A has not merged the tag back into main yet.
    git(work, "checkout -q main");
    git(work, "checkout -q -b release/v1.0.0");
    await fs.writeFile(path.join(work, "release-only.txt"), "release\n");
    git(work, "add .");
    git(work, "commit -q -m 'release commit'");
    git(work, "push -q -u origin release/v1.0.0");

    git(work, "checkout -q main");
    git(work, "checkout -q -b production");
    git(work, "merge -q --no-ff hotfix/prod-only -m 'Merge hotfix/prod-only into production'");
    git(work, "merge -q --no-ff release/v1.0.0 -m 'Merge release/v1.0.0 into production'");
    git(work, "tag production-v1.0.0");

    git(work, "checkout -q main");
    git(work, "push -q origin main");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("--exec deletes hotfix/prod-only via a read-only preplanned -D (ancestor of production verified)", () => {
    const result = spawnSync("node", [pruneScript, "--exec"], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /executing: git branch -D hotfix\/prod-only/);
    assert.doesNotMatch(result.stdout, /-d refused|git branch -d hotfix\/prod-only/);
    assert.equal(git(work, "branch --list hotfix/prod-only"), "", "hotfix/prod-only must be deleted by the preplanned -D path");
  });

  it("--exec keeps release/v1.0.0 until its production tag is merged back into origin/main", () => {
    const result = spawnSync("node", [pruneScript, "--exec"], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /kept until Step 6A[\s\S]*release\/v1\.0\.0/);
    assert.doesNotMatch(result.stdout, /git branch -[dD] release\/v1\.0\.0/);
    assert.match(git(work, "branch --list release/v1.0.0"), /release\/v1\.0\.0/);
  });
});

// ─── Scenario P: stale local production vs fresh origin/production ──────────
//
// Repro: after `gh pr merge release/* → production`, origin/production advances
// but local `production` branch is NOT updated by `git fetch --prune` (only
// remote-tracking refs/remotes/origin/production updates). If script compares
// via local `production`, it misses freshly-merged branches. Fix: prefer
// `origin/production` (refreshed by step 1 fetch) for ancestor checks.
// 2026-05-11 live repro evidence: v6.42.1 release prune first reported "no
// branches eligible" even though 5 branches were ancestor of origin/production.

describe("prune-merged-local: stale local production vs fresh origin/production", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    // Build production branch baseline + push
    git(work, "checkout -q -b production");
    const baselineTip = git(work, "rev-parse production");
    git(work, "push -q -u origin production");
    git(work, "checkout -q main");
    // Branch a chore, merge into production locally + push, simulating
    // a release merge that advances origin/production
    git(work, "checkout -q -b chore/ship-via-prod");
    await fs.writeFile(path.join(work, "ship.txt"), "shipped\n");
    git(work, "add .");
    git(work, "commit -q -m 'chore: ship'");
    git(work, "push -q -u origin chore/ship-via-prod");
    git(work, "checkout -q production");
    git(work, "merge -q --no-ff chore/ship-via-prod -m 'Merge chore/ship-via-prod into production'");
    git(work, "push -q origin production");
    // CRITICAL: roll local production BACK to baseline to simulate the
    // "post-fetch-prune but pre-manual-ff" stale window. origin/production
    // remains advanced (verified by `git rev-parse origin/production`).
    git(work, `update-ref refs/heads/production ${baselineTip}`);
    git(work, "checkout -q main");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("detects chore/ship-via-prod as eligible via origin/production (not stale local production)", () => {
    // Sanity: confirm local production is genuinely stale before running script
    const localProdTip = git(work, "rev-parse production");
    const remoteProdTip = git(work, "rev-parse origin/production");
    assert.notEqual(localProdTip, remoteProdTip,
      "fixture must put local production STRICTLY behind origin/production");

    const result = spawnSync("node", [pruneScript, "--exec"], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // Eligibility must surface chore/ship-via-prod (was ancestor of
    // origin/production; would be missed if script compared local production)
    assert.match(result.stdout, /chore\/ship-via-prod/,
      "branch ancestor of origin/production must be listed even when local production is stale");
    const localList = git(work, "branch --list chore/ship-via-prod");
    assert.equal(localList, "",
      "stale-local-production must NOT block deletion when origin/production proves ancestor");
  });
});

// ─── Scenario Q: grep-based assertion — productionRef helper exists ─────────
//
// Mechanical guard against future regression: script must use the
// origin-preferred ref via a `productionRef()` helper, not hard-code the
// literal "production" string in is-ancestor / rev-parse comparisons.

describe("prune-merged-local: source-level guard against literal 'production' regression", () => {
  it("uses productionRef() helper in is-ancestor and rev-parse --verify calls", async () => {
    const src = await fs.readFile(pruneScript, "utf8");
    assert.match(src, /function productionRef\(\)/,
      "productionRef() helper must exist (preferred=origin/production, fallback=local production)");
    assert.match(src, /execResult\('git', \['merge-base', '--is-ancestor', tip, productionRef\(\)\]\)\.ok/,
      "is-ancestor argv must call productionRef() (not literal 'production')");
    assert.match(src, /execResult\('git', \['rev-parse', '--verify', productionRef\(\)\]\)/,
      "rev-parse --verify must call productionRef() through exact argv (not a shell string or literal 'production')");
  });
});

// ─── Scenario Q2: rules branch/worktree follows same production rule ───────

describe("prune-merged-local: rules/* no longer in scan (owned by prune-rules-lane)", () => {
  let tmp, work, shippedWtPath;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    const initial = git(work, "rev-parse HEAD");
    git(work, `branch -f production ${initial}`);

    git(work, "checkout -q -b rules/agent-rules-v6.61.1 main");
    await fs.writeFile(path.join(work, "rules.txt"), "rules sync\n");
    git(work, "add .");
    git(work, "commit -q -m 'chore: sync devpro-agent-rules'");
    const rulesTip = git(work, "rev-parse HEAD");
    git(work, "checkout -q main");

    shippedWtPath = path.join(tmp, "rules-worktree");
    git(work, `worktree add "${shippedWtPath}" rules/agent-rules-v6.61.1`);
    git(work, `merge --ff-only ${rulesTip}`);
    git(work, `branch -f production ${rulesTip}`);

    git(work, "checkout -q -b rules/main-only main");
    await fs.writeFile(path.join(work, "rules-main-only.txt"), "rules main only\n");
    git(work, "add .");
    git(work, "commit -q -m 'chore: sync devpro-agent-rules'");
    const mainOnlyTip = git(work, "rev-parse HEAD");
    git(work, "checkout -q main");
    git(work, `merge --ff-only ${mainOnlyTip}`);

    git(work, "checkout -q -b feature/main-only main");
    await fs.writeFile(path.join(work, "feature.txt"), "feature\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: main only'");
    const featureTip = git(work, "rev-parse HEAD");
    git(work, "checkout -q main");
    git(work, `merge --ff-only ${featureTip}`);
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not list rules/* as shipped/unshipped candidates (owned by prune-rules-lane)", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /DRY-RUN ONLY/);
    // Candidate sections only — orphan/force-delete advisory may still name abandoned refs.
    const orphanIdx = result.stdout.search(/orphaned|untracked local-only|force-delete/i);
    const beforeAdvisory = orphanIdx === -1 ? result.stdout : result.stdout.slice(0, orphanIdx);
    assert.doesNotMatch(beforeAdvisory, /rules\/agent-rules-v6\.61\.1/,
      "rules/* owned by prune-rules-lane; must not appear in shipped/unshipped candidate sections");
    assert.doesNotMatch(beforeAdvisory, /rules\/main-only/);
    assert.doesNotMatch(beforeAdvisory, new RegExp(shippedWtPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

// ─── Scenario Q3: --exec force-removes worktrees that contain submodules ────

describe("prune-merged-local: --exec handles linked worktree containing submodule", () => {
  let tmp, work, wtPath;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    const sub = path.join(tmp, "submodule-source");
    await fs.mkdir(sub);
    git(sub, "init -q -b main");
    git(sub, "config user.email t@e.x");
    git(sub, "config user.name test");
    await fs.writeFile(path.join(sub, "sub.txt"), "submodule\n");
    git(sub, "add .");
    git(sub, "commit -q -m 'submodule seed'");

    git(work, "checkout -q -b feature/submodule-shipped main");
    execSync(`git -c protocol.file.allow=always submodule add "${sub}" vendor/submodule`, {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
    });
    git(work, "add .gitmodules vendor/submodule");
    git(work, "commit -q -m 'feat: add submodule'");
    git(work, "checkout -q main");
    git(work, "merge -q --no-ff feature/submodule-shipped -m 'merge feature/submodule-shipped'");
    git(work, "branch -f production");

    wtPath = path.join(tmp, "submodule-worktree");
    git(work, `worktree add "${wtPath}" feature/submodule-shipped`);
    execSync("git -c protocol.file.allow=always submodule update --init --recursive", {
      cwd: wtPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("--exec removes the clean submodule-containing worktree with --force only after git refuses the plain remove", () => {
    const result = spawnSync("node", [pruneScript, "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /executing: git (?:-c core.longpaths=true )?worktree remove (?!--force)/);
    assert.match(result.stdout, /executing: git (?:-c core.longpaths=true )?worktree remove --force .*contains a submodule/);
    assert.match(result.stdout, /submodule-worktree/);
    assert.equal(git(work, "branch --list feature/submodule-shipped"), "");
    assert.doesNotMatch(git(work, "worktree list --porcelain"), /submodule-worktree/);
  });
});

// ─── Scenario Q4: --force-delete removes linked worktree before branch -D ───

describe("prune-merged-local: --force-delete removes linked worktree first", () => {
  let tmp, work, wtPath;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    git(work, "checkout -q -b bugfix/linked-force-delete main");
    await fs.writeFile(path.join(work, "force-delete.txt"), "abandoned\n");
    git(work, "add .");
    git(work, "commit -q -m 'wip: abandoned linked branch'");
    git(work, "checkout -q main");

    wtPath = path.join(tmp, "force-delete-worktree");
    git(work, `worktree add "${wtPath}" bugfix/linked-force-delete`);
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("removes the clean linked worktree without --force, then deletes the branch", () => {
    const result = spawnSync("node", [pruneScript, "--force-delete", "bugfix/linked-force-delete"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /linked worktree:/);
    assert.match(result.stdout, /executing: git (?:-c core.longpaths=true )?worktree remove (?!--force)/);
    assert.doesNotMatch(result.stdout, /worktree remove --force/);
    assert.match(result.stdout, /git branch -D bugfix\/linked-force-delete/);
    assert.equal(git(work, "branch --list bugfix/linked-force-delete"), "");
    assert.doesNotMatch(git(work, "worktree list --porcelain"), /force-delete-worktree/);
  });
});

// ─── Scenario R: --include-subsumed cleans squash-source WIP branches ───────

describe("prune-merged-local: --include-subsumed cleans patch-id-subsumed WIP branches", () => {
  let tmp, work, wtPath;
  const wipBranches = [
    "bugfix/wip-subsumed-a",
    "bugfix/wip-subsumed-b",
    "bugfix/wip-subsumed-c",
  ];

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    for (const [idx, branch] of wipBranches.entries()) {
      git(work, `checkout -q -b ${branch} main`);
      await fs.writeFile(path.join(work, `subsumed-${idx}.txt`), `subsumed ${idx}\n`);
      git(work, "add .");
      git(work, `commit -q -m 'wip: subsumed ${idx}'`);
      git(work, "checkout -q main");
    }

    wtPath = path.join(tmp, "wip-a-worktree");
    git(work, `worktree add "${wtPath}" ${wipBranches[0]}`);

    // Ship equivalent patches with different commit SHAs. This simulates a
    // force-pushed PR head that absorbed the old local WIP patch content.
    git(work, "checkout -q -b production main");
    for (const idx of [0, 1, 2]) {
      await fs.writeFile(path.join(work, `subsumed-${idx}.txt`), `subsumed ${idx}\n`);
      git(work, "add .");
      git(work, `commit -q -m 'ship: equivalent patch ${idx}'`);
    }

    // Negative control: a local branch with a patch absent from production.
    git(work, "checkout -q -b bugfix/wip-unshipped main");
    await fs.writeFile(path.join(work, "unshipped.txt"), "not shipped\n");
    git(work, "add .");
    git(work, "commit -q -m 'wip: not shipped'");
    git(work, "checkout -q main");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not list subsumed branches as deletion candidates by default", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // Without --include-subsumed, no branch carries the subsumed-by-squash label.
    assert.doesNotMatch(result.stdout, /subsumed-by-squash/);
    // The WIP branches are never-pushed, so they surface in the advisory
    // untracked-local-only block — but NOT as deletion candidates above it.
    const idx = result.stdout.search(/untracked local-only/i);
    const beforeAdvisory = idx === -1 ? result.stdout : result.stdout.slice(0, idx);
    assert.doesNotMatch(beforeAdvisory, /bugfix\/wip-subsumed-a/,
      "subsumed WIP branch must not be a deletion candidate without --include-subsumed");
  });

  it("--include-subsumed reports all three WIP branches and the linked worktree", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    for (const branch of wipBranches) {
      assert.match(result.stdout, new RegExp(branch.replace("/", "\\/")));
    }
    assert.match(result.stdout, /subsumed-by-squash/);
    assert.match(result.stdout, /--include-subsumed --exec/);
    assert.match(result.stdout, /wip-a-worktree/);
    assert.doesNotMatch(result.stdout, /bugfix\/wip-unshipped\s+\[subsumed-by-squash\]/);
  });

  it("--include-subsumed --exec removes worktree first, deletes subsumed branches, and keeps unshipped branch", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed", "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /executing: git (?:-c core.longpaths=true )?worktree remove (?!--force)/);
    assert.doesNotMatch(result.stdout, /worktree remove --force/);
    assert.match(result.stdout, /wip-a-worktree/);
    assert.match(result.stdout, /executing: git branch -D bugfix\/wip-subsumed-a/);
    assert.doesNotMatch(result.stdout, /-d refused/);
    for (const branch of wipBranches) {
      assert.equal(git(work, `branch --list ${branch}`), "", `${branch} should be deleted`);
    }
    assert.match(git(work, "branch --list bugfix/wip-unshipped"), /bugfix\/wip-unshipped/);
    const wtList = git(work, "worktree list --porcelain");
    assert.doesNotMatch(wtList, /wip-a-worktree/);
  });
});
