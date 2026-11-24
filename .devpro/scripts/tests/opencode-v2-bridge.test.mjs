/**
 * opencode-v2-bridge.test.mjs
 *
 * T1–T3 prove-it for the OpenCode V2 plugin bridge
 * (`.opencode/plugins/devpro-hooks.js` → shared `run-hook.mjs --host=opencode`).
 *
 * T1 [R15]: dual-export shape (default export = object literal with id/setup/server;
 *            server() returns the existing V1 hook-key object; node:* imports only).
 * T2 [R2, R16]: V2 `permission.evaluate` decision matrix (four quadrants, classified
 *            no-ops, configured-deny semantics note, ownership three states, fast-path
 *            gate, deny-path re-verify).
 * T3 [R3, R16]: V2 event-stream idle→deny host control — D17.6 all 13 recovery cases,
 *            transport generations, atomic single-winner attempt model, barrier/takeover,
 *            reminder via ctx.session.synthetic (never ctx.session.prompt).
 * T10 [R5, R9, R14]: write/edit proposal content contract — real host shape fixtures
 *            (T-R5a live probe), witness (disk ≠ proposal), named fail-closed deny with
 *            zero gate calls, capability-vs-mapping reason split, apply_patch regression.
 *
 * All tests drive the REAL default-export `setup(ctx)` with a fake ctx
 * (event stream is a controllable async iterator; runner is a mock).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { postPrMarkerFilenames } from "../hooks/lib/post-pr-completion-state.mjs";

const PLUGIN_JS = repoPath(".opencode/plugins/devpro-hooks.js");
const pluginMod = await import(pathToFileURL(PLUGIN_JS).href);

// ── fakes / harness ────────────────────────────────────────────────────────

async function flush(n = 20) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

async function until(fn, label = "condition", timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await flush(50);
  }
  assert.fail(`${label} not met within ${timeout}ms`);
}

/** Like `until`, but yields to the event loop between checks so real child-process
 *  I/O (a real launcher spawn) can make progress; `until` only flushes microtasks. */
async function untilIo(fn, label = "condition", timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} not met within ${timeout}ms`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PASS = { status: 0, stdout: "", stderr: "" };
function blockDecision(reason = "must-block") {
  return {
    status: 0,
    stdout: JSON.stringify({ decision: "block", reason }),
    stderr: "",
  };
}

/** mock shared-runner: decisions keyed `${event}::${gateBasename}` | `${event}` | `*`
 *  Invocations are recorded immediately (before the decision resolves) so tests
 *  can observe hung gates without waiting for completion. */
function makeMockRunner(decisions) {
  const calls = [];
  const runHook = async (args) => {
    const key = `${args.event}::${path.basename(args.gate)}`;
    const hit = decisions[key] || decisions[args.event] || decisions["*"] || PASS;
    const promise =
      typeof hit === "function" ? hit(args, calls) : Promise.resolve(hit);
    calls.push({ ...args });
    return promise;
  };
  return { runHook, calls };
}

/** controllable event-stream source: every subscribe() returns a new iterator */
function makeEventSource() {
  const source = { subscribeCount: 0, current: null };
  function newStream() {
    const s = {
      events: [],
      waiters: [],
      done: false,
      err: null,
      [Symbol.asyncIterator]() {
        return s;
      },
      next() {
        if (s.err) return Promise.reject(s.err);
        if (s.events.length) {
          return Promise.resolve({ value: s.events.shift(), done: false });
        }
        if (s.done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) =>
          s.waiters.push({ resolve, reject })
        );
      },
      push(ev) {
        const w = s.waiters.shift();
        if (w) w.resolve({ value: ev, done: false });
        else s.events.push(ev);
      },
      end() {
        s.done = true;
        const w = s.waiters.shift();
        if (w) w.resolve({ done: true, value: undefined });
      },
      fail(err) {
        s.err = err;
        const w = s.waiters.shift();
        if (w) w.reject(err);
      },
    };
    return s;
  }
  source.subscribe = () => {
    source.subscribeCount += 1;
    source.current = newStream();
    return source.current;
  };
  return source;
}

const OUR_DIR = REPO_ROOT;
const FOREIGN_DIR = path.resolve(REPO_ROOT, "..", "another-checkout");

async function makeV2Harness(opts = {}) {
  const source = makeEventSource();
  const runner = makeMockRunner(opts.decisions || {});
  const calls = { get: [], synthetic: [], promptApi: [], context: [] };
  const registrations = {
    evaluate: null,
    prompt: null,
    executeAfter: null,
    executeBefore: null,
    shellCreateBefore: null,
    skillTransform: null,
  };
  const sessionGet =
    opts.sessionGet ||
    (() => ({ location: { directory: OUR_DIR }, projectID: "prj_test" }));
  const ctx = {
    app: { version: "fake-test" },
    location: { directory: OUR_DIR, workspaceID: "wrk_test" },
    options: {
      runHook: runner.runHook,
      eventBackoffMs: opts.eventBackoffMs || [0, 0, 0],
      ...(opts.testMode === false ? {} : { testMode: true }),
      ...(Number.isFinite(opts.takeoverTimeoutMs)
        ? { takeoverTimeoutMs: opts.takeoverTimeoutMs }
        : {}),
    },
    permission: {
      hook(name, fn) {
        if (name === "evaluate") registrations.evaluate = fn;
      },
    },
    session: {
      hook(name, fn) {
        if (name === "prompt") registrations.prompt = fn;
      },
      get: async ({ sessionID }) => {
        calls.get.push(sessionID);
        const out = sessionGet(sessionID);
        if (out instanceof Error) throw out;
        return out;
      },
      context: async ({ sessionID }) => {
        calls.context.push(sessionID);
        if (opts.sessionContextFails) throw new Error("context unavailable");
        const out = opts.sessionContext ? opts.sessionContext(sessionID) : [];
        if (out instanceof Error) throw out;
        return out;
      },
      synthetic: async (arg) => {
        calls.synthetic.push(arg);
        if (opts.syntheticFails) throw new Error("synthetic unavailable");
      },
      prompt: async (arg) => {
        calls.promptApi.push(arg);
      },
    },
    tool: {
      hook(name, fn) {
        if (name === "execute.after") registrations.executeAfter = fn;
        if (name === "execute.before") registrations.executeBefore = fn;
      },
    },
    shell: {
      hook(name, fn) {
        if (name === "create.before") registrations.shellCreateBefore = fn;
      },
    },
    skill: {
      transform: async (fn) => {
        registrations.skillTransform = fn;
      },
    },
    event: {
      subscribe: () => source.subscribe(),
    },
  };
  const dispose = await pluginMod.default.setup(ctx);
  return {
    ctx,
    source,
    runner,
    registrations,
    calls,
    runtime: ctx.__devproHooksV2,
    dispose,
  };
}

async function withV2Harness(opts, fn) {
  const h = await makeV2Harness(opts);
  try {
    await fn(h);
  } finally {
    await h.dispose();
  }
}

/** default V2 evaluate event (binary-observed trigger shape, Permission.Request) */
function evaluateEvent(overrides = {}) {
  return {
    sessionID: "ses_t",
    agent: "build",
    action: "shell",
    resources: ["echo hi"],
    metadata: {},
    source: "tool",
    effect: "allow",
    ...overrides,
  };
}

const SID = (n) => `ses_v2_${n}`;

describe("issue #3458: unmapped tools preserve host authority", () => {
  // User-approved host parity supersedes the original MCP-only allowlist.
  for (const action of ["synthetic_read_status", "probe_status", "futuretool",
    "opencode_list_mcp_resources", "opencode_read_mcp_resource", "constructor", "__proto__"]) {
    for (const effect of ["allow", "ask", "deny"]) {
      test(`issue #3458: ${action} preserves host ${effect} without a catalog`, async () => {
        await withV2Harness({}, async (h) => {
          let catalogReads = 0;
          h.ctx.mcp = { list: async () => { catalogReads++; throw new Error("catalog unavailable"); } };
          h.ctx.tool.list = async () => { catalogReads++; return { malformed: true }; };
          const ev = evaluateEvent({ action, effect, message: "host decision" });
          await h.registrations.evaluate(ev);
          assert.equal(ev.effect, effect);
          assert.equal(ev.message, "host decision");
          assert.equal(catalogReads, 0, "unmapped tools must not depend on MCP catalogs");
          assert.equal(h.runner.calls.filter((c) => c.event === "PreToolUse").length, 0);
        });
      });
    }
  }

  test("issue #3458: unmapped tools still honor authoritative Stop blocks", async () => {
    await withV2Harness({ decisions: {
      "Stop::recap-check.mjs": blockDecision("parity-stop-block"),
    } }, async (h) => {
      const ev = evaluateEvent({ action: "probe_status", effect: "ask" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      assert.equal(ev.message, "parity-stop-block");
    });
  });

  test("issue #3458: unresolvable ownership still denies unmapped tools", async () => {
    await withV2Harness({ sessionGet: () => new Error("unavailable") }, async (h) => {
      const ev = evaluateEvent({ action: "probe_status" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      assert.equal(ev.message, "ownership unresolvable (fail-closed)");
      assert.equal(h.runner.calls.length, 0);
    });
  });

  test("issue #3458: foreign unmapped tools remain owned by their host", async () => {
    await withV2Harness({ sessionGet: () => ({ location: { directory: FOREIGN_DIR } }) }, async (h) => {
      const ev = evaluateEvent({ action: "probe_status", effect: "ask" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "ask");
      assert.equal(h.runner.calls.length, 0);
    });
  });
});

/** Lines a mocked `console.warn` recorded — the V2 face's plugin-log diagnostic channel. */
function v2WarnLogs(warn) {
  return warn.mock.calls.map((c) => c.arguments.map(String).join(" "));
}

const ADMISSION_PROMPT = [
  "objective: specialized-surface",
  "responsibility_id: plugin-v2-bridge",
  "instance_mode: fresh",
  "evidence_scope: .opencode/plugins/devpro-hooks.js",
  "return_and_stop: tests green",
  "role: dp-programmer",
].join("\n");

// ── T1: dual-export shape prove-it (R15) ───────────────────────────────────

describe("T1 V2 dual-export shape prove-it", () => {
  test("default export is an object (not a function) with id/setup/server", () => {
    assert.equal(typeof pluginMod.default, "object");
    assert.notEqual(typeof pluginMod.default, "function");
    assert.equal(typeof pluginMod.default.id, "string");
    assert.ok(pluginMod.default.id.length > 0);
    assert.equal(typeof pluginMod.default.setup, "function");
    assert.equal(typeof pluginMod.default.server, "function");
    const src = readFileSync(PLUGIN_JS, "utf8");
    assert.match(src, /export default \{/);
    assert.doesNotMatch(src, /export default\s+(async\s+)?function/);
  });

  test("server() returns the existing V1 hook-key object (tool.execute.before/permission.ask/event/chat.message/config)", async () => {
    const hooks = await pluginMod.default.server();
    for (const key of [
      "tool.execute.before",
      "permission.ask",
      "event",
      "chat.message",
      "config",
    ]) {
      assert.equal(
        typeof hooks[key],
        "function",
        `server() must return V1 hook key ${key}`
      );
    }
  });

  test("V2 shell create.before injects the provider-neutral session env (F-hsn-r1-04; Scenario: Shell subprocesses carry the neutral session env)", async () => {
    const h = await makeV2Harness();
    assert.equal(typeof h.registrations.shellCreateBefore, "function", "shell hook must register");
    await h.registrations.prompt({ sessionID: "ses_v2_shell", prompt: { text: "hi" } });
    const event = { command: "echo hi", cwd: OUR_DIR, timeout: 1000, shell: "bash", env: {} };
    await h.registrations.shellCreateBefore(event);
    assert.equal(event.env.DEVPRO_HOST_SESSION_ID, "ses_v2_shell");
    const explicit = {
      command: "echo hi",
      cwd: OUR_DIR,
      timeout: 1000,
      shell: "bash",
      env: { DEVPRO_HOST_SESSION_ID: "explicit-kept" },
    };
    await h.registrations.shellCreateBefore(explicit);
    assert.equal(explicit.env.DEVPRO_HOST_SESSION_ID, "explicit-kept");
    await h.dispose();
  });

  test("createDevproPluginHooks named export retained (V1 face intact)", () => {
    assert.equal(typeof pluginMod.createDevproPluginHooks, "function");
    const hooks = pluginMod.createDevproPluginHooks({});
    assert.equal(typeof hooks["tool.execute.before"], "function");
    assert.equal(typeof hooks["permission.ask"], "function");
  });

  test("plugin imports are node:* builtins only (zero third-party, no @opencode/plugin)", () => {
    const src = readFileSync(PLUGIN_JS, "utf8");
    const bad = src.match(/from\s+['"](?![./]|node:)[^'"]+['"]/g) || [];
    assert.deepEqual(bad, [], `third-party imports forbidden: ${bad}`);
    assert.doesNotMatch(src, /@opencode\/plugin/);
    assert.match(src, /from\s+["']node:/);
  });
});

// ── T2: V2 permission.evaluate matrix (R2, R16) ────────────────────────────

describe("T2 V2 evaluate decision matrix", () => {
  test("allow: gates pass → effect unchanged (no auto-upgrade); runner PreToolUse --host=opencode", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      const ev = evaluateEvent({ action: "shell", resources: ["echo hi"] });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      const pre = h.runner.calls.filter((c) => c.event === "PreToolUse");
      assert.ok(pre.length >= 1, "must invoke shared PreToolUse runner");
      for (const c of pre) {
        assert.equal(c.host, "opencode");
        assert.equal(
          c.env?.DEVPRO_HOST_SESSION_ID,
          "ses_t",
          "V2 decision-gate spawns must carry DEVPRO_HOST_SESSION_ID (F-hsn-r2-02)"
        );
      }
      const payload = JSON.parse(pre[0].payload || "{}");
      assert.equal(payload.tool_name, "Bash");
      assert.equal(payload.tool_input.command, "echo hi");
    });
  });

  test("ask + gates allow → effect stays ask (never auto-upgrade ask→allow)", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      const ev = evaluateEvent({ action: "shell", effect: "ask" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "ask");
    });
  });

  test("block: decision:block → effect deny + message", async () => {
    await withV2Harness(
      { decisions: { "*": blockDecision("test-v2-block") } },
      async (h) => {
        const ev = evaluateEvent({ action: "shell" });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "deny");
        assert.match(String(ev.message || ""), /test-v2-block/);
      }
    );
  });

  test("runner crash fails open (effect stays allow, no message, plugin-log diagnostic; Scenario: `.opencode` Runner Failure Fails Open Like Other Host Profiles)", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    await withV2Harness(
      { decisions: { "*": { status: 2, stdout: "", stderr: "runner crashed" } } },
      async (h) => {
        const ev = evaluateEvent({ action: "read", resources: ["README.md"] });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "allow", "a runner failure must not deny");
        assert.equal(ev.message, undefined, "the diagnostic must not become a model-visible message");
        assert.equal(
          h.calls.synthetic.some((s) => /fail-open/.test(String(s.text || ""))),
          false,
          "the diagnostic must not ride ctx.session.synthetic"
        );
        const logs = v2WarnLogs(warn);
        assert.ok(
          logs.some((l) =>
            /\[devpro-hooks\] hook PreToolUse pre-tool-gate\.mjs runner failure \(exit 2\); fail-open/.test(l)
          ),
          `expected a fail-open diagnostic in the plugin log, got ${JSON.stringify(logs)}`
        );
        assert.equal(
          logs.some((l) => /runner crashed/.test(l)),
          false,
          "the runner's stderr text never reaches the diagnostic"
        );
      }
    );
  });

  test("launcher-translated timeout (exit 0, empty stdout, fail-open stderr line) allows and surfaces a launcher-timeout diagnostic", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const launcherShape = (args) => ({
      status: 0,
      stdout: "",
      stderr: `hook ${args.event} ${args.gate} timed out after 30000ms; fail-open\n`,
    });
    await withV2Harness({ decisions: { "*": launcherShape } }, async (h) => {
      const ev = evaluateEvent({ action: "shell" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      assert.equal(ev.message, undefined);
      const logs = v2WarnLogs(warn);
      for (const g of ["gh-footer-gate", "pre-tool-gate"]) {
        assert.ok(
          logs.some((l) =>
            new RegExp(`hook PreToolUse ${g}\\.mjs runner failure \\(launcher timeout\\); fail-open`).test(l)
          ),
          `expected a launcher-timeout diagnostic for ${g}, got ${JSON.stringify(logs)}`
        );
      }
    });
  });

  test("plugin-side spawn timeout (status 1 + ETIMEDOUT error) allows and surfaces an error-code diagnostic", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    await withV2Harness(
      {
        decisions: {
          "*": { status: 1, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } },
        },
      },
      async (h) => {
        const ev = evaluateEvent({ action: "shell" });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "allow");
        assert.equal(ev.message, undefined);
        const logs = v2WarnLogs(warn);
        assert.ok(
          logs.some((l) => /error ETIMEDOUT\); fail-open/.test(l)),
          `expected an error-code diagnostic, got ${JSON.stringify(logs)}`
        );
      }
    );
  });

  test("launcher fail-open line only counts when it is this call's own last stderr line (anchoring)", async () => {
    const { classifyRunnerResult } = (await pluginMod.default.server({ directory: OUR_DIR })).__test__;
    assert.equal(typeof classifyRunnerResult, "function");
    const gate = path.join(OUR_DIR, ".devpro/scripts/hooks/pre-tool-gate.mjs");
    const ctx = { event: "PreToolUse", gate };
    const own = `hook PreToolUse ${gate} timed out after 400ms; fail-open\n`;
    const positive = classifyRunnerResult({ status: 0, stdout: "", stderr: own }, ctx);
    assert.equal(positive.kind, "runner-failure");
    assert.match(positive.diagnostic, /runner failure \(launcher timeout\); fail-open$/);
    const cwdGone = classifyRunnerResult(
      {
        status: 0,
        stdout: "",
        stderr: `hook PreToolUse ${gate}: session working directory missing (deleted worktree?) — run session_move (or switch to an existing directory) and retry; fail-open\n`,
      },
      ctx
    );
    assert.equal(cwdGone.kind, "runner-failure");
    assert.match(cwdGone.diagnostic, /session working directory missing/);
    assert.match(cwdGone.diagnostic, /session_move/);
    const silentAllow = (result, label) => {
      const got = classifyRunnerResult(result, ctx);
      assert.equal(got.kind, "allow", label);
      assert.equal(got.diagnostic, undefined, `${label}: no diagnostic`);
    };
    silentAllow(
      { status: 0, stdout: "", stderr: own.replace("hook PreToolUse", "hook Stop") },
      "another event's line"
    );
    silentAllow(
      { status: 0, stdout: "", stderr: own.replace("pre-tool-gate.mjs", "gh-footer-gate.mjs") },
      "another gate's line"
    );
    silentAllow(
      { status: 0, stdout: "", stderr: `${own}some later line from the hook\n` },
      "not the last non-empty line"
    );
    silentAllow(
      { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: own },
      "stdout is not empty"
    );
    silentAllow({ status: 0, stdout: "", stderr: "" }, "missing hook file is a silent exit 0");
  });

  test("`.opencode` Explicit Gate Block Denies At Any Runner Exit Status (V2: status 1 + block JSON denies with the JSON reason)", async () => {
    await withV2Harness(
      {
        decisions: {
          "*": {
            status: 1,
            stdout: JSON.stringify({ decision: "block", reason: "v2-json-block-reason" }),
            stderr: "gate exited 2 (launcher translated it to exit 1)",
          },
        },
      },
      async (h) => {
        const ev = evaluateEvent({ action: "shell" });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "deny");
        assert.match(String(ev.message || ""), /v2-json-block-reason/);
        assert.doesNotMatch(String(ev.message || ""), /launcher translated/);
      }
    );
  });

  test("V2: an earlier gate failing does not hide a later gate's explicit block", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    await withV2Harness(
      {
        decisions: {
          "PreToolUse::gh-footer-gate.mjs": { status: 1, stdout: "", stderr: "gh-footer crashed" },
          "PreToolUse::pre-tool-gate.mjs": blockDecision("v2-pre-tool-block"),
          "*": PASS,
        },
      },
      async (h) => {
        const ev = evaluateEvent({ action: "shell" });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "deny");
        assert.match(String(ev.message || ""), /v2-pre-tool-block/);
        assert.deepEqual(
          h.runner.calls.filter((c) => c.event === "PreToolUse").map((c) => path.basename(c.gate)),
          ["gh-footer-gate.mjs", "pre-tool-gate.mjs"],
          "the failing first gate must not stop the second gate from running"
        );
        assert.ok(
          v2WarnLogs(warn).some((l) => /hook PreToolUse gh-footer-gate\.mjs runner failure \(exit 1\); fail-open/.test(l)),
          "the failed first gate is still reported"
        );
      }
    );
  });

  test("Launcher Fail-Open Result Still Surfaces A Plugin Diagnostic (V2: launcher times out before the plugin's own timer)", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const dir = makeTempDir("devpro-v2-launcher-first-timeout-");
    const previous = process.env.DEVPRO_HOOK_TIMEOUT_MS;
    // Plugin timer reads process.env (180 s when unset); the launcher reads the child env.
    delete process.env.DEVPRO_HOOK_TIMEOUT_MS;
    try {
      for (const name of ["gh-footer-gate.mjs", "pre-tool-gate.mjs"]) {
        writeFileSync(path.join(dir, name), "setInterval(() => {}, 1000);\n");
      }
      const viaRealLauncher = (args) =>
        pluginMod.defaultRunHookAsync({
          ...args,
          gate: path.join(dir, path.basename(args.gate)),
          env: {
            ...(args.env || {}),
            DEVPRO_HOOK_TIMEOUT_MS: "50",
            DEVPRO_AGENT_RULES_LEVEL: "full",
          },
        });
      await withV2Harness({ decisions: { "*": viaRealLauncher } }, async (h) => {
        const ev = evaluateEvent({ action: "shell" });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "allow");
        assert.equal(ev.message, undefined);
        const logs = v2WarnLogs(warn);
        for (const g of ["gh-footer-gate", "pre-tool-gate"]) {
          assert.equal(
            logs.filter((l) =>
              l.endsWith(`hook PreToolUse ${g}.mjs runner failure (launcher timeout); fail-open`)
            ).length,
            1,
            `exactly one launcher-timeout diagnostic for ${g}: ${JSON.stringify(logs)}`
          );
        }
      });
    } finally {
      if (previous === undefined) delete process.env.DEVPRO_HOOK_TIMEOUT_MS;
      else process.env.DEVPRO_HOOK_TIMEOUT_MS = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unmapped action → host pass-through (not a forced allow)", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      const ev = evaluateEvent({ action: "some_future_action" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow", "preserve the host decision");
      assert.equal(ev.message, undefined);
      assert.equal(
        h.runner.calls.filter((c) => c.event === "PreToolUse").length,
        0,
        "unknown action must not reach the gate runner"
      );
    });
  });

  test("S6(a) literal patch actions are unmapped; actual host writes use edit", async () => {
    // The real host patch tool asserts action=edit and remains covered by T10.
    // Do not infer a local file operation from an otherwise unmapped action name.
    for (const action of ["patch", "apply_patch"]) {
      await withV2Harness({}, async (h) => {
        const ev = evaluateEvent({
          action, effect: "ask", resources: ["p1.md", "p2.md"],
          metadata: { files: [t10FileDiff("p1.md"), t10FileDiff("p2.md")] },
        });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "ask");
        assert.equal(t10PreCalls(h).length, 0);
        assert.equal(h.calls.context.length, 0);
      });
    }
  });

  test("external_directory / execute are classified no-op (effect unchanged, no PreToolUse gates)", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      for (const action of ["external_directory", "execute"]) {
        const before = h.runner.calls.filter((c) => c.event === "PreToolUse").length;
        const ev = evaluateEvent({ action, resources: ["/elsewhere"], effect: "allow" });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "allow", `${action} must not change effect`);
        assert.equal(
          h.runner.calls.filter((c) => c.event === "PreToolUse").length,
          before,
          `${action} must not invoke PreToolUse gates`
        );
      }
    });
  });

  test("configured-deny semantics note: an in-effect deny is never upgraded by the plugin", async () => {
    // V2 docs (V2-Q3): hooks run for allow/ask decisions only; an explicit configured
    // deny is final and does not invoke the hook. Fail-closed polarity is unchanged
    // (deny remains deny). This test pins that IF the hook is invoked with effect deny,
    // the plugin never upgrades it — even when every gate would allow.
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      const ev = evaluateEvent({ action: "shell", effect: "deny" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      assert.equal(
        h.runner.calls.filter((c) => c.event === "PreToolUse").length,
        0,
        "plugin must not re-run gates over a configured deny"
      );
    });
  });

  test("subagent action maps to Task pre-tool-gate with subagent_type (admission path)", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      const ev = evaluateEvent({
        action: "subagent",
        resources: ["dp-explorer"],
        metadata: { description: "survey", prompt: "find x" },
      });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      const pre = h.runner.calls.filter((c) => c.event === "PreToolUse");
      assert.ok(pre.length >= 1);
      const payload = JSON.parse(pre[0].payload || "{}");
      assert.equal(payload.tool_name, "Task");
      assert.equal(payload.tool_input.subagent_type, "dp-explorer");
    });
  });

  // ── T4-live: subagent admission prompt carrier (metadata absent → live-read) ─

  test("subagent admission: metadata without prompt falls back to session.context live-read", async () => {
    const sessionContext = () => [
      {
        id: "msg_1",
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "tool_1",
            name: "task",
            executed: false,
            state: {
              status: "running",
              input: { agent: "dp-programmer", description: "t", prompt: ADMISSION_PROMPT },
              metadata: {},
            },
            time: { created: 1 },
          },
        ],
      },
    ];
    await withV2Harness({ decisions: { "*": PASS }, sessionContext }, async (h) => {
      const ev = evaluateEvent({
        action: "subagent",
        resources: ["dp-programmer"],
        metadata: {},
        source: { type: "tool", messageID: "msg_1", id: "tool_1" },
      });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      const pre = h.runner.calls.filter((c) => c.event === "PreToolUse");
      assert.ok(pre.length >= 1);
      const payload = JSON.parse(pre[0].payload || "{}");
      assert.equal(payload.tool_input.subagent_type, "dp-programmer");
      assert.equal(payload.tool_input.prompt, ADMISSION_PROMPT);
      assert.equal(h.calls.context.length, 1);
    });
  });

  test("subagent admission: session.context fetch failure → deny (fail-closed)", async () => {
    await withV2Harness(
      { decisions: { "*": PASS }, sessionContextFails: true },
      async (h) => {
        const ev = evaluateEvent({
          action: "subagent",
          resources: ["dp-programmer"],
          metadata: {},
          source: { type: "tool", messageID: "msg_1", id: "tool_1" },
        });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "deny");
        assert.match(ev.message, /admission prompt unresolvable/);
      },
    );
  });

  test("subagent admission: no matching tool part in context → deny (fail-closed)", async () => {
    const sessionContext = () => [
      { id: "msg_1", type: "assistant", content: [{ type: "tool", id: "tool_9", name: "task", executed: false, state: { status: "running", input: { prompt: "x" }, metadata: {} }, time: { created: 1 } }] },
    ];
    await withV2Harness({ decisions: { "*": PASS }, sessionContext }, async (h) => {
      const ev = evaluateEvent({
        action: "subagent",
        resources: ["dp-programmer"],
        metadata: {},
        source: { type: "tool", messageID: "msg_1", id: "tool_1" },
      });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      assert.match(ev.message, /admission prompt unresolvable/);
    });
  });

  test("subagent admission: metadata fast path does not call session.context", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      const ev = evaluateEvent({
        action: "subagent",
        resources: ["dp-programmer"],
        metadata: { prompt: ADMISSION_PROMPT },
        source: { type: "tool", messageID: "msg_1", id: "tool_1" },
      });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      assert.equal(h.calls.context.length, 0);
    });
  });

  test("W5-CODE-001: multi-resource events gate EVERY resource (any deny → deny)", async () => {
    await withV2Harness(
      {
        decisions: {
          "PreToolUse::pre-tool-gate.mjs": (args) => {
            const payload = JSON.parse(args.payload || "{}");
            if (payload.tool_input?.file_path === "secret.md") {
              return blockDecision("multi-resource-block");
            }
            return PASS;
          },
          "*": PASS,
        },
      },
      async (h) => {
        // one resource blocks → the whole event is denied, and BOTH resources
        // were actually gated (not just resources[0])
        const ev = evaluateEvent({ action: "read", resources: ["ok.md", "secret.md"] });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "deny");
        assert.match(String(ev.message || ""), /multi-resource-block/);
        const pathed = h.runner.calls
          .filter((c) => c.event === "PreToolUse")
          .map((c) => JSON.parse(c.payload || "{}").tool_input?.file_path);
        assert.ok(pathed.includes("ok.md"), "first resource must be gated");
        assert.ok(pathed.includes("secret.md"), "second resource must be gated");

        // all resources allow → allow
        const ev2 = evaluateEvent({ action: "read", resources: ["ok.md", "other.md"] });
        await h.registrations.evaluate(ev2);
        assert.equal(ev2.effect, "allow");
      }
    );
  });

  test("W5-CODE-002: must-block raised during the subagent live-read denies before admission", async () => {
    const contextGate = deferred();
    let recapCalls = 0;
    const sessionContext = () => contextGate.promise;
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            recapCalls += 1;
            return recapCalls >= 2
              ? blockDecision("live-read-must-block")
              : PASS;
          },
          "*": PASS,
        },
        sessionContext,
      },
      async (h) => {
        const sid = "ses_live_read_block";
        const ev = evaluateEvent({
          sessionID: sid,
          action: "subagent",
          resources: ["dp-programmer"],
          metadata: {}, // forces the live-read path
          source: { type: "tool", messageID: "msg_1", id: "tool_1" },
        });
        // evaluate is now suspended inside the session.context live-read
        const evalPromise = h.registrations.evaluate(ev);
        await flush();
        // an idle arrives and its Stop job publishes must-block while the
        // live-read is still in flight
        h.source.current.push({ type: "session.idle", data: { sessionID: sid } });
        await flush();
        await until(() => h.runtime.sessionState.get(sid)?.blocking === true);
        // the live-read resolves → the decision path must RE-VERIFY the Stop
        // barrier/blocking state before admitting
        contextGate.resolve([
          {
            id: "msg_1",
            type: "assistant",
            content: [
              {
                type: "tool",
                id: "tool_1",
                name: "task",
                executed: false,
                state: { status: "running", input: { prompt: ADMISSION_PROMPT } },
                time: { created: 1 },
              },
            ],
          },
        ]);
        await evalPromise;
        assert.equal(ev.effect, "deny", "post-read must-block must deny admission");
        assert.match(String(ev.message || ""), /live-read-must-block/);
      }
    );
  });

  test("ownership: ours session → enforcement runs (runner invoked)", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      const ev = evaluateEvent({ sessionID: "ses_ours" });
      await h.registrations.evaluate(ev);
      assert.ok(
        h.runner.calls.some((c) => c.event === "PreToolUse"),
        "ours session must run the shared runner"
      );
    });
  });

  test("ownership: foreign session → pass-through (effect unchanged, zero runner calls)", async () => {
    const sessionGet = () => ({
      location: { directory: FOREIGN_DIR, workspaceID: "wrk_foreign" },
      projectID: "prj_foreign",
    });
    await withV2Harness({ decisions: { "*": PASS }, sessionGet }, async (h) => {
      const ev = evaluateEvent({ sessionID: "ses_foreign", effect: "allow" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow", "foreign evaluate must not be denied");
      assert.equal(h.runner.calls.length, 0, "foreign session must not invoke any gate");
    });
  });

  test("ownership: unresolvable → deny + message (fail-closed, retried once)", async () => {
    const sessionGet = () => {
      throw new Error("session.get down");
    };
    await withV2Harness({ decisions: { "*": PASS }, sessionGet }, async (h) => {
      const ev = evaluateEvent({ sessionID: "ses_unres" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      assert.match(String(ev.message || ""), /ownership unresolvable/i);
      assert.ok(h.calls.get.length >= 2, "unresolvable ownership is retried once before deny");
    });
  });

  test("ownership: transient session.get failure does not false-deny (retry succeeds → enforce)", async () => {
    let n = 0;
    const sessionGet = () => {
      n += 1;
      if (n === 1) throw new Error("transient");
      return { location: { directory: OUR_DIR }, projectID: "prj_test" };
    };
    await withV2Harness({ decisions: { "*": PASS }, sessionGet }, async (h) => {
      const ev = evaluateEvent({ sessionID: "ses_transient" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      assert.equal(h.calls.get.length, 2);
    });
  });

  test("fast-path gate: transport READY AND per-session reconciled=true only; STARTING runs authoritative reconcile", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      // STARTING: first evaluate must reconcile authoritatively (Stop gates run)
      const ev1 = evaluateEvent({ sessionID: "ses_fp" });
      await h.registrations.evaluate(ev1);
      const stopAfter1 = h.runner.calls.filter((c) => c.event === "Stop").length;
      assert.ok(stopAfter1 >= 1, "STARTING evaluate must run authoritative reconcile");

      // no transport events → still STARTING → every evaluate reconciles
      const ev1b = evaluateEvent({ sessionID: "ses_fp" });
      await h.registrations.evaluate(ev1b);
      assert.ok(
        h.runner.calls.filter((c) => c.event === "Stop").length >= stopAfter1 + 1,
        "STARTING must never take the fast path"
      );

      // reach READY
      h.source.current.push({ type: "server.connected", data: {} });
      await flush();
      assert.equal(h.runtime.transport(), "READY");

      // READY but reconciled=false (generation bump) → still authoritative
      const ev2 = evaluateEvent({ sessionID: "ses_fp" });
      await h.registrations.evaluate(ev2);
      const stopAfter2 = h.runner.calls.filter((c) => c.event === "Stop").length;
      assert.ok(stopAfter2 >= stopAfter1 + 1, "reconciled=false must reconcile");

      // now reconciled=true in current generation → fast path: no new Stop calls
      const ev3 = evaluateEvent({ sessionID: "ses_fp" });
      await h.registrations.evaluate(ev3);
      assert.equal(ev3.effect, "allow");
      assert.equal(
        h.runner.calls.filter((c) => c.event === "Stop").length,
        stopAfter2,
        "fast path (READY + reconciled) must not re-run Stop gates"
      );
    });
  });

  test("fast-path gate: reconnect invalidates reconciled for ALL sessions (authoritative again)", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      h.source.current.push({ type: "server.connected", data: {} });
      await flush();
      await h.registrations.evaluate(evaluateEvent({ sessionID: "ses_r1" }));
      await h.registrations.evaluate(evaluateEvent({ sessionID: "ses_r2" }));
      const evFast1 = evaluateEvent({ sessionID: "ses_r1" });
      await h.registrations.evaluate(evFast1);
      const stopAfter = h.runner.calls.filter((c) => c.event === "Stop").length;
      assert.ok(
        h.runtime.sessionState.get("ses_r1").reconciled === true &&
          h.runtime.sessionState.get("ses_r2").reconciled === true,
        "both sessions reconciled before reconnect"
      );

      // disconnect → resubscribe → server.connected → READY (new generation)
      h.source.current.end();
      await flush();
      assert.equal(h.runtime.transport(), "DEGRADED");
      await until(() => h.source.subscribeCount >= 2, "resubscribed");
      h.source.current.push({ type: "server.connected", data: {} });
      await flush();
      assert.equal(h.runtime.transport(), "READY");
      assert.equal(h.runtime.sessionState.get("ses_r1").reconciled, false);
      assert.equal(h.runtime.sessionState.get("ses_r2").reconciled, false);

      // next evaluate must reconcile authoritatively (Stop gates again), not trust cache
      const evAfter = evaluateEvent({ sessionID: "ses_r1" });
      await h.registrations.evaluate(evAfter);
      assert.equal(evAfter.effect, "allow");
      assert.ok(
        h.runner.calls.filter((c) => c.event === "Stop").length > stopAfter,
        "reconnect must force an authoritative reconcile before allow"
      );
    });
  });

  test("deny re-verify: cached deny but shared state cleared → gates re-run → allow (stale flag does not false-deny)", async () => {
    let mode = "block";
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => (mode === "block" ? blockDecision("stale-block") : PASS),
          "*": PASS,
        },
      },
      async (h) => {
        // establish blocking cache via authoritative reconcile (STARTING evaluate)
        const evDeny = evaluateEvent({ sessionID: "ses_rv" });
        await h.registrations.evaluate(evDeny);
        assert.equal(evDeny.effect, "deny");
        assert.equal(h.runtime.sessionState.get("ses_rv").blocking, true);

        // shared state clears; cache still says deny
        mode = "allow";
        const stopBefore = h.runner.calls.filter((c) => c.event === "Stop").length;
        const evAllow = evaluateEvent({ sessionID: "ses_rv" });
        await h.registrations.evaluate(evAllow);
        assert.equal(evAllow.effect, "allow", "stale deny flag must not false-deny");
        assert.equal(h.runtime.sessionState.get("ses_rv").blocking, false);
        assert.ok(
          h.runner.calls.filter((c) => c.event === "Stop").length > stopBefore,
          "deny re-verify must re-run the Stop gates against shared state"
        );
      }
    );
  });
});

// ── T3: V2 idle→deny host control (R3, R16; D17.6 all 13 cases) ────────────

describe("T3 V2 idle→deny host control", () => {
  test("session.idle triggers Stop gates via --host=opencode; pump never sync-blocks", async () => {
    const hang = deferred();
    let recapCalls = 0;
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            recapCalls += 1;
            return recapCalls === 1 ? hang.promise : PASS;
          },
          "*": PASS,
        },
      },
      async (h) => {
        h.source.current.push({ type: "session.idle", data: { sessionID: SID(1) } });
        await flush();
        await until(() => h.runner.calls.some((c) => c.event === "Stop"));
        for (const c of h.runner.calls.filter((c) => c.event === "Stop")) {
          assert.equal(c.host, "opencode", "Stop gates must run --host=opencode");
        }
        // First job is hanging (async spawn) — the pump must still accept the next
        // event without waiting for the job (no inline sync spawn in the loop).
        h.source.current.push({ type: "session.idle", data: { sessionID: SID(2) } });
        await flush();
        await until(() => h.runtime.queueLength() >= 1);
        assert.ok(
          h.runtime.sessionState.get(SID(2))?.pendingAttempt,
          "second idle must be accepted while the first job is still running"
        );
        // Idle callbacks are Promise<void> fire-and-forget: pushing never rejects.
        hang.resolve(PASS);
        await flush();
      }
    );
  });

  test("Idle Runner Failure Does Not Lock The Session (V2 worker: no sync Stop-block, no lock, the loop survives)", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    await withV2Harness(
      { decisions: { "*": { status: 2, stdout: "", stderr: "recap crashed" } } },
      async (h) => {
        h.source.current.push({ type: "session.idle", data: { sessionID: SID(3) } });
        await flush();
        await until(() => {
          const st = h.runtime.sessionState.get(SID(3));
          return Boolean(st) && st.pendingAttempt === 0 && st.reconciled === true;
        }, "the idle Stop job has been published");
        assert.equal(
          h.runtime.sessionState.get(SID(3)).blocking,
          false,
          "a runner failure on idle must not lock the session"
        );
        // loop survived a failing Stop job — next event still processed
        h.source.current.push({ type: "server.connected", data: {} });
        await flush();
        assert.equal(h.runtime.transport(), "READY");
        const ev = evaluateEvent({ sessionID: SID(3) });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "allow", "runner failure on idle must not deny later calls");
        assert.equal(
          h.calls.synthetic.some((s) => /fail-open/.test(String(s.text || ""))),
          false,
          "the idle diagnostic must not ride ctx.session.synthetic (never a Stop reminder)"
        );
        // The worker catch in the plugin (a stop job that itself throws) is a defensive
        // path: runStopGates already turns a thrown runner into a runner failure (see
        // "a thrown Stop gate then a later explicit block" below), so it has no separate fixture.
        assert.ok(
          v2WarnLogs(warn).some((l) =>
            /hook Stop recap-check\.mjs runner failure \(exit 2\); fail-open/.test(l)
          ),
          "the idle runner failure is still reported"
        );
      }
    );
  });

  test("V2 idle round 1 explicit block then round 2 runner failure unlocks the session", async () => {
    let round = 0;
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            round += 1;
            return Promise.resolve(
              round === 1
                ? blockDecision("v2-round-1-block")
                : { status: 2, stdout: "", stderr: "recap crashed" }
            );
          },
          "*": PASS,
        },
      },
      async (h) => {
        h.source.current.push({ type: "session.idle", data: { sessionID: SID(30) } });
        await flush();
        await until(() => h.runtime.sessionState.get(SID(30))?.blocking === true, "round 1 locks");
        assert.equal(h.runtime.sessionState.get(SID(30)).blockingReason, "v2-round-1-block");

        h.source.current.push({ type: "session.idle", data: { sessionID: SID(30) } });
        await flush();
        await until(() => {
          const st = h.runtime.sessionState.get(SID(30));
          return st.attempt === 2 && st.pendingAttempt === 0;
        }, "round 2 has been published");
        assert.equal(
          h.runtime.sessionState.get(SID(30)).blocking,
          false,
          "a later round that only had a runner failure unlocks"
        );
        const ev = evaluateEvent({ sessionID: SID(30) });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "allow");
      }
    );
  });

  test("V2 same idle round: a thrown Stop gate then a later explicit block still locks with that block's reason", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            throw new Error("recap exploded");
          },
          "Stop::post-pr-completion-check.mjs": {
            status: 1,
            stdout: JSON.stringify({ decision: "block", reason: "v2-post-pr-block" }),
            stderr: "gate exited 2 (launcher translated it to exit 1)",
          },
          "*": PASS,
        },
      },
      async (h) => {
        h.source.current.push({ type: "session.idle", data: { sessionID: SID(31) } });
        await flush();
        await until(() => {
          const st = h.runtime.sessionState.get(SID(31));
          return Boolean(st) && st.pendingAttempt === 0 && st.reconciled === true;
        }, "the idle Stop job has been published");
        const st = h.runtime.sessionState.get(SID(31));
        assert.equal(st.blocking, true);
        assert.equal(st.blockingReason, "v2-post-pr-block");
        assert.ok(
          h.runner.calls.some(
            (c) => c.event === "Stop" && path.basename(c.gate) === "post-pr-completion-check.mjs"
          ),
          "a thrown earlier gate must not stop the later Stop gates from running"
        );
        const logs = v2WarnLogs(warn);
        assert.ok(logs.some((l) => /hook Stop recap-check\.mjs runner failure \(exception\); fail-open/.test(l)));
        assert.equal(logs.some((l) => /recap exploded/.test(l)), false);
      }
    );
  });

  test("Idle Explicit Block Survives Launcher Exit Translation (V2 worker with the real launcher)", async () => {
    const dir = makeTempDir("devpro-v2-idle-launcher-block-");
    try {
      const fixture = path.join(dir, "fixture-stop-gate.mjs");
      writeFileSync(
        fixture,
        [
          "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'v2-fixture-stop-block' }) + '\\n');",
          "process.exit(2);",
        ].join("\n")
      );
      await withV2Harness(
        {
          decisions: {
            "Stop::recap-check.mjs": (args) =>
              pluginMod.defaultRunHookAsync({
                ...args,
                gate: fixture,
                env: { ...(args.env || {}), DEVPRO_AGENT_RULES_LEVEL: "full" },
              }),
            "*": PASS,
          },
        },
        async (h) => {
          h.source.current.push({ type: "session.idle", data: { sessionID: SID(32) } });
          await flush();
          // The Stop gate runs through the real launcher (child-process I/O), so
          // the wait must yield to the event loop between checks.
          await untilIo(() => {
            const st = h.runtime.sessionState.get(SID(32));
            return Boolean(st) && st.pendingAttempt === 0 && st.reconciled === true;
          }, "the idle Stop job has been published");
          const st = h.runtime.sessionState.get(SID(32));
          assert.equal(st.blocking, true, "an explicit block must lock at any exit status");
          assert.equal(st.blockingReason, "v2-fixture-stop-block");
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reminder delivered via ctx.session.synthetic (never ctx.session.prompt)", async () => {
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": {
            status: 0,
            stdout: JSON.stringify({ systemMessage: "Session Recap reminder: write Recap" }),
            stderr: "",
          },
          "*": PASS,
        },
      },
      async (h) => {
        h.source.current.push({ type: "session.idle", data: { sessionID: SID(4) } });
        await flush();
        await until(() => h.calls.synthetic.length >= 1);
        const hit = h.calls.synthetic.find((s) => s.sessionID === SID(4));
        assert.ok(hit, "synthetic reminder must bind the session");
        assert.match(String(hit.text || ""), /Recap/);
        assert.equal(h.calls.promptApi.length, 0, "ctx.session.prompt must never be used");
        assert.equal(h.runtime.sessionState.get(SID(4)).reminderDelivered, true);
      }
    );
  });

  test("undelivered reminder is backed up by the prompt hook (prepend into event.prompt.text)", async () => {
    await withV2Harness(
      {
        syntheticFails: true,
        decisions: {
          "Stop::recap-check.mjs": {
            status: 0,
            stdout: JSON.stringify({ systemMessage: "Session Recap reminder: write Recap" }),
            stderr: "",
          },
          "*": PASS,
        },
      },
      async (h) => {
        h.source.current.push({ type: "session.idle", data: { sessionID: SID(5) } });
        await flush();
        await until(() => h.runtime.sessionState.get(SID(5))?.reminderDelivered === false);
        assert.ok(h.runtime.sessionState.get(SID(5)).reminder);
        const ev = { sessionID: SID(5), prompt: { text: "continue work" } };
        await h.registrations.prompt(ev);
        assert.match(String(ev.prompt.text), /Session Recap reminder/);
        assert.ok(
          String(ev.prompt.text).indexOf("Session Recap reminder") <
            String(ev.prompt.text).indexOf("continue work"),
          "reminder must be prepended (documented transform)"
        );
        assert.equal(h.runtime.sessionState.get(SID(5)).reminderDelivered, true);
      }
    );
  });

  test("admission handoff flush: execute.after appends to result text; synthetic fallback when no text part", async () => {
    const handoff = "admission_record: 54efdef7-f4bc-46c7-baa7-b8dacb2b655c sha256=40a6c74d4c14e8bec3800ab35dca38c63999aa000fd22d54250f52f64543863d";
    const prompt = ADMISSION_PROMPT.replace("role: dp-programmer", "role: dp-reviewer");
    await withV2Harness(
      {
        decisions: {
          "PreToolUse::pre-tool-gate.mjs": {
            status: 0,
            stdout: JSON.stringify({ decision: "allow", systemMessage: handoff }),
            stderr: "",
          },
          "*": PASS,
        },
      },
      async (h) => {
        const ev = evaluateEvent({ action: "subagent", resources: ["dp-reviewer"], metadata: { prompt } });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "allow");
        const after = { sessionID: "ses_t", result: { output: "task-done" } };
        await h.registrations.executeAfter(after);
        assert.match(String(after.result.output), /admission_record:/);
        // fallback: no text part → ctx.session.synthetic
        const ev2 = evaluateEvent({ action: "subagent", resources: ["dp-reviewer"], metadata: { prompt } });
        await h.registrations.evaluate(ev2);
        const before = h.calls.synthetic.length;
        await h.registrations.executeAfter({ sessionID: "ses_t", result: { status: "error" } });
        assert.equal(h.calls.synthetic.length, before + 1);
        assert.match(String(h.calls.synthetic.at(-1).text || ""), /admission_record:/);
      }
    );
  });

  test("admission handoff flush via prompt hook (same channel as reminder backup)", async () => {
    const handoff = "admission_record: 54efdef7-f4bc-46c7-baa7-b8dacb2b655c sha256=aaaa";
    const prompt = ADMISSION_PROMPT.replace("role: dp-programmer", "role: dp-reviewer");
    await withV2Harness(
      {
        decisions: {
          "PreToolUse::pre-tool-gate.mjs": {
            status: 0,
            stdout: JSON.stringify({ decision: "allow", systemMessage: handoff }),
            stderr: "",
          },
          "*": PASS,
        },
      },
      async (h) => {
        const ev = evaluateEvent({ action: "subagent", resources: ["dp-reviewer"], metadata: { prompt } });
        await h.registrations.evaluate(ev);
        const pev = { sessionID: "ses_t", prompt: { text: "original" } };
        await h.registrations.prompt(pev);
        assert.match(String(pev.prompt.text), /admission_record:/);
      }
    );
  });

  test("session.deleted clears session state (ours only)", async () => {
    await withV2Harness(
      { decisions: { "*": blockDecision("gone") } },
      async (h) => {
        h.source.current.push({ type: "session.idle", data: { sessionID: SID(6) } });
        await flush();
        await until(() => h.runtime.sessionState.has(SID(6)));
        h.source.current.push({ type: "session.deleted", data: { sessionID: SID(6) } });
        await flush();
        await until(() => !h.runtime.sessionState.has(SID(6)));
      }
    );
  });

  test("D17.6-1 disconnect missed events → authoritative reconcile compensates (must-block not lost)", async () => {
    let mode = "allow";
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => (mode === "block" ? blockDecision("missed-must-block") : PASS),
          "*": PASS,
        },
      },
      async (h) => {
        // READY + reconciled allow
        h.source.current.push({ type: "server.connected", data: {} });
        await flush();
        await h.registrations.evaluate(evaluateEvent({ sessionID: "ses_dc" }));
        // source failure → DEGRADED; an idle (must-block) happens during the gap
        h.source.current.end();
        await flush();
        assert.equal(h.runtime.transport(), "DEGRADED");
        mode = "block"; // shared state now has must-block
        const ev = evaluateEvent({ sessionID: "ses_dc" });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "deny", "missed must-block must be caught by the authoritative read");
        assert.match(String(ev.message || ""), /missed-must-block/);
      }
    );
  });

  test("D17.6-2 reconnect-bridge: after reconnect, reconcile completes before any allow", async () => {
    let mode = "allow";
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => (mode === "block" ? blockDecision("reconnect-must-block") : PASS),
          "*": PASS,
        },
      },
      async (h) => {
        h.source.current.push({ type: "server.connected", data: {} });
        await flush();
        await h.registrations.evaluate(evaluateEvent({ sessionID: "ses_rb" }));
        // disconnect (missed idle writes must-block) → reconnect
        h.source.current.end();
        await flush();
        mode = "block";
        await until(() => h.source.subscribeCount >= 2, "resubscribed");
        h.source.current.push({ type: "server.connected", data: {} });
        await flush();
        assert.equal(h.runtime.transport(), "READY");
        assert.equal(h.runtime.sessionState.get("ses_rb").reconciled, false);
        const stopBefore = h.runner.calls.filter((c) => c.event === "Stop").length;
        const ev = evaluateEvent({ sessionID: "ses_rb" });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "deny", "no allow between reconnect and reconcile");
        assert.match(String(ev.message || ""), /reconnect-must-block/);
        assert.ok(
          h.runner.calls.filter((c) => c.event === "Stop").length > stopBefore,
          "reconcile ran authoritatively after reconnect"
        );
      }
    );
  });

  test("D17.6-3 startup-blocking: existing must-block state denies the first evaluate", async () => {
    await withV2Harness(
      { decisions: { "*": blockDecision("startup-must-block") } },
      async (h) => {
        assert.equal(h.runtime.transport(), "STARTING");
        const ev = evaluateEvent({ sessionID: "ses_startup" });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "deny");
        assert.match(String(ev.message || ""), /startup-must-block/);
      }
    );
  });

  test("D17.6-4 idle-enqueued → evaluate-before-completion is denied (barrier)", async () => {
    const hang = deferred();
    let recapCalls = 0;
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            recapCalls += 1;
            if (recapCalls === 1) return hang.promise;
            return blockDecision("idle-must-block");
          },
          "*": PASS,
        },
      },
      async (h) => {
        h.source.current.push({ type: "session.idle", data: { sessionID: "ses_bar" } });
        await flush();
        await until(() => h.runtime.sessionState.get("ses_bar")?.pendingAttempt);
        for (const action of ["shell", "probe_status"]) {
          const evPending = evaluateEvent({ sessionID: "ses_bar", action });
          await h.registrations.evaluate(evPending);
          assert.equal(evPending.effect, "deny");
          assert.match(String(evPending.message || ""), /stop verification pending/);
        }

        // job completes with block → subsequent evaluate denies
        hang.resolve(blockDecision("idle-must-block"));
        await flush();
        await until(() => h.runtime.sessionState.get("ses_bar")?.pendingAttempt === 0);
        const evBlocked = evaluateEvent({ sessionID: "ses_bar" });
        await h.registrations.evaluate(evBlocked);
        assert.equal(evBlocked.effect, "deny");
        assert.match(String(evBlocked.message || ""), /idle-must-block/);
      }
    );
  });

  test("D17.6-4b barrier clears on allow completion → subsequent evaluate allowed", async () => {
    const hang = deferred();
    let recapCalls = 0;
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            recapCalls += 1;
            return recapCalls === 1 ? hang.promise : PASS;
          },
          "*": PASS,
        },
      },
      async (h) => {
        h.source.current.push({ type: "session.idle", data: { sessionID: "ses_bar2" } });
        await flush();
        await until(() => h.runtime.sessionState.get("ses_bar2")?.pendingAttempt);
        hang.resolve(PASS);
        await flush();
        await until(() => h.runtime.sessionState.get("ses_bar2")?.pendingAttempt === 0);
        const ev = evaluateEvent({ sessionID: "ses_bar2" });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "allow", "barrier cleared by winner publish → allow");
      }
    );
  });

  test("D17.6-5 coalesced old job must not clear the barrier (token supersession)", async () => {
    const dA = deferred();
    const dB = deferred();
    let recapCalls = 0;
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            recapCalls += 1;
            if (recapCalls === 1) return dA.promise;
            if (recapCalls === 2) return dB.promise;
            return PASS;
          },
          "*": PASS,
        },
      },
      async (h) => {
        const sid = "ses_coalesce";
        h.source.current.push({ type: "session.idle", data: { sessionID: sid } });
        await flush();
        h.source.current.push({ type: "session.idle", data: { sessionID: sid } });
        await flush();
        await until(() => h.runtime.sessionState.get(sid)?.pendingAttempt >= 2);

        // old job (attempt 1) completes with allow → publish loses the token race
        dA.resolve(PASS);
        await flush();
        await until(
          () => h.runner.calls.filter((c) => c.event === "Stop").length >= 5,
          "old job ran all its gates"
        );
        assert.ok(
          h.runtime.sessionState.get(sid).pendingAttempt >= 2,
          "coalesced old job completion must not consume the newer attempt's barrier"
        );
        const evMid = evaluateEvent({ sessionID: sid });
        await h.registrations.evaluate(evMid);
        assert.equal(evMid.effect, "deny", "barrier still held by attempt 2");

        // newest job completes → winner → barrier cleared
        dB.resolve(PASS);
        await flush();
        await until(() => h.runtime.sessionState.get(sid)?.pendingAttempt === 0);
        const evFinal = evaluateEvent({ sessionID: sid });
        await h.registrations.evaluate(evFinal);
        assert.equal(evFinal.effect, "allow");
      }
    );
  });

  test("D17.6-6 barrier takeover: stuck job → evaluate runs the gates itself (single winner)", async () => {
    const hang = deferred();
    let recapCalls = 0;
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            recapCalls += 1;
            if (recapCalls === 1) return hang.promise;
            return blockDecision("takeover-must-block");
          },
          "*": PASS,
        },
      },
      async (h) => {
        const sid = "ses_takeover";
        h.source.current.push({ type: "session.idle", data: { sessionID: sid } });
        await flush();
        await until(() => h.runtime.sessionState.get(sid)?.attemptStartedAt > 0);
        // simulate the job being stuck past the runner timeout + margin
        h.runtime.sessionState.get(sid).attemptStartedAt = Date.now() - 200_000;

        const ev = evaluateEvent({ sessionID: sid });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "deny", "takeover must enforce the authoritative result");
        assert.match(String(ev.message || ""), /takeover-must-block/);
        assert.equal(
          h.runtime.sessionState.get(sid).pendingAttempt,
          0,
          "takeover winner publish must consume the barrier"
        );

        // original job finally returns allow → superseded → discarded
        hang.resolve(PASS);
        await flush();
        const ev2 = evaluateEvent({ sessionID: sid });
        await h.registrations.evaluate(ev2);
        assert.equal(ev2.effect, "deny", "stale completion must not roll back the deny");
      }
    );
  });

  test("queued-but-unstarted job beyond takeover margin → evaluate takes over (enqueue-stamped clock)", async () => {
    // F-aorp2-r1-01 regression: the takeover clock must cover QUEUE WAIT, not
    // only runner execution. A session whose job is accepted but never dequeued
    // (worker busy on an earlier hung job) must be recoverable via evaluate
    // takeover once the margin elapses — not denied "pending" forever.
    const hang = deferred();
    let recapCalls = 0;
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            recapCalls += 1;
            if (recapCalls === 1) return hang.promise; // worker stuck on session A
            return blockDecision("queued-takeover-must-block");
          },
          "*": PASS,
        },
        takeoverTimeoutMs: 200,
      },
      async (h) => {
        // session A: dequeued by the worker and hung → queue stays occupied
        h.source.current.push({ type: "session.idle", data: { sessionID: "ses_worker_busy" } });
        await flush();
        await until(
          () => h.runtime.sessionState.get("ses_worker_busy")?.attemptStartedAt > 0,
          "session A accepted"
        );
        // session B: accepted (beginAttempt stamps the takeover clock) but the
        // worker never dequeues it — attemptStartedAt covers queue wait.
        const sid = "ses_queued_takeover";
        h.source.current.push({ type: "session.idle", data: { sessionID: sid } });
        await flush();
        await until(() => h.runtime.sessionState.get(sid)?.pendingAttempt > 0);
        assert.ok(
          h.runtime.sessionState.get(sid).attemptStartedAt > 0,
          "enqueue must stamp the takeover clock (covers queue wait)"
        );

        // let the margin elapse naturally (no backdating)
        await new Promise((resolve) => setTimeout(resolve, 400));
        const ev = evaluateEvent({ sessionID: sid });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "deny", "queued-job takeover must enforce the authoritative result");
        assert.match(String(ev.message || ""), /queued-takeover-must-block/);
        assert.equal(
          h.runtime.sessionState.get(sid).pendingAttempt,
          0,
          "takeover winner publish must consume the barrier"
        );

        // stale queued job finally runs → token mismatch → discarded; deny stays
        hang.resolve(PASS);
        await flush();
        await until(
          () => h.runner.calls.filter((c) => c.event === "Stop").length >= 15,
          "stale queued job completed all its gates"
        );
        const ev2 = evaluateEvent({ sessionID: sid });
        await h.registrations.evaluate(ev2);
        assert.equal(ev2.effect, "deny", "stale completion must not roll back the deny");
        assert.match(String(ev2.message || ""), /queued-takeover-must-block/);
      }
    );
  });

  test("D17.6-7 slow-consumer overflow → drop + DEGRADED (authoritative path)", async () => {
    const hang = deferred();
    let recapCalls = 0;
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            recapCalls += 1;
            if (recapCalls === 1) return hang.promise;
            return PASS;
          },
          "*": PASS,
        },
      },
      async (h) => {
        const sids = [];
        for (let i = 0; i < 35; i += 1) {
          sids.push(SID(100 + i));
          h.source.current.push({ type: "session.idle", data: { sessionID: sids[i] } });
        }
        await flush(60);
        await until(() => h.runtime.dropped() >= 1);
        assert.ok(h.runtime.queueLength() <= 32, "queue cap must hold");
        assert.equal(h.runtime.transport(), "DEGRADED", "overflow must degrade transport");

        // dropped session has no barrier → authoritative reconcile → eventual admission
        const droppedSid = sids.find((s) => !h.runtime.sessionState.has(s));
        assert.ok(droppedSid, "at least one idle must be dropped");
        const evDropped = evaluateEvent({ sessionID: droppedSid });
        await h.registrations.evaluate(evDropped);
        assert.equal(evDropped.effect, "allow", "dropped session recovers via authoritative path");

        // accepted-but-uncompleted session still holds its barrier (the takeover
        // clock now starts at enqueue — F-aorp2-r1-01 — so "queued" is detected
        // by a pending attempt with a fresh clock, not startedAt === 0)
        const queuedSid = sids.find(
          (s) =>
            h.runtime.sessionState.has(s) &&
            h.runtime.sessionState.get(s).pendingAttempt > 0
        );
        assert.ok(queuedSid, "at least one accepted session must hold its barrier");
        const evQueued = evaluateEvent({ sessionID: queuedSid });
        await h.registrations.evaluate(evQueued);
        assert.equal(evQueued.effect, "deny");
        assert.match(String(evQueued.message || ""), /stop verification pending/);
        hang.resolve(PASS);
        await flush();
      }
    );
  });

  test("D17.6-8 foreign session: idle ignored (no runner), evaluate pass-through", async () => {
    const sessionGet = (sid) =>
      sid === "ses_foreign_v2"
        ? { location: { directory: FOREIGN_DIR, workspaceID: "wrk_foreign" }, projectID: "prj_f" }
        : { location: { directory: OUR_DIR }, projectID: "prj_test" };
    await withV2Harness({ decisions: { "*": PASS }, sessionGet }, async (h) => {
      h.source.current.push({ type: "session.idle", data: { sessionID: "ses_foreign_v2" } });
      await flush();
      assert.equal(
        h.runner.calls.length,
        0,
        "foreign idle must not run Stop gates or touch state"
      );
      const ev = evaluateEvent({ sessionID: "ses_foreign_v2", effect: "allow" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      assert.equal(h.runner.calls.length, 0);
    });
  });

  test("D17.6-9 unresolvable ownership: idle ignored + reconcile flag; evaluate deny", async () => {
    const sessionGet = (sid) => {
      throw new Error(`no session ${sid}`);
    };
    await withV2Harness({ decisions: { "*": PASS }, sessionGet }, async (h) => {
      h.source.current.push({ type: "session.idle", data: { sessionID: "ses_unres2" } });
      await flush();
      assert.equal(
        h.runner.calls.length,
        0,
        "unresolvable idle must not invoke the runner"
      );
      assert.equal(h.runtime.sessionState.get("ses_unres2").reconciled, false);
      const ev = evaluateEvent({ sessionID: "ses_unres2" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      assert.match(String(ev.message || ""), /ownership unresolvable/i);
    });
  });

  test("D17.6-10 one-server-two-repos: only ours triggers gates; foreign never denied", async () => {
    const sessionGet = (sid) =>
      sid === "ses_foreign_2"
        ? { location: { directory: FOREIGN_DIR, workspaceID: "wrk_foreign" }, projectID: "prj_f" }
        : { location: { directory: OUR_DIR }, projectID: "prj_test" };
    await withV2Harness({ decisions: { "*": PASS }, sessionGet }, async (h) => {
      // two locations broadcast on one stream
      h.source.current.push({ type: "session.idle", data: { sessionID: "ses_ours_2" } });
      h.source.current.push({ type: "session.idle", data: { sessionID: "ses_foreign_2" } });
      await flush();
      await until(() => h.runner.calls.some((c) => c.event === "Stop"));
      const stopPayloads = h.runner.calls
        .filter((c) => c.event === "Stop")
        .map((c) => JSON.parse(c.payload || "{}").session_id);
      assert.ok(stopPayloads.every((s) => s === "ses_ours_2"), "only ours runs Stop gates");
      const evForeign = evaluateEvent({ sessionID: "ses_foreign_2", effect: "ask" });
      await h.registrations.evaluate(evForeign);
      assert.equal(evForeign.effect, "ask", "foreign evaluate must pass through unchanged");
      await until(
        () => h.runtime.sessionState.get("ses_ours_2")?.pendingAttempt === 0,
        "ours idle job completed"
      );
      const evOurs = evaluateEvent({ sessionID: "ses_ours_2" });
      await h.registrations.evaluate(evOurs);
      assert.equal(evOurs.effect, "allow");
    });
  });

  test("D17.6-11 deny re-verify via idle must-block then shared-state clear", async () => {
    let mode = "block";
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => (mode === "block" ? blockDecision("idle-block") : PASS),
          "*": PASS,
        },
      },
      async (h) => {
        h.source.current.push({ type: "session.idle", data: { sessionID: "ses_rv2" } });
        await flush();
        await until(() => h.runtime.sessionState.get("ses_rv2")?.blocking === true);
        const evDeny = evaluateEvent({ sessionID: "ses_rv2" });
        await h.registrations.evaluate(evDeny);
        assert.equal(evDeny.effect, "deny");

        mode = "allow"; // shared state cleared by the recap pipeline
        const evAllow = evaluateEvent({ sessionID: "ses_rv2" });
        await h.registrations.evaluate(evAllow);
        assert.equal(evAllow.effect, "allow", "stale deny must be re-verified and cleared");
        assert.equal(h.runtime.sessionState.get("ses_rv2").blocking, false);
      }
    );
  });

  test("D17.6-12 reconnect old completion must not reverse invalidation (three assertions)", async () => {
    const hang = deferred();
    let recapCalls = 0;
    let mode = "block";
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            recapCalls += 1;
            if (recapCalls === 1) return hang.promise; // job begun at gen X
            return mode === "block" ? blockDecision("post-reconnect-must-block") : PASS;
          },
          "*": PASS,
        },
      },
      async (h) => {
        const sid = "ses_old_completion";
        h.source.current.push({ type: "session.idle", data: { sessionID: sid } });
        await flush();
        await until(() => h.runtime.sessionState.get(sid)?.attemptStartedAt > 0);

        // disconnect (missed must-block written to shared state) → reconnect (gen bump)
        h.source.current.end();
        await flush();
        await until(() => h.source.subscribeCount >= 2, "resubscribed");
        h.source.current.push({ type: "server.connected", data: {} });
        await flush();
        assert.equal(h.runtime.transport(), "READY");
        assert.ok(h.runtime.transportGen() > 1, "reconnect must bump the transport generation");
        assert.equal(h.runtime.sessionState.get(sid).reconciled, false);

        // old job completes with allow → owning gen-mismatch → discard + consume barrier
        hang.resolve(PASS);
        await flush();
        await until(() => h.runtime.sessionState.get(sid)?.pendingAttempt === 0);
        assert.equal(
          h.runtime.sessionState.get(sid).blocking,
          false,
          "stale allow must not overwrite blocking"
        );
        assert.equal(
          h.runtime.sessionState.get(sid).reconciled,
          false,
          "cross-generation read must not restore freshness"
        );

        // ① invalidation not reversed: next evaluate re-reads authoritative state → deny
        const stopBefore = h.runner.calls.filter((c) => c.event === "Stop").length;
        const ev1 = evaluateEvent({ sessionID: sid });
        await h.registrations.evaluate(ev1);
        assert.equal(ev1.effect, "deny", "① old completion must not reverse reconnect invalidation");
        assert.match(String(ev1.message || ""), /post-reconnect-must-block/);
        // ② barrier consumed (evaluate reached the authoritative step, not stuck pending)
        assert.doesNotMatch(String(ev1.message || ""), /stop verification pending/);
        assert.ok(
          h.runner.calls.filter((c) => c.event === "Stop").length > stopBefore,
          "② barrier consumed — reconcile ran instead of a permanent pending deny"
        );

        // ③ eventual admission: state cleared → winner publish in current generation → allow
        mode = "allow";
        const ev2 = evaluateEvent({ sessionID: sid });
        await h.registrations.evaluate(ev2);
        assert.equal(ev2.effect, "allow", "③ eventual admission after current-generation reconcile");
        assert.equal(h.runtime.sessionState.get(sid).reconciled, true);
        assert.equal(h.runtime.sessionState.get(sid).blocking, false);
      }
    );
  });

  test("D17.6-13 takeover then original job returns allow → still deny (losing completion discarded)", async () => {
    const hang = deferred();
    let recapCalls = 0;
    await withV2Harness(
      {
        decisions: {
          "Stop::recap-check.mjs": () => {
            recapCalls += 1;
            if (recapCalls === 1) return hang.promise;
            return blockDecision("takeover-2-must-block");
          },
          "*": PASS,
        },
      },
      async (h) => {
        const sid = "ses_takeover_2";
        h.source.current.push({ type: "session.idle", data: { sessionID: sid } });
        await flush();
        await until(() => h.runtime.sessionState.get(sid)?.attemptStartedAt > 0);
        h.runtime.sessionState.get(sid).attemptStartedAt = Date.now() - 200_000;

        // takeover: evaluate runs the gates synchronously → blocking deny
        const ev1 = evaluateEvent({ sessionID: sid });
        await h.registrations.evaluate(ev1);
        assert.equal(ev1.effect, "deny");
        assert.equal(h.runtime.sessionState.get(sid).pendingAttempt, 0);

        // original job finally returns allow → token mismatch → discarded
        hang.resolve(PASS);
        await flush();
        await until(
          () => h.runner.calls.filter((c) => c.event === "Stop").length >= 10,
          "stale job completed all its gates"
        );
        const ev2 = evaluateEvent({ sessionID: sid });
        await h.registrations.evaluate(ev2);
        assert.equal(ev2.effect, "deny", "takeover verdict must survive the old job's allow");
        assert.match(String(ev2.message || ""), /takeover-2-must-block/);
        assert.equal(h.runtime.sessionState.get(sid).blocking, true);
      }
    );
  });

  test("transport generations: STARTING → READY → DEGRADED → FAILED (retries exhausted)", async () => {
    await withV2Harness(
      {
        decisions: { "*": PASS },
        eventBackoffMs: [0, 0, 0],
      },
      async (h) => {
        assert.equal(h.runtime.transport(), "STARTING");
        h.source.current.push({ type: "server.connected", data: {} });
        await flush();
        assert.equal(h.runtime.transport(), "READY");
        // 3 resubscribe retries, all failing → FAILED
        h.source.current.end();
        await flush();
        await until(() => h.source.subscribeCount >= 2);
        assert.equal(h.runtime.transport(), "DEGRADED");
        h.source.current.end();
        await flush();
        await until(() => h.source.subscribeCount >= 3);
        h.source.current.end();
        await flush();
        await until(() => h.source.subscribeCount >= 4);
        h.source.current.end();
        await flush();
        await until(() => h.runtime.transport() === "FAILED", "transport FAILED");
        // enforcement still authoritative (never silent allow) after FAILED
        const ev = evaluateEvent({ sessionID: "ses_failed" });
        await h.registrations.evaluate(ev);
        assert.equal(ev.effect, "allow");
        assert.ok(
          h.runner.calls.some((c) => c.event === "Stop"),
          "FAILED transport must still reconcile authoritatively"
        );
      }
    );
  });

  test("V2 runtime diagnostics are attached for observability (ctx.__devproHooksV2, test-mode gated)", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      assert.ok(h.runtime, "diagnostics handle must be attached in test mode");
      assert.equal(typeof h.runtime.transport, "function");
      assert.ok(h.runtime.sessionState instanceof Map);
    });
  });

  test("F-aorp2-r2-02: diagnostics handle is NOT attached outside test mode", async () => {
    await withV2Harness(
      { decisions: { "*": PASS }, testMode: false },
      async (h) => {
        assert.equal(
          h.ctx.__devproHooksV2,
          undefined,
          "production ctx must not carry the observability handle"
        );
      }
    );
  });

  test("F-aorp2-r2-01: foreign session.deleted clears local bookkeeping; ghost state is not recreated", async () => {
    const idleProbe = deferred();
    let getCalls = 0;
    const sessionGet = (sid) => {
      getCalls += 1;
      if (sid === "ses_ghost" && getCalls === 1) {
        return idleProbe.promise; // scheduled idle's ownership probe in flight
      }
      if (sid === "ses_ghost" && getCalls >= 3) {
        throw new Error("session gone"); // post-delete probes → unresolvable
      }
      return { location: { directory: FOREIGN_DIR, workspaceID: "wrk_foreign" }, projectID: "prj_f" };
    };
    await withV2Harness({ decisions: { "*": PASS }, sessionGet }, async (h) => {
      // idle scheduled first: its ownership probe hangs (get call #1)
      h.source.current.push({ type: "session.idle", data: { sessionID: "ses_ghost" } });
      await flush();
      // deleted arrives while the idle chain is still pending; resolves foreign
      h.source.current.push({ type: "session.deleted", data: { sessionID: "ses_ghost" } });
      await flush();
      await until(() => getCalls >= 2, "deleted ownership probe ran");
      // the in-flight idle probe finally resolves "ours" — the tombstone must
      // stop it from recreating ghost state or invoking gates
      idleProbe.resolve({ location: { directory: OUR_DIR }, projectID: "prj_test" });
      await flush(40);
      assert.equal(
        h.runtime.sessionState.has("ses_ghost"),
        false,
        "deleted session must not gain ghost state from a scheduled idle chain"
      );
      assert.equal(h.runtime.queueLength(), 0, "ghost idle must not enqueue a job");
      assert.equal(
        h.runner.calls.filter((c) => c.event === "Stop").length,
        0,
        "ghost idle must not invoke Stop gates"
      );
      // subsequent evaluate for the deleted session resolves fresh → unresolvable
      const ev = evaluateEvent({ sessionID: "ses_ghost" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      assert.match(String(ev.message || ""), /ownership unresolvable/i);
    });
  });

  test("F-aorp2-r2-01: foreign bookkeeping is bounded (eviction caps)", async () => {
    const sessionGet = () => ({
      location: { directory: FOREIGN_DIR, workspaceID: "wrk_foreign" },
      projectID: "prj_f",
    });
    await withV2Harness({ decisions: { "*": PASS }, sessionGet }, async (h) => {
      const N = 300; // > V2 bookkeeping cap (256)
      for (let i = 0; i < N; i += 1) {
        h.source.current.push({
          type: "session.idle",
          data: { sessionID: `ses_foreign_evict_${i}` },
        });
      }
      await flush(80);
      await until(
        () => h.runtime.ownershipCacheSize() >= 1,
        "foreign ownership probes started"
      );
      await flush(200);
      assert.ok(
        h.runtime.ownershipCacheSize() <= 256,
        `ownershipCache must stay bounded, got ${h.runtime.ownershipCacheSize()}`
      );
      assert.ok(
        h.runtime.sessionChainsSize() <= 256,
        `sessionChains must stay bounded, got ${h.runtime.sessionChainsSize()}`
      );
    });
  });

  test("F-aorp2-r2-03: backup reminder marks delivered only after the prepend mutation succeeds", async () => {
    await withV2Harness(
      {
        syntheticFails: true,
        decisions: {
          "Stop::recap-check.mjs": {
            status: 0,
            stdout: JSON.stringify({ systemMessage: "Session Recap reminder: write Recap" }),
            stderr: "",
          },
          "*": PASS,
        },
      },
      async (h) => {
        const sid = "ses_rem_mark";
        h.source.current.push({ type: "session.idle", data: { sessionID: sid } });
        await flush();
        await until(() => h.runtime.sessionState.get(sid)?.reminderDelivered === false);
        assert.ok(h.runtime.sessionState.get(sid).reminder);

        // read-only text surface → mutation throws → delivered must stay false
        const frozen = { sessionID: sid };
        Object.defineProperty(frozen, "prompt", {
          value: Object.defineProperty({}, "text", {
            get: () => "readonly",
          }),
          enumerable: true,
        });
        await assert.rejects(async () => {
          await h.registrations.prompt(frozen);
        });
        assert.equal(
          h.runtime.sessionState.get(sid).reminderDelivered,
          false,
          "failed mutation must not mark the reminder delivered"
        );

        // a normal prompt delivers the backup and marks delivered
        const ok = { sessionID: sid, prompt: { text: "continue work" } };
        await h.registrations.prompt(ok);
        assert.match(String(ok.prompt.text), /Session Recap reminder/);
        assert.equal(h.runtime.sessionState.get(sid).reminderDelivered, true);
      }
    );
  });
});

// ── T5: runner equivalence + async decision path (fix-hook-gate-server-block) ─

/** Classify a runner result through the plugin's own classifier (no mirror copy):
 *  the V1 hooks object exposes `classifyRunnerResult` via its existing `__test__`. */
async function classifyViaPlugin(result, gatePath) {
  const hooks = await pluginMod.default.server({ directory: OUR_DIR });
  return hooks.__test__.classifyRunnerResult(result, { event: "PreToolUse", gate: gatePath });
}

function writeFixtureGate(dir, body) {
  const gatePath = path.join(dir, "fixture-decision-gate.mjs");
  writeFileSync(gatePath, `#!/usr/bin/env node\n${body}`);
  return gatePath;
}

const FIXTURE_GATE_PROBE = `
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => {
  const envOk =
    process.env.DEVPRO_HOOK_EVENT === "PreToolUse" &&
    process.env.DEVPRO_HOOK_HOST === "opencode";
  const payloadOk = data.includes("payload-probe");
  process.stdout.write(
    JSON.stringify(
      envOk && payloadOk
        ? { decision: "allow" }
        : { decision: "block", reason: "env-or-payload-mismatch" }
    ) + "\\n"
  );
});
`;

const FIXTURE_GATE_BLOCK = `
process.stdout.write(
  JSON.stringify({ decision: "block", reason: "fixture-block-reason" }) + "\\n"
);
`;

const FIXTURE_GATE_EXIT7 = `
process.stderr.write("fixture gate crashing\\n");
process.exit(7);
`;

const FIXTURE_GATE_SLEEP_600 = `
setTimeout(() => process.exit(0), 600);
`;

const FIXTURE_GATE_HANG = `
setTimeout(() => process.exit(0), 60_000);
`;

function runnerArgs(gatePath, payload) {
  return {
    event: "PreToolUse",
    gate: gatePath,
    host: "opencode",
    payload,
    cwd: OUR_DIR,
  };
}

async function withFixtureGate(body, fn) {
  const dir = makeTempDir("devpro-hooks-runner-equiv-");
  try {
    const gatePath = writeFixtureGate(dir, body);
    return await fn(gatePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("T5 runner equivalence + async decision path (fix-hook-gate-server-block)", () => {
  test("source anchor: runDecisionGates default branch awaits defaultRunHookAsync exactly once; sync same-shape is 0", () => {
    const src = readFileSync(PLUGIN_JS, "utf8");
    const asyncHits =
      src.split("await defaultRunHookAsync({ event: g.event, gate: g.gate").length - 1;
    const syncHits =
      src.split("defaultRunHook({ event: g.event, gate: g.gate").length - 1;
    assert.equal(
      asyncHits,
      1,
      "runDecisionGates default branch must await defaultRunHookAsync (RED pre-fix)"
    );
    assert.equal(
      syncHits,
      0,
      "sync defaultRunHook must not remain on the evaluate decision path"
    );
  });

  test("named exports: defaultRunHook / defaultRunHookAsync are additive test seams", () => {
    assert.equal(typeof pluginMod.defaultRunHook, "function");
    assert.equal(typeof pluginMod.defaultRunHookAsync, "function");
  });

  test("sync/async equivalence: allow — identical decision; payload and env reach the gate via both input paths", async () => {
    await withFixtureGate(FIXTURE_GATE_PROBE, async (gatePath) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "payload-probe" },
        session_id: "ses_eq",
        cwd: OUR_DIR,
      });
      const args = runnerArgs(gatePath, payload);
      const syncResult = pluginMod.defaultRunHook(args);
      const asyncResult = await pluginMod.defaultRunHookAsync(args);
      const syncClass = await classifyViaPlugin(syncResult, gatePath);
      const asyncClass = await classifyViaPlugin(asyncResult, gatePath);
      assert.deepEqual(syncClass, asyncClass, "both runners must produce the same decision shape");
      assert.equal(syncClass.kind, "allow");
      assert.equal(syncResult.stdout, asyncResult.stdout);
    });
  });

  test("sync/async equivalence: decision:block → identical deny reason", async () => {
    await withFixtureGate(FIXTURE_GATE_BLOCK, async (gatePath) => {
      const args = runnerArgs(gatePath, JSON.stringify({}));
      const syncResult = pluginMod.defaultRunHook(args);
      const asyncResult = await pluginMod.defaultRunHookAsync(args);
      for (const [label, result] of [
        ["sync", syncResult],
        ["async", asyncResult],
      ]) {
        const classified = await classifyViaPlugin(result, gatePath);
        assert.equal(classified.kind, "block", `${label} runner must surface decision:block`);
        assert.equal(classified.reason, "fixture-block-reason", label);
      }
    });
  });

  test("sync/async equivalence: gate exit≠0 → runner-failure (fail-open polarity equal)", async () => {
    await withFixtureGate(FIXTURE_GATE_EXIT7, async (gatePath) => {
      const args = runnerArgs(gatePath, JSON.stringify({}));
      const syncResult = pluginMod.defaultRunHook(args);
      const asyncResult = await pluginMod.defaultRunHookAsync(args);
      for (const [label, result] of [
        ["sync", syncResult],
        ["async", asyncResult],
      ]) {
        const classified = await classifyViaPlugin(result, gatePath);
        assert.equal(classified.kind, "runner-failure", label);
        assert.match(classified.diagnostic, /runner failure \(exit 1\); fail-open$/, label);
      }
    });
  });

  test("sync/async equivalence: plugin-timer timeout → runner-failure (fail-open polarity equal; cause text differs by leg)", async () => {
    const prev = process.env.DEVPRO_HOOK_TIMEOUT_MS;
    process.env.DEVPRO_HOOK_TIMEOUT_MS = "400";
    const started = Date.now();
    try {
      await withFixtureGate(FIXTURE_GATE_HANG, async (gatePath) => {
        // The child env pins the launcher's own timer to 5 s, so only the plugin's
        // 400 ms timer (read from process.env) fires: no launcher-translated exit 0.
        const args = {
          ...runnerArgs(gatePath, JSON.stringify({})),
          env: { DEVPRO_HOOK_TIMEOUT_MS: "5000" },
        };
        const syncResult = pluginMod.defaultRunHook(args);
        const asyncResult = await pluginMod.defaultRunHookAsync(args);
        const syncClass = await classifyViaPlugin(syncResult, gatePath);
        const asyncClass = await classifyViaPlugin(asyncResult, gatePath);
        assert.equal(syncClass.kind, "runner-failure");
        assert.equal(asyncClass.kind, "runner-failure");
        // D5 documented asymmetry: the cause text differs between runners
        // (ETIMEDOUT vs "killed by SIGKILL"); the pin is POLARITY, not text.
        assert.match(syncClass.diagnostic, /error ETIMEDOUT\); fail-open$/);
        assert.match(asyncClass.diagnostic, /signal SIGKILL\); fail-open$/);
      });
    } finally {
      if (prev === undefined) delete process.env.DEVPRO_HOOK_TIMEOUT_MS;
      else process.env.DEVPRO_HOOK_TIMEOUT_MS = prev;
    }
    assert.ok(
      Date.now() - started < 3000,
      "only the plugin's own 400 ms timers may fire (launcher timer pinned to 5 s)"
    );
  });

  test("event-loop prove-it: async runner yields interval ticks during a 600ms gate; sync runner yields zero", async () => {
    await withFixtureGate(FIXTURE_GATE_SLEEP_600, async (gatePath) => {
      const args = runnerArgs(gatePath, JSON.stringify({}));
      let ticks = 0;
      const syncTimer = setInterval(() => {
        ticks += 1;
      }, 20);
      let syncResult;
      try {
        syncResult = pluginMod.defaultRunHook(args);
      } finally {
        clearInterval(syncTimer);
      }
      const syncTicks = ticks;
      // spawnSync blocks the loop, but Node's sync-spawn startup phase can
      // yield once (observed 1 tick on Node 20.19) — keep the absolute bound
      // as a sanity ceiling only; the structural pin is the relative gap
      // against the async leg below.
      assert.ok(
        syncTicks <= 1,
        `sync runner must not service the event loop during the gate (saw ${syncTicks} ticks)`
      );
      assert.equal(syncResult.status, 0);

      ticks = 0;
      const asyncTimer = setInterval(() => {
        ticks += 1;
      }, 20);
      let asyncResult;
      try {
        asyncResult = await pluginMod.defaultRunHookAsync(args);
      } finally {
        clearInterval(asyncTimer);
      }
      const asyncTicks = ticks;
      // Structural pin (F-fhgb-r1-05): the async runner must service the loop
      // meaningfully more than the sync runner during the same gate. Measured
      // RELATIVE to the sync leg's own startup-phase tick count, so the
      // assertion does not depend on the exact tick count a Node version
      // yields during spawnSync startup.
      assert.ok(
        asyncTicks >= syncTicks + 3,
        `async runner must yield the event loop during the gate (async ${asyncTicks} ticks vs sync ${syncTicks} ticks)`
      );
      assert.equal(asyncResult.status, 0);
    });
  });
});

// ── fix-silent-gate-skip R3 preserved as host-variant passthrough ─────────
//
// Design D5 (fix-flow-gate-gaps): hosts that ship the proposal args as
// event/metadata fields (args-as-metadata host variant) stay supported
// (source 2 of the source order). The real host of this repo is covered by
// the T10 block below (live-read of the in-flight tool part).

describe("fix-silent-gate-skip R3 host-variant passthrough (preserved)", () => {
  test("write action maps content into pre-tool-gate tool_input", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      const body = "# meeting-notes\nclarification: ok\n";
      const ev = evaluateEvent({
        action: "write",
        resources: ["openspec/changes/demo/meeting-notes.md"],
        metadata: { content: body },
      });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      const pre = h.runner.calls.filter((c) => c.event === "PreToolUse");
      assert.ok(pre.length >= 1, "must invoke PreToolUse");
      const payload = JSON.parse(pre[pre.length - 1].payload || "{}");
      assert.equal(payload.tool_name, "Write");
      assert.equal(payload.tool_input.file_path, "openspec/changes/demo/meeting-notes.md");
      assert.equal(payload.tool_input.content, body);
    });
  });

  test("edit action maps old_string/new_string into tool_input", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      const ev = evaluateEvent({
        action: "edit",
        resources: ["openspec/changes/demo/meeting-notes.md"],
        metadata: { old_string: "a", new_string: "b" },
      });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      const pre = h.runner.calls.filter((c) => c.event === "PreToolUse");
      const payload = JSON.parse(pre[pre.length - 1].payload || "{}");
      assert.equal(payload.tool_name, "Edit");
      assert.equal(payload.tool_input.old_string, "a");
      assert.equal(payload.tool_input.new_string, "b");
    });
  });

  test("write missing content → fail-closed deny (no silent empty pass)", async () => {
    await withV2Harness({ decisions: { "*": PASS } }, async (h) => {
      const ev = evaluateEvent({
        action: "write",
        resources: ["openspec/changes/demo/meeting-notes.md"],
        metadata: {},
      });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      // D5: the missing-field path is now the NAMED fail-closed contract
      // (was a bare "missing content field" string pre-fix).
      assert.match(String(ev.message || ""), /proposal fields unresolvable \(fail-closed/);
      assert.match(String(ev.message || ""), /missing=/);
      const writeCalls = h.runner.calls.filter(
        (c) => c.event === "PreToolUse" && String(c.payload || "").includes('"Write"')
      );
      assert.equal(writeCalls.length, 0, "must not invoke Write gate with empty content");
    });
  });
});

// ── T10 [R5, R9, R14]: OpenCode V2 write/edit proposal content contract ────
//
// Fixtures mirror the REAL host shapes proven by the T-R5a live probe
// (notes/tmp/t-r5a-live-probe/probe-log.jsonl, opencode v2.0.1):
//   - write AND edit tools both send action:"edit" + resources:[path] +
//     metadata:{files:[FileDiff]} — no content/oldString/newString on the event;
//   - during evaluate the in-flight tool part is already in
//     ctx.session.context({sessionID}) and is matched exactly by
//     event.source.id === part.id; the real args live at part.state.input.
// The bridge MUST take the write PROPOSAL from those sources (source order in
// design D5) and MUST NEVER validate the on-disk/current file content.

const T10_WRITE_BODY = [
  "# meeting-notes",
  "clarification: ok",
  "proposal: T10 live-probe shape",
].join("\n");

function t10FileDiff(filePath, patch = "@@ -1 +1 @@\n-OLD-DISK-LINE\n+NEW-PROPOSAL-LINE\n") {
  return { file: filePath, patch, status: "modified", additions: 1, deletions: 1 };
}

/** Real host event: write/edit both arrive as action "edit" + metadata.files. */
function t10HostEvent({
  filePath,
  sourceId,
  patch,
  action = "edit",
  sessionID = SID("t10"),
  effect = "allow",
}) {
  return evaluateEvent({
    sessionID,
    action,
    resources: [filePath],
    metadata: { files: [t10FileDiff(filePath, patch)] },
    source: { type: "tool", messageID: "msg_t10", id: sourceId },
    effect,
  });
}

/** Real host in-flight tool part (probe-log.jsonl shape). */
function t10ToolPart({ id, name, input }) {
  return {
    id: "msg_t10",
    type: "assistant",
    content: [
      {
        type: "tool",
        id,
        name,
        executed: false,
        state: { status: "running", input, metadata: {} },
        time: { created: 1 },
      },
    ],
  };
}

function t10PreCalls(h) {
  return h.runner.calls.filter((c) => c.event === "PreToolUse");
}

describe("fix-flow-gate-gaps T10 OpenCode V2 write/edit proposal contract", () => {
  test("T10(i) real host write shape → tool_name Write + proposal content (patch never a source)", async () => {
    const filePath = "openspec/changes/demo/meeting-notes.md";
    const sessionContext = () => [
      t10ToolPart({ id: "call_w10", name: "write", input: { path: filePath, content: T10_WRITE_BODY } }),
    ];
    await withV2Harness({ decisions: { "*": PASS }, sessionContext }, async (h) => {
      const ev = t10HostEvent({ filePath, sourceId: "call_w10" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      const pre = t10PreCalls(h);
      assert.equal(pre.length, 1);
      const payload = JSON.parse(pre[0].payload || "{}");
      assert.equal(payload.tool_name, "Write");
      assert.equal(payload.tool_input.file_path, filePath);
      assert.equal(payload.tool_input.content, T10_WRITE_BODY, "payload must carry the live-read proposal");
      assert.ok(
        !String(payload.tool_input.content).includes("@@"),
        "metadata.files[].patch MUST NOT be used as content"
      );
      assert.equal(h.calls.context.length, 1, "proposal resolution must live-read the context exactly once");
    });
  });

  test("T10(ii) real host edit shape → tool_name Edit + old_string/new_string/replace_all mapping", async () => {
    const filePath = "openspec/changes/demo/meeting-notes.md";
    const sessionContext = () => [
      t10ToolPart({
        id: "call_e10",
        name: "edit",
        input: { path: filePath, oldString: "alpha", newString: "beta", replaceAll: true },
      }),
    ];
    await withV2Harness({ decisions: { "*": PASS }, sessionContext }, async (h) => {
      const ev = t10HostEvent({ filePath, sourceId: "call_e10" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      const payload = JSON.parse(t10PreCalls(h)[0].payload || "{}");
      assert.equal(payload.tool_name, "Edit");
      assert.equal(payload.tool_input.file_path, filePath);
      assert.equal(payload.tool_input.old_string, "alpha");
      assert.equal(payload.tool_input.new_string, "beta");
      assert.equal(payload.tool_input.replace_all, true);
    });
  });

  test("T10(iii) witness: on-disk content ≠ proposal → payload carries the proposal, never the current file", async () => {
    const dir = makeTempDir("devpro-v2-bridge-witness-");
    try {
      const file = path.join(dir, "meeting-notes.md");
      const onDisk = "# meeting-notes\nON-DISK-CURRENT-CONTENT\n";
      writeFileSync(file, onDisk);

      // write witness: the proposal body differs from the file's current bytes.
      await withV2Harness(
        {
          decisions: { "*": PASS },
          sessionContext: () => [
            t10ToolPart({ id: "call_w11", name: "write", input: { path: file, content: T10_WRITE_BODY } }),
          ],
        },
        async (h) => {
          const ev = t10HostEvent({ filePath: file, sourceId: "call_w11" });
          await h.registrations.evaluate(ev);
          assert.equal(ev.effect, "allow");
          const payload = JSON.parse(t10PreCalls(h)[0].payload || "{}");
          assert.equal(payload.tool_input.content, T10_WRITE_BODY);
          assert.notEqual(payload.tool_input.content, onDisk);
          assert.ok(
            !JSON.stringify(payload).includes("ON-DISK-CURRENT-CONTENT"),
            "the on-disk current content must never reach the gate payload"
          );
        }
      );

      // edit witness: omitting old_string is exactly what made the old bridge
      // validate the file's current content (simulatePostWriteContent fallback).
      await withV2Harness(
        {
          decisions: { "*": PASS },
          sessionContext: () => [
            t10ToolPart({
              id: "call_e11",
              name: "edit",
              input: { path: file, oldString: "ON-DISK-CURRENT-CONTENT", newString: "PROPOSED-REPLACEMENT" },
            }),
          ],
        },
        async (h) => {
          const ev = t10HostEvent({ filePath: file, sourceId: "call_e11" });
          await h.registrations.evaluate(ev);
          assert.equal(ev.effect, "allow");
          const payload = JSON.parse(t10PreCalls(h)[0].payload || "{}");
          assert.equal(payload.tool_input.old_string, "ON-DISK-CURRENT-CONTENT");
          assert.equal(payload.tool_input.new_string, "PROPOSED-REPLACEMENT");
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("T10(iv) both sources missing → named fail-closed deny + zero PreToolUse calls", async () => {
    const sessionContext = () => [
      t10ToolPart({ id: "call_other", name: "write", input: { path: "other.md", content: "x" } }),
    ];
    await withV2Harness({ decisions: { "*": PASS }, sessionContext }, async (h) => {
      const ev = t10HostEvent({
        filePath: "openspec/changes/demo/meeting-notes.md",
        sourceId: "call_missing",
      });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      const msg = String(ev.message || "");
      assert.match(msg, /OpenCode V2 write\/edit proposal fields unresolvable \(fail-closed/);
      assert.ok(
        msg.includes("missing=part[call_missing]+explicit-fields"),
        `missing tokens must name the miss: ${msg}`
      );
      assert.match(msg, /user-authorized/, "deny reason must carry the recovery guidance");
      assert.match(msg, /metadata\.files\[\]\.patch/, "patch may appear as a deny diagnostic note only");
      assert.equal(
        t10PreCalls(h).length,
        0,
        "unresolvable proposal MUST NOT invoke any pre-tool gate"
      );
    });
  });

  test("T10(v) apply_patch shape stays functions.apply_patch (normalize regression)", async () => {
    const patchText =
      "*** Begin Patch\n*** Update File: /tmp/devpro-opencode-apply-patch-probe.txt\n@@\n+hello\n*** End Patch";
    const calls = [];
    const hooks = pluginMod.createDevproPluginHooks({
      directory: OUR_DIR,
      runHook: (args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const permOut = { status: "ask" };
    await hooks["permission.ask"](
      {
        id: "p_ap",
        type: "apply_patch",
        sessionID: SID("t10-ap"),
        metadata: { args: { patchText } },
      },
      permOut
    );
    assert.equal(calls.length, 1);
    const payload = JSON.parse(calls[0].payload || "{}");
    assert.equal(payload.tool_name, "functions.apply_patch");
    assert.equal(payload.tool_input.patchText, patchText);
    assert.equal(payload.tool_input.patch, patchText);
  });

  test("T10(viii) V1 face camelCase Edit args normalize onto snake_case proposal fields (NFR1)", async () => {
    // Design D5: the same normalizer fixes the V1 face — 1.18.29 Edit args are
    // camelCase, so the shared gates previously saw no old_string/new_string and
    // fell back to the prior file content.
    const calls = [];
    const hooks = pluginMod.createDevproPluginHooks({
      directory: OUR_DIR,
      runHook: (args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    await hooks["tool.execute.before"](
      { tool: "edit", sessionID: SID("t10-v1"), callID: "c1" },
      { args: { filePath: "a.md", oldString: "alpha", newString: "beta", replaceAll: true } }
    );
    assert.equal(calls.length, 1);
    const payload = JSON.parse(calls[0].payload || "{}");
    assert.equal(payload.tool_name, "Edit");
    assert.equal(payload.tool_input.file_path, "a.md");
    assert.equal(payload.tool_input.old_string, "alpha");
    assert.equal(payload.tool_input.new_string, "beta");
    assert.equal(payload.tool_input.replace_all, true);
  });

  test("T10(vi) F-r1-04: capability drift vs call-mapping misses deny with distinct named reasons + recovery", async () => {
    const filePath = "openspec/changes/demo/meeting-notes.md";
    // (a) host capability unavailable: ctx.session.context throws.
    await withV2Harness({ decisions: { "*": PASS }, sessionContextFails: true }, async (h) => {
      const ev = t10HostEvent({ filePath, sourceId: "call_cap" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      const msg = String(ev.message || "");
      assert.match(msg, /OpenCode V2 host capability unavailable \(fail-closed/);
      assert.ok(msg.includes("capability=ctx.session.context"));
      assert.match(msg, /user-authorized/);
      assert.doesNotMatch(msg, /proposal fields unresolvable/);
      assert.equal(t10PreCalls(h).length, 0, "capability fail-closed deny MUST NOT invoke any pre-tool gate");
    });
    // (b) call-mapping miss: context works (array) but has no matching part.
    await withV2Harness({ decisions: { "*": PASS }, sessionContext: () => [] }, async (h) => {
      const ev = t10HostEvent({ filePath, sourceId: "call_nop" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      const msg = String(ev.message || "");
      assert.match(msg, /OpenCode V2 write\/edit proposal fields unresolvable \(fail-closed/);
      assert.doesNotMatch(msg, /host capability unavailable/);
      assert.ok(msg.includes("missing=part[call_nop]+explicit-fields"));
      assert.equal(t10PreCalls(h).length, 0, "call-mapping miss MUST NOT invoke any pre-tool gate");
    });
    // (c) shape drift: context returns a non-array payload.
    await withV2Harness({ decisions: { "*": PASS }, sessionContext: () => ({}) }, async (h) => {
      const ev = t10HostEvent({ filePath, sourceId: "call_shape" });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      const msg = String(ev.message || "");
      assert.match(msg, /OpenCode V2 host capability unavailable \(fail-closed/);
      assert.ok(msg.includes("capability=session.context.return-shape"));
      assert.equal(t10PreCalls(h).length, 0, "shape-drift fail-closed deny MUST NOT invoke any pre-tool gate");
    });
  });

  test("T10(vii) multi-resource write/edit: per-resource proposal binding impossible → named fail-closed deny + zero gate calls", async () => {
    // fix-cross-model-review-followups D3: one event carries ONE source.id /
    // live part / explicit field set, so a single proposal MUST NOT be applied
    // across resources. The frozen deny prefix is the contract; the event must
    // never reach proposal resolution (no ctx.session.context read) nor any
    // pre-tool gate.
    const sessionContext = () => [
      t10ToolPart({ id: "call_m10", name: "write", input: { path: "p1.md", content: T10_WRITE_BODY } }),
    ];
    await withV2Harness({ decisions: { "*": PASS }, sessionContext }, async (h) => {
      const ev = evaluateEvent({
        sessionID: SID("t10-multi"),
        action: "edit", // host shape: the write tool also sends action "edit"
        resources: ["p1.md", "p2.md"],
        metadata: { files: [t10FileDiff("p1.md"), t10FileDiff("p2.md")] },
        source: { type: "tool", messageID: "msg_t10", id: "call_m10" },
      });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      const msg = String(ev.message || "");
      assert.match(
        msg,
        /OpenCode V2 write\/edit multi-resource event cannot bind a per-resource proposal \(fail-closed\)/,
        "deny reason must carry the frozen multi-resource prefix"
      );
      assert.ok(msg.includes("resources=2"), `deny reason must name the resource count: ${msg}`);
      assert.match(msg, /user-authorized/, "deny reason must carry the recovery guidance");
      assert.equal(
        t10PreCalls(h).length,
        0,
        "multi-resource fail-closed deny MUST NOT invoke any pre-tool gate"
      );
      assert.equal(h.calls.context.length, 0, "deny must not attempt per-resource proposal resolution");
    });
  });

  test("S6(b) T10(vii) family: edit + 2 resources + live apply_patch part → frozen multi-resource deny (0 gates, 0 context)", async () => {
    // S6 provenance — PR #2767 cross-model PASS sticky 5749649216 Suggestion (2);
    // BRD §1 read-only probe evidence (E3); branch B conclusion (design D2):
    // a patch-family event arriving via write/edit action in multi-resource
    // shape is already covered by the action-scoped D3 deny — the named reason
    // carries the frozen prefix and the resource count before any gate call or
    // live-read. Recompute anchors: V2_MULTI_RESOURCE_DENY_PREFIX literal,
    // "resources=2", this test name.
    const sessionContext = () => [
      t10ToolPart({
        id: "call_s6_multi",
        name: "apply_patch",
        input: { patchText: "*** Begin Patch\n*** Update File: p1.md\n@@\n+hello\n*** End Patch" },
      }),
    ];
    await withV2Harness({ decisions: { "*": PASS }, sessionContext }, async (h) => {
      const ev = evaluateEvent({
        sessionID: SID("t10-s6-multi"),
        action: "edit", // host shape: the write tool also sends action "edit"
        resources: ["p1.md", "p2.md"],
        metadata: { files: [t10FileDiff("p1.md"), t10FileDiff("p2.md")] },
        source: { type: "tool", messageID: "msg_t10", id: "call_s6_multi" },
      });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "deny");
      const msg = String(ev.message || "");
      assert.match(
        msg,
        /OpenCode V2 write\/edit multi-resource event cannot bind a per-resource proposal \(fail-closed\)/,
        "deny reason must carry the frozen multi-resource prefix"
      );
      assert.ok(msg.includes("resources=2"), `deny reason must name the resource count: ${msg}`);
      assert.equal(t10PreCalls(h).length, 0, "multi-resource fail-closed deny MUST NOT invoke any pre-tool gate");
      assert.equal(h.calls.context.length, 0, "deny must not attempt per-resource proposal resolution");
    });
  });

  test("S6(c) F-r1-01 1:1 control: edit + single resource + live apply_patch part → allow with 1 PreToolUse carrying patchText", async () => {
    // S6 provenance — PR #2767 cross-model PASS sticky 5749649216 Suggestion (2);
    // BRD §1 read-only probe evidence (E4; design D2 E5 note / F-r1-01); branch B
    // conclusion: when a patch-family proposal arrives via edit for exactly one
    // resource, the 1:1 binding still resolves from the live part and the single
    // gate call carries the proposal. Recompute anchors: PreToolUse count = 1,
    // tool_name functions.apply_patch, tool_input.patchText, this test name.
    const patchText = "*** Begin Patch\n*** Update File: p1.md\n@@\n+hello\n*** End Patch";
    const sessionContext = () => [
      t10ToolPart({ id: "call_s6_single", name: "apply_patch", input: { patchText } }),
    ];
    await withV2Harness({ decisions: { "*": PASS }, sessionContext }, async (h) => {
      const ev = evaluateEvent({
        sessionID: SID("t10-s6-single"),
        action: "edit",
        resources: ["p1.md"],
        metadata: { files: [t10FileDiff("p1.md")] },
        source: { type: "tool", messageID: "msg_t10", id: "call_s6_single" },
      });
      await h.registrations.evaluate(ev);
      assert.equal(ev.effect, "allow");
      const pre = t10PreCalls(h);
      assert.equal(pre.length, 1, "single-resource binding must invoke exactly one PreToolUse gate");
      const payload = JSON.parse(pre[0].payload || "{}");
      assert.equal(payload.tool_name, "functions.apply_patch");
      assert.equal(
        payload.tool_input.patchText,
        patchText,
        "tool_input must carry the live-read patchText"
      );
      assert.equal(h.calls.context.length, 1, "proposal resolution must live-read the context exactly once");
    });
  });
});


test("GitHub MCP V2 execute.before refuses a failed gate and preserves exact structured arguments", async () => {
  await withV2Harness({decisions:{"PreToolUse::github-mcp-gate.mjs":{status:1,stdout:"",stderr:""}}}, async h => {
    assert.equal(typeof h.registrations.executeBefore,"function");
    await assert.rejects(h.registrations.executeBefore({tool:"devpro-work_github_create_issue",sessionID:"s1",
      input:{repository:"org/repo",body:"unfooted",title:"example"}}), /GitHub gate unavailable/);
  });
});
test("GitHub MCP V2 completed creation binds its marker when execute.after omits input",async()=>{
  const state=makeTempDir('opencode-v2-github-marker-');
  const repository='fixture/repo',head='feature/example',sha='a'.repeat(40);
  try {
    await withV2Harness({decisions:{'PostToolUse::github-mcp-gate.mjs':call=>{
      const run=spawnSync(process.execPath,[call.gate],{cwd:OUR_DIR,input:call.payload,encoding:'utf8',
        env:{...process.env,DEVPRO_HOOK_EVENT:'PostToolUse',DEVPRO_POST_PR_COMPLETION_STATE_DIR:state}});
      assert.equal(run.status,0,run.stderr);return {...run};
    }}},async h=>{
      await h.registrations.executeBefore({tool:'devpro-work_github_create_pr',sessionID:'s1',input:{repository,head,baseBranch:'main'}});
      await h.registrations.executeAfter({tool:'devpro-work_github_create_pr',sessionID:'s1',status:'completed',
        result:{status:'completed',data:{number:7,head:{ref:head,sha},base:{repo:{full_name:repository}},html_url:'https://github.com/fixture/repo/pull/7'}}});
      const [markerName]=postPrMarkerFilenames({repo:repository,prNumber:'7'});
      const marker=JSON.parse(readFileSync(path.join(state,markerName),'utf8'));
      assert.equal(marker.repository_slug,repository);assert.equal(marker.headRefName,head);assert.equal(marker.head_ref_oid,sha);
    });
  }finally{rmSync(state,{recursive:true,force:true});}
});
