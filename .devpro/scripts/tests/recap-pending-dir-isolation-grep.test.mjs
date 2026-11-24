/**
 * recap-pending-dir-isolation-grep.test.mjs
 *
 * test-governance anchor: hook-subprocess test helpers MUST isolate the
 * hook-written recap-pending marker directory (DEVPRO_RECAP_PENDING_DIR)
 * UNCONDITIONALLY — same policy the same helpers already apply to
 * DEVPRO_POSTMERGE_STATE_DIR.
 *
 * Regression guarded (Round 1 seed b): the helpers used
 *   ...(recapPendingDir ? { DEVPRO_RECAP_PENDING_DIR: recapPendingDir } : {})
 * so call sites that passed no recapPendingDir left the env var unset, the
 * hook subprocess fell back to the real devpro-recap-pending state dir, and
 * gate-written recap-pending markers leaked into the developer's live state.
 * The integration-tier file-split (PR #1607) copied the flawed helper into
 * newly split files, so this test scans the WHOLE helper family to fail closed
 * on any file — present or future-split — that re-introduces the conditional
 * form.
 *
 * Spec: openspec/specs/test-governance/spec.md
 *   Requirement: Hook Subprocess Tests Isolate Persistent State Marker Directories
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const testsDir = scriptDir;

// The hook-subprocess helper family: every test file that defines a run()/
// runSpawn() helper wiring DEVPRO_RECAP_PENDING_DIR into the subprocess env.
// Discover by content, not a hard-coded list, so a future file-split that
// copies the helper into a new file is covered automatically.
const helperFiles = readdirSync(testsDir)
  .filter((f) => f.startsWith("hook-pre-tool-gate") && f.endsWith(".test.mjs"))
  .map((f) => ({ name: f, content: readFileSync(path.join(testsDir, f), "utf8") }))
  .filter((f) => f.content.includes("DEVPRO_RECAP_PENDING_DIR"));

test("helper family for recap-pending isolation is non-empty (discovery sanity)", () => {
  assert.ok(
    helperFiles.length > 0,
    "no hook-pre-tool-gate*.test.mjs file references DEVPRO_RECAP_PENDING_DIR — " +
      "discovery glob or env-var name changed; update this anchor test"
  );
});

// Negative lock: the conditional isolation form must not appear anywhere.
const CONDITIONAL_FORM = /recapPendingDir\s*\?\s*\{\s*DEVPRO_RECAP_PENDING_DIR/;

for (const file of helperFiles) {
  test(`${file.name} isolates DEVPRO_RECAP_PENDING_DIR unconditionally (no conditional spread)`, () => {
    assert.ok(
      !CONDITIONAL_FORM.test(file.content),
      `${file.name}: found conditional recap-pending isolation ` +
        "`...(recapPendingDir ? { DEVPRO_RECAP_PENDING_DIR: ... } : {})`. " +
        "Call sites that pass no recapPendingDir leave the env var unset, so the " +
        "hook falls back to the REAL devpro-recap-pending state dir and leaks markers. " +
        "Mirror the DEVPRO_POSTMERGE_STATE_DIR pattern: create a per-invocation temp " +
        "dir when the caller passes none, set the env var unconditionally, and rm the " +
        "self-created temp dir in finally."
    );
  });

  // Positive lock (existence): a non-conditional DEVPRO_RECAP_PENDING_DIR
  // assignment must be present, so a "fix" that simply deletes the recap-pending
  // line (regressing to the real-state-dir fallback) fails this test too. The
  // right-hand side is not pinned to one variable name — inline `mkdtempSync` /
  // `makeTempDir`, a local `pendingDir`/`markerDir`, or the shared-helper
  // `tempRecapPendingDir` are all valid isolation forms; only the conditional
  // spread (negative lock) leaks.
  test(`${file.name} sets DEVPRO_RECAP_PENDING_DIR to an isolated dir (not deleted/fallback)`, () => {
    assert.ok(
      /DEVPRO_RECAP_PENDING_DIR:\s*\S/.test(file.content),
      `${file.name}: no DEVPRO_RECAP_PENDING_DIR assignment found. Deleting the ` +
        "line lets the hook fall back to the real devpro-recap-pending state dir; " +
        "the marker dir must be redirected to an isolated temp dir."
    );
  });

  // Positive lock (shared-helper pattern): files whose run()/runSpawn() helper
  // takes a caller-supplied `recapPendingDir` destructured param MUST wire it to
  // an unconditional `tempRecapPendingDir` temp dir (mirroring `tempMarkerDir`),
  // so this specific helper family cannot silently regress to the conditional
  // spread. Files that isolate inline (no `recapPendingDir` param) are exempt —
  // they were never at risk of the conditional-spread leak.
  const usesCallerSuppliedParam = /\brecapPendingDir\b\s*[,}=]/.test(file.content);
  if (usesCallerSuppliedParam) {
    test(`${file.name} wires caller-supplied recapPendingDir to an unconditional temp dir`, () => {
      assert.ok(
        /DEVPRO_RECAP_PENDING_DIR:\s*tempRecapPendingDir/.test(file.content) &&
          /const tempRecapPendingDir = recapPendingDir \|\| (?:mkdtempSync|makeTempDir)/.test(file.content),
        `${file.name}: this helper accepts a caller-supplied recapPendingDir, so it ` +
          "MUST create a per-invocation temp dir when the caller passes none " +
          "(`const tempRecapPendingDir = recapPendingDir || mkdtempSync(...)` or `makeTempDir(...)`) and set " +
          "`DEVPRO_RECAP_PENDING_DIR: tempRecapPendingDir` unconditionally, mirroring " +
          "`DEVPRO_POSTMERGE_STATE_DIR: tempMarkerDir`."
      );
    });
  }
}
