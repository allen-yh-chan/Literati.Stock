/**
 * hook-pre-tool-gate-branch-verb.test.mjs
 *
 * Multi-occurrence masking regression for the Worktree-Mandatory branch gates
 * (Gate W1: create + checkout). Filed as issue #899 finding (a).
 *
 * Bug: checkWorktreeMandatoryForBranchCreate / checkWorktreeMandatoryForBranchCheckout
 * used a single `cmd.match()`, so a benign or exempt FIRST occurrence (e.g. a checkout
 * to the protected `main`, or a pathspec restore `git checkout -- file`) masked a LATER
 * real branch create/checkout in the main worktree — the later violation escaped the
 * block (false-negative). The fix evaluates EVERY occurrence (matchAll + per-occurrence
 * segment / exemption filtering, mirroring checkGitProtectedWrite), blocking on the
 * first occurrence that survives all exemptions.
 *
 *   Axis A (masking) — exempt/benign first + violating later → MUST STILL BLOCK the later one.
 *   Axis B (no-FP)   — a genuinely all-exempt command           → MUST NOT block.
 *
 * Adversarial revert: restoring the single `.match()` makes the masking cases pass
 * `main`/`--` to the gate, which exempts and returns null → these tests go red.
 *
 * Spawns the hook with synthetic PreToolUse payloads (same integration style as the
 * other hook-pre-tool-gate-*.test.mjs).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(SCRIPT_DIR, "../hooks/pre-tool-gate.mjs");
const WORKTREE_RULE_REL = ".devpro/agent-rules/git-branch-naming-and-anchor.md";
const REAL_WORKTREE_RULE = readFileSync(
  path.resolve(SCRIPT_DIR, "../../agent-rules/git-branch-naming-and-anchor.md"),
  "utf8"
);

const tmpRoot = makeTempDir("branch-verb-gate-test-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

let counter = 0;
// A repo on `main` (a protected branch) that carries the worktree-rule SoT file,
// so the Worktree-Mandatory gates engage. NOT inside a `.worktree/` sub-dir, so the
// inside-sub-worktree exemption does not short-circuit.
function setupMainRepo() {
  const dir = path.join(tmpRoot, `repo-${counter++}`);
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, WORKTREE_RULE_REL), REAL_WORKTREE_RULE);
  writeFileSync(path.join(dir, "f.txt"), "x\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function run(command, cwd) {
  const tempSentinelDir = makeTempDir("sentinel-branchverb-");
  const payload = { tool_name: "Bash", tool_input: { command, cwd } };
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
    },
  });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch {}
  return { code: r.status, stdout: r.stdout, json };
}

// ── Axis A: exempt/benign FIRST occurrence MUST NOT mask a later violating one ──
//
// The checkout gate exempts an occurrence whose ref is a protected mainline
// (PROTECTED_BRANCHES) or whose form is a pathspec restore (`<ref> --`). With a single
// `.match()`, that exempt FIRST occurrence masked a later real branch checkout. Each
// case below has a genuinely-exempt first occurrence followed by a violating one.
const MASKING_CASES = [
  {
    name: "checkout: protected-first masks later checkout",
    cmd: "git checkout main && git checkout feature/x",
    reason: /Worktree Mandatory For Branch Checkout gate/,
  },
  {
    name: "switch: protected-first masks later switch",
    cmd: "git switch main && git switch feature/x",
    reason: /Worktree Mandatory For Branch Checkout gate/,
  },
  {
    name: "checkout: pathspec-restore-first masks later checkout",
    cmd: "git checkout x.txt -- && git checkout feature/y",
    reason: /Worktree Mandatory For Branch Checkout gate/,
  },
];

for (const c of MASKING_CASES) {
  test(`Axis A masking [${c.name}] later violation MUST still block`, () => {
    const dir = setupMainRepo();
    const r = run(c.cmd, dir);
    assert.equal(
      r.json?.decision,
      "block",
      `"${c.cmd}" MUST block the later violation (multi-occurrence masking guard); got: ${JSON.stringify(r.json)}`
    );
    assert.match(r.json.reason, c.reason, `block reason mismatch for "${c.cmd}"`);
  });
}

// ── Axis B: a genuinely all-exempt command MUST NOT block ──
const ALL_EXEMPT_CASES = [
  {
    name: "two protected checkouts",
    cmd: "git checkout main && git checkout master",
  },
  {
    name: "two pathspec restores",
    cmd: "git checkout -- a.txt && git checkout -- b.txt",
  },
];

for (const c of ALL_EXEMPT_CASES) {
  test(`Axis B no-FP [${c.name}] MUST NOT block`, () => {
    const dir = setupMainRepo();
    const r = run(c.cmd, dir);
    assert.notEqual(
      r.json?.decision,
      "block",
      `all-exempt "${c.cmd}" MUST NOT trigger a Worktree Mandatory block; got: ${JSON.stringify(r.json)}`
    );
  });
}

// ── Baseline: bare single violations still block (regression floor) ──
test("baseline: bare git checkout -b <branch> still blocks (create)", () => {
  const dir = setupMainRepo();
  const r = run("git checkout -b feature/solo", dir);
  assert.equal(r.json?.decision, "block", `bare create must block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Create gate/);
});

test("baseline: bare git checkout <branch> still blocks (checkout)", () => {
  const dir = setupMainRepo();
  const r = run("git checkout feature/solo", dir);
  assert.equal(r.json?.decision, "block", `bare checkout must block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// The CREATE gate has no name/pathspec exemption (only cwd-based: inside-sub-worktree /
// repoHasWorktreeRule, shared by every occurrence in one command) and its CMD_POSITION
// anchor already skips quoted occurrences, so an exempt-first masking vector cannot be
// constructed for it. The fix still converts it to matchAll for symmetry / future
// exemptions; this case pins that a benign leading create does not suppress a later one.
test("create: leading benign-form create does not suppress later create block", () => {
  const dir = setupMainRepo();
  // Both are real creates in the main worktree; the FIRST surviving occurrence blocks.
  const r = run("git checkout -b feature/a && git checkout -b feature/b", dir);
  assert.equal(r.json?.decision, "block", `multi-create must block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Create gate/);
});
