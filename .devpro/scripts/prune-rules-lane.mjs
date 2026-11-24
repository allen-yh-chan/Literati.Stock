#!/usr/bin/env node
/**
 * prune-rules-lane.mjs
 *
 * Dedicated cleanup for consumer Rules Lane products. Dry-run by default.
 *
 * Scope (only):
 *   - rules/*            (typically rules/agent-rules-vX.Y.Z)
 *   - release/rules-*    (release/rules-YYYYMMDD[-n])
 *
 * Eligibility:
 *   - rules/*: tip is ancestor of origin/main
 *   - release/rules-YYYYMMDD[-n]: tip is ancestor of production
 *     AND matching production-YYYYMMDD-rules[-n] tag exists
 *     AND that tag tip is ancestor of origin/main
 *
 * Dirty linked worktrees (non-empty `git status --porcelain --ignore-submodules=none --untracked-files=normal`,
 * which also reports a dirty submodule whatever `submodule.<name>.ignore` says) are
 * skipped. A plain `git worktree remove` is tried first; the only time `--force` is
 * used is when git refuses a plain remove solely because the worktree contains an
 * initialised submodule (every rules lane worktree does, after
 * `git submodule update --init`), and the worktree is re-verified clean right before
 * that retry.
 *
 * Refs are refreshed with `git fetch --prune` first; when that fails the dry-run still
 * reports (from possibly stale refs) and --exec is refused. Branches on the shared keep
 * list (<common git dir>/info/deletable-keep, written by prune-merged-local.mjs --keep) are skipped.
 *
 * Usage:
 *   node .devpro/scripts/prune-rules-lane.mjs
 *   node .devpro/scripts/prune-rules-lane.mjs --exec
 *   node .devpro/scripts/prune-rules-lane.mjs --include-remote --exec
 */

import { execFileSync } from "node:child_process";
import process from "node:process";
import { advisoryBranchArg, SUBMODULE_REMOVE_REFUSAL_RE } from "./lib/prune-argv.mjs";
import { KEEP_LIST_GIT_DIR_ARGV, readKeepListAt } from "./lib/prune-keep-list.mjs";

const RELEASE_RULES_RE = /^release\/rules-(\d{8})(?:-(\d+))?$/;
const RULES_NOT_MERGED_REASON = "tip not ancestor of origin/main (rules PR not merged)";

function printUsage() {
  console.error("Usage: node .devpro/scripts/prune-rules-lane.mjs [--exec] [--include-remote]");
  console.error("Dry-run is the default. Scopes only rules/* and release/rules-*.");
  console.error("--include-remote requires --exec.");
}

function parseArgs(args) {
  const options = { exec: false, includeRemote: false };
  for (const arg of args) {
    if (arg === "--exec") {
      options.exec = true;
      continue;
    }
    if (arg === "--include-remote") {
      options.includeRemote = true;
      continue;
    }
    if (arg === "--dry-run") {
      console.error("Unsupported option: --dry-run");
      console.error("Dry-run is the default no-argument mode.");
      printUsage();
      process.exit(1);
    }
    console.error(`Unknown option: ${arg}`);
    printUsage();
    process.exit(1);
  }
  if (options.includeRemote && !options.exec) {
    console.error("--include-remote requires --exec");
    printUsage();
    process.exit(1);
  }
  return options;
}

function execResult(file, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(file, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
      }),
      stderr: "",
    };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err.stdout || ""),
      stderr: String(err.stderr || ""),
      status: err.status ?? null,
      error: err.message,
    };
  }
}

function git(args, options = {}) {
  return execResult("git", args, options);
}

function productionRef() {
  if (git(["rev-parse", "--verify", "origin/production"]).ok) return "origin/production";
  if (git(["rev-parse", "--verify", "production"]).ok) return "production";
  return null;
}

function mainlineRef() {
  return git(["rev-parse", "--verify", "origin/main"]).ok ? "origin/main" : null;
}

function isAncestor(tip, ref) {
  if (!tip || !ref) return false;
  return git(["merge-base", "--is-ancestor", tip, ref]).ok;
}

function tipOf(ref) {
  const result = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  return result.ok ? result.stdout.trim() : null;
}

function matchingRulesTag(branchName) {
  const match = RELEASE_RULES_RE.exec(branchName);
  if (!match) return null;
  const [, ymd, n] = match;
  return n ? `production-${ymd}-rules-${n}` : `production-${ymd}-rules`;
}

function listLocalBranches() {
  const result = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((name) => name.startsWith("rules/") || RELEASE_RULES_RE.test(name));
}

function listRemoteBranches() {
  const result = git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"]);
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((name) => (name.startsWith("origin/") ? name.slice("origin/".length) : name))
    .filter((name) => name !== "HEAD")
    .filter((name) => name.startsWith("rules/") || RELEASE_RULES_RE.test(name));
}

function linkedWorktrees() {
  const result = git(["worktree", "list", "--porcelain"]);
  if (!result.ok) return [];
  const entries = [];
  let current = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null, bare: false };
      continue;
    }
    if (!current) continue;
    if (line === "bare") current.bare = true;
    if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  if (current) entries.push(current);
  return entries.filter((wt) => wt.branch && !wt.bare);
}

// `--ignore-submodules=none` overrides `submodule.<name>.ignore` (.gitmodules / config),
// which would otherwise hide a dirty submodule: this check is the only thing standing
// between a submodule worktree and `git worktree remove --force`. `--untracked-files=normal`
// overrides status.showUntrackedFiles=no, which would otherwise hide untracked files.
function isDirtyWorktree(wtPath) {
  const result = git(["status", "--porcelain", "--ignore-submodules=none", "--untracked-files=normal"], { cwd: wtPath });
  if (!result.ok) return true;
  return result.stdout.trim().length > 0;
}

function classifyBranch(name, tip, { mainline, production }) {
  if (name.startsWith("rules/")) {
    if (!mainline) {
      return { eligible: false, reason: "origin/main unavailable" };
    }
    if (!isAncestor(tip, mainline)) {
      return { eligible: false, reason: RULES_NOT_MERGED_REASON };
    }
    return { eligible: true, reason: "rules tip ⊂ origin/main" };
  }

  if (RELEASE_RULES_RE.test(name)) {
    if (!production) {
      return { eligible: false, reason: "production ref unavailable" };
    }
    if (!isAncestor(tip, production)) {
      return { eligible: false, reason: "tip not ancestor of production" };
    }
    const tag = matchingRulesTag(name);
    const tagTip = tipOf(tag);
    if (!tagTip) {
      return { eligible: false, reason: `missing tag ${tag}` };
    }
    if (!mainline) {
      return { eligible: false, reason: "origin/main unavailable (cannot verify tag back-merge)" };
    }
    if (!isAncestor(tagTip, mainline)) {
      return { eligible: false, reason: `tag ${tag} not ancestor of origin/main (back-merge incomplete)` };
    }
    return { eligible: true, reason: `release/rules tip ⊂ production; ${tag} ⊂ origin/main` };
  }

  return { eligible: false, reason: "out of rules-lane scope" };
}

// Ineligible is not a dead end: name the next step for each kind.
function printIneligibleNextSteps(ineligible) {
  const shortNames = (filter) => [...new Set(ineligible.filter(filter).map((b) => b.name.replace(/^origin\//, "")))];
  const unmergedRules = shortNames((b) => b.reason === RULES_NOT_MERGED_REASON);
  const pendingReleaseRules = shortNames((b) => RELEASE_RULES_RE.test(b.name.replace(/^origin\//, "")));
  if (unmergedRules.length > 0) {
    console.log("\nNext step for rules/* not merged into origin/main:");
    console.log("  if its PR is still open, keep it; if it is abandoned, delete it by name (local + origin, OID lease):");
    for (const name of unmergedRules) {
      const arg = advisoryBranchArg(name);
      console.log(arg === null
        ? `  - ${name}: the name has shell-special characters; quote it for your shell and run prune-merged-local.mjs --force-delete <that branch> --include-remote`
        : `  node .devpro/scripts/prune-merged-local.mjs --force-delete ${arg} --include-remote`);
    }
    console.log("  Commits only on that branch are lost on both sides; run it only for a branch the user named.");
    console.log("  NOTE: --force-delete also removes the branch's linked worktree; it refuses one with uncommitted or untracked changes (commit, stash or remove them first).");
  }
  if (pendingReleaseRules.length > 0) {
    console.log("\nrelease/rules-* not yet eligible: in flight until production, its tag and the back-merge complete;");
    console.log("  an abandoned one is intentionally retained (git-branch-hygiene.md).");
  }
}

function currentBranch() {
  const result = git(["branch", "--show-current"]);
  return result.ok ? result.stdout.trim() : "";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  // Classify against current origin state: a stale origin/main hides merged rules branches,
  // and stale remote-tracking refs list branches that are already gone.
  const fetch = git(["fetch", "--prune"]);
  if (!fetch.ok) {
    const reason = (fetch.stderr || fetch.error || "unknown failure").trim().split("\n")[0];
    console.log(`⚠️  git fetch --prune failed; refs may be stale: ${reason}`);
    if (options.exec) {
      console.error("Refusing --exec because git fetch --prune failed; nothing deleted. Rerun after fetch succeeds.");
      process.exit(1);
    }
  }
  const mainline = mainlineRef();
  const production = productionRef();
  const current = currentBranch();
  const gitDir = git([...KEEP_LIST_GIT_DIR_ARGV]).stdout.trim() || ".git";
  const keep = readKeepListAt(gitDir);
  const kept = new Set();
  const notKept = (name) => {
    if (!keep.has(name)) return true;
    kept.add(name);
    return false;
  };

  const localNames = listLocalBranches().filter(notKept);
  const remoteNames = listRemoteBranches().filter(notKept);
  const worktrees = linkedWorktrees().filter(
    (wt) => (wt.branch.startsWith("rules/") || RELEASE_RULES_RE.test(wt.branch)) && notKept(wt.branch),
  );

  const eligibleLocal = [];
  const ineligibleLocal = [];
  for (const name of localNames) {
    if (name === current) {
      ineligibleLocal.push({ name, reason: "current checked-out branch" });
      continue;
    }
    const tip = tipOf(name);
    if (!tip) {
      ineligibleLocal.push({ name, reason: "unresolvable tip" });
      continue;
    }
    const verdict = classifyBranch(name, tip, { mainline, production });
    if (verdict.eligible) eligibleLocal.push({ name, tip, reason: verdict.reason });
    else ineligibleLocal.push({ name, reason: verdict.reason });
  }

  const eligibleRemote = [];
  const ineligibleRemote = [];
  for (const name of remoteNames) {
    const tip = tipOf(`origin/${name}`);
    if (!tip) {
      ineligibleRemote.push({ name: `origin/${name}`, reason: "unresolvable tip" });
      continue;
    }
    const verdict = classifyBranch(name, tip, { mainline, production });
    if (verdict.eligible) eligibleRemote.push({ name, tip, reason: verdict.reason });
    else ineligibleRemote.push({ name: `origin/${name}`, reason: verdict.reason });
  }

  const eligibleWorktrees = [];
  const skippedDirty = [];
  for (const wt of worktrees) {
    const tip = tipOf(wt.branch);
    if (!tip) continue;
    const verdict = classifyBranch(wt.branch, tip, { mainline, production });
    if (!verdict.eligible) continue;
    if (isDirtyWorktree(wt.path)) {
      skippedDirty.push({ path: wt.path, branch: wt.branch, reason: "dirty worktree (porcelain non-empty)" });
      continue;
    }
    eligibleWorktrees.push({ path: wt.path, branch: wt.branch, tip, reason: verdict.reason });
  }

  // If a branch has a dirty worktree, do not delete the branch either.
  const dirtyBranches = new Set(skippedDirty.map((d) => d.branch));
  const deletableLocal = eligibleLocal.filter((b) => !dirtyBranches.has(b.name));
  const blockedByDirty = eligibleLocal.filter((b) => dirtyBranches.has(b.name));

  console.log("prune-rules-lane — Rules Lane product cleanup");
  console.log(`mode: ${options.exec ? (options.includeRemote ? "exec+remote" : "exec") : "DRY-RUN ONLY"}`);
  console.log(`mainline-ref: ${mainline ?? "unavailable"}`);
  console.log(`production-ref: ${production ?? "unavailable"}`);
  if (kept.size > 0) console.log(`（${kept.size} 條分支在 keep 清單中被跳過：${[...kept].sort().join(", ")}）`);
  console.log("");

  console.log(`Eligible local (${deletableLocal.length}):`);
  if (deletableLocal.length === 0) console.log("  (none)");
  for (const b of deletableLocal) {
    console.log(`  - ${b.name}  [${b.reason}]`);
  }

  console.log(`\nEligible worktrees (${eligibleWorktrees.length}):`);
  if (eligibleWorktrees.length === 0) console.log("  (none)");
  for (const wt of eligibleWorktrees) {
    console.log(`  - ${wt.path}  (${wt.branch})  [${wt.reason}]`);
  }

  if (skippedDirty.length > 0 || blockedByDirty.length > 0) {
    console.log(`\nSkipped dirty (${skippedDirty.length} worktree(s), ${blockedByDirty.length} branch(es) blocked):`);
    for (const d of skippedDirty) {
      console.log(`  - ${d.path} (${d.branch}): ${d.reason}`);
    }
    for (const b of blockedByDirty) {
      console.log(`  - branch ${b.name}: blocked by dirty linked worktree`);
    }
  }

  console.log(`\nIneligible local (${ineligibleLocal.length}):`);
  if (ineligibleLocal.length === 0) console.log("  (none)");
  for (const b of ineligibleLocal) {
    console.log(`  - ${b.name}: ${b.reason}`);
  }

  if (options.includeRemote || !options.exec) {
    console.log(`\nEligible remote (${eligibleRemote.length}):`);
    if (eligibleRemote.length === 0) console.log("  (none)");
    for (const b of eligibleRemote) {
      console.log(`  - origin/${b.name}  [${b.reason}]`);
    }
    if (ineligibleRemote.length > 0) {
      console.log(`\nIneligible remote (${ineligibleRemote.length}):`);
      for (const b of ineligibleRemote) {
        console.log(`  - ${b.name}: ${b.reason}`);
      }
    }
  }

  printIneligibleNextSteps([...ineligibleLocal, ...ineligibleRemote]);

  if (!options.exec && !fetch.ok) {
    console.log("\nNo deletions performed (dry-run). --exec is refused until git fetch --prune succeeds.");
    return;
  }
  if (!options.exec) {
    console.log("\nNo deletions performed (dry-run). After consent:");
    console.log("  node .devpro/scripts/prune-rules-lane.mjs --exec");
    if (eligibleRemote.length > 0) {
      console.log("  node .devpro/scripts/prune-rules-lane.mjs --include-remote --exec");
    }
    return;
  }

  for (const wt of eligibleWorktrees) {
    console.log(`\n  ▶ executing: git worktree remove ${wt.path}`);
    let result = git(["worktree", "remove", wt.path]);
    if (!result.ok && SUBMODULE_REMOVE_REFUSAL_RE.test(result.stderr)) {
      // git only allows removing a worktree that contains a submodule with --force.
      // The dirty check above already passed; repeat it immediately before forcing
      // so a change made since then is never discarded.
      if (isDirtyWorktree(wt.path)) {
        console.error(`mutation skipped for worktree ${wt.path}: became dirty before the submodule-aware remove`);
        process.exitCode = 1;
        return;
      }
      console.log(`  ▶ executing: git worktree remove --force ${wt.path}  (clean; git refuses a plain remove because it contains a submodule)`);
      result = git(["worktree", "remove", "--force", wt.path]);
    }
    if (!result.ok) {
      console.error(`mutation failed for worktree ${wt.path}: ${result.stderr || result.error}`);
      process.exitCode = 1;
      return;
    }
  }

  for (const b of deletableLocal) {
    console.log(`\n  ▶ executing: git branch -D ${b.name}`);
    const result = git(["branch", "-D", b.name]);
    if (!result.ok) {
      console.error(`mutation failed for ${b.name}: ${result.stderr || result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  已刪除：${b.name}`);
  }

  if (options.includeRemote) {
    for (const b of eligibleRemote) {
      console.log(`\n  ▶ executing: git push --force-with-lease=refs/heads/${b.name}:${b.tip} origin --delete ${b.name}`);
      try {
        // The lease pins the tip this run classified (cached origin/<name>); if someone advanced the remote branch since the last
        // fetch, the delete is rejected instead of discarding their commits.
        execFileSync("git", ["push", `--force-with-lease=refs/heads/${b.name}:${b.tip}`, "origin", "--delete", b.name], {
          stdio: "inherit",
          env: { ...process.env, DEVPRO_PRUNE_REMOTE_DELETE: "1" },
        });
      } catch (err) {
        console.error(`mutation failed for origin/${b.name}: ${err.message}`);
        process.exitCode = 1;
        return;
      }
    }
  } else if (eligibleRemote.length > 0) {
    console.log(`\nSkipped ${eligibleRemote.length} remote candidate(s) (pass --include-remote --exec).`);
  }

  if (
    deletableLocal.length === 0 &&
    eligibleWorktrees.length === 0 &&
    !(options.includeRemote && eligibleRemote.length > 0)
  ) {
    console.log("\nno candidates");
  }
}

main();
