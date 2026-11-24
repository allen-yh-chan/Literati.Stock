/**
 * recap-utils.test.mjs
 *
 * Compatibility tests for legacy local Recap marker primitives.
 * Session ownership/evaluation is covered in recap-utils-session-isolation.
 *
 * Notes:
 *   - Discussion existence is local-only; these tests never query GitHub.
 *   - Legacy marker and stable-session state env vars point at test-owned dirs
 *     BEFORE the dynamic import; each case clears both kinds of fixture state.
 */

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const tmpRoot = makeTempDir("recap-utils-test-");
const PENDING_DIR = path.join(tmpRoot, "pending");
const STATE_DIR = path.join(tmpRoot, "state");
const IN_PROGRESS_DIR = path.join(tmpRoot, "in-progress");
const WRITTEN_DIR = path.join(tmpRoot, "written");
const SESSION_DIR = path.join(tmpRoot, "sessions");

process.env.DEVPRO_RECAP_PENDING_DIR = PENDING_DIR;
process.env.DEVPRO_RECAP_STATE_DIR = STATE_DIR;
process.env.DEVPRO_RECAP_IN_PROGRESS_DIR = IN_PROGRESS_DIR;
process.env.DEVPRO_RECAP_WRITTEN_DIR = WRITTEN_DIR;
process.env.DEVPRO_SESSION_REMINDER_STATE_DIR = SESSION_DIR;

const {
  writeRecapPendingMarker,
  writeRecapInProgressMarker,
  clearRecapPendingMarker,
  listRecapPendingMarkers,
  listRecapInProgressMarkers,
  markRecapCreationStartedForChange,
  evaluateMergedRecapPending,
  RECAP_DIAGNOSTIC_LOG_BASENAME,
  RECAP_IN_PROGRESS_DIR,
} = await import("../hooks/lib/recap-utils.mjs");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  for (const d of [PENDING_DIR, STATE_DIR, IN_PROGRESS_DIR, WRITTEN_DIR, SESSION_DIR]) {
    if (existsSync(d)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  }
});

let counter = 0;
const unique = (prefix) => `${prefix}/test-recap-marker-${process.pid}-${counter++}`;

test("writeRecapPendingMarker: work branch → marker exists with sanitized name", () => {
  const branch = unique("feature");
  writeRecapPendingMarker(branch);
  const sanitized = encodeURIComponent(branch);
  assert.ok(existsSync(path.join(PENDING_DIR, sanitized)));
});

test("writeRecapPendingMarker: main / master → no marker (non-work branch)", () => {
  writeRecapPendingMarker("main");
  writeRecapPendingMarker("master");
  assert.equal(existsSync(PENDING_DIR), false);
});

test("writeRecapPendingMarker: chore/bump-v6.30.0 → no marker (excluded)", () => {
  writeRecapPendingMarker("chore/bump-v6.30.0");
  assert.equal(existsSync(PENDING_DIR), false);
});

test("writeRecapPendingMarker: empty / falsy branch → no marker", () => {
  writeRecapPendingMarker("");
  writeRecapPendingMarker(null);
  writeRecapPendingMarker(undefined);
  assert.equal(existsSync(PENDING_DIR), false);
});

test("clearRecapPendingMarker: removes existing marker", () => {
  const branch = unique("feature");
  writeRecapPendingMarker(branch);
  clearRecapPendingMarker(branch);
  assert.equal(
    existsSync(path.join(PENDING_DIR, encodeURIComponent(branch))),
    false
  );
});

test("clearRecapPendingMarker: no-op when marker absent", () => {
  // Should not throw
  clearRecapPendingMarker(unique("feature"));
});

test("listRecapPendingMarkers: empty dir → []", () => {
  assert.deepEqual(listRecapPendingMarkers(), []);
});

test("listRecapPendingMarkers: returns desanitized branch names", () => {
  const a = unique("feature");
  const b = unique("bugfix");
  writeRecapPendingMarker(a);
  writeRecapPendingMarker(b);
  const list = listRecapPendingMarkers();
  assert.deepEqual(new Set(list), new Set([a, b]));
});

test("listRecapPendingMarkers: branch names with underscores round-trip losslessly", () => {
  const branch = "bugfix/fix_branch-name";
  writeRecapPendingMarker(branch);
  const list = listRecapPendingMarkers();
  assert.deepEqual(list, [branch]);
  assert.ok(existsSync(path.join(PENDING_DIR, encodeURIComponent(branch))));
  assert.ok(!list.includes("bugfix/fix/branch-name"));
});

test("listRecapPendingMarkers: stale marker (> 1 day mtime) auto-deleted", () => {
  const branch = unique("feature");
  writeRecapPendingMarker(branch);
  const p = path.join(PENDING_DIR, encodeURIComponent(branch));
  // Backdate 25 hours.
  const past = (Date.now() - 25 * 60 * 60_000) / 1000;
  utimesSync(p, past, past);
  const list = listRecapPendingMarkers();
  assert.equal(list.length, 0);
  assert.equal(existsSync(p), false);
});

test("recap marker cleanup preserves .log diagnostics while cleaning markers", async () => {
  mkdirSync(PENDING_DIR, { recursive: true });
  const logPath = path.join(PENDING_DIR, RECAP_DIAGNOSTIC_LOG_BASENAME);
  writeFileSync(logPath, '{"message":"old diagnostic"}\n');
  const past = (Date.now() - 25 * 60 * 60_000) / 1000;
  utimesSync(logPath, past, past);

  assert.deepEqual(listRecapPendingMarkers(), []);
  assert.equal(existsSync(logPath), true, "TTL cleanup must preserve the diagnostic log");

  writeFileSync(logPath, '{"message":"new diagnostic"}\n');
  const nonWorkBranchMarkerPath = path.join(PENDING_DIR, "main");
  writeFileSync(nonWorkBranchMarkerPath, String(Date.now()));

  assert.equal((await evaluateMergedRecapPending()).skip, true);
  assert.equal(
    existsSync(nonWorkBranchMarkerPath),
    true,
    "scoped evaluator must leave no-owner markers untouched"
  );
  assert.equal(existsSync(logPath), true, "branch cleanup must preserve the diagnostic log");
});

test("recap compatibility fixture leaves inherited session work untouched", () => {
  const fixtureEnv = {
    ...process.env,
    DEVPRO_SESSION_REMINDER_STATE_DIR: path.join(tmpRoot, "inherited-sessions"),
    DEVPRO_POST_PR_COMPLETION_SESSION_ID: "recap-parent-fixture",
    DEVPRO_HOOK_HOST: "test",
  };
  // A nested Node test runner otherwise skips every file and exits successfully.
  delete fixtureEnv.NODE_TEST_CONTEXT;
  const script = [
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    `import { resolveReminderSession, reminderSessionDir } from ${JSON.stringify(new URL("../hooks/lib/session-reminder.mjs", import.meta.url).href)};`,
    `import { recordRecapWork } from ${JSON.stringify(new URL("../hooks/lib/recap-utils.mjs", import.meta.url).href)};`,
    'const session = resolveReminderSession();',
    'assert.ok(recordRecapWork({ cwd: process.cwd(), session, branch: "feature/fixture-pending", commit: "fixture", prNumber: 1, merged: true }));',
    'const file = reminderSessionDir(process.cwd(), session) + "/recap-work.json";',
    'const before = readFileSync(file, "utf8");',
    `const child = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern", "^recap marker cleanup preserves", ${JSON.stringify(fileURLToPath(import.meta.url))}], { env: process.env, encoding: "utf8", timeout: 10_000 });`,
    'assert.equal(child.status, 0, "compatibility checks must ignore inherited own pending work");',
    'assert.match(child.stdout, /^# pass 1$/m, "the child must execute the selected compatibility case");',
    'assert.equal(readFileSync(file, "utf8"), before, "compatibility checks must not consume inherited reminder state");',
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: fixtureEnv,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(child.status, 0, child.stderr);
});

test("markRecapCreationStartedForChange: moves matching pending marker to in-progress", () => {
  const branch = "chore/lease-test";
  writeRecapPendingMarker(branch);

  const count = markRecapCreationStartedForChange("lease-test");

  assert.equal(count, 1);
  assert.deepEqual(listRecapPendingMarkers(), []);
  assert.deepEqual(listRecapInProgressMarkers(), [branch]);
});

test("markRecapCreationStartedForChange: leaves non-matching pending marker untouched", () => {
  const branch = "chore/lease-test";
  writeRecapPendingMarker(branch);

  const count = markRecapCreationStartedForChange("other-change");

  assert.equal(count, 0);
  assert.deepEqual(listRecapPendingMarkers(), [branch]);
  assert.deepEqual(listRecapInProgressMarkers(), []);
});

// Scoped evaluator behavior replaces legacy shared-marker GC/network inference;
// see recap-utils-session-isolation.test.mjs for ownership, lease and dedup coverage.
test("legacy no-owner markers are not inherited or cleaned by scoped evaluation", async () => {
  const branch = unique('feature');
  writeRecapPendingMarker(branch);
  const r = await evaluateMergedRecapPending({session: null});
  assert.equal(r.skip, true);
  assert.equal(r.reason, 'missing-session-identity');
  assert.ok(existsSync(path.join(PENDING_DIR, encodeURIComponent(branch))));
});
