/**
 * opencode-cli-smoke.test.mjs
 *
 * T6 / R7,R8,R17: offline smoke for OpenCode V2 CLI (`opencode2`) — plugin shape,
 * `debug config` listing `.opencode` directory sources, `debug agents` listing the
 * seven dp-* `mode: subagent` projections, and (via Node-imported bridge harness,
 * not a single CLI tool-dispatch conjunction) shared runner + idle reminder /
 * subsequent deny. Does not write global config or hit the network.
 *
 * Does NOT pin the operator's installed `opencode2` version. Live debug queries
 * exercise whatever CLI is on PATH; missing CLI → skip those cases (not red).
 *
 * Re-anchor notes (2026-09-12, measured on this machine):
 * - `opencode2 debug config|agents` are read-only queries that run in ~0.06s with
 *   a warm HOME. Under a FRESH isolated HOME the background service fails to
 *   start: `Error: Timed out waiting for the background service to start`
 *   (measured 124s) — so the debug queries run with the user HOME (read-only
 *   semantics; they write no config).
 * - Headless `opencode2 debug` invocations do NOT activate plugin effects — no
 *   `msg="loading plugin"` entries are produced by debug runs (verified against
 *   the live server log). Plugin setup/load proof therefore uses the D19
 *   fallback: the bridge harness asserts `setup(ctx)` is invoked and emits the
 *   `[devpro-hooks]` load marker; live V2-loader schema acceptance is TL session
 *   log evidence (worktree plugin `loading plugin` entry with no subsequent
 *   `failed to load plugin`). We do NOT claim live-loaded green headlessly.
 *
 * Phased agent catalog (2026-09-16 root-cause; integration flake):
 * After `opencode2 service` (re)start or a cold project attach, `debug agents`
 * returns exit 0 with a **partial** catalog in phases — measured:
 *   1) `[]`
 *   2) built-ins only (`build`/`plan`/… — no `dp-*`)
 *   3) full list including the seven `dp-*` projections
 * Under full-suite load the shared user-HOME daemon often lands smoke in phase
 * 1/2 (solo warm runs always hit phase 3). Treating a single successful JSON
 * parse as final evidence is therefore wrong. Smoke MUST poll until the seven
 * `dp-*` ids appear (bounded deadline), then assert mode/permissions. Empty /
 * built-in-only is "not ready", not a projection regression.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { repoPath } from "./lib/repo-root.mjs";

/** Harness-only mock app version — not a live CLI pin. */
const HARNESS_APP_VERSION = "opencode2 test-harness";
const PLUGIN = repoPath(".opencode/plugins/devpro-hooks.js");
const DEBUG_TIMEOUT_MS = 90_000;
/** Bound for phased catalog readiness (cold attach → seven dp-*). */
const AGENTS_READY_TIMEOUT_MS = 60_000;
const AGENTS_READY_POLL_MS = 200;
const SEVEN_DP_IDS = [
  "dp-analyst",
  "dp-architect",
  "dp-assistant",
  "dp-explorer",
  "dp-programmer",
  "dp-reviewer",
  "dp-second-reviewer",
];

function assertCliFinished(result, label) {
  if (result.error && (result.error.code === "ETIMEDOUT" || /TIMEDOUT/i.test(String(result.error)))) {
    assert.fail(
      `${label} timed out. Prerequisite: opencode2 on PATH must complete ` +
        `debug config|agents within ${DEBUG_TIMEOUT_MS}ms; do not claim smoke green when this fires.`
    );
  }
  if (result.status == null && result.signal) {
    assert.fail(`${label} aborted with signal ${result.signal}`);
  }
}

/**
 * Read-only debug queries run with the user HOME: the background service cannot
 * start under a fresh isolated HOME (measured 124s failure, see header note).
 */
function runOpencode2(args, opts = {}) {
  return spawnSync("opencode2", args, {
    encoding: "utf8",
    cwd: repoPath("."),
    timeout: opts.timeout ?? DEBUG_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", ...(opts.env || {}) },
  });
}

/** Live CLI presence only — never compare the version string. */
function probeOpencode2Available() {
  const result = spawnSync("opencode2", ["--version"], {
    encoding: "utf8",
    cwd: repoPath("."),
    timeout: 15_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error?.code === "ENOENT") {
    return { available: false, reason: "opencode2 not on PATH" };
  }
  if (result.status !== 0) {
    return {
      available: false,
      reason: `opencode2 --version exit ${result.status}: ${(result.stderr || result.stdout || "").trim()}`,
    };
  }
  return { available: true };
}

/**
 * One successful `debug agents` invocation → parsed array.
 * Keeps the truncated-JSON single retry (observed under parallel load).
 */
function readDebugAgentsOnce(label = "opencode2 debug agents", { timeoutMs = DEBUG_TIMEOUT_MS } = {}) {
  const run = () => runOpencode2(["debug", "agents"], { timeout: timeoutMs });
  let result = run();
  assertCliFinished(result, label);
  assert.equal(
    result.status,
    0,
    `${label} failed: ${result.stderr || result.stdout || ""}`
  );
  try {
    const parsed = JSON.parse(String(result.stdout).trim());
    assert.ok(Array.isArray(parsed), `${label} must return a JSON array`);
    return parsed;
  } catch (err) {
    result = run();
    assertCliFinished(result, `${label} (retry)`);
    assert.equal(
      result.status,
      0,
      `${label} (retry) failed: ${result.stderr || result.stdout || ""}`
    );
    try {
      const parsed = JSON.parse(String(result.stdout).trim());
      assert.ok(Array.isArray(parsed), `${label} (retry) must return a JSON array`);
      return parsed;
    } catch (retryErr) {
      assert.fail(
        `${label} output is not JSON (after retry): ${String(result.stdout || "").slice(0, 400)} (${retryErr.message})`
      );
    }
  }
}

/**
 * Poll until the shared daemon's agent catalog includes all seven dp-* ids.
 * Partial catalogs (`[]` / built-ins only) are readiness gaps, not failures.
 */
async function waitForDebugAgentsWithDpProjections({
  timeoutMs = AGENTS_READY_TIMEOUT_MS,
  pollMs = AGENTS_READY_POLL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const remainingMs = Math.max(1, deadline - Date.now());
    last = readDebugAgentsOnce(`opencode2 debug agents (ready#${attempts})`, {
      timeoutMs: Math.min(DEBUG_TIMEOUT_MS, remainingMs),
    });
    const expected = [...SEVEN_DP_IDS].sort();
    const dpIds = last
      .filter((a) => a && String(a.id).startsWith("dp-"))
      .map((a) => a.id)
      .sort();
    if (dpIds.length === expected.length && dpIds.every((id, i) => id === expected[i])) {
      return last;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  const lastIds = last.map((a) => a?.id).filter(Boolean);
  assert.fail(
    `debug agents never listed the seven dp-* projections within ${timeoutMs}ms ` +
      `(phased catalog readiness; attempts=${attempts}; last ids=[${lastIds.join(", ")}])`
  );
}

function mockRunner(table) {
  const calls = [];
  const runHook = (args) => {
    calls.push(args);
    const gateBase = path.basename(args.gate || "");
    const key = `${args.event}::${gateBase}`;
    const hit = table[key] || table["*"] || { status: 0, stdout: "", stderr: "" };
    return { status: hit.status ?? 0, stdout: hit.stdout || "", stderr: hit.stderr || "", error: null };
  };
  return { runHook, calls };
}

/** Event stream that never yields — no timers/handles. */
function neverEndingStream() {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => new Promise(() => {}),
  };
}

/** Minimal fake V2 ctx for the D19 fallback harness (setup-invoked proof). */
function makeFakeCtx() {
  const registrations = {
    evaluate: null,
    prompt: null,
    executeAfter: null,
    skillTransform: null,
  };
  const ctx = {
    app: { version: HARNESS_APP_VERSION },
    location: { directory: repoPath(".") },
    options: {},
    permission: {
      hook(name, fn) {
        if (name === "evaluate") registrations.evaluate = fn;
      },
    },
    session: {
      hook(name, fn) {
        if (name === "prompt") registrations.prompt = fn;
      },
      get: async ({ sessionID }) => ({
        location: { directory: repoPath(".") },
        projectID: "prj_test",
      }),
      synthetic: async () => {},
      prompt: async () => {},
    },
    tool: {
      hook(name, fn) {
        if (name === "execute.after") registrations.executeAfter = fn;
      },
    },
    skill: {
      transform: async (fn) => {
        registrations.skillTransform = fn;
      },
    },
    event: {
      subscribe: () => neverEndingStream(),
    },
  };
  return { ctx, registrations };
}

describe("OpenCode CLI offline smoke (T6 re-anchor opencode2)", () => {
  const liveCli = probeOpencode2Available();

  it("auto-discover plugin is .js (not .mjs-only), dependency-free, dual-export shape", () => {
    assert.equal(existsSync(PLUGIN), true, "missing .opencode/plugins/devpro-hooks.js");
    assert.equal(
      existsSync(repoPath(".opencode/plugins/devpro-hooks.mjs")),
      false,
      "must not ship .mjs as the sole/parallel auto-discover entry"
    );
    const src = readFileSync(PLUGIN, "utf8");
    const thirdParty = src.match(/from\s+['"](?![./]|node:)[^'"]+['"]/g) || [];
    assert.deepEqual(thirdParty, [], `plugin must not import third-party packages: ${thirdParty}`);
    assert.match(src, /run-hook\.mjs/);
    // D15 dual export shape (V2 loader schema acceptance is TL session log evidence)
    assert.match(src, /export default \{/);
    assert.match(src, /async setup\(/);
    assert.match(src, /async server\(/);
  });

  it("opencode2 debug config lists .opencode directory sources", (t) => {
    if (!liveCli.available) {
      t.skip(liveCli.reason);
      return;
    }
    const result = runOpencode2(["debug", "config"]);
    assertCliFinished(result, "opencode2 debug config");
    assert.equal(
      result.status,
      0,
      `opencode2 debug config failed: ${result.stderr || result.stdout || ""}`
    );
    let parsed;
    try {
      parsed = JSON.parse(String(result.stdout).trim());
    } catch (err) {
      assert.fail(
        `debug config output is not JSON: ${String(result.stdout || "").slice(0, 400)} (${err.message})`
      );
    }
    assert.ok(Array.isArray(parsed), "debug config must return a sources array");
    const dirs = parsed.filter(
      (e) => e && e.type === "directory" && typeof e.path === "string"
    );
    assert.ok(dirs.length > 0, "debug config must list directory sources");
    assert.ok(
      dirs.some(
        (e) =>
          e.path.endsWith(".opencode") &&
          (e.path.startsWith(repoPath(".")) || e.path === repoPath(".opencode"))
      ),
      `debug config must list a repo .opencode directory source; got: ${dirs
        .map((e) => e.path)
        .join(", ")}`
    );
  });

  it("opencode2 debug agents lists the seven dp-* mode:subagent projections", async (t) => {
    if (!liveCli.available) {
      t.skip(liveCli.reason);
      return;
    }
    // MUST wait for phased catalog readiness (see file header). A single exit-0
    // JSON parse can still be `[]` or built-ins-only after service (re)start /
    // cold attach under full-suite load.
    const parsed = await waitForDebugAgentsWithDpProjections();
    const dpAgents = parsed.filter((a) => a && String(a.id).startsWith("dp-"));
    assert.deepEqual(
      dpAgents.map((a) => a.id).sort(),
      [...SEVEN_DP_IDS].sort(),
      "debug agents must list exactly the seven dp-* projections"
    );
    for (const agent of dpAgents) {
      assert.equal(agent.mode, "subagent", `${agent.id} must be mode: subagent`);
    }
    // Role boundary continuity (live; D27 dual-key): dp-explorer keeps edit AND
    // shell deny in its resolved permissions (legacy permission: translation
    // plus the canonical permissions: array — append semantics, all-deny).
    const explorer = dpAgents.find((a) => a.id === "dp-explorer");
    const explorerDeny = (explorer?.permissions || []).filter(
      (p) => p.effect === "deny"
    );
    assert.ok(
      explorerDeny.some((p) => p.action === "edit"),
      "dp-explorer resolved permissions must keep edit: deny"
    );
    assert.ok(
      explorerDeny.some((p) => p.action === "shell"),
      "dp-explorer resolved permissions must keep shell: deny (load-bearing; D27)"
    );
  });

  it("dp-* agent frontmatter is dual-key: canonical permissions: array + legacy permission: block (D27)", () => {
    // Dual-key compatibility (D27): the three deny-surface roles carry the V2
    // canonical `permissions:` array (edit deny [+ shell deny for explorer])
    // alongside the V1 `permission:` block (1.18.x consumer face keeps reading
    // it). The four write roles have no deny surface and stay untouched.
    const denyRoles = [
      { file: "dp-explorer.md", expectShellDeny: true },
      { file: "dp-reviewer.md", expectShellDeny: false },
      { file: "dp-second-reviewer.md", expectShellDeny: false },
    ];
    for (const { file, expectShellDeny } of denyRoles) {
      const src = readFileSync(repoPath(`.opencode/agent/${file}`), "utf8");
      assert.match(src, /permissions:/, `${file} must carry canonical permissions:`);
      assert.match(src, /permission:/, `${file} must keep the legacy permission: block`);
      assert.match(
        src,
        /action:\s*edit\s*\n\s*resource:\s*"\*"\s*\n\s*effect:\s*deny/,
        `${file} permissions: must deny edit`
      );
      if (expectShellDeny) {
        assert.match(
          src,
          /action:\s*shell\s*\n\s*resource:\s*"\*"\s*\n\s*effect:\s*deny/,
          `${file} permissions: must deny shell`
        );
      } else {
        assert.doesNotMatch(
          src,
          /action:\s*shell/,
          `${file} must not add a shell deny (its role allows Bash)`
        );
      }
    }
    for (const file of [
      "dp-analyst.md",
      "dp-architect.md",
      "dp-assistant.md",
      "dp-programmer.md",
    ]) {
      const src = readFileSync(repoPath(`.opencode/agent/${file}`), "utf8");
      assert.doesNotMatch(
        src,
        /permissions:/,
        `${file} must stay untouched (no deny surface)`
      );
    }
  });

  it("plugin setup is invoked with the V2 ctx and emits the [devpro-hooks] load marker (D19 fallback: headless debug does not activate plugin effects)", async () => {
    // Headless `opencode2 debug` does NOT trigger plugin load/activation
    // (verified 2026-09-12: no `loading plugin` log entries from debug runs;
    // fresh isolated HOME cannot start the background service, measured 124s).
    // D19 fallback: bridge harness proves setup(ctx) is invoked and the load
    // marker is emitted; live V2-loader schema acceptance is TL session log
    // evidence. We do not claim headless live-loaded green.
    const mod = await import(`${pathToFileURL(PLUGIN).href}?smoke-v2=${Date.now()}`);
    const { ctx, registrations } = makeFakeCtx();
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(" "));
    };
    let dispose;
    try {
      dispose = await mod.default.setup(ctx);
      assert.ok(
        logs.some((l) => l.startsWith("[devpro-hooks] v2 setup loaded")),
        `setup must emit the [devpro-hooks] load marker first; got: ${logs.join(" | ")}`
      );
      assert.equal(
        typeof registrations.evaluate,
        "function",
        "setup must register permission.evaluate"
      );
      assert.equal(
        typeof registrations.prompt,
        "function",
        "setup must register session.hook('prompt')"
      );
      assert.equal(
        typeof registrations.executeAfter,
        "function",
        "setup must register tool.hook('execute.after')"
      );
      assert.equal(
        typeof registrations.skillTransform,
        "function",
        "setup must register skill.transform"
      );
    } finally {
      console.log = originalLog;
      if (dispose) await dispose();
    }
  });

  it("V1 face (server()): plugin module maps tool.execute.before through shared runner (Node import harness)", async () => {
    const mod = await import(`${pathToFileURL(PLUGIN).href}?smoke-v1=${Date.now()}`);
    const { runHook, calls } = mockRunner({
      "*": { status: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" },
    });
    const serverHooks = await mod.default.server();
    assert.equal(typeof serverHooks["tool.execute.before"], "function");
    const hooks = await mod.createDevproPluginHooks({
      directory: repoPath("."),
      runHook,
    });
    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "smoke-session", callID: "c1" },
      { args: { command: "true" } }
    );
    assert.ok(
      calls.some((c) => c.host === "opencode" && c.event === "PreToolUse"),
      "Node-imported bridge harness must observe shared runner PreToolUse --host=opencode (separate from CLI config listing)"
    );
  });

  it("V2 face: permission.evaluate deny surface (bridge harness)", async () => {
    const mod = await import(`${pathToFileURL(PLUGIN).href}?smoke-eval=${Date.now()}`);
    const { ctx, registrations } = makeFakeCtx();
    ctx.options.runHook = async ({ event }) => {
      if (event === "Stop") return { status: 0, stdout: "", stderr: "" };
      return {
        status: 0,
        stdout: JSON.stringify({ decision: "block", reason: "smoke-eval-block" }),
        stderr: "",
      };
    };
    const dispose = await mod.default.setup(ctx);
    try {
      const ev = {
        sessionID: "smoke-eval",
        agent: "build",
        action: "shell",
        resources: ["echo hi"],
        metadata: {},
        source: "tool",
        effect: "allow",
      };
      await registrations.evaluate(ev);
      assert.equal(ev.effect, "deny", "V2 evaluate must deny on decision:block");
      assert.match(String(ev.message || ""), /smoke-eval-block/);
    } finally {
      await dispose();
    }
  });

  it("idle reminder is observable and must-block denies subsequent tool (V1 face)", async () => {
    const mod = await import(`${pathToFileURL(PLUGIN).href}?smoke-idle=${Date.now()}`);
    const reminderSink = [];
    const sessionState = new Map();
    const toastCalls = [];
    const { runHook, calls } = mockRunner({
      "Stop::recap-check.mjs": {
        status: 0,
        stdout: JSON.stringify({
          decision: "block",
          reason: "must-block-after-idle",
          systemMessage: "Session Recap reminder: resolve stop-point",
        }),
      },
      "*": { status: 0, stdout: "", stderr: "" },
    });
    const hooks = await mod.createDevproPluginHooks({
      directory: repoPath("."),
      runHook,
      reminderSink,
      sessionState,
      client: {
        tui: {
          showToast: async (opts) => {
            toastCalls.push(opts);
            return { data: true };
          },
        },
      },
    });

    await assert.doesNotReject(() =>
      hooks.event({
        event: { type: "session.idle", properties: { sessionID: "smoke-idle" } },
      })
    );
    assert.ok(
      calls.some(
        (c) =>
          c.host === "opencode" &&
          c.event === "Stop" &&
          path.basename(c.gate) === "recap-check.mjs"
      ),
      "idle must call Stop/recap-check"
    );
    assert.ok(
      toastCalls.length >= 1 ||
        reminderSink.length >= 1 ||
        sessionState.get("smoke-idle")?.reminder,
      "reminder must be host-observable after idle"
    );
    assert.ok(sessionState.get("smoke-idle")?.blocking, "must-block sets session blocking");

    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "smoke-idle", callID: "c-deny" },
          { args: { command: "echo after-idle" } }
        ),
      /must-block|block|deny|fail.closed|session blocked/i
    );
    const permOut = { status: "ask" };
    await hooks["permission.ask"](
      {
        id: "p1",
        type: "bash",
        sessionID: "smoke-idle",
        title: "bash",
        metadata: {},
        time: { created: Date.now() },
      },
      permOut
    );
    assert.equal(permOut.status, "deny");
  });

  it("skills discoverable from .agents/skills; no OPENCODE.md / .opencode/skills", () => {
    assert.equal(existsSync(repoPath(".agents/skills")), true);
    assert.equal(existsSync(repoPath("OPENCODE.md")), false);
    assert.equal(existsSync(repoPath(".opencode/skills")), false);
    // Skill discovery in V2 goes through ctx.skill.transform (D18) — asserted
    // in opencode-skill-discovery.test.mjs (T5), not via a CLI skill dump
    // (V2-Q7: `opencode2 debug` has no skill subcommand).
  });

  it("Desktop remains unsupported/unverified in adapter + doctor surfaces", () => {
    const adapter = readFileSync(
      repoPath(".devpro/agent-rules/platform-adapters/opencode.md"),
      "utf8"
    );
    assert.match(adapter, /unsupported/);
    assert.match(adapter, /unverified/);
    const doctor = spawnSync(
      process.execPath,
      [repoPath(".devpro/scripts/devpro-doctor.mjs")],
      { encoding: "utf8", cwd: repoPath("."), timeout: 60_000 }
    );
    const report = `${doctor.stdout || ""}\n${doctor.stderr || ""}`;
    assert.match(report, /unsupported/);
    assert.match(report, /unverified|OpenCode Desktop/i);
    assert.match(report, /OpenCode CLI carriers/);
  });
});
