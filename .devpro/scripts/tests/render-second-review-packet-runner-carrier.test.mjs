import "./lib/model-probe-fixture.mjs";
/**
 * Renderer host-branching tests for the D2 repo-root-relative Claude Code
 * host runner carrier (add-second-reviewer-runner-permission T3; design.md
 * D1, D2, D4, D9 scenarios 1-2).
 *
 * Implemented in T4; kept here as a regression test. The renderer emits the
 * D2 relative carrier for `projection_runner_command` only when the Claude
 * Code host env markers are present (design.md D1 point 1's priority rule);
 * `projection_bootstrap_command` always stays absolute (design.md D4: no
 * Claude Code exception for the bootstrap carrier).
 *
 * This file does NOT import
 * `.devpro/scripts/lib/projection-runner-carrier.mjs`; the D2 literals below
 * are hand-written from design.md.
 */
import "./lib/portable-command-shims.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
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
import { claudeCodeHostEnv, envWithoutHostMarkers, validSessionId } from "./lib/host-session-env.mjs";

process.env.DEVPRO_ALLOW_CLAUDE_EFFORT_STUB ??= "1";
process.env.DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB ??= "xhigh";

const renderer = repoPath(".devpro/scripts/render-second-review-packet.mjs");
const liveCanonicalCarrierRoot = path.join(path.dirname(deriveMainCheckoutNotesTmp(REPO_ROOT)), "cross-review");
const absoluteBootstrapScriptPath = path.join(REPO_ROOT, ".devpro/scripts/ack-second-reviewer-projection.mjs");
const absoluteRunnerScriptPath = path.join(REPO_ROOT, ".devpro/scripts/run-second-reviewer-projection.mjs");
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
  scope_summary: "bounded local runner-carrier host smoke",
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

function render(dir, env) {
  const handoffPath = path.join(dir, "handoff.json");
  writeFileSync(handoffPath, JSON.stringify(auditHandoff), "utf8");
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
      env: {
        ...env,
        DEVPRO_ALLOW_CLAUDE_EFFORT_STUB: "1",
        DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB: "xhigh",
        DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(dir, "control-evidence"),
        DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(dir, "post-pr-completion-state"),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const packetPath = result.stdout.trim();
  assertAttemptUnderOwnedRoot(packetPath, prepared.ownedCarrierRoot);
  const contextPath = path.join(path.dirname(packetPath), "observability-context.json");
  return JSON.parse(readFileSync(contextPath, "utf8"));
}

// ---------------------------------------------------------------------------
// D9 scenario 1 — Claude Code host renders the repo-root-relative runner
// carrier; bootstrap stays absolute (design.md D4: no Claude Code exception
// for projection_bootstrap_command).
// ---------------------------------------------------------------------------
// Scenario: Claude Code host renders the repo-root-relative runner carrier
test(
  "Claude Code host renders the D2 repo-root-relative runner carrier; bootstrap stays absolute (design.md D1/D2/D4, D9 scenario 1)",
  async () => {
    await withTempDir(
      async (dir) => {
        const context = render(dir, claudeCodeHostEnv());
        assert.deepEqual(context.projection_bootstrap_command, {
          executable: process.execPath,
          argv: [absoluteBootstrapScriptPath, path.resolve(context.observability_context_path)],
        });
        assert.deepEqual(context.projection_runner_command, {
          executable: "node",
          argv: [relativeRunnerScriptLiteral, path.resolve(context.observability_context_path)],
        });
      },
      { prefix: "second-review-render-runner-carrier-claude-host-" },
    );
  },
);

// ---------------------------------------------------------------------------
// D9 scenario 2 — non-Claude-Code hosts keep the absolute runner carrier,
// even with a Codex/Cursor marker PLUS a valid CLAUDE_CODE_SESSION_ID present
// at once (design.md D1 point 1's priority rule; env inheritance residual
// F-r1-01; the OpenCode markers are covered by the dedicated D21 scenario
// tests further below). Implemented in T4; kept here as a regression test.
// ---------------------------------------------------------------------------
const nonClaudeHostEnvCases = [
  ["no host markers at all", envWithoutHostMarkers()],
  ["DEVPRO_POST_PR_COMPLETION_SESSION_ID alone (not positive Claude-Code-host evidence)", {
    ...envWithoutHostMarkers(),
    DEVPRO_POST_PR_COMPLETION_SESSION_ID: validSessionId(),
  }],
  ["CODEX_THREAD_ID plus a valid CLAUDE_CODE_SESSION_ID", {
    ...envWithoutHostMarkers(),
    CODEX_THREAD_ID: "thread-1",
    CLAUDE_CODE_SESSION_ID: validSessionId(),
  }],
  ["CODEX_CI plus a valid CLAUDE_CODE_SESSION_ID", {
    ...envWithoutHostMarkers(),
    CODEX_CI: "1",
    CLAUDE_CODE_SESSION_ID: validSessionId(),
  }],
  ["CURSOR_TRACE_ID plus a valid CLAUDE_CODE_SESSION_ID", {
    ...envWithoutHostMarkers(),
    CURSOR_TRACE_ID: "trace-1",
    CLAUDE_CODE_SESSION_ID: validSessionId(),
  }],
  ["CURSOR_SESSIONID plus a valid CLAUDE_CODE_SESSION_ID", {
    ...envWithoutHostMarkers(),
    CURSOR_SESSIONID: "session-1",
    CLAUDE_CODE_SESSION_ID: validSessionId(),
  }],
];

// Scenario: Non-Claude-Code hosts keep the absolute runner carrier byte-for-byte
for (const [name, env] of nonClaudeHostEnvCases) {
  test(
    `Non-Claude-Code host keeps the absolute runner carrier: ${name} (design.md D1/D9 scenario 2)`,
    async () => {
      await withTempDir(
        async (dir) => {
          const context = render(dir, env);
          assert.deepEqual(context.projection_runner_command, {
            executable: process.execPath,
            argv: [absoluteRunnerScriptPath, path.resolve(context.observability_context_path)],
          });
        },
        { prefix: "second-review-render-runner-carrier-non-claude-host-" },
      );
    },
  );
}

// ---------------------------------------------------------------------------
// D21 (post-PR cross-model round 1) — an OpenCode host whose command
// environment inherited a valid CLAUDE_CODE_SESSION_ID from the process that
// launched it keeps the absolute runner carrier. OPENCODE_TERMINAL is written
// by OpenCode's own shell service into the environment of every command it
// runs; DEVPRO_HOOK_HOST=opencode is this repo's own host declaration
// (run-hook.mjs --host=opencode). No Codex marker is present in either case.
// ---------------------------------------------------------------------------
const openCodeInheritedClaudeMarkerCases = [
  ["OPENCODE_TERMINAL", { OPENCODE_TERMINAL: "1" }],
  ["DEVPRO_HOOK_HOST=opencode", { DEVPRO_HOOK_HOST: "opencode" }],
];

// Scenario: Host with a shell-service marker that inherits a Claude session marker keeps the absolute runner carrier
for (const [name, marker] of openCodeInheritedClaudeMarkerCases) {
  test(
    `Host with a shell-service marker that inherits a Claude session marker keeps the absolute runner carrier: ${name} (D21)`,
    async () => {
      await withTempDir(
        async (dir) => {
          const context = render(dir, {
            ...envWithoutHostMarkers(),
            ...marker,
            CLAUDE_CODE_SESSION_ID: validSessionId(),
          });
          assert.deepEqual(context.projection_runner_command, {
            executable: process.execPath,
            argv: [absoluteRunnerScriptPath, path.resolve(context.observability_context_path)],
          });
          assert.deepEqual(context.projection_bootstrap_command, {
            executable: process.execPath,
            argv: [absoluteBootstrapScriptPath, path.resolve(context.observability_context_path)],
          });
        },
        { prefix: "second-review-render-runner-carrier-opencode-host-" },
      );
    },
  );
}
