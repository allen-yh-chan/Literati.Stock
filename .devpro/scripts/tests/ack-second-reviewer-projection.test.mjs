import "./lib/model-probe-fixture.mjs";
import "./lib/portable-command-shims.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalEmbeddedReviewMaterialProof } from "../second-review-material-contract.mjs";
import { deriveMainCheckoutNotesTmp } from "../second-reviewer-cli-recipe-contract.mjs";
import { acknowledgeProjectionHandoff } from "../ack-second-reviewer-projection.mjs";
import {
  authorizeSecondReviewPacketFile,
  parseCanonicalSecondReviewPacketData,
  SECOND_REVIEW_FRAME_MARKER,
} from "../validate-second-review-packet.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { resolveNativeExecutableOnPath } from "./lib/resolve-native-executable.mjs";
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
process.env.DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB ??= "xhigh";
// Isolate the pr-sticky review-round sidecar (R2 round budget): every test in
// this file renders PR #1612, so without a private state dir the fourth
// successful render trips the cap-3 budget against the real state dir.
process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR ??= makeTempDir("review-round-state-");

const renderer = repoPath(".devpro/scripts/render-second-review-packet.mjs");
const ackScript = repoPath(".devpro/scripts/ack-second-reviewer-projection.mjs");
const runnerScript = repoPath(".devpro/scripts/run-second-reviewer-projection.mjs");
const liveCanonicalCarrierRoot = path.join(path.dirname(deriveMainCheckoutNotesTmp(REPO_ROOT)), "cross-review");
const approvalContext = "none";
const headSha = "a".repeat(40);
const reviewScope = {
  kind: "full-pr",
  pull_request_number: 1612,
  head_sha: headSha,
};
const stickyAuthoritySnapshot = {
  repository_slug: "example/repo",
  pr_number: 1612,
  completeness: { status: "complete", pagination_exhausted: true, pages_fetched: 1 },
  query_error: null,
  comments: [],
};
const reviewMaterial = [
  "diff --git a/.devpro/scripts/render-second-review-packet.mjs b/.devpro/scripts/render-second-review-packet.mjs",
  "--- a/.devpro/scripts/render-second-review-packet.mjs",
  "+++ b/.devpro/scripts/render-second-review-packet.mjs",
  "@@ -1 +1 @@",
  "-legacy",
  "+typed scope",
  "diff --git a/.devpro/scripts/ack-second-reviewer-projection.mjs b/.devpro/scripts/ack-second-reviewer-projection.mjs",
  "--- a/.devpro/scripts/ack-second-reviewer-projection.mjs",
  "+++ b/.devpro/scripts/ack-second-reviewer-projection.mjs",
  "@@ -1 +1 @@",
  "-legacy",
  "+typed scope",
  "",
].join("\n");

const validHandoff = {
  mode: "pr-sticky",
  attempt: "initial",
  primary_family: "openai-codex",
  reviewer_family: "claude",
  target: "PR #1612",
  repository_slug: "example/repo",
  head_ref_oid: headSha,
  approval_context: approvalContext,
  approval_resolution: { status: "not-required" },
  pr_head_ref_name: "chore/strengthen-second-reviewer-idle-timeout",
  scope_summary: "bounded PR review",
  changed_files_or_touch_list: [
    ".devpro/scripts/render-second-review-packet.mjs",
    ".devpro/scripts/ack-second-reviewer-projection.mjs",
  ],
  review_scope: reviewScope,
  review_material_carrier: "embedded-diff",
  review_material_capability: "scope-bound-embedded-complete-diff-v1",
  review_material_proof: canonicalEmbeddedReviewMaterialProof(reviewScope, reviewMaterial),
  sticky_authority_snapshot: stickyAuthoritySnapshot,
  review_material: reviewMaterial,
  primary_validation_evidence: "openspec validate code-review-checklist --strict passed",
  primary_test_evidence: "node --test targeted second-review suites passed",
  retry_context: { classification: "none", sticky_verification: "not-needed" },
  write_path: "reviewer current neutral cwd body file plus disposition-bound gh api only",
  allowed_tools: `Write,Bash(command -v gh),Bash(gh pr view:*),Bash(node ${repoPath(".devpro/scripts/read-second-review-sticky-comment.mjs")}:*),Bash(node ${repoPath(".devpro/scripts/write-second-review-sticky-gated.mjs")}:*)`,
};

function reviewMaterialWithExactUtf8Bytes(targetBytes) {
  const currentBytes = Buffer.byteLength(reviewMaterial, "utf8");
  assert.ok(currentBytes <= targetBytes);
  return `${reviewMaterial}${"x".repeat(targetBytes - currentBytes)}`;
}

function largeValidHandoff() {
  const largeReviewMaterial = reviewMaterialWithExactUtf8Bytes(262_145);
  return {
    ...validHandoff,
    review_material_proof: canonicalEmbeddedReviewMaterialProof(reviewScope, largeReviewMaterial),
    review_material: largeReviewMaterial,
  };
}

function immutableAuthorityFixture(handoff, dir) {
  const fixtureBin = path.join(dir, "immutable-authority-bin");
  mkdirSync(fixtureBin, { recursive: true });
  const comparisonBase = "c".repeat(40);
  const nameStatus = handoff.changed_files_or_touch_list
    .map((changedPath) => `M\0${changedPath}\0`)
    .join("");
  const realGit = resolveNativeExecutableOnPath("git");
  const gitPath = path.join(fixtureBin, "git");
  const ghPath = path.join(fixtureBin, "gh");
  writeFileSync(gitPath, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const authoritativeRawDiffBase64 = process.env.DEVPRO_TEST_SECOND_REVIEW_AUTHORITATIVE_RAW_DIFF_BASE64
  ?? ${JSON.stringify(Buffer.from(handoff.review_material, "utf8").toString("base64"))};
if (args.join(" ") === "rev-parse --show-toplevel") process.stdout.write(${JSON.stringify(`${REPO_ROOT}\n`)});
else if (args[0] === "merge-base") process.stdout.write(${JSON.stringify(`${comparisonBase}\n`)});
else if (args[0] === "diff" && args.includes("--name-status")) process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(nameStatus, "utf8").toString("base64"))}, "base64"));
else if (args[0] === "diff") process.stdout.write(Buffer.from(authoritativeRawDiffBase64, "base64"));
else { const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" }); process.exit(result.status ?? 1); }
`, "utf8");
writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view" && args.includes("baseRefOid,headRefOid")) {
  process.stdout.write(JSON.stringify({ baseRefOid: ${JSON.stringify(comparisonBase)}, headRefOid: ${JSON.stringify(handoff.review_scope?.head_sha)} }));
} else { process.stderr.write("unexpected gh fixture args: " + JSON.stringify(args) + "\\n"); process.exit(97); }
`, "utf8");
  chmodSync(gitPath, 0o700);
  chmodSync(ghPath, 0o700);
  return `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}`;
}

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

function withRenderedContext(fn, handoff = validHandoff) {
  const dir = makeTempDir("second-review-ack-");
  const handoffPath = path.join(dir, "handoff.json");
  let carrierDir = null;
  const previousEvidenceRoot = process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
  try {
    writeFileSync(handoffPath, JSON.stringify(handoff), "utf8");
    const authorityPath = handoff.review_scope
      ? immutableAuthorityFixture(handoff, dir)
      : process.env.PATH;
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
    const render = spawnSync(
      process.execPath,
      [prepared.mutatedRendererPath, handoffPath, "--carrier-root", prepared.carrierRootArg],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          // T5 fix (design.md D11): withRenderedContext() is this file's
          // shared render step. Most callers below assert or exact-mutate
          // `context.projection_runner_command` starting from the
          // pre-existing absolute carrier baseline (the two D2
          // repo-root-relative tests near this comment's neighbors
          // overwrite the field by hand afterward, so they are unaffected
          // either way). An ambient `CLAUDE_CODE_SESSION_ID` (inherited from
          // a real Claude Code CLI session running this test file) would
          // otherwise make the renderer emit the relative carrier here
          // instead, breaking the one test that asserts the exact absolute
          // shape without first overwriting it.
          ...envWithoutHostMarkers(),
          DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
          // Per-test sidecar isolation: every test renders the same PR #1612, so a
          // shared state dir would trip the cap-3 pr-sticky round budget (R2).
          DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(dir, "post-pr-completion-state"),
          PATH: authorityPath,
        },
      },
    );
    assert.equal(render.status, 0, render.stderr);
    const packetPath = render.stdout.trim();
    assertAttemptUnderOwnedRoot(packetPath, prepared.ownedCarrierRoot);
    carrierDir = path.dirname(packetPath);
    process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = evidenceRoot;
    return fn({
      dir,
      carrierDir,
      packetPath,
      contextPath: path.join(carrierDir, "observability-context.json"),
      stdoutPath: path.join(carrierDir, "reviewer-stdout.ndjson"),
      authorityPath,
      evidenceRoot,
    });
  } finally {
    if (previousEvidenceRoot === undefined) {
      delete process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
    } else {
      process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = previousEvidenceRoot;
    }
    if (carrierDir) {
      rmSync(carrierDir, { recursive: true, force: true });
    }
    clearOwnedCanonicalCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function runAck(contextPath) {
  return spawnSync(process.execPath, [ackScript, contextPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function runRendererGeneratedBootstrapCommandFromWrongCwd(contextPath) {
  const context = JSON.parse(readFileSync(contextPath, "utf8"));
  const wrongCwd = makeTempDir("second-review-wrong-cwd-");
  try {
    return spawnSync(
      context.projection_bootstrap_command.executable,
      context.projection_bootstrap_command.argv,
      {
      cwd: wrongCwd,
      encoding: "utf8",
      }
    );
  } finally {
    rmSync(wrongCwd, { recursive: true, force: true });
  }
}

function readContext(contextPath) {
  return JSON.parse(readFileSync(contextPath, "utf8"));
}

test("ack-second-reviewer-projection records first post-handoff heartbeat and activity", () => {
  withRenderedContext(({ carrierDir, contextPath }) => {
    const result = runAck(contextPath);
    assert.equal(result.status, 0, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "ok");
    assert.equal(stdout.classification, "projection_handoff_validated");

    const heartbeat = JSON.parse(readFileSync(path.join(carrierDir, "heartbeat.json"), "utf8"));
    assert.equal(heartbeat.status, "projection_handoff_validated");
    assert.equal(heartbeat.next_action, "projection_cli_probe");

    const activity = readFileSync(path.join(carrierDir, "projection-activity.ndjson"), "utf8");
    assert.match(activity, /"event":"packet_rendered"/);
    assert.match(activity, /"event":"projection_handoff_validated"/);
    assert.match(activity, /"next_action":"projection_cli_probe"/);
  });
});

test("renderer-generated projection_bootstrap_command works outside the repo cwd", () => {
  withRenderedContext(({ carrierDir, contextPath }) => {
    const result = runRendererGeneratedBootstrapCommandFromWrongCwd(contextPath);
    assert.equal(result.status, 0, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "ok");
    assert.equal(stdout.classification, "projection_handoff_validated");

    const heartbeat = JSON.parse(readFileSync(path.join(carrierDir, "heartbeat.json"), "utf8"));
    assert.equal(heartbeat.status, "projection_handoff_validated");

    const activity = readFileSync(path.join(carrierDir, "projection-activity.ndjson"), "utf8");
    assert.match(activity, /"event":"projection_handoff_validated"/);
  });
});

test("ack-second-reviewer-projection requires the exact renderer-owned runner carrier", () => {
  const mutations = [
    ["missing", (context) => { delete context.projection_runner_command; }, /projection_runner_command is required/],
    ["legacy string", (context) => { context.projection_runner_command = `node ${runnerScript}`; }, /exact canonical executable\/argv carrier/],
    ["extra arg", (context) => { context.projection_runner_command.argv.push("--tampered"); }, /exact canonical executable\/argv carrier/],
  ];

  withRenderedContext(({ contextPath }) => {
    const canonicalContextBytes = readFileSync(contextPath);
    const canonicalContext = JSON.parse(canonicalContextBytes.toString("utf8"));
    const artifactPaths = [
      canonicalContext.activity_log_path,
      canonicalContext.heartbeat_path,
      canonicalContext.stdout_log_path,
      canonicalContext.stderr_log_path,
      canonicalContext.cli_probe_result_path,
    ];
    const originalArtifacts = new Map(artifactPaths.map((artifactPath) => [
      artifactPath,
      readFileSync(artifactPath),
    ]));

    for (const [name, mutate, errorPattern] of mutations) {
      writeFileSync(contextPath, canonicalContextBytes);
      for (const [artifactPath, originalBytes] of originalArtifacts) {
        writeFileSync(artifactPath, originalBytes);
      }
      const context = readContext(contextPath);
      assert.equal(context.projection_runner_script, ".devpro/scripts/run-second-reviewer-projection.mjs");
      assert.deepEqual(context.projection_runner_command, {
        executable: process.execPath,
        argv: [runnerScript, contextPath],
      });
      mutate(context);
      writeFileSync(contextPath, JSON.stringify(context), "utf8");

      const result = runAck(contextPath);
      assert.equal(result.status, 1, name);
      const stdout = JSON.parse(result.stdout);
      assert.equal(stdout.status, "blocked", name);
      assert.equal(stdout.classification, "projection_observability_contract_missing", name);
      assert.match(stdout.error, errorPattern, name);
      const heartbeat = JSON.parse(readFileSync(context.heartbeat_path, "utf8"));
      assert.equal(heartbeat.status, "projection_observability_contract_missing", name);
      assert.match(
        readFileSync(context.activity_log_path, "utf8"),
        /"event":"projection_observability_contract_missing"/,
        name,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// add-second-reviewer-runner-permission T3 (design.md D1-D3): the Claude Code
// host repo-root-relative runner carrier. Implemented in T4; kept here as a
// regression test. The literal below is hand-written from design.md D2, not
// imported from lib/projection-runner-carrier.mjs.
//
// `ack-second-reviewer-projection rejects carriers that mix executable and
// script-path forms` documents two D3 boundary shapes ("node" + absolute
// script; process.execPath + relative script) that the exact-equality check
// rejects as a regression guard.
// ---------------------------------------------------------------------------
const relativeRunnerScriptLiteral = ".devpro/scripts/run-second-reviewer-projection.mjs";

test("ack-second-reviewer-projection accepts the D2 repo-root-relative runner carrier (design.md D1/D2/D3)", () => {
  withRenderedContext(({ contextPath }) => {
    const context = readContext(contextPath);
    context.projection_runner_command = {
      executable: "node",
      argv: [relativeRunnerScriptLiteral, path.resolve(contextPath)],
    };
    writeFileSync(contextPath, JSON.stringify(context), "utf8");

    const result = runAck(contextPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "ok");
    assert.equal(stdout.classification, "projection_handoff_validated");
  });
});

test(
  "ack-second-reviewer-projection rejects carriers that mix executable and script-path forms (design.md D3)",
  () => {
    const mutations = [
      ["node executable with absolute script path", (context) => {
        context.projection_runner_command = {
          executable: "node",
          argv: [runnerScript, path.resolve(context.observability_context_path)],
        };
      }],
      ["process.execPath with repo-relative script path", (context) => {
        context.projection_runner_command = {
          executable: process.execPath,
          argv: [relativeRunnerScriptLiteral, path.resolve(context.observability_context_path)],
        };
      }],
    ];

    withRenderedContext(({ contextPath }) => {
      const canonicalContextBytes = readFileSync(contextPath);
      for (const [name, mutate] of mutations) {
        writeFileSync(contextPath, canonicalContextBytes);
        const context = readContext(contextPath);
        mutate(context);
        writeFileSync(contextPath, JSON.stringify(context), "utf8");

        const result = runAck(contextPath);
        assert.equal(result.status, 1, name);
        const stdout = JSON.parse(result.stdout);
        assert.equal(stdout.status, "blocked", name);
        assert.equal(stdout.classification, "projection_observability_contract_missing", name);
        assert.match(stdout.error, /exact canonical executable\/argv carrier/, name);
      }
    });
  },
);

test("ack-second-reviewer-projection requires the exact duration conditions for timed activity events", () => {
  withRenderedContext(({ contextPath }) => {
    const context = readContext(contextPath);
    context.duration_conditional_activity_events = context.duration_conditional_activity_events.filter(
      (entry) => entry.event !== "projection_cli_status_checkpoint"
    );
    writeFileSync(contextPath, JSON.stringify(context), "utf8");

    const result = runAck(contextPath);
    assert.equal(result.status, 1);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "blocked");
    assert.match(
      stdout.error,
      /duration_conditional_activity_events must be the exact renderer-owned list/
    );
  });
});

test("ack-second-reviewer-projection rejects extra duration-conditional events", () => {
  withRenderedContext(({ contextPath }) => {
    const context = readContext(contextPath);
    context.duration_conditional_activity_events.push({
      event: "projection_cli_unowned_extra",
      required_when: "always",
    });
    writeFileSync(contextPath, JSON.stringify(context), "utf8");

    const result = runAck(contextPath);
    assert.equal(result.status, 1);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "blocked");
    assert.match(
      stdout.error,
      /duration_conditional_activity_events must be the exact renderer-owned list/
    );
  });
});

test("ack-second-reviewer-projection emits an observable fault before reviewer CLI when artifacts are missing", () => {
  withRenderedContext(({ carrierDir, contextPath, stdoutPath }) => {
    rmSync(stdoutPath, { force: true });

    const result = runAck(contextPath);
    assert.equal(result.status, 1);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "blocked");
    assert.equal(stdout.classification, "projection_observability_contract_missing");
    assert.match(stdout.error, /observability artifact missing: stdout_log_path/);

    const heartbeat = JSON.parse(readFileSync(path.join(carrierDir, "heartbeat.json"), "utf8"));
    assert.equal(heartbeat.status, "projection_observability_contract_missing");
    assert.match(heartbeat.error, /observability artifact missing: stdout_log_path/);

    const activity = readFileSync(path.join(carrierDir, "projection-activity.ndjson"), "utf8");
    assert.match(activity, /"event":"projection_observability_contract_missing"/);
  });
});

test("ack-second-reviewer-projection rejects every mutated canonical reviewer recipe field", () => {
  const mutations = [
    ["family-tool", (context) => { context.reviewer_cli_recipe.tool = "codex"; }],
    ["probe-command-order", (context) => { context.reviewer_cli_recipe.probe_commands.reverse(); }],
    ["probe-command-extra-argv", (context) => {
      context.reviewer_cli_recipe.probe_commands[0].argv.push("--version");
    }],
    ["probe-command-legacy-string", (context) => {
      context.reviewer_cli_recipe.probe_commands[0] = "claude --help";
    }],
    ["auth-preflight-argv", (context) => {
      context.reviewer_cli_recipe.auth_preflight.command.argv.pop();
    }],
    ["auth-preflight-legacy-string", (context) => {
      context.reviewer_cli_recipe.auth_preflight.command = "claude auth status --json";
    }],
    ["auth-preflight-limit", (context) => {
      context.reviewer_cli_recipe.auth_preflight.max_output_bytes += 1;
    }],
    ["required-flag-order", (context) => { context.reviewer_cli_recipe.required_flags.reverse(); }],
    ["allowed-tools", (context) => {
      const index = context.reviewer_cli_recipe.required_invocation_args.indexOf("--allowedTools");
      context.reviewer_cli_recipe.required_invocation_args[index + 1] += ",Bash(gh issue view:*)";
    }],
    ["accepted-alias", (context) => {
      context.reviewer_cli_recipe.accepted_flag_aliases["--allowedTools"].push("--everything");
    }],
  ];

  withRenderedContext(({ carrierDir, contextPath }) => {
    const canonicalContext = readContext(contextPath);
    const artifactPaths = [
      canonicalContext.activity_log_path,
      canonicalContext.heartbeat_path,
      canonicalContext.stdout_log_path,
      canonicalContext.stderr_log_path,
      canonicalContext.cli_probe_result_path,
    ];
    const originalArtifacts = new Map(artifactPaths.map((artifactPath) => [
      artifactPath,
      readFileSync(artifactPath),
    ]));

    for (const [name, mutate] of mutations) {
      const context = structuredClone(canonicalContext);
      mutate(context);
      writeFileSync(contextPath, JSON.stringify(context), "utf8");

      const result = runAck(contextPath);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      const stdout = JSON.parse(result.stdout);
      assert.equal(stdout.status, "blocked", name);
      assert.equal(stdout.classification, "reviewer_cli_recipe_invalid", name);
      assert.match(stdout.error, /reviewer_cli_recipe must exactly match/, name);
      for (const [artifactPath, originalBytes] of originalArtifacts) {
        assert.deepEqual(
          readFileSync(artifactPath),
          originalBytes,
          `${name}: ${path.relative(carrierDir, artifactPath)} must remain byte-identical`,
        );
      }
    }
  });
});

test("ack-second-reviewer-projection rejects family substrings outside the exact mapping", () => {
  withRenderedContext(({ contextPath }) => {
    const canonicalContextBytes = readFileSync(contextPath);
    const canonicalContext = JSON.parse(canonicalContextBytes.toString("utf8"));
    const artifactPaths = [
      canonicalContext.activity_log_path,
      canonicalContext.heartbeat_path,
      canonicalContext.stdout_log_path,
      canonicalContext.stderr_log_path,
      canonicalContext.cli_probe_result_path,
    ];
    const originalArtifacts = new Map(artifactPaths.map((artifactPath) => [
      artifactPath,
      readFileSync(artifactPath),
    ]));

    for (const reviewerFamily of ["anthropic", "claude-enterprise", "openai", "my-codex-wrapper"]) {
      writeFileSync(contextPath, canonicalContextBytes);
      for (const [artifactPath, originalBytes] of originalArtifacts) {
        writeFileSync(artifactPath, originalBytes);
      }
      const context = readContext(contextPath);
      context.reviewer_family = reviewerFamily;
      writeFileSync(contextPath, JSON.stringify(context), "utf8");

      const result = runAck(contextPath);
      assert.equal(result.status, 1, `${reviewerFamily}: ${result.stderr}`);
      const stdout = JSON.parse(result.stdout);
      assert.equal(stdout.status, "blocked", reviewerFamily);
      assert.equal(stdout.classification, "reviewer_dispatch_identity_collision", reviewerFamily);
      assert.match(stdout.error, /reviewer_dispatch_identity_collision/, reviewerFamily);
      for (const [artifactPath, originalBytes] of originalArtifacts) {
        assert.deepEqual(
          readFileSync(artifactPath),
          originalBytes,
          `${reviewerFamily}: ${path.basename(artifactPath)} must remain byte-identical`,
        );
      }
    }
  });
});

test("ack-second-reviewer-projection rejects malformed v5 data before artifact mutation", () => {
  const mutations = [
    ["tampered page", (data) => { data.review_material.pages[0].content += "tampered"; }, /(?:review_material|manifest)\.pages\[0\]/],
    ["non-array changed file list", (data) => { data.changed_files_or_touch_list = null; }, /changed_files_or_touch_list must be an array/],
  ];

  withRenderedContext(({ carrierDir, packetPath, contextPath }) => {
    const canonicalPacket = readFileSync(packetPath);
    const context = readContext(contextPath);
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
      mutateFramedReviewData(packetPath, (data) => {
        assert.equal(data.schema_version, "devpro-second-review-data/v5");
        mutate(data);
      });

      const result = runAck(contextPath);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      const stdout = JSON.parse(result.stdout);
      assert.equal(stdout.status, "blocked", name);
      assert.equal(stdout.classification, "reviewer_dispatch_identity_collision", name);
      assert.match(stdout.error, /reviewer_dispatch_identity_collision/, name);
      for (const [artifactPath, originalBytes] of before) {
        assert.deepEqual(
          readFileSync(artifactPath),
          originalBytes,
          `${name}: ${path.relative(carrierDir, artifactPath)} must remain byte-identical`,
        );
      }
    }
  }, largeValidHandoff());
});

test("ack rejects authoritative hunk-byte drift with all headers before artifact effects", () => {
  const canonicalMaterial = reviewMaterialWithExactUtf8Bytes(263_169);
  const alteredMaterial = canonicalMaterial.replace("+typed scope", "+forged scope");
  assert.notEqual(alteredMaterial, canonicalMaterial);
  assert.deepEqual(
    alteredMaterial.match(/^diff --git .+$/gmu),
    canonicalMaterial.match(/^diff --git .+$/gmu),
    "fixture must retain every authoritative diff header",
  );
  const alteredHandoff = {
    ...validHandoff,
    review_material: alteredMaterial,
    review_material_proof: canonicalEmbeddedReviewMaterialProof(reviewScope, alteredMaterial),
  };

  withRenderedContext(({ authorityPath, carrierDir, contextPath }) => {
    const context = readContext(contextPath);
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
    const previousPath = process.env.PATH;
    const previousRawDiff = process.env.DEVPRO_TEST_SECOND_REVIEW_AUTHORITATIVE_RAW_DIFF_BASE64;
    let result;
    try {
      process.env.PATH = authorityPath;
      process.env.DEVPRO_TEST_SECOND_REVIEW_AUTHORITATIVE_RAW_DIFF_BASE64 = Buffer
        .from(canonicalMaterial, "utf8")
        .toString("base64");
      result = runAck(contextPath);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousRawDiff === undefined) {
        delete process.env.DEVPRO_TEST_SECOND_REVIEW_AUTHORITATIVE_RAW_DIFF_BASE64;
      } else {
        process.env.DEVPRO_TEST_SECOND_REVIEW_AUTHORITATIVE_RAW_DIFF_BASE64 = previousRawDiff;
      }
    }

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "review_material_full_closure_invalid");
    for (const [artifactPath, originalBytes] of before) {
      assert.deepEqual(
        readFileSync(artifactPath),
        originalBytes,
        `${path.relative(carrierDir, artifactPath)} must remain byte-identical`,
      );
    }
  }, alteredHandoff);
});

test("ack rejects reuse of a trusted v5 seal after context mutation before artifact effects", () => {
  withRenderedContext(({
    authorityPath,
    carrierDir,
    contextPath,
    evidenceRoot,
  }) => {
    const previousPath = process.env.PATH;
    const previousEvidenceRoot = process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
    try {
      process.env.PATH = authorityPath;
      process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = evidenceRoot;
      const trustedAuthorization = authorizeSecondReviewPacketFile({ contextPath });
      const context = trustedAuthorization.context;
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
      const replacement = JSON.parse(readFileSync(contextPath, "utf8"));
      replacement.heartbeat_path = replacement.packet_path;
      writeFileSync(contextPath, JSON.stringify(replacement), "utf8");

      const result = acknowledgeProjectionHandoff(contextPath, { trustedAuthorization });

      assert.equal(result.status, "blocked");
      assert.equal(result.classification, "reviewer_dispatch_identity_collision");
      for (const [artifactPath, originalBytes] of before) {
        assert.deepEqual(
          readFileSync(artifactPath),
          originalBytes,
          `${path.relative(carrierDir, artifactPath)} must remain byte-identical`,
        );
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousEvidenceRoot === undefined) {
        delete process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
      } else {
        process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = previousEvidenceRoot;
      }
    }
  }, largeValidHandoff());
});

test("ack cannot bypass trusted v5 authorization through a redirected lawful v4 packet", () => {
  withRenderedContext(({ authorityPath, carrierDir, contextPath, evidenceRoot }) => {
    withRenderedContext(({ packetPath: v4PacketPath, contextPath: v4ContextPath }) => {
      const previousPath = process.env.PATH;
      const previousEvidenceRoot = process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
      try {
        process.env.PATH = authorityPath;
        process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = evidenceRoot;
        assert.equal(
          process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR,
          evidenceRoot,
          "redirect rejection must run under the outer v5 control-evidence root",
        );
        assert.equal(
          process.env.PATH,
          authorityPath,
          "redirect rejection must run under the outer v5 immutable authority",
        );
        const trustedAuthorization = authorizeSecondReviewPacketFile({ contextPath });
        const context = trustedAuthorization.context;
        const v4Context = readContext(v4ContextPath);
        assert.equal(trustedAuthorization.data.schema_version, "devpro-second-review-data/v5");
        assert.equal(trustedAuthorization.context.packet_path, context.packet_path);
        assert.equal(
          parseCanonicalSecondReviewPacketData(readFileSync(v4PacketPath)).schema_version,
          "devpro-second-review-data/v4",
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
        const redirected = readContext(contextPath);
        redirected.packet_path = v4PacketPath;
        redirected.page_window_checkpoint_handoff = false;
        redirected.reviewer_cli_recipe = v4Context.reviewer_cli_recipe;
        writeFileSync(contextPath, JSON.stringify(redirected), "utf8");
        assert.equal(readContext(contextPath).packet_path, v4PacketPath);

        const result = acknowledgeProjectionHandoff(contextPath, { trustedAuthorization });
        const effects = artifactPaths.filter((artifactPath) => (
          !readFileSync(artifactPath).equals(before.get(artifactPath))
        )).map((artifactPath) => path.relative(carrierDir, artifactPath));

        assert.deepEqual({
          status: result.status,
          classification: result.classification,
          error: result.error,
          effects,
        }, {
          status: "blocked",
          classification: "reviewer_dispatch_identity_collision",
          error: "second-review trusted authorization failed: reviewer_dispatch_identity_collision",
          effects: [],
        });
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousEvidenceRoot === undefined) {
          delete process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
        } else {
          process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = previousEvidenceRoot;
        }
      }
    });
  }, largeValidHandoff());
});

// D7 (T4, R7) — external-evaluator dispatches must be typed-rejected before any mutation
// (activity append, heartbeat refresh). This simulates the external context shape D1
// promises by mutating a renderer-produced runner context rather than actually rendering
// an external ticket — this test is about ack's own pre-mutation gate, not about
// exercising the renderer's external-dispatch path (covered elsewhere).
test("ack-second-reviewer-projection rejects external-evaluator dispatch before any mutation (D7)", () => {
  withRenderedContext(({ contextPath }) => {
    const context = readContext(contextPath);
    const activityBefore = readFileSync(context.activity_log_path, "utf8");
    const heartbeatBefore = readFileSync(context.heartbeat_path, "utf8");

    // D1's dispatch record identity gate (authorizeSecondReviewPacketFile, already landed
    // by T1/T2) structurally validates every external field once executor_kind is present,
    // regardless of D7 — so the fixture must be a shape-valid external record. reviewer_family
    // is left untouched: it is compared verbatim against the packet-embedded review data.
    context.executor_kind = "external-evaluator";
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

    const result = runAck(contextPath);
    assert.equal(result.status, 1, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.status, "blocked");
    assert.equal(stdout.classification, "external_evaluator_dispatch_not_runnable");
    assert.equal(
      readFileSync(context.activity_log_path, "utf8"),
      activityBefore,
      "activity log bytes must be unchanged"
    );
    assert.equal(
      readFileSync(context.heartbeat_path, "utf8"),
      heartbeatBefore,
      "heartbeat bytes must be unchanged"
    );
  });
});
