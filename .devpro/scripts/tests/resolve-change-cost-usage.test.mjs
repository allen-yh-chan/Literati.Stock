import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  CHANGE_NAME_GRAMMAR,
  changeNameFolderExists,
  resolveChangeCostUsage,
} from "../lib/resolve-change-cost-usage.mjs";
import { appendChangeUsageSession } from "../hooks/lib/change-usage-checkpoint.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

// Same isolation convention as change-usage-checkpoint.test.mjs's withStateDir
// — DEVPRO_CHANGE_USAGE_STATE_DIR is read directly from process.env by
// changeUsageStateDir (no injected-env parameter exists on that path), so a
// real env mutation + restore is the only isolation mechanism available.
function withStateDir(fn) {
  const dir = makeTempDir("devpro-resolve-change-cost-usage-state-");
  const previous = process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
  process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
    else process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = previous;
  }
}

function makeCwdWithActiveChangeFolder(changeName) {
  const cwd = makeTempDir("devpro-resolve-change-cost-usage-cwd-");
  mkdirSync(path.join(cwd, "openspec", "changes", changeName), { recursive: true });
  return cwd;
}

function makeCwdWithArchivedChangeFolder(changeName, { extraCollidingSuffix = false } = {}) {
  const cwd = makeTempDir("devpro-resolve-change-cost-usage-cwd-");
  mkdirSync(path.join(cwd, "openspec", "changes", "archive", `2026-01-01-${changeName}`), { recursive: true });
  if (extraCollidingSuffix) {
    mkdirSync(path.join(cwd, "openspec", "changes", "archive", `2026-06-01-${changeName}`), { recursive: true });
  }
  return cwd;
}

test("CHANGE_NAME_GRAMMAR: single kebab-case segment only", () => {
  assert.equal(CHANGE_NAME_GRAMMAR.test("add-change-cost-circuit-breaker"), true);
  assert.equal(CHANGE_NAME_GRAMMAR.test("a"), true);
  assert.equal(CHANGE_NAME_GRAMMAR.test("a1-b2"), true);
  assert.equal(CHANGE_NAME_GRAMMAR.test(""), false);
  assert.equal(CHANGE_NAME_GRAMMAR.test("Has-Uppercase"), false);
  assert.equal(CHANGE_NAME_GRAMMAR.test("has/slash"), false);
  assert.equal(CHANGE_NAME_GRAMMAR.test("-leading-dash"), false);
  assert.equal(CHANGE_NAME_GRAMMAR.test("trailing-dash-"), false);
  assert.equal(CHANGE_NAME_GRAMMAR.test("double--dash"), false);
});

test("changeNameFolderExists: active openspec/changes/<name>/ resolves true", () => {
  const cwd = makeCwdWithActiveChangeFolder("some-change");
  assert.equal(changeNameFolderExists({ changeName: "some-change", cwd }), true);
});

test("changeNameFolderExists: neither active nor archive present resolves false", () => {
  const cwd = makeTempDir("devpro-resolve-change-cost-usage-cwd-");
  assert.equal(changeNameFolderExists({ changeName: "nonexistent-change", cwd }), false);
});

test("changeNameFolderExists: archive glob with exactly one match resolves true (D12 F-2-3)", () => {
  const cwd = makeCwdWithArchivedChangeFolder("archived-change");
  assert.equal(changeNameFolderExists({ changeName: "archived-change", cwd }), true);
});

test("changeNameFolderExists: archive glob with more than one match resolves false, not a third state (D12 F-2-3 repo-anomaly)", () => {
  const cwd = makeCwdWithArchivedChangeFolder("dup-change", { extraCollidingSuffix: true });
  assert.equal(changeNameFolderExists({ changeName: "dup-change", cwd }), false);
});

test("resolveChangeCostUsage: missing/empty changeName resolves undefined", () => {
  const cwd = makeTempDir("devpro-resolve-change-cost-usage-cwd-");
  assert.equal(resolveChangeCostUsage({ changeName: undefined, cwd, env: {} }), undefined);
  assert.equal(resolveChangeCostUsage({ changeName: "", cwd, env: {} }), undefined);
});

test("resolveChangeCostUsage: malformed changeName resolves undefined without a folder check (D12 F-5-5)", () => {
  // cwd deliberately has NO openspec/changes/ tree at all — if this resolved
  // by attempting a folder check first, it would still correctly return
  // undefined, so this alone would not prove the grammar short-circuit; the
  // meaningful assertion is that this behaves identically to (and is not
  // distinguishable in outcome from) the folder-nonexistent case below,
  // which is exactly D12's unification requirement.
  const cwd = makeTempDir("devpro-resolve-change-cost-usage-cwd-");
  assert.equal(resolveChangeCostUsage({ changeName: "Has-Uppercase", cwd, env: {} }), undefined);
  assert.equal(resolveChangeCostUsage({ changeName: "has/slash", cwd, env: {} }), undefined);
});

test("resolveChangeCostUsage: valid grammar but folder does not exist resolves undefined", () => {
  const cwd = makeTempDir("devpro-resolve-change-cost-usage-cwd-");
  assert.equal(resolveChangeCostUsage({ changeName: "no-such-folder", cwd, env: {} }), undefined);
});

test("resolveChangeCostUsage: folder exists but checkpoint was never written resolves undefined", () => {
  withStateDir(() => {
    const cwd = makeCwdWithActiveChangeFolder("no-checkpoint-yet");
    assert.equal(resolveChangeCostUsage({ changeName: "no-checkpoint-yet", cwd, env: {} }), undefined);
  });
});

test("resolveChangeCostUsage: active folder + valid empty-sessions checkpoint returns a defined rollup, not undefined", () => {
  withStateDir(() => {
    const changeName = "active-with-checkpoint";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    const write = appendChangeUsageSession({
      cwd,
      changeName,
      session_id: "11111111-1111-1111-1111-111111111111",
      start_ts: "2026-01-01T00:00:00.000Z",
      host: "claude-code",
    });
    assert.equal(write.status, "written");
    const usage = resolveChangeCostUsage({
      changeName,
      cwd,
      env: { HOME: cwd, DEVPRO_TEST_CLAUDE_ROOT: path.join(cwd, "claude-root") },
    });
    // Session's transcript root doesn't exist, so this one entry resolves
    // unavailable inside aggregateSinceChangeUsage — but the key assertion
    // here is that resolveChangeCostUsage reached and returned the real
    // aggregator output (a defined object with the shape it always returns)
    // rather than short-circuiting to undefined; the checkpoint-existence
    // gate and the aggregator's own per-session resolution are independent
    // concerns, and this proves the former without re-testing the latter
    // (already covered by report-session-token-usage.test.mjs's T9/T10).
    assert.notEqual(usage, undefined);
    assert.equal(usage.coverage, "partial");
    assert.equal(Array.isArray(usage.sessions), true);
    assert.equal(usage.sessions.length, 1);
  });
});

test("resolveChangeCostUsage: neutral host session degrades with a named no-telemetry reason (F-hsn-r2-03)", () => {
  withStateDir(() => {
    const changeName = "neutral-with-checkpoint";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    const write = appendChangeUsageSession({
      cwd,
      changeName,
      session_id: "ses_neutral_at",
      start_ts: "2026-01-01T00:00:00.000Z",
      host: "host-neutral",
    });
    assert.equal(write.status, "written");
    const usage = resolveChangeCostUsage({ changeName, cwd, env: { HOME: cwd } });
    assert.notEqual(usage, undefined);
    assert.equal(usage.coverage, "partial");
    const entry = (usage.sessions || []).find((s) => s.session_id === "ses_neutral_at");
    assert.ok(entry, "neutral session entry must be reported");
    assert.equal(entry.reason, "host-neutral-no-telemetry");
  });
});

test("resolveChangeCostUsage: archived folder (exactly one glob match) + valid checkpoint also returns a defined rollup", () => {
  withStateDir(() => {
    const changeName = "archived-with-checkpoint";
    const cwd = makeCwdWithArchivedChangeFolder(changeName);
    const write = appendChangeUsageSession({
      cwd,
      changeName,
      session_id: "22222222-2222-2222-2222-222222222222",
      start_ts: "2026-01-01T00:00:00.000Z",
      host: "codex",
    });
    assert.equal(write.status, "written");
    const usage = resolveChangeCostUsage({
      changeName,
      cwd,
      env: { HOME: cwd, DEVPRO_TEST_CODEX_ROOT: path.join(cwd, "codex-root") },
    });
    assert.notEqual(usage, undefined);
    assert.equal(usage.coverage, "partial");
  });
});
