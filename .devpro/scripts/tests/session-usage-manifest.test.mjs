import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  USAGE_MANIFEST_SCHEMA,
  buildUsageManifest,
  captureTlHostSession,
  collectChangeScopedExternalReviewerSessions,
  discoverUsageManifests,
  extractReviewerSessionEntry,
  readUsageManifest,
  renderManifestRollupMarkdown,
  rollupManifestUsage,
  usageManifestPath,
  writeUsageManifest,
} from "../lib/session-usage-manifest.mjs";
import { isValidNeutralSessionIdShape, isValidSessionIdShape, readClaudeCodeSession, readCodexSession } from "../lib/session-token-usage.mjs";
import { acquireCapacityLockForTest } from "../hooks/lib/second-review-control-evidence.mjs";

const DISPATCH_ID = "dispatch-41b8151c-650b-4a6b-bd1e-9143ab9dd894";
const TL_SESSION = "11111111-1111-1111-1111-111111111111";
const REVIEWER_SESSION = "22222222-2222-2222-2222-222222222222";

function manifestForRetentionTest() {
  return {
    schema: USAGE_MANIFEST_SCHEMA,
    dispatch_id: DISPATCH_ID,
    attempt_id: "attempt-retention-safety",
    repository_slug: "owner/repo",
    head_ref_oid: "abc123",
    mode: "audit-only",
    review_target: "design",
    recorded_at: new Date().toISOString(),
    sessions: [],
    gaps: [],
  };
}

describe("session-usage-manifest", () => {
  it("paged coverage keeps missing windows despite another reviewer row and deduplicates shared sessions", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "usage-paged-"));
    try {
      const context = { reviewer_cli_recipe: { tool: "claude" } };
      const dispatchRecord = { dispatch_id: DISPATCH_ID };
      const build = (index, sessionId, coverage) => buildUsageManifest({ context, dispatchRecord,
        env: { CODEX_SESSION_ID: TL_SESSION }, boundedEvidence: { terminal: { type: "result", session_id: sessionId } },
        invokedWindowIndex: index, pagedCoverage: coverage });
      let coverage = { planned_window_count: 4, invoked_windows: [] };
      for (const [index, sessionId] of [[1, REVIEWER_SESSION], [2, REVIEWER_SESSION], [3, null]]) {
        const manifest = build(index, sessionId, coverage);
        coverage = manifest.paged_coverage;
        writeUsageManifest({ rootDir: root, manifest });
      }
      const manifest = readUsageManifest({ rootDir: root, dispatchId: DISPATCH_ID });
      assert.equal(manifest.sessions.filter(row => row.role === "reviewer").length, 1);
      assert.equal(manifest.paged_coverage.invoked_window_count, 3);
      assert.deepEqual(manifest.paged_coverage.invoked_windows.map(row => row.index), [1, 2, 3]);
      assert.ok(manifest.gaps.some(gap => gap.name === "reviewer-window-session-missing" && gap.window_index === 3));
      assert.ok(!manifest.gaps.some(gap => gap.window_index === 4), "uninvoked future windows are not missing paid sessions");
      const rollup = rollupManifestUsage({ manifests: [manifest], roots: {}, collectSessionUsage: () => ({ available: true, totals: { input: 1, output: 2, cache_read: 0, cache_creation: null }, gaps: [] }) });
      assert.equal(rollup.arithmeticTotals.output, 4);
      assert.equal(rollup.coverage_status, "partial");
      assert.ok(rollup.gaps.some(gap => gap.name === "reviewer-window-session-missing"));
      const scoped = collectChangeScopedExternalReviewerSessions({ evidenceRoot: root, checkpointSessions: [{ session_id: TL_SESSION }] });
      assert.ok(scoped.gaps.some(gap => gap.name === "reviewer-window-session-missing"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("paged coverage detects invoked missing rows and legacy coverage remains unknown", () => {
    const manifest = { ...manifestForRetentionTest(), sessions: [{ role: "reviewer", host: "codex", session_id: REVIEWER_SESSION }],
      paged_coverage: { planned_window_count: 3, invoked_window_count: 2, invoked_windows: [{ index: 1, host: "codex", session_id: REVIEWER_SESSION }, { index: 2, host: "codex", session_id: TL_SESSION }] } };
    const collect = () => ({ available: true, totals: { input: 1, output: 2, cache_read: 0, cache_creation: null }, gaps: [] });
    const rollup = rollupManifestUsage({ manifests: [manifest], roots: {}, collectSessionUsage: collect });
    assert.equal(rollup.coverage_status, "partial");
    assert.ok(rollup.gaps.some(gap => gap.name === "reviewer-window-row-missing" && gap.window_index === 2));
    const legacy = rollupManifestUsage({ manifests: [{ ...manifest, paged_coverage: undefined }], roots: {}, collectSessionUsage: collect });
    assert.equal(legacy.coverage_status, "unknown");
    assert.ok(legacy.gaps.some(gap => gap.name === "reviewer-window-coverage-unknown"));
    assert.equal(rollupManifestUsage({ manifests: [], roots: {}, collectSessionUsage: collect }).coverage_status, "complete");
    for (const coverage of [{ planned_window_count: 0, invoked_window_count: 0, invoked_windows: [] },
      { planned_window_count: 1, invoked_window_count: 1, invoked_windows: [{ index: 2 }] }]) {
      const invalid = rollupManifestUsage({ manifests: [{ ...manifest, paged_coverage: coverage }], roots: {}, collectSessionUsage: collect });
      assert.equal(invalid.coverage_status, "partial");
      assert.ok(invalid.gaps.some(gap => gap.name === "reviewer-window-coverage-invalid"));
    }
    const repeatedPage = { ...manifest, paged_coverage: { planned_window_count: 1, invoked_window_count: 2,
      invoked_windows: [1, 2].map(index => ({ index, host: "codex", session_id: REVIEWER_SESSION })) } };
    assert.equal(rollupManifestUsage({ manifests: [repeatedPage], roots: {}, collectSessionUsage: collect }).coverage_status, "complete", "planned material windows do not cap invocation indices when terminalization repeats a page");
  });

  it("Traversal-shaped dispatch ID is rejected before path construction", () => {
    assert.throws(() => usageManifestPath("/tmp/evidence", "../outside"), /dispatch[_ ]id/i);
  });

  it("captureTlHostSession prefers CODEX_SESSION_ID", () => {
    const entry = captureTlHostSession({
      CODEX_SESSION_ID: TL_SESSION,
      CLAUDE_SESSION_ID: REVIEWER_SESSION,
    });
    assert.equal(entry.host, "codex");
    assert.equal(entry.session_id, TL_SESSION);
    assert.equal(entry.role, "tl-host");
    assert.equal(entry.source, "env:CODEX_SESSION_ID");
  });

  it("captureTlHostSession source matches the validated env var", () => {
    const entry = captureTlHostSession({
      CODEX_SESSION_ID: "not-a-valid-session-id",
      CODEX_THREAD_ID: TL_SESSION,
    });
    assert.equal(entry.session_id, TL_SESSION);
    assert.equal(entry.source, "env:CODEX_THREAD_ID");
  });

  // F-a7c19d2e (round 2): the real Claude Code CLI host process only ever
  // sets CLAUDE_CODE_SESSION_ID — none of CLAUDE_SESSION_ID /
  // CLAUDE_CONVERSATION_ID / DEVPRO_POST_PR_COMPLETION_SESSION_ID are ever
  // populated there (live probe). Before the fix this unseeded real path
  // returned null.
  it("captureTlHostSession resolves the real Claude Code CLI host env shape (only CLAUDE_CODE_SESSION_ID set)", () => {
    const entry = captureTlHostSession({
      CLAUDE_CODE_SESSION_ID: TL_SESSION,
    });
    assert.equal(entry.host, "claude-code");
    assert.equal(entry.session_id, TL_SESSION);
    assert.equal(entry.role, "tl-host");
    assert.equal(entry.source, "env:CLAUDE_CODE_SESSION_ID");
  });

  it("captureTlHostSession still prefers CLAUDE_SESSION_ID over CLAUDE_CODE_SESSION_ID when both are set", () => {
    const entry = captureTlHostSession({
      CLAUDE_SESSION_ID: TL_SESSION,
      CLAUDE_CODE_SESSION_ID: REVIEWER_SESSION,
    });
    assert.equal(entry.session_id, TL_SESSION);
    assert.equal(entry.source, "env:CLAUDE_SESSION_ID");
  });

  it("extractReviewerSessionEntry reads claude result.session_id", () => {
    const entry = extractReviewerSessionEntry({
      terminal: {
        type: "result",
        session_id: REVIEWER_SESSION,
      },
    }, "claude");
    assert.equal(entry.host, "claude-code");
    assert.equal(entry.session_id, REVIEWER_SESSION);
  });

  it("writeUsageManifest merges sessions idempotently", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-"));
    try {
      const dispatchRecord = {
        dispatch_id: DISPATCH_ID,
        attempt_id: "attempt-1",
        repository_slug: "owner/repo",
        head_ref_oid: "abc123",
      };
      const context = { mode: "audit-only", target: "design", reviewer_cli_recipe: { tool: "claude" } };
      const first = buildUsageManifest({
        context,
        dispatchRecord,
        env: { CODEX_SESSION_ID: TL_SESSION },
        boundedEvidence: null,
      });
      writeUsageManifest({ rootDir: root, manifest: first });
      const second = buildUsageManifest({
        context,
        dispatchRecord,
        env: {},
        boundedEvidence: {
          terminal: { type: "result", session_id: REVIEWER_SESSION },
        },
      });
      writeUsageManifest({ rootDir: root, manifest: second });
      const stored = readUsageManifest({ rootDir: root, dispatchId: DISPATCH_ID });
      assert.equal(stored.schema, USAGE_MANIFEST_SCHEMA);
      assert.equal(stored.sessions.length, 2);
      const onDisk = JSON.parse(readFileSync(path.join(root, DISPATCH_ID, "usage-manifest.json"), "utf8"));
      assert.equal(onDisk.sessions.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Merged manifest is retained beside the visible dispatch copy", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-retention-"));
    try {
      const dispatchRecord = {
        dispatch_id: DISPATCH_ID,
        attempt_id: "attempt-retained-merge",
        repository_slug: "owner/repo",
        head_ref_oid: "abc123",
      };
      const context = { mode: "audit-only", target: "design", reviewer_cli_recipe: { tool: "claude" } };
      const existing = buildUsageManifest({
        context,
        dispatchRecord,
        env: { CODEX_SESSION_ID: TL_SESSION },
        boundedEvidence: null,
      });
      writeUsageManifest({ rootDir: root, manifest: existing });
      const incoming = buildUsageManifest({
        context,
        dispatchRecord,
        env: {},
        boundedEvidence: {
          terminal: { type: "result", session_id: REVIEWER_SESSION },
        },
      });

      const { record: merged } = writeUsageManifest({ rootDir: root, manifest: incoming });
      const visiblePath = path.join(root, DISPATCH_ID, "usage-manifest.json");
      const retentionDirectory = path.join(root, ".usage-manifest-retention");
      const retainedPath = path.join(retentionDirectory, `${DISPATCH_ID}.json`);

      assert.equal(merged.sessions.length, 2, "fixture must exercise a merged manifest");
      assert.equal(readFileSync(visiblePath, "utf8"), `${JSON.stringify(merged, null, 2)}\n`);
      assert.equal(
        readFileSync(retainedPath, "utf8"),
        readFileSync(visiblePath, "utf8"),
        "hidden retained copy must contain the identical merged manifest",
      );
      if (process.platform !== "win32") {
        assert.equal(statSync(retentionDirectory).mode & 0o777, 0o700);
        assert.equal(statSync(retainedPath).mode & 0o777, 0o600);
      }
      assert.deepEqual(readdirSync(retentionDirectory).sort(), [`${DISPATCH_ID}.json`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a pre-existing retention symlink without writing outside the evidence root", { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-retention-link-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-retention-outside-"));
    const retentionDirectory = path.join(root, ".usage-manifest-retention");
    try {
      symlinkSync(outside, retentionDirectory, "dir");

      assert.throws(
        () => writeUsageManifest({ rootDir: root, manifest: manifestForRetentionTest() }),
        /retention directory.*(symlink|symbolic|directory)/i,
      );
      assert.deepEqual(readdirSync(outside), [], "the rejected symlink must not receive a retained manifest");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not read a retained manifest through a symlinked retention directory", { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-retention-read-link-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-retention-read-outside-"));
    const retentionDirectory = path.join(root, ".usage-manifest-retention");
    try {
      writeFileSync(path.join(outside, `${DISPATCH_ID}.json`), `${JSON.stringify(manifestForRetentionTest(), null, 2)}\n`, "utf8");
      symlinkSync(outside, retentionDirectory, "dir");

      assert.equal(readUsageManifest({ rootDir: root, dispatchId: DISPATCH_ID }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a pre-existing retention path that is a regular file", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-retention-file-"));
    const retentionPath = path.join(root, ".usage-manifest-retention");
    try {
      writeFileSync(retentionPath, "keep this file", "utf8");

      assert.throws(
        () => writeUsageManifest({ rootDir: root, manifest: manifestForRetentionTest() }),
        /retention directory.*(real directory|directory)/i,
      );
      assert.equal(readFileSync(retentionPath, "utf8"), "keep this file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a pre-existing retention directory with permissions broader than 0o700", { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-retention-mode-"));
    const retentionDirectory = path.join(root, ".usage-manifest-retention");
    try {
      mkdirSync(retentionDirectory, { mode: 0o700 });
      chmodSync(retentionDirectory, 0o755);

      assert.throws(
        () => writeUsageManifest({ rootDir: root, manifest: manifestForRetentionTest() }),
        /retention directory.*(permissions|mode|0o700)/i,
      );
      assert.equal(statSync(retentionDirectory).mode & 0o777, 0o755, "unsafe permissions must not be silently retained");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeUsageManifest waits for the shared capacity lock", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-lock-"));
    const resumePath = path.join(root, "resume-writer");
    const releaseLock = acquireCapacityLockForTest(root);
    const manifestModuleUrl = new URL("../lib/session-usage-manifest.mjs", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const { existsSync } = await import("node:fs");
      const { writeUsageManifest, USAGE_MANIFEST_SCHEMA } = await import(${JSON.stringify(manifestModuleUrl)});
      const nativeWait = Atomics.wait;
      let waitCount = 0;
      Atomics.wait = (...args) => {
        waitCount += 1;
        if (waitCount === 1) {
          process.stdout.write("waiting\\n");
          // Let production finish a real wait and retry the still-held lock.
          return nativeWait(...args);
        }
        if (waitCount === 2) {
          process.stdout.write("waiting-again\\n");
          // The second wait proves the writer did not publish after its first
          // wait. Park here so fixture release is outside filesystem probes;
          // concurrent native-Windows rename behavior is a separate concern.
          while (!existsSync(${JSON.stringify(resumePath)})) nativeWait(...args);
        }
        return nativeWait(...args);
      };
      writeUsageManifest({ rootDir: ${JSON.stringify(root)}, manifest: {
        schema: USAGE_MANIFEST_SCHEMA,
        dispatch_id: ${JSON.stringify(DISPATCH_ID)},
        attempt_id: "attempt-lock-serialize",
        repository_slug: "owner/repo",
        head_ref_oid: "abc123",
        mode: "audit-only",
        review_target: "design",
        recorded_at: new Date().toISOString(),
        sessions: [],
        gaps: [],
      }});
      Atomics.wait = nativeWait;
      process.stdout.write("done\\n");
    `]);
    let stdout = "";
    let stderr = "";
    const exitPromise = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("writer subprocess did not retry the held capacity lock")), 5000);
        const onData = () => {
          if (stdout.includes("waiting-again\n")) {
            clearTimeout(timeout);
            child.stdout.off("data", onData);
            resolve();
          }
        };
        child.stdout.on("data", onData);
        child.once("error", reject);
        child.once("exit", (code) => {
          if (!stdout.includes("waiting-again\n")) reject(new Error(`writer subprocess exited before retrying the held lock (${code}): ${stderr}`));
        });
      });
      const completedWhileLocked = stdout.includes("done\n");
      releaseLock();
      writeFileSync(resumePath, "continue\n");
      const exitCode = await exitPromise;
      assert.equal(exitCode, 0, `writer subprocess failed: ${stderr}`);
      assert.equal(completedWhileLocked, false, "writer must wait until cleanup releases the shared capacity lock");
      assert.equal(readUsageManifest({ rootDir: root, dispatchId: DISPATCH_ID }).dispatch_id, DISPATCH_ID);
    } finally {
      try { releaseLock(); } catch {}
      if (child.exitCode === null && child.pid) {
        child.kill("SIGKILL");
        await exitPromise;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discoverUsageManifests filters by dispatch id list", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-discover-"));
    try {
      writeUsageManifest({
        rootDir: root,
        manifest: {
          schema: USAGE_MANIFEST_SCHEMA,
          dispatch_id: DISPATCH_ID,
          attempt_id: "attempt-1",
          repository_slug: "owner/repo",
          head_ref_oid: "abc123",
          mode: "audit-only",
          review_target: "design",
          recorded_at: "2026-08-27T08:34:13.000Z",
          sessions: [{ role: "tl-host", host: "codex", session_id: TL_SESSION, source: "env" }],
          gaps: [],
        },
      });
      const { manifests: found } = discoverUsageManifests({
        rootDir: root,
        dispatchIds: [DISPATCH_ID],
      });
      assert.equal(found.length, 1);
      assert.equal(found[0].dispatch_id, DISPATCH_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discoverUsageManifests reports explicitly requested missing dispatch ids", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-missing-"));
    try {
      const { manifests, missingDispatchIds } = discoverUsageManifests({
        rootDir: root,
        dispatchIds: [DISPATCH_ID, "dispatch-missing-manifest"],
      });
      assert.equal(manifests.length, 0);
      assert.deepEqual(missingDispatchIds, [DISPATCH_ID, "dispatch-missing-manifest"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rollupManifestUsage emits usage-manifest-missing gaps for requested absent dispatches", () => {
    const collectSessionUsage = () => ({
      available: true,
      host: "codex",
      session: TL_SESSION,
      source: "exact",
      totals: { input: 1, output: 2, cache_read: 0, cache_creation: null },
      cost_usd: null,
      gaps: [],
      turns: [],
    });
    const rollup = rollupManifestUsage({
      manifests: [],
      missingDispatchIds: ["dispatch-missing-a", "dispatch-missing-b"],
      collectSessionUsage,
      roots: { claudeRoot: "/claude", codexRoot: "/codex" },
      env: {},
      cwdRoots: [],
    });
    assert.equal(rollup.gaps.filter((gap) => gap.name === "usage-manifest-missing").length, 2);
    const markdown = renderManifestRollupMarkdown(rollup, { top: 5 });
    assert.match(markdown, /usage-manifest-missing\(dispatch-missing-a\)/);
  });

  it("rollupManifestUsage sums numeric totals across manifest sessions", () => {
    const collectSessionUsage = ({ host, sessionId }) => ({
      available: true,
      host,
      session: sessionId,
      source: "exact",
      totals: { input: 10, output: 20, cache_read: 5, cache_creation: 0 },
      cost_usd: host === "claude-code" ? 1.5 : null,
      gaps: [],
      turns: [],
    });
    const rollup = rollupManifestUsage({
      manifests: [{
        dispatch_id: DISPATCH_ID,
        sessions: [
          { role: "tl-host", host: "codex", session_id: TL_SESSION },
          { role: "reviewer", host: "claude-code", session_id: REVIEWER_SESSION },
        ],
        gaps: [],
      }],
      collectSessionUsage,
      roots: { claudeRoot: "/claude", codexRoot: "/codex" },
      env: {},
      cwdRoots: [],
    });
    assert.equal(rollup.arithmeticTotals.input, 20);
    assert.equal(rollup.arithmeticTotals.output, 40);
    assert.equal(rollup.cost_usd, 1.5);
    const markdown = renderManifestRollupMarkdown(rollup, { top: 5 });
    assert.match(markdown, /算術彙總（非 host 對帳）/);
    assert.match(markdown, /dispatch-41b8151c/);
  });

  it("extractReviewerSessionEntry reads codex thread.started.thread_id", () => {
    const entry = extractReviewerSessionEntry({
      stdoutStructuredEvents: [
        { type: "thread.started", thread_id: REVIEWER_SESSION },
      ],
    }, "codex");
    assert.equal(entry.host, "codex");
    assert.equal(entry.session_id, REVIEWER_SESSION);
    assert.match(entry.source, /thread_id/);
  });

  it("Codex review-time usage is stored as normalized totals only", () => {
    const manifest = buildUsageManifest({
      context: { mode: "audit-only", target: "design", reviewer_cli_recipe: { tool: "codex" } },
      dispatchRecord: {
        dispatch_id: DISPATCH_ID,
        attempt_id: "attempt-codex-snapshot",
        repository_slug: "owner/repo",
        head_ref_oid: "abc123",
      },
      env: { CODEX_SESSION_ID: TL_SESSION },
      boundedEvidence: {
        stdoutStructuredEvents: [
          { type: "thread.started", thread_id: REVIEWER_SESSION },
          { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 45, output_tokens: 17 } },
        ],
      },
    });
    const reviewer = manifest.sessions.find((session) => session.role === "reviewer");
    assert.deepEqual(reviewer.usage_snapshot, {
      totals: { input: 75, output: 17, cache_read: 45, cache_creation: null },
      source: "reviewer-manifest:turn.completed.usage",
    });
  });

  it("Missing snapshot and Claude reviewer keep existing behavior", () => {
    const manifest = buildUsageManifest({
      context: { mode: "audit-only", target: "design", reviewer_cli_recipe: { tool: "claude" } },
      dispatchRecord: {
        dispatch_id: DISPATCH_ID,
        attempt_id: "attempt-claude-no-snapshot",
        repository_slug: "owner/repo",
        head_ref_oid: "abc123",
      },
      boundedEvidence: { terminal: { type: "result", session_id: REVIEWER_SESSION } },
      env: {},
    });
    const reviewer = manifest.sessions.find((session) => session.role === "reviewer");
    assert.equal(reviewer.host, "claude-code");
    assert.equal(reviewer.session_id, REVIEWER_SESSION);
    assert.equal(Object.hasOwn(reviewer, "usage_snapshot"), false);
  });

  it("rollupManifestUsage deduplicates repeated host+session_id across dispatches", () => {
    const collectSessionUsage = ({ host, sessionId }) => ({
      available: true,
      host,
      session: sessionId,
      source: "exact",
      totals: { input: 10, output: 20, cache_read: 5, cache_creation: 0 },
      cost_usd: null,
      gaps: [],
      turns: [],
    });
    const session = { role: "tl-host", host: "codex", session_id: TL_SESSION };
    const rollup = rollupManifestUsage({
      manifests: [
        { dispatch_id: "dispatch-a", sessions: [session], gaps: [] },
        { dispatch_id: "dispatch-b", sessions: [session], gaps: [] },
      ],
      collectSessionUsage,
      roots: { claudeRoot: "/claude", codexRoot: "/codex" },
      env: {},
      cwdRoots: [],
    });
    assert.equal(rollup.arithmeticTotals.input, 10);
    assert.equal(rollup.arithmeticTotals.output, 20);
    assert.ok(rollup.gaps.some((gap) => gap.name === "rollup-session-deduped"));
  });

  it("rollupManifestUsage deduplicates repeated dispatch ids", () => {
    const collectSessionUsage = () => ({
      available: true,
      host: "codex",
      session: TL_SESSION,
      source: "exact",
      totals: { input: 10, output: 20, cache_read: 5, cache_creation: 0 },
      cost_usd: null,
      gaps: [],
      turns: [],
    });
    const manifest = {
      dispatch_id: "dispatch-duplicate",
      sessions: [{ role: "tl-host", host: "codex", session_id: TL_SESSION }],
      gaps: [],
    };
    const rollup = rollupManifestUsage({
      manifests: [manifest, manifest],
      collectSessionUsage,
      roots: { claudeRoot: "/claude", codexRoot: "/codex" },
      env: {},
      cwdRoots: [],
    });
    assert.equal(rollup.dispatches.length, 1);
    assert.equal(rollup.lineage_attribution.dispatch_rows, 1);
    assert.equal(rollup.arithmeticTotals.input, 10);
  });

  it("separates three dispatch rows from two unique external reviewer sessions", () => {
    const reviewerTwo = "33333333-3333-3333-3333-333333333333";
    const collectSessionUsage = ({ host, sessionId }) => ({
      available: true,
      host,
      session: sessionId,
      source: "exact",
      totals: { input: sessionId === REVIEWER_SESSION ? 20 : 10, output: 5, cache_read: null, cache_creation: null },
      cost_usd: null,
      field_availability: { cache_read: "unverified-on-host", cache_creation: "unsupported-by-host", cost_usd: "unsupported-by-host" },
      gaps: [],
      turns: [],
    });
    const reviewer = (session_id) => ({ role: "reviewer", host: "claude-code", session_id });
    const rollup = rollupManifestUsage({
      manifests: [
        { dispatch_id: "dispatch-a", sessions: [reviewer(REVIEWER_SESSION)], gaps: [] },
        { dispatch_id: "dispatch-b", sessions: [reviewer(reviewerTwo)], gaps: [] },
        { dispatch_id: "dispatch-c", sessions: [reviewer(REVIEWER_SESSION)], gaps: [] },
      ],
      collectSessionUsage,
      roots: { claudeRoot: "/claude", codexRoot: "/codex" },
      env: {},
      cwdRoots: [],
    });
    assert.equal(rollup.lineage_attribution.dispatch_rows, 3);
    assert.equal(rollup.lineage_attribution.external_reviewer_sessions, 2);
    assert.equal(rollup.lineage_attribution.unique_sessions.length, 2);
    assert.equal(rollup.arithmeticTotals.input, 30);
  });

  it("rollupManifestUsage preserves unknown cache_creation instead of zero", () => {
    const collectSessionUsage = () => ({
      available: true,
      host: "codex",
      session: TL_SESSION,
      source: "exact",
      totals: { input: 1, output: 2, cache_read: 3, cache_creation: null },
      cost_usd: null,
      gaps: [{ name: "cache-creation-unverified-on-host" }],
      turns: [],
    });
    const rollup = rollupManifestUsage({
      manifests: [{
        dispatch_id: DISPATCH_ID,
        sessions: [{ role: "tl-host", host: "codex", session_id: TL_SESSION }],
        gaps: [],
      }],
      collectSessionUsage,
      roots: { claudeRoot: "/claude", codexRoot: "/codex" },
      env: {},
      cwdRoots: [],
    });
    assert.equal(rollup.arithmeticTotals.cache_creation, null);
    const markdown = renderManifestRollupMarkdown(rollup, { top: 5 });
    assert.match(markdown, /cache_creation —/);
  });

  it("rollupManifestUsage withholds mixed null+numeric cache_creation aggregate", () => {
    const collectSessionUsage = ({ host }) => ({
      available: true,
      host,
      session: host === "codex" ? TL_SESSION : REVIEWER_SESSION,
      source: "exact",
      totals: host === "codex"
        ? { input: 1, output: 2, cache_read: 3, cache_creation: null }
        : { input: 10, output: 20, cache_read: 30, cache_creation: 40 },
      cost_usd: null,
      gaps: host === "codex" ? [{ name: "cache-creation-unverified-on-host" }] : [],
      turns: [],
    });
    const rollup = rollupManifestUsage({
      manifests: [{
        dispatch_id: DISPATCH_ID,
        sessions: [
          { role: "tl-host", host: "codex", session_id: TL_SESSION },
          { role: "reviewer", host: "claude-code", session_id: REVIEWER_SESSION },
        ],
        gaps: [],
      }],
      collectSessionUsage,
      roots: { claudeRoot: "/claude", codexRoot: "/codex" },
      env: {},
      cwdRoots: [],
    });
    assert.equal(rollup.arithmeticTotals.cache_creation, null);
    assert.ok(rollup.gaps.some((gap) => gap.name === "rollup-cache-creation-partial"));
    assert.ok(rollup.gaps.some((gap) => gap.name === "cache-creation-unverified-on-host"));
    const markdown = renderManifestRollupMarkdown(rollup, { top: 5 });
    assert.match(markdown, /cache_creation —/);
    assert.match(markdown, /算術彙總[\s\S]*- gaps: .*rollup-cache-creation-partial/);
  });

  it("writeUsageManifest drops healed session-missing gaps on merge", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "usage-manifest-gap-heal-"));
    try {
      const dispatchRecord = {
        dispatch_id: DISPATCH_ID,
        attempt_id: "attempt-1",
        repository_slug: "owner/repo",
        head_ref_oid: "abc123",
      };
      const context = { mode: "audit-only", target: "design", reviewer_cli_recipe: { tool: "claude" } };
      writeUsageManifest({
        rootDir: root,
        manifest: buildUsageManifest({
          context,
          dispatchRecord,
          env: {},
          boundedEvidence: null,
        }),
      });
      writeUsageManifest({
        rootDir: root,
        manifest: buildUsageManifest({
          context,
          dispatchRecord,
          env: { CODEX_SESSION_ID: TL_SESSION },
          boundedEvidence: {
            terminal: { type: "result", session_id: REVIEWER_SESSION },
          },
        }),
      });
      const stored = readUsageManifest({ rootDir: root, dispatchId: DISPATCH_ID });
      assert.equal(stored.sessions.length, 2);
      assert.equal(stored.gaps.some((gap) => gap.name === "tl-host-session-missing"), false);
      assert.equal(stored.gaps.some((gap) => gap.name === "reviewer-session-missing"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rollupManifestUsage sanitizes item text before export", () => {
    const collectSessionUsage = () => ({
      available: true,
      host: "codex",
      session: TL_SESSION,
      source: "exact",
      totals: { input: 1, output: 2, cache_read: 0, cache_creation: 0 },
      cost_usd: null,
      gaps: [],
      turns: [{ item: "| evil | table |\n@mention", tokens: { output: 2 } }],
    });
    const rollup = rollupManifestUsage({
      manifests: [{
        dispatch_id: DISPATCH_ID,
        sessions: [{ role: "tl-host", host: "codex", session_id: TL_SESSION }],
        gaps: [],
      }],
      collectSessionUsage,
      roots: { claudeRoot: "/claude", codexRoot: "/codex" },
      env: {},
      cwdRoots: [],
      homeDir: "/Users/test",
    });
    const item = rollup.dispatches[0].sessions[0].usage.turns[0].item;
    assert.equal(item.includes("|"), false);
    assert.equal(item.includes("@mention"), false);
  });

  it("R5: empty checkpoint + reviewer manifest emits external-reviewer-scope-unbound (no false zero)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devpro-usage-unbound-empty-"));
    try {
      writeUsageManifest({
        rootDir: root,
        manifest: {
          schema: USAGE_MANIFEST_SCHEMA,
          dispatch_id: "dispatch-unbound-empty",
          attempt_id: "attempt-1",
          repository_slug: "owner/repo",
          head_ref_oid: "abc",
          mode: "pr-sticky",
          review_target: "PR #1",
          recorded_at: "2026-01-01T00:00:00.000Z",
          sessions: [
            { role: "tl-host", host: "claude-code", session_id: TL_SESSION, source: "fixture" },
            { role: "reviewer", host: "claude-code", session_id: REVIEWER_SESSION, source: "fixture" },
          ],
          gaps: [],
        },
      });
      const result = collectChangeScopedExternalReviewerSessions({
        evidenceRoot: root,
        checkpointSessions: [],
        changeName: "fix-cross-review-visibility",
      });
      assert.equal(result.externalSessions.length, 0);
      assert.ok(result.gaps.some((gap) => gap.name === "external-reviewer-scope-unbound"));
      assert.equal(result.gaps[0].change_name, "fix-cross-review-visibility");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R5: non-overlapping foreign reviewer manifest stays true-zero (no false unbound gap)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devpro-usage-foreign-nonoverlap-"));
    try {
      writeUsageManifest({
        rootDir: root,
        manifest: {
          schema: USAGE_MANIFEST_SCHEMA,
          dispatch_id: "dispatch-foreign-nonoverlap",
          attempt_id: "attempt-1",
          repository_slug: "owner/repo",
          head_ref_oid: "abc",
          mode: "pr-sticky",
          review_target: "PR #1",
          recorded_at: "2026-01-01T00:00:00.000Z",
          sessions: [
            { role: "tl-host", host: "claude-code", session_id: TL_SESSION, source: "fixture" },
            { role: "reviewer", host: "claude-code", session_id: REVIEWER_SESSION, source: "fixture" },
          ],
          gaps: [],
        },
      });
      const foreignCheckpointId = "99999999-9999-4999-8999-999999999999";
      const result = collectChangeScopedExternalReviewerSessions({
        evidenceRoot: root,
        checkpointSessions: [{ session_id: foreignCheckpointId, host: "claude-code" }],
        changeName: "fix-cross-review-visibility",
      });
      assert.equal(result.externalSessions.length, 0);
      assert.equal(
        result.gaps.filter((gap) => gap.name === "external-reviewer-scope-unbound").length,
        0,
        "foreign non-overlap with nonempty checkpoint must not manufacture unbound gaps",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captureTlHostSession falls back to the provider-neutral env and keeps claude/codex precedence (Scenario: Path assembly stays UUID-only)", () => {
    const entry = captureTlHostSession({ DEVPRO_HOST_SESSION_ID: "ses_neutral01" });
    assert.equal(entry?.host, "host-neutral");
    assert.equal(entry?.session_id, "ses_neutral01");
    assert.equal(entry?.source, "env:DEVPRO_HOST_SESSION_ID");
    const claudeWins = captureTlHostSession({
      CLAUDE_SESSION_ID: TL_SESSION,
      DEVPRO_HOST_SESSION_ID: "ses_neutral01",
    });
    assert.equal(claudeWins?.host, "claude-code");
    assert.equal(claudeWins?.session_id, TL_SESSION);
    // The neutral shape must never satisfy the UUID whitelist used for
    // transcript path assembly, and the transcript readers must reject it
    // before assembling any path (F-hsn-r1-01).
    assert.equal(isValidSessionIdShape("ses_neutral01"), false);
    assert.equal(isValidNeutralSessionIdShape("ses_neutral01"), true);
    const root = mkdtempSync(path.join(os.tmpdir(), "devpro-neutral-reader-"));
    try {
      for (const reader of [readClaudeCodeSession, readCodexSession]) {
        const result = reader({ root, sessionId: "ses_neutral01" });
        assert.equal(result.available, false);
        assert.equal(result.reason, "invalid session id shape");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rollupManifestUsage reports a no-telemetry gap for neutral host sessions (Scenario: Neutral sessions in manifests report a no-telemetry gap)", () => {
    const rollup = rollupManifestUsage({
      manifests: [{
        dispatch_id: DISPATCH_ID,
        sessions: [{ role: "tl-host", host: "host-neutral", session_id: "ses_neutral01" }],
        gaps: [],
      }],
      collectSessionUsage: () => {
        throw new Error("must not read any transcript root for host-neutral sessions");
      },
      roots: { claudeRoot: "/claude", codexRoot: "/codex" },
      env: {},
      cwdRoots: [],
    });
    assert.ok(rollup.gaps.some((gap) => gap.name === "manifest-session-unavailable"));
  });
});
