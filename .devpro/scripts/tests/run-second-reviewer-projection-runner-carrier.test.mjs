import "./lib/model-probe-fixture.mjs";
/**
 * Runner self-check + K3 acceptance/rejection matrix + process-level carrier
 * independence tests (add-second-reviewer-runner-permission T3;
 * design.md D1-D6, D9 scenarios 7-8).
 *
 * Implemented in T4; kept here as a regression test. The D2 repo-root-relative
 * runner carrier literal used below is hand-written from design.md rather than
 * imported from lib/projection-runner-carrier.mjs.
 *
 * A subset of these tests assert behavior that was already true before T4
 * landed (Node's own module resolution; the existing absolute carrier's cwd
 * independence; the existing no-args Usage: guard) and MUST stay true as a
 * regression guard.
 */
import "./lib/portable-command-shims.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { withTempDir } from "./lib/tmp.mjs";
import {
  assertAttemptUnderOwnedRoot,
  assertNotLiveWrite,
  prepareOwnedCanonicalRenderer,
} from "./lib/owned-canonical-carrier.mjs";
import { deriveMainCheckoutNotesTmp } from "../second-reviewer-cli-recipe-contract.mjs";
import { attemptLockPath } from "../lib/second-review-attempt-lock.mjs";
import { runProjection as runProjectionImpl } from "../run-second-reviewer-projection.mjs";
import { envWithoutHostMarkers } from "./lib/host-session-env.mjs";

process.env.DEVPRO_ALLOW_CLAUDE_EFFORT_STUB ??= "1";
process.env.DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB ??= "xhigh";

const renderer = repoPath(".devpro/scripts/render-second-review-packet.mjs");
const liveCanonicalCarrierRoot = path.join(path.dirname(deriveMainCheckoutNotesTmp(REPO_ROOT)), "cross-review");
const relativeRunnerScriptLiteral = ".devpro/scripts/run-second-reviewer-projection.mjs";

const auditHandoff = {
  mode: "audit-only",
  attempt: "initial",
  primary_family: "openai-codex",
  reviewer_family: "claude",
  target: "local diff",
  head_ref_oid: "none",
  repository_slug: "devpro/example",
  approval_context: "none",
  scope_summary: "bounded local runner-carrier self-check smoke",
  changed_files_or_touch_list: [
    ".devpro/scripts/run-second-reviewer-projection.mjs",
    ".devpro/scripts/render-second-review-packet.mjs",
  ],
  review_material_carrier: "embedded-diff",
  review_material_complete: true,
  review_material: "bounded diff excerpt supplied by TL handoff",
  primary_validation_evidence: "renderer and runner tests passed",
  primary_test_evidence: "targeted local smoke",
  retry_context: { classification: "none", sticky_verification: "not-needed" },
  write_path: "none",
  allowed_tools: "read-only audit mode",
};

function render(dir) {
  const handoffPath = path.join(dir, "handoff.json");
  writeFileSync(handoffPath, JSON.stringify(auditHandoff), "utf8");
  const evidenceRoot = path.join(dir, "control-evidence");
  const prepared = prepareOwnedCanonicalRenderer({
    fixtureDir: dir,
    repoRoot: REPO_ROOT,
    rendererPath: renderer,
  });
  assertNotLiveWrite(
    prepared.mutatedRendererPath,
    prepared.carrierRootArg,
    liveCanonicalCarrierRoot,
    renderer,
  );
  const result = spawnSync(
    process.execPath,
    [prepared.mutatedRendererPath, handoffPath, "--carrier-root", prepared.carrierRootArg],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // T4 fix (design.md D11): this file's every test asserts or executes
      // projection_runner_command against an EXPECTED absolute carrier (the
      // relative carrier tests below overwrite it explicitly after render()
      // returns). An ambient CLAUDE_CODE_SESSION_ID (inherited from a real
      // Claude Code CLI session running this test file) would otherwise make
      // the renderer emit the D2 relative carrier here instead, which is not
      // what this file's absolute-carrier baseline/regression-guard tests
      // (scenario 8, the self-check-acceptance-order baseline) intend to
      // exercise. Full ambient-marker coverage is T5's scope; this is the
      // narrower fix needed for THIS file's own render() calls to be
      // deterministic regardless of which host actually runs the suite.
      env: {
        ...envWithoutHostMarkers(),
        DEVPRO_ALLOW_CLAUDE_EFFORT_STUB: "1",
        DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB: "xhigh",
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
        DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(dir, "post-pr-completion-state"),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const packetPath = result.stdout.trim();
  assertAttemptUnderOwnedRoot(packetPath, prepared.ownedCarrierRoot);
  const carrierDir = path.dirname(packetPath);
  const contextPath = path.join(carrierDir, "observability-context.json");
  return {
    carrierDir,
    contextPath,
    context: JSON.parse(readFileSync(contextPath, "utf8")),
    evidenceRoot,
  };
}

function relativeCarrier(contextPath) {
  return { executable: "node", argv: [relativeRunnerScriptLiteral, path.resolve(contextPath)] };
}

function activityEvents(activityLogPath) {
  if (!existsSync(activityLogPath)) return [];
  return readFileSync(activityLogPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).event);
}

/** A byte snapshot of every write surface the D5 self-check MUST NOT touch on
 * failure (design.md D5 "失敗輸出" — no activity/heartbeat/lock/control-evidence
 * write). */
function snapshotWriteSurfaces(context) {
  const lockPath = attemptLockPath(context.observability_context_path);
  return {
    activity: existsSync(context.activity_log_path) ? readFileSync(context.activity_log_path).toString("hex") : null,
    heartbeat: existsSync(context.heartbeat_path) ? readFileSync(context.heartbeat_path).toString("hex") : null,
    lockExists: existsSync(lockPath),
    controlEvidenceEntries: existsSync(context.control_evidence_root)
      ? readdirSync(context.control_evidence_root, { recursive: true }).sort()
      : null,
  };
}

/** Deterministic empty-PATH env: guarantees no real reviewer CLI (`claude`,
 * `codex`, etc.) is ever reachable, so any run that gets far enough to probe
 * for one fails fast and safely instead of racing this test against whatever
 * happens to be on the host's ambient PATH. */
function isolatedEmptyPathEnv(context) {
  const emptyBinDir = mkdtempSync(path.join(os.tmpdir(), "second-review-runner-carrier-empty-bin-"));
  return {
    env: {
      ...process.env,
      PATH: emptyBinDir,
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
    },
    cleanup: () => rmSync(emptyBinDir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// K3 (a)/(b) accept: cwd === the runner module's own real checkout root. This
// worktree IS a linked worktree (git-branch-naming-and-anchor.md), so running
// with cwd=REPO_ROOT literally exercises K3 case (b) (case (a), main
// checkout, is the same equality check and is not separately distinguishable
// at the unit-injection level — `ownRoot` is always derived from THIS
// process's real `import.meta.url`, so a's outcome is identical to b's here).
// ---------------------------------------------------------------------------
// Scenario: Runner self-check accepts the renderer's own checkout root
test(
  "runner self-check accepts the D2 relative carrier when cwd equals the renderer's own checkout root (design.md D5 K3 case a/b)",
  async () => {
    await withTempDir(
      async (dir) => {
        const { context, contextPath } = render(dir);
        context.projection_runner_command = relativeCarrier(contextPath);
        writeFileSync(contextPath, JSON.stringify(context), "utf8");
        const { env, cleanup } = isolatedEmptyPathEnv(context);
        try {
          const result = await runProjectionImpl(contextPath, { cwd: REPO_ROOT, execPath: process.execPath, env });
          assert.notEqual(result.classification, "projection_context_invalid", result.error);
          // design.md D5 "失敗輸出": the self-check's blocked shape carries the
          // specific token in `reason`, not `classification` (same
          // classification/reason split as tool_discovery_blocked elsewhere in
          // this runner) — not `result.classification`.
          assert.notEqual(result.reason, "projection_runner_cwd_not_repo_root", result.error);
          assert.notEqual(result.reason, "projection_runner_node_mismatch", result.error);
          const events = activityEvents(context.activity_log_path);
          assert.ok(events.includes("projection_attempt_lock_acquired"), JSON.stringify(events));
          assert.ok(events.includes("projection_handoff_validated"), JSON.stringify(events));
        } finally {
          cleanup();
        }
      },
      { prefix: "second-review-runner-carrier-accept-" },
    );
  },
);

// ---------------------------------------------------------------------------
// K3 (b')/(c')/(d) reject: cwd is any real directory other than the runner's
// own checkout root. All three K3 rows collapse to the same
// `cwdReal !== ownRoot` comparison at the unit-injection level (design.md D5
// step 4) — the difference between them (which physical runner FILE Node
// would have resolved) only exists at the process level, which the dedicated
// process-level test below covers separately. Also proves zero writes on
// self-check rejection (design.md D5 "失敗輸出").
// ---------------------------------------------------------------------------
// Scenario: Runner self-check rejects another checkout before any mutation
test(
  "runner self-check rejects a cwd outside the renderer's own checkout root, with zero writes (design.md D5 K3 case b'/c'/d)",
  async () => {
    await withTempDir(
      async (dir) => {
        const { context, contextPath } = render(dir);
        context.projection_runner_command = relativeCarrier(contextPath);
        writeFileSync(contextPath, JSON.stringify(context), "utf8");
        const { env, cleanup } = isolatedEmptyPathEnv(context);
        const otherRoot = mkdtempSync(path.join(os.tmpdir(), "second-review-runner-carrier-other-root-"));
        try {
          const before = snapshotWriteSurfaces(context);
          const result = await runProjectionImpl(contextPath, { cwd: otherRoot, execPath: process.execPath, env });
          assert.equal(result.status, "blocked");
          // design.md D5 "失敗輸出": classification is the fixed bucket
          // `projection_observability_contract_missing`; the specific token
          // lives in `reason` (T4 fix: this file originally asserted the
          // token against `result.classification`, which conflicts with
          // design.md's literal object shape and with the existing
          // classification/reason twin-field convention used elsewhere in
          // this runner, e.g. tool_discovery_blocked/reason).
          assert.equal(result.classification, "projection_observability_contract_missing", result.error);
          assert.equal(result.reason, "projection_runner_cwd_not_repo_root", result.error);
          const after = snapshotWriteSurfaces(context);
          assert.deepEqual(after, before, "self-check rejection must not write activity/heartbeat/lock/control-evidence");
        } finally {
          cleanup();
          rmSync(otherRoot, { recursive: true, force: true });
        }
      },
      { prefix: "second-review-runner-carrier-reject-cwd-" },
    );
  },
);

// ---------------------------------------------------------------------------
// K3 (b') renderer-side: cwd === ownRoot, but the bootstrap carrier's argv[0]
// implies a DIFFERENT renderer root than ownRoot (design.md D5 step 3's
// `rendererRoot` derivation). Only reachable in-process, since it depends on
// the bootstrap literal in the sidecar, not on which physical runner file got
// loaded.
// ---------------------------------------------------------------------------
test(
  "runner self-check rejects renderer-root drift when the bootstrap carrier implies a different checkout (design.md D5 K3 case b', renderer-side)",
  async () => {
    await withTempDir(
      async (dir) => {
        const { context, contextPath } = render(dir);
        context.projection_runner_command = relativeCarrier(contextPath);
        const otherRendererRoot = mkdtempSync(path.join(os.tmpdir(), "second-review-runner-carrier-other-renderer-"));
        context.projection_bootstrap_command = {
          executable: process.execPath,
          argv: [
            path.join(otherRendererRoot, ".devpro/scripts/ack-second-reviewer-projection.mjs"),
            path.resolve(contextPath),
          ],
        };
        writeFileSync(contextPath, JSON.stringify(context), "utf8");
        const { env, cleanup } = isolatedEmptyPathEnv(context);
        try {
          const before = snapshotWriteSurfaces(context);
          const result = await runProjectionImpl(contextPath, { cwd: REPO_ROOT, execPath: process.execPath, env });
          // design.md D5 "失敗輸出": see the T4 fix note above — reason, not classification.
          assert.equal(result.classification, "projection_observability_contract_missing", result.error);
          assert.equal(result.reason, "projection_runner_cwd_not_repo_root", result.error);
          const after = snapshotWriteSurfaces(context);
          assert.deepEqual(after, before, "self-check rejection must not write activity/heartbeat/lock/control-evidence");
        } finally {
          cleanup();
          rmSync(otherRendererRoot, { recursive: true, force: true });
        }
      },
      { prefix: "second-review-runner-carrier-reject-rendererroot-" },
    );
  },
);

// ---------------------------------------------------------------------------
// K3 (e) reject: cwd/ownRoot/rendererRoot all agree, but the injected
// execPath (standing in for "PATH-resolved node") differs from the
// bootstrap's `executable`.
// ---------------------------------------------------------------------------
// Scenario: Runner self-check rejects node identity drift
test(
  "runner self-check rejects node identity drift from the bootstrap's node (design.md D5 K3 case e)",
  async () => {
    await withTempDir(
      async (dir) => {
        const { context, contextPath } = render(dir);
        context.projection_runner_command = relativeCarrier(contextPath);
        writeFileSync(contextPath, JSON.stringify(context), "utf8");
        const { env, cleanup } = isolatedEmptyPathEnv(context);
        try {
          const before = snapshotWriteSurfaces(context);
          const result = await runProjectionImpl(contextPath, {
            cwd: REPO_ROOT,
            execPath: path.join(os.tmpdir(), "not-the-bootstraps-node"),
            env,
          });
          // design.md D5 "失敗輸出": see the T4 fix note above — reason, not classification.
          assert.equal(result.classification, "projection_observability_contract_missing", result.error);
          assert.equal(result.reason, "projection_runner_node_mismatch", result.error);
          const after = snapshotWriteSurfaces(context);
          assert.deepEqual(after, before, "self-check rejection must not write activity/heartbeat/lock/control-evidence");
        } finally {
          cleanup();
        }
      },
      { prefix: "second-review-runner-carrier-reject-node-" },
    );
  },
);

// ---------------------------------------------------------------------------
// F-pr-r1-06: a malformed/missing `projection_bootstrap_command.executable`
// (bootstrap parses as valid JSON but is shaped wrong) is a DIFFERENT failure
// than a genuine two-real-paths node mismatch (K3 case e above). The
// self-check must defer (return null / not misreport
// projection_runner_node_mismatch with "(undefined)" in the error text) and
// let the existing exact-carrier validation downstream classify it instead.
// F-pr-r7-01: the scenario's GIVEN is "executable absent or not a non-empty
// string", and the self-check has one branch per part of that condition
// (`typeof !== "string"` and `=== ""`). Each row below exercises one of them
// (absent, empty string, non-string) with the same assertions, so removing
// either branch turns a row into a node-mismatch rejection and fails it. The
// null row is the degenerate "no executable at all" carrier and pins the
// `bootstrap !== null` guard that reads it.
// ---------------------------------------------------------------------------
// Scenario: Runner self-check defers on a malformed bootstrap carrier
test(
  "runner self-check defers (does not misreport node mismatch) when projection_bootstrap_command has no usable executable (absent, empty, non-string, or null carrier)",
  async () => {
    const rows = [
      { label: "executable absent", malform: () => ({}) },
      { label: "executable empty string", malform: (canonical) => ({ ...canonical, executable: "" }) },
      { label: "executable not a string", malform: (canonical) => ({ ...canonical, executable: 5 }) },
      { label: "bootstrap carrier null", malform: () => null },
    ];
    for (const { label, malform } of rows) {
      await withTempDir(
        async (dir) => {
          const { context, contextPath } = render(dir);
          context.projection_runner_command = relativeCarrier(contextPath);
          context.projection_bootstrap_command = malform(context.projection_bootstrap_command);
          writeFileSync(contextPath, JSON.stringify(context), "utf8");
          const { env, cleanup } = isolatedEmptyPathEnv(context);
          try {
            const before = snapshotWriteSurfaces(context);
            const result = await runProjectionImpl(contextPath, { cwd: REPO_ROOT, execPath: process.execPath, env });
            // F-pr-r2-01: positive assertion on the intended failure class (the
            // downstream validateRunnerContext rejection), not just an OR-union
            // negative check that any other outcome would also satisfy.
            assert.equal(result.classification, "projection_context_invalid", `${label}: ${result.error}`);
            assert.match(
              result.error,
              /projection_bootstrap_command must be the exact canonical executable\/argv carrier/,
              label,
            );
            assert.notEqual(result.reason, "projection_runner_node_mismatch", `${label}: ${result.error}`);
            const after = snapshotWriteSurfaces(context);
            assert.deepEqual(after, before, `${label}: deferred malformed-bootstrap rejection must not write activity/heartbeat/lock/control-evidence`);
          } finally {
            cleanup();
          }
        },
        { prefix: "second-review-runner-carrier-defer-malformed-bootstrap-" },
      );
    }
  },
);

// ---------------------------------------------------------------------------
// D5 "自檢通過後...順序不變": a relative carrier that DOES pass self-check must
// reach the same early activity-event ORDER (lock acquired, then handoff
// validated) as today's absolute-carrier run — proving the self-check is
// purely an added front gate, not a reordering of anything downstream.
// Both runs use the same empty-PATH env, so both legitimately reach and stop
// at the same later point (no reviewer CLI resolvable); only the prefix
// through `projection_handoff_validated` is compared.
// ---------------------------------------------------------------------------
test(
  "runner self-check acceptance preserves the existing pre-probe event order (design.md D5; K3 case a/b)",
  async () => {
    await withTempDir(async (dirA) => {
      await withTempDir(
        async (dirB) => {
          const baseline = render(dirA);
          const relative = render(dirB);
          relative.context.projection_runner_command = relativeCarrier(relative.contextPath);
          writeFileSync(relative.contextPath, JSON.stringify(relative.context), "utf8");

          const { env: baselineEnv, cleanup: cleanupBaseline } = isolatedEmptyPathEnv(baseline.context);
          const { env: relativeEnv, cleanup: cleanupRelative } = isolatedEmptyPathEnv(relative.context);
          try {
            await runProjectionImpl(baseline.contextPath, { cwd: REPO_ROOT, execPath: process.execPath, env: baselineEnv });
            await runProjectionImpl(relative.contextPath, { cwd: REPO_ROOT, execPath: process.execPath, env: relativeEnv });
            const prefixThroughHandoffValidated = (events) => {
              const index = events.indexOf("projection_handoff_validated");
              return index === -1 ? events : events.slice(0, index + 1);
            };
            const baselineEvents = prefixThroughHandoffValidated(activityEvents(baseline.context.activity_log_path));
            const relativeEvents = prefixThroughHandoffValidated(activityEvents(relative.context.activity_log_path));
            assert.deepEqual(
              relativeEvents,
              baselineEvents,
              `baseline=${JSON.stringify(baselineEvents)} relative=${JSON.stringify(relativeEvents)}`,
            );
          } finally {
            cleanupBaseline();
            cleanupRelative();
          }
        },
        { prefix: "second-review-runner-carrier-order-relative-" },
      );
    }, { prefix: "second-review-runner-carrier-order-baseline-" });
  },
);

// ---------------------------------------------------------------------------
// Existing guard (tasks.md T3, D5 "入口 guard" — unchanged): relative,
// no-args launch from repo root must still exit 2 with Usage:. Already true
// today (unrelated to carrier type — the check runs before any context path
// is even read).
// ---------------------------------------------------------------------------
test(
  "runner exits 2 with Usage: when launched relative from repo root with no arguments (design.md D5 入口 guard)",
  () => {
    const result = spawnSync(process.execPath, [relativeRunnerScriptLiteral], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Usage:/);
  },
);

// ---------------------------------------------------------------------------
// Process-level (1) — design-review round 1 F-r1-02, K3 case (c): launching
// the relative carrier from a subdirectory with no .devpro/scripts must make
// NODE ITSELF fail (module-not-found-shaped) before the runner's own JS ever
// loads. This is Node's own module resolution, unrelated to any code this
// change adds or has yet to add, so it is already true today.
// ---------------------------------------------------------------------------
// Scenario: Subdirectory cwd cannot start the relative runner
test(
  "process-level: relative carrier from a subdirectory with no .devpro/scripts fails at node module resolution with zero writes (design.md D5 K3 case c; D9 scenario 7 process-level half)",
  () => {
    const badCwd = mkdtempSync(path.join(os.tmpdir(), "second-review-runner-carrier-no-devpro-"));
    try {
      const result = spawnSync(process.execPath, [relativeRunnerScriptLiteral, "irrelevant-context-path"], {
        cwd: badCwd,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Cannot find module/);
      assert.deepEqual(readdirSync(badCwd), [], "node's own module-resolution failure must leave zero artifacts");
    } finally {
      rmSync(badCwd, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Process-level (2) — D9 scenario 8: the EXISTING absolute carrier launched
// from a cwd entirely outside the repo/worktree must still work exactly as it
// does today (regression guard). Already true today — the absolute carrier
// has always been cwd-independent; this test just NAMES the guarantee as a
// scenario for the first time.
// ---------------------------------------------------------------------------
// Scenario: Absolute runner carrier keeps cwd independence
test(
  "process-level: the existing absolute runner carrier still works from a cwd entirely outside the repo/worktree (design.md D9 scenario 8)",
  async () => {
    await withTempDir(
      async (dir) => {
        const { context } = render(dir);
        const outsideCwd = mkdtempSync(path.join(os.tmpdir(), "second-review-runner-carrier-scenario8-"));
        const { env, cleanup } = isolatedEmptyPathEnv(context);
        try {
          const command = context.projection_runner_command;
          const result = spawnSync(command.executable, command.argv, { cwd: outsideCwd, encoding: "utf8", env });
          assert.equal(result.error, undefined);
          const events = activityEvents(context.activity_log_path);
          assert.ok(
            events.includes("projection_attempt_lock_acquired"),
            JSON.stringify({ events, stdout: result.stdout, stderr: result.stderr }),
          );
          assert.ok(events.includes("projection_handoff_validated"), JSON.stringify(events));
        } finally {
          cleanup();
          rmSync(outsideCwd, { recursive: true, force: true });
        }
      },
      { prefix: "second-review-runner-carrier-scenario8-dir-" },
    );
  },
);
