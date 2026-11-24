/**
 * hook-pre-tool-gate-commit-flag-scope.test.mjs
 *
 * false-positive-regression: commit attribution gate (Gate 2b) misidentified
 * flags from OTHER tools (e.g. `grep -F`, `awk -F`, `grep -m`) as git-commit
 * flags (-F/--file, -m/--message), causing fail-closed blocks on legitimate
 * natural commands.
 *
 * Root cause: gitCommitMessageFromCommand extracted -m/-F from the FULL command
 * string; isMatchInCommandSegment only ensured the flag was in a command segment
 * (not a quoted string/heredoc body) but did NOT restrict to the git-commit
 * clause specifically.
 *
 * Fix (M1-M3): clause-scope flag extraction — locate each git commit match
 * index, find the clause endpoint (next top-level &&/;/|/\n verified via
 * isMatchInCommandSegment), extract flags only from that slice.
 *
 * Test strategy:
 *   - Each test sets up a temp git repo on a NON-protected branch
 *     (feature/fix-commit-flag-scope) so Gate 1 (protected-branch) does not
 *     interfere with Gate 2b (commit attribution) results.
 *   - Runs the hook via spawnSync (spawn path) to exercise the real hook
 *     process contract — mirrors the approach in
 *     hook-pre-tool-gate-cmd-position-boundary.test.mjs.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { advisoryText } from "./lib/hook-harness.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(SCRIPT_DIR, "../hooks/pre-tool-gate.mjs");

// Reuse the real preflight-checklist.md so branch-verb-whitelist / rules-source
// gates do not trip on the feature branch.
const REAL_PREFLIGHT = readFileSync(
  path.resolve(SCRIPT_DIR, "../../agent-rules/preflight-checklist.md"),
  "utf8"
);

const tmpRoot = makeTempDir("commit-flag-scope-test-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

let counter = 0;

/**
 * Set up a minimal git repo on a NON-protected branch so Gate 1 does not fire
 * and Gate 2b (commit attribution) is the only relevant gate for these tests.
 */
function setupRepo() {
  const dir = path.join(tmpRoot, `repo-${counter++}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "feature/fix-commit-flag-scope"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "devpro-test"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, "AGENTS.md"), "# AI Agent 規範\n\n版本：6.66.2\n");
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), REAL_PREFLIGHT);
  writeFileSync(path.join(dir, "f.md"), "# test file\nneedle\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

/** Run the hook as a spawned child process (real hook process contract). */
function run(command, cwd) {
  const tempSentinelDir = makeTempDir("sentinel-cfscope-");
  try {
    const payload = {
      tool_name: "Bash",
      tool_input: { command, cwd },
    };
    const r = spawnSync("node", [HOOK], {
      cwd,
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_CI: "",
        CODEX_THREAD_ID: "",
        DEVPRO_SENTINEL_STATE_DIR: tempSentinelDir,
        PWD: cwd,
        // No PR context needed; cross-model gate fails-open on missing PR data.
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
        CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
          comments: [],
          headRefOid: "a".repeat(40),
          headRefName: "feature/fix-commit-flag-scope",
        }),
        CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: "feature/fix-commit-flag-scope",
      },
    });
    let json = null;
    try { json = r.stdout?.trim() ? JSON.parse(r.stdout) : null; } catch {}
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
  } finally {
    try { rmSync(tempSentinelDir, { recursive: true, force: true }); } catch {}
  }
}

function assertNoCommitAttributionAdvisory(r, label) {
  assert.doesNotMatch(
    advisoryText(r.json),
    /Commit attribution gate/,
    `${label}: valid footer must not emit attribution advisory; got: ${JSON.stringify(r.json)}`
  );
}

// Valid footer for Gate 2b. Must match AGENTS.md version in the worktree.
// Version 6.66.2 is the current worktree AGENTS.md version.
const FOOTER = "Rules: v6.66.2 · Tool: Claude Code · Model: Sonnet 4.6";

// ─── Case 1: grep -F before git commit heredoc ──────────────────────────────
//
// false-positive-regression: `grep -F "needle" f.md && git commit -m "$(..."
// The pre-fix code extracted `-F "needle"` as a commit `-F/--file` flag,
// statSync("needle") threw → fail-closed BLOCK on a legitimate natural command.
//
// Phase RED: this test MUST FAIL before the fix (proving the bug is present).
// Phase GREEN: this test MUST PASS after the fix.

test("[false-positive-regression] case1: grep -F before git commit heredoc → PASS (not blocked)", () => {
  const dir = setupRepo();
  // Exact probe-A shape from the bug report.
  const cmd =
    `grep -F "needle" f.md && git commit -m "$(cat <<'EOF'\nsubject line\n\n${FOOTER}\nEOF\n)"`;
  const r = run(cmd, dir);
  assert.equal(
    r.json?.decision,
    undefined,
    `[false-positive-regression] case1: grep -F before commit MUST NOT block; got: ${JSON.stringify(r.json)}`
  );
});

// ─── Case 2: full restore shape (grep -n + python heredoc + grep -F + git add + commit) ──
//
// false-positive-regression: multi-tool pipeline with grep -n, python heredoc,
// grep -F, git add, then git commit with footer. Pre-fix blocked on grep -F.

test("[false-positive-regression] case2: full restore shape (grep -n + python + grep -F + add + commit) → PASS", () => {
  const dir = setupRepo();
  const cmd = [
    `grep -n "needle" f.md`,
    `python3 -c 'print("x")'`,
    `grep -F "needle" f.md`,
    `git add f.md`,
    `git commit -m "$(cat <<'EOF'\nfix: restore shape\n\n${FOOTER}\nEOF\n)"`,
  ].join(" && ");
  const r = run(cmd, dir);
  assert.equal(
    r.json?.decision,
    undefined,
    `[false-positive-regression] case2: full restore shape MUST NOT block; got: ${JSON.stringify(r.json)}`
  );
});

// ─── Case 3: real git commit -F /nonexistent/file → BLOCK (fail-closed not weakened) ───
//
// fail-closed: a real `git commit -F /nonexistent/file` MUST still block
// (the file cannot be read → fail-closed). Both before AND after the fix.

test("[fail-closed] case3: git commit -F /nonexistent/file → BLOCK (fail-closed preserved)", () => {
  const dir = setupRepo();
  const cmd = "git commit -F /nonexistent/file-does-not-exist-xyz";
  const r = run(cmd, dir);
  assert.equal(
    r.json?.decision,
    "block",
    `[fail-closed] case3: real commit -F with missing file MUST block; got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json.reason,
    /attribution|commit.*gate|read failed/i,
    `case3: block reason must mention attribution gate; got: ${r.json.reason}`
  );
});

// ─── Case 4: git commit -F <real fixture file with valid footer> → PASS ─────
//
// clause-internal -F still reads the file and validates the footer.

test("[clause-F-read] case4: git commit -F <fixture file with valid footer> → PASS", () => {
  const dir = setupRepo();
  const msgFile = path.join(dir, "commit-msg.txt");
  writeFileSync(msgFile, `fix: case4 clause-F read\n\n${FOOTER}\n`);
  const cmd = `git commit -F ${msgFile}`;
  const r = run(cmd, dir);
  assert.equal(
    r.json?.decision,
    undefined,
    `[clause-F-read] case4: commit -F with valid footer file MUST pass; got: ${JSON.stringify(r.json)}`
  );
});

// ─── Case 5: awk -F " " before git commit heredoc ───────────────────────────
//
// false-positive-regression: `awk -F " " '{print}' x && git commit -m "$(..."
// awk -F " " was misread as commit -F with value " ", causing a parse error.

test("[false-positive-regression] case5: awk -F before git commit heredoc → PASS", () => {
  const dir = setupRepo();
  const cmd =
    `awk -F " " '{print}' f.md && git commit -m "$(cat <<'EOF'\nfix: awk-F shape\n\n${FOOTER}\nEOF\n)"`;
  const r = run(cmd, dir);
  assert.equal(
    r.json?.decision,
    undefined,
    `[false-positive-regression] case5: awk -F before commit MUST NOT block; got: ${JSON.stringify(r.json)}`
  );
});

// ─── Case 6: M1 guard — inner && inside commit message must not truncate clause ─
//
// M1 architect constraint: clause endpoint scan MUST use isMatchInCommandSegment
// to verify a separator is at top-level. A `&&` inside the commit message's
// subshell `"$(... && grep -F x ...)"` must NOT be treated as the clause
// endpoint, or the -m flag value is truncated and the footer is lost →
// false-negative (gate misses the attribution footer → advisory fires on a
// command that HAS a valid footer).
//
// This test proves M1: after the fix, the inner `&&` does NOT truncate the
// clause, the footer is fully read, and the gate PASSES (no advisory, no block).

test("[M1-guard] case6: inner && inside commit message subshell must not truncate clause → PASS", () => {
  const dir = setupRepo();
  // The `&& grep -F x` is INSIDE the subshell `"$(cat <<'EOF'...EOF)"`, not
  // at the outer command level. The clause endpoint scanner must skip it.
  const innerHeredoc = `cat <<'EOF'\nfix: case6 inner-and\n\nbody with inner && grep -F x and some text\n\n${FOOTER}\nEOF`;
  const cmd = `git commit -m "$(${innerHeredoc}\n)"`;
  const r = run(cmd, dir);
  assert.equal(
    r.json?.decision,
    undefined,
    `[M1-guard] case6: inner && in message must not break footer detection; got: ${JSON.stringify(r.json)}`
  );
  assertNoCommitAttributionAdvisory(r, "[M1-guard] case6");
});

// ─── Case 6b: scanner guard — heredoc body separators stay opaque ────────────
//
// Regression for the clause-end scanner itself: while scanning through the
// `-m "$(...)"` subshell, heredoc body text may contain shell-like syntax
// (`)`, `|`, `&&`, and backtick grep patterns). Those bytes are message text,
// not clause separators. A valid footer must still be read fully.

test("[M1-regression] case6b: heredoc body with backtick grep regex and separators → PASS without advisory", () => {
  const dir = setupRepo();
  const cmd =
    `git commit -m "$(cat <<'EOF'\nfix: case6b scanner\n\nbody cites \`grep "(^|[^>/])"\`, literal ) " then | and && before footer\n\n${FOOTER}\nEOF\n)"`;
  const r = run(cmd, dir);
  assert.equal(
    r.json?.decision,
    undefined,
    `[M1-regression] case6b: heredoc body syntax must not truncate clause; got: ${JSON.stringify(r.json)}`
  );
  assertNoCommitAttributionAdvisory(r, "[M1-regression] case6b");
});

// ─── Case 7: grep -F AFTER commit (trailing, different clause) → PASS ────────
//
// The grep -F appears in a later clause (after the commit clause), not before.
// Must not cause a block either.

test("[false-positive-regression] case7: grep -F after git commit (post-commit clause) → PASS", () => {
  const dir = setupRepo();
  const cmd =
    `git commit -m "$(cat <<'EOF'\nfix: case7\n\n${FOOTER}\nEOF\n)" && grep -F "needle" f.md`;
  const r = run(cmd, dir);
  assert.equal(
    r.json?.decision,
    undefined,
    `[false-positive-regression] case7: grep -F after commit MUST NOT block; got: ${JSON.stringify(r.json)}`
  );
});

// ─── Case 8: M2 — commit heredoc followed by real commands, footer still read ─
//
// M2 architect constraint: a commit clause terminated by a newline (commit on
// one line, then grep on the next) must still fully read the -m heredoc value
// within the commit clause (up to the clause end). To PROVE footer verification
// is still active: we intentionally OMIT the footer → the gate should emit an
// advisory (not silently pass), proving the footer path was executed.

test("[M2-continuation] case8: commit heredoc followed by real commands, deliberately missing footer → advisory (footer check still runs)", () => {
  const dir = setupRepo();
  // Deliberately NO footer — we expect an advisory to prove Gate 2b ran.
  const cmd =
    `git commit -m "$(cat <<'EOF'\nfix: case8 no footer\n\nbody text without any attribution\nEOF\n)"\ngrep -F "needle" f.md`;
  const r = run(cmd, dir);
  // Must NOT block (missing footer → advisory, not block, per L959 invariant).
  assert.notEqual(
    r.json?.decision,
    "block",
    `[M2-continuation] case8: missing footer must be advisory, not block; got: ${JSON.stringify(r.json)}`
  );
  // Must emit advisory proving footer verification ran on the commit clause.
  const advisory =
    advisoryText(r.json);
  assert.match(
    advisory,
    /Commit attribution gate/,
    `[M2-continuation] case8: advisory must mention attribution gate (proves footer check ran); got: ${advisory}`
  );
});

// ─── Case 9: multiple commit clauses validate missing footer independently ───
//
// A later valid commit footer must not mask an earlier commit clause that is
// missing the attribution footer. Missing footer remains advisory, but the
// advisory must still be emitted for the first clause.

test("[multi-commit-regression] case9: later valid footer must not mask earlier missing footer → advisory", () => {
  const dir = setupRepo();
  const cmd =
    `git commit -m "fix: missing footer" && git commit -m "$(cat <<'EOF'\nfix: valid footer\n\n${FOOTER}\nEOF\n)"`;
  const r = run(cmd, dir);
  assert.notEqual(
    r.json?.decision,
    "block",
    `[multi-commit-regression] case9: missing footer must remain advisory, not block; got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    advisoryText(r.json),
    /Commit attribution gate/,
    `[multi-commit-regression] case9: first commit missing footer must emit advisory; got: ${JSON.stringify(r.json)}`
  );
});

// ─── Case 10: multiple commit clauses validate footer version independently ──
//
// A later valid footer must not mask an earlier commit clause whose Rules
// version is wrong. Version mismatch is a release-integrity hard block.

test("[multi-commit-regression] case10: later valid footer must not mask earlier wrong Rules version → BLOCK", () => {
  const dir = setupRepo();
  const cmd =
    `git commit -m "$(cat <<'EOF'\nfix: wrong version\n\nRules: v0.0.1 · Tool: Claude Code · Model: Sonnet 4.6\nEOF\n)" && git commit -m "$(cat <<'EOF'\nfix: valid footer\n\n${FOOTER}\nEOF\n)"`;
  const r = run(cmd, dir);
  assert.equal(
    r.json?.decision,
    "block",
    `[multi-commit-regression] case10: wrong first footer version MUST block even when a later footer is valid; got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json?.reason || "",
    /release-integrity|version-mismatch|Rules: v0\.0\.1/,
    `[multi-commit-regression] case10: block reason must identify version mismatch; got: ${r.json?.reason}`
  );
});

// ─── T2: -F - stdin via heredoc ─────────────────────────────────────────────
//
// Bug: `git commit -F - <<'EOF'\n<msg>\nEOF` was blocked because gitCommitMessageFromCommand
// treated `-F -` as a path, did path.resolve → `<cwd>/-`, statSync threw → readFailed: true.
// Fix: when -F value is "-" (stdin), look for a heredoc-body segment in the same commit clause.
//
// T2(a): heredoc body with valid footer → attribution passes (not blocked, no advisory)
// T2(b): heredoc body with Co-Authored-By: Claude → forbidden attribution still blocks
// T2(c): -F - with no heredoc body → readFailed maintained (fail-closed)
// ─────────────────────────────────────────────────────────────────────────────

test("[T2-stdin-heredoc] case-a: git commit -F - with valid footer heredoc body → PASS (not blocked)", () => {
  const dir = setupRepo();
  // Simulates: git commit -F - <<'EOF'\nsubject\n\n<footer>\nEOF
  // The heredoc body is the commit message (stdin replacement).
  const cmd = `git commit -F - <<'EOF'\nfix: T2 stdin heredoc case-a\n\n${FOOTER}\nEOF`;
  const r = run(cmd, dir);
  assert.notEqual(
    r.json?.decision,
    "block",
    `[T2-stdin-heredoc] case-a: valid footer via -F - heredoc MUST NOT block; got: ${JSON.stringify(r.json)}`
  );
  assertNoCommitAttributionAdvisory(r, "[T2-stdin-heredoc] case-a");
});

test("[T2-stdin-heredoc] case-b: git commit -F - with Co-Authored-By: Claude → BLOCK (forbidden attribution)", () => {
  const dir = setupRepo();
  // Forbidden marker must still be detected even when message comes via -F - heredoc.
  const cmd = `git commit -F - <<'EOF'\nfix: T2 stdin heredoc case-b\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n${FOOTER}\nEOF`;
  const r = run(cmd, dir);
  assert.equal(
    r.json?.decision,
    "block",
    `[T2-stdin-heredoc] case-b: forbidden Co-Authored-By marker in -F - heredoc MUST block; got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json.reason,
    /attribution|forbidden/i,
    `[T2-stdin-heredoc] case-b: block reason must mention attribution; got: ${r.json.reason}`
  );
});

test("[T2-stdin-heredoc] case-c: git commit -F - (no heredoc body) → BLOCK (fail-closed)", () => {
  const dir = setupRepo();
  // -F - with no heredoc body (bare stdin reference) — fail-closed, must still block.
  const cmd = `git commit -F -`;
  const r = run(cmd, dir);
  assert.equal(
    r.json?.decision,
    "block",
    `[T2-stdin-heredoc] case-c: -F - with no heredoc body MUST block (fail-closed); got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json.reason,
    /attribution|commit.*gate|read failed/i,
    `[T2-stdin-heredoc] case-c: block reason must mention attribution gate; got: ${r.json.reason}`
  );
});
