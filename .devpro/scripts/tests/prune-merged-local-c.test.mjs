import "./lib/portable-command-shims.cjs";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, promises as fs, cpSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { stripJsCommentSpans, JsCommentSpanScanError } from "../lib/js-comment-spans.mjs";

const pruneScript = path.join(REPO_ROOT, ".devpro", "scripts", "prune-merged-local.mjs");
const forceDeleteWorktreeWarningPattern = /--force-delete also removes the branch's linked worktree; it refuses one with uncommitted or untracked changes/i;
const staticGitArgv = new Map([
  ["add .", ["add", "."]],
  ["branch -f production", ["branch", "-f", "production"]],
  ["branch -m main mainline", ["branch", "-m", "main", "mainline"]],
  ["branch production main", ["branch", "production", "main"]],
  ["branch --set-upstream-to=origin/feature/was-pushed feature/was-pushed", ["branch", "--set-upstream-to=origin/feature/was-pushed", "feature/was-pushed"]],
  ["branch --list pr-1331-review", ["branch", "--list", "pr-1331-review"]],
  ["checkout -q main", ["checkout", "-q", "main"]],
  ["checkout -q -b production main", ["checkout", "-q", "-b", "production", "main"]],
  ["checkout -q -b feature/was-pushed", ["checkout", "-q", "-b", "feature/was-pushed"]],
  ["checkout -q -b pr-1331-review main", ["checkout", "-q", "-b", "pr-1331-review", "main"]],
  ["checkout -q -b pr-2222-review main", ["checkout", "-q", "-b", "pr-2222-review", "main"]],
  ["checkout -q -b pr-3333-review main", ["checkout", "-q", "-b", "pr-3333-review", "main"]],
  ["checkout -q -b pr-4444-review main", ["checkout", "-q", "-b", "pr-4444-review", "main"]],
  ["commit -q -m 'archive + unshipped'", ["commit", "-q", "-m", "archive + unshipped"]],
  ["commit -q -m 'archive some-change'", ["commit", "-q", "-m", "archive some-change"]],
  ["commit -q -m 'chore: never pushed unmerged'", ["commit", "-q", "-m", "chore: never pushed unmerged"]],
  ["commit -q -m 'chore: pushed no upstream'", ["commit", "-q", "-m", "chore: pushed no upstream"]],
  ["commit -q -m 'chore: pushed with upstream'", ["commit", "-q", "-m", "chore: pushed with upstream"]],
  ["commit -q -m 'chore: query failed would be contained'", ["commit", "-q", "-m", "chore: query failed would be contained"]],
  ["commit -q -m 'chore: would be contained'", ["commit", "-q", "-m", "chore: would be contained"]],
  ["commit -q -m 'feat: was-pushed'", ["commit", "-q", "-m", "feat: was-pushed"]],
  ["commit -q -m 'pr 2222 review'", ["commit", "-q", "-m", "pr 2222 review"]],
  ["commit -q -m 'pr 3333'", ["commit", "-q", "-m", "pr 3333"]],
  ["commit -q -m 'pr 4444'", ["commit", "-q", "-m", "pr 4444"]],
  ["commit -q -m 'pr review head'", ["commit", "-q", "-m", "pr review head"]],
  ["commit -q -m 'ship: archive + rule (combined)'", ["commit", "-q", "-m", "ship: archive + rule (combined)"]],
  ["commit -q -m 'ship: archive + rule combined'", ["commit", "-q", "-m", "ship: archive + rule combined"]],
  ["commit -q -m 'ship: archive + rule (combined → defeats patch-id)'", ["commit", "-q", "-m", "ship: archive + rule (combined → defeats patch-id)"]],
  ["commit -q -m 'ship: archive some-change + newer rule (combined commit)'", ["commit", "-q", "-m", "ship: archive some-change + newer rule (combined commit)"]],
  ["commit -q -m 'ship: equivalent remote patch'", ["commit", "-q", "-m", "ship: equivalent remote patch"]],
  ["commit -q -m 'wip: remote subsumed'", ["commit", "-q", "-m", "wip: remote subsumed"]],
  ["fetch -q --prune origin", ["fetch", "-q", "--prune", "origin"]],
  ["fetch -q origin", ["fetch", "-q", "origin"]],
  ["ls-remote --heads origin", ["ls-remote", "--heads", "origin"]],
  ["push -q origin --delete feature/was-pushed", ["push", "-q", "origin", "--delete", "feature/was-pushed"]],
  ["push -q origin feature/was-pushed", ["push", "-q", "origin", "feature/was-pushed"]],
  ["push -q origin main", ["push", "-q", "origin", "main"]],
  ["push -q origin production", ["push", "-q", "origin", "production"]],
  ["tag production-v1.0.0", ["tag", "production-v1.0.0"]],
  ["worktree list --porcelain", ["worktree", "list", "--porcelain"]],
]);

function git(cwd, args) {
  const argv = Array.isArray(args) ? args : staticGitArgv.get(args);
  assert.ok(argv, `git fixture command must use structured argv: ${args}`);
  return execFileSync("git", argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveExecutable(command) {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = entry.replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return realpathSync(candidate);
      } catch {
        // Keep searching PATH for an executable carrier.
      }
    }
  }
  throw new Error(`Cannot resolve executable from PATH: ${command}`);
}

/** One-shot git init + bare remote bootstrap (built once per test file). */
async function buildBaseRepoTemplate() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "prune-local-template-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");

  await fs.mkdir(work);
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "t@e.x"]);
  git(work, ["config", "user.name", "test"]);

  await fs.writeFile(path.join(work, "a.txt"), "init\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", "init"]);

  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(work, ["remote", "add", "origin", bare]);
  git(work, ["push", "-q", "origin", "main"]);

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
  git(work, ["remote", "set-url", "origin", bare]);

  return { tmp, work, bare };
}

// ─── Scenario 0: dry-run CLI contract ─────────────────────────────────────

// ─── Scenario N: --force-delete accepts rules/* prefix ───────────────────────

// ─── Scenario S: --include-subsumed cleans REMOTE squash-subsumed branches ───


describe("prune-merged-local: --include-subsumed cleans remote patch-id-subsumed branches", () => {
  let tmp, work, bare;
  const remoteBranch = "chore/remote-subsumed";

  before(async () => {
    ({ tmp, work, bare } = await createBaseRepo());

    // A remote branch whose commit patch will be shipped to production under a
    // DIFFERENT sha (squash-rewritten), so its tip is NOT an ancestor of
    // production but its patch id IS present in production history.
    git(work, ["checkout", "-q", "-b", remoteBranch, "main"]);
    await fs.writeFile(path.join(work, "remote-subsumed.txt"), "remote subsumed\n");
    git(work, "add .");
    git(work, "commit -q -m 'wip: remote subsumed'");
    git(work, ["push", "-q", "origin", remoteBranch]);
    git(work, "checkout -q main");
    // Drop the local copy so only the remote ref remains (mirrors the real orphan).
    git(work, ["branch", "-D", remoteBranch]);

    // Ship the equivalent patch to production under a different sha.
    git(work, "checkout -q -b production main");
    await fs.writeFile(path.join(work, "remote-subsumed.txt"), "remote subsumed\n");
    git(work, "add .");
    git(work, "commit -q -m 'ship: equivalent remote patch'");
    git(work, "push -q origin production");
    git(work, "checkout -q main");
    // refresh remote-tracking refs so origin/* is current
    git(work, "fetch -q origin");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not list the remote subsumed branch by default", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, new RegExp(remoteBranch.replace("/", "\\/")));
  });

  it("--include-subsumed reports the remote subsumed branch", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(remoteBranch.replace("/", "\\/")));
    assert.match(result.stdout, /subsumed-by-squash/);
  });

  it("--include-subsumed --exec skips the remote subsumed branch by default", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed", "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /executing: git push origin/);
    assert.match(result.stdout, /skipped 1 remote ref/);
    // remote ref must remain until remote deletion is explicitly opted in
    const remoteRefs = git(work, "ls-remote --heads origin");
    assert.match(remoteRefs, new RegExp(remoteBranch.replace("/", "\\/")));
  });

  it("--include-subsumed --include-remote --exec deletes the remote subsumed branch from origin", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed", "--include-remote", "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /executing: git push origin --force-with-lease=refs\/heads\/[^:\s]+:[0-9a-f]{40} :refs\/heads\//);
    const remoteRefs = git(work, "ls-remote --heads origin");
    assert.doesNotMatch(remoteRefs, new RegExp(remoteBranch.replace("/", "\\/")));
  });
});

// ─── Scenario T: --include-subsumed cleans archive-shipped branches (fail-closed) ──

describe("prune-merged-local: --include-subsumed archive-shipped tier", () => {
  let tmp, work;
  const archiveDir = "openspec/changes/archive/2026-06-29-some-change";
  const archiveOnly = "chore/archive-only-shipped";
  const archivePlusExtra = "chore/archive-plus-unshipped";

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // production ships the archive folder in a commit that ALSO touches another file,
    // so production's commit patch-id differs from a branch's pure-archive commit
    // (this is what defeats the patch-id tier and forces the archive-shipped tier).
    git(work, "checkout -q -b production main");
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped\n");
    await fs.writeFile(path.join(work, "rule.md"), "newer production rule\n");
    git(work, "add .");
    git(work, "commit -q -m 'ship: archive some-change + newer rule (combined commit)'");

    // archive-only branch: its entire delta vs merge-base is the byte-identical archive file.
    git(work, ["checkout", "-q", "-b", archiveOnly, "main"]);
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped\n");
    git(work, "add .");
    git(work, "commit -q -m 'archive some-change'");

    // archive-plus-extra branch: archive file + a non-archive unshipped file (MUST be kept).
    git(work, ["checkout", "-q", "-b", archivePlusExtra, "main"]);
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped\n");
    await fs.writeFile(path.join(work, "unshipped.md"), "real unshipped work\n");
    git(work, "add .");
    git(work, "commit -q -m 'archive + unshipped'");

    git(work, "checkout -q main");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not list archive-shipped branches by default", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /archive-shipped/);
  });

  it("--include-subsumed reports archive-only branch but NOT the archive+unshipped branch", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /archive-shipped/);
    assert.match(result.stdout, new RegExp(archiveOnly.replace("/", "\\/")));
    // fail-closed: the branch carrying extra unshipped work must NOT be a candidate
    assert.doesNotMatch(
      result.stdout,
      new RegExp(`${archivePlusExtra.replace("/", "\\/")}\\s+\\[archive-shipped\\]`),
    );
  });

  it("--include-subsumed --exec deletes archive-only branch and keeps archive+unshipped branch", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed", "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(git(work, ["branch", "--list", archiveOnly]), "", `${archiveOnly} should be deleted`);
    assert.match(
      git(work, ["branch", "--list", archivePlusExtra]),
      new RegExp(archivePlusExtra.replace("/", "\\/")),
      `${archivePlusExtra} must be kept (carries unshipped work)`,
    );
  });
});

// ── Regression (cross-model CRITICAL): never-pushed AND archive-shipped overlap ──
// chore/archive-only-shipped is never-pushed (no remote, no tracking) AND reaches
// the archive-shipped tier. It MUST be classified archive-shipped only (a deletion
// candidate with a production byte-identical backup), NOT double-listed in the
// advisory "untracked local-only" block — otherwise --exec deletes a ref the same
// run labels "NEVER auto-deleted", a self-contradiction that violates the contract.
// Isolated in its own suite (own before/after) so a prior --exec test cannot delete
// the fixture branch out from under it.

describe("prune-merged-local: archive-shipped + never-pushed overlap is not double-classified", () => {
  let tmp, work;
  const archiveDir = "openspec/changes/archive/2026-06-29-some-change";
  const archiveOnly = "chore/archive-only-shipped";

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // production ships the archive folder in a combined commit (defeats patch-id tier).
    git(work, "checkout -q -b production main");
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped\n");
    await fs.writeFile(path.join(work, "rule.md"), "newer production rule\n");
    git(work, "add .");
    git(work, "commit -q -m 'ship: archive + rule (combined)'");

    // never-pushed archive-only branch: entire delta is byte-identical archive content.
    git(work, ["checkout", "-q", "-b", archiveOnly, "main"]);
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped\n");
    git(work, "add .");
    git(work, "commit -q -m 'archive some-change'");
    git(work, "checkout -q main");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("reports it as archive-shipped, never in the untracked local-only advisory block", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // it IS reported as archive-shipped
    assert.match(result.stdout, /archive-shipped/);
    assert.match(result.stdout, new RegExp(archiveOnly.replace("/", "\\/")));
    // it must NOT appear in the untracked local-only advisory block
    const idx = result.stdout.search(/untracked local-only/i);
    if (idx !== -1) {
      const advisoryBlock = result.stdout.slice(idx);
      assert.doesNotMatch(
        advisoryBlock,
        new RegExp(archiveOnly.replace("/", "\\/")),
        "archive-shipped branch must not be double-listed in the advisory-only block",
      );
    }
  });

  it("--include-subsumed --exec deletes it as archive-shipped (advisory-only contract intact)", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed", "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // archive-shipped classification governs: the branch is deleted (it has a
    // production byte-identical backup); it was never in the untracked local-only
    // bucket, so no advisory-only ref was auto-deleted.
    assert.equal(
      git(work, ["branch", "--list", archiveOnly]),
      "",
      `${archiveOnly} should be deleted as archive-shipped`,
    );
  });
});

// ─── Scenario T2: archive-shipped LOCAL branch checked out in a linked worktree ──

describe("prune-merged-local: --include-subsumed --exec removes archive-shipped worktree first", () => {
  let tmp, work, wtPath;
  const archiveDir = "openspec/changes/archive/2026-06-29-some-change";
  const branch = "chore/archive-shipped-wt";

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    git(work, "checkout -q -b production main");
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped\n");
    await fs.writeFile(path.join(work, "rule.md"), "newer production rule\n");
    git(work, "add .");
    git(work, "commit -q -m 'ship: archive + rule (combined → defeats patch-id)'");

    git(work, ["checkout", "-q", "-b", branch, "main"]);
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped\n");
    git(work, "add .");
    git(work, "commit -q -m 'archive some-change'");
    git(work, "checkout -q main");

    // check the archive-shipped branch out in a linked worktree.
    wtPath = path.join(tmp, "archive-shipped-worktree");
    git(work, ["worktree", "add", wtPath, branch]);
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("removes the linked worktree before deleting the archive-shipped branch", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed", "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.equal(git(work, ["branch", "--list", branch]), "", `${branch} should be deleted`);
    assert.doesNotMatch(git(work, "worktree list --porcelain"), /archive-shipped-worktree/);
  });
});

// ─── Scenario T3: archive-shipped REMOTE branch ──────────────────────────────

describe("prune-merged-local: --include-subsumed cleans remote archive-shipped branch", () => {
  let tmp, work;
  const archiveDir = "openspec/changes/archive/2026-06-29-some-change";
  const remoteBranch = "chore/remote-archive-shipped";

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // remote branch introduces only the (byte-identical) archive folder.
    git(work, ["checkout", "-q", "-b", remoteBranch, "main"]);
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped\n");
    git(work, "add .");
    git(work, "commit -q -m 'archive some-change'");
    git(work, ["push", "-q", "origin", remoteBranch]);
    git(work, "checkout -q main");
    git(work, ["branch", "-D", remoteBranch]);

    // production ships the same archive content combined with another file
    // (so patch-id differs → forces the archive-shipped tier).
    git(work, "checkout -q -b production main");
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped\n");
    await fs.writeFile(path.join(work, "rule.md"), "newer rule\n");
    git(work, "add .");
    git(work, "commit -q -m 'ship: archive + rule combined'");
    git(work, "push -q origin production");
    git(work, "checkout -q main");
    git(work, "fetch -q origin");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("--include-subsumed reports the remote archive-shipped branch", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /archive-shipped/);
    assert.match(result.stdout, new RegExp(remoteBranch.replace("/", "\\/")));
  });

  it("--include-subsumed --exec skips the remote archive-shipped branch by default", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed", "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /executing: git push origin/);
    assert.match(result.stdout, /skipped 1 remote ref/);
    assert.match(git(work, "ls-remote --heads origin"), new RegExp(remoteBranch.replace("/", "\\/")));
  });

  it("--include-subsumed --include-remote --exec deletes the remote archive-shipped branch from origin", () => {
    const result = spawnSync("node", [pruneScript, "--include-subsumed", "--include-remote", "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /executing: git push origin --force-with-lease=refs\/heads\/[^:\s]+:[0-9a-f]{40} :refs\/heads\//);
    assert.doesNotMatch(git(work, "ls-remote --heads origin"), new RegExp(remoteBranch.replace("/", "\\/")));
  });
});

// ─── Scenario U: untracked local-only refs (never pushed) → advisory-only ────
// Complement of the orphan detector: a ref that was NEVER pushed and has no
// matching remote ref. It must surface in a distinct advisory block, never be
// auto-deleted by --exec, be distinguishable from `orphaned`, and respect the
// protected / keep / current / candidate exclusions.

describe("prune-merged-local: untracked local-only ref → advisory-only block", () => {
  let tmp, work, pruneResult;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // tag prod at main so the scan has a production line
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");

    // pr-1331-review: a fetched-head style ref that was never pushed and never
    // configured to track origin (no upstream). Created directly off main.
    git(work, "checkout -q -b pr-1331-review main");
    await fs.writeFile(path.join(work, "review.txt"), "review\n");
    git(work, "add .");
    git(work, "commit -q -m 'pr review head'");
    git(work, "checkout -q main");
    pruneResult = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("lists the never-pushed ref under an untracked local-only advisory block", () => {
    assert.equal(pruneResult.status, 0, `stderr: ${pruneResult.stderr}`);
    assert.match(pruneResult.stdout, /untracked local-only/i);
    assert.match(pruneResult.stdout, /pr-1331-review/);
  });

  it("emits a per-ref --force-delete hint for the untracked ref", () => {
    // A plain name is printed bare, so the same line works in every shell.
    assert.match(pruneResult.stdout, /--force-delete pr-1331-review$/m);
  });

  it("warns that --force-delete can remove linked worktrees before the operator uses the hint", () => {
    assert.match(pruneResult.stdout, forceDeleteWorktreeWarningPattern);
  });

  it("--exec does NOT delete the untracked local-only ref", () => {
    const result = spawnSync("node", [pruneScript, "--exec"], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // ref must still exist after --exec
    const stillThere = git(work, "branch --list pr-1331-review");
    assert.match(stillThere, /pr-1331-review/, "untracked local-only ref must survive --exec");
  });
});

// ─── Scenario V: untracked local-only is distinguished from orphaned ─────────

describe("prune-merged-local: untracked local-only distinct from orphaned", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // orphaned ref: pushed + tracked, then remote ref deleted
    git(work, "checkout -q -b feature/was-pushed");
    await fs.writeFile(path.join(work, "p.txt"), "p\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: was-pushed'");
    git(work, "push -q origin feature/was-pushed");
    git(work, "branch --set-upstream-to=origin/feature/was-pushed feature/was-pushed");
    git(work, "checkout -q main");
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");
    git(work, "push -q origin --delete feature/was-pushed");
    git(work, "fetch -q --prune origin");

    // untracked local-only ref: never pushed
    git(work, "checkout -q -b pr-2222-review main");
    await fs.writeFile(path.join(work, "r.txt"), "r\n");
    git(work, "add .");
    git(work, "commit -q -m 'pr 2222 review'");
    git(work, "checkout -q main");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("reports the never-pushed ref under untracked local-only, not orphaned", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // both buckets present
    assert.match(result.stdout, /orphaned/i);
    assert.match(result.stdout, /feature\/was-pushed/);
    assert.match(result.stdout, /untracked local-only/i);
    assert.match(result.stdout, /pr-2222-review/);
    // the untracked block conveys no remote backup
    assert.match(result.stdout, /no remote backup/i);

    // pr-2222-review must NOT appear inside the orphaned block. Split the output
    // at the untracked-local-only header and assert the orphaned section above it
    // does not name the never-pushed ref.
    const idx = result.stdout.search(/untracked local-only/i);
    const beforeUntracked = result.stdout.slice(0, idx);
    assert.doesNotMatch(beforeUntracked, /pr-2222-review/,
      "never-pushed ref must not be listed in the orphaned section");
  });

  it("warns in both orphaned and untracked advisory blocks before force-delete handoff", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const untrackedIdx = result.stdout.search(/untracked local-only/i);
    assert.notEqual(untrackedIdx, -1, "untracked local-only block must exist");
    const orphanedBlock = result.stdout.slice(0, untrackedIdx);
    const untrackedBlock = result.stdout.slice(untrackedIdx);
    assert.match(orphanedBlock, forceDeleteWorktreeWarningPattern);
    assert.match(untrackedBlock, forceDeleteWorktreeWarningPattern);
  });
});

// ─── Scenario W: untracked local-only excludes protected / keep / current ────

describe("prune-merged-local: untracked local-only respects exclusions", () => {
  let tmp, work, result;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");

    // keep-listed never-pushed ref
    git(work, "checkout -q -b pr-3333-review main");
    await fs.writeFile(path.join(work, "k.txt"), "k\n");
    git(work, "add .");
    git(work, "commit -q -m 'pr 3333'");
    git(work, "checkout -q main");
    spawnSync("node", [pruneScript, "--keep", "pr-3333-review"], { cwd: work, encoding: "utf8" });

    // current checked-out never-pushed ref
    git(work, "checkout -q -b pr-4444-review main");
    await fs.writeFile(path.join(work, "c.txt"), "c\n");
    git(work, "add .");
    git(work, "commit -q -m 'pr 4444'");
    // stay on pr-4444-review so it is the current branch during the scan
    // Both `it()`s below assert on disjoint facets (keep/current exclusion vs.
    // protected-branch exclusion) of the SAME no-argument scan over the SAME
    // fixture state — one shared spawn instead of two.
    result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not list keep-listed or current refs in the untracked local-only block", () => {
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /pr-3333-review/, "keep-listed ref must be excluded");
    assert.doesNotMatch(result.stdout, /pr-4444-review/, "current branch must be excluded");
  });

  it("never lists a protected branch as untracked local-only", () => {
    // main/production must never appear under the advisory block
    const idx = result.stdout.search(/untracked local-only/i);
    if (idx !== -1) {
      const block = result.stdout.slice(idx);
      assert.doesNotMatch(block, /^\s*(main|master|production)\s*$/m,
        "protected branches must never be advisory-listed");
    }
  });
});

// ─── Scenario X: mainline-contained branches use content reachability, not
// push-tracking-config proxies ─────────────────────────────────────────────
// Reproduces issue #1817: `git push origin <branch>` (no `-u`) never writes
// `branch.<name>.remote`. After a regular (non-squash) merge PR + GitHub
// auto-deletes the remote branch + `fetch --prune`, the branch has neither a
// remote ref nor tracking config even though its content is fully contained
// in `origin/main` — the old classifier mislabels it "never pushed; no remote
// backup". A branch pushed WITH `-u` (which DOES write tracking config)
// suffers the symmetric misdiagnosis: it lands in `orphaned` instead. Both
// must be reclassified via mainline-content-reachability, a strictly stronger
// signal than either push-tracking proxy.

describe("prune-merged-local: mainline-contained branches classified via content reachability, not push-tracking proxies", () => {
  let tmp, work, dryRunResult, execResult;
  const pushedNoUpstream = "chore/pushed-no-upstream";
  const pushedWithUpstream = "chore/pushed-with-upstream";
  const neverPushedUnmerged = "chore/never-pushed-unmerged";

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // `production` stays pinned at the init commit (never advances), so both
    // merged-into-main branches below are "shipped to mainline but not yet to
    // production" — the exact issue-report environment, and the state that
    // makes the post-`--exec` survival check a direct proof that the `--exec`
    // deletion tier is unchanged (no ref may become newly auto-deletable).
    git(work, "branch production main");

    // Fixture 1: push WITHOUT -u — issue #1817's exact repro. A bare
    // `git push origin <branch>` never writes `branch.<name>.remote`.
    git(work, ["checkout", "-q", "-b", pushedNoUpstream, "main"]);
    await fs.writeFile(path.join(work, "pnu.txt"), "pnu\n");
    git(work, "add .");
    git(work, "commit -q -m 'chore: pushed no upstream'");
    git(work, ["push", "-q", "origin", pushedNoUpstream]);
    git(work, "checkout -q main");
    git(work, ["merge", "--no-ff", "-q", pushedNoUpstream, "-m", `merge ${pushedNoUpstream}`]);
    git(work, "push -q origin main");
    git(work, ["push", "-q", "origin", "--delete", pushedNoUpstream]);

    // Fixture 2: push WITH -u (writes branch.<name>.remote) — the symmetric
    // misclassification; this one used to fall into `orphaned` instead.
    git(work, ["checkout", "-q", "-b", pushedWithUpstream, "main"]);
    await fs.writeFile(path.join(work, "pwu.txt"), "pwu\n");
    git(work, "add .");
    git(work, "commit -q -m 'chore: pushed with upstream'");
    git(work, ["push", "-q", "-u", "origin", pushedWithUpstream]);
    git(work, "checkout -q main");
    git(work, ["merge", "--no-ff", "-q", pushedWithUpstream, "-m", `merge ${pushedWithUpstream}`]);
    git(work, "push -q origin main");
    git(work, ["push", "-q", "origin", "--delete", pushedWithUpstream]);

    // Negative-guard fixture: genuinely never pushed AND never merged. The new
    // category MUST NOT swallow a real high-risk ref.
    git(work, ["checkout", "-q", "-b", neverPushedUnmerged, "main"]);
    await fs.writeFile(path.join(work, "npu.txt"), "npu\n");
    git(work, "add .");
    git(work, "commit -q -m 'chore: never pushed unmerged'");
    git(work, "checkout -q main");

    git(work, "fetch -q --prune origin");

    dryRunResult = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    execResult = spawnSync("node", [pruneScript, "--exec"], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("classifies the push-without-upstream branch (issue #1817 repro) as unshipped-mainline / mainline-contained, not orphaned/untracked", () => {
    const { stdout } = dryRunResult;
    assert.equal(dryRunResult.status, 0, `stderr: ${dryRunResult.stderr}`);
    assert.match(stdout, /mainline-ref: origin\/main/);
    const idx = stdout.search(/classified unshipped-mainline|already contained in/i);
    assert.notEqual(idx, -1, "unshipped-mainline / mainline-contained block must exist");
    const beforeNewBlock = stdout.slice(0, idx);
    assert.doesNotMatch(beforeNewBlock, new RegExp(pushedNoUpstream.replace("/", "\\/")));
    const nextBlock = stdout.slice(idx).search(/\n  [⚠️ℹ️✅]/);
    const block = nextBlock === -1 ? stdout.slice(idx) : stdout.slice(idx, idx + nextBlock);
    assert.match(block, new RegExp(pushedNoUpstream.replace("/", "\\/")));
    assert.doesNotMatch(block, /never pushed|no remote backup|possibly squash-merged/i);
    assert.doesNotMatch(block, /confirmed shipped/i);
  });

  it("classifies the push-with-upstream branch (symmetric orphaned misdiagnosis) the same way", () => {
    const { stdout } = dryRunResult;
    const idx = stdout.search(/classified unshipped-mainline|already contained in/i);
    assert.notEqual(idx, -1, "unshipped-mainline / mainline-contained block must exist");
    const beforeNewBlock = stdout.slice(0, idx);
    assert.doesNotMatch(beforeNewBlock, new RegExp(pushedWithUpstream.replace("/", "\\/")));
    const nextBlock = stdout.slice(idx).search(/\n  [⚠️ℹ️✅]/);
    const block = nextBlock === -1 ? stdout.slice(idx) : stdout.slice(idx, idx + nextBlock);
    assert.match(block, new RegExp(pushedWithUpstream.replace("/", "\\/")));
    assert.doesNotMatch(block, /never pushed|no remote backup|possibly squash-merged/i);
  });

  it("keeps the genuinely never-pushed, unmerged branch in the untracked local-only risk bucket", () => {
    const { stdout } = dryRunResult;
    const idx = stdout.search(/untracked local-only/i);
    assert.notEqual(idx, -1, "untracked local-only block must still exist");
    assert.match(stdout.slice(idx), new RegExp(neverPushedUnmerged.replace("/", "\\/")));
  });

  it("plain --exec does not auto-delete mainline-contained / unshipped-mainline branches", () => {
    assert.equal(execResult.status, 0, `stderr: ${execResult.stderr}`);
    assert.match(
      git(work, ["branch", "--list", pushedNoUpstream]),
      new RegExp(pushedNoUpstream.replace("/", "\\/")),
      `${pushedNoUpstream} must survive plain --exec (not a shipped deletion candidate)`,
    );
    assert.match(
      git(work, ["branch", "--list", pushedWithUpstream]),
      new RegExp(pushedWithUpstream.replace("/", "\\/")),
      `${pushedWithUpstream} must survive plain --exec (not a shipped deletion candidate)`,
    );
  });
});

// ─── Scenario Y: fail-closed when origin/main is unresolvable ────────────────
// D2/D3's fail-closed contract: if `origin/main` cannot be resolved, mainline-
// contained classification MUST be disabled — visibly (a `mainline-ref:
// unavailable` line + a degraded effective-scope marker), not silently — and
// no ref may be classified via an unverified containment claim. In particular
// no literal `null` may leak into a "tip not in <ref>" style qualifier.

describe("prune-merged-local: fail-closed when origin/main is unresolvable", () => {
  let tmp, work, bare, dryRunResult;
  const wouldBeContained = "chore/would-be-contained";

  before(async () => {
    ({ tmp, work, bare } = await createBaseRepo());

    // Rename the remote's `main` to `mainline` directly on the bare repo, so
    // `origin/main` becomes unresolvable while `git fetch --prune` still
    // succeeds (remote is reachable) — precisely `status: 'unavailable'`, not
    // a fetch-failure path.
    git(bare, "branch -m main mainline");

    // work repo needs a local `production` branch, otherwise [2/4] finds no
    // production ref and returns before the classification loop ever runs.
    git(work, "branch production main");

    // A branch that WOULD be classified mainline-contained under a verified
    // containment query — merged into local main, remote ref deleted. In this
    // fail-closed state it MUST fall back to the existing classification
    // instead, and it MUST still be listed somewhere (not swallowed).
    git(work, ["checkout", "-q", "-b", wouldBeContained, "main"]);
    await fs.writeFile(path.join(work, "wbc.txt"), "wbc\n");
    git(work, "add .");
    git(work, "commit -q -m 'chore: would be contained'");
    git(work, ["push", "-q", "origin", wouldBeContained]);
    git(work, "checkout -q main");
    git(work, ["merge", "--no-ff", "-q", wouldBeContained, "-m", `merge ${wouldBeContained}`]);
    git(work, ["push", "-q", "origin", "--delete", wouldBeContained]);

    git(work, "fetch -q --prune origin");

    dryRunResult = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("degrades visibly instead of silently, and never asserts unverified mainline containment", () => {
    const { stdout } = dryRunResult;
    assert.equal(dryRunResult.status, 0, `stderr: ${dryRunResult.stderr}`);
    assert.match(stdout, /mainline-ref: unavailable/);
    assert.match(stdout, /degraded effective scope:.*mainline-ref unavailable/);
    assert.doesNotMatch(stdout, /already contained in/i);
    assert.doesNotMatch(stdout, /tip not in null/);
    assert.match(stdout, new RegExp(wouldBeContained.replace("/", "\\/")));
  });
});

// ─── Scenario Y2: fail-closed when origin/main resolves but containment query fails ──

describe("prune-merged-local: fail-closed when mainline containment query fails", () => {
  let tmp, work, dryRunResult;
  const wouldBeContained = "chore/query-failed-would-be-contained";

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    git(work, "branch production main");

    git(work, ["checkout", "-q", "-b", wouldBeContained, "main"]);
    await fs.writeFile(path.join(work, "qf.txt"), "qf\n");
    git(work, "add .");
    git(work, "commit -q -m 'chore: query failed would be contained'");
    git(work, ["push", "-q", "origin", wouldBeContained]);
    git(work, "checkout -q main");
    git(work, ["merge", "--no-ff", "-q", wouldBeContained, "-m", `merge ${wouldBeContained}`]);
    git(work, "push -q origin main");
    git(work, ["push", "-q", "origin", "--delete", wouldBeContained]);
    git(work, "fetch -q --prune origin");

    const fakeBin = path.join(tmp, "fake-bin");
    await fs.mkdir(fakeBin);
    const fakeGitPayload = path.join(fakeBin, "fake-git.mjs");
    await fs.writeFile(fakeGitPayload, `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "for-each-ref" && args.includes("--merged")) {
  process.stderr.write("fixture merged query failed\\n");
  process.exit(128);
}
const result = spawnSync(process.env.DEVPRO_REAL_GIT, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
    const fakeGit = path.join(fakeBin, "git");
    const dispatchWrapper = "#!/bin/sh\nexec \"$DEVPRO_NODE_EXE\" \"$DEVPRO_FAKE_GIT_PAYLOAD\" \"$@\"\n";
    await fs.writeFile(fakeGit, dispatchWrapper);
    await fs.chmod(fakeGit, 0o755);
    const realGit = resolveExecutable("git");
    dryRunResult = spawnSync(process.execPath, [pruneScript], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        DEVPRO_NODE_EXE: process.execPath,
        DEVPRO_FAKE_GIT_PAYLOAD: fakeGitPayload,
        DEVPRO_REAL_GIT: realGit,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
    });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("degrades visibly instead of silently asserting unverified containment", () => {
    const { stdout } = dryRunResult;
    assert.equal(dryRunResult.status, 0, `stderr: ${dryRunResult.stderr}`);
    assert.match(stdout, /mainline-ref: origin\/main \(containment query failed: fixture merged query failed/);
    assert.match(stdout, /degraded effective scope:.*mainline-containment query failed/);
    assert.doesNotMatch(stdout, /already contained in/i);
    assert.match(stdout, new RegExp(wouldBeContained.replace("/", "\\/")));
  });
});

// ── Scenario Z: classification-path git probes are shell-quote independent ────
// Issue #1817 was reported on Windows 11. `execSync` runs through /bin/sh on
// POSIX but cmd.exe on Windows, and the two disagree about single quotes: sh
// strips them, cmd.exe passes them through literally. A probe written as
// `--format='%(refname:short)'` therefore reaches git intact on Windows and
// every emitted line carries stray `'`, so it never matches a bare branch name
// from `git branch --list`. The failure is silent — git still exits 0, so the
// containment query reports `verified` while matching nothing, and every branch
// falls through to the very `untracked local-only (…no remote backup…)` label
// this change exists to remove.
//
// This is a source-shape guard rather than a behavioural test on purpose: on
// POSIX both spellings behave identically, so no fixture run can distinguish
// them. The invariant only has teeth if it is asserted structurally.
// The assertion set is a single re-entrant helper so the live source and
// every resident mutation fixture in the block below run the SAME assertion
// path (design D6): a mutation that stops tripping the guard must not be
// masked by the live path and the mutation path having drifted apart.
function assertShellQuoteIndependentProbes(code) {
  assert.doesNotMatch(
    code,
    /git for-each-ref --format='%\(refname:short\)'/,
    "mainline containment query must not be a single-quoted shell string (cmd.exe keeps the quotes)",
  );
  assert.match(
    code,
    /'for-each-ref',\s*'--format=%\(refname:short\)',\s*'--merged'/,
    "mainline containment query must be issued as an argv array",
  );

  assert.doesNotMatch(
    code,
    /git for-each-ref --format='%\(refname\)%00%\(refname:short\)%00%\(objectname\)'/,
    "branch snapshot query must not be a single-quoted shell string (cmd.exe keeps the quotes)",
  );
  assert.match(
    code,
    /'for-each-ref',\s*'--format=%\(refname\)%00%\(refname:short\)%00%\(objectname\)'/,
    "branch snapshot query must be issued as an argv array",
  );

  assert.doesNotMatch(
    code,
    /git config --get-regexp/,
    "tracking-config probe must not be a single-quoted shell string (cmd.exe keeps the quotes)",
  );
  assert.match(
    code,
    /'config',\s*'--get-regexp',\s*'\^branch\\\\\..\*\\\\\.remote\$'/,
    "tracking-config probe must be issued as an argv array",
  );

  for (const [label, forbidden] of [
    ["worktree remove must be an argv exec, not a shell string", /execSync\(`git worktree remove --force/],
    ["rev-parse of shellQuote(target) must be an argv exec, not a shell string", /sh\(`git rev-parse \$\{shellQuote\(target\)\}/],
    ["git tag --contains must be an argv exec, not a shell string", /sh\(`git tag --contains/],
    ["git branch -d/-D must be an argv exec, not a shell string", /execSync\(`git branch -[dD]/],
    ["git push origin --delete must be an argv exec, not a shell string", /execSync\(`git push origin --delete/],
  ]) {
    assert.doesNotMatch(code, forbidden, label);
  }
  assert.match(code, /execGitFileSync\(worktreeRemoveArgv\(wt, \{ force \}\)/);
  assert.match(code, /const remove = \['worktree', 'remove', \.\.\.\(force \? \['--force'\] : \[\]\), wt\.path\];/);
  assert.match(code, /process\.platform === 'win32' \? \['-c', 'core\.longpaths=true', \.\.\.remove\] : remove/);
  assert.match(
    code,
    /execResult\('git',\s*\[\s*'rev-parse',\s*'--verify',\s*`refs\/heads\/\$\{branch\}\^\{commit\}`/,
    "local branch tip must resolve via refs/heads/<branch>^{commit} (not ambiguous short name)",
  );
  assert.doesNotMatch(
    code,
    /execResult\('git', \['rev-parse', (?:target|branch)\]/,
    "must not rev-parse ambiguous short branch names for tip reads",
  );
  assert.match(code, /execResult\('git', \['tag', '--contains', tip\]/);
  assert.match(code, /execGitFileSync\(\['branch', '-D', target\]/);
  assert.match(code, /execGitFileSync\(\['push', 'origin', `--force-with-lease=\$\{leaseSpec\}`, `:\$\{exactRef\}`\]/);

  assert.match(code, /isProtectedBaseBranch\(/);
  assert.doesNotMatch(code, /const PROTECTED\s*=\s*new Set/);
  assert.doesNotMatch(code, /PROTECTED_BRANCHES\s*=\s*new Set/);
}

describe("prune-merged-local: classification-path probes do not depend on shell quoting", () => {
  let code;

  before(async () => {
    // Strip comments first: the negative assertions below name the very shell
    // spelling the fix removed, so prose that explains the defect would
    // otherwise satisfy its own guard. Only comment spans are removed —
    // string/template/regex text is preserved byte-for-byte (defect B), so the
    // lexical stripper replaces the naive regex pair this block used before.
    code = stripJsCommentSpans(await fs.readFile(pruneScript, "utf8"));
  });

  it("keeps every protected classification-path query shell-quote independent", () => {
    assertShellQuoteIndependentProbes(code);
  });
});

// ── Scenario Z resident mutation fixtures: the guard's teeth in both ways ────
//
// Every row mutates the RAW script text and only then strips comments — the
// order is load-bearing (design D6): mutating the already-stripped `code`
// would insert "comments" into text that has none, and the comment-only and
// glob-star rows would pass for the wrong reason forever.
//
// Each row carries its own expected-failure label (tuple-owned matcher: the
// thrown assertion's message must equal that row's label; no shared loose
// matcher). The axis set grows with design D4's residual table — every
// false-green residual MUST get its own axis here. 軸集合隨 D4 殘留表成長，
// MUST NOT 以既有 comment-only 軸概括承受（round 4 已證 comment-only 軸不承接
// L1b 型殘留；L1b 是假紅方向，由 D4 判準 (b) 承接，故不在本表）。
// Spec scenario carrier (test-governance): "Residual axes grow with the residual table and consumers assert their expected-reject set" — this table plus the census lists below carry it.
//
// L1／L4 rows (ledger F-tl-02, user decision 2026-09-19 = option 1,「照字面紅」):
// D6 requires these rows to be RED while the residual itself is a false-green
// hole (comment/span content survives). The constructions below keep the D4
// shape present and turn red; in both, the red is NOT caused by the residual —
// the surviving text never reaches the assertion pair the row is bound to. The
// hole itself (a protected argv surviving inside an L1 comment without a second
// `//`, or inside an L4 span) is pinned at the stripper level by
// js-comment-spans.test.mjs's documented-limitation tests L1／L4.

const MAINLINE_REF_ANCHOR = "  const ref = mainlineRef();";
const MAINLINE_ARGV_TEXT = "'for-each-ref', '--format=%(refname:short)', '--merged'";
const MAINLINE_ARGV_BLOCK = [
  "  const result = execResult('git', [",
  "    'for-each-ref',",
  "    '--format=%(refname:short)',",
  "    '--merged',",
  "    ref,",
  "    'refs/heads/',",
  "  ]);",
].join("\n");

const MAINLINE_SHELL_STRING_LABEL =
  "mainline containment query must not be a single-quoted shell string (cmd.exe keeps the quotes)";
const MAINLINE_ARGV_LABEL =
  "mainline containment query must be issued as an argv array";

function applyMutation(rawSource, row) {
  const mutated = row.mutate(rawSource);
  assert.notEqual(mutated, rawSource, `mutation must modify its target: ${row.name}`);
  return mutated;
}

const MUTATION_FIXTURE_ROWS = [
  {
    name: "absence: protected argv replaced by a single-quoted shell string",
    mutate: (source) =>
      source.replace(
        MAINLINE_ARGV_BLOCK,
        "  const result = execResult('git', `git for-each-ref --format='%(refname:short)' --merged ${ref} refs/heads/`);",
      ),
    expected: "throws",
    label: MAINLINE_SHELL_STRING_LABEL,
  },
  {
    name: "insertion: forbidden shell-string literal added to a real code region",
    mutate: (source) =>
      source.replace(
        MAINLINE_REF_ANCHOR,
        "  const ref = mainlineRef();\n  execSync(`git branch -D fixture-branch`);",
      ),
    expected: "throws",
    label: "git branch -d/-D must be an argv exec, not a shell string",
  },
  {
    name: "comment-only (false-green face): protected argv only inside a plain comment",
    mutate: (source) =>
      source.replace(
        MAINLINE_ARGV_BLOCK,
        "  const result = execResult('git', ['for-each-ref']); // " + MAINLINE_ARGV_TEXT,
      ),
    expected: "throws",
    label: MAINLINE_ARGV_LABEL,
  },
  {
    name: "comment-only (false-red face): forbidden shell-string literal only inside a comment",
    mutate: (source) =>
      source.replace(
        MAINLINE_REF_ANCHOR,
        "  const ref = mainlineRef();\n  // execSync(`git branch -D fixture-branch`);",
      ),
    expected: "passes",
  },
  {
    name: "glob-star (defect B shape): `<path>/*` line comment before the protected code",
    mutate: (source) =>
      source.replace(
        MAINLINE_REF_ANCHOR,
        "  const ref = mainlineRef();\n  // worktree refs live under .worktree/*/notes",
      ),
    expected: "passes",
  },
  {
    name: "string literal containing `/*` before the protected code",
    mutate: (source) =>
      source.replace(
        MAINLINE_REF_ANCHOR,
        "  const ref = mainlineRef();\n  const note = 'worktrees live under .worktree/* and stay there';",
      ),
    expected: "passes",
  },
  {
    name: "L1 residual shape: regex quote pairs inside comment text; argv only in the comment",
    mutate: (source) =>
      source.replace(
        MAINLINE_ARGV_BLOCK,
        "  const _l1Probe = /['x]/; // don't use // " + MAINLINE_ARGV_TEXT,
      ),
    expected: "throws",
    label: MAINLINE_ARGV_LABEL,
  },
  {
    name: "L4 residual shape: two unescaped-backtick regexes pair up; argv only in the comment outside the span",
    mutate: (source) =>
      source.replace(
        MAINLINE_ARGV_BLOCK,
        "  const _l4ProbeA = /`/; const _l4ProbeB = /`/;\n  // " + MAINLINE_ARGV_TEXT,
      ),
    expected: "throws",
    label: MAINLINE_ARGV_LABEL,
  },
];

describe("prune-merged-local: Scenario Z mutation fixtures keep the guard's teeth", () => {
  for (const row of MUTATION_FIXTURE_ROWS) {
    it(row.name, async () => {
      const rawSource = await fs.readFile(pruneScript, "utf8");
      const mutated = applyMutation(rawSource, row);
      const mutatedCode = stripJsCommentSpans(mutated);

      if (row.expected === "throws") {
        assert.throws(
          () => assertShellQuoteIndependentProbes(mutatedCode),
          (error) => {
            assert.equal(
              error?.message,
              row.label,
              `${row.name}: expected the guard to fail on this row's own tuple-owned assertion label`,
            );
            return true;
          },
          `${row.name}: guard must reject the mutated source`,
        );
        return;
      }

      assert.doesNotThrow(
        () => assertShellQuoteIndependentProbes(mutatedCode),
        `${row.name}: guard must accept the mutated source`,
      );
    });
  }
});

describe("prune contract source census", () => {
  const fixedProtectedBases = ["integration", "main", "master", "production"];

  // Lexical comment stripping fails closed (design D4 E4) when a file's regex
  // bodies carry unescaped backticks (residual L4). The refused set is asserted
  // by name (design D4 disposition 3): a file entering or leaving it MUST be an
  // explicit edit with a deliberate list update, never a silent drift.
  const expectedScannerRejects = [
    "scripts/hooks/lib/branch-naming.mjs",
    "scripts/hooks/lib/chore-code-size-gate.mjs",
    "scripts/hooks/lib/git-utils.mjs",
    "scripts/hooks/lib/recap-utils.mjs",
    "scripts/hooks/lib/rule-load-host-diagnostics.mjs",
    "scripts/lib/declared-title-lists.mjs",
    "scripts/lib/load-chain-declarations.mjs",
    "scripts/lib/markdown-fence-aware.mjs",
    "scripts/lib/requirement-ledger-rows.mjs",
    "scripts/lint-modified-scenario-preservation.mjs",
    "scripts/lint-proposal-touch-coverage.mjs",
    "scripts/report-governance-ratio.mjs",
    "scripts/rule-load-ledger.mjs",
    "scripts/sarif-report.mjs",
  ];
  // Ledger F-tl-03 (user decision 2026-09-19 = option 1): the census's own
  // authority (`branch-naming.mjs`, the only definition site of the anchor)
  // is itself refused by the scanner, so a plain "skip refused files" rule
  // would leave the census with zero authorities (measured). Files named here
  // are the ONLY refused files allowed to carry the census anchor; they are
  // classified from their RAW text (comments not stripped) and the anchor
  // intersection of the refused set is asserted both ways below — in or out
  // of this list turns the census red rather than silently missing a
  // should-be-classified file (design D4 disposition 3, F-r5-07).
  const expectedAnchorCarryingRejects = [
    "scripts/hooks/lib/branch-naming.mjs",
    "scripts/hooks/lib/recap-utils.mjs",
  ];
  const protectedCensusAnchor = /PROTECTED_BASE_BRANCHES|PROTECTED_BRANCHES|\bconst PROTECTED\b|isProtectedBaseBranch/;

  function sortedUnique(values) {
    return [...new Set(values)].sort();
  }

  function quotedNames(text) {
    return [...text.matchAll(/[`'"]([^`'"]+)[`'"]/g)].map((match) => match[1]);
  }

  function assertCanonicalProtectedCarrier(source) {
    const definitions = [...source.matchAll(/\bconst\s+PROTECTED_BASE_BRANCHES\s*=\s*new Set\(\[([\s\S]*?)\]\);/g)];
    assert.equal(definitions.length, 1, "canonical carrier must define one private protected-base Set");
    assert.deepEqual(
      sortedUnique(quotedNames(definitions[0][1])),
      fixedProtectedBases,
      "canonical protected-base membership must equal the exact fixed four-name set",
    );
    assert.match(
      source,
      /export function isProtectedBaseBranch\(branch\)\s*\{\s*return PROTECTED_BASE_BRANCHES\.has\(branch\);\s*\}/,
      "the neutral predicate must read the private canonical Set directly",
    );
    assert.doesNotMatch(source, /export\s+(?:const|let|var)\s+PROTECTED_BASE_BRANCHES\b/);
    assert.doesNotMatch(source, /PROTECTED_BASE_BRANCHES\.(?:add|delete|clear)\s*\(/);
  }

  function assertSemanticActionPoint(rule) {
    const markers = [...rule.matchAll(/<!-- prune-contract-action-point:start -->([\s\S]*?)<!-- prune-contract-action-point:end -->/g)];
    assert.equal(markers.length, 1, "rule must contain one bounded prune action point");
    const action = markers[0][1];
    const membership = action.match(/protected bases exact set 為 ([^，\n]+)，且 guard/);
    assert.ok(membership, "action point must expose a parseable exact-set boundary");
    assert.deepEqual(
      sortedUnique(quotedNames(membership[1])),
      fixedProtectedBases,
      "human action point must normalize to exactly the canonical four names",
    );
    assert.match(action, /zero-network/i);
    assert.match(action, /unverified/i);
    assert.match(action, /non-executable/i);
    assert.match(action, /fresh live proof/i);
  }

  function assertModifiedRequirementSupersession(spec) {
    const marker = spec.indexOf("## MODIFIED Requirements");
    assert.notEqual(marker, -1, "effective delta must contain MODIFIED requirements");
    const requirements = spec
      .slice(marker)
      .split(/(?=^### Requirement:)/m)
      .filter((block) => block.startsWith("### Requirement:"));
    const legacyEnumeration = /`main`\s*\/\s*`master`\s*\/\s*`production`/;
    const exactSupersession = /superseded by the exact fixed membership `\{main, master, production, integration\}`/;
    const legacyRequirements = requirements.filter((block) => legacyEnumeration.test(block));
    assert.ok(legacyRequirements.length > 0, "guard fixture must exercise preserved legacy enumerations");
    for (const block of legacyRequirements) {
      assert.match(
        block,
        exactSupersession,
        "each MODIFIED requirement that preserves a legacy three-name enumeration must supersede it in the same requirement boundary",
      );
    }
  }

  it("prove-it I5 derives the semantic census from the live tree instead of a consumer snapshot", async () => {
    const self = await fs.readFile(fileURLToPath(import.meta.url), "utf8");
    const staleSnapshotIdentifier = ["allowed", "Predicate", "Consumers"].join("");
    assert.equal(
      self.includes(staleSnapshotIdentifier),
      false,
      "protected-consumer census must not hardcode a previously observed file list",
    );
  });

  it("classifies every live protected-base authority/import/alias/re-export/mutation/predicate consumer", async () => {
    const devproRoot = repoPath(".devpro");
    const files = [];
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "tests") await walk(full);
        } else if (/\.(?:mjs|js)$/.test(entry.name)) {
          files.push(full);
        }
      }
    }
    await walk(devproRoot);

    const authorities = [];
    const classifiedConsumers = [];
    const unclassified = [];
    const scannerRejects = [];
    const anchorCarryingRejects = [];
    for (const file of files) {
      const rel = path.relative(devproRoot, file).split(path.sep).join("/");
      const rawSource = await fs.readFile(file, "utf8");
      let source;
      try {
        source = stripJsCommentSpans(rawSource);
      } catch (error) {
        if (!(error instanceof JsCommentSpanScanError)) throw error;
        scannerRejects.push(rel);
        if (protectedCensusAnchor.test(rawSource)) anchorCarryingRejects.push(rel);
        // Only the explicitly named anchor-carrying rejects are classified,
        // and only from raw text; every other refused file is anchor-checked
        // above and then left out — named and asserted, never a silent skip.
        if (!expectedAnchorCarryingRejects.includes(rel)) continue;
        source = rawSource;
      }
      const hasRelevantSymbol = protectedCensusAnchor.test(source);
      if (!hasRelevantSymbol) continue;

      const definesAuthority = /\bconst\s+PROTECTED_BASE_BRANCHES\s*=\s*new Set\(/.test(source)
        && /export function isProtectedBaseBranch\(/.test(source);
      const importsPredicate = /import\s*\{[^}]*\bisProtectedBaseBranch\b[^}]*\}\s*from\s*["'][^"']*branch-naming\.mjs["']/s.test(source);
      const aliasesPredicate = /\bisProtectedBaseBranch\s+as\s+\w+|\b(?:const|let|var)\s+\w+\s*=\s*isProtectedBaseBranch\b(?!\s*\()/.test(source);
      const reexportsPredicate = /export\s*\{[^}]*\bisProtectedBaseBranch\b[^}]*\}/s.test(source);
      const mutatesMembership = /\bPROTECTED_BASE_BRANCHES\.(?:add|delete|clear)\s*\(/.test(source);
      const duplicatesMembership = /\b(?:PROTECTED_BRANCHES|PROTECTED)\s*=\s*new Set\(/.test(source)
        || (!definesAuthority && /\bPROTECTED_BASE_BRANCHES\s*=\s*new Set\(/.test(source));

      if (definesAuthority) {
        authorities.push({ rel, source });
      } else if (importsPredicate && !aliasesPredicate && !reexportsPredicate && !mutatesMembership && !duplicatesMembership) {
        classifiedConsumers.push(rel);
      } else {
        unclassified.push({
          rel,
          importsPredicate,
          aliasesPredicate,
          reexportsPredicate,
          mutatesMembership,
          duplicatesMembership,
        });
      }
    }

    assert.deepEqual(
      scannerRejects.sort(),
      [...expectedScannerRejects].sort(),
      "scanner-refused file set drifted; update expectedScannerRejects deliberately (in or out = red)",
    );
    assert.deepEqual(
      anchorCarryingRejects.sort(),
      [...expectedAnchorCarryingRejects].sort(),
      "anchor-carrying refused files must be exactly the named exception list (in or out = red)",
    );
    assert.equal(authorities.length, 1, "live semantic census must find exactly one protected-membership authority");
    assertCanonicalProtectedCarrier(authorities[0].source);
    assert.ok(classifiedConsumers.length > 0, "census fixture must exercise predicate consumers");
    assert.deepEqual(unclassified, []);
  });

  it("keeps one parseable human action point with exact fixed bases and local-only semantics", async () => {
    const rule = await fs.readFile(repoPath(".devpro/agent-rules/git-branch-hygiene.md"), "utf8");
    assertSemanticActionPoint(rule);
  });

  it("enforces exact-four precedence inside every affected MODIFIED requirement boundary", async () => {
    const spec = await fs.readFile(repoPath("openspec/changes/archive/2026-08-13-fix-prune-contract-integrity/specs/branch-hygiene-tooling/spec.md"), "utf8");
    assert.match(spec, /exactly `main`, `master`, `production`, and `integration`/);
    assert.match(spec, /SHALL derive their protected-base decision from the same canonical membership/);
    assert.match(spec, /explicit-local-only Git argv guard SHALL be the sole normative executable authority/);
    assertModifiedRequirementSupersession(spec);
  });

  it("prove-it I5 source-contract guards fail under membership, rule, supersession, and ordering mutations", async () => {
    const canonical = await fs.readFile(repoPath(".devpro/scripts/hooks/lib/branch-naming.mjs"), "utf8");
    const rule = await fs.readFile(repoPath(".devpro/agent-rules/git-branch-hygiene.md"), "utf8");
    const spec = await fs.readFile(repoPath("openspec/changes/archive/2026-08-13-fix-prune-contract-integrity/specs/branch-hygiene-tooling/spec.md"), "utf8");
    const runtime = await fs.readFile(pruneScript, "utf8");

    assert.doesNotThrow(() => assertCanonicalProtectedCarrier(canonical));
    assert.throws(
      () => assertCanonicalProtectedCarrier(canonical.replace(/^\s*"integration",\s*$/m, "")),
      "removing integration must trip exact-four equality",
    );
    assert.doesNotThrow(() => assertSemanticActionPoint(rule));
    assert.throws(
      () => assertSemanticActionPoint(rule.replace("`integration`，且 guard", "`develop`，且 guard")),
      "human-rule membership drift must fail closed",
    );
    assert.doesNotThrow(() => assertModifiedRequirementSupersession(spec));
    assert.throws(
      () => assertModifiedRequirementSupersession(spec.replace(/^Within this requirement, every legacy protected-base enumeration[^\n]+\n/m, "")),
      "a legacy enumeration without same-requirement supersession must fail closed",
    );

    const forceBlock = runtime.slice(
      runtime.indexOf("if (MODE === '--force-delete')"),
      runtime.indexOf("// ─── default scan mode"),
    );
    function assertProtectedBeforeRelease(block) {
      const protectedGuard = block.indexOf("if (isProtectedBaseBranch(target))");
      const releaseGuard = block.indexOf("if (target.startsWith(RELEASE_PREFIX))");
      assert.ok(protectedGuard >= 0 && protectedGuard < releaseGuard, "fixed protected guard must precede independent release policy");
    }
    const snapshotGuard = forceBlock.indexOf("if (effectiveScope.worktreeSnapshot?.ok !== true)");
    const worktreeMutation = forceBlock.indexOf("removeLinkedWorktree(wt)");
    const branchMutation = forceBlock.indexOf("execGitFileSync(['branch', '-D', target]");
    assert.doesNotThrow(() => assertProtectedBeforeRelease(forceBlock));
    assert.ok(snapshotGuard >= 0 && snapshotGuard < worktreeMutation, "worktree snapshot guard must precede worktree mutation");
    assert.ok(snapshotGuard < branchMutation, "worktree snapshot guard must precede branch mutation");

    const mutatedOrdering = forceBlock
      .replace("if (isProtectedBaseBranch(target))", "if (__MUTATED_PROTECTED_PLACEHOLDER__)")
      .replace("if (target.startsWith(RELEASE_PREFIX))", "if (isProtectedBaseBranch(target))")
      .replace("if (__MUTATED_PROTECTED_PLACEHOLDER__)", "if (target.startsWith(RELEASE_PREFIX))");
    assert.throws(
      () => assertProtectedBeforeRelease(mutatedOrdering),
      "mutation fixture must invert the protected/release guard order",
    );
  });
});

// ─── Scenario #2062: unshipped-mainline consent tier (FR-5 prove-it matrix) ───

describe("prune-merged-local: unshipped-mainline consent tier (#2062)", () => {
  let tmp, work, bare;
  const shippedLocal = "chore/shipped-prod";
  const mainOnlyLocal = "chore/main-only-local";
  const mainOnlyRemote = "chore/main-only-remote";
  const neitherLocal = "chore/neither-wip";

  before(async () => {
    ({ tmp, work, bare } = await createBaseRepo());

    // Pin production at init; advance main separately so main-only tips stay unshipped.
    git(work, ["branch", "production", "main"]);
    git(work, ["push", "-q", "origin", "production"]);

    // Production-contained tip (shipped path must keep working without unshipped flag).
    git(work, ["checkout", "-q", "-b", shippedLocal, "production"]);
    await fs.writeFile(path.join(work, "shipped.txt"), "shipped\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "chore: shipped to production"]);
    git(work, ["checkout", "-q", "production"]);
    git(work, ["merge", "--no-ff", "-q", shippedLocal, "-m", `merge ${shippedLocal}`]);
    git(work, ["push", "-q", "origin", "production"]);
    git(work, ["push", "-q", "origin", shippedLocal]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "--no-ff", "-q", "production", "-m", "sync main with production"]);
    git(work, ["push", "-q", "origin", "main"]);

    // Main-only local (remote deleted after merge) — consent local path.
    git(work, ["checkout", "-q", "-b", mainOnlyLocal, "main"]);
    await fs.writeFile(path.join(work, "main-only-local.txt"), "mol\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "chore: main-only local"]);
    git(work, ["push", "-q", "origin", mainOnlyLocal]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "--no-ff", "-q", mainOnlyLocal, "-m", `merge ${mainOnlyLocal}`]);
    git(work, ["push", "-q", "origin", "main"]);
    git(work, ["push", "-q", "origin", "--delete", mainOnlyLocal]);

    // Main-only with remote still present — stronger remote consent path.
    git(work, ["checkout", "-q", "-b", mainOnlyRemote, "main"]);
    await fs.writeFile(path.join(work, "main-only-remote.txt"), "mor\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "chore: main-only remote"]);
    git(work, ["push", "-q", "-u", "origin", mainOnlyRemote]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "--no-ff", "-q", mainOnlyRemote, "-m", `merge ${mainOnlyRemote}`]);
    git(work, ["push", "-q", "origin", "main"]);

    // Neither main nor production — never auto-delete.
    git(work, ["checkout", "-q", "-b", neitherLocal, "main"]);
    await fs.writeFile(path.join(work, "neither.txt"), "neither\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "chore: neither wip"]);
    git(work, ["checkout", "-q", "main"]);

    git(work, ["fetch", "-q", "--prune", "origin"]);
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("dry-run distinguishes shipped vs unshipped-mainline vs neither without labelling unshipped as shipped", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const { stdout } = result;
    assert.match(stdout, /confirmed shipped/);
    assert.match(stdout, new RegExp(shippedLocal.replace("/", "\\/")));
    assert.match(stdout, /classified unshipped-mainline/i);
    assert.match(stdout, new RegExp(mainOnlyLocal.replace("/", "\\/")));
    assert.match(stdout, new RegExp(mainOnlyRemote.replace("/", "\\/")));
    const shippedIdx = stdout.search(/confirmed shipped/i);
    const unshippedIdx = stdout.search(/classified unshipped-mainline/i);
    assert.ok(shippedIdx >= 0 && unshippedIdx >= 0 && shippedIdx < unshippedIdx);
    assert.doesNotMatch(
      stdout.slice(shippedIdx, unshippedIdx),
      new RegExp(mainOnlyLocal.replace("/", "\\/")),
      "main-only must not appear in shipped block",
    );
    assert.match(stdout, new RegExp(neitherLocal.replace("/", "\\/")));
    assert.doesNotMatch(
      stdout.slice(unshippedIdx),
      /confirmed shipped|production-backed|merged into production/i,
    );
  });

  it("plain --exec deletes production-contained local but not main-only or neither", () => {
    const cloneTmp = path.join(tmp, "plain-exec");
    cpSync(work, cloneTmp, { recursive: true });
    // Detach origin for isolation of local deletes only.
    git(cloneTmp, ["remote", "set-url", "origin", bare]);
    const result = spawnSync("node", [pruneScript, "--exec"], {
      cwd: cloneTmp,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(cloneTmp, ["branch", "--list", shippedLocal]).includes(shippedLocal),
      false,
      "shipped local must be deleted by plain --exec",
    );
    assert.ok(
      git(cloneTmp, ["branch", "--list", mainOnlyLocal]).includes(mainOnlyLocal),
      "main-only must survive plain --exec",
    );
    assert.ok(
      git(cloneTmp, ["branch", "--list", mainOnlyRemote]).includes(mainOnlyRemote),
      "main-only-with-remote must survive plain --exec",
    );
    assert.ok(
      git(cloneTmp, ["branch", "--list", neitherLocal]).includes(neitherLocal),
      "neither must survive plain --exec",
    );
  });

  it("--include-unshipped-mainline --exec deletes verified main-only local and keeps neither", () => {
    const cloneTmp = path.join(tmp, "consent-local");
    cpSync(work, cloneTmp, { recursive: true });
    git(cloneTmp, ["remote", "set-url", "origin", bare]);
    // Restore shipped local so this case isolates unshipped consent.
    if (!git(cloneTmp, ["branch", "--list", shippedLocal]).includes(shippedLocal)) {
      git(cloneTmp, ["branch", shippedLocal, `origin/${shippedLocal}`]);
    }
    const result = spawnSync(
      "node",
      [pruneScript, "--include-unshipped-mainline", "--exec"],
      { cwd: cloneTmp, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(cloneTmp, ["branch", "--list", mainOnlyLocal]).includes(mainOnlyLocal),
      false,
      "main-only local must be deleted with unshipped-mainline consent",
    );
    assert.equal(
      git(cloneTmp, ["branch", "--list", mainOnlyRemote]).includes(mainOnlyRemote),
      false,
      "main-only local (remote still present) must be deleted locally with consent",
    );
    assert.ok(
      git(cloneTmp, ["ls-remote", "--heads", "origin", mainOnlyRemote]).includes(mainOnlyRemote),
      "remote must survive local-only unshipped consent",
    );
    assert.ok(
      git(cloneTmp, ["branch", "--list", neitherLocal]).includes(neitherLocal),
      "neither must never auto-delete",
    );
    const shippedBlockEnd = result.stdout.search(/classified unshipped-mainline/i);
    assert.ok(shippedBlockEnd > 0);
    assert.doesNotMatch(
      result.stdout.slice(0, shippedBlockEnd),
      /main-only/i,
      "main-only must not be listed under shipped",
    );
  });

  it("--include-remote --exec alone deletes shipped remote but not unshipped-mainline remote", () => {
    const caseTmp = path.join(tmp, "remote-alone-case");
    const caseBare = path.join(caseTmp, "remote.git");
    const caseWork = path.join(caseTmp, "work");
    cpSync(bare, caseBare, { recursive: true });
    cpSync(work, caseWork, { recursive: true });
    git(caseWork, ["remote", "set-url", "origin", caseBare]);
    const result = spawnSync(
      "node",
      [pruneScript, "--include-remote", "--exec"],
      { cwd: caseWork, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(caseWork, ["ls-remote", "--heads", "origin", shippedLocal]).includes(shippedLocal),
      false,
      "shipped remote must still delete via --include-remote --exec",
    );
    assert.ok(
      git(caseWork, ["ls-remote", "--heads", "origin", mainOnlyRemote]).includes(mainOnlyRemote),
      "unshipped-mainline remote must survive --include-remote --exec alone",
    );
    assert.ok(
      git(caseWork, ["branch", "--list", mainOnlyLocal]).includes(mainOnlyLocal),
      "main-only local must survive --include-remote --exec alone",
    );
  });

  it("--include-unshipped-mainline --include-remote --exec deletes unshipped-mainline remote", () => {
    // Use a dedicated bare clone so prior remote-alone deletion does not poison this case.
    const caseTmp = path.join(tmp, "stronger-remote-case");
    const caseBare = path.join(caseTmp, "remote.git");
    const caseWork = path.join(caseTmp, "work");
    cpSync(bare, caseBare, { recursive: true });
    cpSync(work, caseWork, { recursive: true });
    git(caseWork, ["remote", "set-url", "origin", caseBare]);
    // Ensure remote tip still exists on this private bare.
    if (!git(caseWork, ["ls-remote", "--heads", "origin", mainOnlyRemote]).includes(mainOnlyRemote)) {
      git(caseWork, ["push", "-q", "origin", mainOnlyRemote]);
    }
    const result = spawnSync(
      "node",
      [pruneScript, "--include-unshipped-mainline", "--include-remote", "--exec"],
      { cwd: caseWork, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(caseWork, ["ls-remote", "--heads", "origin", mainOnlyRemote]).includes(mainOnlyRemote),
      false,
      "stronger consent must delete unshipped-mainline remote",
    );
    assert.equal(
      git(caseWork, ["branch", "--list", mainOnlyRemote]).includes(mainOnlyRemote),
      false,
    );
    assert.ok(
      git(caseWork, ["branch", "--list", neitherLocal]).includes(neitherLocal),
      "neither must never auto-delete even with strongest consent flags",
    );
  });

  it("--local-only remains mutually exclusive with --include-remote and zero-network with unshipped flag", () => {
    const conflict = spawnSync(
      "node",
      [pruneScript, "--local-only", "--include-remote", "--include-unshipped-mainline"],
      { cwd: work, encoding: "utf8" },
    );
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /--local-only and --include-remote cannot be used together/);

    const cloneTmp = path.join(tmp, "local-only-consent");
    cpSync(work, cloneTmp, { recursive: true });
    git(cloneTmp, ["remote", "set-url", "origin", bare]);
    const localOnly = spawnSync(
      "node",
      [pruneScript, "--local-only", "--include-unshipped-mainline", "--exec"],
      { cwd: cloneTmp, encoding: "utf8" },
    );
    assert.equal(localOnly.status, 0, localOnly.stderr);
    assert.match(localOnly.stdout, /explicit --local-only zero-network/i);
    assert.match(localOnly.stdout, /git fetch --prune skipped/);
  });
});

describe("prune-merged-local: ambiguous mainline + unshipped consent aborts invocation-wide", () => {
  let tmp, work, bare;
  let mixedFixtureTemplatePromise;
  const shipped = "chore/ambig-shipped";
  const mainOnly = "chore/ambig-main-only";

  async function buildMixedFixtureTemplate() {
    const fixture = await createBaseRepo();
    ({ work, bare } = fixture);
    git(work, ["branch", "production", "main"]);
    git(work, ["push", "-q", "origin", "production"]);

    git(work, ["checkout", "-q", "-b", shipped, "production"]);
    await fs.writeFile(path.join(work, "ambig-shipped.txt"), "s\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "chore: ambig shipped"]);
    git(work, ["checkout", "-q", "production"]);
    git(work, ["merge", "--no-ff", "-q", shipped, "-m", `merge ${shipped}`]);
    git(work, ["push", "-q", "origin", "production"]);
    git(work, ["push", "-q", "origin", shipped]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "--no-ff", "-q", "production", "-m", "sync"]);
    git(work, ["push", "-q", "origin", "main"]);

    git(work, ["checkout", "-q", "-b", mainOnly, "main"]);
    await fs.writeFile(path.join(work, "ambig-main.txt"), "m\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "chore: ambig main only"]);
    git(work, ["push", "-q", "origin", mainOnly]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "--no-ff", "-q", mainOnly, "-m", `merge ${mainOnly}`]);
    git(work, ["push", "-q", "origin", "main"]);
    git(work, ["push", "-q", "origin", "--delete", mainOnly]);
    git(work, ["fetch", "-q", "--prune", "origin"]);

    return fixture;
  }

  async function buildMixedFixture() {
    if (!mixedFixtureTemplatePromise) {
      mixedFixtureTemplatePromise = buildMixedFixtureTemplate();
    }
    const template = await mixedFixtureTemplatePromise;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "prune-ambiguous-mainline-"));
    bare = path.join(tmp, "remote.git");
    work = path.join(tmp, "work");
    cpSync(template.bare, bare, { recursive: true });
    cpSync(template.work, work, { recursive: true });
    git(work, ["remote", "set-url", "origin", bare]);
  }

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  after(async () => {
    const template = await mixedFixtureTemplatePromise;
    if (template?.tmp) await fs.rm(template.tmp, { recursive: true, force: true });
  });

  it("unavailable mainline + consent flag → zero mutation including shipped (local)", async () => {
    await buildMixedFixture();
    git(bare, ["branch", "-m", "main", "mainline"]);
    git(work, ["remote", "prune", "origin"]);
    // Refresh so origin/main disappears from work's remote-tracking.
    spawnSync("git", ["fetch", "-q", "--prune", "origin"], { cwd: work });

    const beforeShipped = git(work, ["branch", "--list", shipped]);
    const beforeMain = git(work, ["branch", "--list", mainOnly]);
    const result = spawnSync(
      "node",
      [pruneScript, "--include-unshipped-mainline", "--exec"],
      { cwd: work, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, "must abort when consent requested under ambiguous mainline");
    assert.match(`${result.stdout}\n${result.stderr}`, /mainline-ref: unavailable|degraded|abort|refuse|unverified/i);
    assert.ok(git(work, ["branch", "--list", shipped]).includes(shipped), "shipped must be retained");
    assert.ok(git(work, ["branch", "--list", mainOnly]).includes(mainOnly), "main-only must be retained");
    assert.equal(git(work, ["branch", "--list", shipped]), beforeShipped);
    assert.equal(git(work, ["branch", "--list", mainOnly]), beforeMain);
  });

  it("unavailable mainline + consent + include-remote → zero mutation including remotes", async () => {
    await buildMixedFixture();
    git(bare, ["branch", "-m", "main", "mainline"]);
    spawnSync("git", ["fetch", "-q", "--prune", "origin"], { cwd: work });

    const result = spawnSync(
      "node",
      [pruneScript, "--include-unshipped-mainline", "--include-remote", "--exec"],
      { cwd: work, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.ok(git(work, ["branch", "--list", shipped]).includes(shipped));
    assert.ok(git(work, ["ls-remote", "--heads", "origin", shipped]).includes(shipped));
    assert.ok(git(work, ["branch", "--list", mainOnly]).includes(mainOnly));
  });

  it("without consent flag, shipped path still deletes under mainline unavailable", async () => {
    await buildMixedFixture();
    git(bare, ["branch", "-m", "main", "mainline"]);
    spawnSync("git", ["fetch", "-q", "--prune", "origin"], { cwd: work });

    const result = spawnSync("node", [pruneScript, "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(work, ["branch", "--list", shipped]).includes(shipped),
      false,
      "plain --exec shipped path remains independent of mainline ambiguity",
    );
    assert.ok(
      git(work, ["branch", "--list", mainOnly]).includes(mainOnly),
      "main-only still survives without consent",
    );
  });
});

// ─── #2083 / D5: consent flag MUST NOT swallow advisory-bucket release/* ───

describe("prune-merged-local: --include-unshipped-mainline must not swallow release/*", () => {
  let tmp, work, bare;
  const releaseMainOnly = "release/v9.9.9-unshipped";
  const ordinaryMainOnly = "chore/ordinary-main-only";

  before(async () => {
    ({ tmp, work, bare } = await createBaseRepo());
    git(work, ["branch", "production", "main"]);
    git(work, ["push", "-q", "origin", "production"]);

    // Ordinary main-only tip — should still be deletable with consent.
    git(work, ["checkout", "-q", "-b", ordinaryMainOnly, "main"]);
    await fs.writeFile(path.join(work, "ordinary-main.txt"), "o\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "chore: ordinary main-only"]);
    git(work, ["push", "-q", "origin", ordinaryMainOnly]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "--no-ff", "-q", ordinaryMainOnly, "-m", `merge ${ordinaryMainOnly}`]);
    git(work, ["push", "-q", "origin", "main"]);
    git(work, ["push", "-q", "origin", "--delete", ordinaryMainOnly]);

    // Mainline-contained release/* that is NOT production-ancestor — advisory bucket.
    git(work, ["checkout", "-q", "-b", releaseMainOnly, "main"]);
    await fs.writeFile(path.join(work, "release-unshipped.txt"), "r\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "chore: release unshipped mainline"]);
    git(work, ["push", "-q", "origin", releaseMainOnly]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "--no-ff", "-q", releaseMainOnly, "-m", `merge ${releaseMainOnly}`]);
    git(work, ["push", "-q", "origin", "main"]);
    // Keep local release ref; delete remote so it is local advisory-bucket shaped.
    git(work, ["push", "-q", "origin", "--delete", releaseMainOnly]);
    git(work, ["fetch", "-q", "--prune", "origin"]);
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("consent --exec deletes ordinary main-only but retains mainline-contained release/*", () => {
    const cloneTmp = path.join(tmp, "release-nonswallow");
    cpSync(work, cloneTmp, { recursive: true });
    git(cloneTmp, ["remote", "set-url", "origin", bare]);
    if (!git(cloneTmp, ["branch", "--list", ordinaryMainOnly]).includes(ordinaryMainOnly)) {
      git(cloneTmp, ["branch", ordinaryMainOnly, "main"]);
    }
    if (!git(cloneTmp, ["branch", "--list", releaseMainOnly]).includes(releaseMainOnly)) {
      git(cloneTmp, ["branch", releaseMainOnly, "main"]);
    }

    const result = spawnSync(
      "node",
      [pruneScript, "--include-unshipped-mainline", "--exec"],
      { cwd: cloneTmp, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      result.stdout,
      /Deleting local branch\s+release\/v9\.9\.9-unshipped|deleted branch release\/v9\.9\.9-unshipped/i,
      "consent exec must not delete release/*",
    );
    assert.equal(
      git(cloneTmp, ["branch", "--list", ordinaryMainOnly]).includes(ordinaryMainOnly),
      false,
      "ordinary main-only must still delete with consent",
    );
    assert.ok(
      git(cloneTmp, ["branch", "--list", releaseMainOnly]).includes(releaseMainOnly),
      "mainline-contained release/* must not be swallowed by unshipped-mainline consent",
    );
  });
});

// ─── Unshipped-mainline remote TOCTOU: tip drift between scan and delete ───

describe("prune-merged-local: unshipped-mainline remote tip drift refuses delete", () => {
  let tmp, work, bare;
  const driftFirst = "chore/unshipped-drift-a";
  const driftLater = "chore/unshipped-drift-b";

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("--include-unshipped-mainline --include-remote --exec refuses when remote tip drifts mid-run", async () => {
    ({ tmp, work, bare } = await createBaseRepo());
    git(work, ["branch", "production", "main"]);
    git(work, ["push", "-q", "origin", "production"]);

    for (const name of [driftFirst, driftLater]) {
      git(work, ["checkout", "-q", "-b", name, "main"]);
      await fs.writeFile(path.join(work, `${name.replace(/\//g, "-")}.txt`), `${name}\n`);
      git(work, ["add", "."]);
      git(work, ["commit", "-q", "-m", `chore: ${name}`]);
      git(work, ["push", "-q", "-u", "origin", name]);
      git(work, ["checkout", "-q", "main"]);
      git(work, ["merge", "--no-ff", "-q", name, "-m", `merge ${name}`]);
      git(work, ["push", "-q", "origin", "main"]);
    }
    git(work, ["fetch", "-q", "--prune", "origin"]);

    const fakeBin = path.join(tmp, "fake-bin-drift");
    await fs.mkdir(fakeBin);
    const fakeGitPayload = path.join(fakeBin, "fake-git.mjs");
    const driftOnce = path.join(tmp, "drift-once.marker");
    await fs.writeFile(
      fakeGitPayload,
      `import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const realGit = process.env.DEVPRO_REAL_GIT;
const driftBranch = process.env.DEVPRO_DRIFT_BRANCH;
const bare = process.env.DEVPRO_DRIFT_BARE;
const once = process.env.DEVPRO_DRIFT_ONCE_FILE;
const isLeaseDeletePush =
  args[0] === "push" &&
  args[1] === "origin" &&
  args.some((a) => a.startsWith(\`--force-with-lease=refs/heads/\${driftBranch}:\`)) &&
  args.includes(\`:refs/heads/\${driftBranch}\`);
// Advance tip AFTER revalidation succeeded but BEFORE the leased delete runs
// (check/use race). force-with-lease must then refuse.
if (isLeaseDeletePush && once && !existsSync(once)) {
  writeFileSync(once, "1");
  const parent = spawnSync(realGit, ["-C", bare, "rev-parse", \`refs/heads/\${driftBranch}\`], {
    encoding: "utf8",
  });
  if ((parent.status ?? 1) !== 0) process.exit(parent.status ?? 1);
  const parentOid = parent.stdout.trim();
  const tree = spawnSync(realGit, ["-C", bare, "rev-parse", \`\${parentOid}^{tree}\`], {
    encoding: "utf8",
  });
  if ((tree.status ?? 1) !== 0) process.exit(tree.status ?? 1);
  const commit = spawnSync(
    realGit,
    ["-C", bare, "commit-tree", tree.stdout.trim(), "-p", parentOid, "-m", "fixture: tip drift after revalidate"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    },
  );
  if ((commit.status ?? 1) !== 0) process.exit(commit.status ?? 1);
  const upd = spawnSync(
    realGit,
    ["-C", bare, "update-ref", \`refs/heads/\${driftBranch}\`, commit.stdout.trim()],
    { encoding: "utf8" },
  );
  if ((upd.status ?? 1) !== 0) process.exit(upd.status ?? 1);
}
const result = spawnSync(realGit, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    );
    const fakeGit = path.join(fakeBin, "git");
    const dispatchWrapper = "#!/bin/sh\nexec \"$DEVPRO_NODE_EXE\" \"$DEVPRO_FAKE_GIT_PAYLOAD\" \"$@\"\n";
    await fs.writeFile(fakeGit, dispatchWrapper);
    await fs.chmod(fakeGit, 0o755);

    const result = spawnSync(
      process.execPath,
      [pruneScript, "--include-unshipped-mainline", "--include-remote", "--exec"],
      {
        cwd: work,
        encoding: "utf8",
        env: {
          ...process.env,
          DEVPRO_NODE_EXE: process.execPath,
          DEVPRO_FAKE_GIT_PAYLOAD: fakeGitPayload,
          DEVPRO_REAL_GIT: resolveExecutable("git"),
          DEVPRO_DRIFT_BRANCH: driftFirst,
          DEVPRO_DRIFT_BARE: bare,
          DEVPRO_DRIFT_ONCE_FILE: driftOnce,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        },
      },
    );

    assert.notEqual(result.status, 0, `expected non-zero on tip drift; stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /drift|refuse|retained|stale info|force-with-lease|rejected/i,
      "must mention lease refusal / retained",
    );
    assert.ok(
      git(work, ["ls-remote", "--heads", "origin", driftFirst]).includes(driftFirst),
      "drifted remote must be retained",
    );
    assert.ok(
      git(work, ["ls-remote", "--heads", "origin", driftLater]).includes(driftLater),
      "later unshipped remote must not be deleted after refuse",
    );
  });
});

// ─── query-failed + consent: invocation-wide abort (incl. shipped) ───

describe("prune-merged-local: query-failed mainline + unshipped consent aborts invocation-wide", () => {
  let tmp, work, bare;
  const shipped = "chore/qf-shipped";
  const mainOnly = "chore/qf-main-only";

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  async function buildMixedFixture() {
    ({ tmp, work, bare } = await createBaseRepo());
    git(work, ["branch", "production", "main"]);
    git(work, ["push", "-q", "origin", "production"]);

    git(work, ["checkout", "-q", "-b", shipped, "production"]);
    await fs.writeFile(path.join(work, "qf-shipped.txt"), "s\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "chore: qf shipped"]);
    git(work, ["checkout", "-q", "production"]);
    git(work, ["merge", "--no-ff", "-q", shipped, "-m", `merge ${shipped}`]);
    git(work, ["push", "-q", "origin", "production"]);
    git(work, ["push", "-q", "origin", shipped]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "--no-ff", "-q", "production", "-m", "sync"]);
    git(work, ["push", "-q", "origin", "main"]);

    git(work, ["checkout", "-q", "-b", mainOnly, "main"]);
    await fs.writeFile(path.join(work, "qf-main.txt"), "m\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "chore: qf main only"]);
    git(work, ["push", "-q", "origin", mainOnly]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "--no-ff", "-q", mainOnly, "-m", `merge ${mainOnly}`]);
    git(work, ["push", "-q", "origin", "main"]);
    git(work, ["push", "-q", "origin", "--delete", mainOnly]);
    git(work, ["fetch", "-q", "--prune", "origin"]);
  }

  async function installQueryFailedFakeGit() {
    const fakeBin = path.join(tmp, "fake-bin-qf");
    await fs.mkdir(fakeBin);
    const fakeGitPayload = path.join(fakeBin, "fake-git.mjs");
    await fs.writeFile(
      fakeGitPayload,
      `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "for-each-ref" && args.includes("--merged")) {
  process.stderr.write("fixture merged query failed\\n");
  process.exit(128);
}
const result = spawnSync(process.env.DEVPRO_REAL_GIT, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    );
    const fakeGit = path.join(fakeBin, "git");
    const dispatchWrapper = "#!/bin/sh\nexec \"$DEVPRO_NODE_EXE\" \"$DEVPRO_FAKE_GIT_PAYLOAD\" \"$@\"\n";
    await fs.writeFile(fakeGit, dispatchWrapper);
    await fs.chmod(fakeGit, 0o755);
    return {
      fakeBin,
      fakeGitPayload,
      env: {
        ...process.env,
        DEVPRO_NODE_EXE: process.execPath,
        DEVPRO_FAKE_GIT_PAYLOAD: fakeGitPayload,
        DEVPRO_REAL_GIT: resolveExecutable("git"),
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
    };
  }

  it("query-failed + --include-unshipped-mainline --exec → zero mutation including shipped", async () => {
    await buildMixedFixture();
    const { env } = await installQueryFailedFakeGit();
    const beforeShipped = git(work, ["branch", "--list", shipped]);
    const beforeMain = git(work, ["branch", "--list", mainOnly]);
    const result = spawnSync(
      process.execPath,
      [pruneScript, "--include-unshipped-mainline", "--exec"],
      { cwd: work, encoding: "utf8", env },
    );
    assert.notEqual(result.status, 0, "must abort when consent requested under query-failed mainline");
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /containment query failed|fixture merged query failed|Refusing --include-unshipped-mainline|abort|refuse|unverified/i,
    );
    assert.ok(git(work, ["branch", "--list", shipped]).includes(shipped), "shipped must be retained");
    assert.ok(git(work, ["branch", "--list", mainOnly]).includes(mainOnly), "main-only must be retained");
    assert.equal(git(work, ["branch", "--list", shipped]), beforeShipped);
    assert.equal(git(work, ["branch", "--list", mainOnly]), beforeMain);
  });

  it("query-failed + consent + include-remote → zero mutation including remotes", async () => {
    await buildMixedFixture();
    const { env } = await installQueryFailedFakeGit();
    const result = spawnSync(
      process.execPath,
      [pruneScript, "--include-unshipped-mainline", "--include-remote", "--exec"],
      { cwd: work, encoding: "utf8", env },
    );
    assert.notEqual(result.status, 0);
    assert.ok(git(work, ["branch", "--list", shipped]).includes(shipped));
    assert.ok(git(work, ["ls-remote", "--heads", "origin", shipped]).includes(shipped));
    assert.ok(git(work, ["branch", "--list", mainOnly]).includes(mainOnly));
  });
});
