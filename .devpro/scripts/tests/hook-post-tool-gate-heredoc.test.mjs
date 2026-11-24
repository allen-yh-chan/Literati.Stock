/**
 * hook-post-tool-gate-heredoc.test.mjs
 *
 * Regression tests for BUG4: post-tool-gate.mjs heredoc parser previously
 * matched `git worktree add` substrings inside heredoc bodies / quoted
 * strings / comments and wrote false-positive sentinels. After the fix it
 * uses lib/shell-context.mjs::segmentCommand + isMatchInCommandSegment to
 * skip non-command segments.
 *
 * Approach: spawn post-tool-gate.mjs with a synthetic PostToolUse payload,
 * use a temporary sentinel state dir via DEVPRO_SENTINEL_STATE_DIR env, then
 * inspect that dir to see whether a sentinel was written.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(SCRIPT_DIR, "../hooks/post-tool-gate.mjs");

const tmpRoot = makeTempDir("post-tool-heredoc-test-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

let counter = 0;
function freshSentinelDir() {
  const dir = path.join(tmpRoot, `sentinels-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runHook(payload, sentinelDir) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
    },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function sentinelFiles(dir) {
  return readdirSync(dir).filter((f) => f.startsWith("pending-cd-to-worktree-"));
}

// ── BUG4A — heredoc body false positive eliminated ─────────────────────────

test("BUG4A: commit message heredoc containing 'git worktree add directive' → no sentinel", () => {
  const sentinels = freshSentinelDir();
  const cmd = [
    "git commit -m \"$(cat <<'EOF'",
    "chore: harden first-time detection",
    "",
    "Replace ambiguous '或' with mandatory git worktree add directive in",
    "git-branch-and-pr-flow.md:48.",
    "EOF",
    ")\"",
  ].join("\n");

  runHook(
    {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: "/tmp/fakerepo" },
      tool_response: { exit_code: 0 },
    },
    sentinels
  );

  const found = sentinelFiles(sentinels);
  assert.equal(found.length, 0, `expected 0 sentinels, got ${found.length}: ${found.join(",")}`);
});

// ── BUG4B — real worktree add still writes sentinel ────────────────────────

test("BUG4B: real `git worktree add /abs/path -b feature/foo main` → sentinel written", () => {
  const sentinels = freshSentinelDir();
  const cmd = "git worktree add /tmp/fakerepo/.worktree/foo -b feature/foo main";
  runHook(
    {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: "/tmp/fakerepo" },
      tool_response: { exit_code: 0 },
    },
    sentinels
  );

  const found = sentinelFiles(sentinels);
  assert.ok(
    found.length === 1,
    `expected 1 sentinel, got ${found.length}: ${found.join(",")}`
  );
  assert.match(found[0], /pending-cd-to-worktree-foo/);
});

// ── BUG4C — comment containing the substring → no sentinel ─────────────────

test("BUG4C: comment '# git worktree add foo' → no sentinel", () => {
  const sentinels = freshSentinelDir();
  const cmd = "echo hi  # later we'll git worktree add /abs/foo -b feature/foo";
  runHook(
    {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: "/tmp/fakerepo" },
      tool_response: { exit_code: 0 },
    },
    sentinels
  );

  const found = sentinelFiles(sentinels);
  assert.equal(found.length, 0, `expected 0 sentinels (comment), got ${found.length}`);
});

// ── BUG4D — single-quoted string containing substring → no sentinel ────────

test("BUG4D: echo 'plan: git worktree add /abs/foo' → no sentinel", () => {
  const sentinels = freshSentinelDir();
  const cmd = "echo 'plan: git worktree add /tmp/fakerepo/.worktree/foo -b feature/foo'";
  runHook(
    {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: "/tmp/fakerepo" },
      tool_response: { exit_code: 0 },
    },
    sentinels
  );

  const found = sentinelFiles(sentinels);
  assert.equal(found.length, 0, `expected 0 sentinels (quoted), got ${found.length}`);
});

// ── BUG4E — non-zero exit → no sentinel (existing fail-safe preserved) ─────

test("BUG4E: real worktree add cmd but tool_response.exit_code=1 → no sentinel", () => {
  const sentinels = freshSentinelDir();
  const cmd = "git worktree add /tmp/fakerepo/.worktree/foo -b feature/foo main";
  runHook(
    {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: "/tmp/fakerepo" },
      tool_response: { exit_code: 1 },
    },
    sentinels
  );

  const found = sentinelFiles(sentinels);
  assert.equal(found.length, 0, `expected 0 sentinels (non-zero exit), got ${found.length}`);
});

// ── BUG5 — chained `git worktree add /A && cd /A && ...` → no stale sentinel ──
//
// Empirical 2026-05-10: a single chained command like
//   git worktree add /abs/path -b feat/foo main && cd /abs/path && grep ...
// triggers post-tool-gate to write a sentinel for /abs/path because the
// regex matches `git worktree add`. The next Bash invocation has cwd
// already inside /abs/path (cd succeeded), so it doesn't start with a
// literal `cd /abs/path` prefix → pre-tool-gate fires a stale advisory.
// Fix: post-tool-gate detects the chained `cd <samePath>` in the same cmd
// and skips sentinel write.

test("BUG5A: chained `git worktree add /A && cd /A && other` → no sentinel", () => {
  const sentinels = freshSentinelDir();
  const cmd =
    "git worktree add /tmp/fakerepo/.worktree/foo -b feature/foo main && cd /tmp/fakerepo/.worktree/foo && grep '^版本：' AGENTS.md";
  runHook(
    {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: "/tmp/fakerepo" },
      tool_response: { exit_code: 0 },
    },
    sentinels
  );

  const found = sentinelFiles(sentinels);
  assert.equal(found.length, 0,
    `expected 0 sentinels (chained cd into same path), got ${found.length}: ${found.join(",")}`);
});

test("BUG5B: chained with quoted path `cd \"/A\"` → no sentinel", () => {
  const sentinels = freshSentinelDir();
  const cmd =
    'git worktree add /tmp/fakerepo/.worktree/foo -b feature/foo main && cd "/tmp/fakerepo/.worktree/foo" && pwd';
  runHook(
    {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: "/tmp/fakerepo" },
      tool_response: { exit_code: 0 },
    },
    sentinels
  );

  const found = sentinelFiles(sentinels);
  assert.equal(found.length, 0,
    `expected 0 sentinels (chained cd with quoted path), got ${found.length}`);
});

test("BUG5C: chained cd to DIFFERENT path → sentinel still written", () => {
  // Verify Fix A doesn't over-trigger: cd to a path other than the new
  // worktree should still write the sentinel (user did not enter the
  // new worktree).
  const sentinels = freshSentinelDir();
  const cmd =
    "git worktree add /tmp/fakerepo/.worktree/foo -b feature/foo main && cd /tmp/elsewhere && pwd";
  runHook(
    {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: "/tmp/fakerepo" },
      tool_response: { exit_code: 0 },
    },
    sentinels
  );

  const found = sentinelFiles(sentinels);
  assert.equal(found.length, 1,
    `expected 1 sentinel (cd to different path), got ${found.length}`);
  assert.match(found[0], /pending-cd-to-worktree-foo/);
});

test("BUG5D: no `cd` at all → sentinel still written (pre-existing behavior)", () => {
  const sentinels = freshSentinelDir();
  const cmd =
    "git worktree add /tmp/fakerepo/.worktree/foo -b feature/foo main";
  runHook(
    {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: "/tmp/fakerepo" },
      tool_response: { exit_code: 0 },
    },
    sentinels
  );

  const found = sentinelFiles(sentinels);
  assert.equal(found.length, 1, `expected 1 sentinel (no chained cd), got ${found.length}`);
});
