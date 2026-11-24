import { modelProbeEvidence } from "./lib/model-probe-fixture.mjs";
import portableCommandShims from "./lib/portable-command-shims.cjs";
import "./lib/fixture-fsync-shim.cjs";
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import * as runnerModule from "../run-second-reviewer-projection.mjs";
import { postPrMarkerFilenames } from "../hooks/lib/post-pr-completion-state.mjs";
import { writeUsageManifest, rollupManifestUsage } from "../lib/session-usage-manifest.mjs";
import {
  SECOND_REVIEWER_MODEL_DEFAULTS,
  canonicalReviewScopeReadRecipe,
  requestedKindForSelection,
} from "../second-reviewer-cli-recipe-contract.mjs";
import { fsyncDirectory as fsyncDirectoryReal } from "../lib/durable-fs.mjs";
import { stripJsCommentSpans } from "../lib/js-comment-spans.mjs";
import { isIdentifiableCmuxPathEntry } from "../lib/second-review-env-sanitizer.mjs";
import {
  __testAttemptOwnership,
  __testCodexRolloutScan,
  __testReviewerClassification,
  __testReviewerOutput,
  __testReviewerToolSurface,
  __testReviewerTransport,
  __testRunnerTiming,
  __testStickyVerifier,
  runProjection as runProjectionImpl,
  runReviewScopeProbe,
} from "../run-second-reviewer-projection.mjs";
import {
  authorizeSecondReviewPacketFile,
  parseCanonicalSecondReviewPacketData,
  SECOND_REVIEW_FRAME_MARKER,
  secondReviewPacketStaticPrefix,
  secondReviewRulesVersion,
  resolveCredentialGateSidecarPath,
} from "../validate-second-review-packet.mjs";
import { STICKY_CREDENTIAL_GATE_SIDECAR_BASENAME, stickyWriteResultBasename } from "../write-second-review-sticky-gated.mjs";
import {
  canonicalAdapterRouteProof,
  canonicalEmbeddedReviewMaterialProof,
  appendCheckpointCoverage,
  appendFindingsWindow,
  framePagedReviewMaterial,
  PAGED_FULL_PAGES_CARRIER_BASENAME,
} from "../second-review-material-contract.mjs";
import {
  TERMINAL_RECEIPT_CLASSIFICATIONS,
  TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS,
  TERMINAL_RECEIPT_RESPONSIBILITY,
  TERMINAL_RECEIPT_SCHEMA,
  canonicalInvocationClaimSha256,
  claimDispatchInvocation,
  readDispatchEvidenceStrict,
  reserveDispatchRecord,
  isUsableIdentityFieldValue,
  secondReviewDispatchRecord,
  terminalReceiptOutcomeGroup,
  writeExternalClosureSlot,
  writeTerminalReceipt,
  writeReviewerModelRecord,
} from "../hooks/lib/second-review-control-evidence.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { resolveNativeExecutableOnPath } from "./lib/resolve-native-executable.mjs";
import { expectedNodeModeBits } from "./lib/expected-node-mode-bits.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import {
  assertAttemptUnderOwnedRoot,
  assertNotLiveWrite,
  clearOwnedCanonicalCache,
  prepareOwnedCanonicalRenderer,
} from "./lib/owned-canonical-carrier.mjs";
import { envWithoutHostMarkers } from "./lib/host-session-env.mjs";

// Keep renderer integration tests off live Claude; override per-test via env.
process.env.DEVPRO_ALLOW_CLAUDE_EFFORT_STUB ??= "1";
// Isolate the pr-sticky review-round sidecar (R2 round budget): renders in this
// file reuse one PR number, so without a private state dir the fourth
// successful render trips the cap-3 budget against the real state dir.
process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR ??= makeTempDir("review-round-state-");
process.env.DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB ??= "xhigh";

const PROJECTION_TEST_GROUP = process.env.DEVPRO_SECOND_REVIEWER_PROJECTION_TEST_GROUP ?? "core";
const PROJECTION_TEST_GROUP_RANGES = Object.freeze({
  core: [1, 48],
  runner_a: [49, 91],
  runner_b: [92, 119],
  ownership: [120, 137],
  reconcile: [138, 166],
  reviewer_home: [167, 322],
});
const PROJECTION_TEST_GROUP_RANGE_END = Math.max(
  ...Object.values(PROJECTION_TEST_GROUP_RANGES).map(([, end]) => end),
);
let projectionTestIndex = 0;

if (!Object.hasOwn(PROJECTION_TEST_GROUP_RANGES, PROJECTION_TEST_GROUP)) {
  throw new Error(
    `unknown run-second-reviewer-projection test group: ${PROJECTION_TEST_GROUP}`,
  );
}

function projectionTestGroupForIndex(index) {
  for (const [group, [start, end]] of Object.entries(PROJECTION_TEST_GROUP_RANGES)) {
    if (index >= start && index <= end) return group;
  }
  throw new Error(`run-second-reviewer-projection test index ${index} has no group`);
}

function test(name, optionsOrFn, maybeFn) {
  projectionTestIndex += 1;
  if (projectionTestGroupForIndex(projectionTestIndex) !== PROJECTION_TEST_GROUP) return;
  if (typeof optionsOrFn === "function") {
    return nodeTest(name, optionsOrFn);
  }
  return nodeTest(name, optionsOrFn, maybeFn);
}

const SECOND_REVIEW_RULES_VERSION = secondReviewRulesVersion(REPO_ROOT);
const renderer = repoPath(".devpro/scripts/render-second-review-packet.mjs");
const runnerScript = repoPath(".devpro/scripts/run-second-reviewer-projection.mjs");
const sharedAttemptLockScript = path.join(
  REPO_ROOT,
  ".devpro/scripts/lib/second-review-attempt-lock.mjs",
);

// Every projection case gets its own evidence root through the call boundary.
// This keeps the parent test process free of a mutable evidence-root contract;
// callers may still override other environment keys with withProcessEnv().
async function runProjection(contextPath, options = {}) {
  const context = JSON.parse(readFileSync(contextPath, "utf8"));
  const env = options.env ?? {
    ...process.env,
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
  };
  // fix-flow-gate-gaps R3: the pre-spawn authoritative live-head probe
  // (pr-sticky + 40-hex head + no own scope recipe) is a same-head no-op by
  // default so the pre-existing runner cases keep their previous reachability
  // without each one stubbing a new seam. The dedicated R3 cases below pass
  // their own liveHeadProbeOptions to drive both disposition states (mismatch /
  // probe-unavailable) and the audit-only no-call polarity.
  const defaultLiveHeadProbeOptions = {
    spawnSync() {
      return {
        status: 0,
        stdout: JSON.stringify({ headRefOid: context.head_ref_oid }),
        stderr: "",
      };
    },
  };
  return runProjectionImpl(contextPath, {
    liveHeadProbeOptions: defaultLiveHeadProbeOptions,
    ...options,
    env,
  });
}

function mainCheckoutNotesTmp(cwd = REPO_ROOT) {
  const result = spawnSync("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return path.join(path.dirname(result.stdout.trim()), "notes", "tmp");
}

// Live canonical is geometry-only; write helpers use mutation-relocated owned roots.
const liveCanonicalCarrierRoot = path.join(path.dirname(mainCheckoutNotesTmp()), "cross-review");

const auditHandoff = {
  mode: "audit-only",
  attempt: "initial",
  primary_family: "openai-codex",
  reviewer_family: "claude",
  target: "local diff",
  head_ref_oid: "none",
  repository_slug: "devpro/example",
  approval_context: "none",
  scope_summary: "bounded local runner smoke",
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
const codexAuditHandoff = {
  ...auditHandoff,
  primary_family: "claude",
  reviewer_family: "codex",
};
const approvalContext = "none";
const emptyStickyAuthoritySnapshot = {
  repository_slug: "devpro/example",
  pr_number: 1658,
  completeness: {
    status: "complete",
    pagination_exhausted: true,
    pages_fetched: 1,
  },
  query_error: null,
  comments: [],
};
const emptyStickyAuthorityApiResponse = JSON.stringify({
  comments: [],
  completeness: emptyStickyAuthoritySnapshot.completeness,
  query_error: null,
});
const expectedPrStickyPreAndPostSnapshotCommands = [
  "api --paginate --slurp repos/devpro/example/issues/1658/comments?per_page=100",
  // fix-flow-gate-gaps R3: the authoritative pre-spawn live-head probe reads
  // this same shape before the reviewer spawns; the verifier's own post-spawn
  // head read follows it (both stay in the logged sequence). The probe pins the
  // repository explicitly with `--repo <slug>` (matches the canonical spec text;
  // GH_REPO stays set as the same env-var form the verifier uses).
  "pr view 1658 --repo devpro/example --json headRefOid",
  "pr view 1658 --json headRefOid",
  "api --paginate --slurp repos/devpro/example/issues/1658/comments?per_page=100",
];
const expectedPrStickyVerifiedReadCommands = [
  ...expectedPrStickyPreAndPostSnapshotCommands,
  "api repos/devpro/example/issues/comments/4242 --include",
];
const verifiedEmptyStickyDispositionOptions = {
  spawnSync(executable, argv, options) {
    assert.equal(executable, "gh");
    assert.deepEqual(argv, [
      "api",
      "--paginate",
      "--slurp",
      "repos/devpro/example/issues/1658/comments?per_page=100",
    ]);
    assert.equal(options.env.GH_REPO, "devpro/example");
    return {
      status: 0,
      stdout: emptyStickyAuthorityApiResponse,
      stderr: "",
    };
  },
};
const prStickyHeadSha = "a".repeat(40);
const prStickyScope = {
  kind: "full-pr",
  pull_request_number: 1658,
  head_sha: prStickyHeadSha,
};
const prStickyMaterial = [
  "diff --git a/.devpro/scripts/run-second-reviewer-projection.mjs b/.devpro/scripts/run-second-reviewer-projection.mjs",
  "--- a/.devpro/scripts/run-second-reviewer-projection.mjs",
  "+++ b/.devpro/scripts/run-second-reviewer-projection.mjs",
  "@@ -1 +1 @@",
  "-legacy runner",
  "+typed runner scope",
  "diff --git a/.devpro/scripts/render-second-review-packet.mjs b/.devpro/scripts/render-second-review-packet.mjs",
  "--- a/.devpro/scripts/render-second-review-packet.mjs",
  "+++ b/.devpro/scripts/render-second-review-packet.mjs",
  "@@ -1 +1 @@",
  "-legacy renderer",
  "+typed renderer scope",
  "",
].join("\n");
const prStickyHandoff = {
  ...auditHandoff,
  review_material_complete: undefined,
  mode: "pr-sticky",
  target: "PR #1658",
  head_ref_oid: prStickyHeadSha,
  approval_context: approvalContext,
  approval_resolution: { status: "not-required" },
  pr_head_ref_name: "bugfix/fix-second-reviewer-control-plane-recursion",
  sticky_authority_snapshot: emptyStickyAuthoritySnapshot,
  review_scope: prStickyScope,
  review_material_carrier: "embedded-diff",
  review_material_capability: "scope-bound-embedded-complete-diff-v1",
  review_material_proof: canonicalEmbeddedReviewMaterialProof(
    prStickyScope,
    prStickyMaterial,
  ),
  review_material: prStickyMaterial,
  write_path: "reviewer current neutral cwd body file plus disposition-bound gh api only",
  allowed_tools: `Write,Bash(command -v gh),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(node ${repoPath(".devpro/scripts/read-second-review-sticky-comment.mjs")}:*),Bash(node ${repoPath(".devpro/scripts/write-second-review-sticky-gated.mjs")}:*)`,
};
const codexPrStickyHandoff = {
  ...prStickyHandoff,
  primary_family: "claude",
  reviewer_family: "codex",
};

function reviewMaterialWithExactUtf8Bytes(material, targetBytes) {
  const currentBytes = Buffer.byteLength(material, "utf8");
  assert.ok(currentBytes <= targetBytes);
  return `${material}${"x".repeat(targetBytes - currentBytes)}`;
}

function largePrStickyHandoff() {
  const material = reviewMaterialWithExactUtf8Bytes(prStickyMaterial, 262_145);
  return {
    ...prStickyHandoff,
    review_material_proof: canonicalEmbeddedReviewMaterialProof(prStickyScope, material),
    review_material: material,
  };
}

function immutableAuthorityFixture(handoff, dir) {
  const fixtureBin = path.join(dir, "immutable-authority-bin");
  mkdirSync(fixtureBin, { recursive: true });
  const comparisonBase = handoff.review_scope?.kind === "commit-range"
    ? handoff.review_scope.base_sha
    : "c".repeat(40);
  const nameStatus = handoff.changed_files_or_touch_list
    .map((changedPath) => `M\0${changedPath}\0`)
    .join("");
  const rawFacts = handoff.changed_files_or_touch_list
    .map((changedPath) => `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0${changedPath}\0`)
    .join("");
  const numstat = handoff.changed_files_or_touch_list
    .map((changedPath) => `1\t1\t${changedPath}\0`)
    .join("");
  const githubFilePages = [handoff.changed_files_or_touch_list.map((filename) => ({
    filename,
    status: "modified",
    patch: "@@ -1 +1 @@\n-old\n+new",
  }))];
  const authoritativeRawDiff = handoff.review_material || prStickyMaterial;
  const realGit = resolveNativeExecutableOnPath("git");
  writeFileSync(path.join(fixtureBin, "git"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const authoritativeRawDiffBase64 = process.env.DEVPRO_TEST_SECOND_REVIEW_AUTHORITATIVE_RAW_DIFF_BASE64
  ?? ${JSON.stringify(Buffer.from(authoritativeRawDiff, "utf8").toString("base64"))};
if (args.join(" ") === "rev-parse --show-toplevel") process.stdout.write(${JSON.stringify(`${REPO_ROOT}\n`)});
else if (args[0] === "merge-base") process.stdout.write(${JSON.stringify(`${comparisonBase}\n`)});
else if (args[0] === "diff" && args.includes("--name-status")) process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(nameStatus, "utf8").toString("base64"))}, "base64"));
else if (args[0] === "diff" && args.includes("--raw")) process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(rawFacts, "utf8").toString("base64"))}, "base64"));
else if (args[0] === "diff" && args.includes("--numstat")) process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(numstat, "utf8").toString("base64"))}, "base64"));
else if (args[0] === "diff") process.stdout.write(Buffer.from(authoritativeRawDiffBase64, "base64"));
else { const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" }); process.exit(result.status ?? 1); }
`, { mode: 0o700 });
writeFileSync(path.join(fixtureBin, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view" && args.includes("baseRefOid,headRefOid")) {
  process.stdout.write(JSON.stringify({ baseRefOid: ${JSON.stringify(comparisonBase)}, headRefOid: ${JSON.stringify(handoff.review_scope?.head_sha)} }));
} else if (args[0] === "pr" && args[1] === "view" && args.includes("headRefOid")) {
  process.stdout.write(${JSON.stringify(handoff.review_scope?.head_sha)});
} else if (args[0] === "api" && args.some((arg) => arg.includes("/pulls/") && arg.includes("/files?"))) {
  process.stdout.write(${JSON.stringify(JSON.stringify(githubFilePages))});
} else { process.stderr.write("unexpected gh fixture args: " + JSON.stringify(args) + "\\n"); process.exit(97); }
`, { mode: 0o700 });
  return `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}`;
}
const commitRangeBaseSha = "b".repeat(40);
const trustedReviewerExecutableDiscoveryOptions = Object.freeze({
  pathValue: path.join(path.sep, "devpro-test-bin"),
  accessSyncImpl() {},
  statSyncImpl() {
    return { isFile: () => true };
  },
  realpathSyncImpl(candidate) {
    return candidate;
  },
});
const commitRangeScope = {
  kind: "commit-range",
  base_sha: commitRangeBaseSha,
  head_sha: prStickyHeadSha,
};
const liveCommitRangeHandoff = {
  ...prStickyHandoff,
  review_scope: commitRangeScope,
  review_material_carrier: "adapter-live-pr-reads",
  review_material_capability: "commit-range-exact-compare-v1",
  review_material_proof: canonicalAdapterRouteProof(commitRangeScope),
  review_material: "",
};
const liveFullPrHandoff = {
  ...prStickyHandoff,
  review_material_carrier: "adapter-live-pr-reads",
  review_material_capability: "full-pr-bounded-live-reads-v1",
  review_material_proof: canonicalAdapterRouteProof(prStickyScope),
  review_material: "",
};

const completeHelp = `Usage: reviewer [options]
  -p, --print
  --safe-mode
  --system-prompt <prompt>
  --model <model>
  --effort <level>
  --verbose
  --output-format <format>
  --json-schema <schema>
  --include-partial-messages
  --include-hook-events
  --tools <tools...>
  --allowedTools, --allowed-tools <tools...>
`;

test("run-second-reviewer-projection gives Claude and Codex the same 30-minute hard cap", () => {
  assert.equal(__testRunnerTiming.defaultTotalTimeoutMsForTool("claude"), 30 * 60 * 1000);
  assert.equal(__testRunnerTiming.defaultTotalTimeoutMsForTool("codex"), 30 * 60 * 1000);
});

test("reviewer transport termination does not fabricate a kill after natural close", () => {
  let killCalls = 0;
  const termination = __testReviewerTransport.terminateOpen({
    exitCode: 0,
    signalCode: null,
    kill() {
      killCalls += 1;
      return true;
    },
  });

  assert.deepEqual(termination, {
    status: "reviewer_transport_already_closed",
    attempted: false,
    accepted: false,
    signal: null,
    child_open_before: false,
  });
  assert.equal(killCalls, 0);
});

test("reviewer process-group support remains explicit and cross-platform testable", () => {
  assert.equal(__testReviewerTransport.supportsProcessGroups("linux"), true);
  assert.equal(__testReviewerTransport.supportsProcessGroups("darwin"), true);
  assert.equal(__testReviewerTransport.supportsProcessGroups("win32"), false);

  let childKillSignal = null;
  const termination = __testReviewerTransport.forceKillOpen({
    exitCode: null,
    signalCode: null,
    pid: 4242,
    kill(signal) {
      childKillSignal = signal;
      return true;
    },
  }, { platform: "win32" });

  assert.equal(childKillSignal, "SIGKILL");
  assert.equal(termination.process_group, false);
});

test("reviewer process-group cleanup uses saved ownership after the leader exits", () => {
  const signals = [];
  const termination = __testReviewerTransport.terminateOpen({
    exitCode: 0,
    signalCode: null,
    kill() {
      assert.fail("saved process-group cleanup must not fall back to the exited leader");
    },
  }, {
    platform: "darwin",
    processGroupId: 4242,
    killProcess(pid, signal) {
      signals.push([pid, signal]);
      return true;
    },
  });

  assert.deepEqual(signals, [[-4242, "SIGTERM"]]);
  assert.deepEqual(termination, {
    status: "reviewer_transport_sigterm_requested",
    attempted: true,
    accepted: true,
    signal: "SIGTERM",
    child_open_before: false,
  });
});

test("reviewer process-group cleanup treats ESRCH as gone and propagates other errors", () => {
  const exitedChild = {
    exitCode: 0,
    signalCode: null,
    kill() {
      assert.fail("saved process-group cleanup must not use child fallback");
    },
  };
  const gone = __testReviewerTransport.forceKillOpen(exitedChild, {
    platform: "linux",
    processGroupId: 4242,
    killProcess() {
      throw Object.assign(new Error("group gone"), { code: "ESRCH" });
    },
  });

  assert.deepEqual(gone, {
    status: "reviewer_transport_process_group_gone",
    attempted: true,
    accepted: false,
    signal: "SIGKILL",
    child_open_before: false,
    process_group: true,
  });
  assert.throws(() => __testReviewerTransport.forceKillOpen(exitedChild, {
    platform: "linux",
    processGroupId: 4242,
    killProcess() {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    },
  }), { code: "EPERM" });
});

test("closed-terminal cleanup confirmation distinguishes a reaped group from live or unclosed transport", () => {
  assert.equal(__testReviewerTransport.cleanupConfirmed({
    processSpawned: false,
    processCloseObserved: false,
    processGroupId: null,
    platform: "linux",
  }), true, "no spawned process means no transport exists to clean");
  assert.equal(__testReviewerTransport.cleanupConfirmed({
    processSpawned: true,
    processCloseObserved: false,
    processGroupId: 4242,
    platform: "linux",
  }), false, "a process exit or forced settlement without close is not cleanup evidence");
  assert.equal(__testReviewerTransport.cleanupConfirmed({
    processSpawned: true,
    processCloseObserved: true,
    processGroupId: 4242,
    platform: "linux",
    killProcess() {
      throw Object.assign(new Error("group gone"), { code: "ESRCH" });
    },
  }), true);
  assert.equal(__testReviewerTransport.cleanupConfirmed({
    processSpawned: true,
    processCloseObserved: true,
    processGroupId: 4242,
    platform: "linux",
    killProcess(pid, signal) {
      assert.deepEqual([pid, signal], [-4242, 0]);
      return true;
    },
  }), false, "a live descendant keeps post-close cleanup unconfirmed");
});

// REQ-R8 (design.md D10-D13): the success path historically *observed* transport
// state exactly once, at close, and never attempted cleanup. One stray group member
// alive at that instant produced `transport_cleanup_confirmed: false`, which
// permanently withholds the closed-terminal receipt and deadlocks that PR's review
// lineage. These tests pin the bounded convergence that replaces the bare observation.
const CONVERGENCE_GROUP_ID = 4242;

function scriptedGroupSignals(steps) {
  // One entry is consumed per killProcess() call, in order:
  //   "alive"  -> returns true (group still has members)
  //   "gone"   -> throws ESRCH (group reaped)
  //   "denied" -> throws EPERM (group exists but is unsignalable)
  const calls = [];
  let index = 0;
  return {
    calls,
    killProcess(pid, signal) {
      calls.push([pid, signal]);
      const step = steps[index];
      index += 1;
      if (step === undefined) {
        assert.fail(`unscripted killProcess call #${index} with signal ${String(signal)}`);
      }
      if (step === "gone") throw Object.assign(new Error("group gone"), { code: "ESRCH" });
      if (step === "denied") throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      return true;
    },
  };
}

async function convergeOnClose(steps, overrides = {}) {
  const scripted = scriptedGroupSignals(steps);
  const sleeps = [];
  const closedLeader = {
    exitCode: 0,
    signalCode: null,
    kill() {
      assert.fail("convergence must use the saved process group, not the exited leader");
    },
  };
  const result = await __testReviewerTransport.converge(closedLeader, {
    processSpawned: true,
    closeObserved: true,
    processGroupId: CONVERGENCE_GROUP_ID,
    platform: "linux",
    killProcess: scripted.killProcess,
    graceMs: 50,
    settleMs: 100,
    sleep: async (ms) => { sleeps.push(ms); },
    ...overrides,
  });
  return { result, calls: scripted.calls, sleeps };
}

test("close-time convergence leaves an already-reaped group untouched", async () => {
  const { result, calls, sleeps } = await convergeOnClose(["gone"]);

  assert.equal(result.confirmed, true);
  assert.deepEqual(result.telemetry, {
    eligible: true,
    outcome: "already_clean",
    probes: 1,
    signals: [],
    escalated: false,
    grace_ms: 50,
    settle_ms: 100,
  });
  assert.deepEqual(calls, [[-CONVERGENCE_GROUP_ID, 0]], "a clean group costs exactly one signal-0 probe");
  assert.deepEqual(sleeps, [], "a clean group must not arm the grace or settle timer");
});

test("close-time convergence reaps a stray group with SIGTERM before escalating", async () => {
  const { result, calls, sleeps } = await convergeOnClose(["alive", "alive", "gone"]);

  assert.equal(result.confirmed, true);
  assert.equal(result.telemetry.outcome, "sigterm_converged");
  assert.equal(result.telemetry.probes, 2);
  assert.deepEqual(result.telemetry.signals, ["SIGTERM"]);
  assert.equal(result.telemetry.escalated, false);
  assert.deepEqual(calls, [
    [-CONVERGENCE_GROUP_ID, 0],
    [-CONVERGENCE_GROUP_ID, "SIGTERM"],
    [-CONVERGENCE_GROUP_ID, 0],
  ]);
  assert.deepEqual(sleeps, [50], "only the grace bound is spent when SIGTERM converges");
});

test("close-time convergence escalates to a group SIGKILL and confirms the reap", async () => {
  const { result, calls, sleeps } = await convergeOnClose([
    "alive",
    "alive",
    "alive",
    "alive",
    "gone",
  ]);

  assert.equal(result.confirmed, true);
  assert.equal(result.telemetry.outcome, "sigkill_converged");
  assert.equal(result.telemetry.probes, 3);
  assert.deepEqual(result.telemetry.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.telemetry.escalated, true);
  assert.deepEqual(calls, [
    [-CONVERGENCE_GROUP_ID, 0],
    [-CONVERGENCE_GROUP_ID, "SIGTERM"],
    [-CONVERGENCE_GROUP_ID, 0],
    [-CONVERGENCE_GROUP_ID, "SIGKILL"],
    [-CONVERGENCE_GROUP_ID, 0],
  ]);
  assert.deepEqual(sleeps, [50, 100]);
});

test("close-time convergence keeps a survivor and a non-ESRCH signal error fail closed", async () => {
  const survived = await convergeOnClose(["alive", "alive", "alive", "alive", "alive"]);
  assert.equal(survived.result.confirmed, false, "an unreaped group must stay cleanup-unconfirmed");
  assert.equal(survived.result.telemetry.outcome, "cleanup_unconfirmed");
  assert.equal(survived.result.telemetry.probes, 3);

  const denied = await convergeOnClose(["denied"]);
  assert.equal(denied.result.confirmed, false);
  assert.equal(denied.result.telemetry.outcome, "signal_error");
  assert.equal(denied.result.telemetry.probes, 1);
  assert.deepEqual(denied.result.telemetry.signals, [], "an unsignalable group must not be escalated");
  assert.deepEqual(denied.sleeps, [], "a signal error must end convergence before any timer is armed");

  const deniedAfterTerm = await convergeOnClose(["alive", "denied"]);
  assert.equal(deniedAfterTerm.result.confirmed, false);
  assert.equal(deniedAfterTerm.result.telemetry.outcome, "signal_error");
  assert.deepEqual(deniedAfterTerm.sleeps, []);
});

test("close-time convergence is skipped whenever the process-group entry gate is unmet", async () => {
  const noProcessGroups = await convergeOnClose([], { platform: "win32" });
  assert.equal(noProcessGroups.result.confirmed, true, "win32 keeps its existing direct-child semantics");
  assert.equal(noProcessGroups.result.telemetry.eligible, false);
  assert.equal(noProcessGroups.result.telemetry.outcome, null);
  assert.equal(noProcessGroups.result.telemetry.probes, 0);
  assert.deepEqual(noProcessGroups.calls, [], "an ineligible host must never signal or probe");

  const noProcessGroupId = await convergeOnClose([], { processGroupId: null });
  assert.equal(noProcessGroupId.result.confirmed, true);
  assert.equal(noProcessGroupId.result.telemetry.eligible, false);
  assert.deepEqual(noProcessGroupId.calls, []);

  const neverSpawned = await convergeOnClose([], { processSpawned: false, closeObserved: false });
  assert.equal(neverSpawned.result.confirmed, true, "no spawned process means no transport to clean");
  assert.equal(neverSpawned.result.telemetry.eligible, false);
  assert.deepEqual(neverSpawned.calls, []);
});

test("close-time convergence matches the existing predicate at every finalize call site", async () => {
  // design.md D12: `finalize()` has four callers. Only the three that observe a real
  // process `close` may converge; the force-settle path must keep today's semantics.
  const forceSettle = await convergeOnClose([], { closeObserved: false });
  assert.equal(forceSettle.result.telemetry.eligible, false, "force settle never observed close");
  assert.equal(forceSettle.result.confirmed, false, "a forced settlement is not cleanup evidence");
  assert.deepEqual(forceSettle.calls, [], "the force-settle path must not probe the group");

  const converged = await convergeOnClose(["gone"]);
  assert.equal(converged.result.telemetry.eligible, true, "an observed close is eligible to converge");
  assert.equal(converged.result.confirmed, true);
  assert.deepEqual(converged.calls, [[-CONVERGENCE_GROUP_ID, 0]]);

  // The behavioural half above only exercises the predicate. Which call site
  // passes which closeObserved value is not observable through it at all — a
  // caller flipped from `true` to `false` still leaves every assertion green.
  // So assert the call sites themselves: exactly four callers, each pinned to
  // the closeObserved argument design.md D12 assigns it.
  const finalizeCallSites = withoutComments(runnerSourceText)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("finalize(") && line.endsWith(";"));
  assert.deepEqual(
    finalizeCallSites,
    [
      // bounded termination, after a clean transport sweep: converge only if a
      // real close was seen, otherwise this is a synthesised observation.
      "finalize(observation.code, observation.signal, closeObservation !== null);",
      // termination grace timer with a close already in hand.
      "finalize(closeObservation.code, closeObservation.signal, true);",
      // forced settlement: no close was ever observed, so it must not converge.
      'finalize(child.exitCode, child.signalCode ?? "SIGKILL", false);',
      // the child's own close event.
      "finalize(code, signal, true);",
    ],
    "every finalize() caller must keep its design.md D12 closeObserved argument; "
    + "adding, removing or flipping one changes which paths may claim cleanup evidence"
  );
});

test("reviewer line accumulator accepts exactly 64 KiB and preserves split UTF-8", () => {
  const lines = [];
  let overflows = 0;
  const accumulator = __testReviewerOutput.createBoundedLineAccumulator({
    onLine: (line) => lines.push(line),
    onOverflow: () => { overflows += 1; },
  });
  const payload = Buffer.concat([
    Buffer.alloc(__testReviewerOutput.maxLineBytes - Buffer.byteLength("界"), 0x78),
    Buffer.from("界"),
  ]);

  accumulator.write(payload.subarray(0, payload.length - 1));
  accumulator.write(payload.subarray(payload.length - 1));
  accumulator.write(Buffer.from("\n"));

  assert.equal(overflows, 0);
  assert.equal(lines.length, 1);
  assert.equal(Buffer.byteLength(lines[0], "utf8"), 64 * 1024);
  assert.equal(lines[0].endsWith("界"), true);
});

test("reviewer line accumulator fails once at byte 65537 without retaining or resuming", () => {
  const lines = [];
  let overflows = 0;
  const accumulator = __testReviewerOutput.createBoundedLineAccumulator({
    onLine: (line) => lines.push(line),
    onOverflow: () => { overflows += 1; },
  });

  accumulator.write(Buffer.alloc(64 * 1024, 0x78));
  accumulator.write(Buffer.from("y"));
  accumulator.write(Buffer.from("more output must be ignored\n"));
  accumulator.end();

  assert.equal(overflows, 1);
  assert.deepEqual(lines, []);
});

function collectReviewerLineAccumulatorOutcome(chunks) {
  const lines = [];
  let overflows = 0;
  let overflowMaxBytes = null;
  const accumulator = __testReviewerOutput.createBoundedLineAccumulator({
    onLine: (line) => lines.push(line),
    onOverflow: ({ maxBytes }) => {
      overflows += 1;
      overflowMaxBytes = maxBytes;
    },
  });
  for (const chunk of chunks) accumulator.write(chunk);
  accumulator.end();
  return { lines, overflows, overflowMaxBytes };
}

function collectToolSurfaceOutcome(chunks, { mode = "audit-only" } = {}) {
  const expectedTools = __testReviewerToolSurface.expectedToolsForContext({
    mode,
    reviewer_cli_recipe: {
      required_invocation_args: ["--json-schema", "{}"],
      required_flags: ["--json-schema"],
    },
  }, "claude");
  let check = __testReviewerToolSurface.initialCheck(expectedTools);
  const transitions = [];
  const accumulator = __testReviewerOutput.createBoundedLineAccumulator({
    onLine(line) {
      const outcome = __testReviewerToolSurface.inspectLine({
        check,
        expectedTools,
        line: String(line).trim(),
      });
      check = outcome.check;
      if (outcome.action !== "none") transitions.push(outcome);
    },
    onOverflow() {
      throw new Error("tool-surface fixture unexpectedly overflowed");
    },
  });
  for (const chunk of chunks) accumulator.write(chunk);
  accumulator.end();
  return {
    check,
    transitions,
    safeTelemetry: __testReviewerToolSurface.safeTelemetry(check),
  };
}

test("run-second-reviewer-projection derives StructuredOutput only from schema recipes", () => {
  const schemaRecipe = {
    required_invocation_args: ["--json-schema", "{}"],
    required_flags: ["--json-schema"],
  };

  assert.deepEqual(
    __testReviewerToolSurface.expectedToolsForContext({
      mode: "audit-only",
      reviewer_cli_recipe: schemaRecipe,
    }, "claude"),
    ["StructuredOutput"]
  );
  assert.deepEqual(
    __testReviewerToolSurface.expectedToolsForContext({
      mode: "pr-sticky",
      reviewer_cli_recipe: schemaRecipe,
    }, "claude"),
    ["Bash", "StructuredOutput", "Write"]
  );
  assert.deepEqual(
    __testReviewerToolSurface.expectedToolsForContext({
      mode: "audit-only",
      reviewer_cli_recipe: {},
    }, "claude"),
    []
  );
  assert.deepEqual(
    __testReviewerToolSurface.expectedToolsForContext({
      mode: "pr-sticky",
      reviewer_cli_recipe: {},
    }, "claude"),
    ["Bash", "Write"]
  );
});

const fixtureExactCarrierRegistries = new Map();

function registerPublishedExactCarrier(fixtureDir, packetPath) {
  assert.notEqual(packetPath, "", "successful renderer fixture must publish its packet path");
  assert.equal(path.isAbsolute(packetPath), true, "renderer fixture packet path must be absolute");
  const carrierDir = path.resolve(path.dirname(packetPath));
  const fixtureKey = path.resolve(fixtureDir);
  const registry = fixtureExactCarrierRegistries.get(fixtureKey) ?? new Set();
  registry.add(carrierDir);
  fixtureExactCarrierRegistries.set(fixtureKey, registry);
  return carrierDir;
}

function fixtureKeyIsWithin(fixtureRoot, fixtureKey) {
  const relative = path.relative(fixtureRoot, fixtureKey);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function cleanupFixtureDir(dir) {
  const fixtureRoot = path.resolve(dir);
  for (const [fixtureKey, carrierDirs] of fixtureExactCarrierRegistries) {
    if (!fixtureKeyIsWithin(fixtureRoot, fixtureKey)) continue;
    for (const carrierDir of carrierDirs) {
      rmSync(carrierDir, { recursive: true, force: true });
    }
    fixtureExactCarrierRegistries.delete(fixtureKey);
  }
  clearOwnedCanonicalCache(dir);
  rmSync(dir, { recursive: true, force: true });
}

function parseNdjsonObjects(text) {
  return String(text)
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return [];
      try {
        const value = JSON.parse(trimmed);
        return value && typeof value === "object" ? [value] : [];
      } catch {
        return [];
      }
    });
}

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    cleanupFixtureDir(dir);
  }
}

async function withTempDirAsync(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    cleanupFixtureDir(dir);
  }
}

async function withProcessEnv(overrides, fn) {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function exactCommitRangeProbePayload(overrides = {}) {
  return {
    status: "ahead",
    ahead_by: 2,
    behind_by: 0,
    total_commits: 2,
    base_commit: { sha: commitRangeBaseSha },
    merge_base_commit: { sha: commitRangeBaseSha },
    commits: [
      { sha: "c".repeat(40), commit: { message: "SENSITIVE_RAW_COMMIT_MESSAGE" } },
      { sha: prStickyHeadSha },
    ],
    files: prStickyHandoff.changed_files_or_touch_list.map((filename) => ({ filename })),
    ...overrides,
  };
}

function exactFullPrProbePayload(overrides = {}) {
  const files = prStickyHandoff.changed_files_or_touch_list.map((filePath) => ({ path: filePath }));
  return {
    number: prStickyScope.pull_request_number,
    headRefOid: prStickyScope.head_sha,
    changedFiles: files.length,
    files,
    ...overrides,
  };
}

/** Dual-call mock for gh-pr-bounded-live-v1 (head bind + paginated pulls files).
 * Optional `headAfterOverrides` applies only to the post-files rebind call.
 */
function fullPrScopeProbeSpawnSync(options = {}) {
  const pullNumber = String(prStickyScope.pull_request_number);
  const headArgv = ["pr", "view", pullNumber, "--json", "number,headRefOid,changedFiles"];
  const filesArgv = [
    "api",
    "--paginate",
    "--jq",
    ".[].filename",
    `repos/{owner}/{repo}/pulls/${pullNumber}/files`,
  ];
  let headCalls = 0;
  return (executable, argv, spawnOptions) => {
    assert.equal(executable, "gh");
    if (spawnOptions !== undefined && options.assertEnvSlug) {
      assert.equal(spawnOptions.env.GH_REPO, liveFullPrHandoff.repository_slug);
      assert.equal(spawnOptions.maxBuffer, 2_097_152);
    }
    if (JSON.stringify(argv) === JSON.stringify(headArgv)) {
      headCalls += 1;
      if (typeof options.headResult === "function") return options.headResult({ headCalls });
      const overrides = headCalls === 1
        ? (options.headOverrides ?? {})
        : (options.headAfterOverrides ?? options.headOverrides ?? {});
      const payload = exactFullPrProbePayload(overrides);
      return {
        status: 0,
        stdout: JSON.stringify({
          number: payload.number,
          headRefOid: payload.headRefOid,
          changedFiles: payload.changedFiles,
        }),
        stderr: "",
      };
    }
    if (JSON.stringify(argv) === JSON.stringify(filesArgv)) {
      if (typeof options.filesResult === "function") return options.filesResult();
      const payload = exactFullPrProbePayload(options.filesOverrides ?? {});
      const names = (payload.files ?? []).map((entry) => entry.path ?? entry.filename);
      return {
        status: 0,
        stdout: `${names.join("\n")}\n`,
        stderr: "",
      };
    }
    throw new Error(`unexpected full-pr probe argv: ${argv.join(" ")}`);
  };
}

function writeWindowsExecutableResolverMarker(scriptPath) {
  if (process.platform === "win32") {
    // Production discovery must see a PATHEXT-native path on Windows; the
    // test-only spawn shim redirects this marker to its adjacent script fixture.
    writeFileSync(`${scriptPath}.exe`, "DevPro Windows test resolver marker\n", "utf8");
  }
}

function writePortableFakeReviewerCli(scriptPath, exportName, options = {}) {
  const helperHref = pathToFileURL(repoPath(".devpro/scripts/tests/lib/portable-fake-reviewer-cli.mjs")).href;
  const source = `#!/usr/bin/env node\n`
    + `import(${JSON.stringify(helperHref)})\n`
    + `.then((helpers) => helpers[${JSON.stringify(exportName)}](${JSON.stringify(options)}))\n`
    + `.catch((error) => { console.error(error); process.exitCode = 1; });\n`;
  writeFileSync(scriptPath, source, "utf8");
  chmodSync(scriptPath, 0o755);
  writeWindowsExecutableResolverMarker(scriptPath);
  return scriptPath;
}

function writeFakeClaude(binDir, helpText = completeHelp) {
  const fake = path.join(binDir, "claude");
  return writePortableFakeReviewerCli(fake, "runFakeClaude", { helpText });
}

function writeBlockingNodeFakeClaude(binDir, helpText = completeHelp) {
  const fake = path.join(binDir, "claude");
  const helpTextLiteral = JSON.stringify(helpText);
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const helpText = ${helpTextLiteral};
if (args.some((arg) => ["--help", "-help", "-h", "help"].includes(arg))) {
  process.stdout.write(helpText);
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status" && args[2] === "--json" && args.length === 3) {
  process.stdout.write('{"loggedIn":true}\\n');
  process.exit(0);
}
const tools = JSON.parse(process.env.DEVPRO_FAKE_REVIEWER_INIT_TOOLS || '["Bash","StructuredOutput","Write"]');
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools }) + "\\n");
process.stdin.on("data", () => {});
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  chmodSync(fake, 0o755);
  return fake;
}

function writeFakeCodex(binDir) {
  const fake = path.join(binDir, "codex");
  return writePortableFakeReviewerCli(fake, "runFakeCodex");
}

function writeDisappearingClaude(binDir) {
  const fake = path.join(binDir, "claude");
  return writePortableFakeReviewerCli(fake, "runDisappearingClaude", { helpText: completeHelp });
}

function writeFakeGh(binDir) {
  const fake = path.join(binDir, "gh");
  return writePortableFakeReviewerCli(fake, "runFakeGh");
}

function writeFakeOpenCode(binDir) {
  const fake = path.join(binDir, "opencode");
  return writePortableFakeReviewerCli(fake, "runFakeOpenCode");
}

function renderHandoff(dir, handoff = auditHandoff, extraEnv = {}, options = {}) {
  const handoffPath = path.join(dir, "handoff.json");
  writeFileSync(handoffPath, JSON.stringify(handoff), "utf8");
  const evidenceRoot = path.join(dir, "control-evidence");
  const authorityPath = handoff.review_scope
    ? immutableAuthorityFixture(handoff, dir)
    : process.env.PATH;
  const prepared = prepareOwnedCanonicalRenderer({
    fixtureDir: dir,
    repoRoot: REPO_ROOT,
    rendererPath: renderer,
    ownedCarrierRoot: options.ownedCarrierRoot,
  });
  assertNotLiveWrite(
    prepared.mutatedRendererPath,
    prepared.carrierRootArg,
    liveCanonicalCarrierRoot,
    renderer,
  );
  const render = spawnSync(
    process.execPath,
    [prepared.mutatedRendererPath, handoffPath, "--carrier-root", prepared.carrierRootArg],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        // T5 fix (design.md D11): this whole file executes/asserts against
        // `context.projection_runner_command` as the pre-existing absolute
        // carrier (e.g. runGeneratedRunnerCommand/Async deliberately spawn
        // it from a cwd OTHER than the repo root, to prove the absolute
        // form's cwd independence — that would ERR_MODULE_NOT_FOUND against
        // the D2 relative carrier's repo-relative script path). An ambient
        // `CLAUDE_CODE_SESSION_ID` (inherited from a real Claude Code CLI
        // session running this test file) would otherwise make the renderer
        // emit the relative carrier here instead. This file never exercises
        // the new relative-carrier behavior (that lives in its own dedicated
        // file, run-second-reviewer-projection-runner-carrier.test.mjs).
        ...envWithoutHostMarkers(),
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
        // Per-test sidecar isolation: pr-sticky renders reuse a handful of PR
        // numbers across this file, so a shared state dir would trip the cap-3
        // pr-sticky round budget (R2). An explicit extraEnv value still wins.
        DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(dir, "post-pr-completion-state"),
        PATH: authorityPath,
        ...extraEnv,
      },
    },
  );
  assert.equal(render.status, 0, render.stderr);
  const packetPath = render.stdout.trim();
  assertAttemptUnderOwnedRoot(packetPath, prepared.ownedCarrierRoot);
  const carrierDir = registerPublishedExactCarrier(dir, packetPath);
  const contextPath = path.join(carrierDir, "observability-context.json");
  const context = JSON.parse(readFileSync(contextPath, "utf8"));
  assert.equal(context.guarantee_assessment_required, true, "new renderer activates assessment consumption");
  // Historical compatibility requires an explicit opt-out; normal fixtures use production activation.
  if (options.guaranteeAssessmentRequired === false) {
    delete context.guarantee_assessment_required;
    writeFileSync(contextPath, JSON.stringify(context));
  }
  return {
    packetPath,
    carrierDir,
    contextPath,
    context,
    authorityPath,
    evidenceRoot,
    ownedCarrierRoot: prepared.ownedCarrierRoot,
  };
}

if (PROJECTION_TEST_GROUP === "core") {
  nodeTest("new pr-sticky runner validates the published assessment and completion agreement", () => {
    for (const variant of ["valid", "missing-sticky", "different-sticky"]) {
      withTempDir("second-review-assessment-sticky-", dir => {
        const binDir = path.join(dir, "bin"); mkdirSync(binDir, { recursive: true }); writeFakeClaude(binDir); writeFakeGh(binDir);
        const { context } = renderHandoff(dir, prStickyHandoff, {}, { guaranteeAssessmentRequired: true });
        const report = { schema: "devpro.review-guarantee-assessment/v1", reviewed_target: context.head_ref_oid, dispatch_id: context.dispatch_id, assessments: [] };
        const section = value => "## Guarantee Assessment\n```json\n" + JSON.stringify(value) + "\n```";
        const response = JSON.parse(currentHeadStickyResponse("PASS", context.dispatch_id, "Claude Code", "claude-test", false));
        if (variant !== "missing-sticky") {
          const stickyReport = variant === "different-sticky" ? { ...report, assessments: [{ finding_id: "F1", guarantee_ceiling: "cooperative", classification: "above-ceiling", rationale: "TL ruling needed" }] } : report;
          response.comments[0].body = response.comments[0].body.replace("\nRules:", "\n\n" + section(stickyReport) + "\nRules:");
        }
        const reason = "No blocking findings.\n\n" + section(report);
        const result = runGeneratedRunnerCommand(context, binDir, {
          DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
          DEVPRO_FAKE_GUARANTEE_NO_AUTO: "1",
          DEVPRO_FAKE_GH_RESPONSE: JSON.stringify(response),
          DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({
            sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242", verdict: "PASS", last_reviewed_sha: context.head_ref_oid, reviewer_model: "claude-test", reason,
          }) }),
        });
        assert.equal(result.status, variant === "valid" ? 0 : 1, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.sticky.status, variant === "valid" ? "verified" : "failed");
        if (variant === "valid") assert.deepEqual(output.guarantee_assessment.next_actions, []);
      });
    }
  });
  nodeTest("new renderer runner consumes assessment before accepting native completion", () => {
    for (const assessmentPresent of [false, true]) {
      withTempDir("second-review-assessment-native-", dir => {
        const binDir = path.join(dir, "bin"); mkdirSync(binDir, { recursive: true }); writeFakeClaude(binDir);
        const { context } = renderHandoff(dir, auditHandoff, {}, { guaranteeAssessmentRequired: true });
        const report = { schema: "devpro.review-guarantee-assessment/v1", reviewed_target: context.target, dispatch_id: context.dispatch_id, assessments: [] };
        const reason = "No blocking findings." + (assessmentPresent ? "\n\n## Guarantee Assessment\n```json\n" + JSON.stringify(report) + "\n```" : "");
        const result = runGeneratedRunnerCommand(context, binDir, {
          DEVPRO_FAKE_GUARANTEE_NO_AUTO: "1",
          DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({
            sticky_comment_url: "none", verdict: "PASS", last_reviewed_sha: "none", reviewer_model: "claude-test", reason,
          }) }),
        });
        assert.equal(result.status, assessmentPresent ? 0 : 1, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.status, assessmentPresent ? "finished" : "blocked");
      });
    }
  });

  nodeTest("opencode pr-sticky runner accepts a session-export-verified sticky and blocks a wrong-model export", () => {
    for (const variant of ["valid", "wrong-model", "tool-outside-policy"]) {
      withTempDir("second-review-opencode-sticky-", dir => {
        const binDir = path.join(dir, "bin"); mkdirSync(binDir, { recursive: true }); writeFakeOpenCode(binDir); writeFakeGh(binDir);
        const openCodeHandoff = { ...prStickyHandoff, reviewer_family: "deepseek" };
        const { context } = renderHandoff(dir, openCodeHandoff, {
          PATH: [binDir, path.join(dir, "immutable-authority-bin"), process.env.PATH].join(path.delimiter),
        }, { guaranteeAssessmentRequired: true });
        assert.equal(context.reviewer_opencode.tool_policy, "pr-sticky");
        assert.equal(context.reviewer_opencode.agent_name, "devpro-review-sticky");
        const report = { schema: "devpro.review-guarantee-assessment/v1", reviewed_target: context.head_ref_oid, dispatch_id: context.dispatch_id, assessments: [] };
        const section = "## Guarantee Assessment\n```json\n" + JSON.stringify(report) + "\n```";
        const response = JSON.parse(currentHeadStickyResponse("PASS", context.dispatch_id, "OpenCode", "deepseek/deepseek-v4-pro", false));
        response.comments[0].body = response.comments[0].body.replace("\nRules:", "\n\n" + section + "\nRules:");
        const result = runGeneratedRunnerCommand(context, binDir, {
          DEVPRO_FAKE_GUARANTEE_NO_AUTO: "1",
          DEVPRO_FAKE_GH_RESPONSE: JSON.stringify(response),
          DEVPRO_FAKE_OPENCODE_STATE_DIR: path.join(dir, "fake-opencode-state"),
          DEVPRO_FAKE_OPENCODE_TOOL_USE: variant === "tool-outside-policy" ? "write,shell,webfetch" : "write,shell",
          ...(variant === "wrong-model" ? { DEVPRO_FAKE_OPENCODE_EXPORT_MODEL: "deepseek/deepseek-v4-flash" } : {}),
          DEVPRO_FAKE_OPENCODE_REPORT: JSON.stringify({
            sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242",
            verdict: "PASS",
            last_reviewed_sha: context.head_ref_oid,
            reviewer_model: "deepseek/deepseek-v4-pro",
            reason: "No blocking findings.\n\n" + section,
          }),
          ...(process.platform === "win32" ? { NODE_OPTIONS: process.env.NODE_OPTIONS ?? "" } : {}),
        });
        const output = JSON.parse(result.stdout);
        if (variant === "valid") {
          assert.equal(result.status, 0, result.stderr + result.stdout);
          assert.equal(output.sticky.status, "verified");
          const events = readFileSync(context.activity_log_path, "utf8").trim().split("\n").map(line => JSON.parse(line));
          assert.equal(events.find(event => event.event === "projection_opencode_session_verified").observed_selector, "deepseek/deepseek-v4-pro");
        } else {
          assert.equal(result.status, 1, result.stderr + result.stdout);
          assert.equal(output.status, "blocked");
          assert.equal(output.classification, variant === "wrong-model" ? "reviewer_model_provenance_unverified" : "reviewer_tool_surface_mismatch");
        }
      });
    }
  });

  nodeTest("active native runner preserves unavailable and critical classifications without assessment", () => {
    for (const verdict of ["UNAVAILABLE", "CRITICAL"]) withTempDir("second-review-assessment-blocking-", dir => {
      const binDir = path.join(dir, "bin"); mkdirSync(binDir); writeFakeClaude(binDir);
      const { context } = renderHandoff(dir, auditHandoff);
      assert.equal(context.guarantee_assessment_required, true);
      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_GUARANTEE_NO_AUTO: "1",
        DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({
          sticky_comment_url: "none", verdict, last_reviewed_sha: "none", reviewer_model: "claude-test", reason: "Existing blocking outcome.",
        }) }),
      });
      const output = JSON.parse(result.stdout);
      assert.equal(result.status, 1);
      assert.equal(output.classification, "reviewer_completion_" + verdict.toLowerCase());
      assert.equal(output.guarantee_assessment, undefined);
    });
  });
  nodeTest("active paged native runner checks every window finding and refuses an omitted assessment ID", async () => {
    for (const omitted of [false, true]) await withTempDirAsync("second-review-assessment-paged-", async dir => {
      const rendered = renderHandoff(dir, largePrStickyHandoff());
      const { context, contextPath } = rendered;
      assert.equal(context.guarantee_assessment_required, true);
      const binDir = path.join(dir, "bin"); mkdirSync(binDir); writeFakeClaude(binDir); writeFakeGh(binDir);
      const authorityGh = path.join(rendered.authorityPath.split(path.delimiter)[0], "gh");
      const program = path.join(dir, "page-reviewer.mjs");
      writeFileSync(program, `
import { readFileSync } from "node:fs";
const packet = readFileSync(0);
const marker = "Content-Type: application/json\\nContent-Length: ";
const start = packet.indexOf(marker) + Buffer.byteLength(marker);
const end = packet.indexOf("\\n\\n", start);
const data = JSON.parse(packet.subarray(end + 2, end + 2 + Number(packet.subarray(start, end).toString())));
const material = data.review_material;
const index = material.pages[0].index;
const findings = [{ severity: "WARN", summary_id: "F" + index, summary: "fixture ordinary omission" }];
const report = { schema: "devpro.review-guarantee-assessment/v1", reviewed_target: data.head_ref_oid, dispatch_id: data.dispatch_id,
  assessments: ${omitted} ? [] : [{ finding_id: "F" + index, guarantee_ceiling: "fixture cooperative reviewer; mechanical shape checks", classification: "within-ceiling", rationale: "ordinary omission within the promise" }] };
const section = "## Guarantee Assessment\\n" + String.fromCharCode(96).repeat(3) + "json\\n" + JSON.stringify(report) + "\\n" + String.fromCharCode(96).repeat(3);
const completion = { sticky_comment_url: "none", verdict: "WARN", last_reviewed_sha: data.head_ref_oid, reviewer_model: "claude-test", reason: section,
  window_index: index, page_indices: material.pages.map(page => page.index), head_ref_oid: data.head_ref_oid, dispatch_id: data.dispatch_id, findings, findings_payload_sha256: "runner-seal" };
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(completion) }));
`);
      const result = await withProcessEnv({ PATH: binDir + path.delimiter + rendered.authorityPath, DEVPRO_FAKE_GH_API_RESPONSE: emptyStickyAuthorityApiResponse }, () => runProjection(contextPath, {
        cwd: REPO_ROOT, execPath: process.execPath,
        executableDiscoveryOptions: { pathValue: binDir }, scopeProbeOptions: { spawnSync: fullPrScopeProbeSpawnSync() },
        stickyDispositionOptions: verifiedEmptyStickyDispositionOptions,
        env: { ...process.env, PATH: binDir + path.delimiter + rendered.authorityPath, DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
          DEVPRO_FAKE_GH_SCOPE_AUTHORITY: authorityGh, DEVPRO_FAKE_REVIEWER_PAGE_PROGRAM: program, DEVPRO_FAKE_GH_API_RESPONSE: emptyStickyAuthorityApiResponse },
      }));
      const assessments = readFileSync(context.activity_log_path, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(event => event.event === "projection_guarantee_assessment");
      if (omitted) {
        assert.equal(result.classification, "reviewer_completion_contract_invalid");
        assert.match(result.assessment_diagnostic, /match every structured finding/);
        assert.equal(assessments.length, 0);
      } else {
        assert.equal(result.classification, "sticky_missing", JSON.stringify(result));
        assert.equal(assessments.length, context.page_window_count);
        for (const event of assessments) assert.equal(event.next_actions.length, 1);
      }
    });
  });
  nodeTest("historical context accepts actual native completion without any assessment", () => {
    withTempDir("second-review-assessment-historical-", dir => {
      const binDir = path.join(dir, "bin"); mkdirSync(binDir); writeFakeClaude(binDir);
      const { context } = renderHandoff(dir, auditHandoff, {}, { guaranteeAssessmentRequired: false });
      assert.equal(Object.hasOwn(context, "guarantee_assessment_required"), false);
      const result = runGeneratedRunnerCommand(context, binDir, { DEVPRO_FAKE_GUARANTEE_NO_AUTO: "1" });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.classification, "reviewer_cli_completed");
      assert.equal(output.guarantee_assessment, undefined);
    });
  });
  nodeTest("runner fixture removes only its registered exact carrier root", () => {
    let carrierDir;
    let unregisteredSibling;
    const outerOwned = mkdtempSync(path.join(tmpdir(), "second-review-runner-owned-sibling-"));
    try {
      withTempDir("second-review-runner-carrier-cleanup-", (dir) => {
        ({ carrierDir } = renderHandoff(dir, auditHandoff, {}, { ownedCarrierRoot: outerOwned }));
        unregisteredSibling = path.join(
          outerOwned,
          `${path.basename(dir)}-unregistered-sibling`,
        );
        mkdirSync(unregisteredSibling);
        assert.equal(existsSync(carrierDir), true, "successful publication must create its carrier root");
        assertAttemptUnderOwnedRoot(carrierDir, outerOwned);
      });

      assert.equal(existsSync(carrierDir), false, "fixture teardown must immediately remove its exact carrier root");
      assert.equal(
        existsSync(unregisteredSibling),
        true,
        "fixture teardown must not scan or remove an unregistered sibling",
      );
    } finally {
      if (carrierDir) rmSync(carrierDir, { recursive: true, force: true });
      if (unregisteredSibling) rmSync(unregisteredSibling, { recursive: true, force: true });
      rmSync(outerOwned, { recursive: true, force: true });
    }
  });
}

for (const scenario of ["CRITICAL", "PASS", "WARN", "reject-PASS", "reject-WARN", "missing-sidecar", "checkpoint-write-failure", "deadline-expired", "retry-deadline-expired"]) nodeTest(`unified scan ${scenario}: native runner preserves coverage and guards its sticky`, async (t) => {
  await withTempDirAsync("critical-scan-live-", async dir => {
    const rejectedVerdict = scenario.startsWith("reject-") ? scenario.slice(7) : null;
    const missingSidecar = scenario === "missing-sidecar";
    const failedCheckpoint = scenario === "checkpoint-write-failure";
    const retryDeadlineExpired = scenario === "retry-deadline-expired";
    const deadlineExpired = scenario === "deadline-expired" || retryDeadlineExpired;
    const finalVerdict = deadlineExpired ? "PASS" : scenario;
    const aggregateVerdict = rejectedVerdict || missingSidecar || failedCheckpoint ? "CRITICAL" : finalVerdict;
    const previous = JSON.parse(currentHeadStickyResponse("PASS", "previous-dispatch", "Claude Code", "claude-test", false)).comments[0];
    const handoff = { ...largePrStickyHandoff(), full_scope_reason: "Risk-shape change requires complete window coverage", sticky_authority_snapshot: { ...emptyStickyAuthoritySnapshot, comments: [previous] } };
    const rendered = renderHandoff(dir, handoff, {}, { guaranteeAssessmentRequired: false });
    const { context, contextPath } = rendered;
    const binDir = path.join(dir, "bin"); mkdirSync(binDir); writeFakeClaude(binDir); writeFakeGh(binDir);
    const storePath = path.join(dir, "comment-store.json");
    writeFileSync(storePath, JSON.stringify({ comment: previous, etag: "initial", getCount: 0 }));
    const tracePath = path.join(dir, "windows.jsonl");
    const writesPath = path.join(dir, "writes.jsonl");
    const sidecarPaths = [resolveCredentialGateSidecarPath(undefined, context.dispatch_id), path.join(path.dirname(contextPath), STICKY_CREDENTIAL_GATE_SIDECAR_BASENAME)];
    const program = path.join(dir, "review-window.mjs");
    const bodyTemplate = JSON.parse(currentHeadStickyResponse(aggregateVerdict, "dispatch-template", "Claude Code", "claude-test", false)).comments[0].body;
    writeFileSync(program, `
import { readFileSync, writeFileSync, appendFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
const packet = readFileSync(0);
const text = packet.toString("utf8");
const marker = "Content-Type: application/json\\nContent-Length: ";
const start = packet.indexOf(marker) + Buffer.byteLength(marker);
const end = packet.indexOf("\\n\\n", start);
const data = JSON.parse(packet.subarray(end + 2, end + 2 + Number(packet.subarray(start, end).toString())));
const material = data.review_material;
const index = material.pages[0].index;
const checkpoint = text.includes("intermediate CRITICAL write checkpoint");
const stored = JSON.parse(readFileSync(${JSON.stringify(storePath)}, "utf8"));
const sidecars = ${JSON.stringify(sidecarPaths)}.map(p => ({ verdict: JSON.parse(readFileSync(p, "utf8")).required_verdict ?? null, mode: statSync(p).mode & 0o777 }));
appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ index, checkpoint, priorBody: stored.comment.body, sidecars }) + "\\n");
if (${missingSidecar} && index === 1) rmSync(${JSON.stringify(sidecarPaths[0])});
const critical = ${JSON.stringify(aggregateVerdict)} === "CRITICAL" && (index === 1 || index === 3);
const findings = critical ? [{ severity: "CRITICAL", summary_id: "C" + index, summary: "blocking finding on window " + index }] : ${JSON.stringify(aggregateVerdict)} === "WARN" && index === 1 ? [{ severity: "WARN", summary_id: "W1", summary: "bounded advisory" }] : [];
const final = material.window_role === "final";
if (checkpoint || final) {
  const body = ${JSON.stringify(bodyTemplate)}.replace("dispatch-template", data.dispatch_id);
  const attemptedVerdict = checkpoint && ${failedCheckpoint} ? "PASS" : final ? ${JSON.stringify(rejectedVerdict)} : null;
  writeFileSync("cross-model-second-opinion.md", attemptedVerdict ? body.replace("verdict: CRITICAL", "verdict: " + attemptedVerdict) : body);
  const recipe = text.match(/sticky_write_exact_recipe: node (\\S+) (\\S+)/);
  if (!recipe) throw new Error("missing gated write recipe");
  const write = spawnSync(process.execPath, [recipe[1], recipe[2]], { encoding: "utf8", env: process.env, timeout: 60000 });
  if (write.error) throw write.error;
  appendFileSync(${JSON.stringify(writesPath)}, JSON.stringify({ index, checkpoint, status: write.status, failure: write.status === 0 ? null : JSON.parse(write.stderr) }) + "\\n");
  if (write.status !== 0 && !${JSON.stringify(rejectedVerdict)} && !${failedCheckpoint}) throw new Error(write.stderr);
}
const completion = { sticky_comment_url: checkpoint || final ? stored.comment.html_url : "none", verdict: checkpoint || critical ? "CRITICAL" : final ? ${JSON.stringify(aggregateVerdict)} : findings.length ? "WARN" : "PASS", last_reviewed_sha: data.head_ref_oid, reviewer_model: "claude-test", reason: "Bounded review reached a current-head gate verdict.", window_index: index, page_indices: material.pages.map(page => page.index), head_ref_oid: data.head_ref_oid, dispatch_id: data.dispatch_id, findings, findings_payload_sha256: "runner-seal" };
const result = ${retryDeadlineExpired} && index === 1 ? "{" : JSON.stringify(completion);
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "33333333-3333-3333-3333-" + String(index * 2 + Number(checkpoint)).padStart(12, "0"), usage: { input_tokens: 100, output_tokens: 10 }, result }));
`);
    const env = {
      ...process.env, PATH: binDir + path.delimiter + rendered.authorityPath,
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
      DEVPRO_FAKE_GH_SCOPE_AUTHORITY: path.join(rendered.authorityPath.split(path.delimiter)[0], "gh"),
      DEVPRO_FAKE_GH_COMMENT_STORE: storePath, DEVPRO_FAKE_GH_DYNAMIC_STICKY: "1",
      DEVPRO_FAKE_GH_API_COUNT_FILE: path.join(dir, "api-count"),
      DEVPRO_FAKE_REVIEWER_PAGE_PROGRAM: program,
      // v7.4.0 release run: one window hung and the default 30-minute total timeout held the
      // integration tier for 1807 s. Each window finishes in about a second, so a hang now fails
      // within two minutes as a timed-out window instead.
      DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "120000",
    };
    if (deadlineExpired) {
      const clock = performance.now.bind(performance);
      t.mock.method(performance, "now", () => clock() + (existsSync(tracePath) ? 120000 : 0));
    }
    const result = await withProcessEnv(env, () => runProjection(contextPath, {
      cwd: REPO_ROOT, execPath: process.execPath, env,
      executableDiscoveryOptions: { pathValue: binDir },
      scopeProbeOptions: { spawnSync: fullPrScopeProbeSpawnSync() },
    }));
    const trace = readFileSync(tracePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    if (deadlineExpired) {
      assert.equal(result.status, "blocked");
      assert.equal(result.classification, "reviewer_cli_timeout");
      assert.equal(result.cli_exit.process_close_observed, true);
      assert.equal(result.cli_exit.timed_out, false);
      assert.deepEqual(trace.map(row => row.index), [1]);
      const events = readFileSync(context.activity_log_path, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(events.filter(event => event.event === "projection_cli_starting").length, 1);
      const retries = events.filter(event => event.event === "projection_page_window_completion_retry");
      assert.deepEqual(retries.map(event => event.window_index), retryDeadlineExpired ? [1] : []);
      const exitIndex = events.findIndex(event => event.event === "projection_cli_exited");
      const deadlineIndex = events.findIndex(event => event.event === "projection_page_window_deadline_exhausted");
      assert.equal(events[deadlineIndex]?.next_window_pass, 2);
      assert.ok(exitIndex >= 0 && exitIndex < deadlineIndex);
      const expiryChecks = events.slice(exitIndex + 1, deadlineIndex)
        .filter(event => event.event === "projection_sticky_verification_started");
      assert.deepEqual(expiryChecks.map(event => event.expected_head_ref_oid), [context.head_ref_oid]);
      return;
    }
    if (missingSidecar) {
      assert.equal(result.status, "blocked");
      assert.equal(result.classification, "sticky_credential_gate_sidecar_invalid", JSON.stringify(result));
      assert.deepEqual(trace.map(row => row.index), [1]);
      const gates = readFileSync(context.activity_log_path, "utf8").trim().split("\n").map(JSON.parse).filter(event => event.event === "projection_page_window_live_gate");
      assert.equal(gates.at(-1)?.scan_complete, false);
      assert.deepEqual(gates.at(-1)?.critical_findings.map(finding => finding.summary_id), ["C1"]);
      return;
    }
    if (failedCheckpoint) {
      assert.equal(result.status, "blocked");
      assert.deepEqual(trace.map(row => row.index), [1, 1]);
      const gates = readFileSync(context.activity_log_path, "utf8").trim().split("\n").map(JSON.parse).filter(event => event.event === "projection_page_window_live_gate");
      assert.equal(gates.at(-1).scan_complete, false);
      assert.deepEqual(gates.at(-1).critical_findings?.map(finding => finding.summary_id), ["C1"]);
      assert.equal(gates.at(-1).sticky_authorized, false);
      return;
    }
    assert.deepEqual(trace.filter(row => !row.checkpoint).map(row => row.index), Array.from({ length: context.page_window_count }, (_, i) => i + 1), JSON.stringify(result));
    assert.equal(trace.filter(row => row.checkpoint).length, aggregateVerdict === "CRITICAL" ? 1 : 0);
    if (aggregateVerdict === "CRITICAL") {
      assert.match(trace.find(row => row.index === 2).priorBody, /verdict: CRITICAL/);
      for (const row of trace.filter(row => row.checkpoint || row.index > 1)) {
        assert.deepEqual(row.sidecars.map(sidecar => sidecar.verdict), ["CRITICAL", "CRITICAL"], `clamp must survive packet advance before window ${row.index} spawn`);
        if (process.platform !== "win32") assert.deepEqual(row.sidecars.map(sidecar => sidecar.mode), [0o600, 0o600]);
      }
    }
    if (rejectedVerdict) {
      const writes = readFileSync(writesPath, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(writes.at(-1).status, 1);
      assert.equal(writes.at(-1).failure.classification, "sticky_required_verdict_mismatch");
    }
    const events = readFileSync(context.activity_log_path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    if (scenario === "PASS") {
      const budgets = events
        .filter(event => event.event === "projection_cli_starting")
        .map(event => event.total_timeout_ms);
      assert.equal(budgets.length, trace.length);
      assert.equal(budgets[0], 120000);
      assert.ok(budgets.length > 1);
      assert.ok(
        budgets.slice(1).every((budget, index) => budget > 0 && budget < budgets[index]),
        `review windows must share one decreasing deadline: ${budgets.join(", ")}`,
      );
    }
    const checkpoints = events.filter(event => event.event === "projection_page_window_live_gate" && ["intermediate_critical_sticky", "critical_sticky_checkpoint"].includes(event.phase));
    assert.equal(checkpoints.length, aggregateVerdict === "CRITICAL" ? 2 : 0);
    for (const event of checkpoints) {
      assert.equal(Object.hasOwn(event, "critical_findings"), false);
      assert.equal(event.critical_findings_count, 1);
      assert.equal(event.scan_complete, false);
    }
    const complete = events.find(event => event.event === "projection_page_window_live_gate" && event.scan_complete);
    assert.ok(complete, JSON.stringify(result));
    assert.deepEqual(complete.critical_findings.filter(finding => finding.summary_id !== null).map(finding => finding.summary_id), aggregateVerdict === "CRITICAL" ? ["C1", "C3"] : []);
    assert.equal(complete.findings_windows, context.page_window_count);
    assert.equal(result.status, aggregateVerdict === "CRITICAL" ? "blocked" : "finished", JSON.stringify(result));
    assert.equal(result.sticky.sticky_comment_id, previous.id);
    assert.match(JSON.parse(readFileSync(storePath, "utf8")).comment.body, new RegExp("verdict: " + aggregateVerdict));
    const manifest = JSON.parse(readFileSync(path.join(context.control_evidence_root, context.dispatch_id, "usage-manifest.json"), "utf8"));
    assert.deepEqual(manifest.paged_coverage.invoked_windows.map(row => row.index), Array.from({ length: trace.length }, (_, index) => index + 1));
    assert.equal(manifest.sessions.filter(row => row.role === "reviewer").length, trace.length);
    assert.equal(manifest.gaps.some(gap => gap.name.startsWith("reviewer-window-")), false, JSON.stringify(manifest.gaps));
  });
});

function mutateFramedReviewData(packetPath, mutate) {
  const packet = readFileSync(packetPath);
  const marker = Buffer.from(SECOND_REVIEW_FRAME_MARKER, "utf8");
  const separator = Buffer.from("\n\n", "utf8");
  const markerStart = packet.indexOf(marker);
  assert.notEqual(markerStart, -1);
  const lengthStart = markerStart + marker.length;
  const headerEnd = packet.indexOf(separator, lengthStart);
  assert.notEqual(headerEnd, -1);
  const payloadStart = headerEnd + separator.length;
  const payloadLength = Number(packet.subarray(lengthStart, headerEnd).toString("utf8"));
  const payloadEnd = payloadStart + payloadLength;
  const data = JSON.parse(packet.subarray(payloadStart, payloadEnd).toString("utf8"));
  mutate(data);
  const mutatedPayload = Buffer.from(JSON.stringify(data), "utf8");
  writeFileSync(packetPath, Buffer.concat([
    packet.subarray(0, lengthStart),
    Buffer.from(String(mutatedPayload.length), "utf8"),
    separator,
    mutatedPayload,
    packet.subarray(payloadEnd),
  ]));
}

function derivedPostWriteGhEnv(extraEnv) {
  const snapshotText = extraEnv.DEVPRO_FAKE_GH_POST_API_RESPONSE
    ?? extraEnv.DEVPRO_FAKE_GH_RESPONSE
    ?? extraEnv.DEVPRO_FAKE_GH_API_RESPONSE;
  if (typeof snapshotText !== "string") return {};
  try {
    const snapshot = JSON.parse(snapshotText);
    const comments = Array.isArray(snapshot?.comments) ? snapshot.comments : [];
    return {
      DEVPRO_FAKE_GH_POST_API_RESPONSE: snapshotText,
      ...(comments.length === 1
        ? { DEVPRO_FAKE_GH_EXACT_COMMENT_RESPONSE: JSON.stringify(comments[0]) }
        : {}),
    };
  } catch {
    return {};
  }
}

test("issue 1717: generic commit-range route is rejected before any reviewer probe or spawn", async () => {
  await withTempDirAsync("second-review-runner-range-generic-route-", async (dir) => {
    const { context, contextPath } = renderHandoff(dir, liveCommitRangeHandoff);
    context.review_scope_read_recipe = {
      ...context.review_scope_read_recipe,
      route_id: "gh-pr-generic-diff-v0",
      argv: ["pr", "diff", "1658"],
      quoted_command: "gh pr diff 1658",
    };
    writeFileSync(contextPath, JSON.stringify(context), "utf8");
    let scopeProbeCalls = 0;
    let reviewerProbeCalls = 0;

    const result = await runProjection(contextPath, {
      scopeProbeOptions: {
        spawnSync() {
          scopeProbeCalls += 1;
          throw new Error("scope probe must not execute for a generic route");
        },
      },
      probeOptions: {
        runCommand() {
          reviewerProbeCalls += 1;
          throw new Error("reviewer CLI probe must not execute for a generic route");
        },
      },
    });

    assert.equal(result.classification, "reviewer_cli_recipe_invalid");
    assert.equal(scopeProbeCalls, 0);
    assert.equal(reviewerProbeCalls, 0);
    assert.equal(existsSync(`${contextPath}.attempt.lock`), false);
    assert.equal(existsSync(context.review_scope_probe_result_path), false);
    assert.equal(activityEvents(context.activity_log_path).includes("projection_cli_starting"), false);
  });
});

test("issue 1717: exact compare success publishes only bounded typed scope evidence", async () => {
  await withTempDirAsync("second-review-runner-range-exact-success-", async (dir) => {
    const { context, contextPath } = renderHandoff(dir, liveCommitRangeHandoff);
    let scopeProbeCalls = 0;
    let reviewerProbeCalls = 0;

    const result = await runProjection(contextPath, {
      executableDiscoveryOptions: trustedReviewerExecutableDiscoveryOptions,
      stickyDispositionOptions: verifiedEmptyStickyDispositionOptions,
      scopeProbeOptions: {
        spawnSync(executable, argv, options) {
          scopeProbeCalls += 1;
          assert.equal(executable, "gh");
          assert.deepEqual(argv, [
            "api",
            `repos/{owner}/{repo}/compare/${commitRangeBaseSha}...${prStickyHeadSha}`,
          ]);
          assert.equal(options.env.GH_REPO, liveCommitRangeHandoff.repository_slug);
          assert.equal(options.maxBuffer, 2_097_152);
          return {
            status: 0,
            stdout: JSON.stringify(exactCommitRangeProbePayload()),
            stderr: "",
          };
        },
      },
      probeOptions: {
        runCommand(command) {
          reviewerProbeCalls += 1;
          return {
            command,
            args: [],
            status: 1,
            signal: null,
            error: null,
            error_code: null,
            stdout: "",
            stderr: "reviewer unavailable after successful scope proof",
          };
        },
      },
    });

    assert.equal(scopeProbeCalls, 1);
    assert.ok(reviewerProbeCalls > 0, "successful exact scope proof must advance to the reviewer CLI probe");
    assert.equal(result.classification, "probe_evidence_unavailable");
    const persisted = readFileSync(context.review_scope_probe_result_path, "utf8");
    const scopeResult = JSON.parse(persisted);
    assert.equal(scopeResult.status, "verified");
    assert.equal(scopeResult.classification, "review_material_scope_resolved");
    assert.deepEqual(scopeResult.resolved_scope, {
      kind: "commit-range",
      base_sha: commitRangeBaseSha,
      head_sha: prStickyHeadSha,
      merge_base_sha: commitRangeBaseSha,
    });
    assert.deepEqual(scopeResult.counts, { commits: 2, files: 2 });
    assert.doesNotMatch(persisted, /SENSITIVE_RAW_COMMIT_MESSAGE/);
    assert.equal(existsSync(`${contextPath}.attempt.lock`), false);
  });
});

test("issue 1717: full-pr live scope probes exact PR, head, and files before reviewer probing", async () => {
  assertPortableFakeGhRoutes();
  await withTempDirAsync("second-review-runner-full-pr-exact-success-", async (dir) => {
    const { context, contextPath } = renderHandoff(dir, liveFullPrHandoff);
    let scopeProbeCalls = 0;
    let reviewerProbeCalls = 0;

    const result = await runProjection(contextPath, {
      executableDiscoveryOptions: trustedReviewerExecutableDiscoveryOptions,
      stickyDispositionOptions: verifiedEmptyStickyDispositionOptions,
      scopeProbeOptions: {
        spawnSync(...args) {
          scopeProbeCalls += 1;
          return fullPrScopeProbeSpawnSync({ assertEnvSlug: true })(...args);
        },
      },
      probeOptions: {
        runCommand(command) {
          reviewerProbeCalls += 1;
          return {
            command,
            args: [],
            status: 1,
            signal: null,
            error: null,
            error_code: null,
            stdout: "",
            stderr: "reviewer unavailable after successful full-pr scope proof",
          };
        },
      },
    });

    assert.equal(scopeProbeCalls, 3, "head bind + path-only files list + head rebind");
    assert.ok(reviewerProbeCalls > 0, "verified full-pr scope must advance to reviewer CLI probing");
    assert.equal(result.classification, "probe_evidence_unavailable");
    const scopeResult = JSON.parse(readFileSync(context.review_scope_probe_result_path, "utf8"));
    assert.equal(scopeResult.status, "verified");
    assert.equal(scopeResult.classification, "review_material_scope_resolved");
    assert.deepEqual(scopeResult.resolved_scope, prStickyScope);
    assert.deepEqual(scopeResult.counts, { files: 2 });
    assert.equal(existsSync(`${contextPath}.attempt.lock`), false);
  });
});

test("issue 1717: full-pr head mismatch blocks before reviewer spawn, completion, or sticky", async () => {
  await withTempDirAsync("second-review-runner-full-pr-head-mismatch-", async (dir) => {
    const { context, contextPath } = renderHandoff(dir, liveFullPrHandoff);
    let reviewerProbeCalls = 0;
    const result = await runProjection(contextPath, {
      executableDiscoveryOptions: trustedReviewerExecutableDiscoveryOptions,
      stickyDispositionOptions: verifiedEmptyStickyDispositionOptions,
      scopeProbeOptions: {
        spawnSync: fullPrScopeProbeSpawnSync({
          headOverrides: { headRefOid: "d".repeat(40) },
        }),
      },
      probeOptions: {
        runCommand() {
          reviewerProbeCalls += 1;
          throw new Error("full-pr head mismatch must stop before reviewer CLI probing");
        },
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "review_material_scope_unresolvable");
    assert.equal(result.failure_relation, "resolved_pr_or_head_mismatch");
    assert.equal(reviewerProbeCalls, 0);
    const scopeResult = JSON.parse(readFileSync(context.review_scope_probe_result_path, "utf8"));
    assert.equal(scopeResult.status, "blocked");
    assert.equal(scopeResult.classification, "review_material_scope_unresolvable");
    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal?.record.outcome_group, "spawn_or_probe_failure");
    assert.equal(terminal?.record.process_spawned, false);
    const evidenceDir = path.join(context.control_evidence_root, context.dispatch_id);
    assert.equal(existsSync(path.join(evidenceDir, "invocation-claim.json")), false);
    assert.equal(existsSync(path.join(evidenceDir, "completion.json")), false);
    const events = activityEvents(context.activity_log_path);
    assert.equal(events.includes("projection_cli_starting"), false);
    assert.equal(events.includes("projection_cli_started"), false);
    assert.equal(events.some((event) => event.startsWith("projection_sticky_")), false);
  });
});


test("Scenario: Full-PR live-read probe reaches 101–1000 files", () => {
  for (const fileCount of [101, 542, 1000]) {
    const manyFiles = Array.from({ length: fileCount }, (_, index) => `src/path-${index}.mjs`);
    withTempDir(`second-review-runner-full-pr-${fileCount}-files-`, (dir) => {
      // Render a small live-full-pr packet (renderer patch probe cannot invent the fixture repo paths),
      // then widen expected paths + recipe in memory for the runner-owned scope probe.
      const { context } = renderHandoff(dir, liveFullPrHandoff);
      const reviewData = parseCanonicalSecondReviewPacketData(readFileSync(context.packet_path));
      reviewData.changed_files_or_touch_list = manyFiles;
      context.review_scope_read_recipe = canonicalReviewScopeReadRecipe(reviewData);
      assert.equal(context.review_scope_read_recipe.expected_changed_files.length, fileCount);
      rmSync(context.review_scope_probe_result_path, { force: true });
      let calls = 0;
      const headStdout = JSON.stringify({
        number: prStickyScope.pull_request_number,
        headRefOid: prStickyScope.head_sha,
        changedFiles: fileCount,
      });
      const result = runReviewScopeProbe(context, reviewData, {
        spawnSync(executable, argv) {
          calls += 1;
          assert.equal(executable, "gh");
          if (argv[0] === "pr") {
            assert.deepEqual(argv, [
              "pr", "view", String(prStickyScope.pull_request_number),
              "--json", "number,headRefOid,changedFiles",
            ]);
            return { status: 0, stdout: headStdout, stderr: "" };
          }
          assert.deepEqual(argv, [
            "api", "--paginate", "--jq", ".[].filename",
            `repos/{owner}/{repo}/pulls/${prStickyScope.pull_request_number}/files`,
          ]);
          return {
            status: 0,
            stdout: `${manyFiles.join("\n")}\n`,
            stderr: "",
          };
        },
      });
      assert.equal(calls, 3);
      assert.equal(result.status, "verified", JSON.stringify(result));
      assert.equal(result.classification, "review_material_scope_resolved");
      assert.deepEqual(result.counts, { files: fileCount });
    });
  }
});

test("Scenario: Truncated GitHub files list is a named fail-closed relation", () => {
  const manyFiles = Array.from({ length: 101 }, (_, index) => `src/path-${index}.mjs`);
  withTempDir("second-review-runner-full-pr-files-truncated-", (dir) => {
    const { context } = renderHandoff(dir, liveFullPrHandoff);
    const reviewData = parseCanonicalSecondReviewPacketData(readFileSync(context.packet_path));
    reviewData.changed_files_or_touch_list = manyFiles;
    context.review_scope_read_recipe = canonicalReviewScopeReadRecipe(reviewData);
    rmSync(context.review_scope_probe_result_path, { force: true });
    const headStdout = JSON.stringify({
      number: prStickyScope.pull_request_number,
      headRefOid: prStickyScope.head_sha,
      changedFiles: 101,
    });
    const result = runReviewScopeProbe(context, reviewData, {
      spawnSync(executable, argv) {
        assert.equal(executable, "gh");
        if (argv[0] === "pr") {
          return { status: 0, stdout: headStdout, stderr: "" };
        }
        assert.deepEqual(argv, [
          "api", "--paginate", "--jq", ".[].filename",
          `repos/{owner}/{repo}/pulls/${prStickyScope.pull_request_number}/files`,
        ]);
        return {
          status: 0,
          stdout: `${manyFiles.slice(0, 50).join("\n")}\n`,
          stderr: "",
        };
      },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "review_material_scope_unresolvable");
    assert.equal(result.failure_relation, "gh_pr_view_files_truncated");
  });
});

test("issue 1717: compare mismatch blocks pre-spawn without sticky or completion evidence", async () => {
  await withTempDirAsync("second-review-runner-range-compare-mismatch-", async (dir) => {
    const { context, contextPath } = renderHandoff(dir, liveCommitRangeHandoff);
    let reviewerProbeCalls = 0;
    const result = await runProjection(contextPath, {
      executableDiscoveryOptions: trustedReviewerExecutableDiscoveryOptions,
      stickyDispositionOptions: verifiedEmptyStickyDispositionOptions,
      scopeProbeOptions: {
        spawnSync() {
          return {
            status: 0,
            stdout: JSON.stringify(exactCommitRangeProbePayload({
              merge_base_commit: { sha: "d".repeat(40) },
            })),
            stderr: "",
          };
        },
      },
      probeOptions: {
        runCommand() {
          reviewerProbeCalls += 1;
          throw new Error("scope mismatch must stop before reviewer CLI probing");
        },
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "review_material_scope_unresolvable");
    assert.equal(result.failure_relation, "resolved_base_head_or_merge_base_mismatch");
    assert.equal(reviewerProbeCalls, 0);
    const scopeResult = JSON.parse(readFileSync(context.review_scope_probe_result_path, "utf8"));
    assert.equal(scopeResult.status, "blocked");
    assert.equal(scopeResult.classification, "review_material_scope_unresolvable");
    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal?.record.classification, "review_material_scope_unresolvable");
    assert.equal(terminal?.record.process_spawned, false);
    const evidenceDir = path.join(context.control_evidence_root, context.dispatch_id);
    assert.equal(existsSync(path.join(evidenceDir, "invocation-claim.json")), false);
    assert.equal(existsSync(path.join(evidenceDir, "completion.json")), false);
    const events = activityEvents(context.activity_log_path);
    assert.equal(events.some((event) => event.startsWith("projection_sticky_")), false);
    assert.equal(events.includes("projection_cli_starting"), false);
  });
});

test("issue 1717: stale scope evidence sidecar is never overwritten", () => {
  withTempDir("second-review-runner-range-stale-probe-", (dir) => {
    const { context } = renderHandoff(dir, liveCommitRangeHandoff);
    const stale = '{"schema":"stale-predecessor"}\n';
    writeFileSync(context.review_scope_probe_result_path, stale, "utf8");
    const reviewData = parseCanonicalSecondReviewPacketData(readFileSync(context.packet_path));
    const result = runReviewScopeProbe(context, reviewData, {
      spawnSync() {
        return {
          status: 0,
          stdout: JSON.stringify(exactCommitRangeProbePayload()),
          stderr: "",
        };
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "review_material_scope_unresolvable");
    assert.equal(result.failure_relation, "probe_result_not_exclusively_publishable");
    assert.equal(readFileSync(context.review_scope_probe_result_path, "utf8"), stale);
  });
});

test("issue 1717: exact compare failure matrix stays typed, bounded, and fail closed", () => {
  const cases = [
    {
      name: "unresolved-base",
      result: () => ({
        status: 0,
        stdout: JSON.stringify(exactCommitRangeProbePayload({
          base_commit: { sha: "d".repeat(40) },
        })),
        stderr: "",
      }),
      relation: "resolved_base_head_or_merge_base_mismatch",
    },
    {
      name: "wrong-head",
      result: () => {
        const payload = exactCommitRangeProbePayload();
        payload.commits.at(-1).sha = "d".repeat(40);
        return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
      },
      relation: "resolved_base_head_or_merge_base_mismatch",
    },
    {
      name: "diverged-history",
      result: () => ({
        status: 0,
        stdout: JSON.stringify(exactCommitRangeProbePayload({
          status: "diverged",
          behind_by: 1,
        })),
        stderr: "",
      }),
      relation: "resolved_commit_relation_diverged_or_truncated",
    },
    {
      name: "truncated-commit-list",
      result: () => ({
        status: 0,
        stdout: JSON.stringify(exactCommitRangeProbePayload({
          ahead_by: 3,
          total_commits: 3,
        })),
        stderr: "",
      }),
      relation: "resolved_commit_relation_diverged_or_truncated",
    },
    {
      name: "file-mismatch",
      result: () => ({
        status: 0,
        stdout: JSON.stringify(exactCommitRangeProbePayload({
          files: [{ filename: "unexpected-secret-path.txt" }],
        })),
        stderr: "",
      }),
      relation: "resolved_changed_files_mismatch_or_overflow",
    },
    {
      name: "probe-denied",
      result: () => ({
        status: 1,
        stdout: "SENSITIVE_DENIAL_OUTPUT",
        stderr: "SENSITIVE_DENIAL_REASON",
      }),
      relation: "probe_execution_failed_or_output_overflow",
    },
    {
      name: "probe-output-overflow",
      result: () => ({
        status: 0,
        stdout: "SENSITIVE_OVERFLOW".repeat(140_000),
        stderr: "",
      }),
      relation: "probe_execution_failed_or_output_overflow",
    },
  ];

  withTempDir("second-review-runner-range-failure-matrix-", (dir) => {
    const { context } = renderHandoff(dir, liveCommitRangeHandoff);
    const reviewData = parseCanonicalSecondReviewPacketData(readFileSync(context.packet_path));

    for (const testCase of cases) {
      rmSync(context.review_scope_probe_result_path, { force: true });
      const result = runReviewScopeProbe(context, reviewData, {
        spawnSync: testCase.result,
      });

      assert.equal(result.status, "blocked", testCase.name);
      assert.equal(result.classification, "review_material_scope_unresolvable", testCase.name);
      assert.equal(result.failure_relation, testCase.relation, testCase.name);
      const persisted = readFileSync(context.review_scope_probe_result_path, "utf8");
      assert.doesNotMatch(persisted, /SENSITIVE_|unexpected-secret-path/, testCase.name);
      assert.ok(Buffer.byteLength(persisted, "utf8") < 2_048, testCase.name);
    }
  });
});

test("issue 1717: recovery rerenders canonical scope state instead of reusing predecessor evidence", async () => {
  await withTempDirAsync("second-review-runner-range-recovery-", async (dir) => {
    const predecessorDir = path.join(dir, "predecessor");
    const embeddedDir = path.join(dir, "embedded-successor");
    const staleDir = path.join(dir, "stale-successor");
    mkdirSync(predecessorDir, { recursive: true });
    mkdirSync(embeddedDir, { recursive: true });
    mkdirSync(staleDir, { recursive: true });

    const predecessor = renderHandoff(predecessorDir, liveCommitRangeHandoff);
    assert.ok(predecessor.context.review_scope_read_recipe);
    assert.ok(predecessor.context.review_scope_probe_result_path);

    const embedded = renderHandoff(embeddedDir, prStickyHandoff);
    assert.equal(Object.hasOwn(embedded.context, "review_scope_read_recipe"), false);
    assert.equal(Object.hasOwn(embedded.context, "review_scope_probe_result_path"), false);
    let embeddedScopeProbeCalls = 0;
    let embeddedReviewerProbeCalls = 0;
    const embeddedResult = await runProjection(embedded.contextPath, {
      executableDiscoveryOptions: trustedReviewerExecutableDiscoveryOptions,
      stickyDispositionOptions: verifiedEmptyStickyDispositionOptions,
      scopeProbeOptions: {
        spawnSync() {
          embeddedScopeProbeCalls += 1;
          throw new Error("fresh embedded material must not run a live scope probe");
        },
      },
      probeOptions: {
        runCommand(command) {
          embeddedReviewerProbeCalls += 1;
          return {
            command,
            args: [],
            status: 1,
            signal: null,
            error: null,
            error_code: null,
            stdout: "",
            stderr: "reviewer unavailable after embedded recovery",
          };
        },
      },
    });
    assert.equal(embeddedScopeProbeCalls, 0);
    assert.ok(embeddedReviewerProbeCalls > 0);
    assert.equal(embeddedResult.classification, "probe_evidence_unavailable");

    const stale = renderHandoff(staleDir, prStickyHandoff);
    stale.context.review_scope_read_recipe = predecessor.context.review_scope_read_recipe;
    stale.context.review_scope_probe_result_path = predecessor.context.review_scope_probe_result_path;
    writeFileSync(stale.contextPath, JSON.stringify(stale.context), "utf8");
    let staleScopeProbeCalls = 0;
    let staleReviewerProbeCalls = 0;
    const staleResult = await runProjection(stale.contextPath, {
      scopeProbeOptions: {
        spawnSync() {
          staleScopeProbeCalls += 1;
          throw new Error("stale predecessor scope evidence must fail before probing");
        },
      },
      probeOptions: {
        runCommand() {
          staleReviewerProbeCalls += 1;
          throw new Error("stale predecessor scope evidence must fail before reviewer probing");
        },
      },
    });
    assert.equal(staleResult.classification, "reviewer_dispatch_identity_collision");
    assert.equal(staleScopeProbeCalls, 0);
    assert.equal(staleReviewerProbeCalls, 0);
    assert.equal(existsSync(`${stale.contextPath}.attempt.lock`), false);
  });
});

test("issue 1717: verified exact scope cannot let fresh PASS or WARN override typed denial", () => {
  for (const verdict of ["PASS", "WARN"]) {
    withTempDir(`second-review-runner-range-denial-${verdict.toLowerCase()}-`, (dir) => {
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFakeClaude(binDir);
      writeFakeGh(binDir);
      const ghLog = path.join(dir, "gh.log");
      const evidenceEnv = {
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(dir, "control-evidence"),
      };
      const { context } = renderHandoff(dir, liveCommitRangeHandoff, evidenceEnv);
      const denialSentinel = `SENSITIVE_RANGE_DENIAL_${verdict}_DO_NOT_PERSIST`;
      const result = runGeneratedRunnerCommand(context, binDir, {
        ...evidenceEnv,
        DEVPRO_FAKE_GH_LOG: ghLog,
        DEVPRO_FAKE_GH_COMPARE_RESPONSE: JSON.stringify(exactCommitRangeProbePayload()),
        DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponse(verdict, context.dispatch_id),
        DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
        DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          uuid: `result-range-denial-${verdict.toLowerCase()}`,
          session_id: `session-range-denial-${verdict.toLowerCase()}`,
          permission_denials: [{
            tool_name: "Bash",
            tool_use_id: `toolu-range-denial-${verdict.toLowerCase()}`,
            tool_input: { command: denialSentinel },
          }],
          result: JSON.stringify({
            sticky_comment_url: "https://example.test/sticky/1",
            verdict,
            last_reviewed_sha: prStickyHeadSha,
            reviewer_model: "claude-test",
            reason: "A fresh completion must remain subordinate to typed denial evidence.",
          }),
        }),
      });

      assert.equal(result.status, 1, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.classification, "reviewer_orchestration_permission_denied");
      assert.match(result.stdout, /"evidence_provenance":"provider_typed_event"/);
      assert.doesNotMatch(result.stdout, new RegExp(denialSentinel));

      const scopeEvidence = readFileSync(context.review_scope_probe_result_path, "utf8");
      const scopeResult = JSON.parse(scopeEvidence);
      assert.equal(scopeResult.status, "verified");
      assert.equal(scopeResult.classification, "review_material_scope_resolved");
      assert.doesNotMatch(scopeEvidence, /SENSITIVE_RAW_COMMIT_MESSAGE/);

      const ghCommands = readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean);
      assert.ok(ghCommands.includes(
        `api repos/{owner}/{repo}/compare/${commitRangeBaseSha}...${prStickyHeadSha}`
      ));
      assert.ok(ghCommands.some((line) => line.startsWith("pr view 1658 ")));
      assert.equal(ghCommands.some((line) => line.startsWith("pr comment ")), false);
      const dispatchEvidenceDir = path.join(context.control_evidence_root, context.dispatch_id);
      assert.equal(existsSync(path.join(dispatchEvidenceDir, "invocation-claim.json")), true);
      assert.equal(existsSync(path.join(dispatchEvidenceDir, "completion.json")), false);
    });
  }
});

// Parallel reviewer_home cases mutate process.env (CODEX_HOME, timeouts, fake
// flags). Snapshot+scrub so a generated-runner child never inherits a sibling's
// ambient Codex home or DEVPRO_FAKE_* unless the caller opts in via extraEnv.
function buildGeneratedRunnerEnv(context, binDir, extraEnv = {}, wrongCwd, baseEnv = process.env) {
  const env = { ...baseEnv };
  const pathKey = Object.keys(baseEnv).find((key) => key.toLowerCase() === "path");
  const inheritedPath = pathKey === undefined ? "" : baseEnv[pathKey];
  if (!Object.hasOwn(extraEnv, "CODEX_HOME")) {
    delete env.CODEX_HOME;
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("DEVPRO_FAKE_") && !Object.hasOwn(extraEnv, key)) {
      delete env[key];
    }
  }
  const explicitEnv = { ...extraEnv };
  if (process.platform === "win32" && Object.hasOwn(extraEnv, "NODE_OPTIONS")) {
    explicitEnv.NODE_OPTIONS = portableCommandShims.appendPreload(
      extraEnv.NODE_OPTIONS,
      repoPath(".devpro/scripts/tests/lib/portable-command-shims.cjs"),
    );
  }
  return {
    ...env,
    PATH: `${binDir}${path.delimiter}${inheritedPath ?? ""}`,
    SHELL: "/bin/sh",
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
    DEVPRO_SECOND_REVIEW_RUNNER_HEARTBEAT_MS: "50",
    DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "5000",
    DEVPRO_SECOND_REVIEW_RUNNER_TERMINATION_GRACE_MS: "50",
    DEVPRO_SECOND_REVIEW_RUNNER_FORCE_SETTLE_MS: "100",
    DEVPRO_FAKE_GH_API_RESPONSE: emptyStickyAuthorityApiResponse,
    DEVPRO_FAKE_GH_API_COUNT_FILE: path.join(wrongCwd, "fake-gh-api-count"),
    ...derivedPostWriteGhEnv(extraEnv),
    ...explicitEnv,
  };
}

function assertFixtureCodexHome(dir, codexHome) {
  const resolved = path.resolve(codexHome);
  assert.ok(
    resolved === path.resolve(dir) || resolved.startsWith(`${path.resolve(dir)}${path.sep}`),
    `CODEX_HOME must stay under the case temp dir, got ${resolved}`,
  );
  assert.notEqual(resolved, path.join(homedir(), ".codex"));
}

function createWindowsReviewerExecutableMarkers(binDir) {
  if (process.platform !== "win32") return [];
  const markers = [];
  for (const tool of ["claude", "codex", "opencode"]) {
    const scriptPath = path.join(binDir, tool);
    const markerPath = `${scriptPath}.exe`;
    if (existsSync(scriptPath) && !existsSync(markerPath)) {
      // The production resolver correctly requires a native PATHEXT entry. The
      // test-only spawn shim maps this marker back to the adjacent POSIX fixture
      // before execution, so no non-native executable is run on Windows.
      writeFileSync(markerPath, "DevPro Windows test resolver marker\n", "utf8");
      markers.push(markerPath);
    }
  }
  return markers;
}

function removeWindowsReviewerExecutableMarkers(markers) {
  for (const markerPath of markers) rmSync(markerPath, { force: true });
}

function runGeneratedRunnerCommand(context, binDir, extraEnv = {}, options = {}) {
  const wrongCwd = makeTempDir("second-review-runner-wrong-cwd-");
  const markers = createWindowsReviewerExecutableMarkers(binDir);
  try {
    return spawnSync(context.projection_runner_command.executable, context.projection_runner_command.argv, {
      cwd: wrongCwd,
      encoding: "utf8",
      env: buildGeneratedRunnerEnv(context, binDir, extraEnv, wrongCwd),
      ...options,
    });
  } finally {
    removeWindowsReviewerExecutableMarkers(markers);
    rmSync(wrongCwd, { recursive: true, force: true });
  }
}

function runGeneratedRunnerCommandAsync(context, binDir, extraEnv = {}) {
  const wrongCwd = makeTempDir("second-review-runner-wrong-cwd-");
  const markers = createWindowsReviewerExecutableMarkers(binDir);
  return new Promise((resolve) => {
    const child = spawn(context.projection_runner_command.executable, context.projection_runner_command.argv, {
      cwd: wrongCwd,
      env: buildGeneratedRunnerEnv(context, binDir, extraEnv, wrongCwd),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      removeWindowsReviewerExecutableMarkers(markers);
      rmSync(wrongCwd, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
    child.on("error", (error) => {
      removeWindowsReviewerExecutableMarkers(markers);
      rmSync(wrongCwd, { recursive: true, force: true });
      resolve({ status: null, stdout, stderr: `${stderr}${error.message}` });
    });
  });
}

const sharedAuditRunnerFixtures = new Map();

function sharedAuditRunnerFixtureForHandoff(
  handoff = auditHandoff,
  fixtureKey = "default"
) {
  const existing = sharedAuditRunnerFixtures.get(fixtureKey);
  if (existing !== undefined) return existing;
  const dir = mkdtempSync(path.join(tmpdir(), `second-review-runner-audit-shared-${fixtureKey}-`));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeClaude(binDir);
  const { carrierDir, context, evidenceRoot } = renderHandoff(dir, handoff);
  const carrierSnapshot = path.join(dir, "initial-carrier");
  const evidenceSnapshot = path.join(dir, "initial-control-evidence");
  cpSync(carrierDir, carrierSnapshot, { recursive: true, preserveTimestamps: true });
  if (existsSync(evidenceRoot)) {
    cpSync(evidenceRoot, evidenceSnapshot, { recursive: true, preserveTimestamps: true });
  }
  const fixture = {
    binDir,
    carrierDir,
    carrierSnapshot,
    context,
    dir,
    evidenceRoot,
    evidenceSnapshot,
    uses: 0,
  };
  process.once("exit", () => cleanupFixtureDir(dir));
  sharedAuditRunnerFixtures.set(fixtureKey, fixture);
  return fixture;
}

function withSharedAuditRunnerFixture(run, options = {}) {
  const fixture = sharedAuditRunnerFixtureForHandoff(
    options.handoff ?? auditHandoff,
    options.fixtureKey ?? "default"
  );
  if (fixture.uses > 0) {
    rmSync(fixture.carrierDir, { recursive: true, force: true });
    cpSync(fixture.carrierSnapshot, fixture.carrierDir, {
      recursive: true,
      preserveTimestamps: true,
    });
    rmSync(fixture.evidenceRoot, { recursive: true, force: true });
    if (existsSync(fixture.evidenceSnapshot)) {
      cpSync(fixture.evidenceSnapshot, fixture.evidenceRoot, {
        recursive: true,
        preserveTimestamps: true,
      });
    }
  }
  fixture.uses += 1;
  return run(fixture);
}

function activityEvents(activityPath) {
  return readFileSync(activityPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).event);
}

function terminalReceiptForContext(context) {
  const receiptPath = path.join(
    context.control_evidence_root,
    context.dispatch_id,
    "terminal-receipt.json"
  );
  return existsSync(receiptPath)
    ? { path: receiptPath, record: JSON.parse(readFileSync(receiptPath, "utf8")) }
    : null;
}

function completionReceiptForContext(context) {
  const receiptPath = path.join(
    context.control_evidence_root,
    context.dispatch_id,
    "completion-receipt.json"
  );
  return existsSync(receiptPath)
    ? { path: receiptPath, record: JSON.parse(readFileSync(receiptPath, "utf8")) }
    : null;
}

// T13 (design.md D12; tasks.md item 12).
function reviewerModelRecordForContext(context) {
  const recordPath = path.join(
    context.control_evidence_root,
    context.dispatch_id,
    "reviewer-model-record.json"
  );
  return existsSync(recordPath)
    ? { path: recordPath, record: JSON.parse(readFileSync(recordPath, "utf8")) }
    : null;
}

function assertPostSpawnTerminalReceipt(context, terminal, classification) {
  assert.equal(terminal?.record.schema, "devpro-second-review-closed-terminal/v1");
  assert.equal(terminal?.record.classification, classification);
  assert.equal(terminal?.record.responsibility, "reviewer_invocation_lifecycle");
  assert.equal(terminal?.record.process_spawned, true);
  assert.equal(terminal?.record.lifecycle_phase, "post_close_transport_cleaned");
  assert.equal(terminal?.record.process_close_observed, true);
  assert.equal(terminal?.record.transport_cleanup_confirmed, true);
  const claimPath = path.join(
    context.control_evidence_root,
    context.dispatch_id,
    "invocation-claim.json"
  );
  assert.equal(
    terminal?.record.invocation_claim_sha256,
    createHash("sha256").update(readFileSync(claimPath)).digest("hex")
  );
}

function deepValuesForKey(value, wantedKey, matches = []) {
  if (!value || typeof value !== "object") return matches;
  if (Array.isArray(value)) {
    for (const item of value) deepValuesForKey(item, wantedKey, matches);
    return matches;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === wantedKey) matches.push(child);
    deepValuesForKey(child, wantedKey, matches);
  }
  return matches;
}

function currentHeadStickyResponse(
  verdict = "PASS",
  dispatchId = null,
  reviewerTool = "Claude Code",
  reviewerModel = "claude-test",
  assessmentRequired = true
) {
  assert.notEqual(dispatchId, null, "canonical producer-derived sticky fixture requires a dispatch id");
  const prefix = secondReviewPacketStaticPrefix(reviewerTool, "pr-sticky", dispatchId);
  const lines = prefix.trimEnd().split("\n");
  const markerIndex = lines.indexOf("<!-- cross-model-second-opinion:sticky -->");
  const footerIndex = lines.findIndex(
    (line, index) => index > markerIndex && line.startsWith(`Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: ${reviewerTool} · Model:`)
  );
  assert.notEqual(markerIndex, -1, "canonical packet producer must expose the sticky marker");
  assert.notEqual(footerIndex, -1, "canonical packet producer must expose one bare provenance footer");
  let body = lines.slice(markerIndex, footerIndex + 1).join("\n")
    .replace("<actual-verdict>", verdict)
    .replace("<actual-head-ref-oid>", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    .replace("<current-dispatch-id>", dispatchId)
    .replace("<actual-bounded-reason>", "Bounded review reached a current-head gate verdict.")
    .replace("<actual-model>", reviewerModel);
  if (assessmentRequired && ["PASS", "WARN"].includes(verdict)) {
    const report = { schema: "devpro.review-guarantee-assessment/v1", reviewed_target: prStickyHeadSha, dispatch_id: dispatchId, assessments: [] };
    body = body.replace("\nRules:", "\n## Guarantee Assessment\n```json\n" + JSON.stringify(report) + "\n```\nRules:");
  }
  return currentHeadStickyResponseWithBody(body);
}

function currentHeadStickyResponseWithBody(body) {
  const comment = {
    id: 4242,
    node_id: "IC_kwDOExample4242",
    html_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242",
    url: "https://github.com/devpro/example/pull/1658#issuecomment-4242",
    body,
    updated_at: "2026-07-20T03:04:05Z",
  };
  return JSON.stringify({
    comments: [comment],
    headRefOid: prStickyHeadSha,
    completeness: {
      status: "complete",
      pagination_exhausted: true,
      pages_fetched: 1,
    },
    query_error: null,
  });
}

function reviewerCliResultForClassification(code = 0) {
  return {
    code,
    signal: null,
    timed_out: false,
    spawn_error: null,
  };
}

function boundedEvidenceForClassification({
  stdoutText = "",
  stderrText = "",
  stdoutStructuredEvents = [],
  stderrStructuredEvents = [],
  terminal = null,
} = {}) {
  const stdout = __testReviewerClassification.partitionBoundedEvidence(
    stdoutText,
    { collectStructured: true }
  );
  const stderr = __testReviewerClassification.partitionBoundedEvidence(
    stderrText,
    { collectStructured: true }
  );
  const mergedStdoutStructuredEvents = [
    ...stdoutStructuredEvents,
    ...stdout.structuredEvents,
  ];
  const mergedStderrStructuredEvents = [
    ...stderrStructuredEvents,
    ...stderr.structuredEvents,
  ];
  return {
    structuredEvents: [
      ...mergedStdoutStructuredEvents,
      ...mergedStderrStructuredEvents,
    ],
    stdoutStructuredEvents: mergedStdoutStructuredEvents,
    terminal,
    unstructuredText: stdout.unstructuredLines.join("\n"),
    stderrText: stderr.unstructuredLines.join("\n"),
    unmatchedCandidateText: [
      stdout.unmatchedCandidateLines.join("\n"),
      stderr.unmatchedCandidateLines.join("\n"),
    ].filter(Boolean).join("\n"),
  };
}

function classifyReviewerCliForTest(context, evidence, code = 0) {
  return __testReviewerClassification.classifyCliExit(
    context,
    reviewerCliResultForClassification(code),
    evidence
  );
}

function claudeClassificationContext(overrides = {}) {
  return {
    mode: "audit-only",
    head_ref_oid: "none",
    reviewer_cli_recipe: { tool: "claude" },
    ...overrides,
  };
}

function classifyReviewerCliEventsForTest(
  context,
  {
    stdoutStructuredEvents = [],
    stderrStructuredEvents = [],
    terminal,
    stdoutText = "",
    stderrText = "",
    code = 0,
  } = {}
) {
  const structuredEvents = [
    ...stdoutStructuredEvents,
    ...stderrStructuredEvents,
  ];
  const resolvedTerminal = terminal === undefined
    ? stdoutStructuredEvents.findLast((event) => event?.type === "result" || event?.type === "error") ?? null
    : terminal;
  return classifyReviewerCliForTest(
    context,
    boundedEvidenceForClassification({
      stdoutStructuredEvents,
      stderrStructuredEvents,
      terminal: resolvedTerminal,
      stdoutText,
      stderrText,
    }),
    code
  );
}

function assertProcessGoneEventually(pid, { timeoutMs = 500, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("run-second-reviewer-projection queries current-head sticky before hard-cap SIGTERM", () => {
  withTempDir("second-review-runner-hard-cap-order-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      DEVPRO_FAKE_REVIEWER_BUSY_UNTIL_SIGNAL: "1",
      DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "1000",
    }, { timeout: 8000 });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_cli_timeout");
    assert.equal(output.cli_exit.signal, "SIGTERM");
    const terminal = terminalReceiptForContext(context);
    assertPostSpawnTerminalReceipt(context, terminal, "reviewer_cli_timeout");
    assert.equal(output.cli_exit.process_spawned, true);
    assert.equal(output.cli_exit.transport_cleanup_confirmed, true);
    const termination = output.cli_exit.hard_cap_termination;
    if (process.platform === "win32") {
      assert.deepEqual(termination, {
        status: "reviewer_transport_sigterm_requested",
        attempted: true,
        accepted: true,
        signal: "SIGTERM",
        child_open_before: true,
        process_group: false,
      });
    } else {
      // The SIGKILL escalation targets a process group whose leader has
      // already been asked to exit via the earlier group SIGTERM. Whether
      // that escalation observes the group as already-reaped (ESRCH ->
      // "process_group_gone") or still holding a not-yet-reaped member that
      // SIGKILL is delivered to as a no-op ("sigkill_requested") is a kernel
      // scheduling race, not a behavioral difference: both are equally valid
      // evidence that hard-cap enforcement escalated correctly and the
      // transport converged. Pinning one exact outcome here previously
      // produced a disclosed intermittent failure under full-suite process
      // pressure (see qa-test-scope.md Baseline); reproduced deterministically
      // by shrinking DEVPRO_SECOND_REVIEW_RUNNER_TERMINATION_GRACE_MS under
      // synthetic CPU/fork-churn load, including at the shipped 50ms default.
      assert.equal(termination.attempted, true, JSON.stringify(termination));
      assert.equal(termination.signal, "SIGKILL", JSON.stringify(termination));
      assert.equal(termination.process_group, true, JSON.stringify(termination));
      assert.equal(termination.child_open_before, false, JSON.stringify(termination));
      assert.ok(
        termination.status === "reviewer_transport_process_group_gone"
          || termination.status === "reviewer_transport_sigkill_requested",
        `unexpected hard-cap SIGKILL escalation status: ${JSON.stringify(termination)}`
      );
      assert.equal(
        termination.accepted,
        termination.status === "reviewer_transport_sigkill_requested",
        JSON.stringify(termination)
      );
    }
    const events = activityEvents(context.activity_log_path);
    assert.ok(events.indexOf("projection_sticky_verification_failed") < events.indexOf("projection_cli_timeout"));
    assert.ok(events.indexOf("projection_cli_timeout") < events.indexOf("projection_cli_exited"));
  });
});

test("run-second-reviewer-projection escalates a stubborn child process group to SIGKILL and settles", {
  skip: process.platform === "win32",
}, () => {
  withTempDir("second-review-runner-hard-cap-stubborn-tree-", (dir) => {
    const binDir = path.join(dir, "bin");
    const descendantPidPath = path.join(dir, "descendant.pid");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["StructuredOutput"]',
      DEVPRO_FAKE_REVIEWER_STUBBORN_DESCENDANT_PID_LOG: descendantPidPath,
      // Preserve enough startup budget for the fake reviewer to create its
      // descendant under full-suite process pressure. The outer timeout below
      // remains the independent fail-safe for a non-settling implementation.
      // 3000 ms: the cap starts at spawn, before two node cold starts finish (2026-10-28 sweep).
      DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "3000",
    }, { timeout: 15000 });

    assert.notEqual(
      result.signal,
      "SIGTERM",
      "the generated command must settle before the test safety timeout",
    );
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_cli_timeout");
    assert.equal(output.cli_exit.hard_cap_termination.signal, "SIGKILL");
    assert.equal(output.cli_exit.hard_cap_termination.process_group, true);
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8").trim());
    assertProcessGoneEventually(descendantPid);
  });
});

test("run-second-reviewer-projection kills the saved process group after its leader exits", {
  skip: process.platform === "win32",
}, () => {
  withTempDir("second-review-runner-hard-cap-exited-leader-", (dir) => {
    const binDir = path.join(dir, "bin");
    const descendantPidPath = path.join(dir, "descendant.pid");
    const signalLogPath = path.join(dir, "signal.log");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    let descendantPid = null;

    try {
      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["StructuredOutput"]',
        DEVPRO_FAKE_REVIEWER_PRE_INIT_STUBBORN_DESCENDANT_PID_LOG: descendantPidPath,
        DEVPRO_FAKE_REVIEWER_SIGNAL_LOG: signalLogPath,
        DEVPRO_FAKE_REVIEWER_BUSY_UNTIL_SIGNAL: "1",
        DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "3000",
      }, { timeout: 15000 });

      if (existsSync(descendantPidPath)) {
        descendantPid = Number(readFileSync(descendantPidPath, "utf8").trim());
      }
      assert.notEqual(
        result.signal,
        "SIGTERM",
        "the generated command must settle before the test safety timeout",
      );
      assert.equal(result.status, 1, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.classification, "reviewer_cli_timeout");
      assert.equal(output.cli_exit.hard_cap_termination.signal, "SIGKILL");
      assert.equal(output.cli_exit.hard_cap_termination.process_group, true);
      assert.equal(Number.isInteger(descendantPid), true);
      assert.match(readFileSync(signalLogPath, "utf8"), /reviewer-sigterm/);
      assertProcessGoneEventually(descendantPid);
    } finally {
      if (Number.isInteger(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
    }
  });
});

test("run-second-reviewer-projection settles via forceSettle when a detached grandchild outlives its leader and holds the reviewer transport open", {
  skip: process.platform === "win32",
}, () => {
  withTempDir("second-review-runner-hard-cap-detached-grandchild-", (dir) => {
    const binDir = path.join(dir, "bin");
    const descendantPidPath = path.join(dir, "descendant.pid");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    let descendantPid = null;

    try {
      // The generated command itself MUST be bounded even if the fix under
      // test regresses: without it, a reverted process.exit() would hang
      // this spawnSync call (and the whole suite) rather than surfacing as
      // a single failing test.
      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["StructuredOutput"]',
        DEVPRO_FAKE_REVIEWER_EXIT_WITH_STUBBORN_DESCENDANT_PID_LOG: descendantPidPath,
        // Leave enough fixture-startup budget for the fake reviewer to spawn
        // its detached descendant, wait for the descendant's ready-file, and
        // let the group leader exit on its own. The 80 ms value previously
        // raced that setup under full-suite process pressure and sometimes
        // exercised ordinary leader termination instead of forceSettle for a
        // transport already held open by the escaped descendant.
        DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "2500",
      }, { timeout: 15000 });

      if (existsSync(descendantPidPath)) {
        descendantPid = Number(readFileSync(descendantPidPath, "utf8").trim());
      }

      // The hard cap starts at child spawn, after CLI/auth preflight.
      // Keep the same 3-second lifecycle ceiling and the 15-second outer hang guard.
      const activity = readFileSync(context.activity_log_path, "utf8")
        .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      const started = activity.find((row) => row.event === "projection_cli_started");
      const exited = activity.find((row) => row.event === "projection_cli_exited");
      assert.ok(started && exited, "runner lifecycle boundaries must be recorded");
      const lifecycleMs = Date.parse(exited.generated_at) - Date.parse(started.generated_at);
      assert.ok(
        Number.isFinite(lifecycleMs) && lifecycleMs >= 0 && lifecycleMs < 3000,
        "runner must force-settle the child lifecycle within 3 seconds, excluding preflight"
      );
      assert.notEqual(
        result.signal,
        "SIGTERM",
        "the generated command must not have been killed by the test's own safety timeout"
      );
      assert.equal(result.status, 1, result.stderr);

      const output = JSON.parse(result.stdout);
      assert.equal(output.classification, "reviewer_cli_timeout");
      // The leader process exits cleanly on its own (not via the hard-cap
      // SIGTERM/SIGKILL escalation), but its detached, stdio-inherited
      // grandchild has already escaped into its own process group and keeps
      // the reviewer transport's stdout/stderr pipes open forever, so
      // `close` never fires. This is the first assertion in the suite of
      // process_close_observed: false, proving the forceSettle path is not
      // merely present but actually reachable and exercised.
      assert.equal(output.cli_exit.process_close_observed, false);
      assert.equal(
        terminalReceiptForContext(context),
        null,
        "force-settled transport without observed close must never publish terminal lifecycle evidence"
      );
      assert.equal(Number.isInteger(descendantPid), true);
    } finally {
      // The detached grandchild is its own process-group leader (it escaped
      // the reviewer's group via setsid) and has itself forked a further
      // `sleep` child in that same new group; killing only descendantPid
      // would leave that grandchild's own child running, so the whole
      // group must be signaled.
      if (Number.isInteger(descendantPid)) {
        try {
          process.kill(-descendantPid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
    }
  });
});

test("run-second-reviewer-projection accepts packet-producer-derived current-head PASS or WARN sticky", () => {
  for (const verdict of ["PASS", "WARN"]) {
    withTempDir(`second-review-runner-hard-cap-${verdict.toLowerCase()}-`, (dir) => {
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFakeClaude(binDir);
      writeFakeGh(binDir);
      const { context } = renderHandoff(dir, prStickyHandoff);

      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
        // The semantic relation is "init first, then hard-cap". Give the
        // fixture enough scheduling room under file-level suite concurrency.
        DEVPRO_FAKE_REVIEWER_HOLD_AFTER_INIT_MS: "2000",
        DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponse(verdict, context.dispatch_id),
        DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "1000",
      });

      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "finished");
      assert.equal(output.classification, "sticky_verified");
      assert.notEqual(output.classification, "reviewer_cli_timeout");
      assert.equal(output.sticky.status, "verified");
      assert.equal(output.sticky.verdict, verdict);
      assert.equal(output.cli_exit.timed_out, true, "transport/finalization fault remains observable");
      assert.equal(output.cli_exit.process_close_observed, true);
      const completion = JSON.parse(readFileSync(
        path.join(context.control_evidence_root, context.dispatch_id, "completion-receipt.json"),
        "utf8"
      ));
      assert.equal(completion.schema, "devpro-second-review-completion/v2");
      assert.equal(completion.sticky_verdict, verdict);
      assert.equal(completion.sticky_dispatch_id, context.dispatch_id);
      assert.equal(completion.sticky_comment_id, 4242);
      assert.equal(
        completion.sticky_comment_url,
        "https://github.com/devpro/example/pull/1658#issuecomment-4242"
      );
      assert.equal(completion.process_close_observed, true);
    });
  }
});

test("run-second-reviewer-projection rejects multiple current-head sticky authorities", () => {
  withTempDir("second-review-runner-duplicate-sticky-authority-", (dir) => {
    const binDir = path.join(dir, "bin");
    const ghLog = path.join(dir, "gh.log");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const response = JSON.parse(currentHeadStickyResponse("PASS", context.dispatch_id));
    response.comments.push({
      ...response.comments[0],
      id: 4243,
      node_id: "IC_kwDOExample4243",
      html_url: "https://github.com/devpro/example/pull/1658#issuecomment-4243",
      url: "https://github.com/devpro/example/pull/1658#issuecomment-4243",
    });

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      DEVPRO_FAKE_GH_RESPONSE: JSON.stringify(response),
      DEVPRO_FAKE_GH_LOG: ghLog,
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242",
          verdict: "PASS",
          last_reviewed_sha: context.head_ref_oid,
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        }),
      }),
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "sticky_authority_ambiguous");
    assert.equal(output.sticky.status, "failed");
    assert.equal(output.sticky.classification, "sticky_authority_ambiguous");
    assert.equal(output.sticky.authority_candidate_count, 2);
    const ghCalls = readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(
      ghCalls.some((line) =>
        /(?:^|\s)-(?:X|f)\s+(?:POST|PATCH|DELETE)\b|--method\s+(?:POST|PATCH|DELETE)\b/.test(line)
      ),
      false,
      "post-spawn duplicate detection must not perform compensating comment mutation"
    );
  });
});

test("RED-5 post-write verification binds create completion URL to the sole REST sticky authority", () => {
  withTempDir("second-review-runner-create-completion-identity-", (dir) => {
    const binDir = path.join(dir, "bin");
    const ghLog = path.join(dir, "gh.log");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const postWriteResponse = currentHeadStickyResponse("PASS", context.dispatch_id);
    const exactComment = JSON.parse(postWriteResponse).comments[0];

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_GH_LOG: ghLog,
      DEVPRO_FAKE_GH_RESPONSE: postWriteResponse,
      DEVPRO_FAKE_GH_POST_API_RESPONSE: postWriteResponse,
      DEVPRO_FAKE_GH_EXACT_COMMENT_RESPONSE: JSON.stringify(exactComment),
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          sticky_comment_url:
            "https://github.com/devpro/example/pull/1658#issuecomment-4243",
          verdict: "PASS",
          last_reviewed_sha: context.head_ref_oid,
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        }),
      }),
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "sticky_completion_identity_mismatch");
    const ghCalls = readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(
      ghCalls.some((call) => call.startsWith("api repos/devpro/example/issues/comments/4242")),
      "post-write verification must perform an exact REST comment readback"
    );
  });
});

function priorStickyBodyForRunnerDisposition() {
  return [
    "<!-- cross-model-second-opinion:sticky -->",
    "verdict: PASS",
    "last_reviewed_sha: abc1234",
    "dispatch_id: prior-dispatch-for-runner-disposition",
    "reason: Prior bounded review completed.",
    `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
  ].join("\n");
}

function runnerStickyRestComment(commentId, overrides = {}) {
  return {
    id: commentId,
    node_id: `IC_kwDOExample${commentId}`,
    html_url:
      `https://github.com/devpro/example/pull/1658#issuecomment-${commentId}`,
    url: `https://github.com/devpro/example/pull/1658#issuecomment-${commentId}`,
    body: priorStickyBodyForRunnerDisposition(),
    updated_at: "2026-07-20T03:04:05Z",
    ...overrides,
  };
}

function runnerStickySnapshot(comments) {
  return {
    repository_slug: "devpro/example",
    pr_number: 1658,
    completeness: {
      status: "complete",
      pagination_exhausted: true,
      pages_fetched: 1,
    },
    query_error: null,
    comments,
  };
}

test("RED-4 duplicate authority blocks before probe, invocation claim, reviewer spawn, or PR write", () => {
  withTempDir("second-review-runner-pre-spawn-duplicate-authority-", (dir) => {
    const binDir = path.join(dir, "bin");
    const reviewerProbeLog = path.join(dir, "reviewer-probe.log");
    const authPreflightLog = path.join(dir, "auth-preflight.log");
    const reviewerInvocationLog = path.join(dir, "reviewer-invocation.log");
    const ghLog = path.join(dir, "gh.log");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);

    const renderedHandoff = {
      ...prStickyHandoff,
      sticky_authority_snapshot: runnerStickySnapshot([
        runnerStickyRestComment(4242),
      ]),
      // R5 minimality: the READY sticky above establishes a reviewed baseline,
      // so a full-pr re-render must carry an explicit full_scope_reason.
      full_scope_reason: "RED-4 fixture re-renders full-pr over a READY sticky baseline",
    };
    const { context } = renderHandoff(dir, renderedHandoff);
    const liveResponse = JSON.stringify({
      comments: [
        runnerStickyRestComment(4242),
        runnerStickyRestComment(4243, { updated_at: "2026-07-20T03:04:06Z" }),
      ],
      headRefOid: context.head_ref_oid,
      completeness: {
        status: "complete",
        pagination_exhausted: true,
        pages_fetched: 1,
      },
    });

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_GH_API_RESPONSE: liveResponse,
      DEVPRO_FAKE_GH_RESPONSE: liveResponse,
      DEVPRO_FAKE_GH_LOG: ghLog,
      DEVPRO_FAKE_REVIEWER_ARGS_LOG: reviewerProbeLog,
      DEVPRO_FAKE_AUTH_PREFLIGHT_LOG: authPreflightLog,
      DEVPRO_FAKE_REVIEWER_INVOCATION_LOG: reviewerInvocationLog,
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
    });

    assert.equal(
      existsSync(reviewerProbeLog),
      false,
      "RED-4 authority revalidation must happen before reviewer capability probing"
    );
    assert.equal(
      existsSync(authPreflightLog),
      false,
      "RED-4 authority revalidation must happen before reviewer auth probing"
    );
    assert.equal(
      existsSync(reviewerInvocationLog),
      false,
      "RED-4 blocked disposition must not spawn the reviewer"
    );
    assert.equal(
      existsSync(
        path.join(context.control_evidence_root, context.dispatch_id, "invocation-claim.json")
      ),
      false,
      "RED-4 blocked disposition must not create an invocation claim"
    );
    const ghCalls = existsSync(ghLog)
      ? readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean)
      : [];
    assert.ok(ghCalls.length >= 1, "runner must perform the bounded live authority revalidation");
    assert.equal(
      ghCalls.some((line) => /(?:^|\s)-(?:X|f)\s+(?:POST|PATCH)\b|--method\s+(?:POST|PATCH)\b/.test(line)),
      false,
      "blocked revalidation must not perform any PR-comment write"
    );
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "sticky_write_disposition_blocked");
    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal?.record.classification, "sticky_write_disposition_blocked");
    assert.equal(terminal?.record.process_spawned, false);
    assert.equal(terminal?.record.invocation_claim_sha256, null);
  });
});

test("run-second-reviewer-projection hard-cap without a fresh sticky remains timeout fail-closed", () => {
  withTempDir("second-review-runner-hard-cap-no-fresh-sticky-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      DEVPRO_FAKE_REVIEWER_HOLD_AFTER_INIT_MS: "4000",
      DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "1000",
    }, { timeout: 8000 });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "reviewer_cli_timeout");
    assert.equal(output.sticky.status, "failed");
    assert.equal(output.sticky.classification, "sticky_missing");
    assert.equal(output.cli_exit.timed_out, true);
  });
});

test("run-second-reviewer-projection verifier failures terminate and fail closed", () => {
  for (const { name, ghResponse, stickyClassification } of [
    {
      name: "null-shape",
      ghResponse: "null",
      stickyClassification: "sticky_response_shape_invalid",
    },
    {
      name: "invalid-json",
      ghResponse: "not-json",
      stickyClassification: "sticky_verification_parse_failed",
    },
  ]) {
    withTempDir(`second-review-runner-hard-cap-verifier-${name}-`, (dir) => {
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFakeClaude(binDir);
      if (process.platform === "win32") writeBlockingNodeFakeClaude(binDir);
      writeFakeGh(binDir);
      const { context } = renderHandoff(dir, prStickyHandoff);

      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
        DEVPRO_FAKE_REVIEWER_BUSY_UNTIL_SIGNAL: "1",
        DEVPRO_FAKE_REVIEWER_SIGNAL_LOG: path.join(dir, "reviewer-signal.log"),
        DEVPRO_FAKE_GH_RESPONSE: ghResponse,
        // fix-flow-gate-gaps R3: the pre-spawn live-head probe consumes the
        // FIRST head read, so the verifier's own read is the second one — drive
        // only that one into the broken shape this case pins.
        DEVPRO_FAKE_GH_HEAD_COUNT_FILE: path.join(dir, "fake-gh-head-count"),
        DEVPRO_FAKE_GH_HEAD_AFTER_FIRST_RESPONSE: ghResponse,
        DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "1000",
        DEVPRO_SECOND_REVIEW_RUNNER_TERMINATION_GRACE_MS: "100",
        DEVPRO_SECOND_REVIEW_RUNNER_FORCE_SETTLE_MS: "120",
      }, { timeout: 8000 });

      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "blocked", name);
      assert.equal(output.classification, "reviewer_cli_timeout", name);
      assert.equal(output.sticky.status, "failed", name);
      assert.equal(output.sticky.classification, stickyClassification, name);
      assert.equal(output.cli_exit.timed_out, true, name);
      const signalLog = existsSync(path.join(dir, "reviewer-signal.log"))
        ? readFileSync(path.join(dir, "reviewer-signal.log"), "utf8")
        : "";
      if (process.platform === "win32") {
        assert.equal(output.cli_exit.signal, "SIGTERM", name);
      } else {
        assert.ok(
          output.cli_exit.signal === "SIGTERM"
            || (output.cli_exit.signal === null
              && output.cli_exit.code === 143
              && signalLog.split(/\r?\n/).includes("reviewer-sigterm")),
          `${name}: ${JSON.stringify({ cli_exit: output.cli_exit, signal_log: signalLog })}`
        );
      }
      const termination = output.cli_exit.hard_cap_termination;
      if (process.platform === "win32") {
        assert.deepEqual(
          termination,
          {
            status: "reviewer_transport_sigterm_requested",
            attempted: true,
            accepted: true,
            signal: "SIGTERM",
            child_open_before: true,
            process_group: false,
          },
          `${name}: ${JSON.stringify({
            termination,
            cli_exit: output.cli_exit,
            signal_log: existsSync(path.join(dir, "reviewer-signal.log"))
              ? readFileSync(path.join(dir, "reviewer-signal.log"), "utf8")
              : null,
          })}`
        );
      } else {
        // Same kernel process-group-reap race as
        // "run-second-reviewer-projection queries current-head sticky before
        // hard-cap SIGTERM" (see that test's comment / qa-test-scope.md
        // Baseline): whether the SIGKILL escalation observes the group as
        // already-reaped ("process_group_gone") or still holding a
        // not-yet-reaped member it delivers a no-op SIGKILL to
        // ("sigkill_requested") is scheduling-dependent, not a behavioral
        // difference — assert the actual invariant instead of one exact
        // outcome.
        assert.equal(termination.attempted, true, `${name}: ${JSON.stringify(termination)}`);
        assert.equal(termination.signal, "SIGKILL", `${name}: ${JSON.stringify(termination)}`);
        assert.equal(termination.process_group, true, `${name}: ${JSON.stringify(termination)}`);
        assert.equal(termination.child_open_before, false, `${name}: ${JSON.stringify(termination)}`);
        assert.ok(
          termination.status === "reviewer_transport_process_group_gone"
            || termination.status === "reviewer_transport_sigkill_requested",
          `${name}: unexpected hard-cap SIGKILL escalation status: ${JSON.stringify(termination)}`
        );
        assert.equal(
          termination.accepted,
          termination.status === "reviewer_transport_sigkill_requested",
          `${name}: ${JSON.stringify(termination)}`
        );
      }
      const events = activityEvents(context.activity_log_path);
      assert.ok(
        events.indexOf("projection_sticky_verification_failed") < events.indexOf("projection_cli_timeout"),
        `${name}: verifier failure must be observed before transport termination`
      );
      assert.ok(
        events.indexOf("projection_cli_timeout") < events.indexOf("projection_cli_exited"),
        `${name}: termination evidence must precede reviewer close`
      );
    });
  }
});

test("run-second-reviewer-projection covers every invalid hard-cap sticky contract body without subprocess fanout", () => {
  const invalidModelIdentities = [
    { name: "unknown-model-status", value: "unknown-model" },
    { name: "model-unknown-status", value: "model unknown" },
    { name: "generic-model-status", value: "generic" },
    { name: "default-model-status", value: "default" },
    { name: "not-reported-model-status", value: "not-reported" },
    { name: "not-available-model-status", value: "not available" },
    { name: "not-set-model-status", value: "not-set" },
    { name: "not-specified-model-status", value: "not-specified" },
    { name: "unspecified-model-status", value: "unspecified" },
    { name: "unavailable-model-status", value: "unavailable" },
    { name: "actual-model-unknown-status", value: "actual-model-unknown" },
    { name: "reviewer-model-unknown-status", value: "reviewer-model-unknown" },
    { name: "unknown-reviewer-model-status", value: "unknown-reviewer-model" },
    { name: "generic-reviewer-model-status", value: "generic-reviewer-model" },
    { name: "unknown-model-id-status", value: "unknown-model-id" },
    { name: "model-id-unknown-status", value: "model-id-unknown" },
    { name: "not-reported-model-id-status", value: "not-reported-model-id" },
    { name: "model-identity-unavailable-status", value: "model-identity-unavailable" },
    { name: "actual-model-identity-only", value: "actual-model-identity" },
    { name: "reviewer-model-identity-only", value: "reviewer-model-identity" },
    { name: "model-identity-only", value: "model-identity" },
    { name: "actual-name-only", value: "actual-name" },
    { name: "reviewer-id-only", value: "reviewer-id" },
    { name: "identity-only", value: "identity" },
    { name: "compound-unknown-generic-status", value: "unknown-generic" },
    { name: "compound-generic-unknown-status", value: "generic-unknown" },
    {
      name: "compound-model-unknown-unavailable-id-status",
      value: "model-unknown-unavailable-id",
    },
    { name: "slash-model-name-only", value: "model/name" },
    { name: "slash-unknown-generic-status", value: "unknown/generic" },
    { name: "dotted-unknown-generic-status", value: "unknown.generic" },
    { name: "slash-not-reported-status", value: "not/reported" },
    { name: "colon-model-unknown-status", value: "model:unknown" },
    { name: "plus-generic-reviewer-model-status", value: "generic+reviewer+model" },
    { name: "parenthesized-model-name-only", value: "model(name)" },
    { name: "parenthesized-actual-model-only", value: "(actual-model-identity)" },
    { name: "punctuated-not-applicable-status", value: "N.A" },
    { name: "model-not-applicable-status", value: "model N/A" },
    { name: "reviewer-model-not-applicable-status", value: "reviewer-model-N.A" },
    { name: "actual-model-not-applicable-status", value: "actual/model/n+a" },
    { name: "not-applicable-model-identity-status", value: "N/A model identity" },
  ];
  const invalidBodies = [
    {
      name: "duplicate-canonical-marker",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_marker_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: A repeated marker must not preserve sticky authority.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "duplicate-tool-carrier",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_tool_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: A repeated tool carrier must not preserve reviewer provenance.",
        "Tool: Claude Code",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "duplicate-model-carrier",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_model_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: A repeated model carrier must not preserve reviewer provenance.",
        "Model: claude-test",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "wrong-rules-version",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_rules_version_mismatch",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: The schema version must not replace the canonical rules version.",
        "Rules: v3.0.0 · Tool: Claude Code · Model: claude-test",
      ].join("\n"),
    },
    {
      name: "missing-reason",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reason_missing",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ].join("\n"),
    },
    {
      name: "blank-reason",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reason_missing",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: WARN",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "reason:   ",
      ].join("\n"),
    },
    {
      name: "marker-misplaced",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_marker_not_first_line",
      body: [
        "Second opinion",
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "reason: Marker is not the first line.",
      ].join("\n"),
    },
    {
      name: "wrong-reviewer-tool",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reviewer_tool_mismatch",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: The reviewer tool must match the dispatched reviewer family.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Codex · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "actual-model-placeholder",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reviewer_model_invalid",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: A template placeholder is not an actual reviewer model identity.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: <actual-model>`,
      ].join("\n"),
    },
    {
      name: "generic-model-placeholder",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reviewer_model_invalid",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: A generic placeholder is not an actual reviewer model identity.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: <model>`,
      ].join("\n"),
    },
    {
      name: "reviewer-model-placeholder",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reviewer_model_invalid",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: A reviewer-model placeholder is not an actual model identity.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: <reviewer-model>`,
      ].join("\n"),
    },
    {
      name: "unterminated-angle-placeholder",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reviewer_model_invalid",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: A malformed angle placeholder is not an actual model identity.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: <model`,
      ].join("\n"),
    },
    {
      name: "mustache-model-placeholder",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reviewer_model_invalid",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: A mustache placeholder is not an actual model identity.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: {{model}}`,
      ].join("\n"),
    },
    {
      name: "unknown-model",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reviewer_model_invalid",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: Unknown is not an actual model identity.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: unknown`,
      ].join("\n"),
    },
    ...invalidModelIdentities.map(({ name, value }) => ({
      name,
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reviewer_model_invalid",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        `reason: ${value} is not an actual model identity.`,
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: ${value}`,
      ].join("\n"),
    })),
    {
      name: "duplicate-identical-verdict",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_verdict_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: Repeating an identical verdict must not create two authorities.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "duplicate-conflicting-verdict",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_verdict_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "verdict: WARN",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: Conflicting verdicts must not be resolved by selecting the first one.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "duplicate-identical-last-reviewed-sha",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_last_reviewed_sha_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: Repeating the current SHA must not create two freshness authorities.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "duplicate-conflicting-last-reviewed-sha",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_last_reviewed_sha_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "last_reviewed_sha: deadbeef",
        "dispatch_id: {{dispatch_id}}",
        "reason: Conflicting SHAs must not be resolved by selecting the first one.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "duplicate-identical-dispatch-id",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_dispatch_id_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "dispatch_id: {{dispatch_id}}",
        "reason: Repeating the dispatch ID must not create two dispatch authorities.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "duplicate-conflicting-dispatch-id",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_dispatch_id_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "dispatch_id: different-dispatch",
        "reason: Conflicting dispatch IDs must not be resolved by selecting the first one.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "duplicate-identical-reason",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reason_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: This complete explanation must remain unambiguous.",
        "reason: This complete explanation must remain unambiguous.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "duplicate-conflicting-reason",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_reason_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: The first explanation claims the evidence is complete.",
        "reason: The second explanation claims the evidence is incomplete.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "duplicate-identical-provenance-footer",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_provenance_footer_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: Repeating provenance must not create two reviewer identities.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "duplicate-conflicting-provenance-footer",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_provenance_footer_duplicate",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: Conflicting provenance must not be resolved by selecting the final footer.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-other`,
      ].join("\n"),
    },
    {
      name: "malformed-footer",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_provenance_footer_missing_or_invalid",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: The footer punctuation is outside the canonical contract.",
        `Rules v${SECOND_REVIEW_RULES_VERSION} | Tool: Claude Code | Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "footer-not-final",
      expectedClassification: "sticky_contract_invalid",
      expectedContractError: "sticky_provenance_footer_missing_or_invalid",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: The canonical provenance footer must be the final line.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
        "unexpected trailing text",
      ].join("\n"),
    },
    {
      name: "stale-sha",
      expectedClassification: "sticky_sha_mismatch",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: deadbeef",
        "dispatch_id: {{dispatch_id}}",
        "reason: This review is stale.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
    {
      name: "nongate-verdict",
      expectedClassification: "sticky_verdict_not_gate_satisfying",
      body: [
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: CRITICAL",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dispatch_id: {{dispatch_id}}",
        "reason: A critical finding cannot satisfy the gate.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n"),
    },
  ];

  assert.equal(invalidBodies.length, 68);
  for (const { name, body, expectedClassification, expectedContractError } of invalidBodies) {
    const parsed = __testStickyVerifier.parseStickyBody(
      body.replaceAll("{{dispatch_id}}", `dispatch-${name}`),
      "Claude Code",
      SECOND_REVIEW_RULES_VERSION
    );

    if (expectedContractError !== undefined) {
      assert.equal(expectedClassification, "sticky_contract_invalid", name);
      assert.ok(
        parsed.contract_errors.includes(expectedContractError),
        `${name}: expected ${expectedContractError} in sticky parser evidence`
      );
    } else if (expectedClassification === "sticky_sha_mismatch") {
      assert.deepEqual(parsed.contract_errors, [], name);
      assert.notEqual(parsed.last_reviewed_sha, "abc1234", name);
    } else if (expectedClassification === "sticky_verdict_not_gate_satisfying") {
      assert.deepEqual(parsed.contract_errors, [], name);
      assert.equal(parsed.verdict, "CRITICAL", name);
    } else {
      assert.fail(`${name}: unhandled expected classification ${expectedClassification}`);
    }
  }

  const subprocessCoverageNames = new Set([
    "duplicate-canonical-marker",
  ]);
  const subprocessInvalidBodies = invalidBodies.filter(({ name }) => subprocessCoverageNames.has(name));
  assert.deepEqual(
    subprocessInvalidBodies.map(({ name }) => name),
    [...subprocessCoverageNames]
  );

  for (const { name, body, expectedClassification, expectedContractError } of subprocessInvalidBodies) {
    withTempDir(`second-review-runner-hard-cap-sticky-contract-${name}-`, (dir) => {
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFakeClaude(binDir);
      writeFakeGh(binDir);
      const { context } = renderHandoff(dir, prStickyHandoff);

      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
        DEVPRO_FAKE_REVIEWER_HOLD_AFTER_INIT_MS: "4000",
        DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponseWithBody(
          body.replaceAll("{{dispatch_id}}", context.dispatch_id)
        ),
        DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "2000",
      }, { timeout: 8000 });

      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "blocked", name);
      assert.equal(output.classification, "reviewer_cli_timeout", name);
      assert.equal(output.sticky.status, "failed", name);
      assert.equal(output.sticky.classification, expectedClassification, name);
      if (expectedContractError !== undefined) {
        const activity = readFileSync(context.activity_log_path, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        assert.ok(
          activity.some((record) => record.contract_errors?.includes(expectedContractError)),
          `${name}: expected ${expectedContractError} in sticky verifier evidence`
        );
      }
      assert.equal(output.cli_exit.timed_out, true, name);
    });
  }
});

function runMarkedRunner(contextPath) {
  const args = [runnerScript];
  if (contextPath !== undefined) args.push(contextPath);
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_CROSS_MODEL_REVIEWER: "1",
    },
  });
}

function assertContextFreeRecursiveReentry(result) {
  assert.equal(result.status, 1, result.stderr);
  assert.notEqual(
    result.stdout.trim(),
    "",
    "marked runner must return a context-free JSON fault instead of usage or context I/O failure"
  );
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.classification, "projection_recursive_reentry");
  return payload;
}

function createOwnershipWorker() {
  const runnerUrl = pathToFileURL(runnerScript).href;
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    let ownership;
    import(${JSON.stringify(runnerUrl)}).then((module) => {
      ownership = module.__testAttemptOwnership;
      parentPort.postMessage({ type: "ready" });
    }).catch((error) => {
      parentPort.postMessage({ type: "startup-error", error: error.message });
    });
    parentPort.on("message", ({ id, contextPath, attemptId }) => {
      try {
        parentPort.postMessage({ id, result: ownership.acquire(contextPath, attemptId) });
      } catch (error) {
        parentPort.postMessage({ id, error: error.message });
      }
    });
  `, { eval: true });
  const ready = new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.type === "ready") {
        cleanup();
        resolve();
      } else if (message.type === "startup-error") {
        cleanup();
        reject(new Error(message.error));
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
  return { worker, ready };
}

function requestOwnership(worker, id, contextPath, attemptId) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.postMessage({ id, contextPath, attemptId });
  });
}

// ── fix-projection-completion-truncation (T1–T5) ─────────────────────────────────────
// Shared fixtures for the completion-stream truncation classification, the diagnostic
// event, and the non-authoritative `reviewer-completion-evidence.json` carrier. All
// payloads are synthetic/de-identified (shape/sizes/hash only) — never a real reviewer
// payload. Env knobs consumed here are the claude/codex fake CLI knobs added in this file.
//
// Canonical shard bookkeeping: the cases below register through the standard `test`
// wrapper inside the core range (fix-projection-completion-truncation's ten cases took
// shard indices 36-45; fix-truncation-review-followups inserts its codex partial-line
// case inside that block, moving them to 36-40 / 42-46), so the pinned registration
// count and GROUP_RANGES in run-test-suite.test.mjs moved with them and the default
// (core) invocation — the one this change's acceptance command runs — exercises every
// fixture.
const completionEvidenceFileName = "reviewer-completion-evidence.json";

function completionEvidenceArtifactForContext(context) {
  const filePath = path.join(path.dirname(context.stdout_log_path), completionEvidenceFileName);
  return existsSync(filePath)
    ? { path: filePath, record: JSON.parse(readFileSync(filePath, "utf8")) }
    : null;
}

function completionStreamEvidenceEventsForContext(context) {
  return readFileSync(context.activity_log_path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "projection_completion_stream_evidence");
}

// Three byte-arbitrary, ASCII-only pieces of one valid completion JSON — split so fragment
// concatenation is actually exercised (and never a real payload).
function syntheticCompletionPayloadChunks() {
  const payload = JSON.stringify({
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: "none",
    reviewer_model: "claude-fixture",
    reason: "Fixture completion payload assembled from streamed deltas.",
  });
  return [payload.slice(0, 40), payload.slice(40, 96), payload.slice(96)];
}

const syntheticPartialTailLine =
  '{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"wire_tool_inputs":';

test("run-second-reviewer-projection names a partial-line completion truncation and persists arrived evidence without authority", () => {
  withSharedAuditRunnerFixture(({ binDir, context }) => {
    const chunks = syntheticCompletionPayloadChunks();
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INPUT_JSON_FRAGMENTS: JSON.stringify(chunks),
      DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1",
      DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT: syntheticPartialTailLine,
    });

    // Negative: a truncated stream MUST NOT become a completed reviewer run.
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "reviewer_completion_stream_truncated");
    assert.notEqual(output.classification, "reviewer_cli_completed");
    assert.equal(output.sticky.status, "skipped");
    assert.equal(
      completionReceiptForContext(context),
      null,
      "truncated completion must never mint an audit-only completion receipt",
    );

    // Usage companions now persist per invocation. Exclude only those advisory
    // events when asserting the unchanged control-plane anchor ordering.
    // Diagnostic event: exactly one, allowlisted fields only, positioned after the
    // audit-only terminal anchors and before the terminal receipt persist.
    const events = activityEvents(context.activity_log_path).filter(event => !event.startsWith("usage_manifest_"));
    assert.equal(
      events.filter((event) => event === "projection_completion_stream_evidence").length,
      1,
    );
    assert.equal(
      events.indexOf("projection_sticky_verification_skipped"),
      events.indexOf("projection_cli_exited") + 1,
      "audit-only terminal anchor order stays byte-identical",
    );
    assert.ok(
      events.indexOf("projection_completion_stream_evidence")
        > events.indexOf("projection_sticky_verification_skipped"),
    );
    assert.ok(
      events.indexOf("projection_terminal_receipt_written")
        > events.indexOf("projection_completion_stream_evidence"),
    );

    const [evidenceEvent] = completionStreamEvidenceEventsForContext(context);
    assert.deepEqual(
      Object.keys(evidenceEvent).sort(),
      [
        "attempt_id",
        "completion_evidence",
        "event",
        "generated_at",
        "runner_script",
        "stdout_bytes",
        "stdout_end_shape",
        "stdout_last_complete_event",
        "stdout_trailing_partial_bytes",
        "stdout_window_truncated",
      ].sort(),
      "diagnostic event must carry the exact allowlist only",
    );
    assert.equal(evidenceEvent.stdout_end_shape, "partial_line");
    assert.equal(
      evidenceEvent.stdout_trailing_partial_bytes,
      Buffer.byteLength(syntheticPartialTailLine, "utf8"),
    );
    assert.deepEqual(evidenceEvent.stdout_last_complete_event, {
      type: "stream_event",
      subtype: null,
      event_type: "content_block_stop",
    });
    assert.equal(evidenceEvent.stdout_window_truncated, false);
    assert.equal(evidenceEvent.stdout_bytes, output.cli_exit.stdout_bytes);
    assert.deepEqual(evidenceEvent.completion_evidence, {
      file: completionEvidenceFileName,
      assembly_state: "json_object",
    });
    assert.doesNotMatch(
      JSON.stringify(evidenceEvent),
      /Fixture completion payload/,
      "diagnostic event must not carry reviewer completion content",
    );
    assert.deepEqual(output.completion_stream_evidence, {
      stdout_bytes: evidenceEvent.stdout_bytes,
      stdout_end_shape: evidenceEvent.stdout_end_shape,
      stdout_trailing_partial_bytes: evidenceEvent.stdout_trailing_partial_bytes,
      stdout_last_complete_event: evidenceEvent.stdout_last_complete_event,
      stdout_window_truncated: evidenceEvent.stdout_window_truncated,
      completion_evidence: evidenceEvent.completion_evidence,
    });
    const heartbeat = JSON.parse(readFileSync(context.heartbeat_path, "utf8"));
    assert.equal(heartbeat.status, "blocked");
    assert.deepEqual(heartbeat.completion_stream_evidence, output.completion_stream_evidence);

    // Carrier: attempt-dir sibling, never under the control-evidence root, exact schema.
    const artifact = completionEvidenceArtifactForContext(context);
    assert.notEqual(artifact, null, "arrived evidence must be persisted");
    assert.equal(
      artifact.path.startsWith(`${context.control_evidence_root}${path.sep}`),
      false,
      "carrier is attempt-local, not control evidence",
    );
    assert.equal(
      existsSync(path.join(context.control_evidence_root, context.dispatch_id, completionEvidenceFileName)),
      false,
    );
    assert.deepEqual(
      Object.keys(artifact.record).sort(),
      [
        "schema",
        "attempt_id",
        "dispatch_id",
        "tool",
        "captured_at",
        "completion_authority",
        "assembly_state",
        "assembled_from",
        "fragment_count",
        "payload_bytes",
        "payload_sha256",
        "source",
        "assembled_payload",
      ].sort(),
    );
    assert.equal(artifact.record.schema, "devpro-second-review-completion-evidence/v1");
    assert.equal(artifact.record.attempt_id, context.attempt_id);
    assert.equal(artifact.record.dispatch_id, context.dispatch_id);
    assert.equal(artifact.record.tool, "claude");
    assert.match(artifact.record.captured_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(artifact.record.completion_authority, "none");
    assert.equal(artifact.record.assembly_state, "json_object");
    assert.equal(artifact.record.assembled_from, "input_json_delta");
    assert.equal(artifact.record.fragment_count, chunks.length);
    assert.equal(artifact.record.payload_bytes, Buffer.byteLength(chunks.join(""), "utf8"));
    assert.equal(
      artifact.record.payload_sha256,
      createHash("sha256").update(chunks.join(""), "utf8").digest("hex"),
    );
    assert.equal(artifact.record.assembled_payload, chunks.join(""));
    assert.deepEqual(artifact.record.source, {
      file_role: "reviewer_stdout_archive",
      stdout_bytes: evidenceEvent.stdout_bytes,
      window_truncated: false,
    });

    // The named classification lands in the existing receipt field set only.
    const terminal = terminalReceiptForContext(context);
    assertPostSpawnTerminalReceipt(context, terminal, "reviewer_completion_stream_truncated");
    assert.equal(terminal.record.outcome_group, "terminal_contract_or_cli_failure");
    assert.equal(
      JSON.stringify(terminal.record).includes(completionEvidenceFileName),
      false,
      "carrier must not leak into the terminal receipt field set",
    );
  });
});

test("run-second-reviewer-projection keeps a non-completion tool stream out of the completion-evidence carrier", () => {
  withSharedAuditRunnerFixture(({ binDir, context }) => {
    const chunks = syntheticCompletionPayloadChunks();
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INPUT_JSON_FRAGMENTS: JSON.stringify(chunks),
      DEVPRO_FAKE_REVIEWER_INPUT_JSON_TOOL_NAME: "Bash",
      DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1",
      DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT: syntheticPartialTailLine,
    });

    // F-6: a pr-sticky tool stream (`Bash`/`Write`) is not the completion payload. The
    // truncation classification and its diagnostic stay byte-identical; only the carrier
    // is withheld, so nothing can claim a completion that never arrived.
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "reviewer_completion_stream_truncated");
    assert.equal(completionReceiptForContext(context), null);

    const [evidenceEvent] = completionStreamEvidenceEventsForContext(context);
    assert.notEqual(evidenceEvent, undefined, "the truncation diagnostic still fires");
    assert.equal(evidenceEvent.stdout_end_shape, "partial_line");
    assert.equal(
      evidenceEvent.completion_evidence,
      null,
      "a non-StructuredOutput tool stream must never be reported as a persisted completion",
    );
    assert.equal(output.completion_stream_evidence.completion_evidence, null);
    assert.equal(
      completionEvidenceArtifactForContext(context),
      null,
      "no carrier may be written for a non-completion tool stream",
    );
    assertPostSpawnTerminalReceipt(context, terminalReceiptForContext(context), "reviewer_completion_stream_truncated");
  });
});

test("run-second-reviewer-projection names a mid-turn stream truncation while the persisted fragments stay partial", () => {
  withSharedAuditRunnerFixture(({ binDir, context }) => {
    const chunks = syntheticCompletionPayloadChunks().slice(0, 2);
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INPUT_JSON_FRAGMENTS_OPEN: JSON.stringify(chunks),
      DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1",
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "reviewer_completion_stream_truncated");
    assert.equal(output.sticky.status, "skipped");
    assert.equal(completionReceiptForContext(context), null);

    const [evidenceEvent] = completionStreamEvidenceEventsForContext(context);
    assert.notEqual(evidenceEvent, undefined);
    assert.equal(evidenceEvent.stdout_end_shape, "mid_turn_stream");
    assert.equal(evidenceEvent.stdout_trailing_partial_bytes, 0);
    assert.deepEqual(evidenceEvent.stdout_last_complete_event, {
      type: "stream_event",
      subtype: null,
      event_type: "content_block_delta",
    });
    assert.deepEqual(evidenceEvent.completion_evidence, {
      file: completionEvidenceFileName,
      assembly_state: "partial_json",
    });

    const artifact = completionEvidenceArtifactForContext(context);
    assert.equal(artifact?.record.assembly_state, "partial_json");
    assert.equal(artifact?.record.assembled_payload, chunks.join(""));
    assert.equal(artifact?.record.fragment_count, chunks.length);
    assertPostSpawnTerminalReceipt(context, terminalReceiptForContext(context), "reviewer_completion_stream_truncated");
  });
});

test("run-second-reviewer-projection keeps a clean-boundary completion gap generic with diagnostics only", () => {
  withSharedAuditRunnerFixture(({ binDir, context }) => {
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1",
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_completion_contract_missing");
    assert.equal(output.status, "blocked");

    const [evidenceEvent] = completionStreamEvidenceEventsForContext(context);
    assert.notEqual(evidenceEvent, undefined, "generic missing gaps still carry the diagnostic");
    assert.equal(evidenceEvent.stdout_end_shape, "clean_boundary");
    assert.deepEqual(evidenceEvent.stdout_last_complete_event, {
      type: "assistant",
      subtype: null,
      event_type: null,
    });
    assert.equal(evidenceEvent.stdout_trailing_partial_bytes, 0);
    assert.equal(evidenceEvent.completion_evidence, null);
    assert.equal(completionEvidenceArtifactForContext(context), null);
    assertPostSpawnTerminalReceipt(context, terminalReceiptForContext(context), "reviewer_completion_contract_missing");
  });
});

test("run-second-reviewer-projection reports codex no-byte and clean-boundary gaps generically with no carrier", () => {
  const cases = [
    ["no-bytes", { DEVPRO_FAKE_REVIEWER_OMIT_ALL_STDOUT: "1" }, "no_bytes", null],
    [
      "clean-boundary",
      { DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1" },
      "clean_boundary",
      { type: "unknown", subtype: null, event_type: null },
    ],
  ];
  for (const [name, env, expectedShape, expectedLastEvent] of cases) {
    withTempDir(`second-review-runner-codex-completion-${name}-`, (dir) => {
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFakeCodex(binDir);
      const { context } = renderHandoff(dir, codexAuditHandoff);
      const result = runGeneratedRunnerCommand(context, binDir, env);

      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.classification, "reviewer_completion_contract_missing", name);
      const [evidenceEvent] = completionStreamEvidenceEventsForContext(context);
      assert.equal(evidenceEvent?.stdout_end_shape, expectedShape, name);
      assert.deepEqual(evidenceEvent?.stdout_last_complete_event, expectedLastEvent, name);
      assert.equal(evidenceEvent?.completion_evidence, null, name);
      assert.deepEqual(output.completion_stream_evidence, {
        stdout_bytes: evidenceEvent.stdout_bytes,
        stdout_end_shape: evidenceEvent.stdout_end_shape,
        stdout_trailing_partial_bytes: evidenceEvent.stdout_trailing_partial_bytes,
        stdout_last_complete_event: evidenceEvent.stdout_last_complete_event,
        stdout_window_truncated: evidenceEvent.stdout_window_truncated,
        completion_evidence: null,
      }, name);
      assert.equal(completionEvidenceArtifactForContext(context), null, name);
      assert.equal(completionReceiptForContext(context), null, name);
      assertPostSpawnTerminalReceipt(context, terminalReceiptForContext(context), "reviewer_completion_contract_missing");
    });
  }
});

// R1 (S1-a) — codex is the other completion-owing reviewer family, but the truncation
// fixtures only ever exercised claude. Synthetic, ASCII-only tail: an `item.completed`
// line cut mid-write, never a real reviewer payload.
const syntheticCodexPartialTailLine =
  '{"type":"item.completed","item":{"id":"item-truncated","type":"agent_mess';

test("run-second-reviewer-projection names a codex partial-line completion truncation with no carrier", () => {
  // T1 (R1) characterization baseline, first because it is the pre-change truth: the named
  // classification already exists (fix-projection-completion-truncation D2/D3; proven by the
  // read-only analyst probe) and this block freezes it on the shared classifier seam for a
  // non-claude family. Expected GREEN before and after this change — a RED here is a
  // runtime-behavior regression, which is outside this change's scope: stop and report.
  withTempDir("second-review-codex-partial-line-seam-", (dir) => {
    const stderrPath = path.join(dir, "stderr.log");
    writeFileSync(stderrPath, "");
    const threadStartedEvent = '{"type":"thread.started","thread_id":"thr-fixture"}';
    const classifyArchive = (archiveText) => {
      const stdoutPath = path.join(dir, "stdout.log");
      writeFileSync(stdoutPath, archiveText);
      const context = {
        mode: "audit-only",
        head_ref_oid: "none",
        reviewer_cli_recipe: { tool: "codex" },
        stdout_log_path: stdoutPath,
        stderr_log_path: stderrPath,
      };
      const stdoutBytes = Buffer.byteLength(archiveText, "utf8");
      const evidence = __testReviewerClassification.extractBoundedTerminalEvidence(context);
      return {
        evidence,
        shape: __testReviewerClassification.deriveCompletionStreamEndShape({
          stdoutBytes,
          endsWithNewline: evidence.stdoutEndsWithNewline,
          trailingPartialBytes: evidence.stdoutTrailingPartialBytes,
          lastStructuredEvent: evidence.stdoutLastStructuredEvent,
        }),
        classification: __testReviewerClassification.classifyCliExit(
          context,
          { ...reviewerCliResultForClassification(0), stdout_bytes: stdoutBytes },
          evidence,
        ),
      };
    };

    const partial = classifyArchive(`${threadStartedEvent}\n${syntheticCodexPartialTailLine}`);
    assert.equal(partial.evidence.stdoutEndsWithNewline, false);
    assert.equal(
      partial.evidence.stdoutTrailingPartialBytes,
      Buffer.byteLength(syntheticCodexPartialTailLine, "utf8"),
    );
    assert.equal(partial.shape, "partial_line");
    assert.equal(partial.classification, "reviewer_completion_stream_truncated");

    // Control: the same codex recipe with an LF-terminated tail whose completion never
    // arrived keeps the generic classification — truncation is never fabricated.
    const clean = classifyArchive(`${threadStartedEvent}\n`);
    assert.equal(clean.evidence.stdoutEndsWithNewline, true);
    assert.equal(clean.shape, "clean_boundary");
    assert.equal(clean.classification, "reviewer_completion_contract_missing");
  });

  // T2 (R1) integration fixture: the same truth through the generated runner and the fake
  // codex CLI. A codex stdout archive carries no claude input_json_delta candidate, so the
  // truncation stays classification-only: no carrier, no completion authority.
  withTempDir("second-review-runner-codex-partial-line-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    const { context } = renderHandoff(dir, codexAuditHandoff);
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1",
      DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT: syntheticCodexPartialTailLine,
    });

    // Negative: a truncated stream MUST NOT become a completed reviewer run.
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "reviewer_completion_stream_truncated");
    assert.notEqual(output.classification, "reviewer_cli_completed");
    assert.equal(output.sticky.status, "skipped");
    assert.equal(
      completionReceiptForContext(context),
      null,
      "truncated completion must never mint an audit-only completion receipt",
    );

    // Usage companion events are advisory; control anchors keep the Claude order.
    // Diagnostic event: exactly one, positioned after the audit-only terminal anchors and
    // before the terminal receipt persist — the same event order as the claude case.
    const events = activityEvents(context.activity_log_path).filter(event => !event.startsWith("usage_manifest_"));
    assert.equal(
      events.filter((event) => event === "projection_completion_stream_evidence").length,
      1,
    );
    assert.equal(
      events.indexOf("projection_sticky_verification_skipped"),
      events.indexOf("projection_cli_exited") + 1,
      "audit-only terminal anchor order stays byte-identical",
    );
    assert.ok(
      events.indexOf("projection_completion_stream_evidence")
        > events.indexOf("projection_sticky_verification_skipped"),
    );
    assert.ok(
      events.indexOf("projection_terminal_receipt_written")
        > events.indexOf("projection_completion_stream_evidence"),
    );

    const [evidenceEvent] = completionStreamEvidenceEventsForContext(context);
    assert.equal(evidenceEvent.stdout_end_shape, "partial_line");
    assert.equal(
      evidenceEvent.stdout_trailing_partial_bytes,
      Buffer.byteLength(syntheticCodexPartialTailLine, "utf8"),
    );
    assert.deepEqual(evidenceEvent.stdout_last_complete_event, {
      type: "unknown",
      subtype: null,
      event_type: null,
    });
    assert.equal(evidenceEvent.stdout_window_truncated, false);
    assert.equal(evidenceEvent.stdout_bytes, output.cli_exit.stdout_bytes);
    assert.equal(
      evidenceEvent.completion_evidence,
      null,
      "a codex archive has no assemblable completion candidate -> no persistence claim",
    );
    assert.deepEqual(output.completion_stream_evidence, {
      stdout_bytes: evidenceEvent.stdout_bytes,
      stdout_end_shape: evidenceEvent.stdout_end_shape,
      stdout_trailing_partial_bytes: evidenceEvent.stdout_trailing_partial_bytes,
      stdout_last_complete_event: evidenceEvent.stdout_last_complete_event,
      stdout_window_truncated: evidenceEvent.stdout_window_truncated,
      completion_evidence: null,
    });

    // No carrier: nothing may claim a completion that never arrived.
    assert.equal(completionEvidenceArtifactForContext(context), null);

    // The named classification lands in the existing receipt field set only.
    const terminal = terminalReceiptForContext(context);
    assertPostSpawnTerminalReceipt(context, terminal, "reviewer_completion_stream_truncated");
    assert.equal(terminal.record.outcome_group, "terminal_contract_or_cli_failure");
    assert.deepEqual(Object.keys(terminal.record).sort(), [
      "attempt_id",
      "classification",
      "created_at",
      "dispatch_id",
      "head_ref_oid",
      "integrity_id",
      "invocation_claim_sha256",
      "lifecycle_phase",
      "outcome_group",
      "pr_number",
      "previous_dispatch_id",
      "process_close_observed",
      "process_spawned",
      "repository_slug",
      "responsibility",
      "schema",
      "transport_cleanup_confirmed",
    ]);
  });
});

test("run-second-reviewer-projection leaves a healthy completion run without diagnostic or carrier", () => {
  withSharedAuditRunnerFixture(({ binDir, context }) => {
    const result = runGeneratedRunnerCommand(context, binDir, {});

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "finished");
    assert.equal(output.classification, "reviewer_cli_completed");
    assert.equal("completion_stream_evidence" in output, false);
    assert.equal(
      activityEvents(context.activity_log_path).includes("projection_completion_stream_evidence"),
      false,
    );
    assert.equal(completionEvidenceArtifactForContext(context), null);
    assert.equal(terminalReceiptForContext(context), null);
    assert.notEqual(completionReceiptForContext(context), null);
    const heartbeat = JSON.parse(readFileSync(context.heartbeat_path, "utf8"));
    assert.equal(heartbeat.status, "finished");
    assert.equal("completion_stream_evidence" in heartbeat, false);
  });
});

test("run-second-reviewer-projection pairs not-successful and malformed completion gaps with their carrier", () => {
  const variants = [
    [
      "not-successful",
      JSON.stringify({ type: "result", subtype: "error", is_error: false }),
    ],
    [
      "malformed",
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "not-json" }),
    ],
  ];
  for (const [name, terminalEvent] of variants) {
    withSharedAuditRunnerFixture(({ binDir, context }) => {
      const chunks = syntheticCompletionPayloadChunks();
      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_REVIEWER_INPUT_JSON_FRAGMENTS: JSON.stringify(chunks),
        DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: terminalEvent,
      });

      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.classification, "reviewer_completion_contract_invalid", name);
      assert.equal(completionReceiptForContext(context), null, name);

      const [evidenceEvent] = completionStreamEvidenceEventsForContext(context);
      assert.equal(evidenceEvent?.stdout_end_shape, "clean_boundary", name);
      assert.deepEqual(evidenceEvent?.completion_evidence, {
        file: completionEvidenceFileName,
        assembly_state: "json_object",
      }, name);
      assert.deepEqual(output.completion_stream_evidence, {
        stdout_bytes: evidenceEvent.stdout_bytes,
        stdout_end_shape: "clean_boundary",
        stdout_trailing_partial_bytes: evidenceEvent.stdout_trailing_partial_bytes,
        stdout_last_complete_event: evidenceEvent.stdout_last_complete_event,
        stdout_window_truncated: evidenceEvent.stdout_window_truncated,
        completion_evidence: {
          file: completionEvidenceFileName,
          assembly_state: "json_object",
        },
      }, name);

      const artifact = completionEvidenceArtifactForContext(context);
      assert.equal(artifact?.record.assembly_state, "json_object", name);
      assert.equal(artifact?.record.completion_authority, "none", name);
      assert.equal(artifact?.record.assembled_payload, chunks.join(""), name);
      assertPostSpawnTerminalReceipt(context, terminalReceiptForContext(context), "reviewer_completion_contract_invalid");
    });
  }
});

test("run-second-reviewer-projection classification and receipts are invariant to the completion-evidence carrier", () => {
  const seededCases = [
    ["absent", null],
    ["tampered-unparseable", '{"schema":"devpro-second-review-completion-evidence/v1"'],
    [
      "tampered-different-bytes",
      `${JSON.stringify({
        schema: "devpro-second-review-completion-evidence/v1",
        sentinel: "preseeded-different-bytes",
      })}\n`,
    ],
  ];
  const observations = [];
  for (const [name, seeded] of seededCases) {
    withSharedAuditRunnerFixture(({ binDir, context }) => {
      const carrierPath = path.join(path.dirname(context.stdout_log_path), completionEvidenceFileName);
      if (seeded !== null) writeFileSync(carrierPath, seeded, "utf8");
      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_REVIEWER_INPUT_JSON_FRAGMENTS: JSON.stringify(syntheticCompletionPayloadChunks()),
        DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1",
        DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT: syntheticPartialTailLine,
      });

      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      const terminal = terminalReceiptForContext(context);
      assert.equal(output.classification, "reviewer_completion_stream_truncated", name);
      assert.equal(terminal?.record.classification, "reviewer_completion_stream_truncated", name);
      assert.equal(terminal?.record.outcome_group, "terminal_contract_or_cli_failure", name);
      assert.equal(completionReceiptForContext(context), null, name);

      const [evidenceEvent] = completionStreamEvidenceEventsForContext(context);
      assert.equal(evidenceEvent?.stdout_end_shape, "partial_line", name);
      if (seeded === null) {
        assert.equal(
          completionEvidenceArtifactForContext(context)?.record.assembly_state,
          "json_object",
          name,
        );
      } else {
        assert.equal(
          readFileSync(carrierPath, "utf8"),
          seeded,
          `${name}: an existing carrier MUST NOT be overwritten`,
        );
        assert.equal(
          evidenceEvent?.completion_evidence,
          null,
          `${name}: no persistence claim when the carrier was not written`,
        );
      }
      observations.push({
        classification: output.classification,
        terminal: terminal?.record.classification,
        shape: evidenceEvent?.stdout_end_shape,
      });
    });
  }
  assert.deepEqual(
    observations,
    seededCases.map(() => ({
      classification: "reviewer_completion_stream_truncated",
      terminal: "reviewer_completion_stream_truncated",
      shape: "partial_line",
    })),
  );
});

test("completion-stream shape derivation stays inside the bounded tail vocabulary and caps the carrier payload", (t) => {
  assert.equal(runnerModule.BOUNDED_TAIL_EVIDENCE_MAX_BYTES, 65536);
  assert.equal(runnerModule.COMPLETION_EVIDENCE_PAYLOAD_MAX_BYTES, 65536);
  const derive = __testReviewerClassification.deriveCompletionStreamEndShape;
  assert.equal(
    derive({ stdoutBytes: 0, endsWithNewline: true, trailingPartialBytes: 0, lastStructuredEvent: null }),
    "no_bytes",
  );
  assert.equal(
    derive({ stdoutBytes: 10, endsWithNewline: false, trailingPartialBytes: 3, lastStructuredEvent: null }),
    "partial_line",
  );
  assert.equal(
    derive({
      stdoutBytes: 10,
      endsWithNewline: true,
      trailingPartialBytes: 0,
      lastStructuredEvent: { type: "stream_event", subtype: null, event_type: "content_block_delta" },
    }),
    "mid_turn_stream",
  );
  assert.equal(
    derive({
      stdoutBytes: 10,
      endsWithNewline: true,
      trailingPartialBytes: 0,
      lastStructuredEvent: { type: "result", subtype: "success", event_type: null },
    }),
    "clean_boundary",
  );

  withTempDir("second-review-completion-tail-fields-", (dir) => {
    const missingPath = path.join(dir, "missing.ndjson");
    const emptyPath = path.join(dir, "empty.ndjson");
    const completePath = path.join(dir, "complete.ndjson");
    const partialPath = path.join(dir, "partial.ndjson");
    const partialLine = '{"type":"assistant"}';
    writeFileSync(emptyPath, "");
    writeFileSync(completePath, '{"type":"assistant"}\n');
    writeFileSync(partialPath, `{"type":"assistant"}\n${partialLine}`);
    const evidenceFor = (stdoutPath) => __testReviewerClassification.extractBoundedTerminalEvidence({
      mode: "audit-only",
      head_ref_oid: "none",
      reviewer_cli_recipe: { tool: "claude" },
      stdout_log_path: stdoutPath,
      stderr_log_path: path.join(dir, "stderr.ndjson"),
    });

    for (const [label, stdoutPath] of [["missing", missingPath], ["empty", emptyPath]]) {
      const evidence = evidenceFor(stdoutPath);
      assert.equal(evidence.stdoutEndsWithNewline, true, label);
      assert.equal(evidence.stdoutTrailingPartialBytes, 0, label);
      assert.equal(evidence.stdoutLastStructuredEvent, null, label);
    }
    const complete = evidenceFor(completePath);
    assert.equal(complete.stdoutEndsWithNewline, true);
    assert.equal(complete.stdoutTrailingPartialBytes, 0);
    assert.deepEqual(complete.stdoutLastStructuredEvent, {
      type: "assistant",
      subtype: null,
      event_type: null,
    });
    const partial = evidenceFor(partialPath);
    assert.equal(partial.stdoutEndsWithNewline, false);
    assert.equal(partial.stdoutTrailingPartialBytes, Buffer.byteLength(partialLine, "utf8"));
    assert.deepEqual(partial.stdoutLastStructuredEvent, {
      type: "assistant",
      subtype: null,
      event_type: null,
    });
  });

  const seam = runnerModule.__testCompletionStreamEvidence;
  assert.notEqual(seam, undefined, "completion-evidence test seam must exist");
  const startEvent = (index) => ({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: `toolu_${index}`, name: "StructuredOutput", input: {} },
    },
  });
  const deltaEvent = (index, partialJson) => ({
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } },
  });
  const stopEvent = (index) => ({
    type: "stream_event",
    event: { type: "content_block_stop", index },
  });
  assert.deepEqual(
    seam.completionEvidenceCandidate([startEvent(2), deltaEvent(2, '{"a"'), stopEvent(2)]).fragments,
    ['{"a"'],
  );
  assert.deepEqual(
    seam.completionEvidenceCandidate([
      startEvent(2),
      deltaEvent(2, "first"),
      stopEvent(2),
      startEvent(3),
      deltaEvent(3, "second"),
    ]).fragments,
    ["second"],
  );
  assert.equal(
    seam.completionEvidenceCandidate([deltaEvent(2, "{}")]),
    null,
    "deltas without an observed tool_use start are not assembled",
  );
  assert.equal(
    seam.completionEvidenceCandidate([startEvent(2), deltaEvent(3, "{}")]),
    null,
    "index-mismatched deltas are not assembled",
  );
  assert.equal(
    seam.completionEvidenceCandidate([startEvent(2), stopEvent(2), deltaEvent(2, "late")]),
    null,
    "deltas after content_block_stop do not extend a closed block",
  );
  const nonCompletionStartEvent = (index) => ({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: `toolu_${index}`, name: "Bash", input: {} },
    },
  });
  assert.equal(
    seam.completionEvidenceCandidate([
      nonCompletionStartEvent(2),
      deltaEvent(2, '{"command":"gh pr view"}'),
      stopEvent(2),
    ]),
    null,
    "F-6: a pr-sticky Bash/Write tool stream is never a completion candidate",
  );
  assert.deepEqual(
    seam.completionEvidenceCandidate([
      startEvent(2),
      deltaEvent(2, "kept"),
      nonCompletionStartEvent(3),
      deltaEvent(3, "ignored"),
    ]).fragments,
    ["kept"],
    "F-6: a non-completion start neither replaces nor extends the open completion candidate",
  );
  assert.equal(
    seam.completionEvidenceArtifactPath({
      stdout_log_path: path.join("attempt-root", "attempt-dir", "reviewer-stdout.ndjson"),
    }),
    path.join("attempt-root", "attempt-dir", completionEvidenceFileName),
    "carrier is a sibling of the renderer-owned stdout archive",
  );

  const contextStub = {
    attempt_id: "attempt-stub",
    dispatch_id: "dispatch-stub",
    reviewer_cli_recipe: { tool: "claude" },
  };
  const overCapCandidate = { index: 0, fragments: ["a".repeat(40000), "b".repeat(40000)] };
  const assembled = seam.assembleCompletionEvidencePayload(overCapCandidate);
  assert.equal(assembled.overCap, true);
  assert.equal(Buffer.byteLength(assembled.text, "utf8") <= 65536, true);
  const overCapRecord = seam.buildCompletionEvidenceRecord(contextStub, {
    candidate: overCapCandidate,
    stdoutBytes: 65536,
    windowTruncated: true,
  });
  assert.equal(overCapRecord.assembly_state, "over_cap");
  assert.equal("assembled_payload" in overCapRecord, false);
  assert.equal("payload_sha256" in overCapRecord, false);
  assert.deepEqual(
    Object.keys(overCapRecord).sort(),
    [
      "schema",
      "attempt_id",
      "dispatch_id",
      "tool",
      "captured_at",
      "completion_authority",
      "assembly_state",
      "assembled_from",
      "fragment_count",
      "payload_bytes",
      "source",
    ].sort(),
  );
  assert.deepEqual(overCapRecord.source, {
    file_role: "reviewer_stdout_archive",
    stdout_bytes: 65536,
    window_truncated: true,
  });
  const boundedFragment = '{"verdict":"PASS"}';
  const boundedRecord = seam.buildCompletionEvidenceRecord(contextStub, {
    candidate: { index: 0, fragments: [boundedFragment] },
    stdoutBytes: 42,
    windowTruncated: false,
  });
  assert.equal(boundedRecord.assembly_state, "json_object");
  assert.equal(boundedRecord.payload_sha256, createHash("sha256").update(boundedFragment, "utf8").digest("hex"));
  assert.equal(boundedRecord.assembled_payload, boundedFragment);
  assert.equal(boundedRecord.payload_bytes, Buffer.byteLength(boundedFragment, "utf8"));

  withTempDir("second-review-completion-evidence-writer-", (dir) => {
    const writerContext = {
      attempt_id: "attempt-writer",
      dispatch_id: "dispatch-writer",
      reviewer_cli_recipe: { tool: "claude" },
      stdout_log_path: path.join(dir, "reviewer-stdout.ndjson"),
    };
    const boundedEvidence = {
      stdoutTruncated: false,
      stdoutStructuredEvents: [startEvent(1), deltaEvent(1, boundedFragment), stopEvent(1)],
    };
    const carrierPath = path.join(dir, completionEvidenceFileName);

    // paged (v5) attempts never write the carrier (named D5 boundary).
    assert.equal(
      seam.persistCompletionEvidenceArtifact(
        { ...writerContext, page_window_checkpoint_handoff: true },
        { boundedEvidence, completion: { status: "missing" }, stdoutBytes: 64 },
      ),
      null,
    );
    assert.equal(existsSync(carrierPath), false);
    // non-completion-requiring families never write it.
    assert.equal(
      seam.persistCompletionEvidenceArtifact(
        { ...writerContext, reviewer_cli_recipe: { tool: "other" } },
        { boundedEvidence, completion: { status: "missing" }, stdoutBytes: 64 },
      ),
      null,
    );
    // a codex stream carries no claude input_json_delta candidates -> no carrier.
    assert.equal(
      seam.persistCompletionEvidenceArtifact(
        { ...writerContext, reviewer_cli_recipe: { tool: "codex" } },
        {
          boundedEvidence: {
            stdoutTruncated: false,
            stdoutStructuredEvents: [{ type: "item.completed", item: { type: "agent_message" } }],
          },
          completion: { status: "missing" },
          stdoutBytes: 64,
        },
      ),
      null,
    );
    assert.equal(
      seam.persistCompletionEvidenceArtifact(
        writerContext,
        { boundedEvidence, completion: { status: "accepted", completion: {} }, stdoutBytes: 64 },
      ),
      null,
    );
    assert.equal(existsSync(carrierPath), false);

    // F-5: a non-EEXIST write failure (here: the attempt directory does not exist) must
    // return null without throwing and leave no half-written carrier behind.
    const missingAttemptDir = path.join(dir, "missing-attempt-dir");
    assert.equal(
      seam.persistCompletionEvidenceArtifact(
        { ...writerContext, stdout_log_path: path.join(missingAttemptDir, "reviewer-stdout.ndjson") },
        { boundedEvidence, completion: { status: "missing" }, stdoutBytes: 64 },
      ),
      null,
      "a non-EEXIST write failure stays 'no carrier for this attempt'",
    );
    assert.equal(existsSync(path.join(missingAttemptDir, completionEvidenceFileName)), false);

    // Triggered: one exclusive write, literal non-authority marker, then never overwritten.
    assert.deepEqual(
      seam.persistCompletionEvidenceArtifact(
        writerContext,
        { boundedEvidence, completion: { status: "missing" }, stdoutBytes: 64 },
      ),
      { file: completionEvidenceFileName, assembly_state: "json_object" },
    );
    const firstBytes = readFileSync(carrierPath, "utf8");
    assert.equal(JSON.parse(firstBytes).completion_authority, "none");
    writeFileSync(carrierPath, "preseeded different bytes\n", "utf8");
    assert.equal(
      seam.persistCompletionEvidenceArtifact(
        writerContext,
        { boundedEvidence, completion: { status: "missing" }, stdoutBytes: 64 },
      ),
      null,
      "different existing bytes must not be overwritten or reported as this attempt's carrier",
    );
    assert.equal(readFileSync(carrierPath, "utf8"), "preseeded different bytes\n");

    // F-4: the size-first guard must not change equal-size semantics — an existing carrier
    // with the same byte length is still compared byte-for-byte. Frozen Date makes the
    // record's `captured_at` reproducible, so "identical bytes" is deterministic rather
    // than same-millisecond luck.
    let identicalBody;
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 2, 3, 4, 5, 678) });
    try {
      identicalBody = `${JSON.stringify(seam.buildCompletionEvidenceRecord(writerContext, {
        candidate: { index: 1, fragments: [boundedFragment] },
        stdoutBytes: 64,
        windowTruncated: false,
      }), null, 2)}\n`;
      writeFileSync(carrierPath, identicalBody, "utf8");
      assert.deepEqual(
        seam.persistCompletionEvidenceArtifact(
          writerContext,
          { boundedEvidence, completion: { status: "missing" }, stdoutBytes: 64 },
        ),
        { file: completionEvidenceFileName, assembly_state: "json_object" },
        "byte-identical existing carrier -> idempotent re-read returns the existing shape",
      );
      assert.equal(readFileSync(carrierPath, "utf8"), identicalBody);
    } finally {
      t.mock.timers.reset();
    }
    // Same length, different bytes: the exact compare still rejects the collision.
    const equalSizeDifferentBody = identicalBody.replace("attempt-writer", "attempt-WRITER");
    assert.equal(
      Buffer.byteLength(equalSizeDifferentBody, "utf8"),
      Buffer.byteLength(identicalBody, "utf8"),
      "fixture must exercise the equal-size read path, not the size guard",
    );
    writeFileSync(carrierPath, equalSizeDifferentBody, "utf8");
    assert.equal(
      seam.persistCompletionEvidenceArtifact(
        writerContext,
        { boundedEvidence, completion: { status: "missing" }, stdoutBytes: 64 },
      ),
      null,
      "equal-size different bytes must not be overwritten or reported as this attempt's carrier",
    );
    assert.equal(readFileSync(carrierPath, "utf8"), equalSizeDifferentBody);
  });
});

test("reviewer completion classification consumers stay inside the bounded touch surface", () => {
  const runnerSource = readFileSync(runnerScript, "utf8");
  const libSource = readFileSync(
    repoPath(".devpro/scripts/hooks/lib/second-review-control-evidence.mjs"),
    "utf8",
  );
  const rendererSource = readFileSync(repoPath(".devpro/scripts/render-second-review-packet.mjs"), "utf8");
  const validatorSource = readFileSync(repoPath(".devpro/scripts/validate-second-review-packet.mjs"), "utf8");

  // The generic classification keeps exactly one runtime carrier in the runner (the
  // generic missing return) and exactly one in the outcome-group registry; everything
  // else that names it is test evidence (F-r1-01 spillover inventory).
  assert.equal((runnerSource.match(/reviewer_completion_contract_missing/g) ?? []).length, 1);
  assert.ok(runnerSource.includes("reviewer_completion_stream_truncated"));
  assert.equal((libSource.match(/"reviewer_completion_contract_missing"/g) ?? []).length, 1);
  assert.equal((libSource.match(/"reviewer_completion_stream_truncated"/g) ?? []).length, 1);

  // Frozen packet/render/ack surfaces need no allowlist extension for the new terminal
  // classification: they consume `retry_context.classification` as a substring token.
  for (const [relPath, source] of [
    [".devpro/scripts/render-second-review-packet.mjs", rendererSource],
    [".devpro/scripts/validate-second-review-packet.mjs", validatorSource],
    [".devpro/scripts/ack-second-reviewer-projection.mjs", readFileSync(repoPath(".devpro/scripts/ack-second-reviewer-projection.mjs"), "utf8")],
  ]) {
    assert.equal(source.includes("reviewer_completion_contract_missing"), false, relPath);
    assert.equal(source.includes("reviewer_completion_stream_truncated"), false, relPath);
  }
  assert.match(validatorSource, /SAME_FAMILY_FALLBACK_CLASSIFICATION_TOKEN = "same_family_fallback"/);
  assert.match(
    validatorSource,
    /classification\.includes\(SAME_FAMILY_FALLBACK_CLASSIFICATION_TOKEN\)/,
    "retry_context classification consumption is a substring-token check, not a maintained enum",
  );
  assert.match(runnerSource, /classificationIndicatesSameFamilyFallback\(context\.retry_context\?\.classification\)/);
  assert.match(rendererSource, /classificationIndicatesSameFamilyFallback\(input\?\.retry_context\?\.classification\)/);
});

test("reviewer executable discovery is bounded and blocks an identifiable cmux first hit", async () => {
  assert.equal(
    typeof runnerModule.__testReviewerExecutable?.resolve,
    "function",
    "runner must expose its bounded executable resolver to focused tests"
  );

  await withTempDirAsync("second-review-tool-discovery-", async (dir) => {
    const resolve = runnerModule.__testReviewerExecutable.resolve;
    const missing = resolve("claude", { pathValue: path.join(dir, "missing") });
    assert.deepEqual(missing, {
      status: "blocked",
      classification: "tool_discovery_blocked",
      reason: "tool_missing_from_path",
    });

    const directBin = path.join(dir, "direct-bin");
    mkdirSync(directBin, { recursive: true });
    const directTool = writeFakeClaude(directBin);
    const realpathFailed = resolve("claude", {
      pathValue: directBin,
      realpathSyncImpl() {
        throw new Error("fixture realpath failure");
      },
    });
    assert.deepEqual(realpathFailed, {
      status: "blocked",
      classification: "tool_discovery_blocked",
      reason: "tool_realpath_failed",
    });

    const cmuxBin = path.join(dir, "cmux-cli-shims", "session");
    const wrapperInvocationLog = path.join(dir, "wrapper-invocations.log");
    const authPreflightLog = path.join(dir, "auth-preflight-args.log");
    const reviewerInvocationLog = path.join(dir, "reviewer-invocation-args.log");
    const executableIdentityLog = path.join(dir, "executable-identity.log");
    const hookLog = path.join(dir, "cmux-hook.log");
    mkdirSync(cmuxBin, { recursive: true });
    const wrapperTool = path.join(cmuxBin, "claude");
    writeFileSync(
      wrapperTool,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DEVPRO_FAKE_WRAPPER_INVOCATION_LOG"\nexit 97\n`,
      "utf8"
    );
    chmodSync(wrapperTool, 0o755);
    writeWindowsExecutableResolverMarker(wrapperTool);
    writeFileSync(
      path.join(cmuxBin, "hook.cjs"),
      "require('node:fs').appendFileSync(process.env.DEVPRO_FAKE_CMUX_HOOK_LOG, 'loaded\\n');\n",
      "utf8"
    );

    assert.deepEqual(resolve("claude", {
      pathValue: `${cmuxBin}${path.delimiter}${directBin}`,
    }), {
      status: "blocked",
      classification: "tool_discovery_blocked",
      reason: "cmux_wrapper_or_shim_first_hit",
    });
    const directResolution = resolve("claude", { pathValue: directBin });
    assert.equal(directResolution.status, "trusted");
    if (process.platform === "win32") {
      assert.equal(path.dirname(directResolution.executable).toLowerCase(), path.resolve(directBin).toLowerCase());
      assert.match(path.basename(directResolution.executable), /^claude\.(?:exe|com)$/iu);
    } else {
      assert.equal(directResolution.executable, realpathSync(directTool));
    }

    const win32Bin = "C:\\reviewer-bin";
    const win32Candidate = (extension) => path.win32.resolve(win32Bin, `claude${extension}`);
    const resolveSyntheticWin32 = ({
      pathExtValue,
      existing,
      pathValue = win32Bin,
      resolvedPath,
    }) => {
      const accesses = [];
      const realpaths = [];
      const outcome = resolve("claude", {
        platform: "win32",
        cwd: "C:\\reviewer-cwd",
        pathValue,
        pathExtValue,
        accessSyncImpl(candidate) {
          accesses.push(candidate);
          if (!existing.has(candidate)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        statSyncImpl() {
          return { isFile: () => true };
        },
        realpathSyncImpl(candidate) {
          realpaths.push(candidate);
          return resolvedPath ?? candidate;
        },
      });
      return { outcome, accesses, realpaths };
    };

    const pathextOrdered = resolveSyntheticWin32({
      pathExtValue: ".EXE;.COM",
      existing: new Set([win32Candidate(".EXE"), win32Candidate(".COM")]),
    });
    assert.deepEqual(pathextOrdered.outcome, {
      status: "trusted",
      executable: win32Candidate(".EXE"),
    });
    assert.deepEqual(pathextOrdered.accesses, [win32Candidate(".EXE")]);

    for (const shellExtension of [".CMD", ".BAT"]) {
      const shellFirst = resolveSyntheticWin32({
        pathExtValue: `${shellExtension};.EXE`,
        existing: new Set([win32Candidate(shellExtension), win32Candidate(".EXE")]),
      });
      assert.deepEqual(shellFirst.outcome, {
        status: "blocked",
        classification: "tool_discovery_blocked",
        reason: "tool_requires_shell_interpretation",
      });
      assert.deepEqual(shellFirst.accesses, [win32Candidate(shellExtension)]);
      assert.deepEqual(shellFirst.realpaths, []);
    }

    const extensionless = path.win32.resolve(win32Bin, "claude");
    const extensionlessIgnored = resolveSyntheticWin32({
      pathExtValue: ".EXE",
      existing: new Set([extensionless, win32Candidate(".EXE")]),
    });
    assert.deepEqual(extensionlessIgnored.outcome, {
      status: "trusted",
      executable: win32Candidate(".EXE"),
    });
    assert.deepEqual(extensionlessIgnored.accesses, [win32Candidate(".EXE")]);

    const malformedPathextIgnored = resolveSyntheticWin32({
      pathExtValue: "..\\escape;.EXE;C:\\outside",
      existing: new Set([win32Candidate(".EXE")]),
    });
    assert.deepEqual(malformedPathextIgnored.outcome, {
      status: "trusted",
      executable: win32Candidate(".EXE"),
    });
    assert.deepEqual(malformedPathextIgnored.accesses, [win32Candidate(".EXE")]);

    const win32CmuxBin = "C:\\cmux-cli-shims\\session";
    const win32CmuxTool = path.win32.resolve(win32CmuxBin, "claude.EXE");
    const win32Cmux = resolveSyntheticWin32({
      pathExtValue: ".EXE",
      pathValue: win32CmuxBin,
      existing: new Set([win32CmuxTool]),
      resolvedPath: win32CmuxTool,
    });
    assert.deepEqual(win32Cmux.outcome, {
      status: "blocked",
      classification: "tool_discovery_blocked",
      reason: "cmux_wrapper_or_shim_first_hit",
    });

    const cmuxAppResourcesBin = path.join(
      dir,
      "cmux.app",
      "Contents",
      "Resources",
      "bin"
    );
    mkdirSync(cmuxAppResourcesBin, { recursive: true });
    writeFakeClaude(cmuxAppResourcesBin);
    assert.deepEqual(resolve("claude", { pathValue: cmuxAppResourcesBin }), {
      status: "blocked",
      classification: "tool_discovery_blocked",
      reason: "cmux_wrapper_or_shim_first_hit",
    });

    const { context } = renderHandoff(dir);
    const result = runGeneratedRunnerCommand(context, cmuxBin, {
      PATH: `${cmuxBin}${path.delimiter}${directBin}${path.delimiter}${process.env.PATH ?? ""}`,
      DEVPRO_FAKE_WRAPPER_INVOCATION_LOG: wrapperInvocationLog,
      DEVPRO_FAKE_AUTH_PREFLIGHT_LOG: authPreflightLog,
      DEVPRO_FAKE_REVIEWER_INVOCATION_LOG: reviewerInvocationLog,
      DEVPRO_FAKE_EXECUTABLE_IDENTITY_LOG: executableIdentityLog,
      DEVPRO_FAKE_CMUX_HOOK_LOG: hookLog,
      NODE_OPTIONS: `--require ${path.join(cmuxBin, "hook.cjs")}`,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "finished");
    assert.equal(existsSync(wrapperInvocationLog), false);
    const executableIdentities = readFileSync(executableIdentityLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    assert.deepEqual(
      new Set(executableIdentities.map(([, executable]) => executable)),
      new Set([realpathSync(directTool)])
    );
    const sanitizedEvents = readFileSync(context.activity_log_path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.event === "projection_dispatch_env_sanitized");
    assert.equal(sanitizedEvents.length, 1);
    const hostPathIdentifiableCmuxEntryCount = String(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((entry) => isIdentifiableCmuxPathEntry(entry)).length;
    assert.equal(
      sanitizedEvents[0].removed_path_entry_count,
      1 + hostPathIdentifiableCmuxEntryCount,
      "expected count is the fixture's one injected cmux entry plus whatever identifiable cmux entries the real host PATH already carries (e.g. running inside cmux.app)"
    );
    assert.equal(sanitizedEvents[0].node_options_cleared, true);
    assert.equal(
      readFileSync(hookLog, "utf8").trim().split("\n").filter(Boolean).length,
      1
    );
    const leakSurfaces = [
      ["runner stdout", result.stdout],
      ["activity", readFileSync(context.activity_log_path, "utf8")],
      ["heartbeat", readFileSync(context.heartbeat_path, "utf8")],
      ["reviewer stdout", readFileSync(context.stdout_log_path, "utf8")],
      ["reviewer stderr", readFileSync(context.stderr_log_path, "utf8")],
      ["probe", readFileSync(context.cli_probe_result_path, "utf8")],
    ];
    const sanitizedTerminal = terminalReceiptForContext(context);
    if (sanitizedTerminal) {
      leakSurfaces.push(["terminal receipt", readFileSync(sanitizedTerminal.path, "utf8")]);
    }
    for (const [surface, content] of leakSurfaces) {
      assert.equal(content.includes(wrapperTool), false, surface);
      assert.equal(content.includes(directTool), false, surface);
    }

    const wrapperBasenameTool = path.join(dir, "cmux-claude-wrapper");
    const guardWrapperLog = path.join(dir, "guard-wrapper-invocations.log");
    const guardAuthLog = path.join(dir, "guard-auth-preflight-args.log");
    const guardReviewerLog = path.join(dir, "guard-reviewer-invocation-args.log");
    writeFileSync(
      wrapperBasenameTool,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DEVPRO_FAKE_WRAPPER_INVOCATION_LOG"\nexit 97\n`,
      "utf8"
    );
    chmodSync(wrapperBasenameTool, 0o755);
    writeWindowsExecutableResolverMarker(wrapperBasenameTool);
    const fallbackBin = path.join(dir, "fallback-bin");
    mkdirSync(fallbackBin, { recursive: true });
    if (process.platform === "win32") {
      // The resolver probes claude.exe on Windows. Link that exact candidate
      // to a cmux-named .exe marker so realpath sees the wrapper identity;
      // an adjacent marker beside an extensionless symlink is a separate file.
      symlinkSync(`${wrapperBasenameTool}.exe`, path.join(fallbackBin, "claude.exe"), "file");
      assert.deepEqual(resolve("claude", { pathValue: fallbackBin }), {
        status: "blocked",
        classification: "tool_discovery_blocked",
        reason: "cmux_wrapper_or_shim_first_hit",
      });
    } else {
      symlinkSync(wrapperBasenameTool, path.join(fallbackBin, "claude"));
    }
    const { context: guardContext } = renderHandoff(dir);
    const guardResult = runGeneratedRunnerCommand(guardContext, fallbackBin, {
      PATH: `${fallbackBin}${path.delimiter}${directBin}${path.delimiter}${process.env.PATH ?? ""}`,
      DEVPRO_FAKE_WRAPPER_INVOCATION_LOG: guardWrapperLog,
      DEVPRO_FAKE_AUTH_PREFLIGHT_LOG: guardAuthLog,
      DEVPRO_FAKE_REVIEWER_INVOCATION_LOG: guardReviewerLog,
    });
    assert.notEqual(guardResult.status, 0, guardResult.stderr);
    const guardStdout = JSON.parse(guardResult.stdout);
    assert.equal(guardStdout.status, "blocked");
    assert.equal(guardStdout.classification, "tool_discovery_blocked");
    assert.equal(existsSync(guardWrapperLog), false);
    assert.equal(existsSync(guardAuthLog), false);
    assert.equal(existsSync(guardReviewerLog), false);
    assert.equal(
      activityEvents(guardContext.activity_log_path).some((event) => (
        event.startsWith("projection_review_scope_probe")
        || event.startsWith("projection_cli_probe")
        || event.startsWith("projection_cli_start")
      )),
      false
    );
    assert.equal(
      activityEvents(guardContext.activity_log_path).includes("projection_dispatch_env_sanitized"),
      hostPathIdentifiableCmuxEntryCount > 0,
      "fallbackBin injects no identifiable cmux PATH entry itself, but sanitization still fires whenever the real host PATH already carries one (e.g. running inside cmux.app)"
    );

    const guardEvidenceDir = path.join(guardContext.control_evidence_root, guardContext.dispatch_id);
    const guardTerminal = terminalReceiptForContext(guardContext);
    assert.equal(guardTerminal?.record.outcome_group, "spawn_or_probe_failure");
    assert.equal(guardTerminal?.record.process_spawned, false);
    assert.equal(guardTerminal?.record.lifecycle_phase, "pre_spawn_known_terminal");
    assert.equal(guardTerminal?.record.process_close_observed, false);
    assert.equal(guardTerminal?.record.transport_cleanup_confirmed, true);
    assert.equal(guardTerminal?.record.invocation_claim_sha256, null);
    assert.equal(existsSync(path.join(guardEvidenceDir, "invocation-claim.json")), false);

    const disappearingBin = path.join(dir, "disappearing-bin");
    mkdirSync(disappearingBin, { recursive: true });
    const disappearingTool = writeFakeClaude(disappearingBin);
    const pathBearingFailure = renderHandoff(dir);
    const pathBearingResult = await runProjection(pathBearingFailure.contextPath, {
      executableDiscoveryOptions: {
        pathValue: disappearingBin,
        realpathSyncImpl(candidate) {
          const resolved = realpathSync(candidate);
          rmSync(resolved);
          return resolved;
        },
      },
    });
    assert.equal(pathBearingResult.status, "blocked");
    assert.equal(pathBearingResult.classification, "probe_evidence_unavailable");
    const pathBearingTerminal = terminalReceiptForContext(pathBearingFailure.context);
    const pathBearingProbe = JSON.parse(readFileSync(
      pathBearingFailure.context.cli_probe_result_path,
      "utf8",
    ));
    assert.equal(
      pathBearingProbe.command_summaries.every((summary) => summary.command.startsWith("claude ")),
      true,
    );
    assert.equal(
      pathBearingProbe.command_summaries.every((summary) => summary.error === "probe command failed"),
      true,
    );
    for (const [surface, content] of [
      ["returned result", JSON.stringify(pathBearingResult)],
      ["activity", readFileSync(pathBearingFailure.context.activity_log_path, "utf8")],
      ["heartbeat", readFileSync(pathBearingFailure.context.heartbeat_path, "utf8")],
      ["reviewer stdout", readFileSync(pathBearingFailure.context.stdout_log_path, "utf8")],
      ["reviewer stderr", readFileSync(pathBearingFailure.context.stderr_log_path, "utf8")],
      ["probe", readFileSync(pathBearingFailure.context.cli_probe_result_path, "utf8")],
      ["terminal receipt", readFileSync(pathBearingTerminal.path, "utf8")],
    ]) {
      assert.equal(content.includes(disappearingTool), false, surface);
      assert.doesNotMatch(content, /spawnSync .* ENOENT/, surface);
    }

    const thrownFailure = renderHandoff(dir);
    const thrownPathError = new Error(`spawn ${directTool} EACCES`);
    thrownPathError.code = "EACCES";
    const thrownResult = await runProjection(thrownFailure.contextPath, {
      executableDiscoveryOptions: { pathValue: directBin },
      probeOptions: {
        runCommand() {
          throw thrownPathError;
        },
      },
    });
    assert.equal(thrownResult.classification, "probe_evidence_unavailable");
    const thrownTerminal = terminalReceiptForContext(thrownFailure.context);
    for (const [surface, content] of [
      ["returned result", JSON.stringify(thrownResult)],
      ["activity", readFileSync(thrownFailure.context.activity_log_path, "utf8")],
      ["heartbeat", readFileSync(thrownFailure.context.heartbeat_path, "utf8")],
      ["reviewer stdout", readFileSync(thrownFailure.context.stdout_log_path, "utf8")],
      ["reviewer stderr", readFileSync(thrownFailure.context.stderr_log_path, "utf8")],
      ["probe", readFileSync(thrownFailure.context.cli_probe_result_path, "utf8")],
      ["terminal receipt", readFileSync(thrownTerminal.path, "utf8")],
    ]) {
      assert.equal(content.includes(directTool), false, surface);
      assert.equal(content.includes(thrownPathError.message), false, surface);
    }
  });
});

test("run-second-reviewer-projection owns ack, probe, CLI streaming, and heartbeat", () => {
  withTempDir("second-review-runner-", (dir) => {
    const binDir = path.join(dir, "bin");
    const directBin = path.join(dir, "direct-bin");
    const authPreflightLog = path.join(dir, "auth-preflight-args.log");
    const reviewerInvocationLog = path.join(dir, "reviewer-invocation-args.log");
    const executableIdentityLog = path.join(dir, "executable-identity.log");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(directBin, { recursive: true });
    const directTool = writeFakeClaude(directBin);
    const pathTool = path.join(binDir, "claude");
    symlinkSync(directTool, pathTool);
    writeWindowsExecutableResolverMarker(pathTool);
    const { context } = renderHandoff(dir);

    const reviewerArgsBefore = structuredClone(context.reviewer_cli_recipe.required_invocation_args);
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_AUTH_PREFLIGHT_LOG: authPreflightLog,
      DEVPRO_FAKE_REVIEWER_INVOCATION_LOG: reviewerInvocationLog,
      DEVPRO_FAKE_EXECUTABLE_IDENTITY_LOG: executableIdentityLog,
    });
    assert.equal(result.status, 0, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "finished");
    assert.equal(stdout.classification, "reviewer_cli_completed");
    assert.equal(stdout.sticky.status, "skipped");

    const events = activityEvents(context.activity_log_path);
    assert.equal(events.filter((event) => event === "projection_handoff_validated").length, 1);
    assert.ok(events.indexOf("projection_handoff_validated") > events.indexOf("packet_rendered"));
    assert.ok(events.indexOf("projection_cli_probe_started") > events.indexOf("projection_handoff_validated"));
    assert.ok(events.indexOf("projection_cli_probe_result") > events.indexOf("projection_cli_probe_started"));
    assert.ok(events.indexOf("projection_cli_starting") > events.indexOf("projection_cli_probe_result"));
    assert.ok(events.indexOf("projection_cli_started") > events.indexOf("projection_cli_starting"));
    assert.ok(events.includes("projection_cli_tool_surface_verified"));
    assert.ok(events.indexOf("projection_cli_exited") > events.indexOf("projection_cli_started"));
    assert.ok(events.includes("projection_sticky_verification_skipped"));
    assert.equal(events.includes("projection_sticky_write_attempt_observed"), false);

    const probe = JSON.parse(readFileSync(context.cli_probe_result_path, "utf8"));
    assert.equal(probe.classification, "flags_supported");
    assert.equal(probe.command_summaries.every((summary) => summary.stdout_bytes > 0), true);
    assert.equal(probe.auth_preflight.classification, "reviewer_host_capability_verified");
    assert.equal("output_sha256" in probe.auth_preflight.command_summary, false);
    assert.equal(readFileSync(authPreflightLog, "utf8").trim(), "auth status --json");
    const executableIdentities = readFileSync(executableIdentityLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    assert.deepEqual(new Set(executableIdentities.map(([kind]) => kind)), new Set([
      "help",
      "auth",
      "reviewer",
    ]));
    assert.deepEqual(
      new Set(executableIdentities.map(([, executable]) => executable)),
      new Set([realpathSync(directTool)])
    );
    assert.deepEqual(context.reviewer_cli_recipe.required_invocation_args, reviewerArgsBefore);
    assert.equal(
      readFileSync(reviewerInvocationLog, "utf8").trim(),
      context.reviewer_cli_recipe.required_invocation_args.join(" ").trimEnd()
    );

    const reviewerStdout = readFileSync(context.stdout_log_path, "utf8");
    const reviewerStderr = readFileSync(context.stderr_log_path, "utf8");
    assert.match(reviewerStdout, /"cross":"1"/);
    assert.match(reviewerStdout, /"input_bytes":/);
    const reviewerEvent = parseNdjsonObjects(reviewerStdout).find(
      (event) => event.type === "assistant"
    );
    assert.equal(
      reviewerEvent.cwd,
      path.join(realpathSync(path.dirname(context.neutral_cwd_path)), path.basename(context.neutral_cwd_path))
    );
    assert.match(reviewerStdout, /"gh_repo":"devpro\/example"/);
    assert.match(reviewerStdout, /"review_pr":"none"/);
    assert.equal(path.dirname(context.neutral_cwd_path), path.resolve(tmpdir()));
    assert.equal(existsSync(context.neutral_cwd_path), false);
    assert.match(reviewerStderr, /fake stderr line/);

    const heartbeat = JSON.parse(readFileSync(context.heartbeat_path, "utf8"));
    assert.equal(heartbeat.status, "finished");
    assert.equal(heartbeat.classification, "reviewer_cli_completed");
    assert.ok(heartbeat.cli_exit.stdout_bytes > 0);
    assert.ok(heartbeat.cli_exit.stderr_bytes > 0);
    for (const [surface, content] of [
      ["runner stdout", result.stdout],
      ["activity", readFileSync(context.activity_log_path, "utf8")],
      ["heartbeat", readFileSync(context.heartbeat_path, "utf8")],
      ["reviewer stdout", readFileSync(context.stdout_log_path, "utf8")],
      ["reviewer stderr", readFileSync(context.stderr_log_path, "utf8")],
      ["probe", readFileSync(context.cli_probe_result_path, "utf8")],
    ]) {
      assert.equal(content.includes(realpathSync(directTool)), false, surface);
    }
  });
});

test("cli_exit carries whitelisted convergence telemetry and no new activity event", () => {
  withTempDir("second-review-runner-convergence-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);

    const result = runGeneratedRunnerCommand(context, binDir);
    assert.equal(result.status, 0, result.stderr);

    const records = readFileSync(context.activity_log_path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const exited = records.filter((record) => record.event === "projection_cli_exited");
    assert.equal(exited.length, 1);

    const convergence = exited[0].reviewer_transport_convergence;
    assert.deepEqual(Object.keys(convergence).sort(), [
      "eligible",
      "escalated",
      "grace_ms",
      "outcome",
      "probes",
      "settle_ms",
      "signals",
    ]);
    if (process.platform === "win32") {
      assert.deepEqual(convergence, {
        eligible: false,
        outcome: null,
        probes: 0,
        signals: [],
        escalated: false,
        grace_ms: null,
        settle_ms: null,
      });
    } else {
      assert.equal(convergence.eligible, true);
      assert.equal(convergence.escalated, false);
      assert.equal(convergence.outcome, "already_clean");
      assert.equal(convergence.probes, 1);
      assert.deepEqual(convergence.signals, []);
    }

    // No pid, no absolute path, no raw error text may ride along, and the
    // convergence must not have introduced an activity event type of its own —
    // the pr-sticky terminal order is a fixed sequence that fails closed on any
    // extra event.
    assert.doesNotMatch(JSON.stringify(convergence), /pid|\/Users\/|\/private\/|\/tmp\//);
    assert.equal(records.some((record) => record.event === "projection_transport_converged"), false);

    const heartbeat = JSON.parse(readFileSync(context.heartbeat_path, "utf8"));
    assert.deepEqual(heartbeat.cli_exit.reviewer_transport_convergence, convergence);
  });
});

test("run-second-reviewer-projection blocks restricted-HOME auth evidence before claim or spawn", () => {
  withTempDir("second-review-runner-restricted-home-", (dir) => {
    const binDir = path.join(dir, "bin");
    const restrictedHome = path.join(dir, "restricted-home");
    const authPreflightLog = path.join(dir, "auth-preflight-args.log");
    const reviewerInvocationLog = path.join(dir, "reviewer-invocation-args.log");
    const secret = "user@example.test org-secret account-42 token-secret";
    mkdirSync(binDir, { recursive: true });
    mkdirSync(restrictedHome, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);

    const result = runGeneratedRunnerCommand(context, binDir, {
      HOME: restrictedHome,
      DEVPRO_FAKE_AUTH_PREFLIGHT_FAILURE: "1",
      DEVPRO_FAKE_AUTH_PREFLIGHT_SECRET: secret,
      DEVPRO_FAKE_AUTH_PREFLIGHT_LOG: authPreflightLog,
      DEVPRO_FAKE_REVIEWER_INVOCATION_LOG: reviewerInvocationLog,
    });

    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "reviewer_host_surface_unverified");
    assert.equal(readFileSync(authPreflightLog, "utf8").trim(), "auth status --json");
    assert.equal(existsSync(reviewerInvocationLog), false);
    assert.equal(
      existsSync(path.join(context.control_evidence_root, context.dispatch_id, "invocation-claim.json")),
      false
    );
    assert.equal(existsSync(context.neutral_cwd_path), false);

    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal?.record.classification, "reviewer_host_surface_unverified");
    assert.equal(terminal?.record.process_spawned, false);
    assert.equal(terminal?.record.invocation_claim_sha256, null);
    const events = activityEvents(context.activity_log_path);
    assert.equal(events.includes("projection_neutral_cwd_materialized"), false);
    assert.equal(events.includes("projection_dispatch_invocation_claimed"), false);
    assert.equal(events.includes("projection_cli_starting"), false);
    assert.equal(events.includes("projection_cli_started"), false);

    const probe = JSON.parse(readFileSync(context.cli_probe_result_path, "utf8"));
    assert.equal(probe.auth_preflight.classification, "reviewer_host_surface_unverified");
    assert.equal("output_sha256" in probe.auth_preflight.command_summary, false);
    const persisted = [
      result.stdout,
      result.stderr,
      readFileSync(context.cli_probe_result_path, "utf8"),
      readFileSync(context.activity_log_path, "utf8"),
      readFileSync(context.heartbeat_path, "utf8"),
      readFileSync(context.stdout_log_path, "utf8"),
      readFileSync(context.stderr_log_path, "utf8"),
      readFileSync(terminal.path, "utf8"),
    ].join("\n");
    for (const forbidden of [
      secret,
      "user@example.test",
      restrictedHome,
      createHash("sha256").update(secret).digest("hex"),
    ]) {
      assert.equal(persisted.includes(forbidden), false, forbidden);
    }
  });
});

test("run-second-reviewer-projection classifies the same bounded terminal evidence after a 10 MB log", () => {
  for (const paddingLineCount of ["0", "10000"]) {
    withTempDir(`second-review-runner-rate-limit-${paddingLineCount}-`, (dir) => {
      const context = {
        mode: "audit-only",
        head_ref_oid: "none",
        reviewer_cli_recipe: { tool: "claude" },
        stdout_log_path: path.join(dir, "reviewer-stdout.ndjson"),
        stderr_log_path: path.join(dir, "reviewer-stderr.ndjson"),
      };
      const terminal = {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "api_error",
        status: 429,
      };
      const padding = "x".repeat(1000);
      const paddingLines = Array.from(
        { length: Number(paddingLineCount) },
        (_, index) => JSON.stringify({ type: "assistant", index, padding })
      ).join("\n");
      writeFileSync(
        context.stdout_log_path,
        [
          JSON.stringify({
            type: "system",
            subtype: "init",
            tools: [],
            apiKeySource: "none",
          }),
          paddingLines,
          JSON.stringify(terminal),
        ].filter(Boolean).join("\n") + "\n"
      );
      writeFileSync(context.stderr_log_path, "");

      const classification = classifyReviewerCliForTest(
        context,
        __testReviewerClassification.extractBoundedTerminalEvidence(context),
        1
      );
      assert.equal(classification, "claude_reviewer_provider_rate_limited");
      assert.notEqual(classification, "claude_reviewer_authentication_failed");
    });
  }
});

test("run-second-reviewer-projection completes a valid current PASS despite an allowed rate-limit status event", () => {
  withTempDir("second-review-runner-pass-with-allowed-rate-limit-event-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const currentSha = "abcdef1234567890";
    const { context } = renderHandoff(dir, { ...auditHandoff, head_ref_oid: currentSha });
    const completion = {
      sticky_comment_url: "none",
      verdict: "PASS",
      last_reviewed_sha: currentSha,
      reviewer_model: "claude-test",
      reason: "No blocking findings.",
    };

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: [
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            overageStatus: "rejected",
          },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 986033,
          result: JSON.stringify(completion),
        }),
      ].join("\n"),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_cli_completed");
  });
});

test("run-second-reviewer-projection completes a valid current WARN reason despite allowed rate telemetry", () => {
  const currentSha = "abcdef1234567890";
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext({ head_ref_oid: currentSha }),
    {
      stdoutStructuredEvents: [
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", overageStatus: "rejected" },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify({
            sticky_comment_url: "none",
            verdict: "WARN",
            last_reviewed_sha: currentSha,
            reviewer_model: "claude-test",
            reason: "One bounded follow-up remains.",
          }),
        },
      ],
    }
  );
  assert.equal(classification, "reviewer_cli_completed");
  assert.notEqual(classification, "claude_reviewer_provider_rate_limited");
});

test("run-second-reviewer-projection completes a valid current WARN with real nested allowed rate telemetry", () => {
  const currentSha = "abcdef1234567890";
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext({ head_ref_oid: currentSha }),
    {
      stdoutStructuredEvents: [
        {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            overageStatus: "rejected",
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify({
            sticky_comment_url: "none",
            verdict: "WARN",
            last_reviewed_sha: currentSha,
            reviewer_model: "claude-test",
            reason: "One bounded follow-up remains.",
          }),
        },
      ],
    }
  );
  assert.equal(classification, "reviewer_cli_completed");
  assert.notEqual(classification, "claude_reviewer_provider_rate_limited");
});

test("run-second-reviewer-projection lets valid exit-zero PASS and WARN outrank pre-terminal rate telemetry", () => {
  const currentSha = "abcdef1234567890";
  const classificationContext = claudeClassificationContext({ head_ref_oid: currentSha });
  const cases = [
    ["allowed-warning-warn", { status: "allowed_warning" }, "WARN"],
    ["rejected-pass", { status: "rejected" }, "PASS"],
    ["unknown-warn", { status: "unknown" }, "WARN"],
  ];
  for (const [name, rateLimitInfo, verdict] of cases) {
    const terminal = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({
        sticky_comment_url: "none",
        verdict,
        last_reviewed_sha: currentSha,
        reviewer_model: "claude-test",
        reason: verdict === "PASS" ? "No blocking findings." : "One bounded follow-up remains.",
      }),
    };
    const classification = classifyReviewerCliEventsForTest(
      classificationContext,
      {
        stdoutStructuredEvents: [
          { type: "rate_limit_event", rate_limit_info: rateLimitInfo },
          terminal,
        ],
      }
    );
    assert.equal(classification, "reviewer_cli_completed", name);
  }

  withTempDir("second-review-runner-rejected-pass-with-valid-completion-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir, { ...auditHandoff, head_ref_oid: currentSha });
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: [
        JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify({
            sticky_comment_url: "none",
            verdict: "PASS",
            last_reviewed_sha: currentSha,
            reviewer_model: "claude-test",
            reason: "No blocking findings.",
          }),
        }),
      ].join("\n"),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_cli_completed");
  });
});

test("run-second-reviewer-projection treats authentication-like WARN reason text as opaque reviewer data", () => {
  const currentSha = "abcdef1234567890";
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext({ head_ref_oid: currentSha }),
    {
      stdoutStructuredEvents: [{
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          sticky_comment_url: "none",
          verdict: "WARN",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: "Finding references the literal claude_reviewer_authentication_failed classification.",
        }),
      }],
    }
  );
  assert.equal(classification, "reviewer_cli_completed");
  assert.notEqual(classification, "claude_reviewer_authentication_failed");
});

test("run-second-reviewer-projection ignores auth-looking reviewer message events as data", () => {
  const currentSha = "abcdef1234567890";
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext({ head_ref_oid: currentSha }),
    {
      stdoutStructuredEvents: [
        {
          type: "assistant",
          message: "Reviewed authentication_failed, Not logged in, and Please run /login as inert subject matter.",
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify({
            sticky_comment_url: "none",
            verdict: "WARN",
            last_reviewed_sha: currentSha,
            reviewer_model: "claude-test",
            reason: "One bounded authentication-classifier follow-up remains.",
          }),
        },
      ],
    }
  );
  assert.equal(classification, "reviewer_cli_completed");
  assert.notEqual(classification, "claude_reviewer_authentication_failed");
});

test("run-second-reviewer-projection does not let an accepted completion override auth control evidence", () => {
  const currentSha = "abcdef1234567890";
  const terminalResult = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      sticky_comment_url: "none",
      verdict: "PASS",
      last_reviewed_sha: currentSha,
      reviewer_model: "claude-test",
      reason: "No blocking findings.",
    }),
  };
  const classificationContext = claudeClassificationContext({ head_ref_oid: currentSha });
  const authDiagnostics = [
    ["typed", { terminal_reason: "authentication_failed" }],
    ["typed pre-terminal", [{ type: "error", status: 401 }]],
    ["unstructured", "Not logged in. Please run /login."],
  ];
  for (const [name, authDiagnostic] of authDiagnostics) {
    const terminal = typeof authDiagnostic === "object" && !Array.isArray(authDiagnostic)
      ? { ...terminalResult, ...authDiagnostic }
      : terminalResult;
    const classification = classifyReviewerCliEventsForTest(
      classificationContext,
      {
        stdoutStructuredEvents: [
          ...(Array.isArray(authDiagnostic) ? authDiagnostic : []),
          terminal,
        ],
        stdoutText: typeof authDiagnostic === "string" ? authDiagnostic : "",
      }
    );
    assert.equal(classification, "claude_reviewer_authentication_failed", name);
  }

  withTempDir("second-review-runner-accepted-completion-with-typed-auth-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir, { ...auditHandoff, head_ref_oid: currentSha });
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        ...terminalResult,
        terminal_reason: "authentication_failed",
      }),
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).classification,
      "claude_reviewer_authentication_failed"
    );
  });
});

test("run-second-reviewer-projection accepts Claude success with an explicit empty permission-denials array", () => {
  const currentSha = "abcdef1234567890";
  withSharedAuditRunnerFixture(({ binDir, context }) => {
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: [
        JSON.stringify({
          type: "system",
          subtype: "status",
          status: "requesting",
          uuid: "status-requesting-1",
          session_id: "session-empty-denials-1",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          api_error_status: null,
          uuid: "result-empty-denials-1",
          session_id: "session-empty-denials-1",
          permission_denials: [],
          terminal_reason: "completed",
          result: JSON.stringify({
            sticky_comment_url: "none",
            verdict: "PASS",
            last_reviewed_sha: currentSha,
            reviewer_model: "claude-test",
            reason: "No blocking findings.",
          }),
        }),
      ].join("\n"),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_cli_completed");
  }, {
    handoff: { ...auditHandoff, head_ref_oid: currentSha },
    fixtureKey: "current-sha",
  });
});

test("run-second-reviewer-projection fails closed on empty permission denials without approved result identity", () => {
  const currentSha = "abcdef1234567890";
  withSharedAuditRunnerFixture(({ binDir, context }) => {
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        permission_denials: [],
        terminal_reason: "completed",
        result: JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        }),
      }),
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_orchestration_unknown");
  }, {
    handoff: { ...auditHandoff, head_ref_oid: currentSha },
    fixtureKey: "current-sha",
  });
});

test("run-second-reviewer-projection lets approved typed permission denial override completion and fresh sticky", () => {
  withTempDir("second-review-runner-typed-permission-denial-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const ghLog = path.join(dir, "gh.log");
    const evidenceRoot = path.join(dir, "control-evidence");
    const evidenceEnv = { DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot };
    const { context } = renderHandoff(dir, prStickyHandoff, evidenceEnv);
    const sentinel = "SECRET_PERMISSION_SENTINEL_DO_NOT_PERSIST";
    const stickyReasonSentinel = "SECRET_STICKY_REASON_SENTINEL_DO_NOT_PERSIST";
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      ...evidenceEnv,
      DEVPRO_FAKE_GH_LOG: ghLog,
      DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponseWithBody([
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        `dispatch_id: ${context.dispatch_id}`,
        `reason: ${stickyReasonSentinel}`,
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n")),
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        uuid: "result-typed-denial-1",
        session_id: "session-typed-denial-1",
        permission_denials: [{
          tool_name: "Write",
          tool_use_id: "toolu-write-denied-1",
          tool_input: { command: `gh pr comment 1658 --body ${sentinel}` },
        }],
        result: JSON.stringify({
          sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242",
          verdict: "PASS",
          last_reviewed_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        }),
      }),
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_orchestration_permission_denied");
    assert.match(result.stdout, /"evidence_provenance":"provider_typed_event"/);
    assert.match(result.stdout, /"evidence_confidence":"high"/);
    assert.match(result.stdout, /"matcher_id":"[^"\r\n]{1,128}"/);
    assert.doesNotMatch(result.stdout, new RegExp(sentinel));
    assert.doesNotMatch(result.stdout, new RegExp(stickyReasonSentinel));
    assert.equal(Object.hasOwn(output, "fault_capsule_path"), false, "terminal handoff must not expose a local capsule path");

    const capsulePath = path.join(evidenceRoot, context.dispatch_id, "fault-capsule.json");
    assert.equal(existsSync(capsulePath), true, "orchestration fault must persist its current-dispatch capsule");
    const capsuleBytes = readFileSync(capsulePath);
    assert.ok(Buffer.byteLength(capsuleBytes) <= 16 * 1024);
    const capsule = JSON.parse(capsuleBytes);
    assert.equal(capsule.schema, "devpro-second-review-fault-capsule/v1");
    assert.equal(capsule.dispatch_id, context.dispatch_id);
    assert.equal(capsule.classification, "reviewer_orchestration_permission_denied");

    const controlArtifacts = readdirSync(dir, { recursive: true })
      .filter((name) => /(?:\.json|\.ndjson)$/.test(name))
      .filter((name) => !/(?:reviewer-stdout|reviewer-stderr)/.test(name))
      .map((name) => readFileSync(path.join(dir, name), "utf8"))
      .join("\n");
    assert.doesNotMatch(controlArtifacts, new RegExp(sentinel));
    assert.doesNotMatch(controlArtifacts, new RegExp(stickyReasonSentinel));
    for (const excerpt of deepValuesForKey(output, "redacted_excerpt")) {
      assert.ok(Buffer.byteLength(String(excerpt), "utf8") <= 512, "terminal excerpt must stay within 512 bytes");
    }

    const ghCommands = readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean);
    assert.deepEqual(
      ghCommands,
      expectedPrStickyVerifiedReadCommands,
      "orchestration faults may read authority and verify the candidate but must not write a reviewer verdict sticky"
    );
  });
});

test("run-second-reviewer-projection lets approved typed permission denial override reviewer-owned UNAVAILABLE", () => {
  withTempDir("second-review-runner-typed-permission-denial-unavailable-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const evidenceEnv = {
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(dir, "control-evidence"),
    };
    const { context } = renderHandoff(dir, auditHandoff, evidenceEnv);
    const systemMessageSentinel = "SECRET_SYSTEM_DENIAL_MESSAGE_DO_NOT_PERSIST";
    const result = runGeneratedRunnerCommand(context, binDir, {
      ...evidenceEnv,
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: [
        JSON.stringify({
          type: "system",
          subtype: "permission_denied",
          tool_name: "Read",
          tool_use_id: "toolu-read-denied-1",
          message: systemMessageSentinel,
          uuid: "system-typed-denial-1",
          session_id: "session-typed-denial-2",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify({
            sticky_comment_url: "none",
            verdict: "UNAVAILABLE",
            last_reviewed_sha: "none",
            reviewer_model: "claude-test",
            reason: "Reviewer could not read required material.",
          }),
        }),
      ].join("\n"),
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).classification,
      "reviewer_orchestration_permission_denied"
    );
    assert.doesNotMatch(result.stdout, new RegExp(systemMessageSentinel));
  });
});

test("run-second-reviewer-projection maps unapproved denial candidates to unknown before completion or UNAVAILABLE", () => {
  const completionVerdicts = ["PASS", "UNAVAILABLE"];
  const classificationContext = claudeClassificationContext();
  for (const verdict of completionVerdicts) {
    const terminal = {
      type: "result",
      subtype: "success",
      is_error: false,
      permission_denials: "ambiguous-unapproved-shape",
      result: JSON.stringify({
        sticky_comment_url: "none",
        verdict,
        last_reviewed_sha: "none",
        reviewer_model: "claude-test",
        reason: verdict === "PASS"
          ? "No blocking findings."
          : "Reviewer could not complete the requested operation.",
      }),
    };
    const classification = classifyReviewerCliEventsForTest(
      classificationContext,
      { stdoutStructuredEvents: [terminal] }
    );
    assert.equal(classification, "reviewer_orchestration_unknown", verdict);
  }

  withTempDir("second-review-runner-unknown-denial-pass-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        permission_denials: "ambiguous-unapproved-shape",
        result: JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: "none",
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        }),
      }),
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_orchestration_unknown");
    assert.match(result.stdout, /"evidence_provenance":"provider_candidate_unmatched"/);
    assert.match(result.stdout, /"evidence_confidence":"indeterminate"/);
  });
});

test("run-second-reviewer-projection lets an unapproved denial candidate override a fresh sticky", () => {
  withTempDir("second-review-runner-unknown-denial-fresh-sticky-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const evidenceEnv = {
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(dir, "control-evidence"),
    };
    const { context } = renderHandoff(dir, prStickyHandoff, evidenceEnv);
    const result = runGeneratedRunnerCommand(context, binDir, {
      ...evidenceEnv,
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponseWithBody([
        "<!-- cross-model-second-opinion:sticky -->",
        "verdict: PASS",
        "last_reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        `dispatch_id: ${context.dispatch_id}`,
        "reason: Current-head candidate sticky.",
        `Rules: v${SECOND_REVIEW_RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
      ].join("\n")),
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        permission_denials: { unknown_provider_shape: true },
        result: JSON.stringify({
          sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4243",
          verdict: "PASS",
          last_reviewed_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          reviewer_model: "claude-test",
          reason: "Candidate completion that must not override an orchestration candidate.",
        }),
      }),
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_orchestration_unknown");
  });
});

test("run-second-reviewer-projection claims the renderer reservation once and never creates a second dispatch directory", () => {
  withTempDir("second-review-runner-dispatch-claim-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const argsLog = path.join(dir, "reviewer-args.log");
    const evidenceRoot = path.join(dir, "control-evidence");
    const evidenceEnv = { DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot };
    const { context } = renderHandoff(dir, auditHandoff, evidenceEnv);
    assert.match(
      context.dispatch_id,
      /^[\x21-\x7e]{1,128}$/,
      "runner claim fixture requires the renderer-owned current dispatch"
    );

    const first = runGeneratedRunnerCommand(context, binDir, {
      ...evidenceEnv,
      DEVPRO_FAKE_REVIEWER_ARGS_LOG: argsLog,
    });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(
      readdirSync(evidenceRoot).sort(),
      [".usage-manifest-retention", context.dispatch_id].sort(),
    );
    assert.deepEqual(
      readdirSync(evidenceRoot).filter((entry) => !entry.startsWith(".")),
      [context.dispatch_id],
      "the retention inventory must not appear as a second visible dispatch directory",
    );
    const reservationDir = path.join(evidenceRoot, context.dispatch_id);
    assert.equal(existsSync(path.join(reservationDir, "dispatch.json")), true);
    assert.equal(existsSync(path.join(reservationDir, "invocation-claim.json")), true);
    const firstInvocation = readFileSync(argsLog, "utf8");

    const duplicate = runGeneratedRunnerCommand(context, binDir, {
      ...evidenceEnv,
      DEVPRO_FAKE_REVIEWER_ARGS_LOG: argsLog,
    });
    assert.equal(duplicate.status, 1, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).classification, "reviewer_dispatch_identity_collision");
    assert.doesNotMatch(JSON.parse(duplicate.stdout).error, /abandon-interrupted/, "a closed attempt has nothing to abandon");
    assert.equal(readFileSync(argsLog, "utf8"), firstInvocation, "duplicate claim must fail before reviewer spawn");
    assert.deepEqual(
      readdirSync(evidenceRoot).sort(),
      [".usage-manifest-retention", context.dispatch_id].sort(),
    );
    assert.deepEqual(
      readdirSync(evidenceRoot).filter((entry) => !entry.startsWith(".")),
      [context.dispatch_id],
      "a duplicate dispatch claim must not create a second visible dispatch directory",
    );
  });
});

test("run-second-reviewer-projection treats truncated and near-match denial evidence as unknown without a plaintext approval matcher", () => {
  const cases = [
    {
      name: "truncated",
      env: { DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT: '{"permission_denials":[{"tool_name":"Write"}' },
      evidence: { stdoutText: '{"permission_denials":[{"tool_name":"Write"}' },
    },
    {
      name: "near-match",
      env: { DEVPRO_FAKE_REVIEWER_STDERR_LINE: "permission_denials maybe requires approval for Write" },
      evidence: { stderrText: "permission_denials maybe requires approval for Write" },
    },
  ];
  for (const { name, evidence } of cases) {
    const classification = classifyReviewerCliEventsForTest(
      claudeClassificationContext(),
      { ...evidence, code: 1 }
    );
    assert.equal(classification, "reviewer_orchestration_unknown", name);
  }

  const subprocessCase = cases[0];
  withTempDir(`second-review-runner-${subprocessCase.name}-denial-candidate-`, (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    const result = runGeneratedRunnerCommand(context, binDir, subprocessCase.env);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_orchestration_unknown");
  });
});

test("run-second-reviewer-projection keeps wrapper tool-surface hard faults above denial evidence", () => {
  withTempDir("second-review-runner-wrapper-precedes-denial-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_EVENT: JSON.stringify({
        type: "system",
        subtype: "init",
        tools: ["Write"],
        permission_denials: [{
          tool_name: "Bash",
          tool_use_id: "toolu-init-denied-1",
          tool_input: { command: "gh api" },
        }],
      }),
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_tool_surface_mismatch");
  });
});

test("run-second-reviewer-projection treats nested allowed_warning as informational without a completion", () => {
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext(),
    {
      stdoutStructuredEvents: [{
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning" },
      }],
      terminal: null,
      code: 1,
    }
  );
  assert.equal(classification, "reviewer_cli_failed");
});

test("run-second-reviewer-projection treats a flat allowed status as unknown blocking rate evidence", () => {
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext(),
    {
      stdoutStructuredEvents: [{
        type: "rate_limit_event",
        status: "allowed",
      }],
      terminal: null,
      code: 1,
    }
  );
  assert.equal(classification, "claude_reviewer_provider_rate_limited");
});

test("run-second-reviewer-projection classifies nested rejected rate evidence without a terminal result", () => {
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext(),
    {
      stdoutStructuredEvents: [{
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected" },
      }],
      terminal: null,
      code: 1,
    }
  );
  assert.equal(classification, "claude_reviewer_provider_rate_limited");
});

test("run-second-reviewer-projection gives blocking rate evidence precedence over auth-like diagnostics", () => {
  const authDiagnostics = [
    ["unstructured", { stdoutText: "Not logged in. Please run /login." }],
    ["typed", {
      stdoutStructuredEvents: [{
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "authentication_failed",
      }],
    }],
  ];
  for (const [name, authDiagnostic] of authDiagnostics) {
    const classification = classifyReviewerCliEventsForTest(
      claudeClassificationContext(),
      {
        stdoutStructuredEvents: [
          {
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected" },
          },
          ...(authDiagnostic.stdoutStructuredEvents ?? []),
        ],
        stdoutText: authDiagnostic.stdoutText ?? "",
        code: 1,
      }
    );
    assert.equal(classification, "claude_reviewer_provider_rate_limited", name);
  }

  withTempDir("second-review-runner-rate-before-unstructured-auth-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: [
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected" },
        }),
        "Not logged in. Please run /login.",
      ].join("\n"),
      DEVPRO_FAKE_REVIEWER_EXIT_CODE: "1",
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).classification,
      "claude_reviewer_provider_rate_limited"
    );
  });
});

test("run-second-reviewer-projection classifies missing or blank completion reason stably", () => {
  for (const [name, reason] of [["missing", undefined], ["blank", " \t "]]) {
    const completion = {
      sticky_comment_url: "none",
      verdict: "WARN",
      last_reviewed_sha: "none",
      reviewer_model: "claude-test",
    };
    if (reason !== undefined) completion.reason = reason;
    const terminal = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(completion),
    };
    const classification = classifyReviewerCliEventsForTest(
      claudeClassificationContext(),
      {
        stdoutStructuredEvents: [
          {
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed" },
          },
          terminal,
        ],
      }
    );
    assert.equal(classification, "reviewer_completion_reason_missing", name);
  }

  withSharedAuditRunnerFixture(({ binDir, context }) => {
    const completion = {
      sticky_comment_url: "none",
      verdict: "WARN",
      last_reviewed_sha: "none",
      reviewer_model: "claude-test",
    };
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: [
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed" },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify(completion),
        }),
      ].join("\n"),
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).classification,
      "reviewer_completion_reason_missing"
    );
  });
});

test("run-second-reviewer-projection keeps UNAVAILABLE plus rate-limit evidence provider-blocked", () => {
  const terminal = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      sticky_comment_url: "none",
      verdict: "UNAVAILABLE",
      last_reviewed_sha: "none",
      reviewer_model: "claude-test",
      reason: "Reviewer provider remained rate limited.",
    }),
  };
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext(),
    {
      stdoutStructuredEvents: [
        {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            overageStatus: "rejected",
          },
        },
        terminal,
      ],
    }
  );
  assert.equal(classification, "claude_reviewer_provider_rate_limited");
});

test("run-second-reviewer-projection preserves precise authentication classification for a true auth terminal", () => {
  const terminal = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "authentication_failed",
    result: "Not logged in. Please run /login.",
    status: 401,
  };
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext(),
    {
      stdoutStructuredEvents: [terminal],
      code: 1,
    }
  );
  assert.equal(classification, "claude_reviewer_authentication_failed");
});

test("run-second-reviewer-projection classifies typed HTTP 400 invalid recipe selectors as incompatible", () => {
  const cases = [
    {
      name: "effort",
      providerMessage: "effort 'high' is not supported when thinking is disabled",
    },
    {
      name: "thinking",
      providerMessage: "invalid thinking configuration for this request",
    },
    {
      name: "reasoning",
      providerMessage: "reasoning configuration is unsupported for this model",
    },
  ];
  for (const { name, providerMessage } of cases) {
    const terminal = {
      type: "error",
      subtype: "api_error",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 400,
      error: {
        type: "invalid_request_error",
        message: providerMessage,
      },
    };
    const classification = classifyReviewerCliEventsForTest(
      claudeClassificationContext(),
      {
        stdoutStructuredEvents: [terminal],
        code: 1,
      }
    );
    assert.equal(classification, "reviewer_cli_recipe_incompatible", name);
  }

  withTempDir("second-review-runner-incompatible-reasoning-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: "error",
        subtype: "api_error",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 400,
        error: {
          type: "invalid_request_error",
          message: "reasoning configuration is unsupported for this model",
        },
      }),
      DEVPRO_FAKE_REVIEWER_EXIT_CODE: "1",
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).classification,
      "reviewer_cli_recipe_incompatible"
    );
  });
});

test("run-second-reviewer-projection keeps incidental reasoning wording as a generic HTTP 400 failure", () => {
  const providerMessages = [
    "Unknown error occurred while reasoning about the request",
    "Invalid response received while thinking about the request",
  ];
  for (const providerMessage of providerMessages) {
    const terminal = {
      type: "error",
      subtype: "api_error",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 400,
      error: {
        type: "invalid_request_error",
        message: providerMessage,
      },
    };
    const classification = classifyReviewerCliEventsForTest(
      claudeClassificationContext(),
      {
        stdoutStructuredEvents: [terminal],
        code: 1,
      }
    );
    assert.equal(classification, "reviewer_cli_failed", providerMessage);
  }

  withSharedAuditRunnerFixture(({ binDir, context }) => {
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: "error",
        subtype: "api_error",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 400,
        error: {
          type: "invalid_request_error",
          message: providerMessages[0],
        },
      }),
      DEVPRO_FAKE_REVIEWER_EXIT_CODE: "1",
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_cli_failed");
  });
});

test("run-second-reviewer-projection preserves authentication classification for typed HTTP 403", () => {
  const terminal = {
    type: "error",
    subtype: "api_error",
    is_error: true,
    terminal_reason: "api_error",
    status: 403,
    error: {
      type: "forbidden",
      message: "Request forbidden by provider policy",
    },
  };
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext(),
    {
      stdoutStructuredEvents: [terminal],
      code: 1,
    }
  );
  assert.equal(classification, "claude_reviewer_authentication_failed");
});

test("run-second-reviewer-projection treats apiKeySource:none as neutral and a generic terminal error as failed even on exit zero", () => {
  withSharedAuditRunnerFixture(({ binDir, context }) => {
    const rawProviderMessage = "provider-detail-must-remain-sidecar-only";

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_EVENT: JSON.stringify({
        type: "system",
        subtype: "init",
        tools: ["StructuredOutput"],
        apiKeySource: "none",
      }),
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: "error",
        subtype: "api_error",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 400,
        error: { type: "invalid_request_error", message: rawProviderMessage },
      }),
      DEVPRO_FAKE_REVIEWER_EXIT_CODE: "0",
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_cli_failed");
    assert.notEqual(output.classification, "claude_reviewer_authentication_failed");
    assert.match(readFileSync(context.stdout_log_path, "utf8"), new RegExp(rawProviderMessage));
    assert.doesNotMatch(JSON.stringify(output), new RegExp(rawProviderMessage));
    assert.doesNotMatch(readFileSync(context.activity_log_path, "utf8"), new RegExp(rawProviderMessage));
    assert.doesNotMatch(readFileSync(context.heartbeat_path, "utf8"), new RegExp(rawProviderMessage));
  });
});

test("run-second-reviewer-projection recognizes nested provider authentication type", () => {
  const terminal = {
    type: "error",
    subtype: "api_error",
    is_error: true,
    error: { type: "authentication_error" },
  };
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext(),
    {
      stdoutStructuredEvents: [terminal],
      code: 1,
    }
  );
  assert.equal(classification, "claude_reviewer_authentication_failed");
});

test("run-second-reviewer-projection ignores typed auth outside the bounded complete-line tail", () => {
  withSharedAuditRunnerFixture(({ binDir, context }) => {

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_PRE_PADDING_EVENT: JSON.stringify({
        type: "error",
        error: { type: "authentication_error" },
      }),
      DEVPRO_FAKE_REVIEWER_PADDING_LINE_COUNT: "100",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_cli_completed");
  });
});

test("run-second-reviewer-projection recognizes typed authentication evidence on stderr", () => {
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext(),
    {
      stderrStructuredEvents: [{
        type: "error",
        status: 401,
      }],
      code: 1,
    }
  );
  assert.equal(classification, "claude_reviewer_authentication_failed");
});

test("run-second-reviewer-projection recognizes typed rate-limit evidence on stderr", () => {
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext(),
    {
      stderrStructuredEvents: [{
        type: "error",
        status: 429,
      }],
      code: 1,
    }
  );
  assert.equal(classification, "claude_reviewer_provider_rate_limited");
});

test("run-second-reviewer-projection drops a typed auth fragment terminated only by CR", () => {
  withSharedAuditRunnerFixture(({ binDir, context }) => {

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT: `${JSON.stringify({
        type: "error",
        status: 401,
      })}\r`,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_cli_completed");
  });
});

test("run-second-reviewer-projection ignores structured and malformed JSON-like auth prose", () => {
  const currentSha = "abc1234";
  const terminal = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      sticky_comment_url: "none",
      verdict: "PASS",
      last_reviewed_sha: currentSha,
      reviewer_model: "claude-test",
      reason: "No blocking findings.",
    }),
  };
  const classificationContext = {
    mode: "audit-only",
    head_ref_oid: currentSha,
    reviewer_cli_recipe: { tool: "claude" },
  };
  const cases = [
    {
      name: "malformed-stdout-object",
      env: { DEVPRO_FAKE_REVIEWER_PRE_PADDING_EVENT: '{"message":"Not logged in"' },
    },
    {
      name: "malformed-stdout-string",
      env: { DEVPRO_FAKE_REVIEWER_PRE_PADDING_EVENT: '"Not logged in' },
    },
    {
      name: "stdout-array",
      env: { DEVPRO_FAKE_REVIEWER_PRE_PADDING_EVENT: '["Not logged in"]' },
    },
    {
      name: "structured-stderr",
      env: {
        DEVPRO_FAKE_REVIEWER_STDERR_LINE: JSON.stringify({
          type: "assistant",
          message: "Not logged in. Please run /login.",
        }),
      },
    },
  ];

  for (const { name, env } of cases) {
    const classification = classifyReviewerCliForTest(
      classificationContext,
      boundedEvidenceForClassification({
        stdoutText: env.DEVPRO_FAKE_REVIEWER_PRE_PADDING_EVENT ?? "",
        stderrText: env.DEVPRO_FAKE_REVIEWER_STDERR_LINE ?? "",
        stdoutStructuredEvents: [terminal],
        terminal,
      })
    );
    assert.equal(classification, "reviewer_cli_completed", name);
  }

  const subprocessCoverageNames = new Set(["malformed-stdout-object", "structured-stderr"]);
  for (const { name, env } of cases.filter(({ name }) => subprocessCoverageNames.has(name))) {
    withSharedAuditRunnerFixture(({ binDir, context }) => {
      const result = runGeneratedRunnerCommand(context, binDir, env);

      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).classification, "reviewer_cli_completed", name);
    }, {
      handoff: auditHandoff,
      fixtureKey: "short-sha",
    });
  }
});

test("run-second-reviewer-projection does not treat unlisted terminal message fields as typed auth", () => {
  const terminal = {
    type: "error",
    terminal_reason: "api_error",
    error: { type: "invalid_request_error", message: "Not logged in" },
  };
  const classification = classifyReviewerCliEventsForTest(
    claudeClassificationContext(),
    {
      stdoutStructuredEvents: [terminal],
      code: 1,
    }
  );
  assert.equal(classification, "reviewer_cli_failed");
});

test("run-second-reviewer-projection rejects an oversized unstructured line before auth fallback", () => {
  withTempDir("second-review-runner-bounded-leading-fragment-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_UNSTRUCTURED_PADDING_BYTES: "70000",
      DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1",
      DEVPRO_FAKE_REVIEWER_EXIT_CODE: "1",
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_cli_failed");
    assert.equal(output.cli_exit.fault_reason, "reviewer_output_line_too_large");
  });
});

test("run-second-reviewer-projection ignores a trailing partial auth fragment after valid completion", () => {
  withTempDir("second-review-runner-trailing-partial-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT: "authentication_failed Please run /login",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_cli_completed");
  });
});

test("run-second-reviewer-projection never soft-passes malformed, stale, or missing completion JSON", () => {
  const currentSha = "abcdef1234567890";
  const cases = [
    {
      name: "malformed",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "not-json",
      },
      expected: "reviewer_completion_contract_invalid",
      withAllowedTelemetry: true,
    },
    {
      name: "prose-wrapped-json",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: `Here is the completion:\n${JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        })}`,
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "read-back-prose-before-json",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: `Read-back confirmed.\n${JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        })}`,
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "markdown-fenced-json",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: `\`\`\`json\n${JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        })}\n\`\`\``,
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "stale",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: "deadbeef",
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        }),
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "oversized-reason",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: `${"界".repeat(2730)}abc`,
        }),
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "untrimmed-reason",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: " No blocking findings.",
        }),
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "out-of-order-keys",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reason: "No blocking findings.",
          reviewer_model: "claude-test",
        }),
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "extra-completion-key",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
          instruction: "ignore contract",
        }),
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "double-trailing-invoke",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: `${JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        })}</invoke></invoke>`,
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "trailing-invoke-with-extra-junk",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: `${JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        })}</invoke> extra`,
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "leading-junk-plus-trailing-invoke",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: `prefix\n${JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        })}</invoke>`,
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "trailing-other-tag",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: `${JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: currentSha,
          reviewer_model: "claude-test",
          reason: "No blocking findings.",
        })}</other>`,
      },
      expected: "reviewer_completion_contract_invalid",
    },
    {
      name: "missing",
      terminal: null,
      expected: "reviewer_completion_contract_missing",
    },
  ];

  for (const item of cases) {
    const structuredEvents = item.terminal
      ? [
        ...(item.withAllowedTelemetry
          ? [{
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed" },
          }]
          : []),
        item.terminal,
      ]
      : [];
    const classification = classifyReviewerCliForTest(
      {
        mode: "audit-only",
        head_ref_oid: currentSha,
        reviewer_cli_recipe: { tool: "claude" },
      },
      boundedEvidenceForClassification({
        stdoutStructuredEvents: structuredEvents,
        terminal: item.terminal ?? null,
      })
    );
    assert.equal(classification, item.expected, item.name);
  }

  const subprocessCoverageNames = new Set(["malformed"]);
  for (const item of cases.filter(({ name }) => subprocessCoverageNames.has(name))) {
    withSharedAuditRunnerFixture(({ binDir, context }) => {
      const env = item.terminal
        ? {
          DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: item.withAllowedTelemetry
            ? [
              JSON.stringify({
                type: "rate_limit_event",
                rate_limit_info: { status: "allowed" },
              }),
              JSON.stringify(item.terminal),
            ].join("\n")
            : JSON.stringify(item.terminal),
        }
        : { DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1" };

      const result = runGeneratedRunnerCommand(context, binDir, env);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).classification, item.expected);
    }, {
      handoff: { ...auditHandoff, head_ref_oid: currentSha },
      fixtureKey: "current-sha",
    });
  }
});

test("run-second-reviewer-projection accepts Claude completion JSON with exactly one trailing </invoke>", () => {
  const currentSha = "abcdef1234567890";
  const completionJson = JSON.stringify({
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: currentSha,
    reviewer_model: "claude-test",
    reason: "No blocking findings.",
  });
  const variants = [
    `${completionJson}</invoke>`,
    `${completionJson}\n</invoke>\n`,
    `${completionJson} </invoke>`,
  ];

  for (const resultText of variants) {
    const terminal = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: resultText,
    };
    const classification = classifyReviewerCliForTest(
      {
        mode: "audit-only",
        head_ref_oid: currentSha,
        reviewer_cli_recipe: { tool: "claude" },
      },
      boundedEvidenceForClassification({
        stdoutStructuredEvents: [terminal],
        terminal,
      })
    );
    assert.equal(
      classification,
      "reviewer_cli_completed",
      `expected trailing </invoke> completion to classify completed, got ${classification} for ${JSON.stringify(resultText.slice(-24))}`,
    );
  }
});

test("run-second-reviewer-projection requires exact current PASS or WARN Codex completion JSONL", () => {
  const currentSha = "abcdef1234567890";
  const completion = (overrides = {}) => ({
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: currentSha,
    reviewer_model: "codex-test",
    reason: "No blocking findings.",
    ...overrides,
  });
  const event = (text) => JSON.stringify({
    type: "item.completed",
    item: { id: "item-final", type: "agent_message", text },
  });
  const cases = [
    ["pass", event(JSON.stringify(completion())), 0, "reviewer_cli_completed"],
    ["warn", event(JSON.stringify(completion({ verdict: "WARN", reason: "One bounded follow-up remains." }))), 0, "reviewer_cli_completed"],
    ["malformed", event("not-json"), 1, "reviewer_completion_contract_invalid"],
    ["stale", event(JSON.stringify(completion({ last_reviewed_sha: "deadbeef" }))), 1, "reviewer_completion_contract_invalid"],
    ["critical", event(JSON.stringify(completion({ verdict: "CRITICAL", reason: "A blocking finding remains." }))), 1, "reviewer_completion_critical"],
    ["out-of-order", event(JSON.stringify({
      sticky_comment_url: "none",
      verdict: "PASS",
      last_reviewed_sha: currentSha,
      reason: "No blocking findings.",
      reviewer_model: "codex-test",
    })), 1, "reviewer_completion_contract_invalid"],
    ["invoke-trailer", event(`${JSON.stringify(completion())}</invoke>`), 1, "reviewer_completion_contract_invalid"],
    ["missing", null, 1, "reviewer_completion_contract_missing"],
  ];

  for (const [name, terminalEvent, expectedStatus, expectedClassification] of cases) {
    const classification = classifyReviewerCliForTest(
      {
        mode: "audit-only",
        head_ref_oid: currentSha,
        reviewer_cli_recipe: { tool: "codex" },
      },
      boundedEvidenceForClassification({
        stdoutStructuredEvents: terminalEvent ? [JSON.parse(terminalEvent)] : [],
        terminal: null,
      }),
      0
    );
    assert.equal(classification, expectedClassification, name);
  }

  const subprocessCoverageNames = new Set(["pass", "warn", "critical"]);
  for (const [name, terminalEvent, expectedStatus, expectedClassification] of cases.filter(
    ([name]) => subprocessCoverageNames.has(name)
  )) {
    withTempDir(`second-review-runner-codex-${name}-completion-`, (dir) => {
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFakeCodex(binDir);
      const { context } = renderHandoff(dir, { ...codexAuditHandoff, head_ref_oid: currentSha });
      const env = terminalEvent
        ? { DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: terminalEvent }
        : { DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1" };
      const result = runGeneratedRunnerCommand(context, binDir, env);
      assert.equal(result.status, expectedStatus, `${name}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).classification, expectedClassification, name);
      const terminal = terminalReceiptForContext(context);
      const completion = completionReceiptForContext(context);
      if (expectedStatus === 0) {
        assert.equal(terminal, null, `${name}: successful completion uses completion-receipt.json`);
        assert.notEqual(completion, null, `${name}: successful audit-only completion must persist completion-receipt.json`);
        assert.equal(completion.record.schema, "devpro-second-review-completion/v2");
        assert.equal(completion.record.outcome, "reviewer_process_closed_audit_only");
        assert.equal(completion.record.classification, "audit_only_verified");
        assert.equal(completion.record.pr_number, "none");
        assert.equal(completion.record.process_close_observed, true);
        const packetReceiptPath = path.join(path.dirname(context.packet_path), "completion-receipt.json");
        assert.equal(existsSync(packetReceiptPath), true, `${name}: Scenario: Packet-local mirror / packet dir must carry completion-receipt.json`);
        assert.deepEqual(
          readFileSync(packetReceiptPath),
          readFileSync(completion.path),
          `${name}: packet-local receipt must be byte-identical to control-evidence`,
        );
        assert.equal(
          activityEvents(context.activity_log_path).includes("projection_completion_receipt_written"),
          true,
          `${name}: written activity only after packet mirror`,
        );
        assert.deepEqual(
          Object.keys(completion.record).sort(),
          [
            "schema",
            "repository_slug",
            "pr_number",
            "head_ref_oid",
            "attempt_id",
            "dispatch_id",
            "previous_dispatch_id",
            "outcome",
            "classification",
            "process_close_observed",
            "integrity_id",
          ].sort(),
        );
        assert.equal(
          Object.keys(completion.record).some((key) => key.startsWith("sticky_")),
          false,
          `${name}: audit-only receipt must omit sticky REST keys`,
        );
      } else {
        assert.equal(terminal?.record.classification, expectedClassification, name);
        assert.equal(terminal?.record.process_close_observed, true, name);
        assert.equal(completion, null, `${name}: fault path must not persist a success completion-receipt`);
      }
    });
  }
});

test("run-second-reviewer-projection samples reviewer stdout progress without polling agent lifecycle", () => {
  withTempDir("second-review-runner-liveness-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_DELAY_MS: "80",
      DEVPRO_FAKE_REVIEWER_PROGRESS_COUNT: "4",
      DEVPRO_FAKE_REVIEWER_PROGRESS_INTERVAL_MS: "35",
      DEVPRO_SECOND_REVIEW_RUNNER_STATUS_CHECKPOINT_MS: "60",
    });
    assert.equal(result.status, 0, result.stderr);

    const samples = readFileSync(context.activity_log_path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "projection_cli_liveness_sampled");
    assert.ok(samples.length >= 2, "expected periodic reviewer-stream liveness samples");
    assert.ok(samples.some((sample) => sample.stdout_delta_bytes > 0));
    for (const sample of samples) {
      assert.equal(sample.interval_ms, 50);
      assert.equal(Number.isInteger(sample.sample_index), true);
      assert.equal(Number.isInteger(sample.stdout_bytes), true);
      assert.equal(Number.isInteger(sample.stderr_bytes), true);
      assert.equal(Number.isInteger(sample.stdout_delta_bytes), true);
      assert.equal(Number.isInteger(sample.stderr_delta_bytes), true);
      assert.equal(Number.isInteger(sample.idle_duration_ms), true);
      assert.ok(sample.idle_duration_ms >= 0);
      assert.match(sample.process_started_at, /^\d{4}-\d{2}-\d{2}T/);
      if (sample.last_output_at === null) {
        assert.equal(sample.stdout_bytes, 0);
        assert.equal(sample.stderr_bytes, 0);
        assert.equal(sample.idle_reference, "process-start");
      } else {
        assert.match(sample.last_output_at, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(sample.idle_reference, "last-output");
      }
      assert.match(sample.liveness, /^(output-progress|no-output-progress)$/);
    }
    assert.ok(
      samples.some((sample) => sample.last_output_at === null),
      "pre-output samples must retain null last_output_at and process-start idle evidence"
    );
    assert.ok(
      samples.some((sample) => sample.child_open === true && sample.child_exit_observed === false),
      "at least one scheduled sample must observe the child while it is open"
    );
    assert.ok(samples.some((sample) => sample.last_output?.byte_length > 0));
    assert.ok(samples.some((sample) => sample.last_structured_output?.type));
    assert.ok(samples.every((sample) => !sample.last_output || !("preview" in sample.last_output)));
    assert.ok(samples.every((sample) => !sample.last_structured_output || !("preview" in sample.last_structured_output)));

    const checkpoint = readFileSync(context.activity_log_path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.event === "projection_cli_status_checkpoint");
    assert.equal(checkpoint.checkpoint_ms, 60);
    assert.equal(checkpoint.next_action, "continue-until-total-hard-cap");
    assert.equal(checkpoint.child_open, true);
    assert.equal(checkpoint.child_exit_observed, false);
    assert.equal(checkpoint.last_output_at, null);
    assert.equal(checkpoint.last_output, null);
    assert.equal(checkpoint.last_structured_output, null);
    assert.equal(checkpoint.idle_reference, "process-start");
    assert.equal(Number.isInteger(checkpoint.idle_duration_ms), true);
  });
});

test("run-second-reviewer-projection keeps fragmented multi-byte stderr content in sidecar-only metadata", () => {
  withTempDir("second-review-runner-stderr-preview-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_FRAGMENTED_STDERR: "1",
    });
    assert.equal(result.status, 0, result.stderr);

    const samples = readFileSync(context.activity_log_path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "projection_cli_liveness_sampled");
    const stderrSample = samples.find((sample) => (
      sample.last_output?.stream === "stderr"
      && sample.last_output?.byte_length === Buffer.byteLength("stderr 第二行", "utf8")
    ));
    assert.ok(stderrSample, "expected a liveness sample carrying stderr metadata evidence");
    assert.equal("preview" in stderrSample.last_output, false);
    assert.equal(
      stderrSample.last_output.byte_length,
      Buffer.byteLength("stderr 第二行", "utf8")
    );
    assert.match(readFileSync(context.stderr_log_path, "utf8"), /stderr 第二行/);
    assert.doesNotMatch(readFileSync(context.activity_log_path, "utf8"), /stderr 第二行/);
    assert.doesNotMatch(readFileSync(context.heartbeat_path, "utf8"), /stderr 第二行/);
  });
});

test("run-second-reviewer-projection maps unknown structured metadata to a bounded enum", () => {
  withTempDir("second-review-runner-structured-metadata-enum-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    const rawMetadataSentinel = "provider-raw-metadata-must-remain-sidecar-only";

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_EVENT: JSON.stringify({
        type: "system",
        subtype: "init",
        tools: ["StructuredOutput"],
        event: { type: rawMetadataSentinel },
      }),
      DEVPRO_FAKE_REVIEWER_HOLD_AFTER_INIT_MS: "70",
    });
    assert.equal(result.status, 0, result.stderr);

    assert.match(readFileSync(context.stdout_log_path, "utf8"), new RegExp(rawMetadataSentinel));
    assert.doesNotMatch(readFileSync(context.activity_log_path, "utf8"), new RegExp(rawMetadataSentinel));
    assert.doesNotMatch(readFileSync(context.heartbeat_path, "utf8"), new RegExp(rawMetadataSentinel));
    const samples = readFileSync(context.activity_log_path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "projection_cli_liveness_sampled");
    assert.ok(samples.some((sample) => sample.last_structured_output?.event_type === "unknown"));
  });
});

test("run-second-reviewer-projection fails closed when Claude audit-only init exposes tools", () => {
  withTempDir("second-review-runner-tool-surface-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash"]',
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_tool_surface_mismatch");
    const events = activityEvents(context.activity_log_path);
    assert.ok(events.includes("projection_cli_tool_surface_mismatch"));
  });
});

test("run-second-reviewer-projection escalates tool-surface mismatch cleanup before the hard cap", {
  skip: process.platform === "win32",
}, () => {
  withTempDir("second-review-runner-tool-surface-cleanup-", (dir) => {
    const binDir = path.join(dir, "bin");
    const descendantPidPath = path.join(dir, "descendant.pid");
    const signalLogPath = path.join(dir, "signal.log");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    let descendantPid = null;

    try {
      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash"]',
        DEVPRO_FAKE_REVIEWER_PRE_INIT_STUBBORN_DESCENDANT_PID_LOG: descendantPidPath,
        DEVPRO_FAKE_REVIEWER_SIGNAL_LOG: signalLogPath,
        DEVPRO_FAKE_REVIEWER_BUSY_UNTIL_SIGNAL: "1",
        DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "4000",
      }, { timeout: 8000 });

      if (existsSync(descendantPidPath)) {
        descendantPid = Number(readFileSync(descendantPidPath, "utf8").trim());
      }
      assert.notEqual(
        result.signal,
        "SIGTERM",
        "the generated command must settle before the test safety timeout",
      );
      assert.equal(result.status, 1, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.classification, "reviewer_tool_surface_mismatch");
      assert.equal(output.cli_exit.timed_out, false);
      assert.equal(output.cli_exit.fault_reason, "unexpected_tool_surface");
      assert.equal(output.cli_exit.fault_termination.signal, "SIGKILL");
      assert.equal(output.cli_exit.fault_termination.process_group, true);
      assert.equal(Number.isInteger(descendantPid), true);
      assert.match(readFileSync(signalLogPath, "utf8"), /reviewer-sigterm/);
      assertProcessGoneEventually(descendantPid);
    } finally {
      if (Number.isInteger(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
    }
  });
});

test("run-second-reviewer-projection fails closed when Claude audit-only init tools are malformed", () => {
  const outcome = collectToolSurfaceOutcome([
    Buffer.from(`${JSON.stringify({ type: "system", subtype: "init", tools: "Bash" })}\n`),
  ]);

  assert.equal(outcome.check.status, "failed");
  assert.equal(outcome.check.classification, "reviewer_tool_surface_mismatch");
  assert.equal(outcome.check.reason, "unexpected_tool_surface");
  assert.equal(outcome.safeTelemetry.status, "failed");
  assert.equal(outcome.safeTelemetry.reason, "unexpected_tool_surface");
  assert.equal(outcome.safeTelemetry.tools, "invalid");
});

test("run-second-reviewer-projection fails closed when Claude audit-only init evidence is missing", () => {
  withTempDir("second-review-runner-tool-surface-missing-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);

    const result = spawnSync(context.projection_runner_command.executable, context.projection_runner_command.argv, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
        DEVPRO_FAKE_REVIEWER_OMIT_INIT: "1",
      },
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_tool_surface_evidence_missing");
    const events = activityEvents(context.activity_log_path);
    assert.ok(events.includes("projection_cli_tool_surface_evidence_missing"));
  });
});

const reviewerOutputFamilies = ["claude", "codex"];
const reviewerOutputLifecycleCases = [
  { family: "claude", stream: "stdout", boundary: "accepted" },
  { family: "claude", stream: "stderr", boundary: "rejected" },
  { family: "codex", stream: "stdout", boundary: "rejected" },
  { family: "codex", stream: "stderr", boundary: "accepted" },
];

test("reviewer output line accumulator applies the same 64 KiB boundary to every reviewer stream", () => {
  for (const family of reviewerOutputFamilies) {
    for (const stream of ["stdout", "stderr"]) {
      const accepted = collectReviewerLineAccumulatorOutcome([
        Buffer.alloc(__testReviewerOutput.maxLineBytes, 0x78),
        Buffer.from("\n"),
      ]);
      assert.equal(accepted.overflows, 0, `${family} ${stream} at-limit line must pass`);
      assert.equal(accepted.lines.length, 1, `${family} ${stream} at-limit line must emit`);
      assert.equal(
        Buffer.byteLength(accepted.lines[0], "utf8"),
        __testReviewerOutput.maxLineBytes
      );

      const rejected = collectReviewerLineAccumulatorOutcome([
        Buffer.alloc(__testReviewerOutput.maxLineBytes + 1, 0x78),
        Buffer.from("\nignored\n"),
      ]);
      assert.equal(rejected.overflows, 1, `${family} ${stream} over-limit line must fail once`);
      assert.equal(rejected.overflowMaxBytes, __testReviewerOutput.maxLineBytes);
      assert.deepEqual(rejected.lines, []);
    }
  }
});

test("run-second-reviewer-projection routes the 64 KiB line boundary through every reviewer family and stream", () => {
  const dimensions = [
    ["family", reviewerOutputFamilies],
    ["stream", ["stdout", "stderr"]],
    ["boundary", ["accepted", "rejected"]],
  ];
  for (const [dimension, values] of dimensions) {
    assert.deepEqual(
      new Set(reviewerOutputLifecycleCases.map((row) => row[dimension])),
      new Set(values),
      `real lifecycle rows must retain every ${dimension}`
    );
    for (const value of values) {
      assert.equal(
        reviewerOutputLifecycleCases.filter((row) => row[dimension] === value).length,
        2,
        `real lifecycle rows must exercise ${dimension}=${value} twice`
      );
    }
  }
  for (let leftIndex = 0; leftIndex < dimensions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < dimensions.length; rightIndex += 1) {
      const [leftDimension, leftValues] = dimensions[leftIndex];
      const [rightDimension, rightValues] = dimensions[rightIndex];
      for (const leftValue of leftValues) {
        for (const rightValue of rightValues) {
          assert.ok(
            reviewerOutputLifecycleCases.some((row) => (
              row[leftDimension] === leftValue && row[rightDimension] === rightValue
            )),
            `real lifecycle rows must cover ${leftDimension}=${leftValue} with ${rightDimension}=${rightValue}`
          );
        }
      }
    }
  }

  for (const family of reviewerOutputFamilies) {
    const familyCases = reviewerOutputLifecycleCases.filter((row) => row.family === family);
    withTempDir(`second-review-runner-${family}-line-boundaries-`, (dir) => {
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      const handoff = family === "codex" ? codexAuditHandoff : auditHandoff;
      if (family === "codex") {
        writeFakeCodex(binDir);
      } else {
        writeFakeClaude(binDir);
      }
      const { carrierDir, context, evidenceRoot } = renderHandoff(dir, handoff);
      const carrierSnapshot = path.join(dir, "initial-carrier");
      const evidenceSnapshot = path.join(dir, "initial-control-evidence");
      cpSync(carrierDir, carrierSnapshot, { recursive: true, preserveTimestamps: true });
      if (existsSync(evidenceRoot)) {
        cpSync(evidenceRoot, evidenceSnapshot, { recursive: true, preserveTimestamps: true });
      }

      for (let rowIndex = 0; rowIndex < familyCases.length; rowIndex += 1) {
        const { stream, boundary } = familyCases[rowIndex];
        if (rowIndex > 0) {
          rmSync(carrierDir, { recursive: true, force: true });
          cpSync(carrierSnapshot, carrierDir, { recursive: true, preserveTimestamps: true });
          rmSync(evidenceRoot, { recursive: true, force: true });
          if (existsSync(evidenceSnapshot)) {
            cpSync(evidenceSnapshot, evidenceRoot, { recursive: true, preserveTimestamps: true });
          }
        }

        const lineBytes = boundary === "accepted"
          ? __testReviewerOutput.maxLineBytes
          : __testReviewerOutput.maxLineBytes + 1;
        const envName = stream === "stdout"
          ? "DEVPRO_FAKE_REVIEWER_RAW_STDOUT_LINE_BYTES"
          : "DEVPRO_FAKE_REVIEWER_RAW_STDERR_LINE_BYTES";
        const result = runGeneratedRunnerCommand(context, binDir, {
          [envName]: String(lineBytes),
        });
        const output = JSON.parse(result.stdout);
        const sidecarPath = stream === "stdout"
          ? context.stdout_log_path
          : context.stderr_log_path;

        if (boundary === "accepted") {
          assert.equal(result.status, 0, `${family} ${stream}: ${result.stderr}`);
          assert.equal(output.classification, "reviewer_cli_completed", `${family} ${stream}`);
          assert.equal(output.cli_exit.output_safety_check.status, "verified");
          assert.equal(
            readFileSync(sidecarPath).includes(Buffer.alloc(lineBytes, 0x78)),
            true,
            `${family} ${stream}: raw sidecar must retain the complete accepted line`
          );
        } else {
          assert.equal(result.status, 1, `${family} ${stream}: ${result.stderr}`);
          assert.equal(output.classification, "reviewer_cli_failed", `${family} ${stream}`);
          assert.equal(output.cli_exit.fault_reason, "reviewer_output_line_too_large");
          assert.equal(output.cli_exit.output_safety_check.status, "failed");
          assert.equal(output.cli_exit.output_safety_check.stream, stream);
          assert.equal(output.cli_exit.fault_termination.attempted, true);
          assert.ok(
            ["SIGTERM", "SIGKILL"].includes(output.cli_exit.fault_termination.signal),
            `${family} ${stream}: unexpected termination signal ${output.cli_exit.fault_termination.signal}`
          );
          assert.equal(
            readFileSync(sidecarPath).includes(Buffer.alloc(lineBytes, 0x78)),
            true,
            `${family} ${stream}: raw sidecar must retain the complete rejected line`
          );
          const rawFragment = "x".repeat(256);
          assert.doesNotMatch(JSON.stringify(output), new RegExp(rawFragment));
          assert.doesNotMatch(readFileSync(context.activity_log_path, "utf8"), new RegExp(rawFragment));
          assert.doesNotMatch(readFileSync(context.heartbeat_path, "utf8"), new RegExp(rawFragment));
          assert.ok(activityEvents(context.activity_log_path).includes(
            "projection_cli_output_line_limit_exceeded"
          ));
        }
      }
    });
  }
});

let oversizedClaudeLifecycleFixture;

function sharedOversizedClaudeLifecycleFixture() {
  if (oversizedClaudeLifecycleFixture !== undefined) {
    return oversizedClaudeLifecycleFixture;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "second-review-runner-claude-oversized-shared-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeClaude(binDir);
  const { carrierDir, context, evidenceRoot } = renderHandoff(dir);
  const carrierSnapshot = path.join(dir, "initial-carrier");
  const evidenceSnapshot = path.join(dir, "initial-control-evidence");
  cpSync(carrierDir, carrierSnapshot, { recursive: true, preserveTimestamps: true });
  if (existsSync(evidenceRoot)) {
    cpSync(evidenceRoot, evidenceSnapshot, { recursive: true, preserveTimestamps: true });
  }
  oversizedClaudeLifecycleFixture = {
    binDir,
    carrierDir,
    carrierSnapshot,
    context,
    dir,
    evidenceRoot,
    evidenceSnapshot,
    uses: 0,
  };
  process.once("exit", () => cleanupFixtureDir(dir));
  return oversizedClaudeLifecycleFixture;
}

function withSharedOversizedClaudeLifecycleFixture(run) {
  const fixture = sharedOversizedClaudeLifecycleFixture();
  if (fixture.uses > 0) {
    rmSync(fixture.carrierDir, { recursive: true, force: true });
    cpSync(fixture.carrierSnapshot, fixture.carrierDir, {
      recursive: true,
      preserveTimestamps: true,
    });
    rmSync(fixture.evidenceRoot, { recursive: true, force: true });
    if (existsSync(fixture.evidenceSnapshot)) {
      cpSync(fixture.evidenceSnapshot, fixture.evidenceRoot, {
        recursive: true,
        preserveTimestamps: true,
      });
    }
  }
  fixture.uses += 1;
  return run(fixture);
}

test("run-second-reviewer-projection fails closed on an oversized claude stdout line while tool-surface evidence is still pending", () => {
  const rejectedLine = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "字".repeat(24_000) } },
    session_id: "session-test", parent_tool_use_id: null, uuid: "uuid-test", future_unknown_key: null,
  });
  for (const line of [null, rejectedLine]) {
    withSharedOversizedClaudeLifecycleFixture(({ binDir, context }) => {
      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_REVIEWER_OMIT_INIT: "1",
        ...(line === null
          ? { DEVPRO_FAKE_REVIEWER_RAW_STDOUT_LINE_BYTES: String((64 * 1024) + 1) }
          : { DEVPRO_FAKE_REVIEWER_RAW_STDOUT_JSON_LINE: line }),
      });
      assert.equal(result.status, 1, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.classification, "reviewer_cli_failed");
      assert.equal(output.cli_exit.fault_reason, "reviewer_output_line_too_large");
      assert.equal(output.cli_exit.output_safety_check.status, "failed");
      assert.equal(output.cli_exit.output_safety_check.max_line_bytes, 64 * 1024);
      if (line !== null) {
        assert.equal(output.cli_exit.output_safety_check.line_bytes, Buffer.byteLength(line));
        assert.equal(output.cli_exit.output_safety_check.classification_reason, "strict_thinking_shape_rejected");
        const activities = readFileSync(context.activity_log_path, "utf8").trim().split("\n").map(row => JSON.parse(row));
        const rejected = activities.find(row => row.event === "projection_cli_output_line_limit_exceeded");
        assert.ok(rejected, "failure activity must preserve the diagnostic");
        assert.equal(rejected.output_safety_check.line_bytes, Buffer.byteLength(line));
        assert.equal(rejected.output_safety_check.classification_reason, "strict_thinking_shape_rejected");
        assert.equal(readFileSync(context.stdout_log_path, "utf8").includes(line), true, "raw sidecar retains the rejected line");
        assert.equal(JSON.stringify(output).includes("字"), false);
        assert.equal(JSON.stringify(activities).includes("字"), false);
      }
      const terminal = terminalReceiptForContext(context);
      assert.equal(terminal?.record.classification, "reviewer_output_line_overflow");
      assert.equal(terminal?.record.process_close_observed, true);
    });
  }
});

test("run-second-reviewer-projection fails closed on an oversized claude stdout line after tool-surface evidence is verified", () => {
  withSharedOversizedClaudeLifecycleFixture(({ binDir, context }) => {
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_RAW_STDOUT_LINE_BYTES: String((64 * 1024) + 1),
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.cli_exit.tool_surface_check.status, "verified");
    assert.equal(output.classification, "reviewer_cli_failed");
    assert.equal(output.cli_exit.fault_reason, "reviewer_output_line_too_large");
    assert.equal(output.cli_exit.output_safety_check.status, "failed");
  });
});

test("run-second-reviewer-projection fails closed on a repeated valid Claude init event", () => {
  withTempDir("second-review-runner-tool-surface-duplicate-init-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    const validInit = JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"] });

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_EVENT: `${validInit}\n${validInit}`,
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_tool_surface_mismatch");
    assert.equal(output.cli_exit.fault_reason, "duplicate_init_event");
    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal?.record.classification, "reviewer_tool_surface_mismatch");
    assert.equal(terminal?.record.process_close_observed, true);
    const events = activityEvents(context.activity_log_path);
    assert.equal(
      events.filter((event) => event === "projection_cli_tool_surface_verified").length,
      1
    );
    assert.ok(events.includes("projection_cli_tool_surface_mismatch"));
  });
});

for (const [article, variant, secondInit] of [
  ["a", "malformed", { type: "system", subtype: "init", tools: "Bash" }],
  ["a", "missing", { type: "system", subtype: "init" }],
  ["an", "extra", { type: "system", subtype: "init", tools: ["Bash"] }],
]) {
  test(`run-second-reviewer-projection rejects ${article} ${variant} second Claude init`, () => {
    const validInit = JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"] });
    const rawProviderSentinel = `duplicate-init-${variant}-provider-detail`;
    const outcome = collectToolSurfaceOutcome([
      Buffer.from(`${validInit}\n${JSON.stringify({
        ...secondInit,
        provider_detail: rawProviderSentinel,
      })}\n`),
    ]);

    assert.deepEqual(outcome.transitions.map(({ action }) => action), ["verified", "failed"]);
    assert.equal(outcome.check.status, "failed");
    assert.equal(outcome.check.classification, "reviewer_tool_surface_mismatch");
    assert.equal(outcome.check.reason, "duplicate_init_event");
    assert.doesNotMatch(JSON.stringify(outcome.check), new RegExp(rawProviderSentinel));
    assert.doesNotMatch(JSON.stringify(outcome.safeTelemetry), new RegExp(rawProviderSentinel));
  });
}

test("run-second-reviewer-projection detects a repeated Claude init split across chunks", () => {
  const validInit = JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"] });
  const splitAt = Math.floor(validInit.length / 2);
  const outcome = collectToolSurfaceOutcome([
    Buffer.from(`${validInit}\n${validInit.slice(0, splitAt)}`),
    Buffer.from(validInit.slice(splitAt)),
  ]);

  assert.deepEqual(outcome.transitions.map(({ action }) => action), ["verified", "failed"]);
  assert.equal(outcome.check.status, "failed");
  assert.equal(outcome.check.classification, "reviewer_tool_surface_mismatch");
  assert.equal(outcome.check.reason, "duplicate_init_event");
});

test("run-second-reviewer-projection detects a repeated Claude init across a UTF-8 byte boundary", () => {
  const validInit = JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"] });
  const repeatedInit = JSON.stringify({
    type: "system",
    subtype: "init",
    tools: [],
    provider_detail: "界",
  });
  const stream = Buffer.from(`${validInit}\n${repeatedInit}`, "utf8");
  const boundary = stream.indexOf(Buffer.from("界", "utf8")) + 1;
  const outcome = collectToolSurfaceOutcome([
    stream.subarray(0, boundary),
    stream.subarray(boundary),
  ]);

  assert.deepEqual(outcome.transitions.map(({ action }) => action), ["verified", "failed"]);
  assert.equal(outcome.check.status, "failed");
  assert.equal(outcome.check.classification, "reviewer_tool_surface_mismatch");
  assert.equal(outcome.check.reason, "duplicate_init_event");
});

test("run-second-reviewer-projection fails closed before spawn for an unknown Claude mode", () => {
  withTempDir("second-review-runner-unknown-claude-mode-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { contextPath, context } = renderHandoff(dir);
    context.mode = "future-mode";
    writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

    const result = runGeneratedRunnerCommand(context, binDir);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_dispatch_identity_collision");
    const events = activityEvents(context.activity_log_path);
    assert.equal(events.includes("claude_reviewer_mode_unsupported"), false);
    assert.equal(events.includes("projection_cli_probe_started"), false);
    assert.equal(events.includes("projection_cli_starting"), false);
  });
});

test("run-second-reviewer-projection verifies Claude pr-sticky exact init tool set", () => {
  withTempDir("second-review-runner-pr-tools-exact-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const ghLog = path.join(dir, "fake-gh.log");
    const neutralWriteLog = path.join(dir, "neutral-write.log");

    const result = spawnSync(context.projection_runner_command.executable, context.projection_runner_command.argv, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
        GH_REPO: "poisoned/example",
        DEVPRO_REVIEW_PR_NUMBER: "9999",
        DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
        DEVPRO_FAKE_GH_LOG: ghLog,
        DEVPRO_FAKE_GH_API_RESPONSE: emptyStickyAuthorityApiResponse,
        DEVPRO_FAKE_REVIEWER_NEUTRAL_WRITE_NAME: "reviewer-sticky-body.md",
        DEVPRO_FAKE_REVIEWER_NEUTRAL_WRITE_LOG: neutralWriteLog,
      },
    });
    assert.equal(result.status, 1);
    assert.notEqual(JSON.parse(result.stdout).classification, "reviewer_tool_surface_mismatch");
    const events = activityEvents(context.activity_log_path);
    assert.ok(events.includes("projection_cli_tool_surface_verified"));
    assert.deepEqual(
      readFileSync(ghLog, "utf8").trim().split("\n"),
      expectedPrStickyPreAndPostSnapshotCommands
    );
    const neutralWritePath = readFileSync(neutralWriteLog, "utf8").trim();
    assert.equal(
      neutralWritePath,
      path.join(realpathSync(path.dirname(context.neutral_cwd_path)), path.basename(context.neutral_cwd_path), "reviewer-sticky-body.md")
    );
    const reviewerStdout = readFileSync(context.stdout_log_path, "utf8");
    assert.match(reviewerStdout, /"gh_repo":"devpro\/example"/);
    assert.match(reviewerStdout, /"review_pr":"1658"/);
    assert.match(reviewerStdout, /"neutral_write_content":"reviewer sticky body"/);
    assert.equal(existsSync(context.neutral_cwd_path), false);
  });
});

test("run-second-reviewer-projection runs the reviewer CLI with a private isolated TMPDIR under the neutral cwd, not the shared host temp dir", () => {
  withTempDir("second-review-runner-isolated-tmpdir-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const tmpdirLog = path.join(dir, "reviewer-tmpdir.log");

    const result = spawnSync(context.projection_runner_command.executable, context.projection_runner_command.argv, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
        GH_REPO: "poisoned/example",
        DEVPRO_REVIEW_PR_NUMBER: "9999",
        DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
        DEVPRO_FAKE_GH_LOG: path.join(dir, "fake-gh.log"),
        DEVPRO_FAKE_GH_API_RESPONSE: emptyStickyAuthorityApiResponse,
        DEVPRO_FAKE_REVIEWER_TMPDIR_LOG: tmpdirLog,
      },
    });

    assert.equal(result.status, 1, result.stderr);
    const [reviewerTmpdir, writability] = readFileSync(tmpdirLog, "utf8").split("\n");
    // The reviewer's TMPDIR is a private child of the renderer-owned neutral cwd, so its
    // exploratory `find "$TMPDIR"` sees an empty tree instead of the shared host temp dir.
    assert.equal(reviewerTmpdir, path.join(context.neutral_cwd_path, "reviewer-tmp"));
    assert.ok(reviewerTmpdir.startsWith(`${context.neutral_cwd_path}${path.sep}`));
    // The regression this guards: the reviewer must NOT inherit the shared host temp dir.
    assert.notEqual(reviewerTmpdir, path.resolve(tmpdir()));
    assert.notEqual(path.dirname(reviewerTmpdir), path.resolve(tmpdir()));
    // The isolated temp root is materialized and writable before the reviewer runs.
    assert.equal(writability, "writable");
    // Recursive cleanup removes the neutral cwd together with its isolated temp root.
    assert.equal(existsSync(context.neutral_cwd_path), false);
    assert.equal(existsSync(reviewerTmpdir), false);
  });
});

test("run-second-reviewer-projection fails closed when Claude pr-sticky init has extra tools", () => {
  withTempDir("second-review-runner-pr-tools-extra-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const ghLog = path.join(dir, "fake-gh.log");

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write","mcp__discord__send_message"]',
      DEVPRO_FAKE_GH_LOG: ghLog,
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_tool_surface_mismatch");
    const events = activityEvents(context.activity_log_path);
    assert.ok(events.includes("projection_cli_tool_surface_mismatch"));
    assert.deepEqual(
      readFileSync(ghLog, "utf8").trim().split("\n"),
      expectedPrStickyPreAndPostSnapshotCommands
    );
  });
});

test("run-second-reviewer-projection treats DEVPRO_CROSS_MODEL_REVIEWER=1 as a terminal leaf before ack or probe", () => {
  withTempDir("second-review-runner-recursion-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);

    const result = spawnSync(context.projection_runner_command.executable, context.projection_runner_command.argv, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DEVPRO_CROSS_MODEL_REVIEWER: "1",
      },
    });
    assert.equal(result.status, 1);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.classification, "projection_recursive_reentry");
    const events = activityEvents(context.activity_log_path);
    assert.equal(events.includes("projection_handoff_validated"), false);
    assert.equal(events.some((event) => event.includes("probe")), false);
    assert.equal(events.some((event) => event.includes("cli_start")), false);
    assert.equal(events.some((event) => event.includes("sticky")), false);
    assert.equal(readFileSync(context.stdout_log_path, "utf8"), "");
  });
});

test("marked projection runner rejects recursion before checking for a context argument", () => {
  const result = runMarkedRunner();
  const payload = assertContextFreeRecursiveReentry(result);
  assert.deepEqual(payload, {
    status: "blocked",
    classification: "projection_recursive_reentry",
  });
  assert.equal(result.stderr, "");
});

test("marked projection runner is import-pure when canonical AGENTS metadata is unavailable", () => {
  withTempDir("second-review-runner-marker-import-pure-", (dir) => {
    const isolatedRepo = path.join(dir, "isolated-repo");
    const isolatedScripts = path.join(isolatedRepo, ".devpro", "scripts");
    mkdirSync(path.dirname(isolatedScripts), { recursive: true });
    cpSync(path.join(REPO_ROOT, ".devpro", "scripts"), isolatedScripts, { recursive: true });
    const isolatedRunner = realpathSync(path.join(isolatedScripts, "run-second-reviewer-projection.mjs"));
    const isolatedCwd = realpathSync(isolatedRepo);

    for (const agentsState of ["missing", "unreadable"]) {
      const agentsPath = path.join(isolatedRepo, "AGENTS.md");
      if (agentsState === "unreadable") {
        writeFileSync(agentsPath, "版本：0.0.0\n", "utf8");
        chmodSync(agentsPath, 0o000);
      }
      const before = readdirSync(isolatedRepo, { recursive: true }).map(String).sort();
      const result = spawnSync(process.execPath, [isolatedRunner], {
        cwd: isolatedCwd,
        encoding: "utf8",
        env: {
          ...process.env,
          DEVPRO_CROSS_MODEL_REVIEWER: "1",
        },
      });

      const payload = assertContextFreeRecursiveReentry(result);
      assert.deepEqual(payload, {
        status: "blocked",
        classification: "projection_recursive_reentry",
      });
      assert.deepEqual(
        readdirSync(isolatedRepo, { recursive: true }).map(String).sort(),
        before,
        `${agentsState} AGENTS metadata must not cause import-time reads or runner side effects`
      );

      if (agentsState === "unreadable") {
        chmodSync(agentsPath, 0o600);
        rmSync(agentsPath);
      }
    }
  });
});

test("marked projection runner rejects recursion before reading an absent context path", () => {
  withTempDir("second-review-runner-marker-absent-", (dir) => {
    const contextPath = path.join(dir, "does-not-exist.json");
    const before = readdirSync(dir);

    const result = runMarkedRunner(contextPath);
    const payload = assertContextFreeRecursiveReentry(result);

    assert.deepEqual(readdirSync(dir), before, "marked path must not create any sidecar or fault artifact");
    assert.deepEqual(payload, {
      status: "blocked",
      classification: "projection_recursive_reentry",
    });
  });
});

test("marked projection runner rejects recursion before parsing malformed context JSON", () => {
  withTempDir("second-review-runner-marker-malformed-", (dir) => {
    const contextPath = path.join(dir, "malformed.json");
    writeFileSync(contextPath, "{ definitely-not-json\n", "utf8");
    const before = readdirSync(dir);

    const result = runMarkedRunner(contextPath);
    const payload = assertContextFreeRecursiveReentry(result);

    assert.deepEqual(readdirSync(dir), before, "marked path must not create any sidecar or fault artifact");
    assert.equal(readFileSync(contextPath, "utf8"), "{ definitely-not-json\n");
    assert.deepEqual(payload, {
      status: "blocked",
      classification: "projection_recursive_reentry",
    });
  });
});

test("marked projection runner treats hostile context paths as inert data with zero side effects", () => {
  withTempDir("second-review-runner-marker-hostile-", (dir) => {
    const contextPath = path.join(dir, "hostile.json");
    const activityPath = path.join(dir, "must-not-create-activity.ndjson");
    const packetPath = path.join(dir, "must-not-read-packet.md");
    const lockPath = `${contextPath}.attempt.lock`;
    const contextText = JSON.stringify({
      attempt_id: "attacker-controlled",
      activity_log_path: activityPath,
      packet_path: packetPath,
      observability_context_path: contextPath,
      heartbeat_path: path.join(dir, "must-not-create-heartbeat.json"),
      stdout_log_path: path.join(dir, "must-not-create-stdout.ndjson"),
      stderr_log_path: path.join(dir, "must-not-create-stderr.log"),
      cli_probe_result_path: path.join(dir, "must-not-create-probe.json"),
    });
    writeFileSync(contextPath, contextText, "utf8");
    const before = readdirSync(dir);

    const result = runMarkedRunner(contextPath);
    const payload = assertContextFreeRecursiveReentry(result);

    assert.deepEqual(readdirSync(dir), before, "marked path must not touch attacker-selected artifact paths");
    assert.equal(existsSync(activityPath), false);
    assert.equal(existsSync(packetPath), false);
    assert.equal(existsSync(lockPath), false);
    assert.equal(readFileSync(contextPath, "utf8"), contextText);
    assert.deepEqual(payload, {
      status: "blocked",
      classification: "projection_recursive_reentry",
    });
  });
});

test("projection ownership publishes complete records through an atomic hard-link", () => {
  const sharedSource = readFileSync(sharedAttemptLockScript, "utf8");
  const runnerSource = readFileSync(runnerScript, "utf8");
  assert.match(
    sharedSource,
    /\blinkSync\s*\(/,
    "attempt acquisition must publish a complete temp owner record with atomic linkSync",
  );
  assert.doesNotMatch(
    sharedSource,
    /openSync\s*\(\s*lockPath\s*,\s*["']wx["']/,
    "attempt acquisition must not expose an empty lock path before writing the owner record",
  );
  assert.match(
    runnerSource,
    /import\s*\{\s*acquireAttemptOwnership,\s*attemptLockPath,\s*lockOwnerState,\s*releaseAttemptOwnership,\s*\}\s*from\s*["']\.\/lib\/second-review-attempt-lock\.mjs["'];/,
    "runner must consume the shared ownership primitive",
  );
  assert.doesNotMatch(
    runnerSource,
    /function\s+(?:attemptLockPath|readAttemptOwner|lockOwnerState|acquireAttemptOwnership|releaseAttemptOwnership)\s*\(/,
    "runner must not retain a second ownership implementation",
  );
});

test("projection ownership fails closed when the hard-link primitive is unavailable", () => {
  withTempDir("second-review-lock-link-unavailable-", (dir) => {
    const contextPath = path.join(dir, "context.json");
    const lockPath = __testAttemptOwnership.lockPath(contextPath);
    const result = __testAttemptOwnership.acquire(contextPath, "attempt-link-failure", {
      publishLink() {
        const error = new Error("hard links unsupported");
        error.code = "EOPNOTSUPP";
        throw error;
      },
    });

    assert.equal(result.owned, false);
    assert.equal(result.classification, "attempt_lock_primitive_unavailable");
    assert.equal(existsSync(lockPath), false, "failed publication must not expose a false owner lock");
    assert.equal(
      readdirSync(dir).some((entry) => entry.includes(".candidate-")),
      false,
      "handled primitive failure must clean its private candidate"
    );
  });
});

test("projection ownership treats unknown PID liveness as active and never steals", () => {
  withTempDir("second-review-lock-unknown-owner-", (dir) => {
    const contextPath = path.join(dir, "context.json");
    const lockPath = __testAttemptOwnership.lockPath(contextPath);
    const owner = {
      attempt_id: "attempt-unknown-owner",
      pid: 424242,
      created_at: new Date().toISOString(),
      owner_token: "unknown-owner-token",
    };
    writeFileSync(lockPath, `${JSON.stringify(owner)}\n`, "utf8");

    const result = __testAttemptOwnership.acquire(contextPath, owner.attempt_id, {
      signalOwner() {
        const error = new Error("liveness permission denied");
        error.code = "EPERM";
        throw error;
      },
    });

    assert.equal(result.owned, false);
    assert.equal(result.ownerState, "unknown");
    assert.equal(result.classification, "projection_attempt_already_active");
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), owner);
    assert.equal(readdirSync(dir).some((entry) => entry.includes(".candidate-")), false);
  });
});

test("projection ownership refuses a non-owner token release before rename or unlink", () => {
  withTempDir("second-review-lock-non-owner-release-", (dir) => {
    const contextPath = path.join(dir, "context.json");
    const lockPath = __testAttemptOwnership.lockPath(contextPath);
    const currentOwner = {
      attempt_id: "attempt-current-owner",
      pid: process.pid,
      created_at: new Date().toISOString(),
      owner_token: "current-owner-token",
    };
    writeFileSync(lockPath, `${JSON.stringify(currentOwner)}\n`, "utf8");
    let renameCalls = 0;
    let unlinkCalls = 0;

    const released = __testAttemptOwnership.release({
      owned: true,
      lockPath,
      owner: { ...currentOwner, owner_token: "non-owner-token" },
    }, {
      renamePath() { renameCalls += 1; },
      unlinkPath() { unlinkCalls += 1; },
    });

    assert.equal(released, false);
    assert.equal(renameCalls, 0, "token mismatch must be rejected before the atomic rename");
    assert.equal(unlinkCalls, 0, "token mismatch must never unlink any ownership record");
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), currentOwner);
    assert.deepEqual(readdirSync(dir), [path.basename(lockPath)]);
  });
});

test("projection ownership survives a crash before link publication", () => {
  withTempDir("second-review-lock-pre-link-crash-", (dir) => {
    const contextPath = path.join(dir, "context.json");
    const lockPath = __testAttemptOwnership.lockPath(contextPath);
    const orphanCandidate = `${lockPath}.candidate-crashed-before-link`;
    writeFileSync(orphanCandidate, `${JSON.stringify({
      attempt_id: "crashed-before-link",
      pid: 999999,
      created_at: new Date().toISOString(),
      owner_token: "orphan-private-candidate",
    })}\n`, "utf8");

    const ownership = __testAttemptOwnership.acquire(contextPath, "replacement-after-pre-link-crash");

    assert.equal(ownership.owned, true);
    assert.equal(existsSync(lockPath), true);
    assert.equal(existsSync(orphanCandidate), true, "private orphan candidates cannot impersonate the canonical lock");
    assert.equal(__testAttemptOwnership.release(ownership), true);
    assert.equal(existsSync(lockPath), false);
  });
});

test("projection ownership preserves a complete lock after a crash immediately following link publication", () => {
  withTempDir("second-review-lock-post-link-crash-", (dir) => {
    const contextPath = path.join(dir, "context.json");
    const lockPath = __testAttemptOwnership.lockPath(contextPath);
    const crashedCandidate = `${lockPath}.candidate-crashed-after-link`;
    const crashedOwner = {
      attempt_id: "crashed-after-link",
      pid: 999999,
      created_at: new Date().toISOString(),
      owner_token: "published-before-crash",
    };
    writeFileSync(crashedCandidate, `${JSON.stringify(crashedOwner)}\n`, "utf8");
    linkSync(crashedCandidate, lockPath);

    const contender = __testAttemptOwnership.acquire(contextPath, crashedOwner.attempt_id, {
      signalOwner() {
        const error = new Error("owner exited after publication");
        error.code = "ESRCH";
        throw error;
      },
    });

    assert.equal(contender.owned, false);
    assert.equal(contender.ownerState, "dead");
    assert.equal(contender.classification, "projection_attempt_recovery_required");
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), crashedOwner);
    assert.deepEqual(JSON.parse(readFileSync(crashedCandidate, "utf8")), crashedOwner);
  });
});

test("projection ownership linearizes exactly one winner across 100 two-contender races", async () => {
  const dir = makeTempDir("second-review-lock-100-races-");
  const first = createOwnershipWorker();
  const second = createOwnershipWorker();
  try {
    await Promise.all([first.ready, second.ready]);
    for (let round = 0; round < 100; round += 1) {
      const contextPath = path.join(dir, `context-${round}.json`);
      const attemptId = `attempt-${round}`;
      const [left, right] = await Promise.all([
        requestOwnership(first.worker, `left-${round}`, contextPath, attemptId),
        requestOwnership(second.worker, `right-${round}`, contextPath, attemptId),
      ]);
      const results = [left, right];
      const winners = results.filter((result) => result.owned);
      const losers = results.filter((result) => !result.owned);

      assert.equal(winners.length, 1, `round ${round} must publish exactly one owner`);
      assert.equal(losers.length, 1, `round ${round} must have exactly one loser`);
      assert.equal(losers[0].classification, "projection_attempt_already_active");
      assert.equal(losers[0].ownerState, "live");
      assert.deepEqual(
        JSON.parse(readFileSync(winners[0].lockPath, "utf8")),
        winners[0].owner,
        `round ${round} must expose the winner's complete owner record`
      );
      assert.equal(__testAttemptOwnership.release(winners[0]), true);
      assert.equal(existsSync(winners[0].lockPath), false);
    }
  } finally {
    await Promise.allSettled([first.worker.terminate(), second.worker.terminate()]);
    cleanupFixtureDir(dir);
  }
});

test("run-second-reviewer-projection permits exactly one live owner for the same attempt", async () => {
  const dir = makeTempDir("second-review-runner-concurrency-");
  try {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    let firstCompleted = false;
    const first = runGeneratedRunnerCommandAsync(context, binDir, {
      DEVPRO_FAKE_REVIEWER_DELAY_MS: "3000",
    });
    first.then(
      () => { firstCompleted = true; },
      () => { firstCompleted = true; },
    );
    const lockDeadline = Date.now() + 10000;
    let firstLockAcquired = false;
    while (!firstCompleted && Date.now() < lockDeadline) {
      if (existsSync(context.activity_log_path)
        && activityEvents(context.activity_log_path).includes("projection_attempt_lock_acquired")) {
        firstLockAcquired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!firstLockAcquired) {
      await first;
      assert.fail("expected the first runner to acquire the attempt lock before the contender starts");
    }
    const second = runGeneratedRunnerCommandAsync(context, binDir);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const results = [firstResult, secondResult].map((entry) => JSON.parse(entry.stdout));
    assert.deepEqual(
      results.map((entry) => entry.classification).sort(),
      ["projection_attempt_already_active", "reviewer_cli_completed"].sort()
    );
    assert.deepEqual([firstResult.status, secondResult.status].sort(), [0, 1]);
    assert.equal(existsSync(`${context.observability_context_path}.attempt.lock`), false);
  } finally {
    cleanupFixtureDir(dir);
  }
});

test("run-second-reviewer-projection does not steal a well-formed lock from a live owner", () => {
  withTempDir("second-review-runner-live-lock-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    const lockPath = `${context.observability_context_path}.attempt.lock`;
    const liveOwner = {
      attempt_id: context.attempt_id,
      pid: process.pid,
      created_at: new Date().toISOString(),
      owner_token: "preexisting-live-owner",
    };
    writeFileSync(lockPath, `${JSON.stringify(liveOwner)}\n`, "utf8");

    const result = runGeneratedRunnerCommand(context, binDir);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).classification, "projection_attempt_already_active");
    assert.equal(JSON.parse(result.stdout).next_step, undefined, "a live owner is not an interrupted attempt");
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), liveOwner);

    const events = activityEvents(context.activity_log_path);
    assert.equal(events.filter((event) => event === "projection_attempt_already_active").length, 1);
    assert.equal(events.filter((event) => event === "projection_attempt_stale_lock_recovered").length, 0);
    assert.equal(events.filter((event) => event === "projection_attempt_lock_acquired").length, 0);
    assert.equal(events.some((event) => event.includes("cli_start")), false);
  });
});

function writeDeadOwnerLock(context) {
  const deadOwnerProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(deadOwnerProcess.status, 0);
  assert.ok(Number.isInteger(deadOwnerProcess.pid));
  assertProcessGoneEventually(deadOwnerProcess.pid);

  const lockPath = `${context.observability_context_path}.attempt.lock`;
  const deadOwner = {
    attempt_id: context.attempt_id,
    pid: deadOwnerProcess.pid,
    created_at: new Date().toISOString(),
    owner_token: "preexisting-dead-owner",
  };
  writeFileSync(lockPath, `${JSON.stringify(deadOwner)}\n`, "utf8");
  return { lockPath, deadOwner };
}

test("run-second-reviewer-projection requires recovery for a well-formed dead-owner lock without stealing it", () => {
  withTempDir("second-review-runner-dead-lock-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    const { lockPath, deadOwner } = writeDeadOwnerLock(context);

    const result = runGeneratedRunnerCommand(context, binDir);
    assert.equal(result.status, 1, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "blocked");
    assert.equal(stdout.classification, "projection_attempt_recovery_required");
    assert.ok(stdout.next_step.includes(`abandon-interrupted-second-review.mjs notes/cross-review/${context.attempt_id}/observability-context.json --dry-run`));
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), deadOwner);

    const events = activityEvents(context.activity_log_path);
    assert.equal(events.filter((event) => event === "projection_attempt_stale_lock_recovered").length, 0);
    assert.equal(events.filter((event) => event === "projection_attempt_lock_acquired").length, 0);
    assert.equal(events.some((event) => event.includes("cli_start")), false);
  });
});

test("run-second-reviewer-projection requires recovery for a malformed lock without stealing it", () => {
  withTempDir("second-review-runner-stale-lock-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    const lockPath = `${context.observability_context_path}.attempt.lock`;
    writeFileSync(lockPath, "not-json\n", "utf8");

    const result = runGeneratedRunnerCommand(context, binDir);
    assert.equal(result.status, 1, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "blocked");
    assert.equal(stdout.classification, "projection_attempt_recovery_required");
    assert.equal(readFileSync(lockPath, "utf8"), "not-json\n");
    assert.equal(activityEvents(context.activity_log_path).includes("projection_attempt_stale_lock_recovered"), false);
    assert.equal(activityEvents(context.activity_log_path).some((event) => event.includes("cli_start")), false);
  });
});

test("run-second-reviewer-projection releases ownership and neutral cwd after abnormal reviewer exit", () => {
  withTempDir("second-review-runner-abnormal-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);

    const result = spawnSync(context.projection_runner_command.executable, context.projection_runner_command.argv, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
        DEVPRO_FAKE_REVIEWER_EXIT_CODE: "7",
      },
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_cli_failed");
    assert.equal(existsSync(context.neutral_cwd_path), false);
    assert.equal(existsSync(`${context.observability_context_path}.attempt.lock`), false);
  });
});

test("run-second-reviewer-projection blocks before CLI when probe evidence is incomplete", () => {
  withTempDir("second-review-runner-block-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir, "Usage: reviewer\\n  -p, --print\\n");
    const { context } = renderHandoff(dir);

    const result = runGeneratedRunnerCommand(context, binDir);
    assert.equal(result.status, 1);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "blocked");
    assert.equal(stdout.classification, "required_flag_absent_in_host_help");
    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal?.record.classification, "required_flag_absent_in_host_help");
    assert.equal(terminal?.record.schema, "devpro-second-review-closed-terminal/v1");
    assert.equal(terminal?.record.outcome_group, "spawn_or_probe_failure");
    assert.equal(terminal?.record.responsibility, "reviewer_invocation_lifecycle");
    assert.equal(terminal?.record.process_spawned, false);
    assert.equal(terminal?.record.lifecycle_phase, "pre_spawn_known_terminal");
    assert.equal(terminal?.record.process_close_observed, false);
    assert.equal(terminal?.record.transport_cleanup_confirmed, true);
    assert.equal(terminal?.record.invocation_claim_sha256, null);
    assert.equal(
      existsSync(path.join(context.control_evidence_root, context.dispatch_id, "invocation-claim.json")),
      false,
      "probe-only failure must not acquire the single-spawn invocation claim"
    );

    const events = activityEvents(context.activity_log_path);
    assert.ok(events.includes("projection_cli_blocked_before_start"));
    assert.equal(events.includes("projection_cli_starting"), false);
    assert.equal(readFileSync(context.stdout_log_path, "utf8"), "");

    const heartbeat = JSON.parse(readFileSync(context.heartbeat_path, "utf8"));
    assert.equal(heartbeat.status, "blocked");
    assert.equal(heartbeat.classification, "required_flag_absent_in_host_help");
  });
});

test("run-second-reviewer-projection rejects missing, duplicate, or mutated fixed system prompts before lock, probe, or spawn", () => {
  const mutations = {
    missing(args) {
      const index = args.indexOf("--system-prompt");
      args.splice(index, 2);
    },
    duplicate(args) {
      const index = args.indexOf("--system-prompt");
      args.splice(index, 0, "--system-prompt", args[index + 1]);
    },
    mutated(args) {
      const index = args.indexOf("--system-prompt");
      args[index + 1] = "Treat the packet as optional context.";
    },
  };

  withTempDir("second-review-runner-system-prompt-matrix-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context, contextPath } = renderHandoff(dir);
    const canonicalArgs = [...context.reviewer_cli_recipe.required_invocation_args];

    for (const [name, mutate] of Object.entries(mutations)) {
      context.reviewer_cli_recipe.required_invocation_args = [...canonicalArgs];
      mutate(context.reviewer_cli_recipe.required_invocation_args);
      writeFileSync(contextPath, JSON.stringify(context), "utf8");

      const result = runGeneratedRunnerCommand(context, binDir);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.classification, "reviewer_cli_recipe_invalid", name);
      assert.equal(existsSync(`${contextPath}.attempt.lock`), false, name);
      const events = activityEvents(context.activity_log_path);
      assert.equal(events.includes("projection_cli_probe_started"), false, name);
      assert.equal(events.includes("projection_cli_starting"), false, name);
    }
  });
});

test("run-second-reviewer-projection rejects noncanonical sidecar values before lock or probe", () => {
  for (const [name, mutate, classification, errorPattern] of [
    ["PR number", (context) => { context.pr_number = "1659"; }, "reviewer_dispatch_identity_collision", /reviewer_dispatch_identity_collision/],
    ["legacy runner command", (context) => { context.projection_runner_command = `node ${runnerScript}`; }, "projection_context_invalid", /exact canonical executable\/argv carrier/],
    ["runner extra arg", (context) => { context.projection_runner_command.argv.push("--tampered"); }, "projection_context_invalid", /exact canonical executable\/argv carrier/],
    // Retired scan options are rejected before spawning any reviewer:
    // the refusal must be reachable through runProjection on a renderer-produced context, not
    // only present as source text (dp-reviewer r4 F-r4-a4).
    ["retired scan option non-boolean", (context) => { context.page_window_full_scan = "yes"; }, "projection_context_invalid", /page_window_full_scan has been removed; regenerate/],
    ["retired scan option false", (context) => { context.page_window_full_scan = false; }, "projection_context_invalid", /page_window_full_scan has been removed; regenerate/],
    ["retired scan option true", (context) => { context.page_window_full_scan = true; context.page_window_checkpoint_handoff = true; context.page_window_count = 1; }, "projection_context_invalid", /page_window_full_scan has been removed; regenerate/],
  ]) {
    withTempDir(`second-review-runner-mutated-${name.replaceAll(" ", "-")}-`, (dir) => {
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFakeClaude(binDir);
      const { context, contextPath } = renderHandoff(dir, prStickyHandoff);
      mutate(context);
      writeFileSync(contextPath, JSON.stringify(context), "utf8");

      const result = spawnSync(process.execPath, [runnerScript, contextPath], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
        },
      });
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.classification, classification, name);
      assert.match(output.error, errorPattern, name);
      assert.equal(existsSync(`${contextPath}.attempt.lock`), false, name);
      const events = activityEvents(context.activity_log_path);
      assert.equal(events.includes("projection_cli_probe_started"), false, name);
      assert.equal(events.includes("projection_cli_starting"), false, name);
    });
  }
});

// T7/T14a (design.md D2 邊界, D8; tasks.md item 8): a sidecar rendered before
// this change never wrote reviewer_model_selection at all (D2's argv-pin
// fallback removal + D3's no-fallback-on-invalid rule together mean this is
// the ONLY legacy skew shape — there is no partial/legacy selection shape to
// simulate, deleting the field entirely IS the pre-contract sidecar). Both
// families MUST fail closed with the SAME projection_context_invalid
// classification and MUST NOT reach the reviewer CLI probe/spawn.
test("Pre-contract sidecar missing the selection triple fails closed for both families", () => {
  for (const [name, handoff, writeFakeCli] of [
    ["claude", prStickyHandoff, writeFakeClaude],
    ["codex", codexAuditHandoff, writeFakeCodex],
  ]) {
    withTempDir(`second-review-runner-pre-contract-sidecar-${name}-`, (dir) => {
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFakeCli(binDir);
      const { context, contextPath } = renderHandoff(dir, handoff);
      assert.notEqual(context.reviewer_model_selection, undefined, `${name}: renderer must have written the field`);
      delete context.reviewer_model_selection;
      writeFileSync(contextPath, JSON.stringify(context), "utf8");

      const result = spawnSync(process.execPath, [runnerScript, contextPath], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
        },
      });
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.classification, "projection_context_invalid", name);
      assert.match(output.error, /reviewer_model_selection/, name);
      assert.equal(existsSync(`${contextPath}.attempt.lock`), false, name);
      const events = activityEvents(context.activity_log_path);
      assert.equal(events.includes("projection_cli_probe_started"), false, name);
      assert.equal(events.includes("projection_cli_starting"), false, name);
    });
  }
});

test("run-second-reviewer-projection records started only after the reviewer child spawn event", () => {
  withTempDir("second-review-runner-spawn-enoent-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeDisappearingClaude(binDir);
    symlinkSync("/bin/cat", path.join(binDir, "cat"));
    symlinkSync(process.execPath, path.join(binDir, "node"));
    const { context } = renderHandoff(dir);

    const result = runGeneratedRunnerCommand(context, binDir, { PATH: binDir });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_cli_spawn_failed");
    assert.equal(output.cli_exit.process_spawned, false);
    assert.equal(output.cli_exit.process_close_observed, false);
    assert.equal(output.cli_exit.transport_cleanup_confirmed, true);
    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal?.record.outcome_group, "spawn_or_probe_failure");
    assert.equal(terminal?.record.process_spawned, false);
    assert.equal(terminal?.record.lifecycle_phase, "pre_spawn_known_terminal");
    assert.equal(terminal?.record.process_close_observed, false);
    assert.equal(terminal?.record.transport_cleanup_confirmed, true);
    assert.equal(terminal?.record.invocation_claim_sha256, null);
    assert.equal(
      existsSync(path.join(context.control_evidence_root, context.dispatch_id, "invocation-claim.json")),
      true,
      "spawn failure occurs after acquiring single-attempt authority but before child creation"
    );
    const events = activityEvents(context.activity_log_path);
    assert.ok(events.includes("projection_cli_starting"));
    assert.ok(events.includes("projection_cli_spawn_error"));
    assert.equal(events.includes("projection_cli_started"), false);
    assert.equal(events.includes("projection_cli_liveness_sampled"), false);
  });
});

test("run-second-reviewer-projection passes the exact linked-issue allowlist from renderer sidecar to Claude", () => {
  for (const [linkedIssueContext, shouldGrantIssueRead] of [
    ["issue_read_required", true],
    ["none", false],
  ]) {
    withTempDir(`second-review-runner-linked-issue-${linkedIssueContext}-`, (dir) => {
      const binDir = path.join(dir, "bin");
      const argsLog = path.join(dir, "reviewer-args.log");
      mkdirSync(binDir, { recursive: true });
      writeFakeClaude(binDir);
      writeFakeGh(binDir);
      const { context } = renderHandoff(dir, {
        ...prStickyHandoff,
        linked_issue_context: linkedIssueContext,
      });
      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_REVIEWER_ARGS_LOG: argsLog,
        DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
        DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponse("PASS", context.dispatch_id),
        DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify({
            sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242",
            verdict: "PASS",
            last_reviewed_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            reviewer_model: "claude-test",
            reason: "No blocking findings.",
          }),
        }),
      });
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.equal(context.linked_issue_context, linkedIssueContext);
      const invokedArgs = readFileSync(argsLog, "utf8");
      assert.match(invokedArgs, /closingIssuesReferences/);
      assert.match(invokedArgs, /tool-returned decimal issue numbers/);
      assert.equal(invokedArgs.includes("read-second-review-linked-issue.mjs devpro/example:*)"), shouldGrantIssueRead);
    });
  }
});

test("run-second-reviewer-projection supports renderer-owned Codex CLI recipe", () => {
  withTempDir("second-review-runner-codex-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    const { context } = renderHandoff(dir, codexAuditHandoff);

    const result = runGeneratedRunnerCommand(context, binDir);
    assert.equal(result.status, 0, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "finished");
    assert.equal(stdout.classification, "reviewer_cli_completed");
    assert.equal(stdout.sticky.status, "skipped");

    const probe = JSON.parse(readFileSync(context.cli_probe_result_path, "utf8"));
    assert.equal(probe.reviewer_cli_recipe.tool, "codex");
    assert.equal(probe.classification, "flags_supported");
    assert.deepEqual(probe.missing_required_flags, []);

    const reviewerStdout = readFileSync(context.stdout_log_path, "utf8");
    const reviewerStderr = readFileSync(context.stderr_log_path, "utf8");
    assert.match(reviewerStdout, /"tool":"codex"/);
    assert.match(reviewerStdout, /"cross":"1"/);
    assert.match(reviewerStdout, /exec --json/);
    assert.match(reviewerStdout, /--ignore-rules/);
    assert.match(reviewerStdout, /--skip-git-repo-check/);
    assert.match(reviewerStdout, /-s workspace-write/);
    assert.match(reviewerStdout, /-c sandbox_workspace_write\.network_access=true/);
    assert.doesNotMatch(
      reviewerStdout,
      /--add-dir/,
      "canonical Codex invocation must not grant a second writable root via --add-dir (issue #1735 regression fence)"
    );
    const codexInvocation = parseNdjsonObjects(reviewerStdout).find(
      (event) => event.type === "harness.diagnostic" && event.tool === "codex",
    );
    assert.ok(codexInvocation, "the fixture must record the actual Codex argv and cwd");
    assert.ok(codexInvocation.args.includes(`-C ${context.neutral_cwd_path}`));
    assert.equal(
      codexInvocation.cwd,
      path.join(realpathSync(path.dirname(context.neutral_cwd_path)), path.basename(context.neutral_cwd_path)),
    );
    assert.match(reviewerStdout, /"gh_repo":"devpro\/example"/);
    assert.match(reviewerStdout, /"review_pr":"none"/);
    assert.equal(existsSync(context.neutral_cwd_path), false);
    assert.match(reviewerStderr, /fake codex stderr line/);

    const events = activityEvents(context.activity_log_path);
    assert.ok(events.includes("projection_cli_probe_started"));
    assert.ok(events.includes("projection_cli_probe_result"));
    assert.ok(events.includes("projection_cli_started"));
    assert.ok(events.includes("projection_cli_exited"));
    assert.ok(events.includes("projection_sticky_verification_skipped"));

    const heartbeat = JSON.parse(readFileSync(context.heartbeat_path, "utf8"));
    assert.equal(heartbeat.status, "finished");
    assert.equal(heartbeat.classification, "reviewer_cli_completed");
    assert.ok(heartbeat.cli_exit.stdout_bytes > 0);
  });
});

// REQ-R9 post-hoc reconciliation. The reconciler is deliberately module-private
// (design.md D14), so every fixture below drives it the way an operator would:
// a subprocess running the canonical runner with the reconcile argv. The only
// injected seams are process.platform (C2) and process.kill (C13), both patched
// by a preload module the test writes itself — the runner resolves them as
// default parameters at call time, so no production escape hatch is needed.
const reconcilePreloadSource = `const platformOverride = process.env.DEVPRO_RECONCILE_TEST_PLATFORM;
const nativePlatform = process.platform;
if (platformOverride) {
  if (nativePlatform === "win32" && platformOverride !== "win32") {
    // Keep the simulated POSIX process-group branch from changing the native
    // Windows filesystem contract: durable-fs intentionally skips directory
    // fsync on win32 because Node cannot open directories there.
    const { createRequire, syncBuiltinESMExports } = await import("node:module");
    const require = createRequire(import.meta.url);
    const fs = require("node:fs");
    const noDirectoryFd = -2147483647;
    const nativeOpenSync = fs.openSync.bind(fs);
    const nativeFsyncSync = fs.fsyncSync.bind(fs);
    const nativeCloseSync = fs.closeSync.bind(fs);
    fs.openSync = (target, flags, ...rest) => {
      if (flags === "r" && typeof target === "string" && fs.statSync(target).isDirectory()) {
        return noDirectoryFd;
      }
      return nativeOpenSync(target, flags, ...rest);
    };
    fs.fsyncSync = (fd, ...rest) => fd === noDirectoryFd ? undefined : nativeFsyncSync(fd, ...rest);
    fs.closeSync = (fd, ...rest) => fd === noDirectoryFd ? undefined : nativeCloseSync(fd, ...rest);
    syncBuiltinESMExports();
  }
  Object.defineProperty(process, "platform", { value: platformOverride, configurable: true });
}
const killMode = process.env.DEVPRO_RECONCILE_TEST_KILL;
if (killMode) {
  const realKill = process.kill.bind(process);
  // Only the reviewer process-group probe uses a negative pid; the attempt-lock
  // owner probe (C11) keeps the real kill so lock liveness stays honest.
  process.kill = (pid, signal) => {
    if (pid < 0 && (signal === 0 || signal === undefined)) {
      if (killMode === "alive" || killMode === "alive-" + Math.abs(pid)) return true;
      const error = new Error(\`fake reviewer process-group probe: \${killMode}\`);
      error.code = killMode === "esrch" || killMode.startsWith("alive-") ? "ESRCH" : "EPERM";
      throw error;
    }
    return realKill(pid, signal);
  };
}
`;

const reconciledPid = 987654;
const foreignDispatchId = "dispatch-00000000-0000-4000-8000-000000000000";

function directorySnapshot(root) {
  const entries = [];
  const walk = (current, relative) => {
    const children = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const key = relative ? `${relative}/${child.name}` : child.name;
      // Owned-canonical fixtures symlink renderer deps under the temp root;
      // Dirent.isDirectory() is false for those links, and readFileSync(EISDIR).
      if (child.isSymbolicLink()) {
        entries.push([key, `symlink:${readlinkSync(absolute)}`]);
        continue;
      }
      if (child.isDirectory()) {
        entries.push([`${key}/`, "directory"]);
        walk(absolute, key);
        continue;
      }
      entries.push([key, createHash("sha256").update(readFileSync(absolute)).digest("hex")]);
    }
  };
  walk(root, "");
  return Object.fromEntries(entries);
}

async function reconcileFixture(dir, mutate = () => {}) {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  const { context, contextPath, packetPath } = renderHandoff(dir, prStickyHandoff);
  const record = secondReviewDispatchRecord({
    context,
    packetBytes: readFileSync(packetPath),
  });
  const claim = await claimDispatchInvocation({
    rootDir: context.control_evidence_root,
    record,
  });
  const invocationClaimSha256 = canonicalInvocationClaimSha256(claim.record);
  const rendererActivity = readFileSync(context.activity_log_path, "utf8");
  const preloadPath = path.join(dir, "reconcile-preload.mjs");
  writeFileSync(preloadPath, reconcilePreloadSource, "utf8");

  const state = {
    dir,
    binDir,
    preloadPath,
    context,
    contextPath,
    packetPath,
    record,
    invocationClaimSha256,
    argvContextPath: contextPath,
    activity: [
      {
        event: "projection_dispatch_invocation_claimed",
        attempt_id: context.attempt_id,
        generated_at: "2026-07-20T03:00:00.000Z",
        runner_script: runnerScript,
        dispatch_id: context.dispatch_id,
        invocation_claim_sha256: invocationClaimSha256,
      },
      {
        event: "projection_cli_started",
        attempt_id: context.attempt_id,
        generated_at: "2026-07-20T03:00:01.000Z",
        runner_script: runnerScript,
        pid: reconciledPid,
        tool: "claude",
        stdout_log_path: context.stdout_log_path,
        stderr_log_path: context.stderr_log_path,
      },
      {
        event: "projection_cli_exited",
        attempt_id: context.attempt_id,
        generated_at: "2026-07-20T03:04:05.000Z",
        runner_script: runnerScript,
        code: 0,
        signal: null,
        timed_out: false,
        spawn_error: null,
        stdout_bytes: 78659,
        stderr_bytes: 0,
        process_spawned: true,
        process_close_observed: true,
        transport_cleanup_confirmed: false,
      },
    ],
    heartbeat: {
      status: "blocked",
      classification: "reviewer_completion_critical",
      attempt_id: context.attempt_id,
      dispatch_id: context.dispatch_id,
      generated_at: "2026-07-20T03:04:05.000Z",
      cli_exit: {
        code: 0,
        signal: null,
        timed_out: false,
        spawn_error: null,
        stdout_bytes: 78659,
        stderr_bytes: 0,
        process_spawned: true,
        process_close_observed: true,
        transport_cleanup_confirmed: false,
      },
      sticky: {
        status: "failed",
        classification: "sticky_verdict_not_gate_satisfying",
        pr_number: context.pr_number,
        verdict: "CRITICAL",
        last_reviewed_sha: prStickyHeadSha,
        dispatch_id: context.dispatch_id,
        authority_candidate_count: 1,
      },
    },
    writeCarrier() {
      writeFileSync(
        context.activity_log_path,
        `${rendererActivity}${state.activity.map((line) => JSON.stringify(line)).join("\n")}\n`,
        "utf8"
      );
      writeFileSync(
        context.heartbeat_path,
        `${JSON.stringify(state.heartbeat, null, 2)}\n`,
        "utf8"
      );
    },
  };
  state.writeCarrier();
  await mutate(state);
  return state;
}

function reconcileSpawnArgs(state, options = {}) {
  const {
    // These reconciliation fixtures exercise supported-host validation logic on
    // the host's own platform; only a native win32 host is overridden, because
    // the dedicated C2 case below explicitly injects win32 to test refusal.
    platform = process.platform === "win32" ? "linux" : process.platform,
    kill = "esrch",
    ghResponse = currentHeadStickyResponse("CRITICAL", state.context.dispatch_id),
    argv = ["--reconcile-closed-transport", state.argvContextPath],
    controlEvidenceDirOverride = null,
    markerDirOverride = null,
  } = options;
  const wrongCwd = makeTempDir("second-review-reconcile-wrong-cwd-");
  const env = { ...process.env };
  // The reconciler must resolve the evidence root from the named context alone.
  // Deleting the ambient override is the default because most fixtures are not
  // about it — but deleting it unconditionally would mean no fixture can ever
  // observe the one input capable of violating that property, so callers may
  // set it back explicitly.
  delete env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
  if (controlEvidenceDirOverride !== null) {
    env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = controlEvidenceDirOverride;
  }
  return {
    wrongCwd,
    argv: ["--import", pathToFileURL(state.preloadPath).href, runnerScript, ...argv],
    options: {
      cwd: wrongCwd,
      encoding: "utf8",
      env: {
        ...env,
        PATH: `${state.binDir}${path.delimiter}${env.PATH ?? ""}`,
        SHELL: "/bin/sh",
        DEVPRO_RECONCILE_TEST_PLATFORM: platform,
        DEVPRO_RECONCILE_TEST_KILL: kill,
        DEVPRO_FAKE_GH_API_RESPONSE: ghResponse,
        ...(options.credentialEnv ?? {}),
        DEVPRO_FAKE_GH_API_COUNT_FILE: path.join(wrongCwd, "fake-gh-api-count"),
        ...(markerDirOverride === null ? {} : { DEVPRO_POST_PR_COMPLETION_STATE_DIR: markerDirOverride }),
      },
    },
  };
}

function runReconcile(state, options = {}) {
  const spawnArgs = reconcileSpawnArgs(state, options);
  try {
    const before = directorySnapshot(state.dir);
    const result = spawnSync(process.execPath, spawnArgs.argv, spawnArgs.options);
    return { ...result, before, after: directorySnapshot(state.dir) };
  } finally {
    rmSync(spawnArgs.wrongCwd, { recursive: true, force: true });
  }
}

function runReconcileAsync(state, options = {}) {
  const spawnArgs = reconcileSpawnArgs(state, options);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, spawnArgs.argv, {
      ...spawnArgs.options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      rmSync(spawnArgs.wrongCwd, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
  });
}

function assertReconcileBlocked(result, classification, dispatchId) {
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    assert.fail(
      `reconciliation must report a typed blocked result on stdout, got:\n${result.stdout}\n${result.stderr}`
    );
  }
  assert.equal(payload.status, "blocked", result.stderr);
  assert.equal(payload.classification, classification, result.stderr);
  if (dispatchId !== undefined) assert.equal(payload.dispatch_id, dispatchId);
}

function assertReconcileWroteNothing(result) {
  assert.deepEqual(
    result.after,
    result.before,
    "a blocked reconciliation must leave both the evidence and carrier roots byte-identical"
  );
}

async function legacyDiagnosticFixture(dir) {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  writeFakeGh(binDir);
  const evidenceRoot = path.join(dir, "control-evidence");
  const predecessor = secondReviewDispatchRecord({
    context: {
      repository_slug: prStickyHandoff.repository_slug,
      pr_number: String(prStickyScope.pull_request_number),
      head_ref_oid: prStickyHeadSha,
      attempt_id: "legacy-predecessor",
      dispatch_id: foreignDispatchId,
      previous_dispatch_id: null,
      observability_context_path: path.join(dir, "predecessor", "observability-context.json"),
    },
    packetBytes: Buffer.from("predecessor fixture"),
  });
  await reserveDispatchRecord({ rootDir: evidenceRoot, record: predecessor });
  await writeTerminalReceipt({ rootDir: evidenceRoot, record: {
    ...predecessor, schema: TERMINAL_RECEIPT_SCHEMA,
    outcome_group: "spawn_or_probe_failure", classification: "tool_discovery_blocked",
    responsibility: TERMINAL_RECEIPT_RESPONSIBILITY, created_at: new Date().toISOString(),
    process_spawned: false, lifecycle_phase: "pre_spawn_known_terminal",
    process_close_observed: false, transport_cleanup_confirmed: true,
    invocation_claim_sha256: null,
  } });
  const material = reviewMaterialWithExactUtf8Bytes(prStickyMaterial, 13 * 32768 + 1);
  const handoff = {
    ...prStickyHandoff, previous_dispatch_id: foreignDispatchId,
    review_material_proof: canonicalEmbeddedReviewMaterialProof(prStickyScope, material),
    review_material: material,
  };
  const markerDir = path.join(dir, "devpro-post-pr-completion");
  const rendered = renderHandoff(dir, handoff, { DEVPRO_POST_PR_COMPLETION_STATE_DIR: markerDir });
  const { context, contextPath, packetPath } = rendered;
  assert.equal(context.page_window_count, 14);
  const record = readDispatchEvidenceStrict({ rootDir: evidenceRoot, dispatchId: context.dispatch_id }).dispatch;
  const claim = await claimDispatchInvocation({ rootDir: evidenceRoot, record });
  const invocationClaimSha256 = canonicalInvocationClaimSha256(claim.record);
  const initialData = parseCanonicalSecondReviewPacketData(readFileSync(packetPath));
  const privateMaterialPath = path.join(path.dirname(contextPath), PAGED_FULL_PAGES_CARRIER_BASENAME);
  const fullPages = JSON.parse(readFileSync(privateMaterialPath)).pages.map(({ index, content }) => ({ index, content }));
  let checkpoint = initialData.review_material.checkpoint_ledger;
  let findings = initialData.review_material.findings_ledger;
  for (let index = 1; index < 14; index += 1) {
    checkpoint = appendCheckpointCoverage(checkpoint, [fullPages[index - 1]], initialData.review_material.manifest);
    findings = appendFindingsWindow(findings, { window_index: index, page_indices: [index],
      window_verdict: "PASS", findings: [] });
  }
  const finalData = { ...initialData, review_material: framePagedReviewMaterial({
    manifest: initialData.review_material.manifest, fullPages,
    checkpointLedger: checkpoint, findingsLedger: findings, windowIndex: 14, windowMaxPages: 1,
  }) };
  // Historical packet.md is the mutable last window, not the reserved initial
  // packet. Its old static duties are opaque, never execution authority here.
  const payload = JSON.stringify(finalData);
  writeFileSync(packetPath, "Legacy diagnostic final packet\n" + SECOND_REVIEW_FRAME_MARKER
    + Buffer.byteLength(payload) + "\n\n" + payload + "\nLegacy completion suffix\n");
  context.page_window_full_scan = true;
  context.page_window_max_pages = 1;
  writeFileSync(contextPath, JSON.stringify(context));
  const activity = [{ event: "projection_dispatch_invocation_claimed", attempt_id: context.attempt_id,
    dispatch_id: context.dispatch_id, invocation_claim_sha256: invocationClaimSha256 }];
  for (let i = 0; i < 14; i += 1) {
    activity.push({ event: "projection_cli_started", attempt_id: context.attempt_id, pid: reconciledPid + i });
    activity.push({ event: "projection_page_window_live_gate", attempt_id: context.attempt_id,
      phase: i === 13 ? "final" : "intermediate",
      classification: i === 13 ? "page_window_full_scan_final_no_sticky" : "page_window_intermediate_advanced",
      findings_windows: i + 1, page_window_count: 14, scan_complete: i === 13 });
    if (i < 13) activity.push({ event: "projection_page_window_advanced", attempt_id: context.attempt_id,
      page_window_index: i + 2, page_window_count: 14, findings_windows: i + 1 });
    activity.push({ event: "projection_cli_exited", attempt_id: context.attempt_id, code: 0,
      process_spawned: true, process_close_observed: true, transport_cleanup_confirmed: true });
  }
  const heartbeat = { attempt_id: context.attempt_id,
    status: "blocked", classification: "page_window_full_scan_final_no_sticky",
    sticky: { status: "failed", classification: "page_window_full_scan_final_no_sticky",
      sticky_comment_id: null, dispatch_id: context.dispatch_id,
      pr_number: context.pr_number, last_reviewed_sha: context.head_ref_oid } };
  mkdirSync(markerDir, { recursive: true });
  const markerPath = path.join(markerDir, `pending-post-pr-completion-${context.pr_number}.json`);
  const marker = { prNumber: context.pr_number, repository_slug: context.repository_slug,
    head_ref_oid: context.head_ref_oid, expected_dispatch_id: context.dispatch_id,
    authorityId: "legacy-diagnostic-marker", createdAt: new Date().toISOString(),
    branch: "feature/test", headRefName: "feature/test", worktree: REPO_ROOT };
  const preloadPath = path.join(dir, "reconcile-preload.mjs");
  writeFileSync(preloadPath, reconcilePreloadSource);
  const state = { ...rendered, dir, binDir, preloadPath, record, markerPath, marker, markerDir, privateMaterialPath,
    activity, heartbeat, invocationClaimSha256, argvContextPath: contextPath,
    writeCarrier() {
      writeFileSync(contextPath, JSON.stringify(context));
      writeFileSync(context.activity_log_path, activity.map(row => JSON.stringify(row)).join("\n") + "\n");
      writeFileSync(context.heartbeat_path, JSON.stringify(heartbeat));
      writeFileSync(markerPath, JSON.stringify(marker));
    },
  };
  state.writeCarrier();
  return state;
}

async function credentialReconcileFixture(dir) {
  const state = await reconcileFixture(dir);
  const selection = state.context.reviewer_model_selection;
  await writeReviewerModelRecord({ rootDir: state.context.control_evidence_root, record: {
    ...state.record, reviewer_cli_family: state.context.reviewer_cli_recipe.tool,
    requested_model: selection.requested, requested_source: selection.source,
    requested_source_env_var: selection.env_var ?? "none", requested_kind: requestedKindForSelection(selection, state.context.reviewer_cli_recipe.tool),
    observed_model: selection.requested, observed_source: "execution-stream",
    observed_unavailable_reason: "none", agreement: "exact",
  } });
  state.activity.at(-1).transport_cleanup_confirmed = true;
  state.heartbeat.cli_exit.transport_cleanup_confirmed = true;
  state.heartbeat.classification = "sticky_credential_literal_blocked";
  state.heartbeat.sticky = { status: "failed", classification: "sticky_credential_literal_blocked",
    pr_number: state.context.pr_number, sticky_comment_id: null, sticky_comment_url: null,
    verdict: null, last_reviewed_sha: null, dispatch_id: null,
    expected_head_ref_oid: state.context.head_ref_oid, current_head_ref_oid: null };
  state.writeCarrier();
  return state;
}

function runCredentialReconcile(state, options = {}) {
  const slug = state.context.repository_slug;
  return runReconcile(state, {
    argv: ["--reconcile-credential-gate-terminal", state.contextPath],
    ghResponse: JSON.stringify({ comments: [], completeness: { status: "complete",
      pagination_exhausted: true, pages_fetched: 1 }, query_error: null }),
    ...options,
    credentialEnv: {
      DEVPRO_FAKE_GH_REPO_RESPONSE: JSON.stringify({ full_name: slug, permissions: { push: true } }),
      DEVPRO_FAKE_GH_PR_RESPONSE: JSON.stringify({ number: Number(state.context.pr_number), state: "open",
        merged: false, base: { repo: { full_name: slug } },
        head: { sha: state.context.head_ref_oid, repo: { full_name: slug } } }),
      ...(options.credentialEnv ?? {}),
    },
  });
}

if (PROJECTION_TEST_GROUP === "core") {
  for (const classification of ["sticky_credential_literal_blocked", "sticky_credential_literal_detected"]) {
    nodeTest(`closed native runner retains ${classification} and seals only a failure receipt`, () => {
      withTempDir("credential-inline-", dir => {
        const { context, contextPath } = renderHandoff(dir, prStickyHandoff);
        const binDir = path.join(dir, "bin"); mkdirSync(binDir); writeFakeClaude(binDir); writeFakeGh(binDir);
        writeFileSync(path.join(path.dirname(contextPath), stickyWriteResultBasename(context.dispatch_id)),
          JSON.stringify({ ok: false, classification, dispatch_id: context.dispatch_id }));
        const result = runGeneratedRunnerCommand(context, binDir, {
          DEVPRO_FAKE_GH_RESPONSE: JSON.stringify({ comments: [], headRefOid: context.head_ref_oid }),
          DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({ type: "result", subtype: "success", is_error: false,
            result: JSON.stringify({ sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242",
              verdict: "PASS", last_reviewed_sha: context.head_ref_oid, reviewer_model: "claude-test", reason: "Bounded completed review." }) }),
        });
        assert.equal(result.status, 1, result.stderr + result.stdout);
        assert.equal(JSON.parse(result.stdout).classification, classification);
        const evidence = readDispatchEvidenceStrict({ rootDir: context.control_evidence_root, dispatchId: context.dispatch_id });
        assert.equal(evidence.terminal?.classification, "sticky_contract_invalid");
        assert.equal(evidence.terminal.lifecycle_phase, "post_close_transport_cleaned");
        assert.equal(evidence.completion, null);
      });
    });
  }
}

if (PROJECTION_TEST_GROUP === "core") {
  nodeTest("credential gate recovery writes only a failure terminal and rereads it without mutation", async () => {
    await withTempDirAsync("credential-reconcile-positive-", async dir => {
      const state = await credentialReconcileFixture(dir);
      const originalHeartbeat = readFileSync(state.context.heartbeat_path);
      const originalModel = readFileSync(path.join(state.context.control_evidence_root, state.context.dispatch_id, "reviewer-model-record.json"));
      const result = runCredentialReconcile(state);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const evidence = readDispatchEvidenceStrict({ rootDir: state.context.control_evidence_root, dispatchId: state.context.dispatch_id });
      assert.equal(evidence.terminal.classification, "sticky_contract_invalid");
      assert.equal(evidence.terminal.lifecycle_phase, "post_close_transport_reconciled");
      assert.equal(evidence.completion, null);
      assert.deepEqual(readFileSync(state.context.heartbeat_path), originalHeartbeat);
      assert.deepEqual(readFileSync(evidence.paths.reviewerModelRecord), originalModel);
      const again = runCredentialReconcile(state);
      assert.equal(again.status, 0, again.stderr + again.stdout);
      assert.deepEqual(again.after, again.before, "idempotent retry changes no evidence or carrier bytes");
    });
  });
  nodeTest("credential gate recovery permits only a verified fast-forward PR successor", async () => {
    await withTempDirAsync("credential-reconcile-ff-", async dir => {
      const state = await credentialReconcileFixture(dir);
      const old = state.context.head_ref_oid, next = "e".repeat(40), slug = state.context.repository_slug;
      state.heartbeat.classification = state.heartbeat.sticky.classification = "sticky_credential_literal_detected";
      state.writeCarrier();
      const result = runCredentialReconcile(state, { credentialEnv: {
        DEVPRO_FAKE_GH_PR_RESPONSE: JSON.stringify({ number: Number(state.context.pr_number), state: "open", merged: false,
          base: { repo: { full_name: slug } }, head: { sha: next, repo: { full_name: slug } } }),
        DEVPRO_FAKE_GH_COMPARE_RESPONSE: JSON.stringify({ status: "ahead", behind_by: 0,
          base_commit: { sha: old }, merge_base_commit: { sha: old } }),
      } });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const evidence = readDispatchEvidenceStrict({ rootDir: state.context.control_evidence_root, dispatchId: state.context.dispatch_id });
      assert.equal(evidence.terminal.head_ref_oid, old, "the receipt always closes the original dispatch");
    });
  });
  for (const [name, mutate, options, classification] of [
    ["alive group", () => {}, { kill: "alive" }, "reconcile_process_group_alive"],
    ["unknown group", () => {}, { kill: "eperm" }, "reconcile_process_group_probe_failed"],
    ["missing close", s => { s.activity.pop(); s.writeCarrier(); }, {}, "reconcile_cli_exited_not_exactly_one"],
    ["unclean transport", s => { s.activity.at(-1).transport_cleanup_confirmed = false; s.writeCarrier(); }, {}, "reconcile_lifecycle_not_eligible"],
    ["wrong heartbeat PR", s => { s.heartbeat.sticky.pr_number = "999"; s.writeCarrier(); }, {}, "reconcile_classification_underivable"],
    ["wrong expected head", s => { s.heartbeat.sticky.expected_head_ref_oid = "f".repeat(40); s.writeCarrier(); }, {}, "reconcile_classification_underivable"],
    ["wrong attempt", s => { s.heartbeat.attempt_id = "other"; s.writeCarrier(); }, {}, "reconcile_classification_underivable"],
    ["missing model", s => rmSync(path.join(s.context.control_evidence_root, s.context.dispatch_id, "reviewer-model-record.json")), {}, "reconcile_model_binding_mismatch"],
    ["inconsistent model", async s => {
      const file = path.join(s.context.control_evidence_root, s.context.dispatch_id, "reviewer-model-record.json");
      const record = JSON.parse(readFileSync(file)); rmSync(file);
      await writeReviewerModelRecord({ rootDir: s.context.control_evidence_root,
        record: { ...record, requested_model: "different-selector" } });
    }, {}, "reconcile_model_binding_mismatch"],
    ["competing terminal", async s => {
      await writeTerminalReceipt({ rootDir: s.context.control_evidence_root, record: {
        ...s.record, schema: TERMINAL_RECEIPT_SCHEMA,
        classification: "reviewer_completion_critical", outcome_group: terminalReceiptOutcomeGroup("reviewer_completion_critical"),
        responsibility: TERMINAL_RECEIPT_RESPONSIBILITY, created_at: new Date().toISOString(),
        process_spawned: true, lifecycle_phase: "post_close_transport_cleaned",
        process_close_observed: true, transport_cleanup_confirmed: true, invocation_claim_sha256: s.invocationClaimSha256,
      } });
    }, {}, "reconcile_dispatch_not_reconcilable"],
    ["live individual PID", s => { s.activity[1].pid = process.pid; s.writeCarrier(); }, {}, "reconcile_process_group_alive"],
    ["no repo permission", () => {}, { credentialEnv: { DEVPRO_FAKE_GH_REPO_RESPONSE: JSON.stringify({ full_name: "devpro/example", permissions: { push: false } }) } }, "reconcile_sticky_authority_unverified"],
    ["wrong claim", s => { s.activity[0].invocation_claim_sha256 = "f".repeat(64); s.writeCarrier(); }, {}, "reconcile_claim_binding_mismatch"],
    ["existing sticky", () => {}, { ghResponse: currentHeadStickyResponse("PASS", "other") }, "reconcile_sticky_authority_unverified"],
    ["closed PR", () => {}, { credentialEnv: { DEVPRO_FAKE_GH_PR_RESPONSE: JSON.stringify({ state: "closed" }) } }, "reconcile_sticky_authority_unverified"],
    ["unrelated head", () => {}, { credentialEnv: { DEVPRO_FAKE_GH_PR_RESPONSE: JSON.stringify({ number: 1658, state: "open", merged: false,
      base: { repo: { full_name: "devpro/example" } }, head: { sha: "f".repeat(40), repo: { full_name: "devpro/example" } } }),
      DEVPRO_FAKE_GH_COMPARE_RESPONSE: JSON.stringify({ status: "diverged", behind_by: 1 }) } }, "reconcile_sticky_authority_unverified"],
  ]) nodeTest(`credential gate recovery refuses ${name} without mutation`, async () => {
    await withTempDirAsync("credential-reconcile-negative-", async dir => {
      const state = await credentialReconcileFixture(dir); await mutate(state);
      const result = runCredentialReconcile(state, options);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.equal(JSON.parse(result.stdout).classification, classification);
      assert.deepEqual(result.after, result.before);
    });
  });
}

function runLegacyReconcile(state, options = {}) {
  return runReconcile(state, {
    argv: ["--reconcile-legacy-diagnostic-scan", state.argvContextPath],
    ghResponse: currentHeadStickyResponse("CRITICAL", state.context.previous_dispatch_id),
    ...options,
  });
}

if (PROJECTION_TEST_GROUP === "core") {
  nodeTest("legacy diagnostic reconciliation closes 14 clean windows and unblocks the renderer without granting readiness", async () => {
    await withTempDirAsync("legacy-diagnostic-positive-", async dir => {
      const state = await legacyDiagnosticFixture(dir);
      const nextHead = "d".repeat(40);
      const nextScope = { ...prStickyScope, head_sha: nextHead };
      // Omitted predecessor must be adopted from the marker: exercise the actual
      // renderer assertPriorDispatchIsClosed, not a copied version of its predicate.
      const successor = () => renderHandoff(dir, {
        ...prStickyHandoff, head_ref_oid: nextHead, review_scope: nextScope,
        review_material_proof: canonicalEmbeddedReviewMaterialProof(nextScope, prStickyMaterial),
      }, {
        DEVPRO_POST_PR_COMPLETION_STATE_DIR: state.markerDir,
      });
      assert.throws(successor, /prior-head dispatch must have/);
      const markerBefore = readFileSync(state.markerPath);
      const result = runLegacyReconcile(state);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const evidence = readDispatchEvidenceStrict({ rootDir: state.evidenceRoot, dispatchId: state.context.dispatch_id });
      assert.equal(evidence.terminal.classification, "legacy_diagnostic_scan_closed");
      assert.equal(evidence.terminal.outcome_group, "diagnostic_scan_closed");
      assert.equal(evidence.terminal.lifecycle_phase, "post_close_transport_reconciled");
      assert.equal(evidence.terminal.invocation_claim_sha256, state.invocationClaimSha256);
      assert.equal(evidence.completion, null);
      assert.deepEqual(readFileSync(state.markerPath), markerBefore, "closure must not clear or advance the marker");
      const next = successor();
      assert.equal(next.context.previous_dispatch_id, state.context.dispatch_id);
      assert.notEqual(next.context.dispatch_id, state.context.dispatch_id);
      assert.equal(Object.hasOwn(next.context, "page_window_full_scan"), false);
    });
  });

  const legacyNegatives = [
    ["flag absent", s => { delete s.context.page_window_full_scan; }, "reconcile_legacy_diagnostic_shape_invalid"],
    ["flag false", s => { s.context.page_window_full_scan = false; }, "reconcile_legacy_diagnostic_shape_invalid"],
    ["audit-only", s => { s.context.mode = "audit-only"; }, "reconcile_legacy_diagnostic_shape_invalid"],
    ["external executor", s => { s.context.executor_kind = "external-evaluator"; }, "reconcile_legacy_diagnostic_shape_invalid"],
    ["self path", s => { s.context.observability_context_path += ".other"; }, "reconcile_invocation_invalid"],
    ["missing evidence root", s => { delete s.context.control_evidence_root; }, "reconcile_invocation_invalid"],
    ["relative evidence root", s => { s.context.control_evidence_root = "control-evidence"; }, "reconcile_invocation_invalid"],
    ["array evidence root", s => { s.context.control_evidence_root = [s.evidenceRoot]; }, "reconcile_invocation_invalid"],
    ["carrier path", s => { s.context.heartbeat_path = path.join(s.dir, "other.json"); }, "reconcile_carrier_root_unresolved"],
    ["private material digest", s => {
      const full = JSON.parse(readFileSync(s.privateMaterialPath));
      full.changed_set_authority.comparison_base_sha = "f".repeat(40);
      writeFileSync(s.privateMaterialPath, JSON.stringify(full) + "\n");
    }, "reconcile_carrier_root_unresolved"],
    ["second frame", s => { appendFileSync(s.packetPath, SECOND_REVIEW_FRAME_MARKER + "2\n\n{}"); }, "reconcile_carrier_root_unresolved"],
    ["invalid frame length", s => { writeFileSync(s.packetPath,
      readFileSync(s.packetPath, "utf8").replace(/Content-Length: [0-9]+/, "Content-Length: -1")); }, "reconcile_carrier_root_unresolved"],
    ["claim digest", s => { s.activity[0].invocation_claim_sha256 = "0".repeat(64); }, "reconcile_claim_binding_mismatch"],
    ["missing claim", s => { rmSync(path.join(s.evidenceRoot, s.context.dispatch_id, "invocation-claim.json")); }, "reconcile_dispatch_not_reconcilable"],
    ["missing dispatch", s => { rmSync(path.join(s.evidenceRoot, s.context.dispatch_id, "dispatch.json")); }, "reconcile_dispatch_not_reconcilable"],
    ["malformed external closure", s => { writeFileSync(path.join(s.evidenceRoot, s.context.dispatch_id, "external-closure.json"), "{}"); }, "reconcile_dispatch_not_reconcilable"],
    ["count mismatch", s => { s.context.page_window_count = 13; }, "reconcile_legacy_diagnostic_shape_invalid"],
    ["invalid window size", s => { s.context.page_window_max_pages = 0; }, "reconcile_legacy_diagnostic_shape_invalid"],
    ["edited window size and truncated log", s => {
      s.context.page_window_max_pages = 2;
      s.context.page_window_count = 7;
      s.activity.splice(15);
    }, "reconcile_legacy_diagnostic_shape_invalid"],
    ["missing start", s => { s.activity.splice(1, 1); }, "reconcile_legacy_window_lifecycle_invalid"],
    ["missing advance", s => { s.activity.splice(s.activity.findIndex(e => e.event === "projection_page_window_advanced"), 1); }, "reconcile_legacy_window_lifecycle_invalid"],
    ["gate count drift", s => { s.activity.findLast(e => e.event === "projection_page_window_live_gate").page_window_count = 7; }, "reconcile_legacy_window_lifecycle_invalid"],
    ["duplicate PID", s => { s.activity.filter(e => e.event === "projection_cli_started")[1].pid = s.activity[1].pid; }, "reconcile_legacy_window_lifecycle_invalid"],
    ["missing exit", s => { s.activity.splice(s.activity.findLastIndex(e => e.event === "projection_cli_exited"), 1); }, "reconcile_legacy_window_lifecycle_invalid"],
    ["unclean final window", s => { s.activity.findLast(e => e.event === "projection_cli_exited").transport_cleanup_confirmed = false; }, "reconcile_legacy_window_lifecycle_invalid"],
    ["unobserved close", s => { s.activity.findLast(e => e.event === "projection_cli_exited").process_close_observed = false; }, "reconcile_legacy_window_lifecycle_invalid"],
    ["not spawned", s => { s.activity.findLast(e => e.event === "projection_cli_exited").process_spawned = false; }, "reconcile_legacy_window_lifecycle_invalid"],
    ["nonzero exit", s => { s.activity.findLast(e => e.event === "projection_cli_exited").code = 1; }, "reconcile_legacy_window_lifecycle_invalid"],
    ["overlapping lifecycle", s => { [s.activity[4], s.activity[5]] = [s.activity[5], s.activity[4]]; }, "reconcile_legacy_window_lifecycle_invalid"],
    ["attempt mismatch", s => { s.activity.at(-1).attempt_id = "foreign"; }, "reconcile_attempt_identity_mismatch"],
    ["heartbeat classification", s => { s.heartbeat.classification = "reviewer_completion_critical"; }, "reconcile_classification_underivable"],
    ["heartbeat identity", s => { s.heartbeat.sticky.dispatch_id = foreignDispatchId; }, "reconcile_classification_underivable"],
    ["heartbeat nested classification", s => { s.heartbeat.sticky.classification = "sticky_missing"; }, "reconcile_classification_underivable"],
    ["sticky written", s => { s.heartbeat.sticky.sticky_comment_id = "123"; }, "reconcile_classification_underivable"],
    ["sticky verified", s => { s.heartbeat.sticky.status = "verified"; }, "reconcile_classification_underivable"],
    ["live lock", s => { writeFileSync(s.contextPath + ".attempt.lock", JSON.stringify({ attempt_id: s.context.attempt_id, pid: process.pid, created_at: new Date().toISOString(), owner_token: "live" })); }, "reconcile_dispatch_in_flight"],
    ["foreign marker", s => { s.marker.expected_dispatch_id = foreignDispatchId; }, "reconcile_pending_marker_mismatch"],
    ["stale marker head", s => { s.marker.head_ref_oid = "b".repeat(40); }, "reconcile_pending_marker_mismatch"],
  ];
  for (const [name, mutate, classification] of legacyNegatives) {
    nodeTest(`legacy diagnostic reconciliation fails closed: ${name}`, async () => {
      await withTempDirAsync("legacy-diagnostic-negative-", async dir => {
        const state = await legacyDiagnosticFixture(dir);
        mutate(state);
        state.writeCarrier();
        const result = runLegacyReconcile(state);
        assertReconcileBlocked(result, classification, state.context.dispatch_id);
        assertReconcileWroteNothing(result);
      });
    });
  }

  for (const [name, options, classification] of [
    ["unsupported host", { platform: "win32" }, "reconcile_platform_unsupported"],
    ["live process group", { kill: "alive" }, "reconcile_process_group_alive"],
    ["only final process group alive", { kill: `alive-${reconciledPid + 13}` }, "reconcile_process_group_alive"],
    ["unprovable process group", { kill: "eperm" }, "reconcile_process_group_probe_failed"],
    ["sticky belongs to diagnostic", { ownSticky: true }, "reconcile_sticky_authority_unverified"],
    ["missing sticky", { ghResponse: "[]" }, "reconcile_sticky_authority_unverified"],
    ["stale predecessor head", { staleSticky: true }, "reconcile_sticky_authority_unverified"],
    ["ambiguous sticky", { ambiguousSticky: true }, "reconcile_sticky_authority_unverified"],
    ["invalid sticky contract", { invalidSticky: true }, "reconcile_sticky_authority_unverified"],
  ]) {
    nodeTest(`legacy diagnostic reconciliation fails closed: ${name}`, async () => {
      await withTempDirAsync("legacy-diagnostic-authority-", async dir => {
        const state = await legacyDiagnosticFixture(dir);
        let ghResponse = options.ghResponse ?? currentHeadStickyResponse("CRITICAL", state.context.previous_dispatch_id);
        if (options.staleSticky) ghResponse = ghResponse.replaceAll(prStickyHeadSha, "b".repeat(40));
        if (options.invalidSticky) {
          const response = JSON.parse(ghResponse);
          response.comments[0].body = response.comments[0].body.replace(/\nRules:.*$/, "");
          ghResponse = JSON.stringify(response);
        }
        if (options.ambiguousSticky) {
          const response = JSON.parse(ghResponse);
          response.comments.push({ ...response.comments[0], id: 4243,
            html_url: "https://github.com/devpro/example/pull/1658#issuecomment-4243" });
          ghResponse = JSON.stringify(response);
        }
        const result = runLegacyReconcile(state, {
          ...options,
          ghResponse,
          ...(options.ownSticky ? { ghResponse: currentHeadStickyResponse("CRITICAL", state.context.dispatch_id) } : {}),
        });
        assertReconcileBlocked(result, classification, state.context.dispatch_id);
        assertReconcileWroteNothing(result);
      });
    });
  }

  nodeTest("legacy diagnostic reconciliation closes only once, ignores ambient evidence roots, and leaves an absent marker absent", async () => {
    await withTempDirAsync("legacy-diagnostic-once-", async dir => {
      const state = await legacyDiagnosticFixture(dir);
      rmSync(state.markerPath);
      const decoy = path.join(dir, "decoy-evidence");
      mkdirSync(decoy);
      const result = runLegacyReconcile(state, { controlEvidenceDirOverride: decoy });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(readdirSync(decoy), []);
      assert.equal(existsSync(state.markerPath), false);
      const again = runLegacyReconcile(state);
      assertReconcileBlocked(again, "reconcile_dispatch_not_reconcilable", state.context.dispatch_id);
      assertReconcileWroteNothing(again);
    });
  });

  nodeTest("legacy diagnostic reconciliation arbitrates concurrent exclusive terminal writes", async () => {
    await withTempDirAsync("legacy-diagnostic-collision-", async dir => {
      const state = await legacyDiagnosticFixture(dir);
      const options = { argv: ["--reconcile-legacy-diagnostic-scan", state.contextPath],
        ghResponse: currentHeadStickyResponse("CRITICAL", state.context.previous_dispatch_id) };
      const results = await Promise.all([runReconcileAsync(state, options), runReconcileAsync(state, options)]);
      assert.equal(results.filter(result => result.status === 0).length, 1, JSON.stringify(results));
      const loser = results.find(result => result.status !== 0);
      assert.ok(["reconcile_receipt_collision", "reconcile_dispatch_not_reconcilable", "reconcile_evidence_changed"]
        .includes(JSON.parse(loser.stdout).classification));
      const evidence = readDispatchEvidenceStrict({ rootDir: state.evidenceRoot, dispatchId: state.context.dispatch_id });
      assert.equal(evidence.terminal.classification, "legacy_diagnostic_scan_closed");
    });
  });

  nodeTest("legacy diagnostic reconciliation refuses carrier changes during its live authority query", async () => {
    await withTempDirAsync("legacy-diagnostic-snapshot-", async dir => {
      const state = await legacyDiagnosticFixture(dir);
      appendFileSync(state.preloadPath, `
const { createRequire, syncBuiltinESMExports } = await import("node:module");
const require = createRequire(import.meta.url);
const cp = require("node:child_process");
const fs = require("node:fs");
const nativeSpawnSync = cp.spawnSync;
cp.spawnSync = (tool, args, ...rest) => {
  const result = nativeSpawnSync(tool, args, ...rest);
  if (tool === "gh") fs.appendFileSync(${JSON.stringify(state.contextPath)}, " ");
  return result;
};
syncBuiltinESMExports();
`);
      const result = runLegacyReconcile(state);
      assertReconcileBlocked(result, "reconcile_evidence_changed", state.context.dispatch_id);
      assert.equal(existsSync(path.join(state.evidenceRoot, state.context.dispatch_id, "terminal-receipt.json")), false);
    });
  });

  nodeTest("legacy diagnostic reconciliation checks the configured marker root as well as the context sibling", async () => {
    await withTempDirAsync("legacy-diagnostic-marker-override-", async dir => {
      const state = await legacyDiagnosticFixture(dir);
      const override = path.join(dir, "configured-marker-root");
      mkdirSync(override);
      writeFileSync(path.join(override, path.basename(state.markerPath)),
        JSON.stringify({ ...state.marker, expected_dispatch_id: foreignDispatchId }));
      const result = runLegacyReconcile(state, { markerDirOverride: override });
      assertReconcileBlocked(result, "reconcile_pending_marker_mismatch", state.context.dispatch_id);
      assertReconcileWroteNothing(result);
    });
  });

  nodeTest("legacy diagnostic reconciliation rejects a keyed marker URL for a different PR", async () => {
    await withTempDirAsync("legacy-diagnostic-keyed-url-", async dir => {
      const state = await legacyDiagnosticFixture(dir);
      const [keyed] = postPrMarkerFilenames({ repo: state.context.repository_slug, prNumber: state.context.pr_number });
      const url = `https://github.com/${state.context.repository_slug}/pull/${Number(state.context.pr_number) + 1}`;
      rmSync(state.markerPath);
      writeFileSync(path.join(path.dirname(state.markerPath), keyed), JSON.stringify({ ...state.marker, url }));
      const result = runLegacyReconcile(state);
      assertReconcileBlocked(result, "reconcile_pending_marker_mismatch", state.context.dispatch_id);
      assertReconcileWroteNothing(result);
    });
  });

  nodeTest("legacy diagnostic recovery does not relax normal projection or closed-transport reconciliation", async () => {
    await withTempDirAsync("legacy-diagnostic-isolation-", async dir => {
      const state = await legacyDiagnosticFixture(dir);
      const ordinary = runReconcile(state);
      assertReconcileBlocked(ordinary, "reconcile_carrier_root_unresolved", state.context.dispatch_id);
      assertReconcileWroteNothing(ordinary);
      const normal = await withProcessEnv({ PATH: state.authorityPath,
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: state.evidenceRoot }, () =>
        runProjection(state.contextPath, { cwd: REPO_ROOT, execPath: process.execPath }));
      assert.equal(normal.status, "blocked");
      // The historical packet has advanced beyond the reserved initial hash;
      // normal v5 authorization must reject that identity before context checks.
      assert.equal(normal.classification, "reviewer_dispatch_identity_collision");
    });
  });

  nodeTest("legacy diagnostic flag is rejected on a fresh unclaimed normal dispatch", () => {
    withTempDir("legacy-diagnostic-fresh-flag-", dir => {
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir);
      writeFakeClaude(binDir);
      const { context, contextPath } = renderHandoff(dir, prStickyHandoff);
      context.page_window_full_scan = true;
      writeFileSync(contextPath, JSON.stringify(context));
      const result = runGeneratedRunnerCommand(context, binDir);
      assert.equal(result.status, 1, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "blocked");
      assert.equal(output.classification, "projection_context_invalid");
      assert.match(output.error, /page_window_full_scan has been removed; regenerate/);
      assert.equal(existsSync(`${contextPath}.attempt.lock`), false);
      const events = activityEvents(context.activity_log_path);
      assert.equal(events.includes("projection_dispatch_invocation_claimed"), false);
      assert.equal(events.includes("projection_cli_probe_started"), false);
      assert.equal(events.includes("projection_cli_started"), false);
    });
  });
}

test("R9 reconciliation rejects a context whose dispatch id is not canonical", async () => {
  await withTempDirAsync("second-review-reconcile-c1-", async (dir) => {
    const state = await reconcileFixture(dir, (fixture) => {
      const invalidPath = path.join(dir, "invalid-observability-context.json");
      writeFileSync(
        invalidPath,
        `${JSON.stringify({ ...fixture.context, dispatch_id: "not-a-canonical-dispatch-id" }, null, 2)}\n`,
        "utf8"
      );
      fixture.argvContextPath = invalidPath;
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_invocation_invalid");
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses to run on a host without process groups", async () => {
  await withTempDirAsync("second-review-reconcile-c2-", async (dir) => {
    const state = await reconcileFixture(dir);
    const result = runReconcile(state, { platform: "win32" });
    assertReconcileBlocked(result, "reconcile_platform_unsupported", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses an external-evaluator dispatch even with a hand-written claim and an open closure slot", async () => {
  // External evaluators are never runner-spawned, so the claim API refuses them; a legacy-shape
  // claim (no lifecycle slot) written by hand must still not open ordinary transport reconciliation.
  await withTempDirAsync("second-review-reconcile-c3-external-", async (dir) => {
    const state = await reconcileFixture(dir, async (fixture) => {
      const directory = path.join(fixture.context.control_evidence_root, fixture.context.dispatch_id);
      const dispatchPath = path.join(directory, "dispatch.json");
      const dispatch = JSON.parse(readFileSync(dispatchPath, "utf8"));
      writeFileSync(dispatchPath, `${JSON.stringify({
        ...dispatch, executor_kind: "external-evaluator", reviewer_family: "gemini", primary_family: "claude",
        reviewer_tool: "Gemini CLI", sticky_write_action: "create", sticky_target_comment_id: null,
        sticky_snapshot_digest: "d".repeat(64), issued_at: "2026-08-20T00:00:00.000Z",
      })}\n`);
      rmSync(path.join(directory, "dispatch-lifecycle-slot.json"));
      await writeExternalClosureSlot({ rootDir: fixture.context.control_evidence_root, dispatchId: fixture.context.dispatch_id, kind: "voided" });
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_dispatch_not_reconcilable", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses a dispatch that already carries terminal evidence", async () => {
  await withTempDirAsync("second-review-reconcile-c3-", async (dir) => {
    const state = await reconcileFixture(dir, async (fixture) => {
      await writeTerminalReceipt({
        rootDir: fixture.context.control_evidence_root,
        record: {
          ...fixture.record,
          schema: TERMINAL_RECEIPT_SCHEMA,
          outcome_group: terminalReceiptOutcomeGroup("reviewer_completion_critical"),
          classification: "reviewer_completion_critical",
          responsibility: TERMINAL_RECEIPT_RESPONSIBILITY,
          created_at: "2026-07-20T03:05:00.000Z",
          process_spawned: true,
          lifecycle_phase: "post_close_transport_cleaned",
          process_close_observed: true,
          transport_cleanup_confirmed: true,
          invocation_claim_sha256: fixture.invocationClaimSha256,
        },
      });
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_dispatch_not_reconcilable", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses a claim digest the activity log does not corroborate", async () => {
  await withTempDirAsync("second-review-reconcile-c4-", async (dir) => {
    const state = await reconcileFixture(dir, (fixture) => {
      fixture.activity[0].invocation_claim_sha256 = "0".repeat(64);
      fixture.writeCarrier();
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_claim_binding_mismatch", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses a carrier whose rederived record does not match the reservation", async () => {
  await withTempDirAsync("second-review-reconcile-c5-carrier-", async (dir) => {
    const state = await reconcileFixture(dir, (fixture) => {
      // Same immutable evidence, different carrier: the whole point of binding
      // carrier_root_id is that relocating the carrier cannot mint a receipt.
      const relocated = path.join(dir, "relocated-carrier");
      mkdirSync(relocated, { recursive: true });
      const relocatedContext = { ...fixture.context };
      for (const [key, value] of Object.entries(relocatedContext)) {
        if (!key.endsWith("_path") || typeof value !== "string") continue;
        if (path.dirname(value) !== path.resolve(dir)) continue;
        cpSync(value, path.join(relocated, path.basename(value)));
        relocatedContext[key] = path.join(relocated, path.basename(value));
      }
      const relocatedContextPath = path.join(relocated, "observability-context.json");
      relocatedContext.observability_context_path = relocatedContextPath;
      writeFileSync(relocatedContextPath, `${JSON.stringify(relocatedContext, null, 2)}\n`, "utf8");
      fixture.argvContextPath = relocatedContextPath;
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_carrier_root_unresolved", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses a carrier whose packet bytes changed after reservation", async () => {
  await withTempDirAsync("second-review-reconcile-c5-packet-", async (dir) => {
    const state = await reconcileFixture(dir, (fixture) => {
      writeFileSync(fixture.packetPath, "swapped reviewer packet body\n", "utf8");
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_carrier_root_unresolved", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses an activity log with an unparsable line", async () => {
  await withTempDirAsync("second-review-reconcile-c6-", async (dir) => {
    const state = await reconcileFixture(dir, (fixture) => {
      appendFileSync(fixture.context.activity_log_path, '{"event":"projection_cli_ex\n', "utf8");
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_activity_log_unreadable", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation requires exactly one projection_cli_started with a positive pid", async () => {
  await withTempDirAsync("second-review-reconcile-c7-", async (dir) => {
    const state = await reconcileFixture(dir, (fixture) => {
      fixture.activity.splice(2, 0, { ...fixture.activity[1], pid: reconciledPid + 1 });
      fixture.writeCarrier();
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_cli_started_not_exactly_one", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation requires exactly one projection_cli_exited", async () => {
  await withTempDirAsync("second-review-reconcile-c8-", async (dir) => {
    const state = await reconcileFixture(dir, (fixture) => {
      fixture.activity = fixture.activity.filter((line) => line.event !== "projection_cli_exited");
      fixture.writeCarrier();
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_cli_exited_not_exactly_one", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses a close that already confirmed transport cleanup", async () => {
  await withTempDirAsync("second-review-reconcile-c9-", async (dir) => {
    const state = await reconcileFixture(dir, (fixture) => {
      fixture.activity[2].transport_cleanup_confirmed = true;
      fixture.heartbeat.cli_exit.transport_cleanup_confirmed = true;
      fixture.writeCarrier();
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_lifecycle_not_eligible", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses activity events from a different attempt", async () => {
  await withTempDirAsync("second-review-reconcile-c10-", async (dir) => {
    const state = await reconcileFixture(dir, (fixture) => {
      fixture.activity[1].attempt_id = `${fixture.context.attempt_id}-foreign`;
      fixture.writeCarrier();
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_attempt_identity_mismatch", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses a dispatch whose attempt lock is still held", async () => {
  await withTempDirAsync("second-review-reconcile-c11-", async (dir) => {
    const state = await reconcileFixture(dir, (fixture) => {
      writeFileSync(
        `${fixture.contextPath}.attempt.lock`,
        `${JSON.stringify({
          attempt_id: fixture.context.attempt_id,
          pid: process.pid,
          created_at: "2026-07-20T03:00:00.000Z",
          owner_token: "reconcile-live-owner",
        })}\n`,
        "utf8"
      );
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_dispatch_in_flight", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses a heartbeat whose outcome yields no terminal classification", async () => {
  await withTempDirAsync("second-review-reconcile-c12-", async (dir) => {
    const state = await reconcileFixture(dir, (fixture) => {
      fixture.heartbeat.status = "finished";
      fixture.heartbeat.classification = "reviewer_cli_completed";
      fixture.writeCarrier();
    });
    const result = runReconcile(state);
    assertReconcileBlocked(result, "reconcile_classification_underivable", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses a reviewer process group that is not reaped", async () => {
  await withTempDirAsync("second-review-reconcile-c13-", async (dir) => {
    const state = await reconcileFixture(dir);
    for (const [kill, classification] of [
      ["alive", "reconcile_process_group_alive"],
      ["eperm", "reconcile_process_group_probe_failed"],
    ]) {
      const result = runReconcile(state, { kill });
      assertReconcileBlocked(result, classification, state.context.dispatch_id);
      assertReconcileWroteNothing(result);
    }
  });
});

test("R9 reconciliation refuses a sticky authority that does not name this dispatch", async () => {
  await withTempDirAsync("second-review-reconcile-c14-", async (dir) => {
    const state = await reconcileFixture(dir);
    const result = runReconcile(state, {
      ghResponse: currentHeadStickyResponse("CRITICAL", foreignDispatchId),
    });
    assertReconcileBlocked(result, "reconcile_sticky_authority_unverified", state.context.dispatch_id);
    assertReconcileWroteNothing(result);
  });
});

test("R9 reconciliation refuses an ambient evidence-root redirect without writing to either root", async () => {
  await withTempDirAsync("second-review-reconcile-root-", async (dir) => {
    const state = await reconcileFixture(dir);
    const decoyRoot = makeTempDir("second-review-reconcile-decoy-root-");
    try {
      // The installed runner's authority must not be redirected by the invoking
      // cwd or an ambient override. A conflicting override therefore blocks the
      // reconciliation and may write to neither the renderer-attested root nor
      // the caller-selected decoy.
      const result = runReconcile(state, { controlEvidenceDirOverride: decoyRoot });
      assertReconcileBlocked(
        result,
        "reconcile_dispatch_not_reconcilable",
        state.context.dispatch_id,
      );

      const terminal = terminalReceiptForContext(state.context);
      assert.equal(terminal, null, "a redirected invocation must not mutate the context evidence root");
      assert.deepEqual(
        readdirSync(decoyRoot),
        [],
        "the ambient override must not receive any part of a reconciled receipt"
      );
    } finally {
      rmSync(decoyRoot, { recursive: true, force: true });
    }
  });
});

test("R9 reconciliation mints exactly one terminal receipt when two processes race", async () => {
  await withTempDirAsync("second-review-reconcile-c15-", async (dir) => {
    const state = await reconcileFixture(dir);
    const results = await Promise.all([
      runReconcileAsync(state),
      runReconcileAsync(state),
    ]);
    const winners = results.filter((result) => result.status === 0);
    const losers = results.filter((result) => result.status !== 0);
    assert.equal(winners.length, 1, results.map((r) => `${r.status}: ${r.stdout}${r.stderr}`).join("\n"));
    assert.equal(losers.length, 1);
    assert.ok(
      ["reconcile_receipt_collision", "reconcile_dispatch_not_reconcilable"]
        .includes(JSON.parse(losers[0].stdout).classification),
      losers[0].stdout
    );
    const receiptCount = activityEvents(state.context.activity_log_path)
      .filter((event) => event === "projection_terminal_receipt_written").length;
    assert.equal(receiptCount, 1, "the losing process must not append a second receipt event");
    assert.notEqual(terminalReceiptForContext(state.context), null);
  });
});

test("R9 reconciliation mints a post_close_transport_reconciled receipt for a stuck closed dispatch", async () => {
  await withTempDirAsync("second-review-reconcile-positive-", async (dir) => {
    const state = await reconcileFixture(dir);
    const result = runReconcile(state);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "finished");
    assert.equal(payload.classification, "reviewer_completion_critical");
    assert.equal(payload.dispatch_id, state.context.dispatch_id);

    const terminal = terminalReceiptForContext(state.context);
    assert.equal(terminal?.record.schema, "devpro-second-review-closed-terminal/v1");
    assert.equal(terminal?.record.classification, "reviewer_completion_critical");
    assert.equal(terminal?.record.responsibility, "reviewer_invocation_lifecycle");
    assert.equal(terminal?.record.lifecycle_phase, "post_close_transport_reconciled");
    assert.equal(terminal?.record.process_spawned, true);
    assert.equal(terminal?.record.process_close_observed, true);
    assert.equal(terminal?.record.transport_cleanup_confirmed, true);
    assert.equal(terminal?.record.invocation_claim_sha256, state.invocationClaimSha256);
    assert.equal(Object.keys(terminal?.record ?? {}).length, 17);

    const events = activityEvents(state.context.activity_log_path);
    assert.equal(events.filter((event) => event === "projection_terminal_receipt_written").length, 1);
    assert.equal(events.at(-1), "projection_terminal_receipt_written");
  });
});

// The four guards below assert structure rather than behaviour, because the
// properties they protect cannot be distinguished by any fixture run: an
// enumerating reconciler returns the same answers on a one-carrier fixture, and
// an exported minting function behaves identically until something else imports
// it. Each one strips comments first, so the prose explaining a guard cannot
// satisfy that guard.
const runnerSourceText = readFileSync(runnerScript, "utf8");

function withoutComments(source) {
  // Lexical strip shared with prune-merged-local-c / fix-guard-scope-fidelity.
  // Naive /\/\*[\s\S]*?\*\//g can swallow real code when / * appears in strings.
  return stripJsCommentSpans(source);
}

function reconciliationSourceBlock() {
  const source = withoutComments(runnerSourceText);
  const start = source.indexOf("const reconcileClosedTransportFlag");
  const end = source.indexOf("function parseRunnerArgv");
  assert.ok(start > 0 && end > start, "reconciliation block must be locatable in the runner source");
  return source.slice(start, end);
}

// Scope note: this asserts the reconciliation block itself enumerates nothing.
// It does not — and cannot — claim the whole call tree is enumeration-free:
// readDispatchEvidence reads one already-named dispatch directory with
// readdirSync. That is a single controlled point read of a directory the
// caller already named, not a sweep over the evidence or carrier root, and it
// is shared with every other caller. What must never appear is an enumerator
// *here*, where the only input is one operator-supplied context path.
test("R9 reconciliation block enumerates neither the evidence root nor the carrier root", () => {
  const block = reconciliationSourceBlock();
  for (const enumerator of ["readdirSync", "globSync", "opendirSync", "readdir", "glob"]) {
    assert.equal(
      block.includes(enumerator),
      false,
      `the reconciliation path must reach control evidence by point read and the carrier by the named `
      + `context alone; ${enumerator} here would turn one named dispatch into a sweep`
    );
  }
});

test("R9 receipt minting stays module-private", () => {
  for (const symbol of [
    "closedTerminalClassification",
    "persistClosedTerminalReceipt",
    "reconcileClosedTransport",
  ]) {
    assert.equal(
      Object.hasOwn(runnerModule, symbol),
      false,
      `${symbol} must stay module-private so no other module can mint a closed-terminal receipt`
    );
  }
  const source = withoutComments(runnerSourceText);
  const inlineTerminalStart = source.indexOf("if (status === \"blocked\" && activeOrchestrationEvidence === null)");
  assert.ok(inlineTerminalStart > 0, "inline terminal receipt branch must remain locatable");
  const inlineTerminalBranch = source.slice(inlineTerminalStart, inlineTerminalStart + 2400);
  assert.match(
    inlineTerminalBranch,
    /persistClosedTerminalReceipt\(\{[\s\S]*?rootDir: evidenceRootForContext\(context, executionEnv\)/u,
    "inline terminal receipt must use the execution env evidence root",
  );
});

test("R9 reconciliation argv is a closed two-token form", () => {
  const rejected = [
    [],
    ["--reconcile-closed-transport"],
    ["--reconcile-closed-transport", "a", "b"],
    ["--reconcile-closed-transport", "--force", "x"],
    ["--reconcile-closed-transport", "--reconcile-closed-transport"],
    ["--reconcile-legacy-diagnostic-scan"],
    ["--reconcile-legacy-diagnostic-scan", "a", "b"],
    ["--reconcile-legacy-diagnostic-scan", "--force"],
    ["--reconcile-legacy-diagnostic-scan", "--reconcile-closed-transport"],
    ["--reconcile-credential-gate-terminal"],
    ["--reconcile-credential-gate-terminal", "a", "b"],
    ["--reconcile-credential-gate-terminal", "--force"],
    ["--reconcile-credential-gate-terminal", "--reconcile-closed-transport"],
    ["context.json", "extra"],
    ["--unknown-flag", "context.json"],
  ];
  for (const argv of rejected) {
    const result = spawnSync(process.execPath, [runnerScript, ...argv], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, DEVPRO_CROSS_MODEL_REVIEWER: "" },
    });
    assert.equal(result.status, 2, `argv ${JSON.stringify(argv)} must be a usage error: ${result.stdout}`);
    assert.equal(result.stdout, "", `argv ${JSON.stringify(argv)} must not emit a result payload`);
  }
});

test("R5 runner rejects malformed v5 data before lock, probes, or artifact mutation", async () => {
  const mutations = [
    ["tampered page", (data) => { data.review_material.pages[0].content += "tampered"; }, /(?:review_material|manifest)\.pages\[0\]/],
    ["non-array changed file list", (data) => { data.changed_files_or_touch_list = null; }, /changed_files_or_touch_list must be an array/],
  ];

  await withTempDirAsync("second-review-runner-v5-invalid-", async (dir) => {
    const { packetPath, carrierDir, contextPath, context } = renderHandoff(
      dir,
      largePrStickyHandoff(),
    );
    const canonicalPacket = readFileSync(packetPath);
    const artifactPaths = [
      context.activity_log_path,
      context.heartbeat_path,
      context.stdout_log_path,
      context.stderr_log_path,
      context.cli_probe_result_path,
    ];
    const before = new Map(artifactPaths.map((artifactPath) => [
      artifactPath,
      readFileSync(artifactPath),
    ]));

    for (const [name, mutate, errorPattern] of mutations) {
      writeFileSync(packetPath, canonicalPacket);
      let scopeProbeCalls = 0;
      let reviewerProbeCalls = 0;

      mutateFramedReviewData(packetPath, (data) => {
        assert.equal(data.schema_version, "devpro-second-review-data/v5");
        mutate(data);
      });

      const result = await runProjection(contextPath, {
        scopeProbeOptions: {
          spawnSync() {
            scopeProbeCalls += 1;
            throw new Error("scope probe must not run for invalid paged data");
          },
        },
        probeOptions: {
          runCommand() {
            reviewerProbeCalls += 1;
            throw new Error("reviewer probe must not run for invalid paged data");
          },
        },
      });

      assert.equal(result.status, "blocked", name);
      assert.equal(result.classification, "reviewer_dispatch_identity_collision", name);
      assert.match(result.error, /reviewer_dispatch_identity_collision/, name);
      assert.equal(scopeProbeCalls, 0, name);
      assert.equal(reviewerProbeCalls, 0, name);
      assert.equal(existsSync(`${contextPath}.attempt.lock`), false, name);
      assert.equal(existsSync(context.neutral_cwd_path), false, name);
      for (const [artifactPath, originalBytes] of before) {
        assert.deepEqual(
          readFileSync(artifactPath),
          originalBytes,
          `${name}: ${path.relative(carrierDir, artifactPath)} must remain byte-identical`,
        );
      }
    }
  });
});

test("R5 runner rejects authoritative hunk-byte drift with all headers before effects", async () => {
  await withTempDirAsync("second-review-runner-raw-diff-drift-", async (dir) => {
    const canonicalHandoff = largePrStickyHandoff();
    const canonicalMaterial = canonicalHandoff.review_material;
    const alteredMaterial = canonicalMaterial.replace("+typed runner scope", "+forged runner scope");
    assert.notEqual(alteredMaterial, canonicalMaterial);
    assert.deepEqual(
      alteredMaterial.match(/^diff --git .+$/gmu),
      canonicalMaterial.match(/^diff --git .+$/gmu),
      "fixture must retain every authoritative diff header",
    );
    const alteredHandoff = {
      ...canonicalHandoff,
      review_material: alteredMaterial,
      review_material_proof: canonicalEmbeddedReviewMaterialProof(prStickyScope, alteredMaterial),
    };
    const rendered = renderHandoff(dir, alteredHandoff);
    const artifactPaths = [
      rendered.context.activity_log_path,
      rendered.context.heartbeat_path,
      rendered.context.stdout_log_path,
      rendered.context.stderr_log_path,
      rendered.context.cli_probe_result_path,
    ];
    const before = new Map(artifactPaths.map((artifactPath) => [
      artifactPath,
      readFileSync(artifactPath),
    ]));
    let scopeProbeCalls = 0;
    let reviewerProbeCalls = 0;

    const result = await withProcessEnv({
      PATH: rendered.authorityPath,
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: rendered.evidenceRoot,
      DEVPRO_TEST_SECOND_REVIEW_AUTHORITATIVE_RAW_DIFF_BASE64: Buffer
        .from(canonicalMaterial, "utf8")
        .toString("base64"),
    }, () => runProjection(rendered.contextPath, {
      scopeProbeOptions: {
        spawnSync() {
          scopeProbeCalls += 1;
          throw new Error("scope probe must not run for authoritative raw-diff drift");
        },
      },
      probeOptions: {
        runCommand() {
          reviewerProbeCalls += 1;
          throw new Error("reviewer probe must not run for authoritative raw-diff drift");
        },
      },
    }));

    const effects = artifactPaths.filter((artifactPath) => (
      !readFileSync(artifactPath).equals(before.get(artifactPath))
    )).map((artifactPath) => path.relative(rendered.carrierDir, artifactPath));
    assert.deepEqual({
      status: result.status,
      classification: result.classification,
      scopeProbeCalls,
      reviewerProbeCalls,
      lockCreated: existsSync(`${rendered.contextPath}.attempt.lock`),
      neutralCwdCreated: existsSync(rendered.context.neutral_cwd_path),
      effects,
    }, {
      status: "blocked",
      classification: "review_material_full_closure_invalid",
      scopeProbeCalls: 0,
      reviewerProbeCalls: 0,
      lockCreated: false,
      neutralCwdCreated: false,
      effects: [],
    });
  });
});

test("R5 runner rejects a noncanonical v5 effect path before lock, probes, spawn, or artifact mutation", async () => {
  await withTempDirAsync("second-review-runner-v5-effect-path-", async (dir) => {
    const { carrierDir, contextPath, context } = renderHandoff(
      dir,
      largePrStickyHandoff(),
    );
    const artifactPaths = [
      context.activity_log_path,
      context.heartbeat_path,
      context.stdout_log_path,
      context.stderr_log_path,
      context.cli_probe_result_path,
    ];
    const before = new Map(artifactPaths.map((artifactPath) => [
      artifactPath,
      readFileSync(artifactPath),
    ]));
    const maliciousContext = JSON.parse(readFileSync(contextPath, "utf8"));
    maliciousContext.heartbeat_path = maliciousContext.packet_path;
    writeFileSync(contextPath, JSON.stringify(maliciousContext), "utf8");
    let scopeProbeCalls = 0;
    let reviewerProbeCalls = 0;

    const result = await runProjection(contextPath, {
      scopeProbeOptions: {
        spawnSync() {
          scopeProbeCalls += 1;
          throw new Error("scope probe must not run for a noncanonical effect path");
        },
      },
      probeOptions: {
        runCommand() {
          reviewerProbeCalls += 1;
          throw new Error("reviewer probe must not run for a noncanonical effect path");
        },
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "reviewer_dispatch_identity_collision");
    assert.equal(scopeProbeCalls, 0);
    assert.equal(reviewerProbeCalls, 0);
    assert.equal(existsSync(`${contextPath}.attempt.lock`), false);
    assert.equal(existsSync(context.neutral_cwd_path), false);
    for (const [artifactPath, originalBytes] of before) {
      assert.deepEqual(
        readFileSync(artifactPath),
        originalBytes,
        `${path.relative(carrierDir, artifactPath)} must remain byte-identical`,
      );
    }
  });
});

test("R5 trusted v5 seal, not a post-auth disk reread, supplies reviewer stdin", async () => {
  await withTempDirAsync("second-review-runner-v5-sealed-stdin-", async (dir) => {
    const binDir = path.join(dir, "bin");
    const stdinLog = path.join(dir, "reviewer-stdin.log");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const rendered = renderHandoff(dir, largePrStickyHandoff());
    const initialPacket = readFileSync(rendered.packetPath);
    assert.equal(
      parseCanonicalSecondReviewPacketData(initialPacket).schema_version,
      "devpro-second-review-data/v5",
    );
    let diskSubstituted = false;

    await withProcessEnv({
      PATH: `${binDir}${path.delimiter}${rendered.authorityPath}`,
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: rendered.evidenceRoot,
      DEVPRO_FAKE_REVIEWER_STDIN_LOG: stdinLog,
    }, async () => {
      const result = await runProjection(rendered.contextPath, {
        executableDiscoveryOptions: {
          pathValue: binDir,
          realpathSyncImpl(candidate) {
            if (!diskSubstituted) {
              diskSubstituted = true;
              writeFileSync(rendered.packetPath, "ATTACKER_POST_AUTH_PACKET\n", "utf8");
            }
            return realpathSync(candidate);
          },
        },
        stickyDispositionOptions: verifiedEmptyStickyDispositionOptions,
        scopeProbeOptions: {
          spawnSync: fullPrScopeProbeSpawnSync(),
        },
      });
      assert.equal(diskSubstituted, true, "fixture must replace the disk carrier after auth");
      assert.equal(existsSync(stdinLog), true, `reviewer must spawn: ${JSON.stringify(result)}`);
    });

    assert.equal(readFileSync(rendered.packetPath, "utf8"), "ATTACKER_POST_AUTH_PACKET\n");
    assert.equal(
      readFileSync(stdinLog, "utf8"),
      initialPacket.toString("utf8").replace(/\n+$/u, ""),
      "reviewer stdin must remain the canonical trusted packet captured before substitution",
    );
  });
});

test("R5 runner cannot bypass trusted v5 authorization through a redirected lawful v4 packet", async () => {
  await withTempDirAsync("second-review-runner-v5-v4-redirect-", async (dir) => {
    const targetDir = path.join(dir, "target");
    const attackerDir = path.join(dir, "attacker");
    mkdirSync(targetDir);
    mkdirSync(attackerDir);
    const target = renderHandoff(targetDir, largePrStickyHandoff());
    const attacker = renderHandoff(attackerDir, prStickyHandoff);
    await withProcessEnv({
      PATH: target.authorityPath,
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: target.evidenceRoot,
    }, async () => {
      assert.equal(
        process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR,
        target.evidenceRoot,
        "redirect rejection must run under the outer v5 control-evidence root",
      );
      assert.equal(
        process.env.PATH,
        target.authorityPath,
        "redirect rejection must run under the outer v5 immutable authority",
      );
      const trustedTarget = authorizeSecondReviewPacketFile({ contextPath: target.contextPath });
      assert.equal(trustedTarget.data.schema_version, "devpro-second-review-data/v5");
      assert.equal(trustedTarget.context.packet_path, target.packetPath);
      assert.equal(
        parseCanonicalSecondReviewPacketData(readFileSync(attacker.packetPath)).schema_version,
        "devpro-second-review-data/v4",
      );
      const artifactPaths = [
        target.context.activity_log_path,
        target.context.heartbeat_path,
        target.context.stdout_log_path,
        target.context.stderr_log_path,
        target.context.cli_probe_result_path,
      ];
      const before = new Map(artifactPaths.map((artifactPath) => [artifactPath, readFileSync(artifactPath)]));
      const redirected = JSON.parse(readFileSync(target.contextPath, "utf8"));
      redirected.packet_path = attacker.packetPath;
      redirected.page_window_checkpoint_handoff = false;
      redirected.reviewer_cli_recipe = attacker.context.reviewer_cli_recipe;
      writeFileSync(target.contextPath, JSON.stringify(redirected), "utf8");
      assert.equal(JSON.parse(readFileSync(target.contextPath, "utf8")).packet_path, attacker.packetPath);
      let scopeProbeCalls = 0;
      let reviewerProbeCalls = 0;

      const result = await runProjection(target.contextPath, {
        scopeProbeOptions: {
          spawnSync() {
            scopeProbeCalls += 1;
            throw new Error("scope probe must not run for a redirected packet");
          },
        },
        probeOptions: {
          runCommand() {
            reviewerProbeCalls += 1;
            throw new Error("reviewer probe must not run for a redirected packet");
          },
        },
      });
      const effects = artifactPaths.filter((artifactPath) => (
        !readFileSync(artifactPath).equals(before.get(artifactPath))
      )).map((artifactPath) => path.relative(target.carrierDir, artifactPath));

      assert.deepEqual({
        status: result.status,
        classification: result.classification,
        error: result.error,
        scopeProbeCalls,
        reviewerProbeCalls,
        lockCreated: existsSync(`${target.contextPath}.attempt.lock`),
        neutralCwdCreated: existsSync(target.context.neutral_cwd_path),
        effects,
      }, {
        status: "blocked",
        classification: "reviewer_dispatch_identity_collision",
        error: "second-review trusted authorization failed: reviewer_dispatch_identity_collision",
        scopeProbeCalls: 0,
        reviewerProbeCalls: 0,
        lockCreated: false,
        neutralCwdCreated: false,
        effects: [],
      });
    });
  });
});

test("R5 runner treats a post-authorization context mutation at seal recheck as terminal before effects", async () => {
  await withTempDirAsync("second-review-runner-v5-recheck-", async (dir) => {
    const rendered = renderHandoff(dir, largePrStickyHandoff());
    const artifactPaths = [
      rendered.context.activity_log_path,
      rendered.context.heartbeat_path,
      rendered.context.stdout_log_path,
      rendered.context.stderr_log_path,
      rendered.context.cli_probe_result_path,
    ];
    const before = new Map(artifactPaths.map((artifactPath) => [artifactPath, readFileSync(artifactPath)]));
    const loaderPath = path.join(dir, "trusted-recheck-loader.mjs");
    const harnessPath = path.join(dir, "trusted-recheck-harness.mjs");
    const validatorUrl = pathToFileURL(repoPath(".devpro/scripts/validate-second-review-packet.mjs")).href;
    writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (url === ${JSON.stringify(validatorUrl)}) {
    const realUrl = url + "?trusted-recheck-real";
    return {
      format: "module",
      shortCircuit: true,
      source: \`
        import { readFileSync, writeFileSync } from "node:fs";
        import * as real from \${JSON.stringify(realUrl)};
        export * from \${JSON.stringify(realUrl)};
        export function assertTrustedSecondReviewAuthorization(authorization, contextPath) {
          const changed = JSON.parse(readFileSync(contextPath, "utf8"));
          changed.heartbeat_path = changed.packet_path;
          writeFileSync(contextPath, JSON.stringify(changed), "utf8");
          return real.assertTrustedSecondReviewAuthorization(authorization, contextPath);
        }
      \`,
    };
  }
  return nextLoad(url, context);
}
`, "utf8");
    writeFileSync(harnessPath, `
import { existsSync } from "node:fs";
import { runProjection } from ${JSON.stringify(pathToFileURL(runnerScript).href)};
let scopeProbeCalls = 0;
let reviewerProbeCalls = 0;
const contextPath = process.argv[2];
const neutralCwdPath = process.argv[3];
const result = await runProjection(contextPath, {
  scopeProbeOptions: { spawnSync() { scopeProbeCalls += 1; throw new Error("unexpected scope probe"); } },
  probeOptions: { runCommand() { reviewerProbeCalls += 1; throw new Error("unexpected reviewer probe"); } },
});
process.stdout.write(JSON.stringify({
  result,
  scopeProbeCalls,
  reviewerProbeCalls,
  lockCreated: existsSync(contextPath + ".attempt.lock"),
  neutralCwdCreated: existsSync(neutralCwdPath),
}));
`, "utf8");

    const child = spawnSync(process.execPath, [
      "--experimental-loader",
      pathToFileURL(loaderPath).href,
      harnessPath,
      rendered.contextPath,
      rendered.context.neutral_cwd_path,
    ], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: rendered.authorityPath,
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: rendered.evidenceRoot,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const observed = JSON.parse(child.stdout);
    const effects = artifactPaths.filter((artifactPath) => (
      !readFileSync(artifactPath).equals(before.get(artifactPath))
    )).map((artifactPath) => path.relative(rendered.carrierDir, artifactPath));

    assert.deepEqual({
      status: observed.result.status,
      classification: observed.result.classification,
      scopeProbeCalls: observed.scopeProbeCalls,
      reviewerProbeCalls: observed.reviewerProbeCalls,
      lockCreated: observed.lockCreated,
      neutralCwdCreated: observed.neutralCwdCreated,
      effects,
    }, {
      status: "blocked",
      classification: "reviewer_dispatch_identity_collision",
      scopeProbeCalls: 0,
      reviewerProbeCalls: 0,
      lockCreated: false,
      neutralCwdCreated: false,
      effects: [],
    });
  });
});

test("R5 runner completes ack authorization preflight before ownership or observability effects", async () => {
  await withTempDirAsync("second-review-runner-v5-ack-preflight-", async (dir) => {
    const rendered = renderHandoff(dir, largePrStickyHandoff());
    const artifactPaths = [
      rendered.context.activity_log_path,
      rendered.context.heartbeat_path,
      rendered.context.stdout_log_path,
      rendered.context.stderr_log_path,
      rendered.context.cli_probe_result_path,
    ];
    const before = new Map(artifactPaths.map((artifactPath) => [artifactPath, readFileSync(artifactPath)]));
    const loaderPath = path.join(dir, "trusted-ack-preflight-loader.mjs");
    const harnessPath = path.join(dir, "trusted-ack-preflight-harness.mjs");
    const ownershipMarkerPath = path.join(dir, "ownership-attempted.marker");
    const validatorUrl = pathToFileURL(repoPath(".devpro/scripts/validate-second-review-packet.mjs")).href;
    const attemptLockUrl = pathToFileURL(sharedAttemptLockScript).href;
    writeFileSync(loaderPath, `
let trustedAssertionCount = 0;
export async function load(url, context, nextLoad) {
  if (url === ${JSON.stringify(validatorUrl)}) {
    const realUrl = url + "?trusted-ack-preflight-real";
    return {
      format: "module",
      shortCircuit: true,
      source: \`
        import { readFileSync, renameSync, writeFileSync } from "node:fs";
        import * as real from \${JSON.stringify(realUrl)};
        export * from \${JSON.stringify(realUrl)};
        let assertionCount = 0;
        export function assertTrustedSecondReviewAuthorization(authorization, contextPath) {
          const result = real.assertTrustedSecondReviewAuthorization(authorization, contextPath);
          assertionCount += 1;
          if (assertionCount === 1) {
            const changed = JSON.parse(readFileSync(contextPath, "utf8"));
            changed.heartbeat_path = changed.packet_path;
            const replacementPath = contextPath + ".replacement";
            writeFileSync(replacementPath, JSON.stringify(changed), "utf8");
            renameSync(replacementPath, contextPath);
          }
          return result;
        }
      \`,
    };
  }
  if (url === ${JSON.stringify(attemptLockUrl)}) {
    const realUrl = url + "?trusted-ack-preflight-real";
    return {
      format: "module",
      shortCircuit: true,
      source: \`
        import { writeFileSync } from "node:fs";
        import * as real from \${JSON.stringify(realUrl)};
        export * from \${JSON.stringify(realUrl)};
        export function acquireAttemptOwnership(...args) {
          writeFileSync(${JSON.stringify(ownershipMarkerPath)}, "attempted\\\\n", "utf8");
          return real.acquireAttemptOwnership(...args);
        }
      \`,
    };
  }
  return nextLoad(url, context);
}
`, "utf8");
    writeFileSync(harnessPath, `
import { existsSync } from "node:fs";
import { runProjection } from ${JSON.stringify(pathToFileURL(runnerScript).href)};
let scopeProbeCalls = 0;
let reviewerProbeCalls = 0;
const contextPath = process.argv[2];
const neutralCwdPath = process.argv[3];
const ownershipMarkerPath = process.argv[4];
const result = await runProjection(contextPath, {
  scopeProbeOptions: { spawnSync() { scopeProbeCalls += 1; throw new Error("unexpected scope probe"); } },
  probeOptions: { runCommand() { reviewerProbeCalls += 1; throw new Error("unexpected reviewer probe"); } },
});
process.stdout.write(JSON.stringify({
  result,
  scopeProbeCalls,
  reviewerProbeCalls,
  ownershipAttempted: existsSync(ownershipMarkerPath),
  lockCreated: existsSync(contextPath + ".attempt.lock"),
  neutralCwdCreated: existsSync(neutralCwdPath),
}));
`, "utf8");

    const child = spawnSync(process.execPath, [
      "--experimental-loader",
      pathToFileURL(loaderPath).href,
      harnessPath,
      rendered.contextPath,
      rendered.context.neutral_cwd_path,
      ownershipMarkerPath,
    ], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: rendered.authorityPath,
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: rendered.evidenceRoot,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const observed = JSON.parse(child.stdout);
    const effects = artifactPaths.filter((artifactPath) => (
      !readFileSync(artifactPath).equals(before.get(artifactPath))
    )).map((artifactPath) => path.relative(rendered.carrierDir, artifactPath));

    assert.deepEqual({
      status: observed.result.status,
      classification: observed.result.classification,
      scopeProbeCalls: observed.scopeProbeCalls,
      reviewerProbeCalls: observed.reviewerProbeCalls,
      ownershipAttempted: observed.ownershipAttempted,
      lockCreated: observed.lockCreated,
      neutralCwdCreated: observed.neutralCwdCreated,
      effects,
    }, {
      status: "blocked",
      classification: "reviewer_dispatch_identity_collision",
      scopeProbeCalls: 0,
      reviewerProbeCalls: 0,
      ownershipAttempted: false,
      lockCreated: false,
      neutralCwdCreated: false,
      effects: [],
    });
  });
});

// ---------------------------------------------------------------------------
// T9 (Part B5/B8, R6/R7) — Prove-it contract test for the isolated-CODEX_HOME
// credential-continuity gate (design.md D3/D7). Five independently-attributable
// assertions, each individually recorded so a partial-red state is diagnosable on its
// own (mirrors T1's per-numbered-test red-state reporting). Baseline before any of
// T10-T22 landed: `grep -rn 'CODEX_HOME' .devpro/scripts --include='*.mjs'` -> 0 hits;
// `grep -rn 'maxRetries\|retryDelay' .devpro/scripts --include='*.mjs'` -> 0 hits;
// `grep -rn 'codex_home_clamp_not_applied' .devpro/scripts --include='*.mjs'` -> 0 hits.
// ---------------------------------------------------------------------------

function reviewerHomeTestFixtureContext(overrides = {}) {
  return {
    repository_slug: "devpro/example",
    pr_number: "1658",
    neutral_cwd_path: path.join(tmpdir(), "devpro-second-review-neutral-fixture"),
    reviewer_cli_recipe: { tool: "codex" },
    ...overrides,
  };
}

test("T9(1/5): spawn env assembly names CODEX_HOME — landed by T19-T21 (step 1-3)", () => {
  const source = readFileSync(runnerScript, "utf8");
  assert.match(source, /CODEX_HOME/, "spawn env assembly must name CODEX_HOME once steps 1-3 land");
});

test("T9(2/5): isolated home directory name embeds the runner's own process.pid at mkdirSync time", () => {
  assert.equal(typeof runnerModule.__testReviewerHome, "object", "reviewer-home test seam must exist");
  const { classifyReviewerHomeEntryName, reviewerHomeDirName } = runnerModule.__testReviewerHome;
  const name = reviewerHomeDirName(process.pid, "dispatch-t9");
  const classification = classifyReviewerHomeEntryName(name);
  assert.equal(classification.kind, "active");
  assert.equal(classification.pid, process.pid);
  assert.equal(classification.dispatchId, "dispatch-t9");
});

test("T9(3/5): on win32 the spawn env's TEMP/TMP equal reviewerIsolatedTmpdir(...)", () => {
  assert.equal(typeof runnerModule.__testReviewerSpawnEnv, "object", "D7 spawn-env test seam must exist");
  const context = reviewerHomeTestFixtureContext();
  const env = runnerModule.__testReviewerSpawnEnv.reviewerSpawnEnv(context, { platform: "win32", baseEnv: {} });
  const isolatedTmpdir = path.join(context.neutral_cwd_path, "reviewer-tmp");
  assert.equal(env.TEMP, isolatedTmpdir);
  assert.equal(env.TMP, isolatedTmpdir);
  assert.equal(env.TMPDIR, isolatedTmpdir);
});

test("T9(4/5): teardown-retry-exhaustion always fails closed for the dispatch's own isolated home", () => {
  assert.equal(typeof runnerModule.__testReviewerHome, "object", "reviewer-home test seam must exist");
  const { teardownReviewerHome } = runnerModule.__testReviewerHome;
  const result = teardownReviewerHome({
    dir: "/nonexistent/reviewer-home-fixture",
    root: "/nonexistent",
    scope: "own",
    deps: {
      rmSync() {
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      },
    },
  });
  assert.equal(result.outcome, "fail_closed");
  assert.equal(result.reason, "reviewer_home_teardown_retry_exhausted");
});

test("T9(5/5): degrade diagnostic codex_home_clamp_not_applied exists — landed by T22 (step 5)", () => {
  const source = readFileSync(runnerScript, "utf8");
  assert.match(source, /codex_home_clamp_not_applied/);
});

// ---------------------------------------------------------------------------
// T10-T17 (Part B5/B8, R6) — store-agnostic isolated-CODEX_HOME reviewer-home
// skeleton: path/naming invariants, closed creation set, owner.json crash-consistent
// publication, ownership determination, teardown fail-closed ladder, and
// ownership-based reclaim. See design.md D3 steps 0/4.
// ---------------------------------------------------------------------------

function reviewerHomeDeadPid() {
  const result = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Number.isInteger(result.pid), "spawnSync should expose child pid");
  return result.pid;
}

function withReviewerHomeRoot(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "devpro-reviewer-home-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function backdateMtime(target, ageMs) {
  const past = new Date(Date.now() - ageMs);
  utimesSync(target, past, past);
}

function backdatedIso(ageMs) {
  return new Date(Date.now() - ageMs).toISOString();
}

// scavengeReviewerHomes() derives oldEnough from totalTimeoutMs(context), which
// defaults to 30 minutes. Rather than backdating fixtures by geological ages, shrink
// the env-derived threshold for the duration of fn() — this also incidentally proves
// the threshold really is env-derived (T17's dedicated test covers that directly).
function withSmallReclaimThreshold(fn) {
  const previous = process.env.DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS;
  process.env.DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS = "1000";
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS;
    else process.env.DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS = previous;
  }
}

// T10 — P-ID invariant: the isolated home directory name embeds the runner's own
// process.pid at mkdirSync time (design.md T5 negative test 13), not a spawned child pid.
test("T10: isolated home directory name resolves to a responsible pid equal to the runner's own process.pid", () => {
  withReviewerHomeRoot((root) => {
    const { createReviewerIsolatedHome, classifyReviewerHomeEntryName } = runnerModule.__testReviewerHome;
    const { dir, owner } = createReviewerIsolatedHome({ controlRoot: root, pid: process.pid, dispatchId: "dispatch-t10" });
    const classification = classifyReviewerHomeEntryName(path.basename(dir));
    assert.equal(classification.kind, "active");
    assert.equal(classification.pid, process.pid);
    assert.equal(owner.owner_pid, process.pid);
  });
});

test("T10: the isolated home directory name is not rewritten by mkdirSync-time creation (only T17's quarantine rename renames it)", () => {
  withReviewerHomeRoot((root) => {
    const { createReviewerIsolatedHome, reviewerIsolatedHomePath } = runnerModule.__testReviewerHome;
    const { dir } = createReviewerIsolatedHome({ controlRoot: root, pid: process.pid, dispatchId: "dispatch-t10b" });
    assert.equal(dir, reviewerIsolatedHomePath(root, process.pid, "dispatch-t10b"));
    assert.equal(existsSync(dir), true);
  });
});

// T11 — family naming grammar + closed creation-set (design.md T5 negative tests
// 14(a)/14(b)/14(c)).
test("T11: family naming grammar classifies active / quarantine / unrecognized forms", () => {
  const { classifyReviewerHomeEntryName } = runnerModule.__testReviewerHome;
  assert.deepEqual(classifyReviewerHomeEntryName(".reviewer-home.4242.dispatch-abc.def"), {
    kind: "active",
    pid: 4242,
    dispatchId: "dispatch-abc.def",
  });
  assert.deepEqual(classifyReviewerHomeEntryName(".reviewer-home.recovery.4242.11111111-1111-1111-1111-111111111111"), {
    kind: "quarantine",
    pid: 4242,
    uuid: "11111111-1111-1111-1111-111111111111",
  });
  for (const unrecognized of [
    ".reviewer-home",
    ".reviewer-home.",
    ".reviewer-home.notapid.dispatch",
    ".reviewer-home.0.dispatch",
    ".reviewer-home.recovery",
    ".reviewer-home.recovery.notapid.uuid",
    ".capacity-lock",
    "not-a-reviewer-home-at-all",
  ]) {
    assert.equal(classifyReviewerHomeEntryName(unrecognized).kind, "unrecognized", unrecognized);
  }
});

test("T11: closed creation-set guard admits exactly the four kinds and rejects everything else", () => {
  const { assertReviewerHomeCreationName } = runnerModule.__testReviewerHome;
  for (const admitted of ["owner.json", "config.toml", "auth.json", `.owner.json.${"11111111-1111-1111-1111-111111111111"}.tmp`]) {
    assert.equal(assertReviewerHomeCreationName(admitted), admitted);
  }
  // design.md T5 negative tests 14(a)/14(b)/14(c): temp->rename publication is closed to
  // owner.json only — a .auth.json.*.tmp or .config.toml.*.tmp MUST go red.
  for (const rejected of [
    `.auth.json.${"11111111-1111-1111-1111-111111111111"}.tmp`,
    `.config.toml.${"11111111-1111-1111-1111-111111111111"}.tmp`,
    "owner.json.tmp",
    "random.txt",
    "mcp_servers.toml",
  ]) {
    assert.throws(() => assertReviewerHomeCreationName(rejected), /outside the closed creation set/, rejected);
  }
});

test("T11: an fs-seam observation of everything createReviewerIsolatedHome creates stays within the closed creation set", () => {
  withReviewerHomeRoot((root) => {
    const { createReviewerIsolatedHome, assertReviewerHomeCreationName } = runnerModule.__testReviewerHome;
    const createdNames = [];
    createReviewerIsolatedHome({
      controlRoot: root,
      pid: process.pid,
      dispatchId: "dispatch-t11-seam",
      fsSeam: {
        openSync(target, ...rest) {
          createdNames.push(path.basename(target));
          return openSync(target, ...rest);
        },
        renameSync(from, to) {
          createdNames.push(path.basename(to));
          return renameSync(from, to);
        },
      },
    });
    assert.ok(createdNames.length > 0);
    for (const name of createdNames) {
      assert.doesNotThrow(() => assertReviewerHomeCreationName(name), `unexpected creation name: ${name}`);
    }
  });
});

test("T11: config.toml key allowlist rejects mcp_servers unconditionally and rejects keys outside the caller's allowlist", () => {
  const { assertReviewerHomeConfigTomlKeyAllowed } = runnerModule.__testReviewerHome;
  assert.equal(assertReviewerHomeConfigTomlKeyAllowed("model", ["model"]), "model");
  // Hard-rejected even when a (hypothetically attacker-controlled) allowlist admits it —
  // defense in depth so the "never mcp_servers" property survives whatever allowlist
  // T19 eventually populates.
  assert.throws(
    () => assertReviewerHomeConfigTomlKeyAllowed("mcp_servers", ["mcp_servers"]),
    /MUST NOT contain tool-surface key/,
  );
  assert.throws(
    () => assertReviewerHomeConfigTomlKeyAllowed("unlisted_key", ["model"]),
    /is not on the allowlist/,
  );
});

test("T11: an isolated-home fixture config.toml built from an allowlist never contains mcp_servers", () => {
  withReviewerHomeRoot((root) => {
    const { assertReviewerHomeConfigTomlKeyAllowed } = runnerModule.__testReviewerHome;
    const allowlist = ["model"];
    const entries = { model: "gpt-5-codex" };
    for (const key of Object.keys(entries)) assertReviewerHomeConfigTomlKeyAllowed(key, allowlist);
    const fixtureConfigToml = path.join(root, "config.toml");
    writeFileSync(
      fixtureConfigToml,
      Object.entries(entries).map(([key, value]) => `${key} = "${value}"\n`).join(""),
      "utf8",
    );
    const content = readFileSync(fixtureConfigToml, "utf8");
    assert.equal((content.match(/mcp_servers/g) ?? []).length, 0);
  });
});

// T12 — owner.json crash-consistent publication (design.md T5 F-2-2 item / negative test 9).
test("T12: owner.json publication order is rename -> fsyncDirectory -> credential-continuity file creation, strictly", () => {
  withReviewerHomeRoot((root) => {
    const { createReviewerIsolatedHome } = runnerModule.__testReviewerHome;
    const calls = [];
    createReviewerIsolatedHome({
      controlRoot: root,
      pid: process.pid,
      dispatchId: "dispatch-t12-order",
      fsSeam: {
        renameSync(from, to) {
          calls.push({ op: "renameSync", tempBasename: path.basename(from) });
          return renameSync(from, to);
        },
        fsyncDirectory(dir, ...rest) {
          calls.push({ op: "fsyncDirectory" });
          return fsyncDirectoryReal(dir, ...rest);
        },
      },
      afterOwnerPublished() {
        // Models T19/T20's credential-continuity file creation for ordering purposes
        // only (T9-T17 does not itself create any continuation file).
        calls.push({ op: "credential-continuity-file-create" });
      },
    });
    assert.deepEqual(
      calls.map((call) => call.op),
      ["renameSync", "fsyncDirectory", "credential-continuity-file-create"],
    );
    assert.notEqual(calls[0].tempBasename, "owner.json");
    assert.match(calls[0].tempBasename, /^\.owner\.json\..+\.tmp$/);
  });
});

test("T12: before rename the temp name is not owner.json; after publication the temp name no longer exists", () => {
  withReviewerHomeRoot((root) => {
    const { createReviewerIsolatedHome } = runnerModule.__testReviewerHome;
    let tempDirname = null;
    let listingDuringWrite = null;
    const { dir } = createReviewerIsolatedHome({
      controlRoot: root,
      pid: process.pid,
      dispatchId: "dispatch-t12-temp",
      fsSeam: {
        openSync(target, ...rest) {
          tempDirname = path.dirname(target);
          return openSync(target, ...rest);
        },
        writeFileSync(fd, bytes) {
          // At this point the temp file exists on disk but the final owner.json must not yet.
          listingDuringWrite = readdirSync(tempDirname);
          return writeFileSync(fd, bytes);
        },
      },
    });
    assert.equal(listingDuringWrite.includes("owner.json"), false);
    assert.equal(listingDuringWrite.some((entry) => entry.endsWith(".tmp")), true);
    const entries = readdirSync(dir);
    assert.deepEqual(entries.sort(), ["owner.json"]);
    assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
  });
});

test("T12: owner.json content carries home_dev/home_ino and a fixed schema, and owner_pid equals the directory-name pid", () => {
  withReviewerHomeRoot((root) => {
    const { createReviewerIsolatedHome, REVIEWER_HOME_OWNER_SCHEMA } = runnerModule.__testReviewerHome;
    const { dir, owner, stat } = createReviewerIsolatedHome({
      controlRoot: root,
      pid: process.pid,
      dispatchId: "dispatch-t12-content",
    });
    const onDisk = JSON.parse(readFileSync(path.join(dir, "owner.json"), "utf8"));
    assert.equal(onDisk.schema, REVIEWER_HOME_OWNER_SCHEMA);
    assert.equal(REVIEWER_HOME_OWNER_SCHEMA, "devpro-second-review-reviewer-home-owner/v1");
    assert.equal(onDisk.owner_pid, process.pid);
    assert.equal(onDisk.home_dev, stat.dev);
    assert.equal(onDisk.home_ino, stat.ino);
    assert.deepEqual(onDisk, owner);
  });
});

test("T12: an owner.json with an injected extra key is not canonical and readReviewerHomeOwner rejects it", () => {
  withReviewerHomeRoot((root) => {
    const { readReviewerHomeOwner, REVIEWER_HOME_OWNER_SCHEMA } = runnerModule.__testReviewerHome;
    const dir = path.join(root, "victim-extra-key");
    mkdirSync(dir, { mode: 0o700 });
    const stat = lstatSync(dir);
    // Same six required fields as a legitimate owner record, plus one extra key an
    // attacker (or a future accidental field addition) might inject. The exact sorted
    // key-set comparison (mirroring assertCapacityLockOwner's precedent) must reject this
    // even though every required field individually validates and
    // canonicalReviewerHomeOwnerBytes() would otherwise round-trip it byte-for-byte.
    const withExtraKey = {
      schema: REVIEWER_HOME_OWNER_SCHEMA,
      owner_pid: process.pid,
      owner_token: "55555555-5555-5555-5555-555555555555",
      created_at: new Date().toISOString(),
      home_dev: stat.dev,
      home_ino: stat.ino,
      injected_extra_key: "attacker-controlled",
    };
    writeFileSync(path.join(dir, "owner.json"), `${JSON.stringify(withExtraKey)}\n`, "utf8");
    assert.equal(readReviewerHomeOwner(dir), null);
  });
});

// T13 — scan + ownership determination.
test("T13: ownership requires name pattern, parent == controlEvidenceRoot, and lstat proving a real directory", () => {
  withReviewerHomeRoot((root) => {
    const { reviewerHomeOwnership, reviewerHomeDirName } = runnerModule.__testReviewerHome;

    assert.equal(reviewerHomeOwnership(root, "not-a-reviewer-home").owned, false);
    assert.equal(reviewerHomeOwnership(root, "not-a-reviewer-home").reason, "unrecognized_name");

    const activeName = reviewerHomeDirName(process.pid, "dispatch-t13-own");
    mkdirSync(path.join(root, activeName), { mode: 0o700 });
    assert.equal(reviewerHomeOwnership(root, activeName).owned, true);

    // Symlink-to-dir: lstat never reports isDirectory() true for the symlink itself.
    const realTargetDir = path.join(root, "not-inside-reviewer-home");
    mkdirSync(realTargetDir, { mode: 0o700 });
    const symlinkName = reviewerHomeDirName(process.pid, "dispatch-t13-symlink");
    symlinkSync(realTargetDir, path.join(root, symlinkName));
    const symlinkResult = reviewerHomeOwnership(root, symlinkName);
    assert.equal(symlinkResult.owned, false);
    assert.equal(symlinkResult.reason, "not_a_real_directory");
  });
});

test("T13: concurrent safety — a live or not-yet-expired responsible pid's home is left alone", () => {
  withReviewerHomeRoot((root) => {
    const { reviewerHomeReclaimDecision, reviewerHomeDirName } = runnerModule.__testReviewerHome;
    const liveName = reviewerHomeDirName(process.pid, "dispatch-t13-live");
    mkdirSync(path.join(root, liveName), { mode: 0o700 });
    const liveDecision = reviewerHomeReclaimDecision({
      name: liveName,
      controlRoot: root,
      oldEnoughMs: 0,
    });
    assert.equal(liveDecision.action, "skip");
    assert.equal(liveDecision.reason, "creator_alive");

    const dead = reviewerHomeDeadPid();
    const freshName = reviewerHomeDirName(dead, "dispatch-t13-fresh");
    mkdirSync(path.join(root, freshName), { mode: 0o700 });
    const freshDecision = reviewerHomeReclaimDecision({
      name: freshName,
      controlRoot: root,
      oldEnoughMs: 60_000,
    });
    assert.equal(freshDecision.action, "skip");
    assert.equal(freshDecision.reason, "not_old_enough");
  });
});

test("T13: symlinks are never followed by ownership determination", () => {
  withReviewerHomeRoot((root) => {
    const { reviewerHomeOwnership, reviewerHomeDirName } = runnerModule.__testReviewerHome;
    const targetDir = path.join(root, "real-target");
    mkdirSync(targetDir, { mode: 0o700 });
    const name = reviewerHomeDirName(process.pid, "dispatch-t13-symlink2");
    symlinkSync(targetDir, path.join(root, name));
    assert.equal(reviewerHomeOwnership(root, name).owned, false);
  });
});

test("T13: a dev/ino mismatch blocks reclaim without deleting, and is the sole blocking reason", () => {
  withReviewerHomeRoot((root) => {
    const { reviewerHomeReclaimDecision, reviewerHomeDirName, REVIEWER_HOME_OWNER_SCHEMA } = runnerModule.__testReviewerHome;
    const dead = reviewerHomeDeadPid();
    const name = reviewerHomeDirName(dead, "dispatch-t13-devino");
    const dir = path.join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    const owner = {
      schema: REVIEWER_HOME_OWNER_SCHEMA,
      owner_pid: dead,
      owner_token: "11111111-1111-1111-1111-111111111111",
      created_at: new Date().toISOString(),
      home_dev: -1,
      home_ino: -1,
    };
    writeFileSync(path.join(dir, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
    backdateMtime(dir, 120_000);

    const decision = reviewerHomeReclaimDecision({ name, controlRoot: root, oldEnoughMs: 1 });
    assert.equal(decision.action, "skip");
    assert.equal(decision.reason, "dev_ino_mismatch");
    assert.equal(existsSync(dir), true, "dev/ino mismatch must not delete");
  });
});

// T14 — teardown fail-closed ladder (design.md T5 negative tests (4)(10)(14); round 7/F-6-1).
test("T14: rmSync is invoked with bounded maxRetries/retryDelay", () => {
  const { teardownReviewerHome, REVIEWER_HOME_TEARDOWN_MAX_RETRIES, REVIEWER_HOME_TEARDOWN_RETRY_DELAY_MS } = runnerModule.__testReviewerHome;
  let observedOptions = null;
  teardownReviewerHome({
    dir: "/fixture/dir",
    root: "/fixture",
    scope: "own",
    deps: {
      rmSync(_dir, options) {
        observedOptions = options;
      },
      fsyncDirectory() {},
    },
  });
  assert.ok(Number.isInteger(observedOptions.maxRetries) && observedOptions.maxRetries > 0);
  assert.ok(Number.isInteger(observedOptions.retryDelay) && observedOptions.retryDelay > 0);
  assert.equal(observedOptions.maxRetries, REVIEWER_HOME_TEARDOWN_MAX_RETRIES);
  assert.equal(observedOptions.retryDelay, REVIEWER_HOME_TEARDOWN_RETRY_DELAY_MS);
});

test("T14: own-dispatch teardown retry exhaustion always fails closed — identically across three fixtures, unconditional on store type, path state, or tree contents", () => {
  withReviewerHomeRoot((root) => {
    const { teardownReviewerHome } = runnerModule.__testReviewerHome;
    const externalTarget = path.join(root, "external-target-file");
    writeFileSync(externalTarget, "not-a-real-credential\n", "utf8");

    // Three REAL, filesystem-distinct fixtures — this is the structural guarantee that
    // "no branch" means "cannot branch", not merely "does not currently branch". A
    // reintroduced classifier reading store type / auth.json's lstat / tree contents
    // (design.md T5 negative test 10, round 7/F-6-1 regression guard) would observe three
    // different states below and could diverge; the single-rule ladder must not.
    //
    // (a) "keyring" store: no continuation file is ever created for this home.
    const keyringDir = path.join(root, "victim-keyring");
    mkdirSync(keyringDir, { mode: 0o700 });
    writeFileSync(path.join(keyringDir, "owner.json"), "{}\n", "utf8");
    writeFileSync(path.join(keyringDir, "config.toml"), "", "utf8");

    // (b) "file-backed" store, continuation present: auth.json is a symlink to a real,
    // existing external credential file.
    const fileBackedPresentDir = path.join(root, "victim-file-backed-present");
    mkdirSync(fileBackedPresentDir, { mode: 0o700 });
    writeFileSync(path.join(fileBackedPresentDir, "owner.json"), "{}\n", "utf8");
    writeFileSync(path.join(fileBackedPresentDir, "config.toml"), "", "utf8");
    symlinkSync(externalTarget, path.join(fileBackedPresentDir, "auth.json"));

    // (c) "file-backed" store, continuation absent at final path: auth.json is a dangling
    // symlink (its lstat succeeds, but the target does not exist) — a different tree/path
    // state than both (a) (no entry at all) and (b) (a resolvable symlink).
    const fileBackedAbsentDir = path.join(root, "victim-file-backed-absent");
    mkdirSync(fileBackedAbsentDir, { mode: 0o700 });
    writeFileSync(path.join(fileBackedAbsentDir, "owner.json"), "{}\n", "utf8");
    writeFileSync(path.join(fileBackedAbsentDir, "config.toml"), "", "utf8");
    symlinkSync(path.join(root, "does-not-exist-target"), path.join(fileBackedAbsentDir, "auth.json"));

    const fixtures = [
      { label: "keyring-classified-no-continuation-file-ever-created", dir: keyringDir },
      { label: "file-backed-symlink-continuation", dir: fileBackedPresentDir },
      { label: "file-backed-but-auth-json-absent-at-final-path", dir: fileBackedAbsentDir },
    ];
    for (const fixture of fixtures) {
      const result = teardownReviewerHome({
        dir: fixture.dir,
        root,
        scope: "own",
        deps: {
          rmSync() {
            throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
          },
        },
      });
      assert.equal(result.outcome, "fail_closed", fixture.label);
      assert.equal(result.reason, "reviewer_home_teardown_retry_exhausted", fixture.label);
      assert.equal(existsSync(fixture.dir), true, `${fixture.label}: a fail-closed outcome must not have deleted anything`);
    }
    assert.equal(existsSync(externalTarget), true, "the file-backed symlink target must survive a fail-closed teardown attempt");
  });
});

test("T14: other-dispatch residue teardown retry exhaustion always skips and never blocks", () => {
  const { teardownReviewerHome } = runnerModule.__testReviewerHome;
  const result = teardownReviewerHome({
    dir: "/fixture/dir",
    root: "/fixture",
    scope: "other",
    deps: {
      rmSync() {
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      },
    },
  });
  assert.equal(result.outcome, "skip");
  assert.equal(result.reason, "reviewer_home_teardown_retry_exhausted_other");
});

test("T14: a successful teardown removes the directory and fsyncs its parent", () => {
  withReviewerHomeRoot((root) => {
    const { teardownReviewerHome } = runnerModule.__testReviewerHome;
    const dir = path.join(root, "victim");
    mkdirSync(dir, { mode: 0o700 });
    let fsyncedRoot = null;
    const result = teardownReviewerHome({
      dir,
      root,
      scope: "own",
      deps: { fsyncDirectory: (target) => { fsyncedRoot = target; } },
    });
    assert.equal(result.outcome, "removed");
    assert.equal(existsSync(dir), false);
    assert.equal(fsyncedRoot, root);
  });
});

test("T14 follow-up: a post-removal fsyncDirectory failure does not escape teardownReviewerHome or downgrade an already-successful removal to fail_closed", () => {
  withReviewerHomeRoot((root) => {
    const { teardownReviewerHome } = runnerModule.__testReviewerHome;
    const dir = path.join(root, "victim-fsync-throws");
    mkdirSync(dir, { mode: 0o700 });
    // The content removal (rmSync) already succeeded by the time fsyncDirectory runs;
    // this call site sits at the top of runProjection's finally block, before neutral
    // cwd cleanup and releaseAttemptOwnership, so an uncaught throw here would leak
    // both. It MUST be caught, not just the sibling rmSync call above it.
    const result = teardownReviewerHome({
      dir,
      root,
      scope: "own",
      deps: {
        fsyncDirectory() {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      },
    });
    assert.equal(result.outcome, "removed");
    assert.equal(existsSync(dir), false);
  });
});

test("T14: teardown never follows a symlink inside the home to its external target", () => {
  withReviewerHomeRoot((root) => {
    const { teardownReviewerHome } = runnerModule.__testReviewerHome;
    const externalTarget = path.join(root, "external-target-file");
    writeFileSync(externalTarget, "not-a-real-credential\n", "utf8");
    const dir = path.join(root, "victim-with-symlink");
    mkdirSync(dir, { mode: 0o700 });
    symlinkSync(externalTarget, path.join(dir, "auth.json"));

    const result = teardownReviewerHome({ dir, root, scope: "own" });
    assert.equal(result.outcome, "removed");
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(externalTarget), true, "the symlink target must survive teardown");
    assert.equal(readFileSync(externalTarget, "utf8"), "not-a-real-credential\n");
  });
});

// T15 — D7 platform-injected spawn env (see also T9(3/5) for the win32 branch).
test("T15: non-win32 spawn env key set and values are byte-for-byte unchanged (full key-set comparison)", () => {
  const { reviewerSpawnEnv } = runnerModule.__testReviewerSpawnEnv;
  const context = reviewerHomeTestFixtureContext();
  const baseEnv = { PATH: "/usr/bin", HOME: "/home/example" };
  const env = reviewerSpawnEnv(context, { platform: "darwin", baseEnv });
  const isolatedTmpdir = path.join(context.neutral_cwd_path, "reviewer-tmp");
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/example",
    GH_REPO: context.repository_slug,
    DEVPRO_REVIEW_PR_NUMBER: context.pr_number,
    DEVPRO_CROSS_MODEL_REVIEWER: "1",
    TMPDIR: isolatedTmpdir,
  });
});

test("T15: win32 spawn env overwrites (not merely adds) pre-existing TEMP/TMP to the isolated tmpdir (full key-set comparison)", () => {
  const { reviewerSpawnEnv } = runnerModule.__testReviewerSpawnEnv;
  const context = reviewerHomeTestFixtureContext();
  const baseEnv = { PATH: "C:\\\\Windows", TEMP: "C:\\\\Old\\\\Temp", TMP: "C:\\\\Old\\\\Tmp" };
  const env = reviewerSpawnEnv(context, { platform: "win32", baseEnv });
  const isolatedTmpdir = path.join(context.neutral_cwd_path, "reviewer-tmp");
  // Exact key-set comparison (not per-key assert.equal): a future key added by habit to
  // the win32 branch — and never removed from the assembled env — must turn this test
  // red, mirroring the existing darwin T15 above (spec.md: "each branch MUST be
  // asserted with an exact key-set comparison of the resulting environment").
  assert.deepEqual(env, {
    PATH: "C:\\\\Windows",
    TEMP: isolatedTmpdir,
    TMP: isolatedTmpdir,
    TMPDIR: isolatedTmpdir,
    GH_REPO: context.repository_slug,
    DEVPRO_REVIEW_PR_NUMBER: context.pr_number,
    DEVPRO_CROSS_MODEL_REVIEWER: "1",
  });
});

test("T15 follow-up: CODEX_HOME is never injected for a non-codex (Claude) recipe, even when reviewer_codex_home_path is set", () => {
  const { reviewerSpawnEnv } = runnerModule.__testReviewerSpawnEnv;
  const context = reviewerHomeTestFixtureContext({
    reviewer_cli_recipe: { tool: "claude" },
    reviewer_codex_home_path: "/some/isolated/codex-home",
  });
  const env = reviewerSpawnEnv(context, { platform: "darwin", baseEnv: { PATH: "/usr/bin" } });
  assert.equal("CODEX_HOME" in env, false, "the tool === \"codex\" conjunct must gate CODEX_HOME even when reviewer_codex_home_path is truthy");
});

// T16 — capacityLockOwnerIsAlive export promotion, reused (not reimplemented) by scavenging.
test("T16: run-second-reviewer-projection.mjs does not carry a second process.kill liveness implementation", () => {
  const source = readFileSync(runnerScript, "utf8");
  assert.equal((source.match(/process\.kill\(/g) ?? []).length, 0);
});

test("T16: reviewerHomeReclaimDecision's default liveness check is capacityLockOwnerIsAlive (EPERM/unknown treated as live, only ESRCH is dead)", () => {
  withReviewerHomeRoot((root) => {
    const { reviewerHomeReclaimDecision, reviewerHomeDirName } = runnerModule.__testReviewerHome;
    // process.pid is genuinely alive: this exercises the real (non-injected) default
    // isAlive path, which is capacityLockOwnerIsAlive imported from
    // second-review-control-evidence.mjs (T16), not a second implementation.
    const name = reviewerHomeDirName(process.pid, "dispatch-t16-live-default");
    mkdirSync(path.join(root, name), { mode: 0o700 });
    const decision = reviewerHomeReclaimDecision({ name, controlRoot: root, oldEnoughMs: 0 });
    assert.equal(decision.action, "skip");
    assert.equal(decision.reason, "creator_alive");
  });
});

// T17 — reclaim criteria + reclaim procedure (design.md T5 negative tests
// (1)(5)(6)(7)(11)(12)(13)).
test("T17(1): a simulated host-crash residue (dead pid, valid owner, oldEnough) is fully removed by scavengeReviewerHomes", () => {
  withReviewerHomeRoot((root) => {
    const { scavengeReviewerHomes, reviewerHomeDirName, REVIEWER_HOME_OWNER_SCHEMA } = runnerModule.__testReviewerHome;
    const dead = reviewerHomeDeadPid();
    const name = reviewerHomeDirName(dead, "dispatch-t17-crash");
    const dir = path.join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    const stat = lstatSync(dir);
    const owner = {
      schema: REVIEWER_HOME_OWNER_SCHEMA,
      owner_pid: dead,
      owner_token: "22222222-2222-2222-2222-222222222222",
      created_at: backdatedIso(120_000),
      home_dev: stat.dev,
      home_ino: stat.ino,
    };
    writeFileSync(path.join(dir, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
    writeFileSync(path.join(dir, "config.toml"), "", "utf8");
    // A test-fixture placeholder standing in for the copy-fallback continuity file this
    // block does not itself create (T20, out of scope).
    writeFileSync(path.join(dir, "auth.json"), "fixture-auth-bytes\n", "utf8");

    const result = withSmallReclaimThreshold(() => scavengeReviewerHomes({
      controlRoot: root,
      context: reviewerHomeTestFixtureContext(),
      deps: { readdirSync },
    }));
    assert.equal(result.reclaimed, 1);
    assert.equal(existsSync(dir), false);
  });
});

test("T17(2): a not-yet-expired responsible pid's home is left alone (parallel-safety reverse control)", () => {
  withReviewerHomeRoot((root) => {
    const { scavengeReviewerHomes, reviewerHomeDirName, REVIEWER_HOME_OWNER_SCHEMA } = runnerModule.__testReviewerHome;
    const dead = reviewerHomeDeadPid();
    const name = reviewerHomeDirName(dead, "dispatch-t17-fresh");
    const dir = path.join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    const stat = lstatSync(dir);
    writeFileSync(path.join(dir, "owner.json"), `${JSON.stringify({
      schema: REVIEWER_HOME_OWNER_SCHEMA,
      owner_pid: dead,
      owner_token: "33333333-3333-3333-3333-333333333333",
      created_at: new Date().toISOString(),
      home_dev: stat.dev,
      home_ino: stat.ino,
    })}\n`, "utf8");
    // Not backdated: this home is fresh, well within the (default 30-minute-plus-grace)
    // oldEnough window.
    const result = scavengeReviewerHomes({
      controlRoot: root,
      context: reviewerHomeTestFixtureContext(),
      deps: { readdirSync },
    });
    assert.equal(result.reclaimed, 0);
    assert.equal(existsSync(dir), true);
  });
});

test("T17(4): a Codex self-created tmp/arg0/** subtree does not affect reclaim determination", () => {
  withReviewerHomeRoot((root) => {
    const { scavengeReviewerHomes, reviewerHomeDirName, REVIEWER_HOME_OWNER_SCHEMA } = runnerModule.__testReviewerHome;
    const dead = reviewerHomeDeadPid();
    const name = reviewerHomeDirName(dead, "dispatch-t17-arg0");
    const dir = path.join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    const stat = lstatSync(dir);
    writeFileSync(path.join(dir, "owner.json"), `${JSON.stringify({
      schema: REVIEWER_HOME_OWNER_SCHEMA,
      owner_pid: dead,
      owner_token: "44444444-4444-4444-4444-444444444444",
      created_at: backdatedIso(120_000),
      home_dev: stat.dev,
      home_ino: stat.ino,
    })}\n`, "utf8");
    const arg0Dir = path.join(dir, "tmp", "arg0", "codex-arg0-fixture");
    mkdirSync(arg0Dir, { recursive: true });
    writeFileSync(path.join(arg0Dir, ".lock"), "", "utf8");
    writeFileSync(path.join(arg0Dir, "codex-execve-wrapper"), "", "utf8");

    const result = withSmallReclaimThreshold(() => scavengeReviewerHomes({
      controlRoot: root,
      context: reviewerHomeTestFixtureContext(),
      deps: { readdirSync },
    }));
    assert.equal(result.reclaimed, 1);
    assert.equal(existsSync(dir), false);
  });
});

test("T17(5): a residue with no auth.json (keyring / never-built continuation file) is reclaimable like any other", () => {
  withReviewerHomeRoot((root) => {
    const { scavengeReviewerHomes, reviewerHomeDirName, REVIEWER_HOME_OWNER_SCHEMA } = runnerModule.__testReviewerHome;
    const dead = reviewerHomeDeadPid();
    const name = reviewerHomeDirName(dead, "dispatch-t17-noauth");
    const dir = path.join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    const stat = lstatSync(dir);
    writeFileSync(path.join(dir, "owner.json"), `${JSON.stringify({
      schema: REVIEWER_HOME_OWNER_SCHEMA,
      owner_pid: dead,
      owner_token: "55555555-5555-5555-5555-555555555555",
      created_at: backdatedIso(120_000),
      home_dev: stat.dev,
      home_ino: stat.ino,
    })}\n`, "utf8");
    writeFileSync(path.join(dir, "config.toml"), "", "utf8");

    const result = withSmallReclaimThreshold(() => scavengeReviewerHomes({
      controlRoot: root,
      context: reviewerHomeTestFixtureContext(),
      deps: { readdirSync },
    }));
    assert.equal(result.reclaimed, 1);
  });
});

test("T17(6): missing/truncated/non-canonical owner.json + oldEnough + dead name-pid are all reclaimable", () => {
  withReviewerHomeRoot((root) => {
    const { scavengeReviewerHomes, reviewerHomeDirName, REVIEWER_HOME_OWNER_SCHEMA } = runnerModule.__testReviewerHome;
    const fixtures = [
      { label: "missing", write: () => {} },
      { label: "truncated", write: (dir) => writeFileSync(path.join(dir, "owner.json"), "{\"schema\":", "utf8") },
      {
        label: "non-canonical",
        write: (dir) => writeFileSync(
          path.join(dir, "owner.json"),
          `${JSON.stringify({
            // Same fields, but pretty-printed (not the canonical single-line bytes).
            schema: REVIEWER_HOME_OWNER_SCHEMA,
            owner_pid: 1,
            owner_token: "66666666-6666-6666-6666-666666666666",
            created_at: new Date().toISOString(),
            home_dev: 0,
            home_ino: 0,
          }, null, 2)}\n`,
          "utf8",
        ),
      },
    ];
    for (const fixture of fixtures) {
      const dead = reviewerHomeDeadPid();
      const name = reviewerHomeDirName(dead, `dispatch-t17-owner-${fixture.label}`);
      const dir = path.join(root, name);
      mkdirSync(dir, { mode: 0o700 });
      fixture.write(dir);
      backdateMtime(dir, 120_000);

      withSmallReclaimThreshold(() => scavengeReviewerHomes({
        controlRoot: root,
        context: reviewerHomeTestFixtureContext(),
        deps: { readdirSync },
      }));
      assert.equal(existsSync(dir), false, fixture.label);
    }
  });
});

test("T17(7): missing owner.json + not yet expired is left alone", () => {
  withReviewerHomeRoot((root) => {
    const { scavengeReviewerHomes, reviewerHomeDirName } = runnerModule.__testReviewerHome;
    const dead = reviewerHomeDeadPid();
    const name = reviewerHomeDirName(dead, "dispatch-t17-freshnoowner");
    const dir = path.join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    const result = scavengeReviewerHomes({
      controlRoot: root,
      context: reviewerHomeTestFixtureContext(),
      deps: { readdirSync },
    });
    assert.equal(result.reclaimed, 0);
    assert.equal(existsSync(dir), true);
  });
});

test("T17(11/12, F-3-2 load-bearing pair): owner not yet published + expired + creator alive is never reclaimed; the dead-pid mirror is", () => {
  withReviewerHomeRoot((root) => {
    const { scavengeReviewerHomes, reviewerHomeReclaimDecision, reviewerHomeDirName } = runnerModule.__testReviewerHome;

    // 11: name pid is this test process's own pid (necessarily alive) — no owner.json,
    // directory mtime backdated far past the threshold.
    const liveName = reviewerHomeDirName(process.pid, "dispatch-t17-11-live-unpublished");
    const liveDir = path.join(root, liveName);
    mkdirSync(liveDir, { mode: 0o700 });
    backdateMtime(liveDir, 120_000);
    const liveDecision = reviewerHomeReclaimDecision({ name: liveName, controlRoot: root, oldEnoughMs: 1 });
    assert.equal(liveDecision.action, "skip");
    assert.equal(liveDecision.reason, "creator_alive", "must be distinguishable from other skip reasons");

    const liveScan = scavengeReviewerHomes({
      controlRoot: root,
      context: reviewerHomeTestFixtureContext(),
      deps: { readdirSync },
    });
    assert.equal(existsSync(liveDir), true);
    assert.equal(liveScan.results.find((r) => r.name === liveName)?.reason, "creator_alive");

    // 12: the exact same fixture shape, but the name-embedded pid is a definitely-dead
    // one obtained by spawning a trivial child and reading its pid after exit — not a
    // guessed large constant (design.md T5 negative test 12 explicitly forbids that).
    const dead = reviewerHomeDeadPid();
    const deadName = reviewerHomeDirName(dead, "dispatch-t17-12-dead-unpublished");
    const deadDir = path.join(root, deadName);
    mkdirSync(deadDir, { mode: 0o700 });
    backdateMtime(deadDir, 120_000);
    const deadDecision = reviewerHomeReclaimDecision({ name: deadName, controlRoot: root, oldEnoughMs: 1 });
    assert.equal(deadDecision.action, "reclaim");
  });
});

test("T17(13): the P-ID invariant's build-face guardrail — a real created isolated home resolves to the runner pid, and owner_pid matches", () => {
  withReviewerHomeRoot((root) => {
    const { createReviewerIsolatedHome, classifyReviewerHomeEntryName } = runnerModule.__testReviewerHome;
    const { dir, owner } = createReviewerIsolatedHome({ controlRoot: root, pid: process.pid, dispatchId: "dispatch-t17-13" });
    const classification = classifyReviewerHomeEntryName(path.basename(dir));
    assert.equal(classification.kind, "active");
    assert.equal(classification.pid, process.pid);
    assert.equal(owner.owner_pid, process.pid);
  });
});

test("T17(quarantine/3a): a quarantine-form residue whose reclaimer pid is alive is skipped, never raced", () => {
  withReviewerHomeRoot((root) => {
    const { scavengeReviewerHomes } = runnerModule.__testReviewerHome;
    // Judgment 3: the responsible pid for a quarantine-form candidate is the reclaimer
    // that rename-to-quarantined it (encoded in the name), not the original creator. A
    // live reclaimer means another pass is already tearing this candidate down.
    const name = `.reviewer-home.recovery.${process.pid}.11111111-1111-1111-1111-111111111111`;
    const dir = path.join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    backdateMtime(dir, 120_000);

    const result = withSmallReclaimThreshold(() => scavengeReviewerHomes({
      controlRoot: root,
      context: reviewerHomeTestFixtureContext(),
      deps: { readdirSync },
    }));
    assert.equal(result.reclaimed, 0);
    assert.equal(existsSync(dir), true, "a live reclaimer's in-flight quarantine must not be raced");
  });
});

test("T17(quarantine/3b): a quarantine-form residue whose reclaimer pid is dead and oldEnough proceeds straight to teardown", () => {
  withReviewerHomeRoot((root) => {
    const { scavengeReviewerHomes } = runnerModule.__testReviewerHome;
    const dead = reviewerHomeDeadPid();
    const name = `.reviewer-home.recovery.${dead}.22222222-2222-2222-2222-222222222222`;
    const dir = path.join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    backdateMtime(dir, 120_000);

    const result = withSmallReclaimThreshold(() => scavengeReviewerHomes({
      controlRoot: root,
      context: reviewerHomeTestFixtureContext(),
      deps: { readdirSync },
    }));
    assert.equal(result.reclaimed, 1);
    assert.equal(existsSync(dir), false, "an already-quarantined, dead-reclaimer, oldEnough candidate must be removed");
  });
});

test("T17: oldEnough is derived from totalTimeoutMs(context), not a second hardcoded constant", () => {
  withReviewerHomeRoot((root) => {
    const { reviewerHomeOldEnoughMs } = runnerModule.__testReviewerHome;
    const previous = process.env.DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS;
    try {
      process.env.DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS = "1000";
      const small = reviewerHomeOldEnoughMs(reviewerHomeTestFixtureContext());
      process.env.DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS = "1000000";
      const large = reviewerHomeOldEnoughMs(reviewerHomeTestFixtureContext());
      assert.ok(large > small, "the effective threshold must move with the env-derived total timeout");
      assert.equal(large - small, 1000000 - 1000);
    } finally {
      if (previous === undefined) delete process.env.DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS;
      else process.env.DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS = previous;
    }
  });
});

test("T17: scavengeReviewerHomes fails closed when the candidate count exceeds the repository dispatch bound", () => {
  const { scavengeReviewerHomes } = runnerModule.__testReviewerHome;
  const overCapacityEntries = Array.from({ length: 600 }, (_, index) => ({
    name: `.reviewer-home.${index + 1}.dispatch-capacity`,
    isDirectory: () => false,
  }));
  assert.throws(() => scavengeReviewerHomes({
    controlRoot: "/fixture",
    context: reviewerHomeTestFixtureContext(),
    deps: { readdirSync: () => overCapacityEntries },
  }), /reviewer home scavenging scan exceeds the repository dispatch bound/);
});

// Round-2 six-axis review fix (Critical C-1): reclaimReviewerHomeCandidate does real
// filesystem I/O (renameSync/fsyncDirectory/lstatSync) that a concurrent dispatch racing
// the same control-evidence root (ENOENT) or an open Windows handle (EPERM/EACCES) can
// make throw. Per spec "Another dispatch's residue is skipped and never blocks", the ONLY
// fail-closed condition in this path is the candidate-count bound (covered above) — a
// single candidate's I/O failure MUST be skip-and-continue, not abort the whole scan.
test("T17 follow-up: a per-candidate reclaim I/O failure (concurrent-race/open-handle simulation) is skipped, and the scan still reclaims the remaining candidates", () => {
  withReviewerHomeRoot((root) => {
    const { scavengeReviewerHomes, reviewerHomeDirName, REVIEWER_HOME_OWNER_SCHEMA } = runnerModule.__testReviewerHome;

    function seedDeadResidue(label, ownerToken) {
      const dead = reviewerHomeDeadPid();
      const name = reviewerHomeDirName(dead, `dispatch-t17-race-${label}`);
      const dir = path.join(root, name);
      mkdirSync(dir, { mode: 0o700 });
      const stat = lstatSync(dir);
      writeFileSync(path.join(dir, "owner.json"), `${JSON.stringify({
        schema: REVIEWER_HOME_OWNER_SCHEMA,
        owner_pid: dead,
        owner_token: ownerToken,
        created_at: backdatedIso(120_000),
        home_dev: stat.dev,
        home_ino: stat.ino,
      })}\n`, "utf8");
      writeFileSync(path.join(dir, "config.toml"), "", "utf8");
      return { name, dir };
    }

    const racing = seedDeadResidue("racing", "66666666-6666-6666-6666-666666666666");
    const clean = seedDeadResidue("clean", "77777777-7777-7777-7777-777777777777");

    const result = withSmallReclaimThreshold(() => scavengeReviewerHomes({
      controlRoot: root,
      context: reviewerHomeTestFixtureContext(),
      deps: {
        readdirSync,
        renameSync(oldPath, newPath) {
          if (oldPath === racing.dir) {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }
          return renameSync(oldPath, newPath);
        },
      },
    }));

    assert.equal(result.scanned, 2);
    assert.equal(result.reclaimed, 1, "the racing candidate's I/O failure must not block the other candidate's reclaim");
    const byName = new Map(result.results.map((entry) => [entry.name, entry]));
    assert.equal(byName.get(racing.name).outcome, "skip");
    assert.equal(byName.get(racing.name).reason, "reviewer_home_reclaim_io_error");
    assert.equal(byName.get(clean.name).outcome, "removed");
    assert.equal(existsSync(racing.dir), true, "the racing candidate's directory is left untouched, not deleted");
    assert.equal(existsSync(clean.dir), false);
  });
});

// ---------------------------------------------------------------------------
// T19-T22 (Part B5/B8, R6) — the D3 steps 1/2/3/5 credential continuity gate: detection +
// store-resolution parity (T19), symlink-first/copy-fallback continuity (T20), the named
// verification step `isolated_home_credential_verification` (T21), and step 5 degrade
// (T22). See design.md D3 and fr-b7-evidence.md (tasks.md T18) for the real-environment
// findings this composition relies on. T13/T14/T17 already cover ownership-based
// out-of-process reclaim and generic symlink-safe teardown (design.md D3 step 4) — those
// are reused here, not re-derived.
// ---------------------------------------------------------------------------

// T19 — D3 step 1: credential-store detection + store-resolution parity.
test("T19: detectReviewerHomeCredentialStore classifies auth.json presence and (synthetic-only) store tokens into all four design.md tokens", () => {
  withReviewerHomeRoot((root) => {
    const { detectReviewerHomeCredentialStore } = runnerModule.__testReviewerHomeGate;
    const withAuth = path.join(root, "default-with-auth");
    mkdirSync(withAuth, { mode: 0o700 });
    writeFileSync(path.join(withAuth, "auth.json"), "{}\n", "utf8");
    const withoutAuth = path.join(root, "default-without-auth");
    mkdirSync(withoutAuth, { mode: 0o700 });

    // Real fixtures — the only two branches reachable on this host (fr-b7-evidence.md §2:
    // no credential_store config key exists to read on the tested CLI version).
    assert.equal(
      detectReviewerHomeCredentialStore({ defaultCodexHome: withAuth }).token,
      "file_backed_present"
    );
    assert.equal(
      detectReviewerHomeCredentialStore({ defaultCodexHome: withoutAuth }).token,
      "auth_material_absent"
    );

    // Synthetic-only branches — `storeToken` has no production source (see the
    // function's own comment); exercised here purely to prove the classifier's logic
    // covers all four design.md tokens, per this task's explicit instruction.
    assert.equal(
      detectReviewerHomeCredentialStore({ defaultCodexHome: withAuth, storeToken: "auto" }).token,
      "store_unknown_with_material",
      "synthetic: material present but the store value is ambiguous"
    );
    assert.equal(
      detectReviewerHomeCredentialStore({ defaultCodexHome: withoutAuth, storeToken: "keyring" }).token,
      "not_file_backed",
      "synthetic: no auth.json and an explicit keyring token"
    );
  });
});

test("T19: reviewerHomeConfigTomlBytes / writeReviewerHomeConfigToml build allowlist-only content — the allowlist is empty by construction, so any entry (including mcp_servers) is rejected", () => {
  const { reviewerHomeConfigTomlBytes, writeReviewerHomeConfigToml } = runnerModule.__testReviewerHomeGate;
  assert.deepEqual(reviewerHomeConfigTomlBytes([]), Buffer.from("", "utf8"));
  for (const rejected of [["mcp_servers", {}], ["some_future_key", "x"]]) {
    assert.throws(() => reviewerHomeConfigTomlBytes([rejected]), /reviewer isolated home config\.toml/);
  }
  withReviewerHomeRoot((root) => {
    writeReviewerHomeConfigToml(root, []);
    assert.equal(readFileSync(path.join(root, "config.toml"), "utf8"), "");
  });
});

test("T19: the isolated-home config.toml writer never reads or copies the default home's config.toml — the mechanism store-resolution parity relies on, not itself a proof of parity for every credential store", () => {
  withReviewerHomeRoot((root) => {
    const { writeReviewerHomeConfigToml } = runnerModule.__testReviewerHomeGate;
    // This proves the no-leak mechanism (writer never reads the default home's
    // config.toml, so an injected key here cannot leak through even in principle) that
    // finding 2's zero-projection parity argument depends on. It does NOT itself prove
    // parity holds for a keyring-backed default home — that generalization is inferred
    // from finding 1 (no config.toml key selects the store), not independently confirmed
    // against a real keyring-backed host (fr-b7-evidence.md §驗證覆蓋率的誠實揭露).
    const defaultHome = path.join(root, "default-home");
    mkdirSync(defaultHome, { mode: 0o700 });
    writeFileSync(
      path.join(defaultHome, "config.toml"),
      'evil_allowlist_external_key = "x"\ncredential_store = "keyring"\n',
      "utf8"
    );

    const isolatedHome = path.join(root, "isolated-home");
    mkdirSync(isolatedHome, { mode: 0o700 });
    writeReviewerHomeConfigToml(isolatedHome, []);
    const isolatedContent = readFileSync(path.join(isolatedHome, "config.toml"), "utf8");
    assert.equal(isolatedContent.includes("evil_allowlist_external_key"), false);
    assert.equal(isolatedContent.includes("credential_store"), false);
    assert.equal(isolatedContent.includes("keyring"), false);
  });
});

test("T19: defaultReviewerCodexHome resolves a CODEX_HOME env override before falling back to homedir()/.codex", () => {
  const { defaultReviewerCodexHome } = runnerModule.__testReviewerHomeGate;
  assert.equal(
    defaultReviewerCodexHome({ CODEX_HOME: "/fixture/explicit-codex-home" }),
    path.resolve("/fixture/explicit-codex-home")
  );
  assert.equal(
    defaultReviewerCodexHome({}, { homedir: () => "/fixture/home" }),
    path.join("/fixture/home", ".codex")
  );
});

// T20 — D3 step 2: symlink-first, copy fallback.
test("T20: createReviewerHomeCredentialContinuity uses a symlink when available, and teardown removes it without following it to the default home's real auth.json", () => {
  withReviewerHomeRoot((root) => {
    const { createReviewerHomeCredentialContinuity } = runnerModule.__testReviewerHomeGate;
    const { teardownReviewerHome } = runnerModule.__testReviewerHome;
    const defaultHome = path.join(root, "default-home");
    mkdirSync(defaultHome, { mode: 0o700 });
    const defaultAuthJsonPath = path.join(defaultHome, "auth.json");
    writeFileSync(defaultAuthJsonPath, "not-a-real-credential\n", "utf8");

    const isolatedHome = path.join(root, "isolated-home");
    mkdirSync(isolatedHome, { mode: 0o700 });
    const outcome = createReviewerHomeCredentialContinuity({ dir: isolatedHome, defaultAuthJsonPath });
    assert.equal(outcome.method, "symlink");
    assert.equal(lstatSync(path.join(isolatedHome, "auth.json")).isSymbolicLink(), true);

    const teardown = teardownReviewerHome({ dir: isolatedHome, root, scope: "own" });
    assert.equal(teardown.outcome, "removed");
    assert.equal(existsSync(defaultAuthJsonPath), true, "the symlink target must survive teardown");
    assert.equal(readFileSync(defaultAuthJsonPath, "utf8"), "not-a-real-credential\n");
  });
});

test("T20: createReviewerHomeCredentialContinuity falls back to copy when symlinkSync throws, requesting mode 0o600", () => {
  withReviewerHomeRoot((root) => {
    const { createReviewerHomeCredentialContinuity } = runnerModule.__testReviewerHomeGate;
    const defaultHome = path.join(root, "default-home");
    mkdirSync(defaultHome, { mode: 0o700 });
    const defaultAuthJsonPath = path.join(defaultHome, "auth.json");
    writeFileSync(defaultAuthJsonPath, "not-a-real-credential\n", "utf8");
    const isolatedHome = path.join(root, "isolated-home");
    mkdirSync(isolatedHome, { mode: 0o700 });

    const outcome = createReviewerHomeCredentialContinuity({
      dir: isolatedHome,
      defaultAuthJsonPath,
      fsSeam: {
        symlinkSync() {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      },
    });
    assert.equal(outcome.method, "copy");
    const copiedPath = path.join(isolatedHome, "auth.json");
    assert.equal(lstatSync(copiedPath).isSymbolicLink(), false);
    assert.equal(lstatSync(copiedPath).mode & 0o777, expectedNodeModeBits(0o600));
  });
});

test("T20: copy fallback content is byte-identical to the source auth.json", () => {
  withReviewerHomeRoot((root) => {
    const { createReviewerHomeCredentialContinuity } = runnerModule.__testReviewerHomeGate;
    const defaultHome = path.join(root, "default-home");
    mkdirSync(defaultHome, { mode: 0o700 });
    const defaultAuthJsonPath = path.join(defaultHome, "auth.json");
    const original = Buffer.from("not-a-real-credential-bytes\n", "utf8");
    writeFileSync(defaultAuthJsonPath, original);
    const isolatedHome = path.join(root, "isolated-home");
    mkdirSync(isolatedHome, { mode: 0o700 });

    createReviewerHomeCredentialContinuity({
      dir: isolatedHome,
      defaultAuthJsonPath,
      fsSeam: { symlinkSync() { throw new Error("no symlink"); } },
    });
    assert.deepEqual(readFileSync(path.join(isolatedHome, "auth.json")), original);
  });
});

test("T20: a copy-fallback failure is swallowed — no continuity file, no throw, and no default-home path leaks through the return value", () => {
  withReviewerHomeRoot((root) => {
    const { createReviewerHomeCredentialContinuity } = runnerModule.__testReviewerHomeGate;
    const isolatedHome = path.join(root, "isolated-home");
    mkdirSync(isolatedHome, { mode: 0o700 });
    const sensitivePath = path.join(root, "default-home", "auth.json");

    let outcome;
    assert.doesNotThrow(() => {
      outcome = createReviewerHomeCredentialContinuity({
        dir: isolatedHome,
        defaultAuthJsonPath: sensitivePath,
        fsSeam: {
          symlinkSync() { throw Object.assign(new Error(`EPERM: ${sensitivePath}`), { code: "EPERM" }); },
          readFileSync() { throw Object.assign(new Error(`ENOENT: ${sensitivePath}`), { code: "ENOENT" }); },
        },
      });
    });
    assert.equal(outcome.method, "none");
    assert.equal(existsSync(path.join(isolatedHome, "auth.json")), false);
    assert.equal(JSON.stringify(outcome).includes(sensitivePath), false);
  });
});

function reviewerHomeGateFixtureContext(overrides = {}) {
  return {
    ...reviewerHomeTestFixtureContext(),
    dispatch_id: "dispatch-t19-t22",
    reviewer_cli_recipe: {
      tool: "codex",
      auth_preflight: {
        command: { executable: process.execPath, argv: ["-e", "process.exit(0)"] },
        success_condition: "exit_zero",
        timeout_ms: 15000,
        max_output_bytes: 65536,
        raw_output_policy: "memory-only-do-not-persist",
      },
    },
    ...overrides,
  };
}

// T21 — D3 step 3: the named step `isolated_home_credential_verification`.
test("T21: isolatedHomeCredentialVerificationResult verifies on exit 0, with a classification distinct from reviewer_host_surface_unverified, and the only env difference from the caller's baseEnv is CODEX_HOME", () => {
  const { isolatedHomeCredentialVerificationResult } = runnerModule.__testReviewerHomeGate;
  const context = reviewerHomeGateFixtureContext();
  let observedEnv = null;
  const result = isolatedHomeCredentialVerificationResult({
    context,
    isolatedHomePath: "/fixture/isolated-home",
    deps: {
      baseEnv: { PATH: "/usr/bin" },
      runCommand(_carrier, options) {
        observedEnv = options.env;
        return { status: 0, error: null, error_code: null, stdout: "Logged in\n", stderr: "" };
      },
    },
  });
  assert.equal(result.verified, true);
  assert.equal(result.classification, "isolated_home_credential_verified");
  assert.notEqual(result.classification, "reviewer_host_surface_unverified");
  assert.equal(observedEnv.CODEX_HOME, "/fixture/isolated-home");
  assert.equal(observedEnv.PATH, "/usr/bin");
});

test("T21: a non-zero exit does not verify, and is not classified as reviewer_host_surface_unverified", () => {
  const { isolatedHomeCredentialVerificationResult } = runnerModule.__testReviewerHomeGate;
  const result = isolatedHomeCredentialVerificationResult({
    context: reviewerHomeGateFixtureContext(),
    isolatedHomePath: "/fixture/isolated-home",
    deps: { runCommand: () => ({ status: 1, error: null, error_code: null, stdout: "", stderr: "Not logged in\n" }) },
  });
  assert.equal(result.verified, false);
  assert.equal(result.classification, "isolated_home_credential_verification_failed");
  assert.notEqual(result.classification, "reviewer_host_surface_unverified");
});

test("T21: a timeout does not verify", () => {
  const { isolatedHomeCredentialVerificationResult } = runnerModule.__testReviewerHomeGate;
  const result = isolatedHomeCredentialVerificationResult({
    context: reviewerHomeGateFixtureContext(),
    isolatedHomePath: "/fixture/isolated-home",
    deps: { runCommand: () => ({ status: null, error: "timeout", error_code: "ETIMEDOUT", stdout: "", stderr: "" }) },
  });
  assert.equal(result.verified, false);
  assert.equal(result.timed_out, true);
});

test("T21: bounds are reused from the recipe's own auth_preflight (timeout_ms/max_output_bytes), not a second hardcoded value", () => {
  const { isolatedHomeCredentialVerificationResult } = runnerModule.__testReviewerHomeGate;
  const context = reviewerHomeGateFixtureContext();
  context.reviewer_cli_recipe.auth_preflight.timeout_ms = 4242;
  context.reviewer_cli_recipe.auth_preflight.max_output_bytes = 4096;
  let observed = null;
  isolatedHomeCredentialVerificationResult({
    context,
    isolatedHomePath: "/fixture/isolated-home",
    deps: {
      runCommand(_carrier, options) {
        observed = options;
        return { status: 0, error: null, error_code: null, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(observed.timeoutMs, 4242);
  assert.equal(observed.maxBufferBytes, 4096);
});

test("T21: output past the recipe's max_output_bytes does not verify", () => {
  const { isolatedHomeCredentialVerificationResult } = runnerModule.__testReviewerHomeGate;
  const context = reviewerHomeGateFixtureContext();
  context.reviewer_cli_recipe.auth_preflight.max_output_bytes = 8;
  const result = isolatedHomeCredentialVerificationResult({
    context,
    isolatedHomePath: "/fixture/isolated-home",
    deps: {
      runCommand: () => ({
        status: 0,
        error: null,
        error_code: null,
        stdout: "way too many bytes for the bound\n",
        stderr: "",
      }),
    },
  });
  assert.equal(result.verified, false);
  assert.equal(result.output_overflowed, true);
});

test("T21: isolated-home credential verification reads probe/recipe modules and does not write those files", () => {
  const runnerSrc = readFileSync(
    path.join(REPO_ROOT, ".devpro/scripts/run-second-reviewer-projection.mjs"),
    "utf8"
  );
  assert.match(
    runnerSrc,
    /from "\.\/probe-second-reviewer-cli-recipe\.mjs"/,
    "runner reads probe via import"
  );
  assert.match(
    runnerSrc,
    /from "\.\/second-reviewer-cli-recipe-contract\.mjs"/,
    "runner reads recipe contract via import"
  );
  assert.doesNotMatch(
    runnerSrc,
    /writeFileSync\([^)]*(?:probe-second-reviewer-cli-recipe|second-reviewer-cli-recipe-contract)/,
    "runner must not write probe or recipe-contract files; git-diff-vs-main freeze was change-scoped and blocked later schema binds"
  );
});

test("T20: the gate does not create any continuity file when the default home has no auth.json (keyring / never-built continuation file — the normal case for 裁示2's keyring coverage)", () => {
  withReviewerHomeRoot((root) => {
    const { applyReviewerHomeCredentialContinuityGate } = runnerModule.__testReviewerHomeGate;
    const defaultHome = path.join(root, "default-home-no-auth");
    mkdirSync(defaultHome, { mode: 0o700 });
    const context = reviewerHomeGateFixtureContext();
    const gate = applyReviewerHomeCredentialContinuityGate(context, {
      deps: {
        controlRoot: root,
        defaultCodexHome: defaultHome,
        runCommand: () => ({ status: 0, error: null, error_code: null, stdout: "ok\n", stderr: "" }),
      },
    });
    assert.equal(gate.applied, true);
    assert.equal(gate.detection.token, "auth_material_absent");
    assert.equal(existsSync(path.join(gate.isolatedHomePath, "auth.json")), false);
    assert.deepEqual(readdirSync(gate.isolatedHomePath).sort(), ["config.toml", "owner.json"]);
  });
});

test("T20: the gate builds a symlink continuity file when the default home has a regular-file auth.json, and the isolated home is left on disk (lifecycle bound to the caller's dispatch, not torn down by the gate itself on success)", () => {
  withReviewerHomeRoot((root) => {
    const { applyReviewerHomeCredentialContinuityGate } = runnerModule.__testReviewerHomeGate;
    const defaultHome = path.join(root, "default-home-with-auth");
    mkdirSync(defaultHome, { mode: 0o700 });
    writeFileSync(path.join(defaultHome, "auth.json"), "not-a-real-credential\n", "utf8");
    const context = reviewerHomeGateFixtureContext();

    const gate = applyReviewerHomeCredentialContinuityGate(context, {
      deps: {
        controlRoot: root,
        defaultCodexHome: defaultHome,
        runCommand: () => ({ status: 0, error: null, error_code: null, stdout: "ok\n", stderr: "" }),
      },
    });
    assert.equal(gate.applied, true);
    assert.equal(gate.detection.token, "file_backed_present");
    assert.equal(lstatSync(path.join(gate.isolatedHomePath, "auth.json")).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(gate.isolatedHomePath).sort(), ["auth.json", "config.toml", "owner.json"]);
  });
});

// T22 — D3 step 5: degrade.
test("T22: a verification that does not pass tears down the isolated home immediately, including a Codex-self-created tmp/arg0/** subtree written during the failed verification run", () => {
  withReviewerHomeRoot((root) => {
    const { applyReviewerHomeCredentialContinuityGate } = runnerModule.__testReviewerHomeGate;
    const defaultHome = path.join(root, "default-home");
    mkdirSync(defaultHome, { mode: 0o700 });
    writeFileSync(path.join(defaultHome, "auth.json"), "not-a-real-credential\n", "utf8");
    const context = reviewerHomeGateFixtureContext({ activity_log_path: path.join(root, "activity.log") });

    let isolatedHomeSeenDuringRun = null;
    const gate = applyReviewerHomeCredentialContinuityGate(context, {
      deps: {
        controlRoot: root,
        defaultCodexHome: defaultHome,
        runCommand(_carrier, options) {
          isolatedHomeSeenDuringRun = options.env.CODEX_HOME;
          // F-2-1 guard mirror (design.md, T14/T17 precedent): simulate Codex writing
          // real, non-empty self-created content before the login check fails, so "the
          // directory is gone afterward" is not a vacuous pass on an empty skeleton.
          const arg0Dir = path.join(isolatedHomeSeenDuringRun, "tmp", "arg0", "codex-arg0-fixture");
          mkdirSync(arg0Dir, { recursive: true });
          writeFileSync(path.join(arg0Dir, ".lock"), "", "utf8");
          writeFileSync(path.join(arg0Dir, "codex-execve-wrapper"), "", "utf8");
          return { status: 1, error: null, error_code: null, stdout: "", stderr: "Not logged in\n" };
        },
      },
    });

    assert.equal(gate.applied, false);
    assert.ok(isolatedHomeSeenDuringRun);
    assert.equal(
      existsSync(isolatedHomeSeenDuringRun),
      false,
      "the isolated home — including its planted tmp/arg0/** subtree — must not exist after degrade"
    );
  });
});

test("T22: degrade does not inject CODEX_HOME — the spawn env key set is exactly the unclamped set", () => {
  const { reviewerSpawnEnv } = runnerModule.__testReviewerSpawnEnv;
  const context = reviewerHomeTestFixtureContext();
  // No context.reviewer_codex_home_path — mirrors a degraded dispatch exactly: the gate
  // never populates this field when step 3 verification does not pass.
  const env = reviewerSpawnEnv(context, { platform: "darwin", baseEnv: { PATH: "/usr/bin" } });
  assert.deepEqual(
    Object.keys(env).sort(),
    ["DEVPRO_CROSS_MODEL_REVIEWER", "DEVPRO_REVIEW_PR_NUMBER", "GH_REPO", "PATH", "TMPDIR"]
  );
  assert.equal("CODEX_HOME" in env, false);
});

test("T22: degrade records exactly one non-terminal codex_home_clamp_not_applied diagnostic carrying a stable reason token and the step-1 store token", () => {
  withReviewerHomeRoot((root) => {
    const { applyReviewerHomeCredentialContinuityGate } = runnerModule.__testReviewerHomeGate;
    const defaultHome = path.join(root, "default-home");
    mkdirSync(defaultHome, { mode: 0o700 });
    writeFileSync(path.join(defaultHome, "auth.json"), "not-a-real-credential\n", "utf8");
    const activityLogPath = path.join(root, "activity.log");
    const context = reviewerHomeGateFixtureContext({ activity_log_path: activityLogPath });

    applyReviewerHomeCredentialContinuityGate(context, {
      deps: {
        controlRoot: root,
        defaultCodexHome: defaultHome,
        runCommand: () => ({ status: 1, error: null, error_code: null, stdout: "", stderr: "Not logged in\n" }),
      },
    });

    const records = readFileSync(activityLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const diagnostics = records.filter((record) => record.event === "codex_home_clamp_not_applied");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].reason_token, "isolated_home_credential_verification_failed");
    assert.equal(diagnostics[0].store_token, "file_backed_present");
  });
});

// Round-1 six-axis review fix (Critical 1): scavengeReviewerHomes had no production call
// site — it was reachable only through the __testReviewerHome seam. This is the wiring
// test that proves the gate itself, not a direct scavengeReviewerHomes() call, actually
// reclaims a dead-pid residue and records the scan outcome before creating its own home
// (spec "Residue scavenging runs before this dispatch creates its own isolated home" /
// "Scavenging observability is bounded and free of paths").
test("T22 follow-up: applyReviewerHomeCredentialContinuityGate scavenges dead-pid residue before creating its own isolated home, and records a scan activity entry", () => {
  withReviewerHomeRoot((root) => {
    const {
      applyReviewerHomeCredentialContinuityGate,
    } = runnerModule.__testReviewerHomeGate;
    const { reviewerHomeDirName, REVIEWER_HOME_OWNER_SCHEMA } = runnerModule.__testReviewerHome;
    const dead = reviewerHomeDeadPid();
    const residueName = reviewerHomeDirName(dead, "dispatch-t22-residue");
    const residueDir = path.join(root, residueName);
    mkdirSync(residueDir, { mode: 0o700 });
    const residueStat = lstatSync(residueDir);
    const owner = {
      schema: REVIEWER_HOME_OWNER_SCHEMA,
      owner_pid: dead,
      owner_token: "33333333-3333-3333-3333-333333333333",
      created_at: backdatedIso(120_000),
      home_dev: residueStat.dev,
      home_ino: residueStat.ino,
    };
    writeFileSync(path.join(residueDir, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
    writeFileSync(path.join(residueDir, "config.toml"), "", "utf8");

    const defaultHome = path.join(root, "default-home-no-auth");
    mkdirSync(defaultHome, { mode: 0o700 });
    const activityLogPath = path.join(root, "activity.log");
    const context = reviewerHomeGateFixtureContext({ activity_log_path: activityLogPath });

    const gate = withSmallReclaimThreshold(() => applyReviewerHomeCredentialContinuityGate(context, {
      deps: {
        controlRoot: root,
        defaultCodexHome: defaultHome,
        runCommand: () => ({ status: 0, error: null, error_code: null, stdout: "ok\n", stderr: "" }),
      },
    }));

    assert.equal(gate.applied, true, "the gate's own home must still be created normally alongside scavenging");
    assert.equal(existsSync(residueDir), false, "the dead-pid residue must be reclaimed before the gate's own home is created");
    assert.equal(existsSync(gate.isolatedHomePath), true);

    const records = readFileSync(activityLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const scavengeEvents = records.filter((record) => record.event === "reviewer_home_scavenge_completed");
    assert.equal(scavengeEvents.length, 1);
    assert.equal(scavengeEvents[0].scanned, 1);
    assert.equal(scavengeEvents[0].reclaimed, 1);
    assert.deepEqual(scavengeEvents[0].skip_reasons, []);
    assert.ok(
      JSON.stringify(scavengeEvents[0]).includes(residueDir) === false,
      "scavenging observability MUST be free of paths"
    );
  });
});

// Round-1 six-axis review fix (Important): a home-setup exception (config.toml write,
// store detection, or the isolated_home_credential_verification probe itself throwing)
// used to leak the already-created isolated home, because the caller only learned `dir`
// from createReviewerIsolatedHome's return value — which an exception prevents. The gate
// now computes `dir` deterministically up front and tears its own home down on any setup
// exception before rethrowing.
test("T22 follow-up: a home-setup exception tears down the already-created isolated home before rethrowing, instead of leaking it", () => {
  withReviewerHomeRoot((root) => {
    const { applyReviewerHomeCredentialContinuityGate } = runnerModule.__testReviewerHomeGate;
    const defaultHome = path.join(root, "default-home-with-auth");
    mkdirSync(defaultHome, { mode: 0o700 });
    writeFileSync(path.join(defaultHome, "auth.json"), "not-a-real-credential\n", "utf8");
    const context = reviewerHomeGateFixtureContext();

    assert.throws(
      () => applyReviewerHomeCredentialContinuityGate(context, {
        deps: {
          controlRoot: root,
          defaultCodexHome: defaultHome,
          runCommand() {
            throw new Error("isolated_home_credential_verification probe blew up");
          },
        },
      }),
      /isolated_home_credential_verification probe blew up/
    );

    const { reviewerHomeDirName } = runnerModule.__testReviewerHome;
    const leftoverName = reviewerHomeDirName(process.pid, context.dispatch_id);
    assert.equal(
      existsSync(path.join(root, leftoverName)),
      false,
      "the isolated home created before the exception must not be left on disk"
    );
  });
});

test("T22: codex_home_clamp_not_applied is emitted by the runner but never registered as a terminal-receipt classification", () => {
  const runnerSource = readFileSync(runnerScript, "utf8");
  const evidenceSource = readFileSync(repoPath(".devpro/scripts/hooks/lib/second-review-control-evidence.mjs"), "utf8");
  assert.ok(runnerSource.includes("codex_home_clamp_not_applied"), "the runner must actually emit this diagnostic");
  assert.equal(evidenceSource.includes("codex_home_clamp_not_applied"), false);
  assert.equal(TERMINAL_RECEIPT_CLASSIFICATIONS.has("codex_home_clamp_not_applied"), false);
  for (const group of Object.values(TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS)) {
    assert.equal(group.includes("codex_home_clamp_not_applied"), false);
  }
});

test("T22: a residual symlink continuity file created before a failed verification is removed by degrade teardown without following it to the default home's real auth.json", () => {
  withReviewerHomeRoot((root) => {
    const { applyReviewerHomeCredentialContinuityGate } = runnerModule.__testReviewerHomeGate;
    const defaultHome = path.join(root, "default-home");
    mkdirSync(defaultHome, { mode: 0o700 });
    const defaultAuthJsonPath = path.join(defaultHome, "auth.json");
    writeFileSync(defaultAuthJsonPath, "not-a-real-credential\n", "utf8");
    const context = reviewerHomeGateFixtureContext();

    const gate = applyReviewerHomeCredentialContinuityGate(context, {
      deps: {
        controlRoot: root,
        defaultCodexHome: defaultHome,
        runCommand: () => ({ status: 1, error: null, error_code: null, stdout: "", stderr: "Not logged in\n" }),
      },
    });
    assert.equal(gate.applied, false);
    assert.equal(existsSync(defaultAuthJsonPath), true);
    assert.equal(readFileSync(defaultAuthJsonPath, "utf8"), "not-a-real-credential\n");
  });
});

test("T22: a teardown retry-exhaustion during degrade is not silent — it surfaces as a thrown, classified error rather than a swallowed failure", () => {
  withReviewerHomeRoot((root) => {
    const { applyReviewerHomeCredentialContinuityGate } = runnerModule.__testReviewerHomeGate;
    const defaultHome = path.join(root, "default-home");
    mkdirSync(defaultHome, { mode: 0o700 });
    const context = reviewerHomeGateFixtureContext();

    assert.throws(
      () => applyReviewerHomeCredentialContinuityGate(context, {
        deps: {
          controlRoot: root,
          defaultCodexHome: defaultHome,
          runCommand: () => ({ status: 1, error: null, error_code: null, stdout: "", stderr: "" }),
          teardownDeps: {
            rmSync() {
              throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
            },
          },
        },
      }),
      (error) => {
        assert.equal(error.classification, "reviewer_home_teardown_retry_exhausted");
        return true;
      }
    );
  });
});

// T19-T22 wiring — full in-process dispatch through runGeneratedRunnerCommand, proving the
// gate is actually reached from runProjection (not merely composable in isolation) at the
// documented window (after materializeNeutralCwd(), before claimDispatchInvocation()).
// design.md D3 step 2 point 6 / T20 acceptance (7 負向契約 #3): 三條路徑（reviewer spawn 失敗、
// hard-cap timeout 強制終止、runner 例外退出）各一個負向測試，證明繼續性檔案／隔離 home 的生命週期
// 綁定 runProjection 的單一 finally block（T13/T17/T14's teardownReviewerHome 呼叫點），而非額外的
// 第二套清理路徑。以下兩個測試涵蓋前兩條路徑（spawn 失敗、hard-cap SIGTERM）；第三條路徑（runner
// 內部例外退出）沒有一個不去碰生產碼就能便宜可靠觸發的既有 fixture 掛鉤——finally block 本身沒有
// 分支邏輯（unconditional `if (reviewerHomeCreated) { teardownReviewerHome(...) }`），所以前兩條路徑
// 已經對「finally 一定跑到」給出經驗證據；第三條路徑留白於 tasks.md T20 checklist 上明列，交給 TL 判斷
// 是否要專門補一個以人工丟出例外為代價的測試，而不是靜默略過。
test("T20: a reviewer spawn failure (ENOENT after the isolated home's own step-3 verification pass) still tears down the isolated home via the same unconditional finally-block teardown, and the default home's real auth.json survives untouched", () => {
  withTempDir("second-review-runner-codex-home-clamp-spawn-fail-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    const defaultCodexHome = path.join(dir, "default-codex-home");
    mkdirSync(defaultCodexHome, { recursive: true });
    const authJsonPath = path.join(defaultCodexHome, "auth.json");
    writeFileSync(authJsonPath, '{"not":"a real credential"}\n', "utf8");

    const { context } = renderHandoff(dir, codexAuditHandoff);
    const controlEvidenceRootForFixture = context.control_evidence_root;
    const result = runGeneratedRunnerCommand(context, binDir, {
      CODEX_HOME: defaultCodexHome,
      // The isolated-home re-run of `login status` (T21) passes and self-deletes the only
      // `codex` on PATH — so the later real `codex exec` spawn ENOENTs, exactly as if the
      // binary vanished between discovery and invocation (mirrors writeDisappearingClaude).
      DEVPRO_FAKE_CODEX_SELF_DELETE_UNDER: controlEvidenceRootForFixture,
    });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_cli_spawn_failed");
    assert.equal(output.cli_exit.process_spawned, false);

    const isolatedHomePath = path.join(
      controlEvidenceRootForFixture,
      `.reviewer-home.${result.pid}.${context.dispatch_id}`
    );
    assert.equal(
      existsSync(isolatedHomePath),
      false,
      "the isolated home must be torn down even though the reviewer child never spawned"
    );

    const events = activityEvents(context.activity_log_path);
    assert.equal(events.includes("projection_reviewer_home_cleaned"), true);
    assert.equal(events.includes("reviewer_home_teardown_retry_exhausted"), false);
    assert.equal(events.includes("codex_home_clamp_not_applied"), false, "step 3 verification passed; this is not a degrade");

    assert.equal(existsSync(authJsonPath), true);
    assert.equal(readFileSync(authJsonPath, "utf8"), '{"not":"a real credential"}\n');
  });
});

test("T20: a reviewer hard-cap timeout (forced SIGTERM/SIGKILL termination) after the isolated home was created still tears it down via the same unconditional finally-block teardown, and the default home's real auth.json survives untouched", () => {
  withTempDir("second-review-runner-codex-home-clamp-hard-cap-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    const defaultCodexHome = path.join(dir, "default-codex-home");
    mkdirSync(defaultCodexHome, { recursive: true });
    const authJsonPath = path.join(defaultCodexHome, "auth.json");
    writeFileSync(authJsonPath, '{"not":"a real credential"}\n', "utf8");

    const { context } = renderHandoff(dir, codexAuditHandoff);
    const result = runGeneratedRunnerCommand(context, binDir, {
      CODEX_HOME: defaultCodexHome,
      DEVPRO_FAKE_REVIEWER_DELAY_MS: "5000",
      DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "1000",
    }, { timeout: 12000 });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_cli_timeout");
    assert.equal(output.cli_exit.process_spawned, true);

    const isolatedHomePath = path.join(
      context.control_evidence_root,
      `.reviewer-home.${result.pid}.${context.dispatch_id}`
    );
    assert.equal(existsSync(isolatedHomePath), false, "the isolated home must be torn down after a hard-cap timeout");

    const events = activityEvents(context.activity_log_path);
    assert.equal(events.includes("projection_reviewer_home_cleaned"), true);
    assert.equal(events.includes("reviewer_home_teardown_retry_exhausted"), false);

    assert.equal(existsSync(authJsonPath), true);
    assert.equal(readFileSync(authJsonPath, "utf8"), '{"not":"a real credential"}\n');
  });
});

test("T19-T22 wiring: a full Codex dispatch clamps CODEX_HOME to a verified isolated home, then tears it down at dispatch end — the default home's real auth.json survives untouched", () => {
  withTempDir("second-review-runner-codex-home-clamp-success-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    const isolatedOsHome = path.join(dir, "os-home");
    mkdirSync(isolatedOsHome, { recursive: true });
    const defaultCodexHome = path.join(dir, "default-codex-home");
    mkdirSync(defaultCodexHome, { recursive: true });
    const authJsonPath = path.join(defaultCodexHome, "auth.json");
    writeFileSync(authJsonPath, '{"not":"a real credential"}\n', "utf8");
    assertFixtureCodexHome(dir, defaultCodexHome);

    const { context } = renderHandoff(dir, codexAuditHandoff);
    const result = runGeneratedRunnerCommand(context, binDir, {
      HOME: isolatedOsHome,
      CODEX_HOME: defaultCodexHome,
    });
    assert.equal(result.status, 0, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "finished");
    assert.equal(stdout.classification, "reviewer_cli_completed");

    const reviewerStdout = readFileSync(context.stdout_log_path, "utf8");
    const invocationEvent = parseNdjsonObjects(reviewerStdout).find(
      (event) => event.tool === "codex"
    );
    assert.ok(invocationEvent.codex_home, "the reviewer must have observed a CODEX_HOME value");
    assert.notEqual(
      invocationEvent.codex_home,
      defaultCodexHome,
      "CODEX_HOME must be clamped to the isolated home, not the inherited default home"
    );
    assert.notEqual(
      path.resolve(invocationEvent.codex_home),
      path.join(homedir(), ".codex"),
      "clamped CODEX_HOME must never resolve to the real host ~/.codex",
    );

    const isolatedHomePath = path.join(
      context.control_evidence_root,
      `.reviewer-home.${result.pid}.${context.dispatch_id}`
    );
    assert.equal(invocationEvent.codex_home, isolatedHomePath);
    assert.equal(existsSync(isolatedHomePath), false, "the isolated home must be torn down by dispatch end");

    const events = activityEvents(context.activity_log_path);
    assert.equal(events.includes("projection_reviewer_home_cleaned"), true);
    assert.equal(events.includes("codex_home_clamp_not_applied"), false);
    assert.equal(events.includes("reviewer_home_teardown_retry_exhausted"), false);

    // Symlink safety (design.md T5 negative test 3): the default home's real auth.json
    // must survive untouched — proves teardown removed the symlink, not its target.
    assert.equal(existsSync(authJsonPath), true);
    assert.equal(readFileSync(authJsonPath, "utf8"), '{"not":"a real credential"}\n');
  });
});

test("T19-T22 wiring: an isolated home that fails step 3 verification degrades — no CODEX_HOME injected, home torn down, non-terminal diagnostic recorded, dispatch still completes exactly as today", () => {
  withTempDir("second-review-runner-codex-home-clamp-degrade-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    const isolatedOsHome = path.join(dir, "os-home");
    mkdirSync(isolatedOsHome, { recursive: true });
    const defaultCodexHome = path.join(dir, "default-codex-home");
    mkdirSync(defaultCodexHome, { recursive: true });
    writeFileSync(path.join(defaultCodexHome, "auth.json"), '{"not":"a real credential"}\n', "utf8");
    assertFixtureCodexHome(dir, defaultCodexHome);

    const { context } = renderHandoff(dir, codexAuditHandoff);
    const controlEvidenceRootForFixture = context.control_evidence_root;
    const result = runGeneratedRunnerCommand(context, binDir, {
      HOME: isolatedOsHome,
      CODEX_HOME: defaultCodexHome,
      // Fails only the isolated-home re-run of `login status` (its CODEX_HOME is always
      // a direct child of the control-evidence root) — the canonical auth_preflight (run
      // earlier, with the inherited CODEX_HOME=defaultCodexHome above) still passes.
      DEVPRO_FAKE_AUTH_PREFLIGHT_FAIL_UNDER: controlEvidenceRootForFixture,
    });
    assert.equal(result.status, 0, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "finished");
    assert.equal(stdout.classification, "reviewer_cli_completed");

    const reviewerStdout = readFileSync(context.stdout_log_path, "utf8");
    const invocationEvent = parseNdjsonObjects(reviewerStdout).find(
      (event) => event.tool === "codex"
    );
    assert.equal(
      invocationEvent.codex_home,
      defaultCodexHome,
      "an unclamped dispatch must run with the inherited (default) CODEX_HOME, exactly like today's behavior"
    );
    assert.notEqual(
      path.resolve(invocationEvent.codex_home),
      path.join(homedir(), ".codex"),
      "degraded unclamped CODEX_HOME must still be the fixture home, not real ~/.codex",
    );

    const isolatedHomePath = path.join(
      controlEvidenceRootForFixture,
      `.reviewer-home.${result.pid}.${context.dispatch_id}`
    );
    assert.equal(
      existsSync(isolatedHomePath),
      false,
      "the isolated home must be torn down after degrade, not left behind"
    );

    const records = readFileSync(context.activity_log_path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const degrade = records.find((record) => record.event === "codex_home_clamp_not_applied");
    assert.ok(degrade, "a non-terminal codex_home_clamp_not_applied diagnostic must be recorded");
    assert.equal(degrade.reason_token, "isolated_home_credential_verification_failed");
    assert.equal(degrade.store_token, "file_backed_present");
    assert.equal(records.some((record) => record.event === "reviewer_home_teardown_retry_exhausted"), false);

    assert.equal(existsSync(path.join(defaultCodexHome, "auth.json")), true);
  });
});

test("generated-runner env scrub drops ambient CODEX_HOME and DEVPRO_FAKE_* unless the case opts in", () => {
  withTempDir("second-review-runner-env-scrub-", (dir) => {
    const context = {
      control_evidence_root: path.join(dir, "control-evidence"),
    };
    const ambient = {
      PATH: "/usr/bin",
      CODEX_HOME: path.join(homedir(), ".codex"),
      DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1",
      KEEP_ME: "1",
    };
    const scrubbed = buildGeneratedRunnerEnv(context, path.join(dir, "bin"), {}, dir, ambient);
    assert.equal("CODEX_HOME" in scrubbed, false);
    assert.equal("DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL" in scrubbed, false);
    assert.equal(scrubbed.KEEP_ME, "1");

    const optedIn = buildGeneratedRunnerEnv(
      context,
      path.join(dir, "bin"),
      {
        CODEX_HOME: path.join(dir, "fixture-codex-home"),
        DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL: "1",
      },
      dir,
      ambient,
    );
    assert.equal(optedIn.CODEX_HOME, path.join(dir, "fixture-codex-home"));
    assert.equal(optedIn.DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL, "1");
    assertFixtureCodexHome(dir, optedIn.CODEX_HOME);
  });
});

// design.md D3 gate invariant + RD12 (TL ruling, provenance: user, 2026-08-18): the
// normal-path (post-completion) isolated-home teardown MUST use the SAME fail-closed-and-
// report discipline as the in-gate degrade throw, unconditionally — even when the reviewer
// already produced a valid completion. This is an in-process test (not a
// runGeneratedRunnerCommand subprocess test like its siblings above) because forcing a
// real rmSync failure requires the fs-seam `deps` injection point
// (reviewerHomeTeardownDeps), which only `runProjection()` called directly exposes — the
// CLI entrypoint (main()) has no argv/env surface for it, by design (no test-only branch
// in production control flow; see the option's own doc comment in
// run-second-reviewer-projection.mjs).
test("T22: a teardown retry-exhaustion AFTER the reviewer already produced a valid completion overrides the dispatch's own reported outcome to blocked with reviewer_home_teardown_retry_exhausted (RD12; not silently log-only)", async () => {
  await withTempDirAsync("second-review-runner-codex-home-teardown-fail-closed-", async (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    const defaultCodexHome = path.join(dir, "default-codex-home");
    mkdirSync(defaultCodexHome, { recursive: true });
    writeFileSync(path.join(defaultCodexHome, "auth.json"), '{"not":"a real credential"}\n', "utf8");
    assertFixtureCodexHome(dir, defaultCodexHome);

    const { context, contextPath } = renderHandoff(dir, codexAuditHandoff);
    const result = await runProjection(contextPath, {
      env: buildGeneratedRunnerEnv(context, binDir, {
        CODEX_HOME: defaultCodexHome,
      }, dir),
      executableDiscoveryOptions: { pathValue: binDir },
      reviewerHomeTeardownDeps: {
        rmSync() {
          throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        },
      },
    });

    // The reviewer genuinely completed — this is not a degrade or a spawn failure. Proves
    // the override is not vacuous: without it, this dispatch would otherwise be reported
    // "finished"/"reviewer_cli_completed" exactly like the clean-teardown wiring test above.
    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "reviewer_home_teardown_retry_exhausted");

    // RD12 is satisfied by the activity-log token and this unconditional blocked result —
    // no closed-terminal receipt is attempted for this classification, since doing so
    // would require an outcome group the canonical spec does not authorize (see the
    // production comment on this branch in run-second-reviewer-projection.mjs).
    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal, null);

    const events = activityEvents(context.activity_log_path);
    assert.equal(events.includes("reviewer_home_teardown_retry_exhausted"), true);
    assert.equal(events.includes("codex_home_clamp_not_applied"), false, "the isolated-home verification must reach the fake CLI on PATH");
    assert.equal(events.includes("projection_reviewer_home_cleaned"), false);
    assert.equal(events.includes("projection_terminal_receipt_written"), false);

    assert.equal(existsSync(path.join(defaultCodexHome, "auth.json")), true);
  });
});

// RD12 follow-up: applyReviewerHomeCredentialContinuityGate's own catch block (design.md
// D3 step 4-5) is a SEPARATE fail-closed cascade from the one T22 exercises: "home creation
// can throw after mkdirSync/publishReviewerHomeOwner already succeeded (e.g. the
// afterOwnerPublished callback's config.toml write ... throws)" (see that function's own
// comment above `dir = reviewerIsolatedHomePath(...)`), and when the gate's OWN teardown of
// that partially-created home ALSO fails, it throws
// `ProjectionRunnerError("reviewer isolated home teardown failed after home setup raised an
// error", "reviewer_home_teardown_retry_exhausted")` directly — reaching runProjection's
// outer catch as a genuine internal exception, not via the outer finally block's
// post-completion teardown that T22 covers (reviewerHomeCreated in the OUTER function scope
// is never set true on this path, since the gate call itself never returns normally). No
// existing test exercised this cascade end to end before this one: `createReviewerIsolatedHome`
// really does create a home on disk (mkdirSync + owner.json genuinely succeed) before the
// injected config.toml write fails, and the gate's own teardown of that half-built home is
// then also made to fail, proving the classification correctly reaches the final JSON result
// through a real `runProjection()` invocation rather than only through the gate's unit-level
// `__testReviewerHomeGate` seam.
test("T22 follow-up: a runner-internal exception during isolated-home setup (afterOwnerPublished config.toml write) whose own teardown of the half-built home also fails reaches the final result as reviewer_home_teardown_retry_exhausted", async () => {
  await withTempDirAsync("second-review-runner-home-setup-exception-teardown-fail-closed-", async (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    const defaultCodexHome = path.join(dir, "default-codex-home");
    mkdirSync(defaultCodexHome, { recursive: true });
    writeFileSync(path.join(defaultCodexHome, "auth.json"), '{"not":"a real credential"}\n', "utf8");
    assertFixtureCodexHome(dir, defaultCodexHome);

    const { context, contextPath } = renderHandoff(dir, codexAuditHandoff);

    const result = await runProjection(contextPath, {
      env: buildGeneratedRunnerEnv(context, binDir, {
        CODEX_HOME: defaultCodexHome,
      }, dir),
      executableDiscoveryOptions: { pathValue: binDir },
      reviewerHomeGateOptions: {
        deps: {
          fsSeam: {
            writeFileSync() {
              throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
            },
          },
          teardownDeps: {
            rmSync() {
              throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
            },
          },
        },
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "reviewer_home_teardown_retry_exhausted");

    // Not the outer post-completion teardown path (T22): the gate's own teardown call
    // fires, but the outer finally's reviewerHomeCreated-gated teardown never runs, since
    // the gate call never returned to set it true.
    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal, null);
    const events = activityEvents(context.activity_log_path);
    assert.equal(events.includes("reviewer_home_teardown_retry_exhausted"), true);
    assert.equal(events.includes("projection_reviewer_home_cleaned"), false);
    assert.equal(events.includes("projection_terminal_receipt_written"), false);
  });
});

// D6 (R4; tasks.md T23-T24) — write-capability preflight. design.md D6 "落點": a
// write/read-back/delete round trip against <neutralCwd>/reviewer-tmp MUST run after
// materializeNeutralCwd() and before claimDispatchInvocation() takes single-spawn
// authority; a failure MUST fail closed pre-spawn with classification
// reviewer_write_surface_unverified, landing in the spawn_or_probe_failure outcome group
// (second-review-control-evidence.mjs). Today (before T24) options.writeCapabilityProbeDeps
// does not exist as a seam anywhere in the runner, so an injected write failure here is
// silently ignored and the dispatch completes normally — this test's own assertions are
// the red signal, not a thrown TypeError.
test("T23: a write-capability preflight round trip must exist between materializeNeutralCwd() and claimDispatchInvocation() — a write failure fails closed pre-spawn with reviewer_write_surface_unverified in spawn_or_probe_failure", async () => {
  await withTempDirAsync("second-review-runner-write-probe-pipeline-fail-", async (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    const { context, contextPath } = renderHandoff(dir, codexAuditHandoff);

    const rawErrorSentinel = "SENTINEL_RAW_WRITE_PROBE_FS_ERROR_TEXT";
    const result = await runProjection(contextPath, {
      executableDiscoveryOptions: { pathValue: binDir },
      writeCapabilityProbeDeps: {
        writeFileSync() {
          throw Object.assign(new Error(rawErrorSentinel), { code: "EACCES" });
        },
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "reviewer_write_surface_unverified");
    assert.equal(terminalReceiptOutcomeGroup(result.classification), "spawn_or_probe_failure");

    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal?.record.classification, "reviewer_write_surface_unverified");
    assert.equal(terminal?.record.outcome_group, "spawn_or_probe_failure");
    assert.equal(terminal?.record.process_spawned, false);
    assert.equal(terminal?.record.lifecycle_phase, "pre_spawn_known_terminal");
    assert.equal(terminal?.record.process_close_observed, false);
    assert.equal(terminal?.record.transport_cleanup_confirmed, true);
    assert.equal(terminal?.record.invocation_claim_sha256, null);

    const events = activityEvents(context.activity_log_path);
    assert.equal(events.includes("projection_neutral_cwd_materialized"), true);
    assert.equal(events.includes("reviewer_write_surface_unverified"), true);
    assert.equal(events.includes("reviewer_write_surface_verified"), false);
    assert.equal(events.includes("projection_dispatch_invocation_claimed"), false);
    assert.equal(events.includes("codex_home_clamp_not_applied"), false);
    assert.equal(events.includes("projection_cli_starting"), false);
    assert.equal(events.includes("projection_cli_started"), false);

    assert.equal(
      existsSync(path.join(context.control_evidence_root, context.dispatch_id, "invocation-claim.json")),
      false
    );
    assert.equal(
      existsSync(context.neutral_cwd_path),
      false,
      "neutral cwd must still be cleaned up on this pre-spawn failure path"
    );

    const persisted = [
      JSON.stringify(result),
      readFileSync(context.activity_log_path, "utf8"),
      readFileSync(terminal.path, "utf8"),
      readFileSync(context.heartbeat_path, "utf8"),
    ].join("\n");
    assert.equal(
      persisted.includes(rawErrorSentinel),
      false,
      "raw fs error text must never reach any persisted output"
    );
  });
});

function withNeutralCwdReviewerTmp(prefix, fn) {
  return withTempDir(prefix, (dir) => {
    const neutralCwdPath = path.join(dir, "neutral-cwd");
    mkdirSync(path.join(neutralCwdPath, "reviewer-tmp"), { recursive: true, mode: 0o700 });
    return fn(neutralCwdPath);
  });
}

test("T24: verifyReviewerWriteSurface performs a real write/read-back/delete round trip against <neutralCwd>/reviewer-tmp and leaves no probe file behind", () => {
  withNeutralCwdReviewerTmp("second-review-runner-write-probe-success-", (neutralCwdPath) => {
    const { verifyReviewerWriteSurface } = runnerModule.__testWriteCapabilityProbe;
    const outcome = verifyReviewerWriteSurface({
      neutralCwdPath,
      dispatchId: "dispatch-write-probe-success",
    });
    assert.equal(outcome.verified, true);
    assert.equal(outcome.classification, "reviewer_write_surface_verified");
    const entries = readdirSync(path.join(neutralCwdPath, "reviewer-tmp"));
    assert.deepEqual(entries, [], "the probe must not leave any file behind on success");
  });
});

test("T24: verifyReviewerWriteSurface fails closed, classification reviewer_write_surface_unverified, when the write itself throws", () => {
  withNeutralCwdReviewerTmp("second-review-runner-write-probe-write-fail-", (neutralCwdPath) => {
    const { verifyReviewerWriteSurface } = runnerModule.__testWriteCapabilityProbe;
    const outcome = verifyReviewerWriteSurface({
      neutralCwdPath,
      dispatchId: "dispatch-write-probe-write-fail",
      fsSeam: {
        writeFileSync() {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      },
    });
    assert.equal(outcome.verified, false);
    assert.equal(outcome.classification, "reviewer_write_surface_unverified");
  });
});

test("T24: verifyReviewerWriteSurface fails closed on a byte-exact content mismatch, and still attempts to clean up the probe file", () => {
  withNeutralCwdReviewerTmp("second-review-runner-write-probe-mismatch-", (neutralCwdPath) => {
    const { verifyReviewerWriteSurface } = runnerModule.__testWriteCapabilityProbe;
    let unlinkCalled = false;
    const outcome = verifyReviewerWriteSurface({
      neutralCwdPath,
      dispatchId: "dispatch-write-probe-mismatch",
      fsSeam: {
        readFileSync() {
          return Buffer.from("not-the-token-that-was-written", "utf8");
        },
        unlinkSync(...args) {
          unlinkCalled = true;
          return unlinkSync(...args);
        },
      },
    });
    assert.equal(outcome.verified, false);
    assert.equal(outcome.classification, "reviewer_write_surface_unverified");
    assert.equal(unlinkCalled, true, "cleanup must still be attempted after a content mismatch");
  });
});

test("T24: verifyReviewerWriteSurface fails closed when unlink fails even though the content round trip matched", () => {
  withNeutralCwdReviewerTmp("second-review-runner-write-probe-unlink-fail-", (neutralCwdPath) => {
    const { verifyReviewerWriteSurface } = runnerModule.__testWriteCapabilityProbe;
    const outcome = verifyReviewerWriteSurface({
      neutralCwdPath,
      dispatchId: "dispatch-write-probe-unlink-fail",
      fsSeam: {
        unlinkSync() {
          throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        },
      },
    });
    assert.equal(outcome.verified, false);
    assert.equal(outcome.classification, "reviewer_write_surface_unverified");
    // Manual cleanup: the injected unlink blocked the probe's own cleanup, so a residual
    // probe file exists on disk — leaving it there is the exact side effect design.md D6
    // requires unlink failure to fail closed over.
    const reviewerTmp = path.join(neutralCwdPath, "reviewer-tmp");
    const entries = readdirSync(reviewerTmp);
    assert.equal(entries.length, 1, "the probe file remains on disk because the injected unlink failed");
    rmSync(path.join(reviewerTmp, entries[0]));
  });
});

test("T24: the probe file name is bound to dispatch_id and lives directly under <neutralCwd>/reviewer-tmp", () => {
  withNeutralCwdReviewerTmp("second-review-runner-write-probe-naming-", (neutralCwdPath) => {
    const { verifyReviewerWriteSurface } = runnerModule.__testWriteCapabilityProbe;
    const dispatchId = "dispatch-write-probe-naming-check";
    let observedPath;
    verifyReviewerWriteSurface({
      neutralCwdPath,
      dispatchId,
      fsSeam: {
        writeFileSync(filePath, ...rest) {
          observedPath = filePath;
          return writeFileSync(filePath, ...rest);
        },
      },
    });
    assert.equal(path.dirname(observedPath), path.join(neutralCwdPath, "reviewer-tmp"));
    assert.equal(path.basename(observedPath).includes(dispatchId), true);
  });
});

test("T24: a successful write-capability preflight records a positive result event before the dispatch invocation is claimed, and the dispatch completes normally", () => {
  withTempDir("second-review-runner-write-probe-pipeline-success-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    const defaultCodexHome = path.join(dir, "default-codex-home");
    mkdirSync(defaultCodexHome, { recursive: true });
    const { context } = renderHandoff(dir, codexAuditHandoff);
    const result = runGeneratedRunnerCommand(context, binDir, { CODEX_HOME: defaultCodexHome });
    assert.equal(result.status, 0, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "finished");

    const records = readFileSync(context.activity_log_path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const events = records.map((record) => record.event);
    assert.equal(events.includes("reviewer_write_surface_verified"), true);
    assert.equal(events.includes("reviewer_write_surface_unverified"), false);
    const verifiedIndex = events.indexOf("reviewer_write_surface_verified");
    const claimedIndex = events.indexOf("projection_dispatch_invocation_claimed");
    assert.ok(
      verifiedIndex >= 0 && claimedIndex >= 0 && verifiedIndex < claimedIndex,
      "the positive result event must be recorded before the dispatch invocation is claimed"
    );
    assert.equal(records[verifiedIndex].dispatch_id, context.dispatch_id);
  });
});

// D4/D5 (R5; tasks.md T25-T26) — reached via `runnerModule.__testEnvironmentClaimCorroboration`
// (not a static destructured import) so that, before T26 lands, this file's red signal is
// this test's own assertion, not a module-load TypeError breaking every other test in the
// file (mirrors the T23 prove-it convention documented at `:9799` above).
test("T25: pr-sticky + UNAVAILABLE + zero write-class events + complete stream + preflight-proven-writable Codex dispatch produces reviewer_environment_claim_uncorroborated", () => {
  const classify = runnerModule.__testEnvironmentClaimCorroboration
    ?.classifyReviewerEnvironmentClaimCorroboration;
  assert.equal(
    typeof classify,
    "function",
    "the D4 environment-claim-corroboration classifier must exist"
  );
  const result = classify({
    mode: "pr-sticky",
    tool: "codex",
    verdict: "UNAVAILABLE",
    stdoutTruncated: false,
    stdoutStructuredEvents: [
      { type: "item.started", item: { id: "item-1", type: "agent_message" } },
      { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "{}" } },
    ],
    preflightProvedWritable: true,
  });
  assert.equal(result, "reviewer_environment_claim_uncorroborated");
});

test("T26: the write-class item-type allowlist is seeded only from FR-B7's observed vocabulary, nothing guessed", () => {
  assert.deepEqual(
    runnerModule.__testEnvironmentClaimCorroboration.recognizedCodexItemTypes,
    ["agent_message", "command_execution"]
  );
  assert.deepEqual(
    runnerModule.__testEnvironmentClaimCorroboration.writeClassCodexItemTypes,
    ["command_execution"]
  );
});

test("T26: a reviewer tool other than codex fails closed to unknown — write-class vocabulary is unproven for it", () => {
  const classify = runnerModule.__testEnvironmentClaimCorroboration
    .classifyReviewerEnvironmentClaimCorroboration;
  const result = classify({
    mode: "pr-sticky",
    tool: "claude",
    verdict: "UNAVAILABLE",
    stdoutTruncated: false,
    stdoutStructuredEvents: [],
    preflightProvedWritable: true,
  });
  assert.equal(result, "unknown");
});

test("T26: a truncated stdout tail fails closed to unknown, never a bare absence", () => {
  const classify = runnerModule.__testEnvironmentClaimCorroboration
    .classifyReviewerEnvironmentClaimCorroboration;
  const result = classify({
    mode: "pr-sticky",
    tool: "codex",
    verdict: "UNAVAILABLE",
    stdoutTruncated: true,
    stdoutStructuredEvents: [
      { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "{}" } },
    ],
    preflightProvedWritable: true,
  });
  assert.equal(result, "unknown");
});

test("T26: an item type outside the recognized vocabulary fails closed to unknown, not a free pass", () => {
  const classify = runnerModule.__testEnvironmentClaimCorroboration
    .classifyReviewerEnvironmentClaimCorroboration;
  const result = classify({
    mode: "pr-sticky",
    tool: "codex",
    verdict: "UNAVAILABLE",
    stdoutTruncated: false,
    stdoutStructuredEvents: [
      { type: "item.completed", item: { id: "item-1", type: "patch_apply" } },
    ],
    preflightProvedWritable: true,
  });
  assert.equal(result, "unknown");
});

test("T26 follow-up: an item.completed/item.started event with a malformed item fails closed to unknown, not skipped as no-evidence", () => {
  const classify = runnerModule.__testEnvironmentClaimCorroboration
    .classifyReviewerEnvironmentClaimCorroboration;
  for (const malformedItem of [undefined, null, "not-an-object", [], { id: "item-1" }, { id: "item-1", type: 42 }]) {
    const result = classify({
      mode: "pr-sticky",
      tool: "codex",
      verdict: "UNAVAILABLE",
      stdoutTruncated: false,
      stdoutStructuredEvents: [
        { type: "item.completed", item: malformedItem },
      ],
      preflightProvedWritable: true,
    });
    assert.equal(
      result,
      "unknown",
      `malformed item ${JSON.stringify(malformedItem)} must fail closed to unknown, not reviewer_environment_claim_uncorroborated`,
    );
  }
});

test("T26: an actually observed write-class event fails closed to unknown, not uncorroborated", () => {
  const classify = runnerModule.__testEnvironmentClaimCorroboration
    .classifyReviewerEnvironmentClaimCorroboration;
  const result = classify({
    mode: "pr-sticky",
    tool: "codex",
    verdict: "UNAVAILABLE",
    stdoutTruncated: false,
    stdoutStructuredEvents: [
      { type: "item.started", item: { id: "item-1", type: "command_execution", command: "echo hi", status: "in_progress" } },
      {
        type: "item.completed",
        item: {
          id: "item-1",
          type: "command_execution",
          command: "echo hi",
          aggregated_output: "hi\n",
          exit_code: 0,
          status: "completed",
        },
      },
    ],
    preflightProvedWritable: true,
  });
  assert.equal(result, "unknown");
});

test("T26: a preflight that never proved the surface writable does not produce reviewer_environment_claim_uncorroborated (result is unknown)", () => {
  const classify = runnerModule.__testEnvironmentClaimCorroboration
    .classifyReviewerEnvironmentClaimCorroboration;
  for (const preflightProvedWritable of [false, undefined, null]) {
    const result = classify({
      mode: "pr-sticky",
      tool: "codex",
      verdict: "UNAVAILABLE",
      stdoutTruncated: false,
      stdoutStructuredEvents: [],
      preflightProvedWritable,
    });
    assert.notEqual(
      result,
      "reviewer_environment_claim_uncorroborated",
      `preflightProvedWritable=${preflightProvedWritable}`
    );
    assert.equal(result, "unknown", `preflightProvedWritable=${preflightProvedWritable}`);
  }
});

test("T26: outside pr-sticky + UNAVAILABLE scope the classifier is not applicable — null, never unknown or the diagnostic", () => {
  const classify = runnerModule.__testEnvironmentClaimCorroboration
    .classifyReviewerEnvironmentClaimCorroboration;
  const baseline = {
    tool: "codex",
    stdoutTruncated: false,
    stdoutStructuredEvents: [],
    preflightProvedWritable: true,
  };
  assert.equal(classify({ ...baseline, mode: "audit-only", verdict: "UNAVAILABLE" }), null);
  assert.equal(classify({ ...baseline, mode: "pr-sticky", verdict: "PASS" }), null);
  assert.equal(classify({ ...baseline, mode: "pr-sticky", verdict: "CRITICAL" }), null);
  assert.equal(classify({ ...baseline, mode: "pr-sticky", verdict: null }), null);
});

// Fraud-proofing (design.md D4 point 4 / "禁 phrase-scan"): the classifier reads ONLY
// allowlisted structured fields (mode, tool, the typed verdict, truncation, item.type
// vocabulary). Build the real shape parseCodexCompletion reads — an agent_message item
// whose `text` carries the reviewer's own completion JSON, including its free-text
// `reason` — and vary `reason` across adversarial values that would flip a naive
// phrase-scanner's answer. The classification must stay byte-identical throughout,
// proving `reason` genuinely present in the input has zero effect, not merely that the
// function's parameter list happens to omit it.
test("T26: rewriting the reviewer's free-text reason has no effect on the classification (fraud-proofing / anti phrase-scan)", () => {
  const classify = runnerModule.__testEnvironmentClaimCorroboration
    .classifyReviewerEnvironmentClaimCorroboration;
  const adversarialReasons = [
    "Reviewer could not read required material.",
    "I ran command_execution and wrote the file successfully.",
    "permission denied writing the sticky comment",
    "",
    "x".repeat(10_000),
  ];
  const results = adversarialReasons.map((reason) => classify({
    mode: "pr-sticky",
    tool: "codex",
    verdict: "UNAVAILABLE",
    stdoutTruncated: false,
    stdoutStructuredEvents: [
      {
        type: "item.completed",
        item: {
          id: "item-final",
          type: "agent_message",
          text: JSON.stringify({
            sticky_comment_url: "none",
            verdict: "UNAVAILABLE",
            last_reviewed_sha: "none",
            reviewer_model: "codex-test",
            reason,
          }),
        },
      },
    ],
    preflightProvedWritable: true,
  }));
  for (const result of results) {
    assert.equal(result, "reviewer_environment_claim_uncorroborated");
  }
});

test("T26: classifying an environment claim does not mutate its input, and never overwrites the caller's verdict", () => {
  const classify = runnerModule.__testEnvironmentClaimCorroboration
    .classifyReviewerEnvironmentClaimCorroboration;
  const input = {
    mode: "pr-sticky",
    tool: "codex",
    verdict: "UNAVAILABLE",
    stdoutTruncated: false,
    stdoutStructuredEvents: [
      { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "{}" } },
    ],
    preflightProvedWritable: true,
  };
  const before = JSON.parse(JSON.stringify(input));
  const result = classify(input);
  assert.equal(result, "reviewer_environment_claim_uncorroborated");
  assert.deepEqual(input, before, "the classifier must not mutate its input");
  assert.equal(input.verdict, "UNAVAILABLE", "the caller's own verdict field must never be overwritten");
});

// D4/D5 wiring proof (R5; tasks.md T25-T26) — everything above tests the pure classifier
// directly; this one proves it is actually invoked during a real dispatch, not dead code.
// A full Codex pr-sticky dispatch whose reviewer returns UNAVAILABLE without ever writing
// anything (default `writeFakeGh` response has zero comments, so sticky verification lands
// on `sticky_missing`, and the fake reviewer's only stdout lines are its own invocation-
// echo line plus the UNAVAILABLE completion — no command_execution item anywhere) with a
// real (unmocked) write-capability preflight round trip against the real filesystem.
test("T25-T26 wiring: a full pr-sticky Codex dispatch that returns UNAVAILABLE without ever attempting a write records reviewer_environment_claim_uncorroborated", () => {
  withTempDir("second-review-runner-environment-claim-wiring-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    writeFakeGh(binDir);
    const defaultCodexHome = path.join(dir, "default-codex-home");
    mkdirSync(defaultCodexHome, { recursive: true });
    writeFileSync(path.join(defaultCodexHome, "auth.json"), '{"not":"a real credential"}\n', "utf8");

    const { context } = renderHandoff(dir, codexPrStickyHandoff);
    const result = runGeneratedRunnerCommand(context, binDir, {
      CODEX_HOME: defaultCodexHome,
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: "item.completed",
        item: {
          id: "item-final",
          type: "agent_message",
          text: JSON.stringify({
            sticky_comment_url: "none",
            verdict: "UNAVAILABLE",
            last_reviewed_sha: prStickyHeadSha,
            reviewer_model: "codex-test",
            reason: "Reviewer could not read required material.",
          }),
        },
      }),
    });

    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_completion_unavailable");
    const events = activityEvents(context.activity_log_path);
    assert.equal(events.includes("reviewer_environment_claim_uncorroborated"), true);
    assert.equal(events.includes("reviewer_write_surface_verified"), true);
  });
});

const STREAM_MODEL = "claude-opus-5";
const SELF_REPORT_MODEL = "claude-sonnet-4-5";
const CODEX_STREAM_MODEL = "gpt-5.4";
const CODEX_SELF_REPORT_MODEL = "codex-test";

function applyExecutionStreamIfExported(boundedEvidence, parsed, tool) {
  const apply = __testReviewerClassification.applyExecutionStreamReviewerModel;
  if (typeof apply === "function") {
    apply(boundedEvidence, parsed, { tool });
  }
}

function claudeMismatchResultEvent(completionOverrides = {}) {
  const completion = {
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: "none",
    reviewer_model: SELF_REPORT_MODEL,
    reason: "No blocking findings.",
    ...completionOverrides,
  };
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    modelUsage: {
      [STREAM_MODEL]: { costUSD: 0, contextWindow: 200000 },
    },
    result: JSON.stringify(completion),
    completion,
  };
}

function persistedClaudeReviewerModel(context, terminal) {
  const parsed = __testReviewerClassification.parseClaudeCompletion(context, terminal);
  applyExecutionStreamIfExported(
    boundedEvidenceForClassification({
      stdoutStructuredEvents: [terminal],
      terminal,
    }),
    parsed,
    "claude",
  );
  return parsed;
}

function persistedCodexReviewerModel(context, stdoutStructuredEvents) {
  const parsed = __testReviewerClassification.parseCodexCompletion(
    context,
    stdoutStructuredEvents,
  );
  applyExecutionStreamIfExported(
    boundedEvidenceForClassification({ stdoutStructuredEvents }),
    parsed,
    "codex",
  );
  return parsed;
}

test("execution-stream reviewer-model: Claude modelUsage overwrites mismatched self-report on audit persist face", () => {
  withTempDir("second-review-runner-stream-model-claude-persist-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir, auditHandoff);
    const terminal = claudeMismatchResultEvent({
      last_reviewed_sha: context.head_ref_oid,
    });
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: terminal.type,
        subtype: terminal.subtype,
        is_error: terminal.is_error,
        modelUsage: terminal.modelUsage,
        result: terminal.result,
      }),
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "reviewer_cli_completed");
    assert.notEqual(output.classification, "reviewer_completion_contract_invalid");
    assert.notEqual(output.classification, "sticky_contract_invalid");

    const evidence = __testReviewerClassification.extractBoundedTerminalEvidence(context);
    assert.equal(evidence.terminal?.type, "result");
    assert.deepEqual(Object.keys(evidence.terminal.modelUsage), [STREAM_MODEL]);
    const parsed = persistedClaudeReviewerModel(context, evidence.terminal);
    assert.equal(parsed.status, "accepted");
    assert.equal(
      parsed.completion.reviewer_model,
      STREAM_MODEL,
      `audit persist face must keep stream identity, not self-report ${parsed.completion.reviewer_model}`,
    );
    assert.deepEqual(Object.keys(parsed.completion), [
      "sticky_comment_url",
      "verdict",
      "last_reviewed_sha",
      "reviewer_model",
      "reason",
    ]);
    const classification = classifyReviewerCliEventsForTest(
      claudeClassificationContext({ head_ref_oid: context.head_ref_oid }),
      { stdoutStructuredEvents: [evidence.terminal] },
    );
    assert.equal(classification, "reviewer_cli_completed");
  });
});

test("execution-stream reviewer-model: PR2408 multi-model Claude stream binds completion sticky and usage manifest to direct execution", () => {
  withTempDir("second-review-runner-stream-model-pr2408-shape-", (dir) => {
    const binDir = path.join(dir, "bin");
    const ghLog = path.join(dir, "gh.log");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const stickyUrl = "https://github.com/devpro/example/pull/1658#issuecomment-4242";
    const primaryModel = "claude-opus-5";
    const helperModel = "claude-haiku-4-5-20251001";
    const completion = {
      sticky_comment_url: stickyUrl,
      verdict: "PASS",
      last_reviewed_sha: context.head_ref_oid,
      reviewer_model: SELF_REPORT_MODEL,
      reason: "No blocking findings.",
    };
    completion.reason += "\n\n## Guarantee Assessment\n```json\n" + JSON.stringify({ schema: "devpro.review-guarantee-assessment/v1", reviewed_target: context.head_ref_oid, dispatch_id: context.dispatch_id, assessments: [] }) + "\n```";
    const terminal = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "ff6f901e-558c-4100-8fea-575446338506",
      modelUsage: {
        [helperModel]: { costUSD: 0, contextWindow: 200000 },
        [primaryModel]: { costUSD: 1, contextWindow: 200000 },
      },
      result: JSON.stringify(completion),
    };
    const directInit = {
      type: "system",
      subtype: "init",
      model: primaryModel,
      tools: ["Bash", "StructuredOutput", "Write"],
    };
    const executionEvents = [
      { type: "assistant", message: { model: primaryModel }, parent_tool_use_id: null },
      { type: "assistant", message: { model: primaryModel }, parent_tool_use_id: null },
      { type: "assistant", message: { model: "claude-ignored-missing-parent" } },
      { type: "assistant", message: { model: helperModel }, parent_tool_use_id: "toolu-helper" },
    ];
    const helperScopedInitEvents = [
      { type: "system", subtype: "init", model: helperModel, parent_tool_use_id: null },
      { type: "system", subtype: "init", model: helperModel, parent_tool_use_id: "toolu-helper" },
    ];
    const pr2408Evidence = boundedEvidenceForClassification({
      stdoutStructuredEvents: [directInit, ...executionEvents, ...helperScopedInitEvents, terminal],
      terminal,
    });
    const fixtureParsed = __testReviewerClassification.parseClaudeCompletion(context, terminal);
    applyExecutionStreamIfExported(pr2408Evidence, fixtureParsed, "claude");
    assert.equal(fixtureParsed.status, "accepted");
    assert.equal(
      fixtureParsed.completion.reviewer_model,
      primaryModel,
      `completion must use direct execution model, actual=${fixtureParsed.completion.reviewer_model}`,
    );

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      DEVPRO_FAKE_REVIEWER_INIT_EVENT: JSON.stringify(directInit),
      DEVPRO_FAKE_GH_LOG: ghLog,
      DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponse(
        "PASS",
        context.dispatch_id,
        "Claude Code",
        SELF_REPORT_MODEL,
      ),
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: [...executionEvents, terminal].map(JSON.stringify).join("\n"),
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const evidence = __testReviewerClassification.extractBoundedTerminalEvidence(context);
    const parsed = __testReviewerClassification.parseClaudeCompletion(context, evidence.terminal);
    applyExecutionStreamIfExported(evidence, parsed, "claude");
    assert.equal(parsed.status, "accepted");
    assert.equal(
      parsed.completion.reviewer_model,
      primaryModel,
      `completion must use direct execution model, actual=${parsed.completion.reviewer_model}`,
    );

    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "finished");
    assert.equal(output.sticky.status, "verified");
    assert.equal(output.sticky.reviewer_model, primaryModel);
    const usageManifest = JSON.parse(readFileSync(
      path.join(context.control_evidence_root, context.dispatch_id, "usage-manifest.json"),
      "utf8",
    ));
    const reviewerSession = usageManifest.sessions.find((session) => session.role === "reviewer");
    assert.equal(reviewerSession?.reviewer_model, primaryModel);
  });
});

test("Scenario: Codex reviewer identity survives bounded stdout tail truncation", () => {
  withTempDir("second-review-codex-usage-snapshot-tail-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeCodex(binDir);
    const { context } = renderHandoff(dir, codexAuditHandoff);
    const reviewerSessionId = "d95add52-317d-4bab-afdd-575446338506";
    const threadStarted = { type: "thread.started", thread_id: reviewerSessionId };
    const usage = { input_tokens: 120, cached_input_tokens: 45, output_tokens: 17 };
    const completion = {
      sticky_comment_url: "none",
      verdict: "PASS",
      last_reviewed_sha: "none",
      reviewer_model: "codex-test",
      reason: "No blocking findings.",
    };
    const terminalEvents = [
      { type: "turn.completed", usage },
      { type: "item.completed", item: { id: "item-final", type: "agent_message", text: JSON.stringify(completion) } },
    ].map(JSON.stringify).join("\n");

    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_RAW_STDOUT_PREFIX: JSON.stringify(threadStarted),
      DEVPRO_FAKE_REVIEWER_RAW_STDOUT_LINE_BYTES: "16000",
      DEVPRO_FAKE_REVIEWER_RAW_STDOUT_LINE_REPEAT: "5",
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: terminalEvents,
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const boundedEvidence = __testReviewerClassification.extractBoundedTerminalEvidence(context);
    assert.equal(boundedEvidence.stdoutTruncated, true);
    assert.equal(
      boundedEvidence.stdoutStructuredEvents.some((event) => event.type === "thread.started"),
      false,
      "the fixture must place thread.started outside the retained tail",
    );
    assert.equal(
      boundedEvidence.stdoutStructuredEvents.some((event) => event.type === "turn.completed"),
      true,
      "the completed usage event remains inside the retained tail",
    );

    const usageManifest = JSON.parse(readFileSync(
      path.join(context.control_evidence_root, context.dispatch_id, "usage-manifest.json"),
      "utf8",
    ));
    const reviewerSession = usageManifest.sessions.find((session) => session.role === "reviewer");
    assert.equal(reviewerSession?.session_id, reviewerSessionId);
    assert.deepEqual(reviewerSession?.usage_snapshot, {
      totals: { input: 75, output: 17, cache_read: 45, cache_creation: null },
      source: "reviewer-manifest:turn.completed.usage",
    });
  });
});

test("execution-stream reviewer-model: zero trusted candidates preserve matching legal self-report", () => {
  withTempDir("second-review-runner-stream-model-zero-candidates-", (dir) => {
    const binDir = path.join(dir, "bin");
    const ghLog = path.join(dir, "gh.log");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const stickyUrl = "https://github.com/devpro/example/pull/1658#issuecomment-4242";
    const completion = {
      sticky_comment_url: stickyUrl,
      verdict: "PASS",
      last_reviewed_sha: context.head_ref_oid,
      reviewer_model: SELF_REPORT_MODEL,
      reason: "No blocking findings.",
    };
    const terminal = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "d95add52-317d-4bab-afdd-ce70ad27c702",
      result: JSON.stringify(completion),
    };
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      DEVPRO_FAKE_GH_LOG: ghLog,
      DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponse(
        "PASS",
        context.dispatch_id,
        "Claude Code",
        SELF_REPORT_MODEL,
      ),
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify(terminal),
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const evidence = __testReviewerClassification.extractBoundedTerminalEvidence(context);
    const parsed = __testReviewerClassification.parseClaudeCompletion(context, evidence.terminal);
    applyExecutionStreamIfExported(evidence, parsed, "claude");
    assert.equal(parsed.completion.reviewer_model, SELF_REPORT_MODEL);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sticky.reviewer_model, SELF_REPORT_MODEL);
    const usageManifest = JSON.parse(readFileSync(
      path.join(context.control_evidence_root, context.dispatch_id, "usage-manifest.json"),
      "utf8",
    ));
    const reviewerSession = usageManifest.sessions.find((session) => session.role === "reviewer");
    assert.equal(reviewerSession?.reviewer_model, SELF_REPORT_MODEL);
    const ghCommands = readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(
      ghCommands.some((line) => /(?:^|\s)-X\s+PATCH\b|--method\s+PATCH\b/.test(line)),
      false,
      "zero trusted candidates must not PATCH an already matching legal self-report",
    );
  });
});

test("execution-stream reviewer-model: zero trusted candidates reject mismatched legal sticky model without PATCH", () => {
  withTempDir("second-review-runner-stream-model-zero-candidates-mismatch-", (dir) => {
    const binDir = path.join(dir, "bin");
    const ghLog = path.join(dir, "gh.log");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const stickyUrl = "https://github.com/devpro/example/pull/1658#issuecomment-4242";
    const stickyLegalModel = "claude-opus-4-1";
    const completion = {
      sticky_comment_url: stickyUrl,
      verdict: "PASS",
      last_reviewed_sha: context.head_ref_oid,
      reviewer_model: SELF_REPORT_MODEL,
      reason: "No blocking findings.",
    };
    const terminal = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "0b753a60-a5f8-4a38-bf11-6844117d98f3",
      result: JSON.stringify(completion),
    };
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      DEVPRO_FAKE_GH_LOG: ghLog,
      DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponse(
        "PASS",
        context.dispatch_id,
        "Claude Code",
        stickyLegalModel,
      ),
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify(terminal),
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "sticky_contract_invalid");
    assert.equal(output.sticky.status, "failed");
    assert.equal(output.sticky.classification, "sticky_contract_invalid");
    assert.equal(output.sticky.reviewer_model, stickyLegalModel);
    assert.match(
      readFileSync(context.activity_log_path, "utf8"),
      /sticky_reviewer_model_invalid/,
    );
    const evidence = __testReviewerClassification.extractBoundedTerminalEvidence(context);
    const parsed = __testReviewerClassification.parseClaudeCompletion(context, evidence.terminal);
    applyExecutionStreamIfExported(evidence, parsed, "claude");
    assert.equal(parsed.completion.reviewer_model, SELF_REPORT_MODEL);
    const usageManifest = JSON.parse(readFileSync(
      path.join(context.control_evidence_root, context.dispatch_id, "usage-manifest.json"),
      "utf8",
    ));
    const reviewerSession = usageManifest.sessions.find((session) => session.role === "reviewer");
    assert.equal(reviewerSession?.reviewer_model, SELF_REPORT_MODEL);
    const ghCommands = readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(
      ghCommands.some((line) => /(?:^|\s)-X\s+PATCH\b|--method\s+PATCH\b/.test(line)),
      false,
      "null trusted identity must not PATCH a different legal sticky self-report",
    );
  });
});

test("execution-stream reviewer-model: Claude three-tier authority stops on conflicts and filters asymmetric parent shapes", () => {
  const primaryModel = "claude-opus-5";
  const alternateModel = "claude-sonnet-5";
  const helperModel = "claude-haiku-4-5-20251001";
  const context = claudeClassificationContext();
  const completionTerminal = (modelUsage = undefined) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    ...(modelUsage === undefined ? {} : { modelUsage }),
    result: JSON.stringify({
      sticky_comment_url: "none",
      verdict: "PASS",
      last_reviewed_sha: "none",
      reviewer_model: SELF_REPORT_MODEL,
      reason: "No blocking findings.",
    }),
  });
  const resolve = (events, terminal) => {
    const evidence = boundedEvidenceForClassification({
      stdoutStructuredEvents: [...events, terminal],
      terminal,
    });
    const parsed = __testReviewerClassification.parseClaudeCompletion(context, terminal);
    const trusted = __testReviewerClassification.extractExecutionStreamReviewerModel(
      evidence,
      { tool: "claude" },
    );
    applyExecutionStreamIfExported(evidence, parsed, "claude");
    return { trusted, finalized: parsed.completion.reviewer_model };
  };

  const divergenceTerminal = completionTerminal({ [helperModel]: {} });
  assert.deepEqual(resolve([
    { type: "assistant", message: { model: primaryModel }, parent_tool_use_id: null },
    { type: "system", subtype: "init", model: alternateModel },
  ], divergenceTerminal), { trusted: primaryModel, finalized: primaryModel });

  const assistantConflict = resolve([
    { type: "assistant", message: { model: primaryModel }, parent_tool_use_id: null },
    { type: "assistant", message: { model: alternateModel }, parent_tool_use_id: null },
    { type: "system", subtype: "init", model: primaryModel },
  ], completionTerminal({ [primaryModel]: {} }));
  assert.deepEqual(assistantConflict, { trusted: null, finalized: SELF_REPORT_MODEL });

  const initConflict = resolve([
    { type: "assistant", message: { model: primaryModel } },
    { type: "assistant", message: { model: helperModel }, parent_tool_use_id: "toolu-helper" },
    { type: "system", subtype: "init", model: primaryModel },
    { type: "system", subtype: "init", model: alternateModel },
  ], completionTerminal({ [primaryModel]: {} }));
  assert.deepEqual(initConflict, { trusted: null, finalized: SELF_REPORT_MODEL });

  const directInitFallback = resolve([
    { type: "assistant", message: { model: alternateModel } },
    { type: "assistant", message: { model: helperModel }, parent_tool_use_id: "toolu-helper" },
    { type: "system", subtype: "init", model: primaryModel },
    { type: "system", subtype: "init", model: alternateModel, parent_tool_use_id: null },
    { type: "system", subtype: "init", model: helperModel, parent_tool_use_id: "toolu-helper" },
  ], completionTerminal({ [alternateModel]: {} }));
  assert.deepEqual(directInitFallback, { trusted: primaryModel, finalized: primaryModel });

  const inheritedMessage = Object.create({ model: primaryModel });
  const inheritedInit = Object.assign(Object.create({ model: primaryModel }), {
    type: "system",
    subtype: "init",
  });
  assert.deepEqual(resolve([
    { type: "assistant", message: inheritedMessage, parent_tool_use_id: null },
    inheritedInit,
  ], completionTerminal({ [alternateModel]: {} })), {
    trusted: alternateModel,
    finalized: alternateModel,
  });

  assert.deepEqual(
    resolve([], completionTerminal({ [primaryModel]: {} })),
    { trusted: primaryModel, finalized: primaryModel },
  );
  assert.deepEqual(
    resolve([], completionTerminal()),
    { trusted: null, finalized: SELF_REPORT_MODEL },
  );
});

test("execution-stream reviewer-model: generated runner retains legal self-report across all persistence faces on same-tier conflicts", () => {
  const primaryModel = "claude-opus-5";
  const alternateModel = "claude-sonnet-5";
  const cases = [
    {
      label: "assistant same-tier conflict",
      initEvent: {
        type: "system",
        subtype: "init",
        model: primaryModel,
        tools: ["Bash", "StructuredOutput", "Write"],
      },
      executionEvents: [
        { type: "assistant", message: { model: primaryModel }, parent_tool_use_id: null },
        { type: "assistant", message: { model: alternateModel }, parent_tool_use_id: null },
      ],
      preexistingEvidenceEvents: [],
    },
    {
      label: "init same-tier conflict",
      initEvent: {
        type: "system",
        subtype: "init",
        model: primaryModel,
        tools: ["Bash", "StructuredOutput", "Write"],
      },
      executionEvents: [],
      preexistingEvidenceEvents: [
        {
          type: "system",
          subtype: "init",
          model: alternateModel,
        },
      ],
    },
  ];

  for (const { label, initEvent, executionEvents, preexistingEvidenceEvents } of cases) {
    withTempDir(`second-review-runner-stream-model-${label.replaceAll(" ", "-")}-`, (dir) => {
      const binDir = path.join(dir, "bin");
      const ghLog = path.join(dir, "gh.log");
      mkdirSync(binDir, { recursive: true });
      writeFakeClaude(binDir);
      writeFakeGh(binDir);
      const { context } = renderHandoff(dir, prStickyHandoff);
      if (preexistingEvidenceEvents.length > 0) {
        appendFileSync(
          context.stdout_log_path,
          `${preexistingEvidenceEvents.map(JSON.stringify).join("\n")}\n`,
        );
      }
      const stickyUrl = "https://github.com/devpro/example/pull/1658#issuecomment-4242";
      const completion = {
        sticky_comment_url: stickyUrl,
        verdict: "PASS",
        last_reviewed_sha: context.head_ref_oid,
        reviewer_model: SELF_REPORT_MODEL,
        reason: "No blocking findings.",
      };
      const terminal = {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "f7ae9bba-980a-4b39-9976-02b8d1ea5cad",
        modelUsage: { [primaryModel]: { costUSD: 1, contextWindow: 200000 } },
        result: JSON.stringify(completion),
      };
      const result = runGeneratedRunnerCommand(context, binDir, {
        DEVPRO_FAKE_REVIEWER_INIT_EVENT: JSON.stringify(initEvent),
        DEVPRO_FAKE_GH_LOG: ghLog,
        DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponse(
          "PASS",
          context.dispatch_id,
          "Claude Code",
          SELF_REPORT_MODEL,
        ),
        DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: [...executionEvents, terminal]
          .map(JSON.stringify)
          .join("\n"),
      });

      assert.equal(result.status, 0, `${label}: ${result.stderr}\n${result.stdout}`);
      const evidence = __testReviewerClassification.extractBoundedTerminalEvidence(context);
      assert.equal(
        __testReviewerClassification.extractExecutionStreamReviewerModel(
          evidence,
          { tool: "claude" },
        ),
        null,
        `${label}: resolver must stop at the conflicting tier`,
      );
      const parsed = __testReviewerClassification.parseClaudeCompletion(
        context,
        evidence.terminal,
      );
      applyExecutionStreamIfExported(evidence, parsed, "claude");
      assert.equal(parsed.status, "accepted", label);
      assert.equal(
        parsed.completion.reviewer_model,
        SELF_REPORT_MODEL,
        `${label}: finalized completion must retain the validated legal self-report`,
      );

      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "finished", label);
      assert.equal(output.sticky.status, "verified", label);
      assert.equal(output.sticky.reviewer_model, SELF_REPORT_MODEL, label);
      const usageManifest = JSON.parse(readFileSync(
        path.join(context.control_evidence_root, context.dispatch_id, "usage-manifest.json"),
        "utf8",
      ));
      const reviewerSession = usageManifest.sessions.find((session) => session.role === "reviewer");
      assert.equal(reviewerSession?.reviewer_model, SELF_REPORT_MODEL, label);
      const ghCommands = readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(
        ghCommands.some((line) => /(?:^|\s)-X\s+PATCH\b|--method\s+PATCH\b/.test(line)),
        false,
        `${label}: null trusted identity must not PATCH a matching legal self-report`,
      );
    });
  }
});

test("execution-stream reviewer-model: Claude missing or multi-key modelUsage keeps self-report", () => {
  const context = claudeClassificationContext();
  const cases = [
    ["absent", undefined],
    ["empty", {}],
    ["two-keys", {
      [STREAM_MODEL]: { costUSD: 1, contextWindow: 200000 },
      "claude-sonnet-4-5": { costUSD: 0, contextWindow: 200000 },
    }],
  ];
  for (const [label, modelUsage] of cases) {
    const terminal = {
      type: "result",
      subtype: "success",
      is_error: false,
      ...(modelUsage === undefined ? {} : { modelUsage }),
      result: JSON.stringify({
        sticky_comment_url: "none",
        verdict: "PASS",
        last_reviewed_sha: "none",
        reviewer_model: SELF_REPORT_MODEL,
        reason: "No blocking findings.",
      }),
    };
    const parsed = persistedClaudeReviewerModel(context, terminal);
    assert.equal(parsed.status, "accepted", label);
    assert.equal(
      parsed.completion.reviewer_model,
      SELF_REPORT_MODEL,
      `${label}: missing-stream must keep self-report`,
    );
    assert.equal(
      classifyReviewerCliEventsForTest(context, { stdoutStructuredEvents: [terminal] }),
      "reviewer_cli_completed",
      label,
    );
  }
});

test("execution-stream reviewer-model: Claude placeholder stream identity keeps legal self-report", () => {
  const context = claudeClassificationContext();
  const terminal = {
    type: "result",
    subtype: "success",
    is_error: false,
    modelUsage: { "unknown": { costUSD: 0, contextWindow: 200000 } },
    result: JSON.stringify({
      sticky_comment_url: "none",
      verdict: "PASS",
      last_reviewed_sha: "none",
      reviewer_model: SELF_REPORT_MODEL,
      reason: "No blocking findings.",
    }),
  };
  const parsed = persistedClaudeReviewerModel(context, terminal);
  assert.equal(parsed.status, "accepted");
  assert.equal(parsed.completion.reviewer_model, SELF_REPORT_MODEL);
  assert.equal(
    classifyReviewerCliEventsForTest(context, { stdoutStructuredEvents: [terminal] }),
    "reviewer_cli_completed",
  );
});

// T8/T9/T10 (design.md D5/D6/D7; tasks.md items 9/10/11): the codex branch of
// extractExecutionStreamReviewerModel() no longer reads
// thread.started.model/turn.completed.model off the `--json` stream -- that
// premise never held on real codex (design.md Context §3: 0 events ever
// carried `model` in captured attempts). It now joins `thread.started.thread_id`
// to the isolated CODEX_HOME's own rollout record and reads
// `turn_context.payload.model` from it (D5). The 7 tests this block replaces
// were exercising the dead pre-D5 branch; replacing them (not just adding new
// ones) is the TDD-correct response to a branch whose actual data source
// changed, not a coverage reduction -- item 9/10's join/budget/degrade
// behavior is now covered directly against the real code paths below.
function codexRolloutDayDir(codexHomePath) {
  const dir = path.join(codexHomePath, "sessions", "2026", "01", "15");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCodexRolloutFile(codexHomePath, threadId, turnContextModels, { filename } = {}) {
  const dir = codexRolloutDayDir(codexHomePath);
  const filePath = path.join(dir, filename ?? `rollout-2026-01-15T00-00-00-${threadId}.jsonl`);
  const lines = turnContextModels.map((model) => JSON.stringify(
    model === null
      ? { type: "turn_context", payload: {} }
      : { type: "turn_context", payload: { model } },
  ));
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

test("execution-stream reviewer-model: Codex observed model is resolved by joining thread.started.thread_id to its isolated-home rollout record", () => {
  withTempDir("second-review-runner-codex-rollout-join-", (dir) => {
    const codexHomePath = path.join(dir, "codex-home");
    mkdirSync(codexHomePath, { recursive: true });
    writeCodexRolloutFile(codexHomePath, "thr-1", [CODEX_STREAM_MODEL]);
    const resolved = __testCodexRolloutScan.resolveCodexObservedModelFromRollout({
      codexHomePath,
      threadId: "thr-1",
    });
    assert.deepEqual(resolved, { model: CODEX_STREAM_MODEL, source: "isolated-home-rollout", reason: null });

    // Full path: extractExecutionStreamReviewerModel() derives thread_id from
    // the LAST thread.started event in the stream (multi-window ordering,
    // same as the pre-D5 branch it replaces), then joins it to the rollout.
    const evidence = boundedEvidenceForClassification({
      stdoutStructuredEvents: [
        { type: "thread.started", thread_id: "thr-old" },
        { type: "thread.started", thread_id: "thr-1" },
      ],
    });
    assert.equal(
      __testReviewerClassification.extractExecutionStreamReviewerModel(evidence, { tool: "codex", codexHomePath }),
      CODEX_STREAM_MODEL,
    );
  });
});

// D7 / r2 finding F-srms-pr2-01. The rollout is an external artifact and RK-3
// already concedes its format is not a stable contract, so a PRESENT but
// out-of-shape value must take the same closed-set degrade as an absent one.
// It must never reach assertReviewerModelRecord(): D12 orders the record write
// before every receipt seal, so a throw there would end a review that actually
// finished as `blocked` with neither a completion nor a terminal receipt, and
// would recur on every dispatch for as long as the rollout carried that value.
test("execution-stream reviewer-model: a present but out-of-shape rollout model degrades to rollout_unparsable instead of reaching the record writer", () => {
  withTempDir("second-review-runner-codex-rollout-out-of-shape-", (dir) => {
    const codexHomePath = path.join(dir, "codex-home");
    mkdirSync(codexHomePath, { recursive: true });
    const evidence = boundedEvidenceForClassification({
      stdoutStructuredEvents: [{ type: "thread.started", thread_id: "thr-1" }],
    });
    // Each of these is accepted by lastTurnContextModel() (a non-empty string
    // after trim) but rejected by the record writer's identity-field rule.
    for (const hostile of ["a".repeat(257), `gpt-5.6\u0007sol`, "unknown"]) {
      writeCodexRolloutFile(codexHomePath, "thr-1", [hostile]);
      assert.equal(
        isUsableIdentityFieldValue(hostile) && hostile !== "unknown",
        false,
        `${JSON.stringify(hostile)} must be rejected by the writer's own rule or be a placeholder`,
      );
      assert.deepEqual(
        __testReviewerClassification.resolveReviewerObservedIdentity(evidence, { tool: "codex", codexHomePath }),
        { model: null, source: null, reason: "rollout_unparsable" },
      );
      // The same filter governs the value that reaches completion.reviewer_model.
      assert.equal(
        __testReviewerClassification.extractExecutionStreamReviewerModel(evidence, { tool: "codex", codexHomePath }),
        null,
      );
    }
    // Control: a well-shaped value still resolves, so the guard is not vacuous.
    writeCodexRolloutFile(codexHomePath, "thr-1", [CODEX_STREAM_MODEL]);
    assert.deepEqual(
      __testReviewerClassification.resolveReviewerObservedIdentity(evidence, { tool: "codex", codexHomePath }),
      { model: CODEX_STREAM_MODEL, source: "isolated-home-rollout", reason: "none" },
    );
  });
});

test("execution-stream reviewer-model: Codex rollout with multiple turn_context lines uses the LAST one", () => {
  withTempDir("second-review-runner-codex-rollout-last-wins-", (dir) => {
    const codexHomePath = path.join(dir, "codex-home");
    mkdirSync(codexHomePath, { recursive: true });
    writeCodexRolloutFile(codexHomePath, "thr-1", [CODEX_STREAM_MODEL, null, "gpt-5.5"]);
    assert.deepEqual(
      __testCodexRolloutScan.resolveCodexObservedModelFromRollout({ codexHomePath, threadId: "thr-1" }),
      { model: "gpt-5.5", source: "isolated-home-rollout", reason: null },
    );
  });
});

test("execution-stream reviewer-model: Codex rollout lookup with no matching thread_id file fails unavailable with rollout_not_found", () => {
  withTempDir("second-review-runner-codex-rollout-not-found-", (dir) => {
    const codexHomePath = path.join(dir, "codex-home");
    mkdirSync(codexHomePath, { recursive: true });
    writeCodexRolloutFile(codexHomePath, "thr-other", [CODEX_STREAM_MODEL]);
    assert.deepEqual(
      __testCodexRolloutScan.resolveCodexObservedModelFromRollout({ codexHomePath, threadId: "thr-1" }),
      { model: null, source: null, reason: "rollout_not_found" },
    );
    // A stream that never produced a usable thread_id (no thread.started, or
    // one with no thread_id) is the same "not found" shape -- there is no
    // join key to look anything up with.
    assert.deepEqual(
      __testCodexRolloutScan.resolveCodexObservedModelFromRollout({ codexHomePath, threadId: null }),
      { model: null, source: null, reason: "rollout_not_found" },
    );
  });
});

test("execution-stream reviewer-model: Codex rollout with only model-less turn_context lines fails unavailable with rollout_unparsable", () => {
  withTempDir("second-review-runner-codex-rollout-unparsable-", (dir) => {
    const codexHomePath = path.join(dir, "codex-home");
    mkdirSync(codexHomePath, { recursive: true });
    writeCodexRolloutFile(codexHomePath, "thr-1", [null, null]);
    assert.deepEqual(
      __testCodexRolloutScan.resolveCodexObservedModelFromRollout({ codexHomePath, threadId: "thr-1" }),
      { model: null, source: null, reason: "rollout_unparsable" },
    );
  });
});

// T9/D7 — the degrade path (no isolated home clamped for this dispatch) MUST
// fail unavailable with reviewer_home_not_isolated and MUST NOT fall back to
// reading the operator's real ~/.codex. resolveCodexObservedModelFromRollout()
// takes no homedir dependency at all (unlike defaultReviewerCodexHome() above,
// which does and is spied via dependency injection at :9737) -- the source-grep
// below is the structural proof that `homedir(` never appears in this
// function's own body, so there is nothing to spy on in the first place.
test("execution-stream reviewer-model: Codex degrade path (no isolated CODEX_HOME) is unavailable with reviewer_home_not_isolated and never calls homedir()", () => {
  assert.deepEqual(
    __testCodexRolloutScan.resolveCodexObservedModelFromRollout({ codexHomePath: undefined, threadId: "thr-1" }),
    { model: null, source: null, reason: "reviewer_home_not_isolated" },
  );
  assert.deepEqual(
    __testCodexRolloutScan.resolveCodexObservedModelFromRollout({ codexHomePath: "", threadId: "thr-1" }),
    { model: null, source: null, reason: "reviewer_home_not_isolated" },
  );
  const source = readFileSync(repoPath(".devpro/scripts/run-second-reviewer-projection.mjs"), "utf8");
  const start = source.indexOf("function resolveCodexObservedModelFromRollout");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "resolveCodexObservedModelFromRollout() source slice must be locatable");
  assert.doesNotMatch(
    source.slice(start, end),
    /homedir\(/,
    "resolveCodexObservedModelFromRollout MUST NOT call homedir() on the degrade path (D5 MUST NOT)",
  );
});

// T8 — the four independent hard scan-budget caps (design.md D5). Each MUST
// stop the scan and return unavailable with rollout_scan_budget_exceeded
// rather than a partial result.
test("execution-stream reviewer-model: Codex rollout scan over-budget cases each fail unavailable with rollout_scan_budget_exceeded", () => {
  withTempDir("second-review-runner-codex-rollout-budget-entries-", (dir) => {
    const codexHomePath = path.join(dir, "codex-home");
    const dayDir = codexRolloutDayDir(codexHomePath);
    for (let index = 0; index < __testCodexRolloutScan.MAX_ENTRIES_PER_LEVEL + 1; index += 1) {
      writeFileSync(path.join(dayDir, `decoy-${index}.jsonl`), "\n", "utf8");
    }
    assert.deepEqual(
      __testCodexRolloutScan.resolveCodexObservedModelFromRollout({ codexHomePath, threadId: "thr-1" }),
      { model: null, source: null, reason: "rollout_scan_budget_exceeded" },
    );
  });

  withTempDir("second-review-runner-codex-rollout-budget-files-", (dir) => {
    const codexHomePath = path.join(dir, "codex-home");
    const dayDir = codexRolloutDayDir(codexHomePath);
    for (let index = 0; index < __testCodexRolloutScan.MAX_CANDIDATE_FILES + 1; index += 1) {
      writeFileSync(path.join(dayDir, `rollout-2026-01-15T00-0${index}-00-thr-1.jsonl`), "\n", "utf8");
    }
    assert.deepEqual(
      __testCodexRolloutScan.resolveCodexObservedModelFromRollout({ codexHomePath, threadId: "thr-1" }),
      { model: null, source: null, reason: "rollout_scan_budget_exceeded" },
    );
  });

  withTempDir("second-review-runner-codex-rollout-budget-bytes-", (dir) => {
    const codexHomePath = path.join(dir, "codex-home");
    const dayDir = codexRolloutDayDir(codexHomePath);
    const oversizedLine = `${JSON.stringify({ type: "turn_context", payload: { model: "x".repeat(64) } })}\n`;
    const repeats = Math.ceil((__testCodexRolloutScan.MAX_TOTAL_BYTES + 1) / oversizedLine.length);
    writeFileSync(
      path.join(dayDir, "rollout-2026-01-15T00-00-00-thr-1.jsonl"),
      oversizedLine.repeat(repeats),
      "utf8",
    );
    assert.deepEqual(
      __testCodexRolloutScan.resolveCodexObservedModelFromRollout({ codexHomePath, threadId: "thr-1" }),
      { model: null, source: null, reason: "rollout_scan_budget_exceeded" },
    );
  });

  // Global list-call ceiling: many shallow day dirs stay under per-level caps
  // but still trip MAX_LIST_CALLS (sessions + year + month + N days).
  withTempDir("second-review-runner-codex-rollout-budget-list-calls-", (dir) => {
    const codexHomePath = path.join(dir, "codex-home");
    const sessionsRoot = path.join(codexHomePath, "sessions", "2026", "01");
    mkdirSync(sessionsRoot, { recursive: true });
    // listCalls = 1 (sessions) + 1 (year) + 1 (month) + N (days). Need N so total > MAX.
    const dayCount = __testCodexRolloutScan.MAX_LIST_CALLS;
    for (let index = 1; index <= dayCount; index += 1) {
      const dayDir = path.join(sessionsRoot, String(index).padStart(2, "0"));
      mkdirSync(dayDir, { recursive: true });
      writeFileSync(path.join(dayDir, "decoy.txt"), "\n", "utf8");
    }
    assert.deepEqual(
      __testCodexRolloutScan.resolveCodexObservedModelFromRollout({ codexHomePath, threadId: "thr-1" }),
      { model: null, source: null, reason: "rollout_scan_budget_exceeded" },
    );
  });
});

test("execution-stream reviewer-model: verified pr-sticky PATCHes footer Model to stream identity", () => {
  withTempDir("second-review-runner-stream-model-sticky-patch-", (dir) => {
    const binDir = path.join(dir, "bin");
    const ghLog = path.join(dir, "gh.log");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const stickyUrl = "https://github.com/devpro/example/pull/1658#issuecomment-4242";
    const terminal = claudeMismatchResultEvent({
      sticky_comment_url: stickyUrl,
      last_reviewed_sha: context.head_ref_oid,
    });
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      DEVPRO_FAKE_GH_LOG: ghLog,
      DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponse(
        "PASS",
        context.dispatch_id,
        "Claude Code",
        SELF_REPORT_MODEL,
      ),
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: terminal.type,
        subtype: terminal.subtype,
        is_error: terminal.is_error,
        modelUsage: terminal.modelUsage,
        result: terminal.result,
      }),
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "finished");
    assert.notEqual(output.classification, "reviewer_completion_contract_invalid");
    assert.notEqual(output.classification, "sticky_contract_invalid");
    assert.equal(output.sticky.status, "verified");
    assert.equal(output.sticky.reviewer_model, STREAM_MODEL);
    const ghCommands = readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(
      ghCommands.some((line) => (
        /(?:^|\s)-X\s+PATCH\b|--method\s+PATCH\b/.test(line)
        && line.includes("repos/devpro/example/issues/comments/4242")
      )),
      `verified mismatch must quiet-PATCH the same comment: ${JSON.stringify(ghCommands)}`,
    );
    const receipt = completionReceiptForContext(context);
    assert.equal(receipt?.record.schema, "devpro-second-review-completion/v2");
    assert.equal(Object.hasOwn(receipt.record, "reviewer_model"), false);
    const parsed = persistedClaudeReviewerModel(
      claudeClassificationContext({
        mode: "pr-sticky",
        head_ref_oid: context.head_ref_oid,
      }),
      terminal,
    );
    assert.equal(parsed.status, "accepted");
    assert.equal(parsed.completion.reviewer_model, STREAM_MODEL);
  });
});

test("execution-stream reviewer-model: placeholder sticky stays invalid and is not PATCHed from stream", () => {
  withTempDir("second-review-runner-stream-model-placeholder-sticky-", (dir) => {
    const binDir = path.join(dir, "bin");
    const ghLog = path.join(dir, "gh.log");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const stickyUrl = "https://github.com/devpro/example/pull/1658#issuecomment-4242";
    const terminal = claudeMismatchResultEvent({
      sticky_comment_url: stickyUrl,
      last_reviewed_sha: context.head_ref_oid,
    });
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      DEVPRO_FAKE_GH_LOG: ghLog,
      DEVPRO_FAKE_GH_RESPONSE: currentHeadStickyResponse(
        "PASS",
        context.dispatch_id,
        "Claude Code",
        "<actual-model>",
      ),
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: terminal.type,
        subtype: terminal.subtype,
        is_error: terminal.is_error,
        modelUsage: terminal.modelUsage,
        result: terminal.result,
      }),
    });

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.sticky.status, "failed");
    assert.equal(output.sticky.classification, "sticky_contract_invalid");
    const activity = readFileSync(context.activity_log_path, "utf8");
    assert.match(activity, /sticky_reviewer_model_invalid/);
    const ghCommands = readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(
      ghCommands.some((line) => /(?:^|\s)-X\s+PATCH\b|--method\s+PATCH\b/.test(line)),
      false,
      "placeholder sticky must not be repaired from stream",
    );
  });
});

test("sticky PATCH snapshot: concurrent comment change after verify GET must abort and keep store B", () => {
  withTempDir("second-review-runner-sticky-patch-toctou-", (dir) => {
    const binDir = path.join(dir, "bin");
    const ghLog = path.join(dir, "gh.log");
    const commentStore = path.join(dir, "comment-store.json");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    writeFakeGh(binDir);
    const { context } = renderHandoff(dir, prStickyHandoff);
    const snapshotA = JSON.parse(
      currentHeadStickyResponse("PASS", context.dispatch_id, "Claude Code", SELF_REPORT_MODEL),
    ).comments[0];
    snapshotA.updated_at = "2026-08-18T10:00:00Z";
    const snapshotB = {
      ...snapshotA,
      updated_at: "2026-08-18T10:00:01Z",
      body: snapshotA.body.replace(
        "Bounded review reached a current-head gate verdict.",
        "Concurrent writer replaced the sticky body.",
      ),
    };
    const listPayload = JSON.parse(currentHeadStickyResponseWithBody(snapshotA.body));
    listPayload.comments[0].updated_at = snapshotA.updated_at;
    const listResponse = JSON.stringify(listPayload);
    const stickyUrl = "https://github.com/devpro/example/pull/1658#issuecomment-4242";
    const terminal = claudeMismatchResultEvent({
      sticky_comment_url: stickyUrl,
      last_reviewed_sha: context.head_ref_oid,
    });
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["Bash","StructuredOutput","Write"]',
      DEVPRO_FAKE_GH_LOG: ghLog,
      DEVPRO_FAKE_GH_RESPONSE: listResponse,
      DEVPRO_FAKE_GH_EXACT_COMMENT_RESPONSE: JSON.stringify(snapshotA),
      DEVPRO_FAKE_GH_EXACT_COMMENT_STALE_RESPONSE: JSON.stringify(snapshotB),
      DEVPRO_FAKE_GH_EXACT_COMMENT_ETAG: "snap1",
      DEVPRO_FAKE_GH_EXACT_COMMENT_STALE_ETAG: "snap2",
      DEVPRO_FAKE_GH_COMMENT_STORE: commentStore,
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: terminal.type,
        subtype: terminal.subtype,
        is_error: terminal.is_error,
        modelUsage: terminal.modelUsage,
        result: terminal.result,
      }),
    });

    const output = JSON.parse(result.stdout);
    assert.notEqual(
      output.sticky?.classification,
      "sticky_verified",
      "stale snapshot must not verify after a concurrent rewrite",
    );
    assert.equal(output.sticky?.classification, "sticky_patch_snapshot_stale");
    const stored = JSON.parse(readFileSync(commentStore, "utf8"));
    assert.equal(stored.comment.body, snapshotB.body, "store must remain concurrent body B");
    assert.notEqual(stored.comment.body, snapshotA.body);
    const ghCommands = existsSync(ghLog)
      ? readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean)
      : [];
    assert.equal(
      ghCommands.some((line) => /(?:^|\s)-X\s+PATCH\b|--method\s+PATCH\b/.test(line)),
      false,
      `stale last-look must not PATCH: ${JSON.stringify(ghCommands)}`,
    );
  });
});

test("reviewer line router: signature carrier bound is exported and enforced (1 MiB cap)", () => {
  assert.equal(__testReviewerOutput.maxSignatureLineBytes, 1024 * 1024);
  const makeSignatureLine = (targetBytes) => {
    const envelope = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "" } },
      session_id: "session-test",
      parent_tool_use_id: null,
      uuid: "uuid-test",
    };
    const line = JSON.stringify(envelope);
    const baseBytes = Buffer.byteLength(line, "utf8");
    const payload = "x".repeat(Math.max(0, targetBytes - baseBytes));
    envelope.event.delta.signature = payload;
    return JSON.stringify(envelope);
  };
  const collect = (line) => {
    const lines = [];
    const overflows = [];
    const discards = [];
    __testReviewerOutput.createReviewerOutputLineRouter({
      reviewerFamily: "claude",
      stream: "stdout",
      onLine: (v) => lines.push(v),
      onOverflow: (o) => overflows.push(o),
      onDiscard: (m) => discards.push(m),
    }).write(Buffer.from(line + "\n", "utf8"));
    return { lines, overflows, discards };
  };
  const atCap = collect(makeSignatureLine(1024 * 1024));
  assert.deepEqual(atCap.overflows, []);
  assert.deepEqual(atCap.lines, []);
  assert.deepEqual(atCap.discards, [{
    event_class: "stream_event_signature_delta",
    byte_length: 1024 * 1024,
    hard_cap_bytes: 1024 * 1024,
  }]);
  const overCap = collect(makeSignatureLine((1024 * 1024) + 1));
  assert.deepEqual(overCap.overflows, [{ maxBytes: 1024 * 1024 }]);
  assert.deepEqual(overCap.discards, []);

  assert.equal(__testReviewerOutput.maxThinkingLineBytes, 1024 * 1024);
  const makeThinkingLine = (targetBytes) => {
    const envelope = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
      session_id: "session-test",
      parent_tool_use_id: null,
      uuid: "uuid-test",
    };
    const line = JSON.stringify(envelope);
    const baseBytes = Buffer.byteLength(line, "utf8");
    const payload = "x".repeat(Math.max(0, targetBytes - baseBytes));
    envelope.event.delta.thinking = payload;
    return JSON.stringify(envelope);
  };
  const thinkingAtCap = collect(makeThinkingLine(1024 * 1024));
  assert.deepEqual(thinkingAtCap.overflows, []);
  assert.deepEqual(thinkingAtCap.lines, []);
  assert.deepEqual(thinkingAtCap.discards, [{
    event_class: "stream_event_thinking_delta",
    byte_length: 1024 * 1024,
    hard_cap_bytes: 1024 * 1024,
  }]);
  const thinkingOverCap = collect(makeThinkingLine((1024 * 1024) + 1));
  assert.deepEqual(thinkingOverCap.overflows, [{ maxBytes: 1024 * 1024 }]);
  assert.deepEqual(thinkingOverCap.discards, []);
});

// D7 (T4, R7) — external-evaluator dispatches must be typed-rejected before attempt lock,
// child spawn, invocation claim, or terminal/completion receipts. T3 (renderer) has not
// landed yet, so this simulates the external context shape D1 promises by mutating a
// renderer-produced runner context rather than actually rendering an external ticket.
test("run-second-reviewer-projection rejects external-evaluator dispatch before any mutation (D7)", () => {
  withTempDir("second-review-runner-external-evaluator-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const identityLog = path.join(dir, "executable-identity.log");
    const { context, contextPath } = renderHandoff(dir, prStickyHandoff);
    const activityBefore = readFileSync(context.activity_log_path, "utf8");

    // D1's dispatch record identity gate (authorizeSecondReviewPacketFile, already
    // landed by T1/T2) structurally validates every external field once executor_kind is
    // present, regardless of D7 — so the fixture must be a shape-valid external record,
    // not just the three D7-relevant fields, or the run fails earlier with
    // reviewer_dispatch_identity_collision instead of exercising this typed exit.
    context.executor_kind = "external-evaluator";
    // reviewer_family MUST stay whatever the renderer already set (packet-embedded
    // review data's reviewer_family is compared for an exact match by the D1 dispatch
    // identity gate, independent of D7).
    context.primary_family = context.primary_family ?? "openai-codex";
    context.reviewer_tool = "Claude Code";
    context.sticky_write_action = "create";
    context.sticky_target_comment_id = null;
    context.sticky_snapshot_digest = "a".repeat(64);
    context.issued_at = new Date().toISOString();
    context.reviewer_cli_recipe = null;
    context.projection_runner_command = null;
    context.required_activity_events = ["packet_rendered", "external_evaluator_ticket_issued"];
    writeFileSync(contextPath, JSON.stringify(context), "utf8");

    const result = spawnSync(process.execPath, [runnerScript, contextPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
        DEVPRO_FAKE_EXECUTABLE_IDENTITY_LOG: identityLog,
      },
    });

    assert.equal(result.status, 1, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "blocked");
    assert.equal(stdout.classification, "external_evaluator_dispatch_not_runnable");
    assert.equal(existsSync(`${contextPath}.attempt.lock`), false, "no attempt lock");
    assert.equal(
      existsSync(identityLog),
      false,
      "external context must never spawn the reviewer executable"
    );
    assert.equal(
      existsSync(path.join(context.control_evidence_root, context.dispatch_id, "invocation-claim.json")),
      false,
      "no invocation claim"
    );
    assert.equal(terminalReceiptForContext(context), null, "no terminal receipt");
    assert.equal(completionReceiptForContext(context), null, "no completion receipt");
    assert.equal(
      readFileSync(context.activity_log_path, "utf8"),
      activityBefore,
      "activity log bytes must be unchanged"
    );
  });
});

// ── fix-flow-gate-gaps R3: pre-spawn authoritative live-head comparison ────
// Applicability: mode pr-sticky ∧ 40-hex head_ref_oid ∧ carrier has no own
// head comparison (embedded-diff / no review_scope_read_recipe). Both blocked
// states are terminal pre-spawn with the existing failure-relation literals
// (family unchanged); audit-only packets never run the probe.

test("fix-flow-gate-gaps R3: pr-sticky embedded head mismatch blocks before reviewer spawn, sticky, or completion", async () => {
  await withTempDirAsync("second-review-runner-live-head-mismatch-", async (dir) => {
    const { context, contextPath } = renderHandoff(dir, prStickyHandoff);
    let liveHeadCalls = 0;
    let reviewerProbeCalls = 0;
    const liveHead = "d".repeat(40);

    const result = await runProjection(contextPath, {
      executableDiscoveryOptions: trustedReviewerExecutableDiscoveryOptions,
      stickyDispositionOptions: verifiedEmptyStickyDispositionOptions,
      liveHeadProbeOptions: {
        spawnSync(executable, argv, options) {
          liveHeadCalls += 1;
          assert.equal(executable, "gh");
          assert.deepEqual(argv, [
            "pr",
            "view",
            String(prStickyScope.pull_request_number),
            "--repo",
            prStickyHandoff.repository_slug,
            "--json",
            "headRefOid",
          ]);
          assert.equal(options.env.GH_REPO, prStickyHandoff.repository_slug);
          assert.equal(options.timeout, 30000, "bounded gh read must reuse the sticky-verifier timeout convention");
          return { status: 0, stdout: JSON.stringify({ headRefOid: liveHead }), stderr: "" };
        },
      },
      probeOptions: {
        runCommand() {
          reviewerProbeCalls += 1;
          throw new Error("stale head must stop before reviewer CLI probing");
        },
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "review_material_scope_unresolvable");
    assert.equal(result.failure_relation, "resolved_pr_or_head_mismatch");
    assert.equal(liveHeadCalls, 1);
    assert.equal(reviewerProbeCalls, 0);
    assert.match(result.reason, new RegExp(prStickyHeadSha), "reason must name the packet head");
    assert.match(result.reason, new RegExp(liveHead), "reason must name the live head");
    assert.match(result.reason, /push[\s\S]{0,80}render/, "reason must name the push-then-render next step");
    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal?.record.classification, "review_material_scope_unresolvable");
    assert.equal(terminal?.record.process_spawned, false);
    const evidenceDir = path.join(context.control_evidence_root, context.dispatch_id);
    assert.equal(existsSync(path.join(evidenceDir, "invocation-claim.json")), false);
    assert.equal(existsSync(path.join(evidenceDir, "completion.json")), false);
    assert.equal(
      existsSync(path.join(path.dirname(context.observability_context_path), "sticky-write-result.json")),
      false,
      "no sticky write may happen for a blocked pre-spawn dispatch",
    );
    const events = activityEvents(context.activity_log_path);
    assert.ok(events.includes("projection_cli_blocked_before_start"));
    assert.equal(events.some((event) => event.startsWith("projection_sticky_")), false);
    assert.equal(events.includes("projection_cli_starting"), false);
    assert.equal(existsSync(`${contextPath}.attempt.lock`), false);
  });
});

test("fix-flow-gate-gaps R3/F-r2-01: unresolvable live PR head is terminal with probe-fault naming (not skip, not mismatch)", async () => {
  await withTempDirAsync("second-review-runner-live-head-unavailable-", async (dir) => {
    const { context, contextPath } = renderHandoff(dir, prStickyHandoff);
    let reviewerProbeCalls = 0;

    const result = await runProjection(contextPath, {
      executableDiscoveryOptions: trustedReviewerExecutableDiscoveryOptions,
      stickyDispositionOptions: verifiedEmptyStickyDispositionOptions,
      liveHeadProbeOptions: {
        spawnSync() {
          return { status: 1, stdout: "", stderr: "gh: authentication required" };
        },
      },
      probeOptions: {
        runCommand() {
          reviewerProbeCalls += 1;
          throw new Error("unavailable head probe must stop before reviewer CLI probing");
        },
      },
    });

    // F-r2-01 pinned naming: `pr-sticky ∧ head 40-hex ∧ PR 不可解析` is
    // TERMINAL pre-spawn (probe-fault family), never a silent skip and never
    // reported as a head mismatch.
    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "review_material_scope_unresolvable");
    assert.equal(result.failure_relation, "probe_result_not_exclusively_publishable");
    assert.notEqual(result.failure_relation, "resolved_pr_or_head_mismatch");
    assert.match(result.reason, /probe 不可用/);
    assert.match(result.reason, /非 head mismatch/);
    assert.match(result.reason, /gh\/auth\/PR|auth/, "reason must name the repair surface");
    assert.equal(reviewerProbeCalls, 0);
    const terminal = terminalReceiptForContext(context);
    assert.equal(terminal?.record.process_spawned, false);
    assert.equal(terminal?.record.classification, "review_material_scope_unresolvable");
    const evidenceDir = path.join(context.control_evidence_root, context.dispatch_id);
    assert.equal(existsSync(path.join(evidenceDir, "invocation-claim.json")), false);
    assert.equal(existsSync(path.join(evidenceDir, "completion.json")), false);
    const events = activityEvents(context.activity_log_path);
    assert.ok(events.includes("projection_cli_blocked_before_start"));
    assert.equal(events.some((event) => event.startsWith("projection_sticky_")), false);
  });
});

test("fix-flow-gate-gaps R3: audit-only shape (head_ref_oid none) never runs the live-head probe", async () => {
  await withTempDirAsync("second-review-runner-live-head-audit-skip-", async (dir) => {
    const { context, contextPath } = renderHandoff(dir, auditHandoff);
    let liveHeadCalls = 0;
    let reviewerProbeCalls = 0;

    const result = await runProjection(contextPath, {
      executableDiscoveryOptions: trustedReviewerExecutableDiscoveryOptions,
      liveHeadProbeOptions: {
        spawnSync() {
          liveHeadCalls += 1;
          throw new Error("audit-only packets must never run the live-head probe");
        },
      },
      probeOptions: {
        runCommand(command) {
          reviewerProbeCalls += 1;
          return {
            command,
            args: [],
            status: 1,
            signal: null,
            error: null,
            error_code: null,
            stdout: "",
            stderr: "reviewer unavailable after audit-only live-head skip",
          };
        },
      },
    });

    assert.equal(liveHeadCalls, 0);
    assert.ok(reviewerProbeCalls > 0, "audit-only dispatch must proceed to the reviewer CLI probe");
    assert.equal(result.classification, "probe_evidence_unavailable");
  });
});

test("fix-flow-gate-gaps R3: same live head stays a no-op and proceeds to the reviewer CLI probe", async () => {
  await withTempDirAsync("second-review-runner-live-head-same-", async (dir) => {
    const { context, contextPath } = renderHandoff(dir, prStickyHandoff);
    let liveHeadCalls = 0;
    let reviewerProbeCalls = 0;

    const result = await runProjection(contextPath, {
      executableDiscoveryOptions: trustedReviewerExecutableDiscoveryOptions,
      stickyDispositionOptions: verifiedEmptyStickyDispositionOptions,
      liveHeadProbeOptions: {
        spawnSync() {
          liveHeadCalls += 1;
          return { status: 0, stdout: JSON.stringify({ headRefOid: prStickyHeadSha }), stderr: "" };
        },
      },
      probeOptions: {
        runCommand(command) {
          reviewerProbeCalls += 1;
          return {
            command,
            args: [],
            status: 1,
            signal: null,
            error: null,
            error_code: null,
            stdout: "",
            stderr: "reviewer unavailable after same-head regression",
          };
        },
      },
    });

    assert.equal(liveHeadCalls, 1);
    assert.ok(reviewerProbeCalls > 0, "matching live head must not block the reviewer CLI probe");
    assert.equal(result.classification, "probe_evidence_unavailable");
  });
});

test("Scenario: Post-files gh pr view head drift fails closed as resolved_pr_or_head_mismatch", () => {
  withTempDir("second-review-runner-full-pr-head-after-drift-", (dir) => {
    const { context } = renderHandoff(dir, liveFullPrHandoff);
    const reviewData = parseCanonicalSecondReviewPacketData(readFileSync(context.packet_path));
    rmSync(context.review_scope_probe_result_path, { force: true });
    let headCalls = 0;
    const driftedHead = "e".repeat(40);
    const result = runReviewScopeProbe(context, reviewData, {
      spawnSync: fullPrScopeProbeSpawnSync({
        headResult({ headCalls: n }) {
          headCalls = n;
          const headRefOid = n === 1 ? prStickyScope.head_sha : driftedHead;
          return {
            status: 0,
            stdout: JSON.stringify({
              number: prStickyScope.pull_request_number,
              headRefOid,
              changedFiles: 2,
            }),
            stderr: "",
          };
        },
      }),
    });
    assert.equal(headCalls, 2, "probe must re-bind head after files list");
    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "review_material_scope_unresolvable");
    assert.equal(result.failure_relation, "resolved_pr_or_head_mismatch");
  });
});


test("Scenario: Post-files gh pr view changedFiles drift fails closed as resolved_pr_or_head_mismatch", () => {
  withTempDir("second-review-runner-full-pr-changed-files-after-drift-", (dir) => {
    const { context } = renderHandoff(dir, liveFullPrHandoff);
    const reviewData = parseCanonicalSecondReviewPacketData(readFileSync(context.packet_path));
    rmSync(context.review_scope_probe_result_path, { force: true });
    const result = runReviewScopeProbe(context, reviewData, {
      spawnSync: fullPrScopeProbeSpawnSync({
        headOverrides: { changedFiles: 2 },
        headAfterOverrides: { changedFiles: 3 },
      }),
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "review_material_scope_unresolvable");
    assert.equal(result.failure_relation, "resolved_pr_or_head_mismatch");
  });
});

// T13/T14b (design.md D12/D13; tasks.md items 12/13) — reviewer-model-record.

// D13 (r2 table): pure judgment-function unit coverage, matching the design
// doc's five relative cases (a)-(e). requestedKind is passed exactly as D1's
// resolver would compute it (never re-derived from family here, same as the
// production caller).
test("Identical requested and observed models yield exact agreement", () => {
  assert.equal(
    __testReviewerClassification.deriveReviewerModelAgreement({
      requestedModel: "gpt-5.6-sol",
      requestedKind: "exact-id",
      observedModel: "gpt-5.6-sol",
    }),
    "exact",
  );
  assert.equal(
    __testReviewerClassification.deriveReviewerModelAgreement({
      requestedModel: "claude-opus-5",
      requestedKind: "alias",
      observedModel: "claude-opus-5",
    }),
    "exact",
  );
});

test("A replaced exact-id default yields divergent agreement", () => {
  // (a): codex built-in default (exact-id) replaced by a different observed —
  // the alarm case (design.md D13: a repo-declared, already-verified default
  // silently swapped out).
  assert.equal(
    __testReviewerClassification.deriveReviewerModelAgreement({
      requestedModel: SECOND_REVIEWER_MODEL_DEFAULTS.codex.model,
      requestedKind: SECOND_REVIEWER_MODEL_DEFAULTS.codex.kind,
      observedModel: "gpt-7-preview",
    }),
    "divergent",
  );
  assert.equal(SECOND_REVIEWER_MODEL_DEFAULTS.codex.kind, "exact-id");
});

test("A probed Claude exact identity changing is divergent", () => {
  assert.equal(__testReviewerClassification.deriveReviewerModelAgreement({
    requestedModel: modelProbeEvidence.claude.selected_model, requestedKind: "exact-id",
    observedModel: "claude-other-model",
  }), "divergent");
});

test("A differing override yields differs-unverified agreement", () => {
  // (c): any family, operator-supplied override (kind "unknown") whose
  // observed differs — MUST NOT be divergent (we never proved the override's
  // shape is a verified exact-id).
  for (const family of ["claude", "codex"]) {
    assert.equal(
      __testReviewerClassification.deriveReviewerModelAgreement({
        requestedModel: "operator-custom-model",
        requestedKind: "unknown",
        observedModel: `${family}-actually-ran-this`,
      }),
      "differs-unverified",
      family,
    );
  }
});

test("Unobtainable observed model yields unavailable agreement with a named reason", () => {
  // (e): observed unavailable short-circuits ahead of every other branch,
  // regardless of requestedKind.
  for (const requestedKind of ["exact-id", "alias", "unknown"]) {
    assert.equal(
      __testReviewerClassification.deriveReviewerModelAgreement({
        requestedModel: "opus",
        requestedKind,
        observedModel: null,
      }),
      "unavailable",
      requestedKind,
    );
  }
  // The named reason itself comes from resolveReviewerObservedIdentity(), not
  // deriveReviewerModelAgreement() — covered end to end by the codex
  // rollout_not_found/rollout_unparsable/reviewer_home_not_isolated/
  // rollout_scan_budget_exceeded tests above and the claude stream_identity_absent
  // tests earlier in this file; deriveReviewerModelAgreement() itself never
  // sees or needs the reason token (D12's schema keeps agreement and
  // observed_unavailable_reason as two separate fields for a reason).
  const identity = __testReviewerClassification.resolveReviewerObservedIdentity(
    boundedEvidenceForClassification({ stdoutStructuredEvents: [] }),
    { tool: "claude" },
  );
  assert.equal(identity.model, null);
  assert.equal(identity.reason, "stream_identity_absent");
});

test("Completion receipt implies a dispatch record for post-contract dispatches", () => {
  withTempDir("second-review-runner-model-record-inv-mr-", (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir, auditHandoff);
    assert.deepEqual(context.reviewer_model_selection, {
      requested: modelProbeEvidence.claude.selected_model,
      source: "built-in-default",
      env_var: null,
      probe: modelProbeEvidence.claude,
    });
    const observedModel = "claude-opus-5";
    const result = runGeneratedRunnerCommand(context, binDir, {
      DEVPRO_FAKE_REVIEWER_INIT_EVENT: JSON.stringify({
        type: "system",
        subtype: "init",
        tools: ["StructuredOutput"],
        model: observedModel,
      }),
      DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          sticky_comment_url: "none",
          verdict: "PASS",
          last_reviewed_sha: "none",
          reviewer_model: CODEX_SELF_REPORT_MODEL,
          reason: "No blocking findings.",
        }),
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "reviewer_cli_completed");

    const completion = completionReceiptForContext(context);
    assert.ok(completion, "INV-MR premise: this dispatch must have a completion receipt");
    const record = reviewerModelRecordForContext(context);
    assert.ok(record, "INV-MR: a dispatch whose completion receipt the runner sealed for a reviewer process it actually spawned MUST have a reviewer-model-record");
    assert.equal(record.record.schema, "devpro-second-review-reviewer-model/v1");
    assert.equal(record.record.dispatch_id, completion.record.dispatch_id);
    assert.equal(record.record.attempt_id, completion.record.attempt_id);
    // The CLI recipe family, not the declared family: `dispatch.json` keeps
    // `reviewer_family` for the declared one (r3 finding F-srms-pr3-04).
    assert.equal(record.record.reviewer_cli_family, "claude");
    assert.equal(Object.hasOwn(record.record, "reviewer_family"), false);
    assert.equal(record.record.requested_model, modelProbeEvidence.claude.selected_model);
    assert.equal(record.record.requested_source, "built-in-default");
    assert.equal(record.record.requested_source_env_var, "none");
    assert.equal(record.record.requested_kind, "exact-id");
    assert.equal(record.record.observed_model, observedModel);
    assert.equal(record.record.observed_source, "execution-stream");
    assert.equal(record.record.observed_unavailable_reason, "none");
    assert.equal(record.record.agreement, "divergent");

    // Item 12(a): single call site, strictly before every receipt-sealing
    // call site it must precede. Scoped to the runProjection() dispatch
    // flow body (not the whole file), since writeCompletionReceipt/
    // persistClosedTerminalReceipt/teardownReviewerHome also have their
    // own function definitions and unrelated call sites elsewhere (e.g.
    // reconcileClosedTransport()'s teardown, per D12's explicit exception)
    // that this invariant is not about.
    const fullSource = readFileSync(repoPath(".devpro/scripts/run-second-reviewer-projection.mjs"), "utf8");
    const runProjectionStart = fullSource.indexOf("export async function runProjection(");
    assert.ok(runProjectionStart >= 0, "runProjection( function definition must exist");
    const nextTopLevelDeclMatch = fullSource
      .slice(runProjectionStart + 1)
      .match(/\n(export |async function |function |class )/);
    assert.ok(nextTopLevelDeclMatch, "runProjection( body must be followed by another top-level declaration");
    const runProjectionEnd = runProjectionStart + 1 + nextTopLevelDeclMatch.index;
    // Single-call-site uniqueness is checked over the WHOLE runProjection()
    // body (r1 finding F-srms-pr-03): scoping it to the post-spawn-gate slice
    // would let a second writeReviewerModelRecord( added before the gate pass
    // unnoticed.
    const runProjectionSource = fullSource.slice(runProjectionStart, runProjectionEnd);
    const writeCallSites = [...runProjectionSource.matchAll(/\bwriteReviewerModelRecord\(/g)].map((m) => m.index);
    assert.equal(writeCallSites.length, 1, "writeReviewerModelRecord( MUST have exactly one call site in runProjection()");
    // The ORDERING comparison, by contrast, is scoped to the
    // `if (cliResult.process_spawned === true)` branch onward: everything
    // before this anchor belongs to the six pre-spawn terminal paths, which
    // per D12 never reach writeReviewerModelRecord( and are a different flow
    // this invariant is not about.
    const spawnGateAnchor = "if (cliResult.process_spawned === true) {";
    const spawnGateIndex = fullSource.indexOf(spawnGateAnchor, runProjectionStart);
    assert.ok(
      spawnGateIndex >= runProjectionStart && spawnGateIndex < runProjectionEnd,
      "runProjection( must contain the process_spawned===true gate",
    );
    const source = fullSource.slice(spawnGateIndex, runProjectionEnd);
    const postGateWriteCallSites = [...source.matchAll(/\bwriteReviewerModelRecord\(/g)].map((m) => m.index);
    assert.equal(
      postGateWriteCallSites.length,
      1,
      "the single writeReviewerModelRecord( call site MUST sit after the process_spawned===true gate",
    );
    const [writeCallIndex] = postGateWriteCallSites;
    const laterSealingIndices = [
      ...[...source.matchAll(/\bwriteCompletionReceipt\(/g)].map((m) => m.index),
      ...[...source.matchAll(/\bpersistClosedTerminalReceipt\(/g)].map((m) => m.index),
      ...[...source.matchAll(/\bteardownReviewerHome\(/g)].map((m) => m.index),
    ];
    assert.ok(laterSealingIndices.length > 0, "runProjection() must contain at least one sealing call site to compare against");
    for (const index of laterSealingIndices) {
      assert.ok(
        writeCallIndex < index,
        `writeReviewerModelRecord( at index ${writeCallIndex} must precede sealing call at index ${index}`,
      );
    }
  });
});

test("Every non-literal processSpawned terminal receipt call site stays inside a known exception", () => {
  // design.md D12 / tasks.md item 12(b). The durable half of INV-MR: item 12(a)
  // proves the single write point precedes today's sealing calls, but it cannot
  // stop someone adding a NEW post-spawn terminal path somewhere else in the
  // file. A `processSpawned:` argument that is not the literal `false` means the
  // path can run after a spawn, so it must either sit after the spawn gate (and
  // therefore after the write point) or be reconcileClosedTransport(), which
  // per D12 never seals a completion receipt and legitimately has no record.
  const source = readFileSync(
    path.join(REPO_ROOT, ".devpro/scripts/run-second-reviewer-projection.mjs"),
    "utf8"
  );
  const spawnGateIndex = source.indexOf("if (cliResult.process_spawned === true) {");
  const reconcileIndex = source.indexOf("async function reconcileClosedTransport");
  assert.ok(spawnGateIndex > 0, "spawn gate anchor MUST exist");
  assert.ok(reconcileIndex > 0, "reconcileClosedTransport() anchor MUST exist");
  // Bound the exception to the function body (design.md D12), not the unbounded
  // suffix after the declaration. Match the body opening brace after ") {".
  const reconcileBodyOpen = source.indexOf(") {", reconcileIndex);
  assert.ok(reconcileBodyOpen > reconcileIndex, "reconcileClosedTransport() body open MUST exist");
  let reconcileDepth = 0;
  let reconcileEnd = -1;
  for (let i = reconcileBodyOpen + 2; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") reconcileDepth += 1;
    else if (ch === "}") {
      reconcileDepth -= 1;
      if (reconcileDepth === 0) {
        reconcileEnd = i;
        break;
      }
    }
  }
  assert.ok(reconcileEnd > reconcileBodyOpen, "reconcileClosedTransport() body end MUST be brace-matched");

  const offenders = [];
  let sawDefinition = false;
  for (const match of source.matchAll(/persistClosedTerminalReceipt\(\{/g)) {
    const callIndex = match.index;
    // The declaration destructures the same shape; it is not a call site.
    if (/function\s+$/.test(source.slice(Math.max(0, callIndex - 20), callIndex))) {
      sawDefinition = true;
      continue;
    }
    // Read the argument object far enough to reach its processSpawned entry.
    const window = source.slice(callIndex, callIndex + 900);
    const arg = window.match(/processSpawned:\s*([^,\n]+)/);
    assert.ok(arg, `call site at offset ${callIndex} MUST pass processSpawned`);
    if (arg[1].trim() === "false") continue;
    const insidePostGate = callIndex > spawnGateIndex && callIndex < reconcileIndex;
    const insideReconcile = callIndex > reconcileBodyOpen && callIndex < reconcileEnd;
    if (!insidePostGate && !insideReconcile) {
      offenders.push({ offset: callIndex, processSpawned: arg[1].trim() });
    }
  }

  // Guard the guard: if the declaration anchor ever stops matching, the loop
  // above would silently inspect nothing meaningful and pass vacuously.
  assert.ok(sawDefinition, "the persistClosedTerminalReceipt declaration MUST still be recognizable");

  assert.deepEqual(
    offenders,
    [],
    "a persistClosedTerminalReceipt( call with a non-literal processSpawned argument appeared outside the post-spawn-gate region and outside reconcileClosedTransport(); it would seal a terminal receipt after a spawn without a reviewer-model-record, breaking INV-MR"
  );
});

test("Pre-spawn terminal path produces no dispatch record", async () => {
  await withTempDirAsync("second-review-runner-model-record-pre-spawn-", async (dir) => {
    const emptyBinDir = path.join(dir, "empty-bin");
    mkdirSync(emptyBinDir, { recursive: true });
    // No fake claude executable anywhere on the resolver's search path: reviewer
    // discovery fails before any spawn (tool_discovery_blocked), one of the six
    // pre-spawn terminal paths (design.md D12) that seal a terminal receipt with
    // processSpawned: false, before the window loop -- and this write point --
    // ever runs.
    const { context, contextPath } = renderHandoff(dir, auditHandoff);
    const result = await runProjection(contextPath, {
      executableDiscoveryOptions: { pathValue: emptyBinDir },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "tool_discovery_blocked");
    const terminal = terminalReceiptForContext(context);
    assert.ok(terminal, "a pre-spawn block still seals a terminal receipt");
    assert.equal(terminal.record.process_spawned, false);
    assert.equal(reviewerModelRecordForContext(context), null);
  });
});

for (const scenario of ["modern", "builder-failure", "writer-failure", "extractor-failure", "pending-fault"]) {
  test(`USAGE-FAIL-OPEN: ordinary single-window ${scenario}`, async () => {
    await withTempDirAsync("usage-single-window-", async dir => {
      const { context, contextPath } = renderHandoff(dir, auditHandoff);
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir);
      writeFakeClaude(binDir);
      const sessionId = "33333333-3333-3333-3333-333333333333";
      const result = await runProjection(contextPath, {
        executableDiscoveryOptions: { pathValue: binDir },
        ...(scenario === "builder-failure" ? { usageManifestBuilder() { throw new Error("synthetic usage builder failure"); } } : {}),
        ...(scenario === "writer-failure" ? { usageManifestWriter() { throw new Error("synthetic usage writer failure"); } } : {}),
        ...(scenario === "extractor-failure" ? { usageManifestSessionExtractor() { throw new Error("synthetic usage extractor failure"); } } : {}),
        ...(scenario === "pending-fault" ? { usageManifestSessionExtractor() { rmSync(context.stdout_log_path); return { session_id: sessionId }; } } : {}),
        env: { ...process.env, DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root, DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: JSON.stringify({ type: "result", subtype: "success", is_error: false,
          session_id: sessionId, result: JSON.stringify({ sticky_comment_url: "none", verdict: "PASS", last_reviewed_sha: "none", reviewer_model: "claude-test", reason: "No blocking findings." }) }) },
      });
      if (scenario === "pending-fault") {
        assert.equal(result.classification, "reviewer_cli_runner_error", "fault after CLI return exercises pending-window finalization");
        assert.match(result.error, /ENOENT/);
      }
      else {
        assert.equal(result.classification, "reviewer_cli_completed");
        assert.equal(result.status, "finished");
      }
      const events = readFileSync(context.activity_log_path, "utf8").trim().split("\n").map(JSON.parse);
      assert.ok(events.some(event => event.event === "projection_attempt_lock_released"));
      if (scenario === "builder-failure" || scenario === "writer-failure") {
        assert.ok(events.some(event => event.event === "usage_manifest_write_failed"));
      } else {
        const manifest = JSON.parse(readFileSync(path.join(context.control_evidence_root, context.dispatch_id, "usage-manifest.json"), "utf8"));
        assert.equal(manifest.paged_coverage.planned_window_count, 1);
        assert.deepEqual(manifest.paged_coverage.invoked_windows.map(window => window.index), [1]);
        assert.equal(manifest.sessions.filter(row => row.role === "reviewer").length, scenario === "extractor-failure" ? 0 : 1);
        if (scenario === "modern") {
          const reviewer = manifest.sessions.find(row => row.role === "reviewer");
          assert.equal(reviewer.reviewer_model, "claude-test");
          assert.equal(reviewer.source, "stream-json:result.session_id");
          assert.ok(!Object.hasOwn(reviewer, "usage_snapshot"), "Claude never had a manifest usage snapshot");
        }
        if (scenario === "extractor-failure") assert.ok(manifest.gaps.some(gap => gap.name === "reviewer-window-session-missing"));
      }
    });
  });
}

for (const scenario of ["distinct", "final-unavailable", "early-unavailable", "missing-id", "write-failure", "nonfinal-write-failure"]) {
  test(`PAGED-E2E: unified scan preserves findings and usage coverage (${scenario})`, async () => {
    await withTempDirAsync("paged-runner-terminal-", async (dir) => {
      const handoff = largePrStickyHandoff();
      const rendered = renderHandoff(dir, handoff);
      const { context, contextPath } = rendered;
      assert.ok(context.page_window_count > 2);
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir);
      writeFakeClaude(binDir);
      const receivedPath = path.join(dir, "received-windows.jsonl");
      const ghLog = path.join(dir, "gh-calls.log");
      const authorityGh = path.join(rendered.authorityPath.split(path.delimiter)[0], "gh");
      writeFileSync(path.join(binDir, "gh"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(ghLog)}, args.join(" ") + "\\n");
if (args[0] === "api" && args.some(arg => arg.includes("/issues/1658/comments"))) {
  process.stdout.write(${JSON.stringify(emptyStickyAuthorityApiResponse)});
} else if (args[0] === "pr" && args[1] === "view" && args.includes("headRefOid")) {
  process.stdout.write(JSON.stringify({ headRefOid: ${JSON.stringify(context.head_ref_oid)} }));
} else {
  const result = spawnSync(process.execPath, [${JSON.stringify(authorityGh)}, ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`, { mode: 0o700 });
      const program = path.join(dir, "page-reviewer.mjs");
      writeFileSync(program, `
import { readFileSync, appendFileSync } from "node:fs";
import { SECOND_REVIEW_FRAME_MARKER } from ${JSON.stringify(pathToFileURL(repoPath(".devpro/scripts/validate-second-review-packet.mjs")).href)};
const packet = readFileSync(0);
const lengthStart = packet.indexOf(SECOND_REVIEW_FRAME_MARKER) + Buffer.byteLength(SECOND_REVIEW_FRAME_MARKER);
const headerEnd = packet.indexOf("\\n\\n", lengthStart);
const length = Number(packet.subarray(lengthStart, headerEnd).toString());
const data = JSON.parse(packet.subarray(headerEnd + 2, headerEnd + 2 + length));
const material = data.review_material;
const index = material.pages[0].index;
const final = material.window_role === "final";
const scenario = ${JSON.stringify(scenario)};
const verdict = scenario === "early-unavailable" && index === 2 || scenario === "final-unavailable" && final ? "UNAVAILABLE" : index === 1 || final ? "CRITICAL" : "PASS";
const findings = verdict === "CRITICAL" ? [{ severity: "CRITICAL", summary_id: "critical-" + index, summary: "blocking window " + index }] : [];
appendFileSync(${JSON.stringify(receivedPath)}, JSON.stringify({ index, pages: material.pages.map(page => page.index), covered: material.checkpoint_ledger.covered_indices, findings_windows: material.findings_ledger.windows }) + "\\n");
const completion = {
  dispatch_id: data.dispatch_id, findings, findings_payload_sha256: "runner-seal",
  head_ref_oid: data.head_ref_oid, last_reviewed_sha: data.head_ref_oid,
  page_indices: material.pages.map(page => page.index), reason: "scripted page-window completion",
  reviewer_model: "claude-test", sticky_comment_url: "none", verdict, window_index: index,
};
if (verdict === "PASS" || verdict === "WARN") {
  const report = { schema: "devpro.review-guarantee-assessment/v1", reviewed_target: data.head_ref_oid, dispatch_id: data.dispatch_id, assessments: [] };
  completion.reason += "\\n\\n## Guarantee Assessment\\n" + String.fromCharCode(96).repeat(3) + "json\\n" + JSON.stringify(report) + "\\n" + String.fromCharCode(96).repeat(3);
}
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: scenario === "missing-id" && index === 2 ? undefined : "33333333-3333-3333-3333-" + String(index).padStart(12, "0"), usage: { input_tokens: 100, output_tokens: 10 }, result: JSON.stringify(completion) }));
`);
      const result = await withProcessEnv({ PATH: binDir + path.delimiter + rendered.authorityPath }, () => runProjection(contextPath, {
        cwd: REPO_ROOT,
        execPath: process.execPath,
        executableDiscoveryOptions: { pathValue: binDir },
        scopeProbeOptions: { spawnSync: fullPrScopeProbeSpawnSync() },
        stickyDispositionOptions: verifiedEmptyStickyDispositionOptions,
        usageManifestWriter: ({ rootDir, manifest }) => {
          if (scenario === "write-failure" && manifest.sessions.some(row => row.role === "reviewer" && row.session_id.endsWith(String(context.page_window_count).padStart(12, "0")))) throw new Error("synthetic final window write failure");
          if (scenario === "nonfinal-write-failure" && manifest.sessions.some(row => row.role === "reviewer" && row.session_id.endsWith("000000000002"))) throw new Error("synthetic non-final window write failure");
          return writeUsageManifest({ rootDir, manifest });
        },
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${rendered.authorityPath}`,
          DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
          DEVPRO_FAKE_REVIEWER_PAGE_PROGRAM: program,
          DEVPRO_FAKE_GH_LOG: ghLog,
          DEVPRO_FAKE_GH_API_RESPONSE: emptyStickyAuthorityApiResponse,
        },
      }));
      const interrupted = scenario === "early-unavailable" || scenario === "final-unavailable";
      const gateClassification = scenario === "early-unavailable" ? "page_window_intermediate_blocks_aggregation" : scenario === "final-unavailable" ? "page_window_final_not_authorized" : "page_window_final_critical_sticky_authorized";
      const classification = scenario === "early-unavailable" ? "reviewer_completion_unavailable" : scenario === "final-unavailable" ? gateClassification : "reviewer_completion_critical";
      assert.equal(result.classification, classification, `${JSON.stringify(result)}\n${readFileSync(context.stderr_log_path, "utf8")}`);
      assert.equal(result.sticky.classification, interrupted ? gateClassification : "sticky_missing");
      assert.equal(result.status, "blocked");
      assert.equal(result.cli_exit.process_spawned, true);
      assert.equal(result.cli_exit.process_close_observed, true);
      assert.equal(result.cli_exit.transport_cleanup_confirmed, true);
      const received = readFileSync(receivedPath, "utf8").trim().split("\n").map(JSON.parse);
      const indices = scenario === "early-unavailable" ? [1, 2] : Array.from({ length: context.page_window_count }, (_, i) => i + 1);
      assert.deepEqual(received.map(window => window.index), indices);
      for (const window of received) {
        assert.deepEqual(window.pages, [window.index]);
        assert.deepEqual(window.covered, indices.slice(0, window.index - 1));
        assert.deepEqual(window.findings_windows.map(entry => entry.window_index), indices.slice(0, window.index - 1));
      }
      const events = readFileSync(context.activity_log_path, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(events.some(event => event.event.startsWith("projection_sticky_verification_")), !interrupted);
      const gates = events.filter(event => event.event === "projection_page_window_live_gate");
      assert.equal(gates.length, indices.length);
      assert.ok(gates.slice(0, -1).every(event => event.sticky_authorized === false));
      assert.equal(gates.at(-1).sticky_authorized, !interrupted);
      assert.ok(gates.slice(0, -1).every(event => event.continue_to_next_window === true));
      const final = gates.at(-1);
      assert.equal(final.classification, gateClassification);
      assert.equal(final.scan_complete, !interrupted);
      assert.equal(final.findings_windows, indices.length);
      assert.deepEqual(final.critical_findings.map(entry => [entry.window_index, entry.summary_id]), interrupted ? [[1, "critical-1"]] : [[1, "critical-1"], [indices.length, `critical-${indices.length}`]]);
      const finalContext = JSON.parse(readFileSync(contextPath, "utf8"));
      assert.equal(finalContext.sticky_write_disposition.action, "blocked");
      const heartbeat = JSON.parse(readFileSync(context.heartbeat_path, "utf8"));
      assert.equal(heartbeat.status, "blocked");
      assert.equal(heartbeat.classification, classification);
      assert.deepEqual(heartbeat.cli_exit, result.cli_exit);
      const calls = existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "";
      assert.doesNotMatch(calls, /(?:--method|-X)\s+(?:POST|PATCH)|pr (?:comment|review)/i);
      assert.equal(events.filter(event => event.event === "projection_cli_exited").length, indices.length);
      const manifest = JSON.parse(readFileSync(path.join(context.control_evidence_root, context.dispatch_id, "usage-manifest.json"), "utf8"));
      const capturedIndices = indices.filter(index => !(scenario === "missing-id" && index === 2) && !(scenario === "write-failure" && index === context.page_window_count) && !(scenario === "nonfinal-write-failure" && index === 2));
      assert.deepEqual(manifest.sessions.filter(session => session.role === "reviewer").map(session => session.session_id), capturedIndices.map(index => `33333333-3333-3333-3333-${String(index).padStart(12, "0")}`));
      assert.deepEqual(manifest.paged_coverage.invoked_windows.map(window => window.index), indices);
      assert.equal(manifest.paged_coverage.planned_window_count, context.page_window_count);
      const retained = JSON.parse(readFileSync(path.join(context.control_evidence_root, ".usage-manifest-retention", `${context.dispatch_id}.json`), "utf8"));
      assert.deepEqual(retained, manifest);
      const rollup = rollupManifestUsage({ manifests: [manifest], roots: {}, collectSessionUsage: () => ({ available: true, totals: { input: 100, output: 10, cache_read: 0, cache_creation: null }, gaps: [] }) });
      assert.equal(rollup.coverage_status, scenario === "missing-id" || scenario.endsWith("write-failure") ? "partial" : "complete");
      if (scenario === "missing-id") assert.ok(manifest.gaps.some(gap => gap.name === "reviewer-window-session-missing" && gap.window_index === 2));
      if (scenario.endsWith("write-failure")) {
        const failedIndex = scenario === "nonfinal-write-failure" ? 2 : context.page_window_count;
        assert.ok(manifest.gaps.some(gap => gap.name === "reviewer-window-manifest-write-failed" && gap.window_index === failedIndex));
        assert.ok(manifest.gaps.some(gap => gap.name === "reviewer-window-row-missing" && gap.window_index === failedIndex));
        assert.equal(events.filter(event => event.event === "usage_manifest_write_failed").length, 1);
      }
    });
  });
}

// fix-codex-reconnect-terminal-classification: Codex turn-closing fixtures. Every event is
// synthetic and shape-only (event type order, own key names, JSON type of `message`); the
// sentinel marks notice text that must never be read for classification nor reach the
// runner's activity log, heartbeat, or stdout result.
const codexNoticeSentinel = "SYNTHETIC-NOTICE-SENTINEL-5c1e";
const codexTurnThreadStarted = { type: "thread.started", thread_id: "thr-turn-closing-fixture" };
const codexTurnStarted = { type: "turn.started" };
const codexTurnCompleted = { type: "turn.completed" };
const codexTurnFailed = { type: "turn.failed" };
const codexTurnCommandItems = [
  { type: "item.started", item: { id: "item-cmd", type: "command_execution", status: "in_progress" } },
  { type: "item.completed", item: { id: "item-cmd", type: "command_execution", status: "completed" } },
];

function syntheticBareCodexNotice(message = `placeholder notice ${codexNoticeSentinel}`) {
  return { type: "error", message };
}

function syntheticTypedCodexError(extra) {
  return { type: "error", message: `placeholder typed notice ${codexNoticeSentinel}`, ...extra };
}

function syntheticCodexCompletionEvent(kind) {
  if (kind === null) return null;
  const text = kind === "malformed"
    ? "placeholder text that is not a completion object"
    : JSON.stringify({
      sticky_comment_url: "none",
      verdict: kind,
      last_reviewed_sha: "none",
      reviewer_model: "codex-test",
      reason: "Synthetic reviewer verdict fixture.",
    });
  return { type: "item.completed", item: { id: "item-final", type: "agent_message", text } };
}

function ndjsonText(events) {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

// Stream order: thread.started, turn.started, `middle`, completion (kind PASS|WARN|
// UNAVAILABLE|CRITICAL|malformed, or null for none), `closing`.
function syntheticCodexTurnStream(middle, closing, completionKind = "PASS") {
  return ndjsonText([
    codexTurnThreadStarted,
    codexTurnStarted,
    ...middle,
    ...[syntheticCodexCompletionEvent(completionKind)].filter(Boolean),
    ...closing,
  ]);
}

// File seam: the synthetic stream goes through the formal bounded-tail extraction and the
// formal classifier, so partial-line handling is the production code path.
function classifySyntheticTurnStream(stdoutText, { tool = "codex", code = 0 } = {}) {
  return withTempDir("second-review-turn-closing-seam-", (dir) => {
    const stdoutPath = path.join(dir, "stdout.log");
    const stderrPath = path.join(dir, "stderr.log");
    writeFileSync(stdoutPath, stdoutText);
    writeFileSync(stderrPath, "");
    const context = {
      mode: "audit-only",
      head_ref_oid: "none",
      reviewer_cli_recipe: { tool },
      stdout_log_path: stdoutPath,
      stderr_log_path: stderrPath,
    };
    const evidence = __testReviewerClassification.extractBoundedTerminalEvidence(context);
    return __testReviewerClassification.classifyCliExit(
      context,
      {
        ...reviewerCliResultForClassification(code),
        stdout_bytes: Buffer.byteLength(stdoutText, "utf8"),
      },
      evidence,
    );
  });
}

// The observed event order: two bare notices in the middle of a turn, an accepted completion,
// then the turn-closing record. Shared by the end-to-end reproduction and its no-closing twin.
const codexBareNoticeTurnEvents = [
  codexTurnStarted,
  ...codexTurnCommandItems,
  syntheticBareCodexNotice(`placeholder notice one ${codexNoticeSentinel}`),
  syntheticBareCodexNotice(`placeholder notice two ${codexNoticeSentinel}`),
  ...codexTurnCommandItems.map((event) => ({ ...event, item: { ...event.item, id: "item-cmd-2" } })),
  syntheticCodexCompletionEvent("PASS"),
  codexTurnCompleted,
];

function runCodexTurnClosingEndToEnd(dir, streamEvents) {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeCodex(binDir);
  const { context } = renderHandoff(dir, codexAuditHandoff);
  const result = runGeneratedRunnerCommand(context, binDir, {
    DEVPRO_FAKE_REVIEWER_RAW_STDOUT_PREFIX: JSON.stringify(codexTurnThreadStarted),
    DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT: streamEvents.map((event) => JSON.stringify(event)).join("\n"),
  });
  return { context, result, output: JSON.parse(result.stdout) };
}

test("Scenario: Codex turn completion supersedes bare error notices", () => {
  // Reproduces the observed event order: two bare reconnect-style notices in the middle of a
  // turn, an accepted completion, then the Codex turn-closing record, exit zero.
  withTempDir("second-review-codex-bare-notices-e2e-", (dir) => {
    const { context, result, output } = runCodexTurnClosingEndToEnd(dir, codexBareNoticeTurnEvents);

    // Fixture precondition and no-leak checks first: they hold before and after the fix.
    assert.ok(
      readFileSync(context.stdout_log_path, "utf8").includes(codexNoticeSentinel),
      "the fixture must deliver the notice text into the raw stdout archive",
    );
    assert.equal(readFileSync(context.activity_log_path, "utf8").includes(codexNoticeSentinel), false);
    assert.equal(readFileSync(context.heartbeat_path, "utf8").includes(codexNoticeSentinel), false);
    assert.equal(result.stdout.includes(codexNoticeSentinel), false);

    assert.equal(output.classification, "reviewer_cli_completed", `exit ${result.status}: ${result.stderr}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.status, "finished");
  });
});

test("Scenario: Codex turn completion supersedes bare error notices (shape only, any count)", () => {
  const shapes = [
    ["one bare notice", [syntheticBareCodexNotice("placeholder-one")]],
    [
      "three bare notices with different placeholders",
      [
        syntheticBareCodexNotice("placeholder-a"),
        syntheticBareCodexNotice(`placeholder-b ${codexNoticeSentinel}`),
        syntheticBareCodexNotice("placeholder-c"),
      ],
    ],
    ["empty-string message", [syntheticBareCodexNotice("")]],
    ["no message key", [{ type: "error" }]],
  ];
  for (const [name, notices] of shapes) {
    const classification = classifySyntheticTurnStream(
      syntheticCodexTurnStream([...codexTurnCommandItems, ...notices], [codexTurnCompleted]),
    );
    assert.equal(classification, "reviewer_cli_completed", name);
  }
});

test("Scenario: Codex error records with typed control fields are not superseded", () => {
  // Characterization: green before and after the fix. Any extra own key, a non-string
  // `message`, or a `result` record keeps the generic failure even with turn.completed.
  const typedErrors = [
    ["provider status 429", syntheticTypedCodexError({ status: 429 })],
    ["unrelated provider status 400", syntheticTypedCodexError({ status: 400 })],
    ["is_error", syntheticTypedCodexError({ is_error: true })],
    ["api_error_status", syntheticTypedCodexError({ api_error_status: 500 })],
    ["terminal_reason", syntheticTypedCodexError({ terminal_reason: "synthetic_reason" })],
    ["nested error object", { type: "error", error: { detail: "synthetic-placeholder" } }],
    ["unrecognized key", syntheticTypedCodexError({ synthetic_unlisted_key: "synthetic-value" })],
  ];
  const bare = syntheticBareCodexNotice();
  const shapes = [
    ...typedErrors.map(([name, typed]) => [`${name} alone`, [typed]]),
    ["typed error, bare", [typedErrors[0][1], bare]],
    ["bare, typed error", [bare, typedErrors[0][1]]],
    ["bare, typed error, bare", [bare, typedErrors[2][1], bare]],
    ["typed 400 recipe error, bare", [
      { type: "error", status: 400, message: "reasoning configuration is unsupported for this model" },
      bare,
    ]],
    ["object-typed message", [{ type: "error", message: { detail: "synthetic-placeholder" } }]],
    ["number-typed message", [{ type: "error", message: 42 }]],
    ["result with is_error", [{ type: "result", subtype: "error", is_error: true }]],
    ["result with is_error, bare", [{ type: "result", subtype: "error", is_error: true }, bare]],
  ];
  for (const [name, records] of shapes) {
    const classification = classifySyntheticTurnStream(
      syntheticCodexTurnStream([...codexTurnCommandItems, ...records], [codexTurnCompleted]),
    );
    assert.equal(classification, "reviewer_cli_failed", name);
  }
});

test("Scenario: Codex stream without a later turn completion keeps the terminal error failure", () => {
  // Characterization: green before and after the fix. End-to-end first: the observed event
  // order minus the closing turn.completed record.
  withTempDir("second-review-codex-bare-notices-no-closing-", (dir) => {
    assert.equal(codexBareNoticeTurnEvents.at(-1), codexTurnCompleted);
    const { result, output } = runCodexTurnClosingEndToEnd(dir, codexBareNoticeTurnEvents.slice(0, -1));
    assert.equal(output.classification, "reviewer_cli_failed", result.stderr);
    assert.equal(result.status, 1, result.stderr);
  });

  const bare = syntheticBareCodexNotice();
  const seamShapes = [
    ["stream ends on the notice", syntheticCodexTurnStream([], [bare])],
    ["only turn.completed precedes the notice", syntheticCodexTurnStream([], [codexTurnCompleted, bare])],
    [
      "trailing turn.completed line is a cut-off unterminated fragment",
      `${syntheticCodexTurnStream([bare], [])}{"type":"turn.compl`,
    ],
    [
      "trailing turn.completed line is complete JSON without a line terminator",
      `${syntheticCodexTurnStream([bare], [])}${JSON.stringify(codexTurnCompleted)}`,
    ],
  ];
  for (const [name, stdoutText] of seamShapes) {
    assert.equal(classifySyntheticTurnStream(stdoutText), "reviewer_cli_failed", name);
  }
});

test("Scenario: Codex turn failure classifies as failure even with an accepted completion", () => {
  const failedAccepted = classifySyntheticTurnStream(
    syntheticCodexTurnStream(codexTurnCommandItems, [codexTurnFailed]),
  );
  assert.equal(failedAccepted, "reviewer_cli_failed", "accepted PASS completion, exit 0, turn.failed");
  assert.notEqual(failedAccepted, "reviewer_cli_completed");

  assert.equal(
    classifySyntheticTurnStream(
      syntheticCodexTurnStream(codexTurnCommandItems, [codexTurnFailed], "UNAVAILABLE"),
    ),
    "reviewer_cli_failed",
    "blocking UNAVAILABLE completion, exit 0, turn.failed",
  );

  // Rows that already fail before the fix stay failed.
  const bare = syntheticBareCodexNotice();
  assert.equal(
    classifySyntheticTurnStream(syntheticCodexTurnStream([bare], [codexTurnFailed])),
    "reviewer_cli_failed",
    "bare notice, turn.failed",
  );
  assert.equal(
    classifySyntheticTurnStream(
      syntheticCodexTurnStream([syntheticTypedCodexError({ status: 429 })], [codexTurnFailed]),
    ),
    "reviewer_cli_failed",
    "typed error, turn.failed",
  );
});

test("Scenario: Turn records do not change terminal classification for non-Codex reviewers", () => {
  // Characterization: green before and after the fix. The turn-closing rule is bound to the
  // Codex tool, so a Claude recipe ignores turn.completed and turn.failed entirely.
  const bareThenCompleted = ndjsonText([
    codexTurnThreadStarted,
    syntheticBareCodexNotice(),
    codexTurnCompleted,
  ]);
  assert.equal(
    classifySyntheticTurnStream(bareThenCompleted, { tool: "claude" }),
    "reviewer_cli_failed",
    "claude: bare-shaped error then turn.completed",
  );

  const successResult = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      sticky_comment_url: "none",
      verdict: "PASS",
      last_reviewed_sha: "none",
      reviewer_model: "claude-test",
      reason: "Synthetic reviewer verdict fixture.",
    }),
  };
  assert.equal(
    classifySyntheticTurnStream(ndjsonText([successResult, codexTurnFailed]), { tool: "claude" }),
    "reviewer_cli_completed",
    "claude: successful result then turn.failed",
  );
  assert.equal(
    classifySyntheticTurnStream(ndjsonText([successResult, codexTurnCompleted]), { tool: "claude" }),
    "reviewer_cli_completed",
    "claude: successful result then turn.completed",
  );
});

test("Scenario: Codex turn records do not displace authentication, provider-rate, or recipe evidence", () => {
  // Characterization: green before and after the fix. The three typed evidence classes are
  // read from the same inputs as before; a following turn record changes none of them.
  const recipe400 = { type: "error", status: 400, message: "reasoning configuration is unsupported for this model" };
  const auth401 = { type: "error", status: 401, message: "placeholder authentication notice" };
  const rate429 = { type: "error", status: 429, message: "placeholder rate notice" };
  for (const [closingName, closing] of [["turn.completed", codexTurnCompleted], ["turn.failed", codexTurnFailed]]) {
    assert.equal(
      classifySyntheticTurnStream(syntheticCodexTurnStream([recipe400], [closing])),
      "reviewer_cli_recipe_incompatible",
      `recipe 400 as terminal, ${closingName}, accepted, exit 0`,
    );
    assert.equal(
      classifySyntheticTurnStream(syntheticCodexTurnStream([auth401], [closing])),
      "claude_reviewer_authentication_failed",
      `status 401, ${closingName}, accepted, exit 0`,
    );
    assert.equal(
      classifySyntheticTurnStream(syntheticCodexTurnStream([rate429], [closing], null)),
      "claude_reviewer_provider_rate_limited",
      `status 429, ${closingName}, no accepted completion`,
    );
  }
});

test("Scenario: Superseded bare Codex error notices do not grant completion", () => {
  // Removing the notices must not change the classification, and none of these may become
  // completed (nor a bare reviewer_cli_failed merely because of the notices).
  const notices = [syntheticBareCodexNotice(), syntheticBareCodexNotice("placeholder-two")];
  const cases = [
    ["blocking UNAVAILABLE completion", "UNAVAILABLE", 0, "reviewer_completion_unavailable"],
    ["blocking CRITICAL completion", "CRITICAL", 0, "reviewer_completion_critical"],
    ["missing completion", null, 0, "reviewer_completion_contract_missing"],
    ["malformed completion", "malformed", 0, "reviewer_completion_contract_invalid"],
  ];
  for (const [name, completionKind, code, expected] of cases) {
    const withNotices = classifySyntheticTurnStream(
      syntheticCodexTurnStream([...codexTurnCommandItems, ...notices], [codexTurnCompleted], completionKind),
      { code },
    );
    const withoutNotices = classifySyntheticTurnStream(
      syntheticCodexTurnStream(codexTurnCommandItems, [codexTurnCompleted], completionKind),
      { code },
    );
    assert.equal(withNotices, withoutNotices, `${name}: same classification as the stream without notices`);
    assert.equal(withNotices, expected, name);
    assert.notEqual(withNotices, "reviewer_cli_completed", name);
    assert.notEqual(withNotices, "reviewer_cli_failed", name);
  }

  // A non-zero exit keeps the generic failure classification.
  assert.equal(
    classifySyntheticTurnStream(
      syntheticCodexTurnStream([...codexTurnCommandItems, ...notices], [codexTurnCompleted]),
      { code: 1 },
    ),
    "reviewer_cli_failed",
    "non-zero exit with superseded notices",
  );
});

test("Scenario: Codex completion does not require a turn completion record", () => {
  // Characterization: green before and after the fix. With no error and no turn.failed,
  // the presence of turn.completed changes nothing.
  const cases = [
    ["accepted completion, exit 0", "PASS", 0, "reviewer_cli_completed"],
    ["blocking UNAVAILABLE completion, exit 0", "UNAVAILABLE", 0, "reviewer_completion_unavailable"],
    ["accepted completion, exit 1", "PASS", 1, "reviewer_cli_failed"],
  ];
  for (const [name, completionKind, code, expected] of cases) {
    const withClosing = classifySyntheticTurnStream(
      syntheticCodexTurnStream(codexTurnCommandItems, [codexTurnCompleted], completionKind),
      { code },
    );
    const withoutClosing = classifySyntheticTurnStream(
      syntheticCodexTurnStream(codexTurnCommandItems, [], completionKind),
      { code },
    );
    assert.equal(withClosing, expected, `${name}: with turn.completed`);
    assert.equal(withoutClosing, expected, `${name}: without turn.completed`);
  }
});

for (const [interruptSignal, paged, repeated] of [["SIGINT", false, false], ["SIGTERM", false, false], ["SIGINT", true, false], ["SIGTERM", true, false], ["SIGINT", true, true]]) {
  test(`runner interruption ${interruptSignal} ${paged ? "paged" : "audit"}${repeated ? " repeated" : ""} terminates its reviewer and records observed close`, { skip: process.platform === "win32", timeout: 15000 }, async () => {
  await withTempDirAsync("second-review-runner-interrupt-", async (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    if (paged) {
      const authorityGh = path.join(dir, "immutable-authority-bin", "gh");
      writeFileSync(path.join(binDir, "gh"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "api" && args.some(arg => arg.includes("/issues/1658/comments"))) {
  process.stdout.write(${JSON.stringify(emptyStickyAuthorityApiResponse)});
} else if (args[0] === "pr" && args[1] === "view" && args.includes("headRefOid") && !args.includes("baseRefOid,headRefOid")) {
  process.stdout.write(args.includes("--jq") ? ${JSON.stringify(prStickyHeadSha)} : JSON.stringify({ headRefOid: ${JSON.stringify(prStickyHeadSha)} }));
} else {
  const result = spawnSync(process.execPath, [${JSON.stringify(authorityGh)}, ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`, { mode: 0o700 });
    }
    const renderEnv = paged ? { PATH: `${binDir}${path.delimiter}${path.join(dir, "immutable-authority-bin")}${path.delimiter}${process.env.PATH}` } : {};
    const { context, evidenceRoot, authorityPath } = renderHandoff(dir, paged ? largePrStickyHandoff() : auditHandoff, renderEnv);
    const child = spawn(context.projection_runner_command.executable, context.projection_runner_command.argv, {
      cwd: dir,
      env: buildGeneratedRunnerEnv(context, binDir, {
        DEVPRO_FAKE_REVIEWER_BUSY_UNTIL_SIGNAL: "1",
        ...(paged ? { PATH: `${binDir}${path.delimiter}${authorityPath}` } : {}),
        DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "12000",
      }, dir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    try {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && (!existsSync(context.activity_log_path)
        || !readFileSync(context.activity_log_path, "utf8").includes('"event":"projection_cli_started"'))) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.match(readFileSync(context.activity_log_path, "utf8"), /projection_cli_started/);
      child.kill(interruptSignal);
      if (repeated) child.kill("SIGTERM");
      const result = await closed;
      assert.equal(result.signal, null, "runner must handle interruption and finish cleanup");
      assert.equal(result.code, 1);
      assert.ok(stdout, stderr);
      assert.equal(JSON.parse(stdout).classification, "reviewer_cli_interrupted");
      const events = readFileSync(context.activity_log_path, "utf8").trim().split("\n").map(JSON.parse);
      const exit = events.find(event => event.event === "projection_cli_exited");
      assert.equal(events.filter(event => event.event === "projection_cli_interrupted").length, 1);
      assert.equal(exit.process_close_observed, true);
      assert.equal(exit.transport_cleanup_confirmed, true);
      const evidence = readDispatchEvidenceStrict({ rootDir: evidenceRoot, dispatchId: context.dispatch_id });
      assert.equal(evidence.completion, null);
      assert.equal(evidence.terminal.classification, "reviewer_cli_interrupted");
      assert.equal(evidence.terminal.process_close_observed, true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
}

test("runner interruption without observed close cannot publish a terminal receipt", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  await withTempDirAsync("second-review-interrupt-unclosed-", async dir => {
    const binDir = path.join(dir, "bin");
    const descendantPidPath = path.join(dir, "descendant.pid");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const { context } = renderHandoff(dir);
    const child = spawn(context.projection_runner_command.executable, context.projection_runner_command.argv, {
      cwd: dir,
      env: buildGeneratedRunnerEnv(context, binDir, {
        DEVPRO_FAKE_REVIEWER_INIT_TOOLS: '["StructuredOutput"]',
        DEVPRO_FAKE_REVIEWER_EXIT_WITH_STUBBORN_DESCENDANT_PID_LOG: descendantPidPath,
        DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "12000",
      }, dir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.resume();
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    let descendantPid = null;
    try {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !existsSync(descendantPidPath)) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(existsSync(descendantPidPath), "test descendant must start before interrupt");
      descendantPid = Number(readFileSync(descendantPidPath, "utf8").trim());
      child.kill("SIGINT");
      const result = await closed;
      assert.equal(result.signal, null);
      const output = JSON.parse(stdout);
      assert.equal(output.classification, "reviewer_cli_interrupted");
      assert.equal(output.cli_exit.process_close_observed, false);
      assert.equal(terminalReceiptForContext(context), null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        try { process.kill(-descendantPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
  });
});

if (projectionTestIndex !== PROJECTION_TEST_GROUP_RANGE_END) {
  throw new Error(
    `run-second-reviewer-projection grouped ${projectionTestIndex} tests, expected ${PROJECTION_TEST_GROUP_RANGE_END}`,
  );
}

function assertPortableFakeGhRoutes() {
  const root = mkdtempSync(path.join(tmpdir(), "fake-gh-route-"));
  try {
    const helper = new URL("./lib/portable-fake-reviewer-cli.mjs", import.meta.url).href;
    const entry = path.join(root, "gh.mjs");
    const authority = path.join(root, "authority.mjs");
    writeFileSync(entry, `import { runFakeGh } from ${JSON.stringify(helper)}; await runFakeGh();`);
    writeFileSync(authority, 'console.log("scope-authority");');
    const env = { ...process.env, DEVPRO_FAKE_GH_SCOPE_AUTHORITY: authority, DEVPRO_FAKE_GH_HEAD_REF_OID: "b".repeat(40), DEVPRO_FAKE_GH_API_RESPONSE: '{"comments":[]}', DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: root };
    for (const args of [["pr", "view", "42", "--json", "headRefOid"], ["pr", "view", "42", "--json", "headRefOid", "--jq", ".headRefOid"]]) {
      const result = spawnSync(process.execPath, [entry, ...args], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(args.includes("--jq") ? result.stdout.trim() : JSON.parse(result.stdout).headRefOid, "b".repeat(40));
    }
    const comments = spawnSync(process.execPath, [entry, "api", "repos/devpro/example/issues/42/comments?per_page=100"], { env, encoding: "utf8" });
    assert.equal(comments.status, 0, comments.stderr);
    assert.deepEqual(JSON.parse(comments.stdout), { comments: [] });
    const scope = spawnSync(process.execPath, [entry, "api", "repos/devpro/example/pulls/42"], { env, encoding: "utf8" });
    assert.equal(scope.status, 0, scope.stderr);
    assert.equal(scope.stdout.trim(), "scope-authority");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (PROJECTION_TEST_GROUP === "core") nodeTest("runner points a claimed attempt without close evidence at the abandon entry", async () => {
  await withTempDirAsync("second-review-runner-claimed-interrupted-", async (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const evidenceRoot = path.join(dir, "control-evidence");
    const evidenceEnv = { DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot };
    const { context, packetPath } = renderHandoff(dir, auditHandoff, evidenceEnv);
    await claimDispatchInvocation({
      rootDir: evidenceRoot,
      record: secondReviewDispatchRecord({ context, packetBytes: readFileSync(packetPath) }),
    });
    const result = runGeneratedRunnerCommand(context, binDir, evidenceEnv);
    assert.equal(result.status, 1, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.classification, "reviewer_dispatch_identity_collision");
    assert.ok(stdout.error.includes(`notes/cross-review/${context.attempt_id}/observability-context.json --dry-run`));
  });
});

if (PROJECTION_TEST_GROUP === "core") nodeTest("a dead lock on a claimed attempt without close evidence points at the abandon entry", async () => {
  await withTempDirAsync("second-review-runner-claimed-dead-lock-", async (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const evidenceRoot = path.join(dir, "control-evidence");
    const evidenceEnv = { DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot };
    const { context, packetPath } = renderHandoff(dir, auditHandoff, evidenceEnv);
    await claimDispatchInvocation({
      rootDir: evidenceRoot,
      record: secondReviewDispatchRecord({ context, packetBytes: readFileSync(packetPath) }),
    });
    const { lockPath, deadOwner } = writeDeadOwnerLock(context);

    const result = runGeneratedRunnerCommand(context, binDir, evidenceEnv);
    assert.equal(result.status, 1, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.classification, "projection_attempt_recovery_required");
    assert.ok(stdout.next_step.includes(`abandon-interrupted-second-review.mjs notes/cross-review/${context.attempt_id}/observability-context.json --dry-run`));
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), deadOwner);
  });
});

if (PROJECTION_TEST_GROUP === "core") nodeTest("a dead lock on a closed attempt names no abandon step", async () => {
  await withTempDirAsync("second-review-runner-closed-dead-lock-", async (dir) => {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeClaude(binDir);
    const evidenceRoot = path.join(dir, "control-evidence");
    const evidenceEnv = { DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot };
    const { context, packetPath } = renderHandoff(dir, auditHandoff, evidenceEnv);
    await writeTerminalReceipt({ rootDir: evidenceRoot, record: {
      ...secondReviewDispatchRecord({ context, packetBytes: readFileSync(packetPath) }),
      schema: TERMINAL_RECEIPT_SCHEMA,
      outcome_group: "spawn_or_probe_failure", classification: "tool_discovery_blocked",
      responsibility: TERMINAL_RECEIPT_RESPONSIBILITY, created_at: new Date().toISOString(),
      process_spawned: false, lifecycle_phase: "pre_spawn_known_terminal",
      process_close_observed: false, transport_cleanup_confirmed: true,
      invocation_claim_sha256: null,
    } });
    writeDeadOwnerLock(context);

    const result = runGeneratedRunnerCommand(context, binDir, evidenceEnv);
    assert.equal(result.status, 1, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.classification, "projection_attempt_recovery_required");
    assert.equal(stdout.next_step, undefined);
  });
});

if (PROJECTION_TEST_GROUP === "core") nodeTest("a dead lock names no recovery when the dispatch evidence cannot be read", () => {
  withTempDir("second-review-runner-unreadable-dead-lock-", (dir) => {
    const evidenceRoot = path.join(dir, "control-evidence");
    const evidenceEnv = { DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot };
    const { context } = renderHandoff(dir, auditHandoff, evidenceEnv);
    writeFileSync(path.join(evidenceRoot, ".cleanup-retirement.json"), "not-json\n", "utf8");
    assert.equal(__testAttemptOwnership.deadOwnerRecoveryHint(context, { ...process.env, ...evidenceEnv }), null);
  });
});

if (PROJECTION_TEST_GROUP === "core") nodeTest("runner rejects absent or inconsistent automatic model proof before spawn", () => {
  for (const mutation of ["missing","inconsistent"]) for (const [name,handoff] of [["claude",auditHandoff],["codex",codexAuditHandoff]]) {
    withTempDir(`second-review-model-proof-${name}-`, (dir) => {
      const {context,contextPath}=renderHandoff(dir,handoff);
      if (mutation === "missing") delete context.reviewer_model_selection.probe;
      else context.reviewer_model_selection.probe.selected_model="other-model";
      writeFileSync(contextPath,JSON.stringify(context),"utf8");
      const result=spawnSync(process.execPath,[runnerScript,contextPath],{cwd:REPO_ROOT,encoding:"utf8",env:{...process.env,DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR:context.control_evidence_root}});
      const output=JSON.parse(result.stdout);
      assert.equal(output.classification,"projection_context_invalid");
      assert.match(output.error,/missing or inconsistent automatic model probe evidence/);
      assert.equal(activityEvents(context.activity_log_path).includes("projection_cli_probe_started"),false);
    });
  }
});
