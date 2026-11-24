/**
 * Tests for `.devpro/scripts/lib/projection-runner-carrier.mjs`
 * (add-second-reviewer-runner-permission T3; design.md D1-D3; T4 implements the lib).
 *
 * Implemented in T4; kept here as a regression test. Each `test()` below runs
 * against design.md D1 (host detection) and D3 (canonical carrier
 * construction + classification).
 *
 * Renderer/ack/runner/process-level behavior tests deliberately live in OTHER files
 * (render-second-review-packet-runner-carrier.test.mjs,
 * ack-second-reviewer-projection.test.mjs, run-second-reviewer-projection-runner-carrier.test.mjs)
 * and do NOT import this lib.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  canonicalProjectionRunnerCarriers,
  classifyProjectionRunnerCarrier,
  isClaudeCodeRendererHost,
  PROJECTION_RUNNER_RELATIVE_EXECUTABLE_LITERAL,
} from "../lib/projection-runner-carrier.mjs";
import { envWithoutHostMarkers, validSessionId } from "./lib/host-session-env.mjs";

const runnerScriptAbsPath = "/repo/.devpro/scripts/run-second-reviewer-projection.mjs";
const contextPath = "/repo/notes/cross-review/attempt-1/observability-context.json";
const execPath = "/usr/bin/node-real";
const relativeRunnerScriptLiteral = ".devpro/scripts/run-second-reviewer-projection.mjs";

function baseEnv(overrides = {}) {
  return { ...envWithoutHostMarkers(), ...overrides };
}

// ---------------------------------------------------------------------------
// D1 — isClaudeCodeRendererHost(env) host detection matrix.
//
// Codex/Cursor/OpenCode markers win over CLAUDE_CODE_SESSION_ID even when
// both are present (design.md D1 point 1, design-review round-1 finding
// F-r1-01: the var can be an inherited-but-stale residual from a parent
// Claude Code session, not evidence the CURRENT host is Claude Code; the
// OpenCode markers were added for post-PR cross-model round 1, decisions.md
// D21).
// DEVPRO_POST_PR_COMPLETION_SESSION_ID, CLAUDE_SESSION_ID,
// CLAUDE_CONVERSATION_ID, and the provider-neutral DEVPRO_HOST_SESSION_ID are
// identity hints elsewhere in this repo (session-usage-manifest.mjs
// captureTlHostSession) but are explicitly NOT host evidence for this
// predicate (design.md D1 point 2 and "未採用的做法").
// ---------------------------------------------------------------------------
const hostMatrixCases = [
  ["no markers at all", baseEnv(), false],
  ["empty env object", {}, false],
  ["valid CLAUDE_CODE_SESSION_ID alone", baseEnv({ CLAUDE_CODE_SESSION_ID: validSessionId() }), true],
  ["invalid-shape CLAUDE_CODE_SESSION_ID", baseEnv({ CLAUDE_CODE_SESSION_ID: "not-a-uuid" }), false],
  ["CODEX_THREAD_ID alone", baseEnv({ CODEX_THREAD_ID: "thread-1" }), false],
  [
    "CODEX_THREAD_ID plus a valid CLAUDE_CODE_SESSION_ID (inherited residual, F-r1-01)",
    baseEnv({ CODEX_THREAD_ID: "thread-1", CLAUDE_CODE_SESSION_ID: validSessionId() }),
    false,
  ],
  ["CODEX_CI alone", baseEnv({ CODEX_CI: "1" }), false],
  [
    "CODEX_CI plus a valid CLAUDE_CODE_SESSION_ID (inherited residual, F-r1-01)",
    baseEnv({ CODEX_CI: "1", CLAUDE_CODE_SESSION_ID: validSessionId() }),
    false,
  ],
  ["DEVPRO_HOOK_HOST=codex alone", baseEnv({ DEVPRO_HOOK_HOST: "codex" }), false],
  [
    "DEVPRO_HOOK_HOST=codex plus a valid CLAUDE_CODE_SESSION_ID (inherited residual, F-r1-01)",
    baseEnv({ DEVPRO_HOOK_HOST: "codex", CLAUDE_CODE_SESSION_ID: validSessionId() }),
    false,
  ],
  ["CODEX_SESSION_ID alone", baseEnv({ CODEX_SESSION_ID: validSessionId() }), false],
  [
    "CODEX_SESSION_ID plus a valid CLAUDE_CODE_SESSION_ID (inherited residual, F-r1-01)",
    baseEnv({ CODEX_SESSION_ID: validSessionId(), CLAUDE_CODE_SESSION_ID: validSessionId() }),
    false,
  ],
  ["CURSOR_TRACE_ID alone", baseEnv({ CURSOR_TRACE_ID: "trace-1" }), false],
  [
    "CURSOR_TRACE_ID plus a valid CLAUDE_CODE_SESSION_ID (inherited residual, F-r1-01)",
    baseEnv({ CURSOR_TRACE_ID: "trace-1", CLAUDE_CODE_SESSION_ID: validSessionId() }),
    false,
  ],
  ["CURSOR_SESSIONID alone", baseEnv({ CURSOR_SESSIONID: "session-1" }), false],
  [
    "CURSOR_SESSIONID plus a valid CLAUDE_CODE_SESSION_ID (inherited residual, F-r1-01)",
    baseEnv({ CURSOR_SESSIONID: "session-1", CLAUDE_CODE_SESSION_ID: validSessionId() }),
    false,
  ],
  ["OPENCODE_TERMINAL alone", baseEnv({ OPENCODE_TERMINAL: "1" }), false],
  [
    "OPENCODE_TERMINAL plus a valid CLAUDE_CODE_SESSION_ID (OpenCode shell env inheriting a Claude session, D21)",
    baseEnv({ OPENCODE_TERMINAL: "1", CLAUDE_CODE_SESSION_ID: validSessionId() }),
    false,
  ],
  ["DEVPRO_HOOK_HOST=opencode alone", baseEnv({ DEVPRO_HOOK_HOST: "opencode" }), false],
  [
    "DEVPRO_HOOK_HOST=opencode plus a valid CLAUDE_CODE_SESSION_ID (inherited residual, D21)",
    baseEnv({ DEVPRO_HOOK_HOST: "opencode", CLAUDE_CODE_SESSION_ID: validSessionId() }),
    false,
  ],
  [
    "empty OPENCODE_TERMINAL plus a valid CLAUDE_CODE_SESSION_ID (a blank value is not a marker)",
    baseEnv({ OPENCODE_TERMINAL: "", CLAUDE_CODE_SESSION_ID: validSessionId() }),
    true,
  ],
  [
    "DEVPRO_HOST_SESSION_ID plus a valid CLAUDE_CODE_SESSION_ID (provider-neutral identity hint, not host evidence, D21)",
    baseEnv({ DEVPRO_HOST_SESSION_ID: "ses_neutral01", CLAUDE_CODE_SESSION_ID: validSessionId() }),
    true,
  ],
  [
    "DEVPRO_POST_PR_COMPLETION_SESSION_ID alone is NOT positive Claude-Code-host evidence",
    baseEnv({ DEVPRO_POST_PR_COMPLETION_SESSION_ID: validSessionId() }),
    false,
  ],
  ["CLAUDE_SESSION_ID alone (identity hint, not the real CLI host marker)", baseEnv({ CLAUDE_SESSION_ID: validSessionId() }), false],
  [
    "CLAUDE_CONVERSATION_ID alone (identity hint, not the real CLI host marker)",
    baseEnv({ CLAUDE_CONVERSATION_ID: validSessionId() }),
    false,
  ],
];

for (const [name, env, expected] of hostMatrixCases) {
  test(`isClaudeCodeRendererHost: ${name} -> ${expected}`, () => {
    assert.equal(isClaudeCodeRendererHost(env), expected, name);
  });
}

// ---------------------------------------------------------------------------
// D3 — canonicalProjectionRunnerCarriers + classifyProjectionRunnerCarrier.
// ---------------------------------------------------------------------------
test("canonicalProjectionRunnerCarriers returns the exact D2 absolute and repo-relative shapes", () => {
  const canonical = canonicalProjectionRunnerCarriers({ runnerScriptAbsPath, contextPath, execPath });
  assert.deepEqual(canonical.absolute, {
    executable: execPath,
    argv: [runnerScriptAbsPath, path.resolve(contextPath)],
  });
  assert.deepEqual(canonical.repoRelative, {
    executable: "node",
    argv: [relativeRunnerScriptLiteral, path.resolve(contextPath)],
  });
});

// F-pr-r1-07 (design.md D2 SSOT): the lib exports the fixed executable
// literal, and canonicalProjectionRunnerCarriers's own repoRelative shape
// self-consistently uses that same exported constant rather than a second
// inline copy of "node".
test("PROJECTION_RUNNER_RELATIVE_EXECUTABLE_LITERAL pins the D2 repo-relative executable literal", () => {
  assert.equal(PROJECTION_RUNNER_RELATIVE_EXECUTABLE_LITERAL, "node");
  const canonical = canonicalProjectionRunnerCarriers({ runnerScriptAbsPath, contextPath, execPath });
  assert.equal(canonical.repoRelative.executable, PROJECTION_RUNNER_RELATIVE_EXECUTABLE_LITERAL);
});

// Scenario: Validators accept exactly two canonical runner carriers
test("classifyProjectionRunnerCarrier accepts exactly the two canonical shapes", () => {
  const canonical = canonicalProjectionRunnerCarriers({ runnerScriptAbsPath, contextPath, execPath });
  assert.equal(classifyProjectionRunnerCarrier(canonical.absolute, canonical), "absolute");
  assert.equal(classifyProjectionRunnerCarrier(canonical.repoRelative, canonical), "repo-relative");
});

// design.md D3: "以下形狀一律 null: legacy string、多餘或缺少 argv、node 配絕對腳本路徑、
// process.execPath 配相對腳本路徑".
const rejectCases = [
  ["legacy string", `node ${runnerScriptAbsPath}`],
  ["null", null],
  ["array instead of object", [runnerScriptAbsPath, path.resolve(contextPath)]],
  ["node executable with absolute script path (mixed shape)", {
    executable: "node",
    argv: [runnerScriptAbsPath, path.resolve(contextPath)],
  }],
  ["process.execPath with repo-relative script path (mixed shape)", {
    executable: execPath,
    argv: [relativeRunnerScriptLiteral, path.resolve(contextPath)],
  }],
  ["missing argv element", { executable: "node", argv: [relativeRunnerScriptLiteral] }],
  ["extra argv element", {
    executable: "node",
    argv: [relativeRunnerScriptLiteral, path.resolve(contextPath), "--tampered"],
  }],
  ["extra own key beside argv/executable", {
    executable: "node",
    argv: [relativeRunnerScriptLiteral, path.resolve(contextPath)],
    extra: true,
  }],
];

for (const [name, actual] of rejectCases) {
  test(`classifyProjectionRunnerCarrier rejects ${name}`, () => {
    const canonical = canonicalProjectionRunnerCarriers({ runnerScriptAbsPath, contextPath, execPath });
    assert.equal(classifyProjectionRunnerCarrier(actual, canonical), null, name);
  });
}
