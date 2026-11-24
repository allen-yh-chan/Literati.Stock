import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultMainCheckoutRoot,
  defaultRepoStateDir,
  probeGitCommonDir,
  repoStateIdentity,
  resolveMainCheckoutRoot,
  REPO_STATE_ROOT_UNDER_WORKTREE_TOKEN,
} from "../hooks/lib/repo-state-identity.mjs";
import { buildRuleLoadHostDiagnostic } from "../hooks/lib/rule-load-host-diagnostics.mjs";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "repo-state-identity-test-"));

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

let counter = 0;

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result.stdout.trim();
}

function makeGitRepo() {
  const repo = path.join(tmpRoot, `repo-${counter++}`);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Devpro Test"]);
  writeFileSync(path.join(repo, "README.md"), "test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

test("repo state identity is shared by linked worktrees", () => {
  const repo = makeGitRepo();
  const worktree = path.join(tmpRoot, `linked-${counter++}`);
  git(repo, ["worktree", "add", "-b", "bugfix/linked-state", worktree]);

  assert.equal(
    repoStateIdentity(repo),
    repoStateIdentity(worktree),
    "main worktree and linked worktree should share git common-dir identity"
  );
  assert.equal(
    defaultRepoStateDir("devpro-postmerge-state", repo),
    defaultRepoStateDir("devpro-postmerge-state", worktree),
    "post-merge marker state dir should be shared by linked worktrees"
  );
});

test("repo state dir uses notes/tmp/state path shape (no os.tmpdir, no hash)", () => {
  const repo = makeGitRepo();
  const result = defaultRepoStateDir("devpro-postmerge-state", repo);
  // MUST end with notes/tmp/state/devpro-postmerge-state
  assert.ok(
    result.endsWith(path.join("notes", "tmp", "state", "devpro-postmerge-state")),
    `Expected path ending with notes/tmp/state/devpro-postmerge-state, got: ${result}`
  );
  // MUST be under the repo root — the load-bearing invariant, robust on all platforms.
  // (A `!result.startsWith(os.tmpdir())` negative would be WRONG here: the test repo is itself
  //  created under tmpdir, so on Linux the repo-local state path legitimately starts with /tmp
  //  and that negative would fail; it only "passed" on macOS via the /var→/private/var realpath
  //  accident. The positive "under repo" assertion is the correct, cross-platform invariant.)
  // realpath both sides so the macOS symlink divergence does not cause a false miss.
  assert.ok(
    realpathSync(result.slice(0, result.indexOf(`${path.sep}notes${path.sep}tmp`))).startsWith(realpathSync(repo)),
    `Expected state path under repo root ${repo}, got: ${result}`
  );
  // MUST NOT contain a 12-hex hash segment
  assert.doesNotMatch(result, /-[0-9a-f]{12}(\/|$)/, `Path must not contain repo hash`);
});

test("main checkout and linked worktree share same notes/tmp/state path", () => {
  const repo = makeGitRepo();
  const worktree = path.join(tmpRoot, `linked2-${counter++}`);
  git(repo, ["worktree", "add", "-b", "bugfix/linked-state2", worktree]);

  const mainDir = defaultRepoStateDir("devpro-postmerge-state", repo);
  const wtDir = defaultRepoStateDir("devpro-postmerge-state", worktree);
  assert.equal(mainDir, wtDir, "main checkout and linked worktree MUST share same state dir");
});

// Perf guard: `repoStateIdentity` is called repeatedly within one short-lived
// hook process and each call otherwise costs a real `git rev-parse
// --git-common-dir` fork+exec (tier spawn census: 1304 duplicate calls, the
// single largest in-process duplicate in the integration tier). The answer is
// structurally invariant per cwd, so it is memoized per resolved cwd — same
// pattern and rationale as `getRepoRoot` in hooks/lib/git-utils.mjs.
// Asserting the memo directly: once resolved, the answer survives the git dir
// going away. Without the memo the second call falls back to realpath(cwd).
test("repoStateIdentity memoizes the common-dir probe per cwd", () => {
  const repo = makeGitRepo();
  const first = repoStateIdentity(repo);
  assert.equal(first, realpathSync(path.join(repo, ".git")), "sanity: resolves to the repo's .git");

  rmSync(path.join(repo, ".git"), { recursive: true, force: true });

  assert.equal(
    repoStateIdentity(repo),
    first,
    "repeated call for the same cwd MUST reuse the memoized common-dir, not re-spawn git"
  );
});

test("repoStateIdentity does not memoize the fail-open fallback", () => {
  // Only successful resolutions are cached: caching the non-git fallback would
  // turn one transient git failure into a process-wide wrong answer.
  const plain = path.join(tmpRoot, `plain-${counter++}`);
  mkdirSync(plain, { recursive: true });
  assert.equal(repoStateIdentity(plain), realpathSync(plain), "non-git dir falls back to realpath(cwd)");

  git(plain, ["init", "-b", "main"]);
  assert.equal(
    repoStateIdentity(plain),
    realpathSync(path.join(plain, ".git")),
    "after the dir becomes a real repo the fallback MUST NOT be sticky"
  );
});

// `git rev-parse --git-common-dir` is ONE structural invariant that used to be
// probed with four different argv shapes across six call sites, none of them
// sharing a memo. probeGitCommonDir is the single shared probe. It deliberately
// does NOT decide a fallback: the callers' fail modes are genuinely different
// (repoStateIdentity fails open to realpath(cwd); run-test-suite falls back to
// the passed repo root; second-reviewer-cli-recipe-contract MUST fail closed by
// throwing, because its value feeds a reviewer-writable containment boundary),
// so unifying the return value would have flipped a fail-closed gate open.
test("probeGitCommonDir returns an absolute common-dir and reports success", () => {
  const repo = makeGitRepo();
  const probe = probeGitCommonDir(repo);

  assert.equal(probe.ok, true, "probing a real repo must succeed");
  assert.ok(path.isAbsolute(probe.commonDir), `common-dir must be absolute, got: ${probe.commonDir}`);
  assert.equal(
    realpathSync(probe.commonDir),
    realpathSync(path.join(repo, ".git")),
    "must resolve to the repo's .git"
  );
});

test("probeGitCommonDir memoizes successes per cwd", () => {
  const repo = makeGitRepo();
  const first = probeGitCommonDir(repo);
  assert.equal(first.ok, true);

  // Removing .git would make a fresh probe fail; a memoized answer survives it.
  rmSync(path.join(repo, ".git"), { recursive: true, force: true });

  const second = probeGitCommonDir(repo);
  assert.equal(second.ok, true, "repeated probe for the same cwd MUST come from the memo");
  assert.equal(second.commonDir, first.commonDir);
});

test("probeGitCommonDir reports failure without throwing and without memoizing it", () => {
  const plain = path.join(tmpRoot, `probe-plain-${counter++}`);
  mkdirSync(plain, { recursive: true });

  const failed = probeGitCommonDir(plain);
  assert.equal(failed.ok, false, "a non-git dir must report failure, not throw");
  assert.equal(failed.commonDir, "", "a failed probe carries no common-dir");

  // A failure must stay retryable: caching it would turn one transient git
  // failure into a process-wide wrong answer.
  git(plain, ["init", "-b", "main"]);
  const retried = probeGitCommonDir(plain);
  assert.equal(retried.ok, true, "the failed probe MUST NOT be sticky once the dir becomes a repo");
  assert.equal(
    realpathSync(retried.commonDir),
    realpathSync(path.join(plain, ".git")),
    "the retry must return the real common-dir"
  );
});

// The spawn cap is part of a caller's FAIL MODE, not of the probe's identity, so
// it stays per-caller like every other disposition here. Five of the six call
// sites had no timeout at all; only repoStateIdentity did (hooks are one-shot, so
// a hung git would hang the hook). Capping all six at 2s would have been a silent
// regression at the two call sites that fail quietly -- run-test-suite.mjs falls
// back to the repo root it was handed, which is where notes/tmp tier logs land,
// and hook-command-context.mjs falls open to "" -- both under an integration tier
// that spawns ~19k processes at load average 20-26.
test("probeGitCommonDir honours an explicit timeout and does not memoize the timeout", () => {
  const repo = makeGitRepo();

  // 1ms cannot cover a fork+exec, so this must report failure rather than throw.
  const capped = probeGitCommonDir(repo, { timeoutMs: 1 });
  assert.equal(capped.ok, false, "an unmeetable timeout must surface as ok:false");
  assert.equal(capped.commonDir, "", "a timed-out probe carries no common-dir");

  // The uncapped default must still succeed for the same cwd: a timeout is a
  // transient failure and MUST NOT latch into the shared memo.
  const uncapped = probeGitCommonDir(repo);
  assert.equal(uncapped.ok, true, "the default probe MUST NOT inherit the caller's cap");
  assert.equal(
    realpathSync(uncapped.commonDir),
    realpathSync(path.join(repo, ".git")),
    "the uncapped probe must return the real common-dir"
  );
});

test("two independent repos have different notes/tmp/state paths", () => {
  const repo1 = makeGitRepo();
  const repo2 = makeGitRepo();
  const dir1 = defaultRepoStateDir("devpro-postmerge-state", repo1);
  const dir2 = defaultRepoStateDir("devpro-postmerge-state", repo2);
  assert.notEqual(dir1, dir2, "two different repos MUST NOT share state dir");
});

// #2497 prove-it: fail-open under linked-worktree-shaped cwd must NOT dirname-peel
// into `<main>/.worktree` and invent `.worktree/notes/tmp/state/...`.
test("fail-open under .worktree leaf does not place state under .worktree/notes", () => {
  const main = path.join(tmpRoot, `main-fo-${counter++}`);
  const leaf = path.join(main, ".worktree", "change-x");
  mkdirSync(leaf, { recursive: true });

  const dir = defaultRepoStateDir("devpro-postmerge-state", leaf);
  const normalized = dir.split(path.sep).join("/");
  assert.ok(
    !normalized.includes("/.worktree/notes/"),
    `fail-open state path MUST NOT contain /.worktree/notes/; got: ${dir}`
  );
  assert.ok(
    normalized.endsWith("/notes/tmp/state/devpro-postmerge-state"),
    `Expected notes/tmp/state/<prefix> under main checkout, got: ${dir}`
  );
  assert.equal(
    realpathSync(defaultMainCheckoutRoot(leaf)),
    realpathSync(main),
    "B root semantics: climb out of .worktree/<leaf> to main checkout"
  );

  const resolved = resolveMainCheckoutRoot(leaf);
  assert.equal(resolved.identitySource, "fallback");
  assert.equal(realpathSync(resolved.mainCheckoutRoot), realpathSync(main));
});

test("forced probe failure on linked-worktree-shaped cwd uses B climb", () => {
  const repo = makeGitRepo();
  const leaf = path.join(repo, ".worktree", "linked-shape");
  mkdirSync(leaf, { recursive: true });

  const resolved = resolveMainCheckoutRoot(leaf, {
    probeResult: { ok: false, commonDir: "", error: new Error("forced") },
  });
  assert.equal(resolved.identitySource, "fallback");
  assert.equal(realpathSync(resolved.mainCheckoutRoot), realpathSync(repo));

  const dir = defaultRepoStateDir("devpro-postmerge-state", leaf, {
    resolveOptions: {
      probeResult: { ok: false, commonDir: "", error: new Error("forced") },
    },
  });
  const normalized = dir.split(path.sep).join("/");
  assert.ok(!normalized.includes("/.worktree/notes/"), `got: ${dir}`);
});

test("defaultRepoStateDir hard-fails when root would land under .worktree", () => {
  const under = path.join(tmpRoot, `under-wt-${counter++}`, ".worktree", "bogus-root");
  mkdirSync(under, { recursive: true });
  assert.throws(
    () => defaultRepoStateDir("devpro-postmerge-state", tmpRoot, { mainCheckoutRoot: under }),
    (err) => String(err?.message || err).includes(REPO_STATE_ROOT_UNDER_WORKTREE_TOKEN)
  );
});

test("successful common-dir path stamps identitySource git-common-dir", () => {
  const repo = makeGitRepo();
  const resolved = resolveMainCheckoutRoot(repo);
  assert.equal(resolved.identitySource, "git-common-dir");
  assert.equal(realpathSync(resolved.mainCheckoutRoot), realpathSync(repo));
});

test("host diagnostic stamps identitySource fallback on fail-open root", () => {
  const main = path.join(tmpRoot, `diag-main-${counter++}`);
  const leaf = path.join(main, ".worktree", "diag-leaf");
  mkdirSync(leaf, { recursive: true });
  const entry = buildRuleLoadHostDiagnostic(
    {
      tool_name: "Read",
      tool_input: { file_path: path.join(leaf, ".devpro/agent-rules/ai-autonomy.md") },
      cwd: leaf,
      session_id: "test-session-identity-source",
    },
    { repoRoot: leaf }
  );
  assert.equal(entry.identitySource, "fallback");
});
