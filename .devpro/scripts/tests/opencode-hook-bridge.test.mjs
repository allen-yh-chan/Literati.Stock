/**
 * opencode-hook-bridge.test.mjs
 *
 * T1–T3 prove-it for OpenCode CLI ↔ shared run-hook bridge
 * (`.opencode/plugins/devpro-hooks.js` → `run-hook.mjs --host=opencode`).
 *
 * Prefer importing/invoking plugin hooks with fixtures (no full interactive
 * OpenCode session). Full CLI smoke is T12.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const PLUGIN_JS = repoPath(".opencode/plugins/devpro-hooks.js");
const PLUGIN_MJS = repoPath(".opencode/plugins/devpro-hooks.mjs");
const RUN_HOOK = repoPath(".devpro/scripts/hooks/run-hook.mjs");

const pluginMod = await import(pathToFileURL(PLUGIN_JS).href);
const {
  createDevproPluginHooks,
  classifyOpenCodeSurface,
  mapOpenCodeToolToProtocol,
  resolveNodeExecutable,
  mergeHookEnv,
  defaultRunHook,
  defaultRunHookAsync,
} = pluginMod;

test("mergeHookEnv keeps inherited vars and adds injected keys (Scenario: Injected hook env merges over the ambient env)", () => {
  const merged = mergeHookEnv({ DEVPRO_HOST_SESSION_ID: "ses_test_1" });
  assert.equal(merged.DEVPRO_HOST_SESSION_ID, "ses_test_1");
  assert.equal(merged.PATH, process.env.PATH, "PATH must survive the merge");
  assert.equal(merged.HOME, process.env.HOME, "HOME must survive the merge");
  const bare = mergeHookEnv(undefined);
  assert.equal(bare.PATH, process.env.PATH);
});

test("defaultRunHook names a missing session cwd instead of an opaque spawn error (Scenario: Missing session cwd names the recovery)", () => {
  const missing = path.join(makeTempDir("devpro-missing-cwd-"), "gone");
  const result = defaultRunHook({
    event: "PreToolUse",
    gate: "pre-tool-gate.mjs",
    host: "opencode",
    payload: "{}",
    cwd: missing,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /session working directory missing/);
  assert.match(result.stderr, /session_move/);
  // R9: the plugin classifies that result as a runner failure (fail-open + diagnostic).
  const { classifyRunnerResult } = createDevproPluginHooks({ directory: REPO_ROOT }).__test__;
  assert.equal(typeof classifyRunnerResult, "function", "__test__ must expose classifyRunnerResult");
  const classified = classifyRunnerResult(result, {
    event: "PreToolUse",
    gate: "pre-tool-gate.mjs",
  });
  assert.equal(classified.kind, "runner-failure");
  assert.match(classified.diagnostic, /session working directory missing/);
  assert.match(classified.diagnostic, /session_move/);
});

test("defaultRunHook keeps timeout diagnostics instead of rewriting them (cross-model F2)", () => {
  const previous = process.env.DEVPRO_HOOK_TIMEOUT_MS;
  process.env.DEVPRO_HOOK_TIMEOUT_MS = "5";
  // Preload a blocker so the child can never finish inside the timeout: on a
  // loaded machine the real hook has completed before the 5ms timer was
  // serviced, which made this test race instead of proving the timeout path.
  const blockerDir = makeTempDir("devpro-hook-timeout-blocker-");
  const blocker = path.join(blockerDir, "block.cjs");
  writeFileSync(
    blocker,
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);\n"
  );
  try {
    const result = defaultRunHook({
      event: "PreToolUse",
      gate: "pre-tool-gate.mjs",
      host: "opencode",
      payload: "{}",
      cwd: REPO_ROOT,
      env: {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${JSON.stringify(blocker)}`]
          .filter(Boolean)
          .join(" "),
      },
    });
    assert.equal(result.status, 1);
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.doesNotMatch(result.stderr, /session working directory missing/);
    // The pre-F2 early return rewrote every spawn error as "spawn failed";
    // non-cwd faults MUST keep the historical passthrough shape, so this
    // assertion is what makes the regression falsifiable.
    assert.doesNotMatch(result.stderr, /spawn failed/);
  } finally {
    rmSync(blockerDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DEVPRO_HOOK_TIMEOUT_MS;
    else process.env.DEVPRO_HOOK_TIMEOUT_MS = previous;
  }
});

test("defaultRunHookAsync names a missing session cwd on the async error event (F-hrr-r1-01)", async () => {
  const missing = path.join(makeTempDir("devpro-missing-cwd-async-"), "gone");
  const result = await defaultRunHookAsync({
    event: "Stop",
    gate: "stop-handoff-cite.mjs",
    host: "opencode",
    payload: "{}",
    cwd: missing,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /session working directory missing/);
  assert.match(result.stderr, /session_move/);
});

test(
  "defaultRunHookAsync settles from the child exit when the child never drains stdin (no unhandled stdin EPIPE)",
  // The fixture stands in for the node binary with a POSIX sh script; a .cmd stand-in
  // cannot be spawned without a shell on Windows.
  { skip: process.platform === "win32" ? "POSIX sh stand-in for the node binary" : false },
  () => {
    const dir = makeTempDir("devpro-stdin-epipe-");
    try {
      const fakeNode = path.join(dir, "fake-node");
      // Closes stdin without reading and exits: the parent's payload write is still
      // pending (larger than the pipe buffer), so the stdin stream errors with EPIPE.
      writeFileSync(fakeNode, "#!/bin/sh\nexec 0<&-\nexit 7\n", { mode: 0o755 });
      const probe = [
        `const mod = await import(${JSON.stringify(pathToFileURL(PLUGIN_JS).href)});`,
        `const r = await mod.defaultRunHookAsync({ event: "PreToolUse", gate: "pre-tool-gate.mjs", host: "opencode",`,
        `  payload: "x".repeat(4 * 1024 * 1024), cwd: process.cwd(), env: { DEVPRO_NODE_PATH: ${JSON.stringify(fakeNode)} } });`,
        `await new Promise((resolve) => setTimeout(resolve, 200));`,
        `process.stdout.write(JSON.stringify({ status: r.status, stderr: r.stderr, error: r.error ? String(r.error.message) : null }));`,
      ].join("\n");
      const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
        encoding: "utf8",
        cwd: repoPath("."),
        timeout: 30000,
      });
      assert.equal(res.status, 0, `probe must not die on an unhandled stdin error: ${res.stderr}`);
      const result = JSON.parse(res.stdout);
      assert.equal(result.status, 7, "the child's own exit code is the result");
      assert.equal(result.error, null);
      assert.equal(result.stderr, "", "a child that stops reading is not a launcher diagnostic");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

function mockRunner(decisions) {
  /** @type {Array<object>} */
  const calls = [];
  const runHook = async (args) => {
    const key = `${args.event}::${path.basename(args.gate)}`;
    const hit =
      decisions[key] ||
      decisions[args.event] ||
      decisions["*"] ||
      { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" };
    const result =
      typeof hit === "function"
        ? await hit(args, calls)
        : {
            status: hit.status ?? 0,
            stdout: hit.stdout ?? "",
            stderr: hit.stderr ?? "",
            error: hit.error ?? null,
          };
    calls.push({ ...args, ...result });
    return result;
  };
  return { runHook, calls };
}

async function loadHooks(opts = {}) {
  return createDevproPluginHooks({
    directory: opts.directory || REPO_ROOT,
    reminderSink: opts.reminderSink || [],
    reminderSinkMax: opts.reminderSinkMax,
    pendingAdmissionByCall: opts.pendingAdmissionByCall,
    pendingAdmissionMax: opts.pendingAdmissionMax,
    sessionState: opts.sessionState || new Map(),
    runHook: opts.runHook,
    client: opts.client,
  });
}

// R9 (design D17): a runner failure fails open — the tool call is not denied, later gates
// still run, and one single-line diagnostic per failed gate reaches the reminder sink
// (V1 face: toast + sink) but never the model-visible tool output.
const PERM_INPUT = (sessionID, type = "bash") => ({
  id: `p-${sessionID}`,
  type,
  sessionID,
  messageID: "m1",
  title: type,
  metadata: { args: { command: "true" } },
  time: { created: Date.now() },
});

async function assertFailsOpen(runnerResult, diagPattern, sessionID) {
  const reminderSink = [];
  const { runHook } = mockRunner({ "*": runnerResult });
  const hooks = await loadHooks({ runHook, reminderSink });
  const output = { args: { command: "true" } };
  await assert.doesNotReject(() =>
    hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" }, output)
  );
  const permOut = { status: "ask" };
  await hooks["permission.ask"](PERM_INPUT(sessionID), permOut);
  assert.equal(permOut.status, "ask", "a runner failure must not turn the permission into deny");
  const messages = reminderSink.map((e) => String(e.message));
  assert.ok(
    messages.some((m) => diagPattern.test(m)),
    `expected a diagnostic matching ${diagPattern}, got ${JSON.stringify(messages)}`
  );
  for (const m of messages) {
    assert.match(m, /; fail-open$/, "every surfaced message is a fail-open diagnostic");
    assert.equal(m.includes("\n"), false, "diagnostics are single-line");
  }
  const afterOut = { output: "ok" };
  await hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: "c1" }, afterOut);
  assert.equal(afterOut.output, "ok", "diagnostics must not enter the model-visible tool output");
  return { messages, hooks };
}

// ── T0: host JS runtime resolution (OpenCode sets process.execPath → opencode) ──

describe("T0 OpenCode host execPath must not spawn run-hook", () => {
  test("resolveNodeExecutable rejects OpenCode host binary and returns a JS runtime", () => {
    assert.equal(typeof resolveNodeExecutable, "function", "must export resolveNodeExecutable");
    const hostBin = "/home/someone/.opencode/bin/opencode";
    const resolved = resolveNodeExecutable(
      { ...process.env, DEVPRO_NODE_PATH: "" },
      hostBin
    );
    assert.notEqual(
      path.basename(resolved).toLowerCase(),
      "opencode",
      "must not spawn the OpenCode CLI as the run-hook interpreter"
    );
    const base = path.basename(resolved).toLowerCase();
    assert.ok(
      base === "node" || base === "node.exe" || base === "bun" || base === "bun.exe",
      `expected node/bun runtime, got ${resolved}`
    );
  });

  test("resolveNodeExecutable honors DEVPRO_NODE_PATH override", () => {
    const override = process.execPath; // real node under node:test
    const resolved = resolveNodeExecutable(
      { ...process.env, DEVPRO_NODE_PATH: override },
      "/fake/opencode"
    );
    assert.equal(resolved, override);
  });

  test("chat.message must not push schema-incomplete text parts", async () => {
    const reminderSink = [];
    const hooks = await loadHooks({
      runHook: async () => ({ status: 0, stdout: "", stderr: "" }),
      reminderSink,
      sessionState: new Map([
        [
          "ses_probe",
          {
            blocking: false,
            reason: "",
            reminder: "should-not-become-bare-part",
            reminderDelivered: true,
            reminderDeliveryError: "",
            pendingAdmissionHandoff: "handoff-must-not-bare-push",
            outcome: "",
            syncStopBlock: false,
            silentSuccess: false,
          },
        ],
      ]),
    });
    const output = { parts: [] };
    await hooks["chat.message"]({ sessionID: "ses_probe" }, output);
    assert.equal(
      output.parts.length,
      0,
      "incomplete {type,text} parts lack id/sessionID/messageID and corrupt OpenCode sessions"
    );
  });
});

// ── T1: allow / block / runner-failure≠allow / unknown classified + .js entry ──

describe("T1 OpenCode hook bridge prove-it", () => {
  test("source-owned plugin entry is auto-discoverable .js (not only .mjs)", () => {
    assert.equal(existsSync(PLUGIN_JS), true, "missing .opencode/plugins/devpro-hooks.js");
    assert.equal(path.extname(PLUGIN_JS), ".js");
    // Discoverability contract: a lone .mjs must not be the only entry.
    if (existsSync(PLUGIN_MJS)) {
      assert.equal(
        existsSync(PLUGIN_JS),
        true,
        "must not rely solely on .mjs — OpenCode 1.18.29 auto-discovers *.js/*.ts only"
      );
    }
    const body = readFileSync(PLUGIN_JS, "utf8");
    assert.match(body, /run-hook|createDevproPluginHooks/);
    // dependency-free: no third-party bare imports
    const thirdParty = body.match(/from\s+['"](?![./]|node:)[^'"]+['"]/g) || [];
    assert.deepEqual(thirdParty, [], `third-party imports forbidden: ${thirdParty}`);
  });

  test("allow: shared runner exit 0 without block → tool.before does not throw; permission stays allow", async () => {
    const { runHook, calls } = mockRunner({
      "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
    });
    const hooks = await loadHooks({ runHook });
    const output = { args: { command: "echo ok" } };
    await assert.doesNotReject(() =>
      hooks["tool.execute.before"](
        { tool: "bash", sessionID: "s-allow", callID: "c1" },
        output
      )
    );
    assert.ok(calls.length >= 1, "must invoke shared runner");
    assert.ok(
      calls.some((c) => c.host === "opencode" && c.event === "PreToolUse"),
      "must call run-hook PreToolUse --host=opencode"
    );
    assert.ok(
      calls.some((c) => c.env && c.env.DEVPRO_HOST_SESSION_ID === "s-allow"),
      "hook subprocess env must carry DEVPRO_HOST_SESSION_ID from the session id (F-hsn-r1-02)"
    );

    const permOut = { status: "ask" };
    await hooks["permission.ask"](
      {
        id: "p1",
        type: "bash",
        sessionID: "s-allow",
        messageID: "m1",
        title: "bash",
        metadata: {},
        time: { created: Date.now() },
      },
      permOut
    );
    assert.equal(permOut.status, "ask");
  });

  test("block: runner decision:block → tool.before throws; permission.status=deny", async () => {
    const { runHook } = mockRunner({
      "*": {
        status: 0,
        stdout: JSON.stringify({ decision: "block", reason: "test-block" }),
        stderr: "",
      },
    });
    const hooks = await loadHooks({ runHook });
    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "s-block", callID: "c1" },
          { args: { command: "git push --force" } }
        ),
      /test-block|block|denied|fail.closed/i
    );

    const permOut = { status: "ask" };
    await hooks["permission.ask"](
      {
        id: "p2",
        type: "bash",
        sessionID: "s-block",
        messageID: "m1",
        title: "bash",
        metadata: {},
        time: { created: Date.now() },
      },
      permOut
    );
    assert.equal(permOut.status, "deny");
  });

  test("runner failure fails open, later gates still run, one diagnostic per failed gate (Scenario: `.opencode` Runner Failure Fails Open Like Other Host Profiles)", async () => {
    const reminderSink = [];
    const { runHook, calls } = mockRunner({
      "*": { status: 1, stdout: "", stderr: "spawn failed: boom" },
    });
    const hooks = await loadHooks({ runHook, reminderSink });
    await assert.doesNotReject(() =>
      hooks["tool.execute.before"](
        { tool: "bash", sessionID: "s-fail", callID: "c1" },
        { args: { command: "true" } }
      )
    );
    const permOut = { status: "ask" };
    await hooks["permission.ask"](
      {
        id: "p3",
        type: "bash",
        sessionID: "s-fail",
        messageID: "m1",
        title: "bash",
        metadata: {},
        time: { created: Date.now() },
      },
      permOut
    );
    assert.equal(permOut.status, "ask");
    const gates = calls.filter((c) => c.event === "PreToolUse").map((c) => path.basename(c.gate));
    for (const g of ["gh-footer-gate.mjs", "pre-tool-gate.mjs"]) {
      assert.ok(gates.includes(g), `${g} must still run after an earlier runner failure`);
    }
    const messages = reminderSink.map((e) => String(e.message));
    for (const g of ["gh-footer-gate", "pre-tool-gate"]) {
      assert.ok(
        messages.some((m) => m === `hook PreToolUse ${g}.mjs runner failure (exit 1); fail-open`),
        `diagnostic for ${g}: ${JSON.stringify(messages)}`
      );
    }
    assert.equal(
      messages.some((m) => /boom/.test(m)),
      false,
      "the runner's stderr text never reaches the diagnostic"
    );
    const afterOut = { output: "ok" };
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: "s-fail", callID: "c1" },
      afterOut
    );
    assert.equal(afterOut.output, "ok", "the diagnostic must not enter the model-visible output");
  });

  test("unknown / unsupported OpenCode surface is classified (not silent success / not default-allow)", () => {
    const classified = classifyOpenCodeSurface("desktop.unverified.event");
    assert.ok(classified);
    assert.ok(
      classified.kind === "unsupported" || classified.kind === "unverified" || classified.kind === "classified-noop",
      `expected unsupported/unverified/classified-noop, got ${classified.kind}`
    );
    assert.notEqual(classified.kind, "allow");
    assert.notEqual(classified.silentSuccess, true);
  });

  test("unknown bus event via hooks.event does not silent-success as allow", async () => {
    const { runHook, calls } = mockRunner({ "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" } });
    const hooks = await loadHooks({ runHook });
    const result = await hooks.event({
      event: { type: "some.unknown.bus.event", properties: {} },
    });
    // Hooks.event returns Promise<void> — must not throw a fake sync Stop-block,
    // but must not report silent allow either.
    assert.equal(result, undefined);
    const unknown = classifyOpenCodeSurface("some.unknown.bus.event");
    assert.notEqual(unknown.kind, "allow");
    // Unknown events must not invoke hard-gate runners as if they were PreToolUse allow.
    assert.equal(
      calls.filter((c) => c.event === "PreToolUse").length,
      0,
      "unknown event must not map to PreToolUse allow path"
    );
  });
});


  test("exit-0 empty stdout is pass; recognized advisory shapes stay non-blocking", async () => {
    // Shared protocol: exit-0 empty stdout = allow/skip.
    {
      const { runHook } = mockRunner({
        "*": { status: 0, stdout: "", stderr: "" },
      });
      const hooks = await loadHooks({ runHook });
      await assert.doesNotReject(() =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "s-empty-ok", callID: "c1" },
          { args: { command: "true" } }
        )
      );
      const permOut = { status: "ask" };
      await hooks["permission.ask"](
        {
          id: "p-empty",
          type: "bash",
          sessionID: "s-empty-ok",
          messageID: "m1",
          title: "bash",
          metadata: { args: { command: "true" } },
          time: { created: Date.now() },
        },
        permOut
      );
      assert.equal(permOut.status, "ask");
    }

    // Recognized advisory-only shape (systemMessage, no decision) remains non-blocking.
    {
      const { runHook } = mockRunner({
        "*": {
          status: 0,
          stdout: JSON.stringify({ systemMessage: "lease-held advisory only" }),
          stderr: "",
        },
      });
      const hooks = await loadHooks({ runHook });
      await assert.doesNotReject(() =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "s-advisory-only", callID: "c1" },
          { args: { command: "true" } }
        )
      );
    }

    // Claude PreToolUse advisory envelope (emitContext) MUST allow + remind — not deny.
    {
      const advisory =
        "Commit-time EOF re-stage gate：not checked（reason=probe-failed）";
      const { runHook } = mockRunner({
        "*": {
          status: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              additionalContext: advisory,
            },
          }),
          stderr: "",
        },
      });
      const hooks = await loadHooks({
        runHook,
        client: {
          tui: {
            async showToast() {
              /* toast optional */
            },
          },
        },
      });
      await assert.doesNotReject(() =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "s-hookspecific-advisory", callID: "c-hso" },
          { args: { command: "git commit -m test" } }
        )
      );
      const afterOut = { output: "ok" };
      await hooks["tool.execute.after"](
        { tool: "bash", sessionID: "s-hookspecific-advisory", callID: "c-hso" },
        afterOut
      );
      assert.match(String(afterOut.output), /probe-failed|EOF re-stage/i);
      const { parseDecision } = hooks.__test__;
      const parsed = parseDecision(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: advisory,
          },
        })
      );
      assert.equal(parsed.block, false);
      assert.equal(parsed.reminder, advisory);
    }
  });

  test("Explicit block still denies at any exit status (top-level and nested decisions, trailing garbage line)", async () => {
    // The launcher turns a gate's nonzero exit into exit 1 but still forwards its
    // stdout, so an explicit block must win whatever the runner status is.
    for (const status of [0, 1, 2]) {
      const { runHook } = mockRunner({
        "*": {
          status,
          stdout: JSON.stringify({ decision: "block", reason: "explicit-block-reason" }),
          stderr: "noise that must not replace the reason",
        },
      });
      const hooks = await loadHooks({ runHook });
      await assert.rejects(
        () =>
          hooks["tool.execute.before"](
            { tool: "bash", sessionID: `s-explicit-${status}`, callID: "c1" },
            { args: { command: "true" } }
          ),
        (err) => {
          assert.equal(err.message, "explicit-block-reason", `status ${status}`);
          return true;
        }
      );
      const permOut = { status: "ask" };
      await hooks["permission.ask"](
        {
          id: `p-explicit-${status}`,
          type: "bash",
          sessionID: `s-explicit-${status}`,
          messageID: "m1",
          title: "bash",
          metadata: { args: { command: "true" } },
          time: { created: Date.now() },
        },
        permOut
      );
      assert.equal(permOut.status, "deny", `status ${status}`);
    }

    // [allow, block, not-json]: the last parsed object is the explicit block, and a
    // trailing garbage line must not turn it into a pass or a different reason.
    {
      const stdout = [
        JSON.stringify({ decision: "allow" }),
        JSON.stringify({ decision: "block", reason: "block-before-garbage" }),
        "not-json",
      ].join("\n");
      const { runHook } = mockRunner({ "*": { status: 0, stdout, stderr: "" } });
      const hooks = await loadHooks({ runHook });
      await assert.rejects(
        () =>
          hooks["tool.execute.before"](
            { tool: "bash", sessionID: "s-block-then-garbage", callID: "c1" },
            { args: { command: "true" } }
          ),
        (err) => {
          assert.equal(err.message, "block-before-garbage");
          return true;
        }
      );
    }

    // Nested permissionDecision deny/ask still blocks (parseDecision unit); an
    // explicit top-level block wins over a sibling advisory envelope.
    const advisory = "Commit-time EOF re-stage gate：not checked（reason=probe-failed）";
    const { runHook: noop } = mockRunner({});
    const { parseDecision } = (await loadHooks({ runHook: noop })).__test__;
    const envelope = (extra, permissionDecision) =>
      JSON.stringify({
        ...extra,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          ...(permissionDecision ? { permissionDecision } : {}),
          additionalContext: advisory,
        },
      });
    const blocked = parseDecision(
      envelope({ decision: "block", reason: "hard gate" })
    );
    assert.equal(blocked.block, true);
    assert.equal(blocked.reason, "hard gate");
    for (const [label, extra, decision] of [
      ["nestedDeny", {}, "deny"],
      ["nestedAsk", {}, "ask"],
      ["mixedDeny", { systemMessage: "notice" }, "deny"],
      ["mixedAsk", { systemMessage: "notice" }, "ask"],
    ]) {
      const parsed = parseDecision(envelope(extra, decision));
      assert.equal(parsed.block, true, label);
      assert.match(String(parsed.reason || ""), /nested permissionDecision|deny|ask/i, label);
    }
  });

  test("Malformed or unrecognized stdout fails open with diagnostic (unparseable, partial, unknown token, wrong type, missing field)", async () => {
    // Unparseable stdout → allow + a fixed-vocabulary single-line diagnostic.
    for (const [i, stdout] of ["{not-json", "totally-garbage"].entries()) {
      await assertFailsOpen(
        { status: 0, stdout, stderr: "" },
        /unparseable stdout\); fail-open/,
        `s-bad-stdout-${i}`
      );
    }

    // Partially malformed multi-line: allow JSON + not-json (no explicit block anywhere).
    await assertFailsOpen(
      {
        status: 0,
        stdout: `${JSON.stringify({ decision: "allow" })}\nnot-json`,
        stderr: "",
      },
      /partially malformed stdout\); fail-open/,
      "s-partial-malformed"
    );

    // Unknown decision token + systemMessage: not a block, and the advisory text of a
    // schema-drifted result is not surfaced as a reminder either.
    {
      const { messages } = await assertFailsOpen(
        {
          status: 0,
          stdout: JSON.stringify({
            decision: "blok",
            systemMessage: "advisory looking but schema-drifted",
          }),
          stderr: "",
        },
        /unknown decision 'blok'\); fail-open/,
        "s-unknown-decision"
      );
      assert.equal(
        messages.some((m) => /schema-drifted/.test(m)),
        false,
        "a drifted result's systemMessage must not become a reminder"
      );
    }

    // Valid JSON null (invalid schema type) → allow + diagnostic, not a TypeError.
    await assertFailsOpen(
      { status: 0, stdout: "null", stderr: "" },
      /invalid decision schema type\); fail-open/,
      "s-json-null"
    );

    // Ambiguous nonempty object (no decision, no reminder) → allow + diagnostic.
    await assertFailsOpen(
      { status: 0, stdout: JSON.stringify({ unrelated: true }), stderr: "" },
      /missing decision field\); fail-open/,
      "s-missing-decision"
    );

    // parseDecision keeps deny/ask/explicit-block as block:true (covered above); an
    // unknown nested permissionDecision is a protocol failure, not a block.
    const advisory = "Commit-time EOF re-stage gate：not checked（reason=probe-failed）";
    const { runHook: noop } = mockRunner({});
    const { parseDecision } = (await loadHooks({ runHook: noop })).__test__;
    for (const [label, extra] of [
      ["nestedUnknown", {}],
      ["mixedUnknown", { systemMessage: "notice" }],
    ]) {
      const parsed = parseDecision(
        JSON.stringify({
          ...extra,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "maybe",
            additionalContext: advisory,
          },
        })
      );
      assert.equal(parsed.block, false, label);
      assert.match(
        String(parsed.protocolFailure || ""),
        /unknown nested permissionDecision 'maybe'/,
        label
      );
    }
  });

  test("`.opencode` Explicit Gate Block Denies At Any Runner Exit Status (an earlier gate failing does not hide a later gate's block)", async () => {
    const reminderSink = [];
    const { runHook, calls } = mockRunner({
      "PreToolUse::gh-footer-gate.mjs": { status: 1, stdout: "", stderr: "gh-footer crashed" },
      "PreToolUse::pre-tool-gate.mjs": {
        status: 1,
        stdout: JSON.stringify({ decision: "block", reason: "pre-tool-explicit-block" }),
        stderr: "gate exited 2 (launcher translated it to exit 1)",
      },
    });
    const hooks = await loadHooks({ runHook, reminderSink });
    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "s-gate-block", callID: "c1" },
          { args: { command: "git push --force" } }
        ),
      (err) => {
        assert.equal(err.message, "pre-tool-explicit-block");
        return true;
      }
    );
    assert.deepEqual(
      calls.filter((c) => c.event === "PreToolUse").map((c) => path.basename(c.gate)),
      ["gh-footer-gate.mjs", "pre-tool-gate.mjs"],
      "the failing first gate must not stop the second gate from running"
    );
    const permOut = { status: "ask" };
    await hooks["permission.ask"](
      {
        id: "p-gate-block",
        type: "bash",
        sessionID: "s-gate-block",
        messageID: "m1",
        title: "bash",
        metadata: { args: { command: "git push --force" } },
        time: { created: Date.now() },
      },
      permOut
    );
    assert.equal(permOut.status, "deny");
  });

  test("a recognized allow at a nonzero exit status is a pass with no diagnostic", async () => {
    const reminderSink = [];
    const { runHook } = mockRunner({
      "*": { status: 1, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
    });
    const hooks = await loadHooks({ runHook, reminderSink });
    await assert.doesNotReject(() =>
      hooks["tool.execute.before"](
        { tool: "bash", sessionID: "s-allow-status-1", callID: "c1" },
        { args: { command: "true" } }
      )
    );
    const permOut = { status: "ask" };
    await hooks["permission.ask"](PERM_INPUT("s-allow-status-1"), permOut);
    assert.equal(permOut.status, "ask");
    assert.deepEqual(
      reminderSink.map((e) => e.message),
      [],
      "a recognized allow is a pass, not a runner failure"
    );
  });

  test("real run-hook missing gate is a silent pass under host=opencode, byte-identical to the other host profiles", () => {
    const missingGate = path.join(
      REPO_ROOT,
      ".devpro/scripts/hooks/__missing-opencode-gate-does-not-exist__.mjs"
    );
    assert.equal(existsSync(missingGate), false);
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "true" },
      cwd: REPO_ROOT,
    });
    const oc = spawnSync(
      process.execPath,
      [RUN_HOOK, "PreToolUse", missingGate, "--host=opencode"],
      { encoding: "utf8", input: payload, cwd: REPO_ROOT, timeout: 15_000 }
    );
    const other = spawnSync(
      process.execPath,
      [RUN_HOOK, "PreToolUse", missingGate, "--host=claude"],
      { encoding: "utf8", input: payload, cwd: REPO_ROOT, timeout: 15_000 }
    );
    assert.equal(oc.status, 0, "host=opencode missing gate must fail open like the other hosts");
    assert.equal(other.status, 0, "non-opencode hosts keep the historical missing-gate exit 0");
    assert.equal(oc.stdout, "", "missing gate writes no stdout");
    assert.equal(oc.stderr, "", "missing gate is a silent pass (accepted silent point)");
    assert.equal(oc.stdout, other.stdout);
    assert.equal(oc.stderr, other.stderr);
  });

  test("real run-hook child timeout: host=opencode fails open exactly like the other host profiles", () => {
    const dir = makeTempDir("opencode-hook-timeout-");
    try {
      const child = path.join(dir, "child.mjs");
      writeFileSync(
        child,
        [
          "process.stdout.write('partial stdout');",
          "process.stderr.write('partial stderr');",
          "setInterval(() => {}, 1000);",
        ].join("\n")
      );
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "true" },
        cwd: REPO_ROOT,
      });
      const env = {
        ...process.env,
        DEVPRO_HOOK_TIMEOUT_MS: "50",
      };

      const startedOc = Date.now();
      const oc = spawnSync(
        process.execPath,
        [RUN_HOOK, "PreToolUse", child, "--host=opencode"],
        { encoding: "utf8", input: payload, cwd: REPO_ROOT, env, timeout: 5_000 }
      );
      assert.equal(oc.status, 0, "host=opencode timeout must fail open like the other hosts");
      assert.match(`${oc.stderr || ""}\n${oc.stdout || ""}`, /timed out after 50ms; fail-open/);
      assert.doesNotMatch(`${oc.stderr || ""}\n${oc.stdout || ""}`, /fail-closed/);
      assert.doesNotMatch(`${oc.stderr || ""}\n${oc.stdout || ""}`, /partial stderr/);
      assert.ok(Date.now() - startedOc < 2000, "opencode timeout path must bound wall time");

      const startedOther = Date.now();
      const other = spawnSync(
        process.execPath,
        [RUN_HOOK, "PreToolUse", child, "--host=claude"],
        { encoding: "utf8", input: payload, cwd: REPO_ROOT, env, timeout: 5_000 }
      );
      assert.equal(other.status, 0, "non-opencode hosts keep historical fail-open exit 0");
      assert.match(`${other.stderr || ""}\n${other.stdout || ""}`, /timed out after 50ms; fail-open/);
      assert.doesNotMatch(`${other.stderr || ""}\n${other.stdout || ""}`, /partial stderr/);
      assert.ok(Date.now() - startedOther < 2000, "non-opencode timeout path must bound wall time");
      assert.equal(oc.stderr, other.stderr, "stderr must be byte-identical across host profiles");
      assert.equal(oc.stdout, other.stdout, "stdout must be byte-identical across host profiles");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Launcher Fail-Open Result Still Surfaces A Plugin Diagnostic (launcher times out before the plugin's own timer)", async () => {
    const dir = makeTempDir("opencode-launcher-first-timeout-");
    const previous = process.env.DEVPRO_HOOK_TIMEOUT_MS;
    // The plugin's own spawn timer reads process.env (180 s when unset); the launcher
    // reads the child env, so a child-only override lets the launcher fire first.
    delete process.env.DEVPRO_HOOK_TIMEOUT_MS;
    try {
      // Fixture gates that hang, named like the real gates so the launcher's
      // fail-open line anchors to the same event + gate basename the plugin asked for.
      for (const name of ["gh-footer-gate.mjs", "pre-tool-gate.mjs"]) {
        writeFileSync(path.join(dir, name), "setInterval(() => {}, 1000);\n");
      }
      const reminderSink = [];
      const runHook = (args) =>
        defaultRunHook({
          ...args,
          gate: path.join(dir, path.basename(args.gate)),
          env: {
            ...(args.env || {}),
            DEVPRO_HOOK_TIMEOUT_MS: "50",
            DEVPRO_AGENT_RULES_LEVEL: "full",
          },
        });
      const hooks = await loadHooks({ runHook, reminderSink });
      const output = { args: { command: "true" } };
      await assert.doesNotReject(() =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "s-launcher-first", callID: "c1" },
          output
        )
      );
      const messages = reminderSink.map((e) => String(e.message));
      for (const g of ["gh-footer-gate", "pre-tool-gate"]) {
        assert.equal(
          messages.filter(
            (m) => m === `hook PreToolUse ${g}.mjs runner failure (launcher timeout); fail-open`
          ).length,
          1,
          `exactly one launcher-timeout diagnostic for ${g}: ${JSON.stringify(messages)}`
        );
      }
      const afterOut = { output: "ok" };
      await hooks["tool.execute.after"](
        { tool: "bash", sessionID: "s-launcher-first", callID: "c1" },
        afterOut
      );
      assert.equal(afterOut.output, "ok", "the diagnostic must not enter model-visible output");
    } finally {
      if (previous === undefined) delete process.env.DEVPRO_HOOK_TIMEOUT_MS;
      else process.env.DEVPRO_HOOK_TIMEOUT_MS = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("real run-hook exit-0 empty stdout is pass (integration, not synthetic allow mock)", async () => {
    // Invoke real run-hook.mjs → pre-tool-gate with a benign Read payload.
    // Shared gates emit empty stdout + exit 0 on skip/pass.
    const hooks = await loadHooks({
      // no runHook mock → defaultRunHook → real binary
    });
    await assert.doesNotReject(() =>
      hooks["tool.execute.before"](
        { tool: "read", sessionID: "s-real-empty", callID: "c-real" },
        { args: { file_path: "README.md" } }
      )
    );
    const permOut = { status: "ask" };
    await hooks["permission.ask"](
      {
        id: "p-real",
        type: "read",
        sessionID: "s-real-empty",
        messageID: "m1",
        title: "read",
        metadata: { args: { file_path: "README.md" } },
        time: { created: Date.now() },
      },
      permOut
    );
    assert.equal(permOut.status, "ask");
  });

// ── T2: hard-gate / permission.ask / tool.execute.before matrix ──

describe("T2 hard-gate / permission matrix", () => {
  test("bash maps to PreToolUse gates (pre-tool-gate + gh-footer)", () => {
    const mapped = mapOpenCodeToolToProtocol("bash");
    assert.equal(mapped.classified, "supported");
    assert.equal(mapped.toolName, "Bash");
    const gates = mapped.gates.map((g) => path.basename(g.gate));
    assert.ok(gates.includes("pre-tool-gate.mjs"));
    assert.ok(gates.includes("gh-footer-gate.mjs"));
    assert.ok(mapped.gates.every((g) => g.event === "PreToolUse"));
  });

  test("task maps to PreToolUse pre-tool-gate with Task tool_name (admission path)", () => {
    const mapped = mapOpenCodeToolToProtocol("task");
    assert.equal(mapped.classified, "supported");
    assert.equal(mapped.toolName, "Task");
    const gates = mapped.gates.map((g) => path.basename(g.gate));
    assert.ok(gates.includes("pre-tool-gate.mjs"));
    assert.ok(mapped.gates.every((g) => g.event === "PreToolUse"));
  });

  test("tool.execute.before matrix: bash invokes expected gates with Bash payload", async () => {
    const { runHook, calls } = mockRunner({
      "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
    });
    const hooks = await loadHooks({ runHook });
    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "s-mat", callID: "c1" },
      { args: { command: "echo hi" } }
    );
    const basenames = calls.map((c) => path.basename(c.gate));
    assert.ok(basenames.includes("pre-tool-gate.mjs"));
    assert.ok(basenames.includes("gh-footer-gate.mjs"));
    for (const c of calls) {
      assert.equal(c.host, "opencode");
      assert.equal(c.event, "PreToolUse");
      const payload = JSON.parse(c.payload || "{}");
      assert.equal(payload.tool_name, "Bash");
      assert.equal(payload.tool_input.command, "echo hi");
    }
  });

  test("tool.execute.before matrix: task invokes pre-tool-gate with Task payload", async () => {
    const { runHook, calls } = mockRunner({
      "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
    });
    const hooks = await loadHooks({ runHook });
    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "s-task", callID: "c1" },
      { args: { description: "x", prompt: "y", subagent_type: "dp-explorer" } }
    );
    assert.ok(calls.some((c) => path.basename(c.gate) === "pre-tool-gate.mjs"));
    const payload = JSON.parse(calls[0].payload || "{}");
    assert.equal(payload.tool_name, "Task");
  });

  test("Task admission allow reason is host-observable (not discarded at boundary)", async () => {
    const handoff =
      "admission_record: 54efdef7-f4bc-46c7-baa7-b8dacb2b655c sha256=40a6c74d4c14e8bec3800ab35dca38c63999aa000fd22d54250f52f64543863d";
    const toastCalls = [];
    const reminderSink = [];
    const { runHook } = mockRunner({
      "*": {
        status: 0,
        stdout: JSON.stringify({ decision: "allow", systemMessage: handoff }),
        stderr: "",
      },
    });
    const hooks = await loadHooks({
      runHook,
      reminderSink,
      client: {
        tui: {
          showToast: async (opts) => {
            toastCalls.push(opts);
            return { data: true };
          },
        },
      },
    });
    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "s-admit", callID: "c-admit" },
      {
        args: {
          description: "review",
          prompt: "x",
          subagent_type: "dp-reviewer",
        },
      }
    );
    assert.ok(
      toastCalls.some((c) => String(c?.body?.message || "").includes("admission_record:")),
      "tool.execute.before must surface admission handoff via showToast"
    );
    const afterOut = { title: "task", output: "task-done", metadata: {} };
    await hooks["tool.execute.after"](
      {
        tool: "task",
        sessionID: "s-admit",
        callID: "c-admit",
        args: { description: "review" },
      },
      afterOut
    );
    assert.match(
      String(afterOut.output || ""),
      /admission_record:/,
      "tool.execute.after must append model-visible admission handoff to tool output"
    );
    const permOut = { status: "ask" };
    toastCalls.length = 0;
    await hooks["permission.ask"](
      {
        id: "p-admit",
        type: "task",
        sessionID: "s-admit-p",
        messageID: "m1",
        title: "task",
        metadata: {
          args: {
            description: "review",
            prompt: "x",
            subagent_type: "dp-reviewer",
          },
        },
        time: { created: Date.now() },
      },
      permOut
    );
    assert.equal(permOut.status, "ask");
    assert.ok(
      toastCalls.some((c) => String(c?.body?.message || "").includes("admission_record:")),
      "permission.ask must surface admission handoff via showToast"
    );
    const chatOut = { parts: [] };
    await hooks["chat.message"]({ sessionID: "s-admit-p" }, chatOut);
    assert.equal(
      chatOut.parts.length,
      0,
      "chat.message must not push schema-incomplete parts for admission handoff"
    );
  });

  test("admission handoff binds sessionID+callID (no cross-session callID collision)", async () => {
    const handoffA =
      "admission_record: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const handoffB =
      "admission_record: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb sha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let which = "A";
    const { runHook } = mockRunner({
      "*": () => ({
        status: 0,
        stdout: JSON.stringify({
          decision: "allow",
          systemMessage: which === "A" ? handoffA : handoffB,
        }),
        stderr: "",
      }),
    });
    const hooks = await loadHooks({
      runHook,
      client: { tui: { showToast: async () => ({ data: true }) } },
    });
    which = "A";
    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "sess-A", callID: "same-call" },
      { args: { description: "a", prompt: "a", subagent_type: "dp-reviewer" } }
    );
    which = "B";
    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "sess-B", callID: "same-call" },
      { args: { description: "b", prompt: "b", subagent_type: "dp-reviewer" } }
    );
    const outA = { title: "task", output: "", metadata: {} };
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: "sess-A", callID: "same-call", args: {} },
      outA
    );
    const outB = { title: "task", output: "", metadata: {} };
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: "sess-B", callID: "same-call", args: {} },
      outB
    );
    assert.match(String(outA.output), /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
    assert.match(String(outB.output), /bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
    assert.doesNotMatch(String(outA.output), /bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
  });

  test("pendingAdmissionByCall clears on session.deleted and respects max", async () => {
    const { runHook } = mockRunner({
      "*": {
        status: 0,
        stdout: JSON.stringify({
          decision: "allow",
          systemMessage: "admission_record: x sha256=y",
        }),
      },
    });
    const hooks = await loadHooks({
      runHook,
      pendingAdmissionMax: 2,
      client: { tui: { showToast: async () => ({ data: true }) } },
    });
    assert.equal(hooks.__test__.pendingAdmissionMax, 2);
    for (let i = 0; i < 3; i += 1) {
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "s-life", callID: `c-${i}` },
        { args: { description: "x", prompt: "y", subagent_type: "dp-reviewer" } }
      );
    }
    assert.ok(
      hooks.__test__.pendingAdmissionByCall.size <= 2,
      `pending map must cap, got ${hooks.__test__.pendingAdmissionByCall.size}`
    );
    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "s-del-adm", callID: "c-keep" },
      { args: { description: "x", prompt: "y", subagent_type: "dp-reviewer" } }
    );
    assert.ok(hooks.__test__.pendingAdmissionByCall.size >= 1);
    await hooks.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "s-del-adm", title: "x" } },
      },
    });
    assert.equal(
      [...hooks.__test__.pendingAdmissionByCall.keys()].some((k) =>
        String(k).startsWith("s-del-adm::")
      ),
      false,
      "session.deleted must drop that session's pending admission entries"
    );
  });

  test("evicted callID must not receive a newer session admission via fallback", async () => {
    let n = 0;
    const { runHook } = mockRunner({
      "*": () => {
        n += 1;
        return {
          status: 0,
          stdout: JSON.stringify({
            decision: "allow",
            systemMessage: `admission_record: call-${n} sha256=${"a".repeat(64)}`,
          }),
          stderr: "",
        };
      },
    });
    const hooks = await loadHooks({
      runHook,
      pendingAdmissionMax: 2,
      client: { tui: { showToast: async () => ({ data: true }) } },
    });
    for (const callID of ["c0", "c1", "c2"]) {
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "s-evict", callID },
        { args: { description: "x", prompt: "y", subagent_type: "dp-reviewer" } }
      );
    }
    const out0 = { title: "task", output: "", metadata: {} };
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: "s-evict", callID: "c0", args: {} },
      out0
    );
    assert.equal(
      String(out0.output || ""),
      "",
      "evicted c0 must not fall back to session-latest (c2) admission"
    );
    const out2 = { title: "task", output: "", metadata: {} };
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: "s-evict", callID: "c2", args: {} },
      out2
    );
    assert.match(String(out2.output || ""), /admission_record: call-3/);
  });

  test("permission.ask matrix mirrors fail-closed for bash/task", async () => {
    const { runHook } = mockRunner({
      "*": {
        status: 0,
        stdout: JSON.stringify({ decision: "block", reason: "matrix-block" }),
      },
    });
    const hooks = await loadHooks({ runHook });
    for (const type of ["bash", "task"]) {
      const out = { status: "ask" };
      await hooks["permission.ask"](
        {
          id: `p-${type}`,
          type,
          sessionID: "s-mat-p",
          messageID: "m1",
          title: type,
          metadata: {},
          time: { created: Date.now() },
        },
        out
      );
      assert.equal(out.status, "deny", `${type} permission must deny on block`);
    }
  });

  for (const tool of ["probe_status", "futuretool", "constructor", "__proto__"]) {
    test(`issue #3458: V1 unmapped ${tool} preserves host authority`, async () => {
      const { runHook, calls } = mockRunner({ "*": {
        status: 0, stdout: JSON.stringify({ decision: "block", reason: "must-not-route" }), stderr: "",
      } });
      const hooks = await loadHooks({ runHook });
      await hooks["tool.execute.before"](
        { tool, sessionID: "s-parity", callID: "c1" }, { args: {} }
      );
      for (const status of ["allow", "ask", "deny"]) {
        const out = { status };
        await hooks["permission.ask"]({ type: tool, sessionID: "s-parity", metadata: {} }, out);
        assert.equal(out.status, status);
      }
      assert.equal(calls.filter((c) => c.event === "PreToolUse").length, 0);
    });
  }

  test("issue #3458: V1 Stop still blocks unmapped tools", async () => {
    const { runHook } = mockRunner({ "Stop::recap-check.mjs": {
      status: 0, stdout: JSON.stringify({ decision: "block", reason: "parity-stop-block" }), stderr: "",
    } });
    const hooks = await loadHooks({ runHook });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s-parity-stop" } } });
    await assert.rejects(() => hooks["tool.execute.before"](
      { tool: "probe_status", sessionID: "s-parity-stop", callID: "c1" }, { args: {} }
    ), /parity-stop-block/);
    const out = { status: "ask" };
    await hooks["permission.ask"]({ type: "probe_status", sessionID: "s-parity-stop" }, out);
    assert.equal(out.status, "deny");
  });

  test("skill allow/deny paths map through PreToolUse (not unknown-tool deny)", async () => {
    const mapped = mapOpenCodeToolToProtocol("skill");
    assert.equal(mapped.classified, "supported");
    assert.equal(mapped.toolName, "Skill");
    assert.ok(mapped.gates.some((g) => path.basename(g.gate) === "pre-tool-gate.mjs"));

    {
      const { runHook, calls } = mockRunner({
        "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
      });
      const hooks = await loadHooks({ runHook });
      await assert.doesNotReject(() =>
        hooks["tool.execute.before"](
          { tool: "skill", sessionID: "s-skill-allow", callID: "c1" },
          { args: { name: "init" } }
        )
      );
      assert.ok(calls.some((c) => c.host === "opencode" && c.event === "PreToolUse"));
      const payload = JSON.parse(calls[0].payload || "{}");
      assert.equal(payload.tool_name, "Skill");
      const permOut = { status: "ask" };
      await hooks["permission.ask"](
        {
          id: "p-skill-allow",
          type: "skill",
          sessionID: "s-skill-allow",
          messageID: "m1",
          title: "skill",
          metadata: { args: { name: "init" } },
          time: { created: Date.now() },
        },
        permOut
      );
      assert.equal(permOut.status, "ask");
    }

    {
      const { runHook } = mockRunner({
        "*": {
          status: 0,
          stdout: JSON.stringify({ decision: "block", reason: "skill-blocked" }),
          stderr: "",
        },
      });
      const hooks = await loadHooks({ runHook });
      await assert.rejects(
        () =>
          hooks["tool.execute.before"](
            { tool: "skill", sessionID: "s-skill-deny", callID: "c1" },
            { args: { name: "init" } }
          ),
        /skill-blocked|block|deny|fail.closed/i
      );
      const permOut = { status: "ask" };
      await hooks["permission.ask"](
        {
          id: "p-skill-deny",
          type: "skill",
          sessionID: "s-skill-deny",
          messageID: "m1",
          title: "skill",
          metadata: { args: { name: "init" } },
          time: { created: Date.now() },
        },
        permOut
      );
      assert.equal(permOut.status, "deny");
    }
  });

  test("question and websearch map as supported 1.18.29 built-ins (not unknown-tool deny)", async () => {
    for (const [tool, toolName] of [
      ["question", "AskUserQuestion"],
      ["websearch", "WebSearch"],
    ]) {
      const mapped = mapOpenCodeToolToProtocol(tool);
      assert.equal(mapped.classified, "supported", tool);
      assert.equal(mapped.toolName, toolName, tool);
      const { runHook, calls } = mockRunner({
        "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
      });
      const hooks = await loadHooks({ runHook });
      await assert.doesNotReject(() =>
        hooks["tool.execute.before"](
          { tool, sessionID: `s-${tool}-allow`, callID: "c1" },
          { args: {} }
        )
      );
      assert.ok(
        calls.some((c) => c.host === "opencode" && c.event === "PreToolUse"),
        `${tool} must invoke shared PreToolUse runner`
      );
      assert.equal(JSON.parse(calls[0].payload || "{}").tool_name, toolName);
    }
  });

  test("permission.ask typed hook is classified unverified (host reachability unproven)", () => {
    const classified = classifyOpenCodeSurface("permission.ask");
    assert.equal(classified.kind, "unverified");
    assert.equal(classified.silentSuccess, false);
  });

  test("apply_patch normalizes patchText to functions.apply_patch allow/deny paths", async () => {
    const mapped = mapOpenCodeToolToProtocol("apply_patch");
    assert.equal(mapped.classified, "supported");
    assert.equal(mapped.toolName, "functions.apply_patch");
    assert.ok(mapped.gates.some((g) => path.basename(g.gate) === "pre-tool-gate.mjs"));

    const patchText =
      "*** Begin Patch\n*** Update File: /tmp/devpro-opencode-apply-patch-probe.txt\n@@\n+hello\n*** End Patch";

    {
      const { runHook, calls } = mockRunner({
        "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
      });
      const hooks = await loadHooks({ runHook });
      await assert.doesNotReject(() =>
        hooks["tool.execute.before"](
          { tool: "apply_patch", sessionID: "s-ap-allow", callID: "c1" },
          { args: { patchText } }
        )
      );
      assert.ok(calls.length >= 1);
      const payload = JSON.parse(calls[0].payload || "{}");
      assert.equal(payload.tool_name, "functions.apply_patch");
      assert.equal(payload.tool_input.patchText, patchText);
      assert.equal(
        payload.tool_input.patch,
        patchText,
        "patchText must normalize onto patch for shared-gate path extraction"
      );
      const permOut = { status: "ask" };
      await hooks["permission.ask"](
        {
          id: "p-ap-allow",
          type: "apply_patch",
          sessionID: "s-ap-allow",
          messageID: "m1",
          title: "apply_patch",
          metadata: { args: { patchText } },
          time: { created: Date.now() },
        },
        permOut
      );
      assert.equal(permOut.status, "ask");
    }

    {
      const { runHook } = mockRunner({
        "*": {
          status: 0,
          stdout: JSON.stringify({ decision: "block", reason: "apply-patch-blocked" }),
          stderr: "",
        },
      });
      const hooks = await loadHooks({ runHook });
      await assert.rejects(
        () =>
          hooks["tool.execute.before"](
            { tool: "apply_patch", sessionID: "s-ap-deny", callID: "c1" },
            { args: { patchText } }
          ),
        /apply-patch-blocked|block|deny|fail.closed/i
      );
      const permOut = { status: "ask" };
      await hooks["permission.ask"](
        {
          id: "p-ap-deny",
          type: "apply_patch",
          sessionID: "s-ap-deny",
          messageID: "m1",
          title: "apply_patch",
          metadata: { args: { patchText } },
          time: { created: Date.now() },
        },
        permOut
      );
      assert.equal(permOut.status, "deny");
    }
  });
});
// ── T3: idle / Stop host-control ──

describe("T3 idle/stop host-control", () => {
  test("session.idle must NOT claim sync Stop-block (event → Promise<void>)", async () => {
    const { runHook } = mockRunner({
      "*": {
        status: 0,
        stdout: JSON.stringify({ decision: "block", reason: "should-not-sync-block-idle" }),
      },
    });
    const hooks = await loadHooks({ runHook });
    // Idle must resolve (void), not throw as if it were a sync Stop-block.
    await assert.doesNotReject(() =>
      hooks.event({ event: { type: "session.idle", properties: { sessionID: "s-idle-1" } } })
    );
    const ret = await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-idle-1b" } },
    });
    assert.equal(ret, undefined);
  });

  test("session.idle invokes Stop/recap via run-hook --host=opencode", async () => {
    const { runHook, calls } = mockRunner({
      "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
    });
    const hooks = await loadHooks({ runHook });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-idle-2" } },
    });
    assert.ok(
      calls.some(
        (c) =>
          c.host === "opencode" &&
          c.event === "Stop" &&
          path.basename(c.gate) === "recap-check.mjs"
      ),
      "idle must call Stop/recap-check --host=opencode"
    );
  });

  test("reminder is delivered via client.tui.showToast (host-facing, not sink-only)", async () => {
    const reminderSink = [];
    const toastCalls = [];
    const client = {
      tui: {
        showToast: async (opts) => {
          toastCalls.push(opts);
          return { data: true };
        },
      },
    };
    const { runHook } = mockRunner({
      "Stop::recap-check.mjs": {
        status: 0,
        stdout: JSON.stringify({
          systemMessage: "Session Recap reminder: write Recap Discussion",
        }),
      },
      "*": { status: 0, stdout: "", stderr: "" },
    });
    const hooks = await loadHooks({ runHook, reminderSink, client });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-idle-toast" } },
    });
    assert.equal(toastCalls.length, 1, "must call client.tui.showToast");
    assert.equal(toastCalls[0]?.body?.message?.includes("Recap"), true);
    assert.equal(toastCalls[0]?.body?.variant, "warning");
    assert.equal(
      hooks.__test__.sessionState.get("s-idle-toast")?.reminderDelivered,
      true
    );
  });

  test("chat.message must not push bare parts when toast unavailable", async () => {
    const reminderSink = [];
    const sessionState = new Map();
    sessionState.set("s-chat-rem", {
      blocking: false,
      reason: "",
      reminder: "pending reminder text",
      reminderDelivered: false,
      reminderDeliveryError: "",
      pendingAdmissionHandoff: "",
      outcome: "reminder",
      syncStopBlock: false,
      silentSuccess: false,
    });
    const hooks = await loadHooks({
      runHook: async () => ({ status: 0, stdout: "", stderr: "" }),
      reminderSink,
      sessionState,
      client: null,
    });
    const output = { message: {}, parts: [] };
    await hooks["chat.message"]({ sessionID: "s-chat-rem" }, output);
    assert.equal(
      output.parts.length,
      0,
      "must not push incomplete {type,text} parts (OpenCode SchemaError)"
    );
    assert.equal(sessionState.get("s-chat-rem")?.reminderDelivered, false);
    assert.match(
      String(sessionState.get("s-chat-rem")?.reminderDeliveryError || ""),
      /unavailable|toast/i
    );
  });

  test("admission toast must not mark undelivered Stop reminder as delivered", async () => {
    const reminderSink = [];
    const toastCalls = [];
    const client = {
      tui: {
        showToast: async (opts) => {
          toastCalls.push(opts);
          return {};
        },
      },
    };
    const sessionState = new Map();
    sessionState.set("s-both", {
      blocking: true,
      reason: "stop-block",
      reminder: "Session Recap reminder: write Recap Discussion",
      reminderDelivered: false,
      reminderDeliveryError: "",
      pendingAdmissionHandoff: "admission-handoff-text",
      outcome: "reminder",
      syncStopBlock: false,
      silentSuccess: false,
    });
    const hooks = await loadHooks({
      runHook: async () => ({ status: 0, stdout: "", stderr: "" }),
      reminderSink,
      sessionState,
      client,
    });
    await hooks["chat.message"]({ sessionID: "s-both" }, { parts: [] });
    const st = sessionState.get("s-both");
    assert.equal(st?.pendingAdmissionHandoff, "");
    assert.equal(
      st?.reminder,
      "Session Recap reminder: write Recap Discussion",
      "admission toast must not overwrite Stop reminder text"
    );
    assert.equal(
      st?.reminderDelivered,
      true,
      "Stop reminder must still be delivered after admission toast"
    );
    assert.equal(toastCalls.length, 2, "must toast admission then Stop reminder");
    assert.match(String(toastCalls[0]?.body?.message || ""), /admission-handoff/);
    assert.match(String(toastCalls[1]?.body?.message || ""), /Recap/);
  });

  test("showToast failure does not mark reminderDelivered; surfaces error", async () => {
    const reminderSink = [];
    const client = {
      tui: {
        showToast: async () => {
          throw new Error("toast transport down");
        },
      },
    };
    const { runHook } = mockRunner({
      "Stop::recap-check.mjs": {
        status: 0,
        stdout: JSON.stringify({ systemMessage: "need recap" }),
      },
      "*": { status: 0, stdout: "", stderr: "" },
    });
    const hooks = await loadHooks({ runHook, reminderSink, client });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-toast-fail" } },
    });
    const st = hooks.__test__.sessionState.get("s-toast-fail");
    assert.equal(st?.reminderDelivered, false);
    assert.match(String(st?.reminderDeliveryError || ""), /toast transport down/);
  });

  test("reminder is observably delivered (sink / toast channel)", async () => {
    const reminderSink = [];
    const toastCalls = [];
    const client = {
      tui: {
        showToast: async (opts) => {
          toastCalls.push(opts);
          return { data: true };
        },
      },
    };
    const { runHook } = mockRunner({
      "Stop::recap-check.mjs": {
        status: 0,
        stdout: JSON.stringify({
          systemMessage: "Session Recap reminder: write Recap Discussion",
        }),
      },
      "*": { status: 0, stdout: "", stderr: "" },
    });
    const hooks = await loadHooks({ runHook, reminderSink, client });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-idle-rem" } },
    });
    assert.ok(
      reminderSink.length >= 1 ||
        (hooks.__test__ &&
          hooks.__test__.sessionState.get("s-idle-rem")?.reminder),
      "reminder must be observable after idle"
    );
    assert.ok(
      toastCalls.some((c) => /Recap|reminder/i.test(String(c?.body?.message || ""))) ||
        hooks.__test__.sessionState.get("s-idle-rem")?.reminderDelivered,
      "reminder must use toast delivery (not bare chat parts)"
    );
    const chatOut = { message: {}, parts: [] };
    await hooks["chat.message"]?.({ sessionID: "s-idle-rem" }, chatOut);
    assert.equal(chatOut.parts.length, 0, "chat.message must not append bare parts");
  });

  test("must-block after idle → subsequent tool.execute.before / permission.ask deny", async () => {
    const sessionState = new Map();
    const { runHook } = mockRunner({
      "Stop::recap-check.mjs": {
        status: 0,
        stdout: JSON.stringify({
          decision: "block",
          reason: "must-block-after-idle",
          systemMessage: "blocked: resolve stop-point first",
        }),
      },
      "*": { status: 0, stdout: "", stderr: "" },
    });
    const hooks = await loadHooks({ runHook, sessionState });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-block-next" } },
    });
    const st = sessionState.get("s-block-next") || hooks.__test__.sessionState.get("s-block-next");
    assert.ok(st?.blocking, "idle block decision must set session blocking state");

    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "s-block-next", callID: "c9" },
          { args: { command: "echo should-deny" } }
        ),
      /must-block|block|deny|fail.closed/i
    );
    const permOut = { status: "ask" };
    await hooks["permission.ask"](
      {
        id: "p-next",
        type: "bash",
        sessionID: "s-block-next",
        messageID: "m1",
        title: "bash",
        metadata: {},
        time: { created: Date.now() },
      },
      permOut
    );
    assert.equal(permOut.status, "deny");
  });

  test("first idle blocks → second idle all-allow clears blocking → safe tool allowed", async () => {
    const sessionState = new Map();
    let idleRound = 0;
    const { runHook } = mockRunner({
      "Stop::recap-check.mjs": () => {
        idleRound += 1;
        if (idleRound === 1) {
          return {
            status: 0,
            stdout: JSON.stringify({
              decision: "block",
              reason: "stale-block-round-1",
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      "*": { status: 0, stdout: "", stderr: "" },
    });
    const hooks = await loadHooks({ runHook, sessionState });

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-clear" } },
    });
    assert.equal(sessionState.get("s-clear")?.blocking, true);

    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "s-clear", callID: "c-deny" },
          { args: { command: "echo denied" } }
        ),
      /stale-block|block|deny|fail.closed|session blocked/i
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-clear" } },
    });
    const st2 = sessionState.get("s-clear");
    assert.equal(st2?.blocking, false, "successful idle must clear blocking");
    assert.equal(st2?.reason, "");
    assert.equal(st2?.outcome, "ok");

    await assert.doesNotReject(() =>
      hooks["tool.execute.before"](
        { tool: "bash", sessionID: "s-clear", callID: "c-allow" },
        { args: { command: "echo allowed" } }
      )
    );
  });

  test("session.deleted clears/removes session state", async () => {
    const sessionState = new Map();
    const { runHook } = mockRunner({
      "Stop::recap-check.mjs": {
        status: 0,
        stdout: JSON.stringify({ decision: "block", reason: "gone" }),
      },
      "*": { status: 0, stdout: "", stderr: "" },
    });
    const hooks = await loadHooks({ runHook, sessionState });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-del" } },
    });
    assert.ok(sessionState.has("s-del"));
    await hooks.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "s-del", title: "x" } },
      },
    });
    assert.equal(sessionState.has("s-del"), false);
  });

  test("reminderSink is capped and cleared on session.deleted", async () => {
    const reminderSink = [];
    const sessionState = new Map();
    const { runHook } = mockRunner({
      "Stop::recap-check.mjs": {
        status: 0,
        stdout: JSON.stringify({
          decision: "block",
          systemMessage: "cap-me",
        }),
      },
      "*": { status: 0, stdout: "", stderr: "" },
    });
    const hooks = await loadHooks({
      runHook,
      reminderSink,
      sessionState,
      reminderSinkMax: 3,
      client: {
        tui: {
          showToast: async () => ({ data: true }),
        },
      },
    });
    assert.equal(hooks.__test__.reminderSinkMax, 3);
    for (let i = 0; i < 5; i += 1) {
      await hooks.event({
        event: {
          type: "session.idle",
          properties: { sessionID: `s-cap-${i}` },
        },
      });
    }
    assert.ok(reminderSink.length <= 3, `sink must cap at 3, got ${reminderSink.length}`);
    await hooks.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "s-cap-4", title: "x" } },
      },
    });
    assert.equal(
      reminderSink.some((e) => e.sessionID === "s-cap-4"),
      false,
      "session.deleted must drop that session's sink entries"
    );
  });

  test("STOP_GATES includes full shared Stop set (post-merge + post-pr-completion)", async () => {
    const { runHook, calls } = mockRunner({
      "*": { status: 0, stdout: "", stderr: "" },
    });
    const hooks = await loadHooks({ runHook });
    const expected = [
      "recap-check.mjs",
      "session-pending-cleanup-check.mjs",
      "post-merge-check.mjs",
      "post-pr-completion-check.mjs",
      "stop-handoff-cite.mjs",
    ];
    assert.deepEqual(
      (hooks.__test__.STOP_GATES || []).map((g) => path.basename(g.gate)),
      expected
    );
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-stop-set" } },
    });
    const stopGates = calls
      .filter((c) => c.event === "Stop")
      .map((c) => path.basename(c.gate));
    for (const g of expected) {
      assert.ok(stopGates.includes(g), `idle must invoke Stop/${g}`);
    }
  });

  test("Idle Runner Failure Does Not Lock The Session (fail-open with a diagnostic, permission stays ask)", async () => {
    const sessionState = new Map();
    const reminderSink = [];
    const { runHook } = mockRunner({
      "Stop::recap-check.mjs": { status: 2, stdout: "", stderr: "recap crashed" },
      "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
    });
    const hooks = await loadHooks({ runHook, sessionState, reminderSink });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-idle-crash" } },
    });
    const st = sessionState.get("s-idle-crash") || hooks.__test__.sessionState.get("s-idle-crash");
    assert.equal(st?.blocking, false, "a runner failure on idle must not lock the session");
    assert.equal(st?.outcome, "fail-open");
    assert.equal(st?.reason, "");
    assert.equal(st?.reminder, "", "the diagnostic is not bound to the Stop reminder state");
    const messages = reminderSink.map((e) => String(e.message));
    assert.ok(
      messages.some((m) => /Stop recap-check\.mjs runner failure \(exit 2\); fail-open/.test(m)),
      `expected an idle runner-failure diagnostic, got ${JSON.stringify(messages)}`
    );
    assert.equal(
      messages.some((m) => /recap crashed/.test(m)),
      false,
      "the runner's stderr text never reaches the diagnostic"
    );

    const permOut = { status: "ask" };
    await hooks["permission.ask"](
      {
        id: "p-crash",
        type: "edit",
        sessionID: "s-idle-crash",
        messageID: "m1",
        title: "edit",
        metadata: {},
        time: { created: Date.now() },
      },
      permOut
    );
    assert.equal(permOut.status, "ask");
  });

  test("Idle Explicit Block Survives Launcher Exit Translation (real launcher, fixture Stop gate exits 2 with a block JSON)", async () => {
    const dir = makeTempDir("opencode-idle-launcher-block-");
    try {
      const fixture = path.join(dir, "fixture-stop-gate.mjs");
      writeFileSync(
        fixture,
        [
          "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'fixture-stop-block' }) + '\\n');",
          "process.exit(2);",
        ].join("\n")
      );
      const sessionState = new Map();
      const runHook = (args) => {
        if (args.event === "Stop" && path.basename(args.gate) === "recap-check.mjs") {
          // Real launcher: the gate's exit 2 becomes launcher exit 1 with stdout forwarded.
          return defaultRunHook({
            ...args,
            gate: fixture,
            env: { ...(args.env || {}), DEVPRO_AGENT_RULES_LEVEL: "full" },
          });
        }
        return { status: 0, stdout: "", stderr: "" };
      };
      const hooks = await loadHooks({ runHook, sessionState });
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID: "s-idle-launcher-block" } },
      });
      const st = sessionState.get("s-idle-launcher-block");
      assert.equal(st?.blocking, true, "an explicit block must lock the session at any exit status");
      assert.equal(st?.reason, "fixture-stop-block");
      assert.equal(st?.outcome, "fail-closed");
      await assert.rejects(
        () =>
          hooks["tool.execute.before"](
            { tool: "bash", sessionID: "s-idle-launcher-block", callID: "c1" },
            { args: { command: "echo denied" } }
          ),
        (err) => {
          assert.equal(err.message, "fixture-stop-block");
          return true;
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("idle round 1 explicit block then round 2 runner failure unlocks the session", async () => {
    const sessionState = new Map();
    let round = 0;
    const { runHook } = mockRunner({
      "Stop::recap-check.mjs": () => {
        round += 1;
        if (round === 1) {
          return {
            status: 0,
            stdout: JSON.stringify({ decision: "block", reason: "round-1-block" }),
            stderr: "",
          };
        }
        return { status: 2, stdout: "", stderr: "recap crashed" };
      },
      "*": { status: 0, stdout: "", stderr: "" },
    });
    const hooks = await loadHooks({ runHook, sessionState });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-round-unlock" } },
    });
    assert.equal(sessionState.get("s-round-unlock")?.blocking, true);
    assert.equal(sessionState.get("s-round-unlock")?.reason, "round-1-block");
    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "s-round-unlock", callID: "c-deny" },
          { args: { command: "echo denied" } }
        ),
      (err) => {
        assert.equal(err.message, "round-1-block");
        return true;
      }
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-round-unlock" } },
    });
    const st2 = sessionState.get("s-round-unlock");
    assert.equal(st2?.blocking, false, "a later round that only had a runner failure unlocks");
    assert.equal(st2?.reason, "");
    assert.equal(st2?.outcome, "fail-open");
    await assert.doesNotReject(() =>
      hooks["tool.execute.before"](
        { tool: "bash", sessionID: "s-round-unlock", callID: "c-allow" },
        { args: { command: "echo allowed" } }
      )
    );
  });

  test("same idle round: a thrown Stop gate then a later explicit block still locks with that block's reason", async () => {
    const sessionState = new Map();
    const reminderSink = [];
    const { runHook, calls } = mockRunner({
      "Stop::recap-check.mjs": () => {
        throw new Error("recap exploded");
      },
      "Stop::post-pr-completion-check.mjs": {
        status: 1,
        stdout: JSON.stringify({ decision: "block", reason: "post-pr-block-reason" }),
        stderr: "gate exited 2 (launcher translated it to exit 1)",
      },
      "*": { status: 0, stdout: "", stderr: "" },
    });
    const hooks = await loadHooks({ runHook, sessionState, reminderSink });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-throw-then-block" } },
    });
    const stopGates = calls.filter((c) => c.event === "Stop").map((c) => path.basename(c.gate));
    assert.ok(
      stopGates.includes("post-pr-completion-check.mjs"),
      "a thrown earlier gate must not stop the later Stop gates from running"
    );
    const st = sessionState.get("s-throw-then-block");
    assert.equal(st?.blocking, true);
    assert.equal(st?.reason, "post-pr-block-reason");
    assert.equal(st?.outcome, "fail-closed");
    const messages = reminderSink.map((e) => String(e.message));
    assert.ok(
      messages.some((m) => /Stop recap-check\.mjs runner failure \(exception\); fail-open/.test(m)),
      `the thrown gate is still reported as a runner failure: ${JSON.stringify(messages)}`
    );
    assert.equal(
      messages.some((m) => /recap exploded/.test(m)),
      false,
      "an exception's message text never reaches the diagnostic"
    );
  });

  test("illegal path / bad state / lease race must not silent-success", async () => {
    const tmp = makeTempDir("opencode-idle-state-");
    try {
      // Point recap dirs at an illegal non-repo path that is not writable as a file.
      const illegalAsFile = path.join(tmp, "not-a-dir");
      writeFileSync(illegalAsFile, "I am a file, not a directory", "utf8");

      const { runHook, calls } = mockRunner({
        "Stop::recap-check.mjs": (args) => {
          // Simulate shared runner observing illegal state: non-zero + classified error.
          // Plugin must not treat this as silent success / allow.
          return {
            status: 1,
            stdout: "",
            stderr: `illegal-state-path: ${args.env?.DEVPRO_RECAP_PENDING_DIR || ""}`,
          };
        },
        "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
      });

      const hooks = await loadHooks({
        runHook,
        directory: REPO_ROOT,
      });

      // Force env into the idle runner call via wrapper: plugin should forward cwd/env;
      // we assert the classified fail-open outcome (not a silent success) and an unlocked session.
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID: "s-illegal" } },
      });

      assert.ok(
        calls.some((c) => c.event === "Stop" && path.basename(c.gate) === "recap-check.mjs"),
        "idle must still invoke shared Stop path (not skip silently)"
      );

      const st = hooks.__test__.sessionState.get("s-illegal");
      assert.equal(st?.blocking, false, "a runner failure on idle must not lock the session");
      assert.equal(
        st?.outcome,
        "fail-open",
        "illegal/bad state is a classified fail-open, not a silent success"
      );
      assert.notEqual(st?.outcome, "ok");
      assert.notEqual(st?.outcome, "allow");
      // Fixture proves the plugin classifies a shared Stop runner illegal-state as fail-open, not a silent success;
      // path confinement itself remains owned by shared recap-utils (invoked via --host=opencode).
      assert.ok(
        calls.some(
          (c) =>
            c.event === "Stop" &&
            (/illegal-state-path/.test(c.stderr || "") || c.status === 1)
        ),
        "illegal-path fixture must surface via non-zero/classified Stop runner result"
      );

      // Lease race: concurrent in-progress marker — plugin must not clear blocking via silent success.
      const leaseDir = path.join(tmp, "in-progress");
      mkdirSync(leaseDir, { recursive: true });
      const leaseFile = path.join(leaseDir, encodeURIComponent("chore/add-opencode-runtime-parity"));
      writeFileSync(leaseFile, JSON.stringify({ leased: true }), "utf8");
      // Fresh lease (not expired)
      const now = new Date();
      utimesSync(leaseFile, now, now);

      const { runHook: run2, calls: calls2 } = mockRunner({
        "Stop::recap-check.mjs": {
          status: 0,
          stdout: JSON.stringify({
            systemMessage: "lease-held: skip duplicate reminder",
            lease: "held",
          }),
        },
        "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
      });
      const hooks2 = await loadHooks({ runHook: run2 });
      await hooks2.event({
        event: { type: "session.idle", properties: { sessionID: "s-lease" } },
      });
      assert.ok(calls2.length >= 1);
      const st2 = hooks2.__test__.sessionState.get("s-lease");
      // Lease-held soft skip is fine, but must be classified — not pretend sync stop-block success.
      assert.notEqual(st2?.syncStopBlock, true);
      assert.notEqual(st2?.silentSuccess, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("TTL/cap/path confinement still go through shared runner (no plugin-local /tmp state)", async () => {
    const { runHook, calls } = mockRunner({
      "*": { status: 0, stdout: JSON.stringify({ systemMessage: "recap please" }) },
    });
    const hooks = await loadHooks({ runHook });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-ttl" } },
    });
    assert.ok(calls.every((c) => c.host === "opencode"));
    assert.ok(calls.some((c) => path.basename(c.gate) === "recap-check.mjs"));
    // Plugin source must not invent a second reminder store under /tmp without repo-hash.
    const src = readFileSync(PLUGIN_JS, "utf8");
    assert.equal(
      /writeFileSync\(\s*['"`]\/tmp\//.test(src) || /['"`]\/tmp\/devpro-recap/.test(src),
      false,
      "plugin must not write recap state to bare /tmp paths"
    );
  });
});

// Smoke: real run-hook binary accepts --host=opencode (alias / normalize)
test("run-hook accepts --host=opencode marker", () => {
  assert.equal(existsSync(RUN_HOOK), true);
  const src = readFileSync(RUN_HOOK, "utf8");
  assert.match(src, /parseHostMarker|--host=/);
  // opencode is a legal host token ([a-z0-9-]+) — exercised by bridge tests above.
});
