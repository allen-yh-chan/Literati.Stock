/**
 * hook-session-pending-cleanup.test.mjs
 *
 * Unit tests for .devpro/scripts/hooks/session-pending-cleanup-check.mjs
 *
 * Per session-pending-lifecycle.md §完成刪除:
 *   主路徑：條目完成 → 刪除該條（不留 ✅）
 *   末端 housekeeping：全刪完 → 刪空檔
 *
 * Hook behavior:
 *  - boilerplate-only drained file → auto-delete, no stdout
 *  - zero-item non-boilerplate content → concise warning
 *
 * Test cases:
 *  1. notes/session-pending.md missing → exit 0, empty stdout
 *  2. File exists, all items deleted (boilerplate only) → exit 0, empty stdout, file removed
 *  3. File exists, has active list items → exit 0, empty stdout (not all deleted)
 *  4. File exists, only prose (no list items) → exit 0, stdout JSON (inspect malformed content)
 *  5. File exists, malformed content but dedup marker recent → exit 0, empty stdout
 *  6. systemMessage content is concise and does not ask for manual rm/git rm
 *  7. File with only prose paragraphs (no - or * prefix) → warning
 *  8. File with ## pending sections only (no - bullets) → countable, keep file
 *  9. dedup expires after TTL → emits again
 * 10. Unclosed HTML comment → warning and preserve file
 * 11. Closed multi-line HTML comment only → auto-delete
 * 12. Trailing prose after HTML comment close → warning and preserve file
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import { randomBytes } from "node:crypto";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/session-pending-cleanup-check.mjs"
);

// Use a temp directory as a fake repo root so tests don't touch real notes/
const TMP_ROOT = path.join(os.tmpdir(), `devpro-spc-test-${process.pid}`);
const NOTES_DIR = path.join(TMP_ROOT, "notes");
const PENDING_FILE = path.join(NOTES_DIR, "session-pending.md");

// Isolated marker dir — injected via DEVPRO_RECAP_STATE_DIR so tests never
// touch the real /tmp/devpro-recap-state used by live developer sessions.
const TEST_MARKER_DIR = path.join(
  os.tmpdir(),
  "session-pending-cleanup-test-" + randomBytes(8).toString("hex")
);
const MARKER_KEY = "session-pending-cleanup";
const MARKER_PATH = path.join(TEST_MARKER_DIR, MARKER_KEY);

function run(opts = {}) {
  // We override HOME so that git --show-toplevel resolves our fake root.
  // Strategy: init a bare-minimum git repo at TMP_ROOT so the hook's
  // `git rev-parse --show-toplevel` returns TMP_ROOT.
  // DEVPRO_RECAP_STATE_DIR injects the isolated marker dir so tests never
  // mutate the real /tmp/devpro-recap-state.
  const result = spawnSync("node", [HOOK], {
    encoding: "utf8",
    cwd: opts.cwd ?? TMP_ROOT,
    env: {
      ...process.env,
      DEVPRO_RECAP_STATE_DIR: TEST_MARKER_DIR,
      ...opts.env,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

before(() => {
  // Create fake git repo at TMP_ROOT
  mkdirSync(TMP_ROOT, { recursive: true });
  execSync("git init", { cwd: TMP_ROOT, stdio: "ignore" });
  mkdirSync(NOTES_DIR, { recursive: true });

  // Create isolated marker dir for tests
  mkdirSync(TEST_MARKER_DIR, { recursive: true });
});

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  // Clean up isolated marker dir — never touches /tmp/devpro-recap-state
  rmSync(TEST_MARKER_DIR, { recursive: true, force: true });
});

function writePending(content) {
  writeFileSync(PENDING_FILE, content, "utf8");
}

function removePending() {
  if (existsSync(PENDING_FILE)) rmSync(PENDING_FILE);
}

function removeMarker() {
  if (existsSync(MARKER_PATH)) rmSync(MARKER_PATH, { force: true });
}

function setMarkerRecent() {
  mkdirSync(TEST_MARKER_DIR, { recursive: true });
  writeFileSync(MARKER_PATH, "");
  // mtime = now (within TTL)
}

function setMarkerOld() {
  mkdirSync(TEST_MARKER_DIR, { recursive: true });
  writeFileSync(MARKER_PATH, "");
  // Set mtime to 35 minutes ago (beyond 30min TTL)
  const oldTime = new Date(Date.now() - 35 * 60_000);
  utimesSync(MARKER_PATH, oldTime, oldTime);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("file missing → exit 0, empty stdout", () => {
  removePending();
  removeMarker();
  const r = run();
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

test("all items deleted (boilerplate only) → auto-delete file and emit no stdout", () => {
  removePending();
  removeMarker();
  writePending([
    "# Session Pending（待辦暫存；落地後刪除該條）",
    "",
    "",
  ].join("\n"));
  const r = run();
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
  assert.equal(existsSync(PENDING_FILE), false, "boilerplate-only pending file should be removed");
});

test("active list items present → exit 0, empty stdout (not all deleted)", () => {
  removePending();
  removeMarker();
  writePending([
    "## Pending",
    "",
    "- Task one still active",
    "- Task two still pending",
  ].join("\n"));
  const r = run();
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

test("no list items (intro-only prose) → exit 0, stdout JSON (inspect malformed content)", () => {
  removePending();
  removeMarker();
  writePending([
    "# Session Pending",
    "",
    "This file tracks items discussed but not yet OpenSpec-ed.",
    "",
    "See session-pending-lifecycle.md for lifecycle rules.",
  ].join("\n"));
  const r = run();
  assert.equal(r.code, 0);
  assert.ok(r.stdout.trim().length > 0, "warning expected when non-boilerplate content has no list items");
  const parsed = JSON.parse(r.stdout);
  assert.ok("systemMessage" in parsed, "should have systemMessage key");
  assert.equal(existsSync(PENDING_FILE), true, "non-boilerplate content should be kept for inspection");
});

test("malformed content but dedup marker recent → exit 0, empty stdout (no duplicate emit)", () => {
  removePending();
  writePending([
    "# Pending",
    "",
    "orphan prose without list marker",
  ].join("\n"));
  setMarkerRecent();
  const r = run();
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "", "dedup should suppress emit");
  assert.equal(existsSync(PENDING_FILE), true, "dedup suppresses warning but keeps malformed content");
  removeMarker();
});

test("systemMessage content is concise and does not ask for manual rm/git rm", () => {
  removePending();
  removeMarker();
  writePending([
    "# Pending",
    "",
    "orphan prose without list marker",
  ].join("\n"));
  const r = run();
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.match(parsed.systemMessage, /有內容但沒有可計數待辦/);
  assert.doesNotMatch(
    parsed.systemMessage,
    /rm notes\/session-pending\.md|git rm|rule-design-principles\.md|session-pending-lifecycle\.md/
  );
  removeMarker();
});

test("file with only prose paragraphs (no - or * prefix) → exit 0, stdout JSON emitted", () => {
  removePending();
  removeMarker();
  writePending([
    "# Notes",
    "",
    "Some introductory text about pending items.",
    "Another paragraph without any list items.",
  ].join("\n"));
  const r = run();
  assert.equal(r.code, 0);
  assert.ok(r.stdout.trim().length > 0, "prose-only file has 0 list items → inspect warning");
  const parsed = JSON.parse(r.stdout);
  assert.ok("systemMessage" in parsed);
  assert.equal(existsSync(PENDING_FILE), true, "prose-only content should be kept for inspection");
  removeMarker();
});

test("section headers only (## pending sections) → countable, keep file, no stdout", () => {
  removePending();
  removeMarker();
  writePending([
    "## Tasks",
    "",
    "## Completed",
    "",
  ].join("\n"));
  const r = run();
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
  assert.equal(existsSync(PENDING_FILE), true, "## pending sections are countable and must not be auto-deleted");
});

test("star-bullet-only pending (* item) → countable, keep file, no stdout", () => {
  removePending();
  removeMarker();
  writePending([
    "# Session Pending",
    "",
    "* **【Star item】**",
    "  - 缺輸入: 無。",
    "  - trigger: tests",
    "  - carrier: new change",
    "",
  ].join("\n"));
  const r = run();
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
  assert.equal(existsSync(PENDING_FILE), true, "* -only legacy pending must remain countable");
});

test("dedup expires after TTL → emits again", () => {
  removePending();
  writePending([
    "# Pending",
    "",
    "orphan prose without list marker",
  ].join("\n"));
  setMarkerOld();
  const r = run();
  assert.equal(r.code, 0);
  assert.ok(r.stdout.trim().length > 0, "should emit after TTL expiry");
  const parsed = JSON.parse(r.stdout);
  assert.ok("systemMessage" in parsed);
  removeMarker();
});

test("unclosed HTML comment → warning and preserve file", () => {
  removePending();
  removeMarker();
  writePending([
    "# Pending",
    "",
    "<!-- pending item accidentally left unclosed",
    "needs review before deletion",
  ].join("\n"));
  const r = run();
  assert.equal(r.code, 0);
  assert.ok(r.stdout.trim().length > 0, "malformed comment should be inspected");
  const parsed = JSON.parse(r.stdout);
  assert.ok("systemMessage" in parsed);
  assert.equal(existsSync(PENDING_FILE), true, "unclosed comment should not be auto-deleted");
  removeMarker();
});

test("closed multi-line HTML comment only → auto-delete file and emit no stdout", () => {
  removePending();
  removeMarker();
  writePending([
    "# Pending",
    "",
    "<!--",
    "items were drained",
    "-->",
  ].join("\n"));
  const r = run();
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
  assert.equal(existsSync(PENDING_FILE), false, "closed comment-only content should be deleted");
});

test("trailing prose after HTML comment close → warning and preserve file", () => {
  removePending();
  removeMarker();
  writePending([
    "# Pending",
    "",
    "<!-- marker --> prose that should be inspected",
  ].join("\n"));
  const r = run();
  assert.equal(r.code, 0);
  assert.ok(r.stdout.trim().length > 0, "trailing prose should be inspected");
  const parsed = JSON.parse(r.stdout);
  assert.ok("systemMessage" in parsed);
  assert.equal(existsSync(PENDING_FILE), true, "trailing prose should not be auto-deleted");
  removeMarker();
});
