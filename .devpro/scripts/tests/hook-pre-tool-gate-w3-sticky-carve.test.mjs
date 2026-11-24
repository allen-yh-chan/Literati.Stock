/**
 * hook-pre-tool-gate-w3-sticky-carve.test.mjs
 *
 * Unit tests for the W3 Body Carrier gate carve:
 *   - notes/tmp/.cross-model-sticky-*.md (gitignored, main-checkout) → ALLOW
 *   - worktree-internal .cross-model-sticky-*.md → BLOCK
 *
 * Implements T8 acceptance: refactor-temp-writes-to-notes-tmp Part A.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const PRE_TOOL_GATE = path.resolve(scriptDir, "../hooks/pre-tool-gate.mjs");

const { isBodyCarrierPath, checkBodyCarrierTarget, evaluatePreToolUsePayload, PASS_THROUGH } = await import(pathToFileURL(PRE_TOOL_GATE).href);

// ── Helpers ──────────────────────────────────────────────────────────────────

const tmpRoot = makeTempDir("w3-sticky-test-");

function cleanup() {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

process.on("exit", cleanup);

let counter = 0;

/**
 * Create a minimal git repo with notes/tmp gitignored.
 * Returns the repo root path.
 */
function makeGitRepo(withNotesIgnored = true) {
  const repo = path.join(tmpRoot, `repo-${counter++}`);
  mkdirSync(repo, { recursive: true });
  execSync("git init", { cwd: repo, stdio: "ignore" });
  execSync("git config user.email test@example.invalid", { cwd: repo, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: repo, stdio: "ignore" });
  if (withNotesIgnored) {
    writeFileSync(path.join(repo, ".gitignore"), "notes/\n", "utf8");
    execSync("git add .gitignore", { cwd: repo, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: repo, stdio: "ignore" });
  }
  return repo;
}

// ── isBodyCarrierPath tests ──────────────────────────────────────────────────

test("isBodyCarrierPath: .cross-model-sticky-foo.md in notes/tmp/ (gitignored) → false (carve, allowed)", () => {
  const repo = makeGitRepo(true);
  const notesDir = path.join(repo, "notes", "tmp");
  mkdirSync(notesDir, { recursive: true });
  const filePath = path.join(notesDir, ".cross-model-sticky-foo.md");
  writeFileSync(filePath, "sticky body\n");
  // notes/ is gitignored → isBodyCarrierPath should return false (not a carrier to block)
  const result = isBodyCarrierPath(filePath, repo);
  assert.equal(result, false, "gitignored notes/tmp/.cross-model-sticky-foo.md must be carved out (not a blocked carrier)");
});

test("isBodyCarrierPath: worktree-root .cross-model-sticky-foo.md (not gitignored) → true (blocked carrier)", () => {
  const repo = makeGitRepo(true);
  const filePath = path.join(repo, ".cross-model-sticky-foo.md");
  // Not gitignored (no entry for .cross-model-sticky* in .gitignore)
  const result = isBodyCarrierPath(filePath, repo);
  assert.equal(result, true, "worktree-root .cross-model-sticky-foo.md must be treated as a blocked carrier");
});

test("isBodyCarrierPath: carve is main-checkout notes/tmp ONLY — a root-level gitignored .cross-model-sticky still blocks", () => {
  // The carve is NOT "any gitignored .cross-model-sticky-*"; it is specifically
  // "<repo-root>/notes/tmp/.cross-model-sticky-*". Prove that gitignoring the file at the
  // repo root (without putting it under notes/tmp) does NOT carve it: it must still block.
  // (Carrier recognition itself is root-level: the rel-path regex `^\.cross-model-sticky-[^/]+`
  //  only matches a repo-root-relative file with no path separators — exactly as on origin/main.
  //  Sub-directory placement is governed by other worktree/protected-branch write gates, not this fn.)
  const repo = makeGitRepo(true);
  // gitignore the sticky pattern at repo root too, so "gitignored" alone is NOT the carve trigger
  writeFileSync(path.join(repo, ".gitignore"), "notes/\n.cross-model-sticky-*\n", "utf8");
  execSync("git add .gitignore", { cwd: repo, stdio: "ignore" });
  execSync('git commit -m "ignore sticky at root"', { cwd: repo, stdio: "ignore" });
  const filePath = path.join(repo, ".cross-model-sticky-bar.md");
  writeFileSync(filePath, "sticky body\n");
  const result = isBodyCarrierPath(filePath, repo);
  assert.equal(result, true, "root-level .cross-model-sticky-bar.md MUST still block even when gitignored (carve is main-checkout notes/tmp prefix only, not 'any gitignored')");
});

test("isBodyCarrierPath: regular notes/tmp/remove-gh-body-pr-body-carve.md → false (not a carrier)", () => {
  const repo = makeGitRepo(true);
  const notesDir = path.join(repo, "notes", "tmp");
  mkdirSync(notesDir, { recursive: true });
  const filePath = path.join(notesDir, "remove-gh-body-pr-body-carve.md");
  const result = isBodyCarrierPath(filePath, repo);
  assert.equal(result, false, "notes/tmp/remove-gh-body-pr-body-carve.md is not a reviewer-sticky carrier");
});

// ── checkBodyCarrierTarget tests ─────────────────────────────────────────────

test("checkBodyCarrierTarget: main branch Write to .cross-model-sticky-foo.md in notes/tmp → null (allowed)", () => {
  const repo = makeGitRepo(true);
  const notesDir = path.join(repo, "notes", "tmp");
  mkdirSync(notesDir, { recursive: true });
  const filePath = path.join(notesDir, ".cross-model-sticky-foo.md");
  writeFileSync(filePath, "sticky body\n");
  // On main branch, but file is gitignored → should not block
  const result = checkBodyCarrierTarget({ toolName: "Write", filePath, baseCwd: repo });
  assert.equal(result, null, "notes/tmp/.cross-model-sticky-foo.md on main must not be blocked (carve)");
});

test("checkBodyCarrierTarget: non-carrier file → null", () => {
  const repo = makeGitRepo(true);
  const filePath = path.join(repo, "notes", "tmp", "pr-body.md");
  mkdirSync(path.join(repo, "notes", "tmp"), { recursive: true });
  const result = checkBodyCarrierTarget({ toolName: "Write", filePath, baseCwd: repo });
  assert.equal(result, null, "non-carrier file must not be blocked");
});

// ── subdir-sticky containment matrix (full-chain evaluatePreToolUsePayload) ──
//
// Proves the invariant: isBodyCarrierPath() only recognises repo-root-level
// `.cross-model-sticky-*` (rel path with no `/`). Worktree-internal subdir
// sticky paths fall through to the protected-branch gate (checkFileWrite) when
// the branch is protected, AND are carved out when the path is gitignored.
// This is a gitignore-dependent implicit invariant: changing .worktree/ gitignore
// status or the protected-branch carve will silently regress containment.

/**
 * Build a minimal git repo with a controlled branch name and .gitignore.
 *
 * @param {string} branchName - The git branch to check out (e.g. "main", "feature/x").
 * @param {{ worktreeIgnored?: boolean }} opts
 *   worktreeIgnored: if true, `.worktree/` is added to .gitignore so subdir
 *   stickies inside it are gitignored (protected-branch carve → ALLOW);
 *   if false, only `notes/` is in .gitignore, so the path is tracked and the
 *   protected-branch gate fires (BLOCK).
 * @returns {string} absolute path to the repo root
 */
function makeGitRepoOnBranch(branchName, { worktreeIgnored = false } = {}) {
  const repo = path.join(tmpRoot, `repo-${counter++}`);
  mkdirSync(repo, { recursive: true });
  execSync("git init", { cwd: repo, stdio: "ignore" });
  execSync("git config user.email test@example.invalid", { cwd: repo, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: repo, stdio: "ignore" });
  const gitignoreLines = worktreeIgnored ? "notes/\n.worktree/\n" : "notes/\n";
  writeFileSync(path.join(repo, ".gitignore"), gitignoreLines, "utf8");
  execSync("git add .gitignore", { cwd: repo, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: repo, stdio: "ignore" });
  // Rename or create the desired branch name.
  // `git init` may produce "master" or "main" depending on git config; rename
  // unconditionally so the test controls the branch precisely.
  execSync(`git branch -m "${branchName}"`, { cwd: repo, stdio: "ignore" });
  return repo;
}

// Matrix test 1 ─────────────────────────────────────────────────────────────
test("matrix[root-level sticky, protected main] → BLOCK by body-carrier gate (not protected-branch)", () => {
  const repo = makeGitRepoOnBranch("main");
  const filePath = path.join(repo, ".cross-model-sticky-bar.md");
  writeFileSync(filePath, "sticky\n");

  const result = evaluatePreToolUsePayload({
    tool_name: "Write",
    tool_input: { file_path: filePath, cwd: repo },
  });

  // Must block (not PASS_THROUGH)
  assert.notEqual(result, PASS_THROUGH, "root-level sticky on main must be blocked");
  assert.ok(result && result.reason, "block result must carry a reason");
  // Specifically the body-carrier gate, NOT the protected-branch gate
  assert.match(
    result.reason,
    /Body Carrier Target gate/,
    "root-level sticky must be caught by body-carrier gate (Body Carrier Target gate keyword)"
  );
  assert.doesNotMatch(
    result.reason,
    /Protected-branch gate/,
    "root-level sticky must NOT fall through to protected-branch gate"
  );
  // Sanity: isBodyCarrierPath correctly identifies it as a carrier
  assert.equal(isBodyCarrierPath(filePath, repo), true, "isBodyCarrierPath must return true for root-level sticky");
});

// Matrix test 2 ─────────────────────────────────────────────────────────────
test("matrix[subdir sticky, .worktree/ NOT gitignored, protected main] → BLOCK by protected-branch gate (NOT body-carrier)", () => {
  // subdir sticky containment 依賴 gitignored-non-promotable + protected-branch gate, NOT isBodyCarrierPath
  const repo = makeGitRepoOnBranch("main", { worktreeIgnored: false });
  const subdirPath = path.join(repo, ".worktree", "foo");
  mkdirSync(subdirPath, { recursive: true });
  const filePath = path.join(subdirPath, ".cross-model-sticky-bar.md");
  writeFileSync(filePath, "sticky\n");

  // Prove isBodyCarrierPath does NOT recognise the subdir sticky
  assert.equal(
    isBodyCarrierPath(filePath, repo),
    false,
    "isBodyCarrierPath must return false for subdir sticky (rel path contains /) — containment comes from other gates"
  );

  const result = evaluatePreToolUsePayload({
    tool_name: "Write",
    tool_input: { file_path: filePath, cwd: repo },
  });

  // Must block
  assert.notEqual(result, PASS_THROUGH,
    "subdir sticky containment 依賴 gitignored-non-promotable + protected-branch gate, NOT isBodyCarrierPath — " +
    "non-gitignored subdir sticky on protected branch must be BLOCKED"
  );
  assert.ok(result && result.reason, "block result must carry a reason");
  // Must be caught by protected-branch gate
  assert.match(
    result.reason,
    /Protected-branch gate/,
    "subdir sticky must be caught by protected-branch gate when .worktree/ is not gitignored"
  );
  assert.doesNotMatch(
    result.reason,
    /Body Carrier Target gate/,
    "subdir sticky must NOT be caught by body-carrier gate (isBodyCarrierPath returns false)"
  );
});

// Matrix test 3 ─────────────────────────────────────────────────────────────
test("matrix[subdir sticky, .worktree/ gitignored, protected main] → ALLOW (gitignore carve, no gate fires)", () => {
  // subdir sticky containment 依賴 gitignored-non-promotable + protected-branch gate, NOT isBodyCarrierPath
  const repo = makeGitRepoOnBranch("main", { worktreeIgnored: true });
  const subdirPath = path.join(repo, ".worktree", "foo");
  mkdirSync(subdirPath, { recursive: true });
  const filePath = path.join(subdirPath, ".cross-model-sticky-bar.md");
  writeFileSync(filePath, "sticky\n");

  const result = evaluatePreToolUsePayload({
    tool_name: "Write",
    tool_input: { file_path: filePath, cwd: repo },
  });

  // null means all gates ran and none fired (allowed). PASS_THROUGH is only
  // returned when the tool itself is not in the gate inventory (non-Write tool).
  // For Write tool: ALLOW ⇒ null, BLOCK ⇒ { block: true, reason: "…" }.
  assert.equal(
    result,
    null,
    "subdir sticky containment 依賴 gitignored-non-promotable + protected-branch gate, NOT isBodyCarrierPath — " +
    "gitignored subdir sticky on protected branch must be ALLOWED (gitignore carve in checkFileWrite)"
  );
});

// Matrix test 4 ─────────────────────────────────────────────────────────────
test("matrix[subdir sticky, non-protected feature/x] → ALLOW (protected-branch gate skips non-protected)", () => {
  const repo = makeGitRepoOnBranch("feature/x", { worktreeIgnored: false });
  const subdirPath = path.join(repo, ".worktree", "foo");
  mkdirSync(subdirPath, { recursive: true });
  const filePath = path.join(subdirPath, ".cross-model-sticky-bar.md");
  writeFileSync(filePath, "sticky\n");

  const result = evaluatePreToolUsePayload({
    tool_name: "Write",
    tool_input: { file_path: filePath, cwd: repo },
  });

  // null means all gates ran and none fired (allowed); see matrix test 3 comment.
  assert.equal(
    result,
    null,
    "subdir sticky on non-protected branch (feature/x) must be ALLOWED — protected-branch gate only fires on protected branches"
  );
});
