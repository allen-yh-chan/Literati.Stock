/**
 * pre-tool-gate-false-positives.test.mjs
 *
 * Regression tests for false-positive bug fixes in pre-tool-gate.mjs:
 *
 * FP1 - Regex incorrectly matched `git merge-base main HEAD` as upstream
 *        pollution (merge-base is a read-only plumbing command, not a merge).
 *        Fix: `(?:merge\b(?!-)|pull\b)` negative lookahead excludes `merge-*`.
 *
 * FP2 - `commandCwd()` did not parse leading `cd <path> &&` in chained
 *        commands, causing the hook to use the wrong cwd (worktree branch
 *        instead of the target repo's branch) and false-block `git pull`.
 *        Fix: detect `^\s*cd\s+<path>\s*(?:&&|;)` at the start of the command.
 *
 * FP4 - Upstream pollution regex matched literal git merge/pull text inside
 *        heredoc bodies (e.g., gh pr create --body "$(cat <<EOF ... EOF)").
 *        Fix: shell-aware segmentation via lib/shell-context.mjs::segmentCommand
 *        + commandSegmentText filters heredoc bodies before regex test
 *        (refactored v6.33.0; previous narrow fix `stripHeredocsForGate`
 *        superseded by full segment-aware parser per
 *        archive/2026-05-04-refactor-pre-tool-gate-shell-aware/).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Import named exports added for unit testing
import {
  commandCwd,
  checkUpstreamPollution,
} from "../hooks/pre-tool-gate.mjs";
import {
  UNRESOLVABLE_CWD,
  commandCwdAt,
  mapMsysDrivePath,
  resolveHostFilesystemPath,
} from "../hooks/lib/hook-command-context.mjs";
import * as preToolGate from "../hooks/pre-tool-gate.mjs";

// Message text is data; the source ref determines upstream pollution.
for (const cmd of [
  'git merge --no-ff production-v7.8.1 -m "fix: reconcile production-v7.8.1 ancestry into main"',
  "git merge -m 'merge integration into main' production-v7.8.1",
  'git merge --message="merge main and integration" production-v7.8.1',
  'git merge -m"main and integration" production-v7.8.1',
  'git merge -m main production-v7.8.1',
  'git merge production-v7.8.1 -m "main; integration && next"',
  'git pull --shallow-exclude main',
  'git pull --negotiation-tip main',
  'git pull --shallow-since main',
  'git pull --deepen main',
  'git pull --jobs main',
  'git pull -j main',
  'git pull -o integration',
]) {
  test(`upstream message data is ignored: ${cmd}`, () => {
    assert.equal(checkUpstreamPollution(cmd, "bugfix/repair"), null);
  });
}
for (const cmd of [
  'git merge "main" -m "release"',
  "git merge 'origin/integration' -m 'release'",
  'git merge production-v7.8.1 -m "main" && git merge origin/main',
  'git merge -m "release" main',
  'git merge --log main',
  'git merge refs/heads/main',
  'git pull origin main:local-main',
  'git merge main@{upstream}',
  'git merge heads/main',
  'git merge fork/main',
  'git merge refs/remotes/fork/main',
  'git pull origin +main:refs/remotes/origin/main',
  'git merge integration@{upstream}',
  'git merge heads/integration',
  'git merge fork/integration',
  'git merge refs/remotes/fork/integration',
  'git pull origin +integration:refs/remotes/origin/integration',
  'git merge feature -m "sync; prep" main',
  'git merge feature -m "sync && prep" integration',
]) {
  test(`real upstream source remains blocked: ${cmd}`, () => {
    assert.equal(checkUpstreamPollution(cmd, "bugfix/repair")?.block, true);
  });
}

// ── Helper: set up a minimal git repo on a given branch ──────────────────
const tmpRoot = mkdtempSync(path.join(tmpdir(), "pre-tool-gate-fp-test-"));
const hookPath = fileURLToPath(new URL("../hooks/pre-tool-gate.mjs", import.meta.url));

let repoCounter = 0;
function setupRepo(branchName) {
  const dir = path.join(tmpRoot, `repo-${repoCounter++}`);
  mkdirSync(dir, { recursive: true });
  const env = fixtureGitEnv(dir, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t.com",
  });
  spawnSync("git", ["init", "-q", "-b", branchName], { cwd: dir, env });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, env });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir, env });
  spawnSync("git", ["config", "core.autocrlf", "false"], { cwd: dir, env });
  spawnSync("git", ["config", "core.symlinks", "true"], { cwd: dir, env });
  writeFileSync(path.join(dir, "x"), "");
  spawnSync("git", ["add", "x"], { cwd: dir, env });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
  return dir;
}

function fixtureGitEnv(cwd, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(cwd, ".git", "fixture-global-config"),
    ...overrides,
  };
}

function runPreToolHook(command, cwd) {
  const payload = {
    tool_name: "Bash",
    tool_input: { command, cwd },
  };
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...fixtureGitEnv(cwd), CODEX_THREAD_ID: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  const stdout = (r.stdout || "").trim();
  return stdout ? JSON.parse(stdout) : null;
}

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test("shared command context: normalizes all ten hook-visible cwd aliases", () => {
  const cases = [
    [{ cwd: tmpRoot }, {}],
    [{ workdir: tmpRoot }, {}],
    [{ working_dir: tmpRoot }, {}],
    [{ workingDir: tmpRoot }, {}],
    [{}, { cwd: tmpRoot }],
    [{}, { workdir: tmpRoot }],
    [{}, { working_dir: tmpRoot }],
    [{}, { workingDir: tmpRoot }],
    [{}, { current_working_directory: tmpRoot }],
    [{}, { currentWorkingDirectory: tmpRoot }],
  ];

  for (const [toolInput, payload] of cases) {
    assert.equal(preToolGate.toolInputCwd(toolInput, payload), tmpRoot);
  }
});

test("shared command context: reads working_directory / workingDirectory (execution cwd; not binding authority)", () => {
  assert.equal(preToolGate.toolInputCwd({ working_directory: tmpRoot }, {}), tmpRoot);
  assert.equal(preToolGate.toolInputCwd({ workingDirectory: tmpRoot }, {}), tmpRoot);
  assert.equal(preToolGate.toolInputCwd({}, { working_directory: tmpRoot }), tmpRoot);
  assert.equal(preToolGate.toolInputCwd({}, { workingDirectory: tmpRoot }), tmpRoot);
  // Binding-safe path MUST ignore working_directory／workingDirectory (D2).
  const bindingFromTool = preToolGate.toolInputBindingCwd({ working_directory: tmpRoot }, {});
  const bindingFromPayload = preToolGate.toolInputBindingCwd({}, { workingDirectory: tmpRoot });
  assert.notEqual(bindingFromTool, tmpRoot);
  assert.notEqual(bindingFromPayload, tmpRoot);
  assert.equal(bindingFromTool, preToolGate.toolInputBindingCwd({}, {}));
  assert.equal(bindingFromPayload, preToolGate.toolInputBindingCwd({}, {}));
});

test("shared command context: commandCwdAt tracks cd, pushd, and popd at each gh position", () => {
  const base = setupRepo("chore/base");
  const first = setupRepo("chore/first");
  const second = setupRepo("chore/second");
  const command = `cd '${first}'; gh issue comment 1 --body first; pushd '${second}'; gh pr create --body second; popd; gh pr create --body third`;
  const firstGh = command.indexOf("gh issue");
  const secondGh = command.indexOf("gh pr create");
  const thirdGh = command.lastIndexOf("gh pr create");

  assert.equal(preToolGate.commandCwdAt(command, base, firstGh, "gh"), first);
  assert.equal(preToolGate.commandCwdAt(command, base, secondGh, "gh"), second);
  assert.equal(preToolGate.commandCwdAt(command, base, thirdGh, "gh"), first);
});

test("shared command context: quoted, comment, and heredoc cd text is data, not cwd mutation", () => {
  const base = setupRepo("chore/base-data");
  const target = setupRepo("chore/target-data");
  const commands = [
    `echo "cd /not-real"; cd '${target}'; gh pr create --body quoted`,
    `# cd /not-real\ncd '${target}'\ngh pr create --body comment`,
    `cat <<'EOF'\ncd /not-real\nEOF\ncd '${target}'\ngh pr create --body heredoc`,
  ];

  for (const command of commands) {
    const ghIndex = command.lastIndexOf("gh pr create");
    assert.equal(preToolGate.commandCwdAt(command, base, ghIndex, "gh"), target);
  }
});

test("shared command context: unresolved shell cwd returns the fail-closed sentinel", () => {
  const base = setupRepo("chore/base-unresolved");
  const command = "CDPATH=/tmp; cd relative; gh pr create --body unresolved";
  assert.equal(
    preToolGate.commandCwdAt(command, base, command.indexOf("gh pr create"), "gh"),
    preToolGate.UNRESOLVABLE_CWD
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// FP1 tests — regex: `(?:merge\b(?!-)|pull\b)`
// ─────────────────────────────────────────────────────────────────────────────

test("FP1 positive: git merge-base main HEAD on chore branch → NOT blocked", () => {
  const cmd = "git merge-base main HEAD";
  const branch = "chore/some-feature";
  const result = checkUpstreamPollution(cmd, branch);
  assert.equal(
    result,
    null,
    `Expected null (not blocked) but got: ${JSON.stringify(result)}`
  );
});

test("FP1 negative: git merge origin/main on chore branch → STILL blocked", () => {
  const cmd = "git merge origin/main";
  const branch = "chore/some-feature";
  const result = checkUpstreamPollution(cmd, branch);
  assert.ok(result !== null, "Expected a block result but got null");
  assert.equal(result.block, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// FP2 tests — commandCwd() parsing of leading `cd <path> &&`
// ─────────────────────────────────────────────────────────────────────────────

test("FP2 positive: cd <main-repo> && git pull origin main → commandCwd resolves to main-repo path", () => {
  const mainRepo = setupRepo("main");
  const choreWorktree = setupRepo("chore/fix-something");

  const cmd = `cd ${mainRepo} && git pull origin main`;
  const resolved = commandCwd(cmd, choreWorktree);

  assert.equal(
    resolved,
    mainRepo,
    `Expected ${mainRepo} but got ${resolved}`
  );

  const pollutionResult = checkUpstreamPollution(
    "git pull origin main",
    "main"
  );
  assert.equal(
    pollutionResult,
    null,
    "Expected null for git pull origin main when on main branch"
  );
});

test("shared command context: git -C path containing git/gh text resolves the target token", () => {
  const base = setupRepo("chore/base-command-index");
  const targetParent = setupRepo("chore/parent-command-index");
  const target = path.join(targetParent, "git-gh-target");
  mkdirSync(target);

  assert.equal(commandCwd(`git -C '${target}' status`, base), target);
});

test("FP2 negative: git pull origin main (no cd) on chore branch → STILL blocked", () => {
  const cmd = "git pull origin main";
  const branch = "chore/fix-something";
  const result = checkUpstreamPollution(cmd, branch);
  assert.ok(result !== null, "Expected a block result but got null");
  assert.equal(result.block, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// FP4 tests — shell-aware segmentation (lib/shell-context.mjs) filters
// heredoc bodies before regex test (refactored v6.33.0)
// ─────────────────────────────────────────────────────────────────────────────

test("FP4 positive: heredoc body with literal 'git merge origin/main' on chore branch → NOT blocked", () => {
  // Simulates: gh pr create --body "$(cat <<EOF\n...\nEOF\n)"
  // Body text mentioning git verbs must not trigger the pollution gate.
  const cmd = [
    `gh pr create --base main --title "chore: my pr" --body "$(cat <<EOF`,
    `## Test plan`,
    `- real \`git merge origin/main\` form still blocked`,
    `EOF`,
    `)"`,
  ].join("\n");
  const result = checkUpstreamPollution(cmd, "chore/my-pr");
  assert.equal(result, null, `Expected null (not blocked) but got: ${JSON.stringify(result)}`);
});

test("FP4 positive: <<'EOF' single-quoted tag with literal 'git pull main' → NOT blocked", () => {
  const cmd = [
    `gh pr create --base main --title "chore: test" --body "$(cat <<'EOF'`,
    `## Summary`,
    `Avoids the need to run git pull main manually`,
    `EOF`,
    `)"`,
  ].join("\n");
  const result = checkUpstreamPollution(cmd, "chore/my-pr");
  assert.equal(result, null);
});

test("FP4 positive: <<-EOF (hyphen flag) with literal git merge main → NOT blocked", () => {
  const cmd = [
    `gh pr create --base main --title "chore: test" --body "$(cat <<-EOF`,
    `\t## Summary`,
    `\tDo NOT git merge main into feature branches`,
    `\tEOF`,
    `)"`,
  ].join("\n");
  const result = checkUpstreamPollution(cmd, "chore/my-pr");
  assert.equal(result, null);
});

test('FP4 positive: <<"EOF" double-quoted tag with literal git merge main → NOT blocked', () => {
  const cmd = [
    `gh pr create --base main --title "chore: test" --body "$(cat <<"EOF"`,
    `## Summary`,
    `Avoid running git merge main on feature branches`,
    `EOF`,
    `)"`,
  ].join("\n");
  const result = checkUpstreamPollution(cmd, "chore/my-pr");
  assert.equal(result, null);
});

test("FP4 positive: heredoc with literal 'git merge integration' on release/* branch → NOT blocked", () => {
  // Companion coverage: strip applies to MERGE_PULL_INTEGRATION_RE too.
  const cmd = [
    `gh pr create --base production --title "release notes" --body "$(cat <<EOF`,
    `## Summary`,
    `Do NOT git merge integration into release subset`,
    `EOF`,
    `)"`,
  ].join("\n");
  const result = checkUpstreamPollution(cmd, "release/v1.2.3");
  assert.equal(result, null);
});

test("FP4 negative: heredoc body literal + chained real 'git merge main' outside → STILL blocked", () => {
  // Heredoc body has a literal mention, but OUTSIDE the heredoc there is
  // also a real `git merge main` chained with &&. After stripping the heredoc,
  // the outer real merge must still be caught.
  const cmd = [
    `gh pr create --base main --title "chore: test" --body "$(cat <<EOF`,
    `## Summary`,
    `Do not git merge origin/main`,
    `EOF`,
    `)" && git merge main`,
  ].join("\n");
  const result = checkUpstreamPollution(cmd, "chore/my-pr");
  assert.ok(result !== null, "Expected a block result but got null");
  assert.equal(result.block, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// FP5 tests — chained `git switch X && git pull/merge X` effective-branch
// analysis. Hook fires before chain runs, so current branch is still pre-
// switch. Walk &&-segments tracking virtual branch; if pull-target was
// switched-to in chain, the operation is legitimate (not pollution).
// ─────────────────────────────────────────────────────────────────────────────

test("FP5 positive: git switch main && git pull --ff-only origin main on chore branch → NOT blocked", () => {
  // Canonical "switch and sync" pattern. Hook reads current branch as
  // chore/* but chain effectively pulls on main.
  const cmd = "git switch main && git pull --ff-only origin main";
  const branch = "chore/some-feature";
  const result = checkUpstreamPollution(cmd, branch);
  assert.equal(
    result,
    null,
    `Expected null (chain effective branch=main) but got: ${JSON.stringify(result)}`
  );
});

test("FP5 positive: git checkout main && git pull origin main → NOT blocked", () => {
  // Same as above with `checkout` verb (older syntax, still valid).
  const cmd = "git checkout main && git pull origin main";
  const branch = "bugfix/something";
  const result = checkUpstreamPollution(cmd, branch);
  assert.equal(result, null);
});

test("FP5 positive: git switch main && git fetch && git pull origin main → NOT blocked", () => {
  // Multi-step chain: switch first, then fetch (no-op for branch state),
  // then pull. Virtual branch at pull time = main → allow.
  const cmd = "git switch main && git fetch origin && git pull --ff-only origin main";
  const branch = "feature/xyz";
  const result = checkUpstreamPollution(cmd, branch);
  assert.equal(result, null);
});

test("FP5 positive: an assignment with an escaped space or a quoted part in front of git switch main still switches (PR #3703 r9 W2-F3)", () => {
  // The assignment value is one shell word, so the switch after it is read and the pull runs on main.
  // A special parameter ($$, $?) and a value joining bare and quoted parts are one word too (PR #3703 r10 W2-F3, W8-F3).
  for (const cmd of ["GIT_TRACE=/tmp/a\\ b git switch main && git pull --ff-only origin main", 'GIT_TRACE="/tmp/a b" git switch main && git pull --ff-only origin main', "http_proxy=/tmp/a\\ b git switch main && git pull --ff-only origin main", "TRACE_ID=$$ git switch main && git pull --ff-only origin main", "LAST=$? git switch main && git pull --ff-only origin main", 'GIT_TRACE=/tmp/"a b"/c git switch main && git pull --ff-only origin main']) {
    assert.equal(checkUpstreamPollution(cmd, "chore/some-feature"), null, cmd);
  }
  // The same prefix in front of a switch to another branch still leaves the pull on a non-main branch.
  const other = checkUpstreamPollution("GIT_TRACE=/tmp/a\\ b git switch other-branch && git pull origin main", "chore/some-pr");
  assert.equal(other?.block, true, JSON.stringify(other));
});

test("FP5 negative: git switch X && git pull origin main (X != main) → STILL blocked", () => {
  // Switching to a non-main branch still leaves pull-on-non-main as pollution.
  const cmd = "git switch other-branch && git pull origin main";
  const branch = "chore/some-pr";
  const result = checkUpstreamPollution(cmd, branch);
  assert.ok(result !== null, "Expected a block result but got null");
  assert.equal(result.block, true);
});

test("FP5 negative: git pull origin main && git switch main (pull BEFORE switch) → STILL blocked", () => {
  // Order matters — pull happens BEFORE switch in this chain. Virtual branch
  // at pull time is still pre-switch (chore/*) → pollution.
  const cmd = "git pull origin main && git switch main";
  const branch = "chore/some-pr";
  const result = checkUpstreamPollution(cmd, branch);
  assert.ok(result !== null, "Expected a block result but got null");
  assert.equal(result.block, true);
});

test("FP5 positive: git switch main; git pull origin main (semicolon chain) → NOT blocked", () => {
  // Semicolon is also a chain separator (sequential, even on prior failure).
  const cmd = "git switch main; git pull origin main";
  const branch = "chore/foo";
  const result = checkUpstreamPollution(cmd, branch);
  assert.equal(result, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// FP6 tests — same chain-effective-branch logic for integration target.
// Mirrors FP5 but for `git pull/merge integration`. Per release flow,
// integration is receive-only-from-main; pulling integration into any other
// branch pollutes (release/feature/bugfix/etc). The chain pattern
// `git switch integration && git pull origin integration` should pass
// because virtual branch at pull time is integration.
// ─────────────────────────────────────────────────────────────────────────────

test("FP6 positive: git switch integration && git pull origin integration on release branch → NOT blocked", () => {
  const cmd = "git switch integration && git pull origin integration";
  const branch = "release/v1.2.3";
  const result = checkUpstreamPollution(cmd, branch);
  assert.equal(
    result,
    null,
    `Expected null (chain effective branch=integration) but got: ${JSON.stringify(result)}`
  );
});

test("FP6 positive: git checkout integration && git merge origin/integration on chore branch → NOT blocked", () => {
  const cmd = "git checkout integration && git merge origin/integration";
  const branch = "chore/some-task";
  const result = checkUpstreamPollution(cmd, branch);
  assert.equal(result, null);
});

test("FP6 negative: git pull origin integration on release branch (no switch) → STILL blocked", () => {
  const cmd = "git pull origin integration";
  const branch = "release/v1.2.3";
  const result = checkUpstreamPollution(cmd, branch);
  assert.ok(result !== null, "Expected a block result but got null");
  assert.equal(result.block, true);
});

test("FP6 negative: git switch other && git pull origin integration → STILL blocked", () => {
  const cmd = "git switch some-feature && git pull origin integration";
  const branch = "chore/foo";
  const result = checkUpstreamPollution(cmd, branch);
  assert.ok(result !== null, "Expected a block result but got null");
  assert.equal(result.block, true);
});

test("FP6 negative: git pull origin integration && git switch integration (wrong order) → STILL blocked", () => {
  const cmd = "git pull origin integration && git switch integration";
  const branch = "release/v1.2.3";
  const result = checkUpstreamPollution(cmd, branch);
  assert.ok(result !== null, "Expected a block result but got null");
  assert.equal(result.block, true);
});

// FP7 tests — integration branch is legitimate target for `git merge main`.
// Per release-sit-uat-pat-prod.md L107 (Step 1) + L260 (integration governance):
// integration is the receive-only-from-main canonical target. Before this fix,
// the hook's allowMergeMain condition missed `integration`, causing release
// Step 1 to be blocked despite explicit SSOT rule (issue #770).

test("FP7 positive: integration branch + git merge origin/main → NOT blocked (release Step 1)", () => {
  const cmd = "git merge origin/main";
  const branch = "integration";
  const result = checkUpstreamPollution(cmd, branch);
  assert.equal(result, null, "integration should be legal merge-main target per release-sit-uat-pat-prod.md L107 / L260");
});

test("FP7 positive: integration branch + git pull origin main → NOT blocked", () => {
  const cmd = "git pull origin main";
  const branch = "integration";
  const result = checkUpstreamPollution(cmd, branch);
  assert.equal(result, null, "integration pull from main is legal");
});

test("FP7 positive: chain switch integration && git merge origin/main → NOT blocked", () => {
  const cmd = "git switch integration && git merge origin/main";
  const branch = "chore/some-task";
  const result = checkUpstreamPollution(cmd, branch);
  assert.equal(result, null, "chain analysis should treat virtual branch=integration as legal");
});

test("FP7 negative: feature/X branch + git merge origin/main → STILL blocked (regression guard)", () => {
  const cmd = "git merge origin/main";
  const branch = "feature/some-feature";
  const result = checkUpstreamPollution(cmd, branch);
  assert.ok(result !== null, "feature branches must NOT receive main merge (subset pollution)");
  assert.equal(result.block, true);
  assert.match(result.reason, /Upstream pollution gate/);
  assert.match(result.reason, /integration/, "block reason should list integration in legal scenarios");
});

test("FP7 negative: bugfix/X branch + git pull origin main → STILL blocked (regression guard)", () => {
  const cmd = "git pull origin main";
  const branch = "bugfix/some-fix";
  const result = checkUpstreamPollution(cmd, branch);
  assert.ok(result !== null, "bugfix branches must NOT receive main pull");
  assert.equal(result.block, true);
});

// FP8 tests — help/introspection command segments are read-only and must not
// trigger intent gates. A later real command in the same Bash payload must still
// be evaluated.

test("FP8 positive: git push --force --help pipeline → NOT blocked by force-push gate", () => {
  const repo = setupRepo("feature/read-help");
  const result = runPreToolHook("git push --force --help | sed -n '1,40p'", repo);
  assert.notEqual(
    result?.decision,
    "block",
    `help/introspection must not be hard-blocked; got: ${JSON.stringify(result)}`
  );
});

test("FP8 negative: help segment then real git push --force → STILL blocked", () => {
  const repo = setupRepo("feature/read-help");
  const result = runPreToolHook("git push --force --help ; git push --force", repo);
  assert.equal(result?.decision, "block", `real force-push must still be blocked; got: ${JSON.stringify(result)}`);
  assert.match(result.reason, /Force-push gate/);
});

test("Git Bash POSIX drive path maps to a Windows host path", () => {
  assert.equal(mapMsysDrivePath("/c/Users/me/repo"), "C:\\Users\\me\\repo");
  assert.equal(mapMsysDrivePath("/d"), "D:\\");
  const existing = setupRepo("main");
  assert.equal(resolveHostFilesystemPath(existing), existing);
  if (process.platform !== "win32") {
    assert.equal(
      resolveHostFilesystemPath("/c/Users/me/repo"),
      "/c/Users/me/repo",
      "POSIX hosts must not reinterpret /c/... as a Windows drive path"
    );
  }
});

function toGitBashDrivePath(nativePath) {
  const parsed = path.win32.parse(nativePath);
  const drive = parsed.root.slice(0, 1).toLowerCase();
  const rest = nativePath.slice(parsed.root.length).replace(/\\/g, "/");
  return `/${drive}/${rest}`;
}

function normalizeObservedCwd(value) {
  return process.platform === "win32" ? path.win32.normalize(value) : path.normalize(value);
}

test("CWD matrix resolves native forms and rejects cross-drive/unrelated escapes", () => {
  const base = setupRepo("main");
  const child = path.join(base, "cwd-child");
  mkdirSync(child, { recursive: true });
  const target = process.platform === "win32" ? path.win32.normalize(child) : child;

  const forms = process.platform === "win32"
    ? [
        ["backslash", target.replace(/\//g, "\\")],
        ["forward-slash", target.replace(/\\/g, "/")],
        ["git-bash", toGitBashDrivePath(target)],
      ]
    : [["posix", target]];

  for (const [label, cwdText] of forms) {
    const command = `cd "${cwdText}" && git status`;
    const got = commandCwdAt(command, base, command.indexOf("git status"), "git");
    assert.notEqual(got, UNRESOLVABLE_CWD, `${label} cwd must resolve`);
    assert.equal(normalizeObservedCwd(got), normalizeObservedCwd(target), `${label} cwd target`);
  }

  const relative = path.relative(base, child);
  const relativeCommand = `cd "${relative}" && git status`;
  assert.equal(
    normalizeObservedCwd(commandCwdAt(relativeCommand, base, relativeCommand.indexOf("git status"), "git")),
    normalizeObservedCwd(target),
    "relative cwd must resolve from the declared base"
  );

  if (process.platform === "win32") {
    const drive = path.win32.parse(target).root.slice(0, 1).toUpperCase();
    const otherDrive = drive === "C" ? "Z" : "C";
    const crossDrive = `${otherDrive}:\\definitely-missing\\repo`;
    const command = `cd "${crossDrive}" && git status`;
    assert.equal(
      commandCwdAt(command, base, command.indexOf("git status"), "git"),
      UNRESOLVABLE_CWD,
      "cross-drive missing cwd must fail closed"
    );
  }

  const unrelated = path.join(tmpRoot, "unrelated-cwd");
  mkdirSync(unrelated, { recursive: true });
  const unrelatedRel = path.relative(base, unrelated);
  const unrelatedResult = checkUpstreamPollution(
    `cd "${unrelatedRel}" && git pull origin main`,
    "main",
    base
  );
  assert.equal(unrelatedResult?.block, true, "unrelated non-repo cwd must fail closed");
  assert.match(unrelatedResult.reason, /無法從 payload 判定 branch|cwd 解析失敗/);
});

test("empty upstream-pollution branch uses parse-failure copy not (none)", () => {
  const result = checkUpstreamPollution("git pull --ff-only origin main", "");
  assert.equal(result?.block, true);
  assert.match(result.reason, /無法從 payload 判定 branch/);
  assert.doesNotMatch(result.reason, /非 main branch/);

  const missing = path.join(tmpRoot, "missing-cwd");
  const unresolvedCwd = checkUpstreamPollution("git pull --ff-only origin main", "main", missing);
  assert.equal(unresolvedCwd?.block, true);
  assert.match(unresolvedCwd.reason, /無法從 payload 判定 branch/);
  assert.doesNotMatch(unresolvedCwd.reason, /非 main branch/);
});

test("resolved non-main branch still uses foreign-branch copy", () => {
  const result = checkUpstreamPollution("git pull origin main", "chore/fix-something");
  assert.equal(result?.block, true);
  assert.match(result.reason, /非 main branch \(`chore\/fix-something`\)/);
});

test("cd mapped-existing-dir then pull main is not blocked when that dir is main", () => {
  const mainRepo = setupRepo("main");
  const result = runPreToolHook(`cd ${mainRepo}; git pull --ff-only origin main`, mainRepo);
  assert.notEqual(result?.decision, "block", JSON.stringify(result));
});
