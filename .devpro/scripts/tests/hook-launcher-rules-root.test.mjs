/**
 * hook-launcher-rules-root.test.mjs
 *
 * Rules source resolution of the shipped inline hook launcher
 * (`.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`):
 *
 *   - `DEVPRO_RULES_ROOT` unset or empty → repo `.devpro` (walk-up, unchanged).
 *   - `DEVPRO_RULES_ROOT` set and valid  → run-hook AND the gate both come from
 *     `<root>/scripts/hooks/` (one root, never half repo / half rules root).
 *   - `DEVPRO_RULES_ROOT` set but without a runner → named error and no repo
 *     gate runs: the repo runner handles the override's missing gate path, so
 *     a GitHub write is still denied while anything else exits 1.
 *
 * Every case runs the command string exactly as the host would: taken from the
 * config by JSON.parse and executed through a shell, so quoting/escaping of the
 * shipped text is part of what is tested. Path handling of other platforms
 * (win32 drive paths, Git Bash `/c/...`) runs the same shipped body in a
 * sandbox with that platform's `path` flavour.
 */

import { mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync, cpSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const CONFIGS = [
  { relPath: ".claude/settings.json", event: "PreToolUse", host: "claude-code" },
  { relPath: ".codex/hooks.json", event: "PreToolUse", host: "codex" },
  { relPath: ".cursor/hooks.json", event: "preToolUse", host: "cursor" },
];
const SHIPPED_GATE = ".devpro/scripts/hooks/pre-tool-gate.mjs";
const PROBE_GATE = ".devpro/scripts/hooks/probe-gate.mjs";

function collectCommands(node, out = []) {
  if (!node || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === "command" && typeof value === "string") out.push(value);
    else collectCommands(value, out);
  }
  return out;
}

/** The shipped launcher command for one config, retargeted at the probe gate. */
function shippedProbeCommand({ relPath, event, host }) {
  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const suffix = ` ${event} ${SHIPPED_GATE} --host=${host}`;
  const command = collectCommands(config.hooks).find((c) => c.endsWith(suffix));
  assert.ok(command, `${relPath}: no launcher command ends with "${suffix}"`);
  return command.slice(0, -suffix.length) + ` ${event} ${PROBE_GATE} --host=${host}`;
}

/** Real runner + its libraries under <hooksDir>, plus a gate that records who ran. */
function installHooks(hooksDir, marker) {
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    path.join(hooksDir, "run-hook.mjs"),
    readFileSync(repoPath(".devpro/scripts/hooks/run-hook.mjs"), "utf8")
  );
  cpSync(repoPath(".devpro/scripts/hooks/lib"), path.join(hooksDir, "lib"), { recursive: true });
  cpSync(repoPath(".devpro/scripts/lib"), path.join(hooksDir, "../lib"), { recursive: true });
  writeFileSync(
    path.join(hooksDir, "probe-gate.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'import { fileURLToPath } from "node:url";',
      "writeFileSync(process.env.LAUNCHER_PROBE_OUT, JSON.stringify({",
      `  marker: ${JSON.stringify(marker)},`,
      "  cwd: process.cwd(),",
      "  self: fileURLToPath(import.meta.url),",
      "  runner: process.argv[1],",
      "}));",
      "process.exit(0);",
      "",
    ].join("\n")
  );
}

/**
 * <base>/repo/.devpro/scripts/hooks   repo copy   (marker "repo")
 * <base>/rules/scripts/hooks          rules root  (marker "rules")
 * Both carry a same-named probe gate, so the marker tells which copy ran.
 */
function buildFixture() {
  const base = realpathSync(makeTempDir("launcher-rules-root-"));
  const repo = path.join(base, "repo");
  const rules = path.join(base, "rules");
  installHooks(path.join(repo, ".devpro", "scripts", "hooks"), "repo");
  installHooks(path.join(rules, "scripts", "hooks"), "rules");
  mkdirSync(path.join(repo, "subdir", "deep"), { recursive: true });
  return { base, repo, rules, probeOut: path.join(base, "probe.json") };
}

const GITHUB_WRITE_INPUT = JSON.stringify({
  tool_name: "Bash",
  tool_input: { command: "git push origin feature/x" },
});

function runShipped(config, { cwd, rulesRoot, probeOut, input = "{}" }) {
  const env = { ...process.env, LAUNCHER_PROBE_OUT: probeOut };
  delete env.DEVPRO_RULES_ROOT;
  if (rulesRoot !== undefined) env.DEVPRO_RULES_ROOT = rulesRoot;
  const result = spawnSync(shippedProbeCommand(config), {
    shell: true,
    cwd,
    env,
    input,
    encoding: "utf8",
  });
  const probe = existsSync(probeOut) ? JSON.parse(readFileSync(probeOut, "utf8")) : null;
  return { result, probe };
}

for (const config of CONFIGS) {
  test(`${config.relPath}: DEVPRO_RULES_ROOT unset → runner and gate come from the repo .devpro`, () => {
    const fx = buildFixture();
    try {
      const { result, probe } = runShipped(config, { cwd: path.join(fx.repo, "subdir", "deep"), probeOut: fx.probeOut });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(probe?.marker, "repo");
      assert.equal(realpathSync(probe.cwd), fx.repo);
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  });

  test(`${config.relPath}: DEVPRO_RULES_ROOT empty string behaves as unset`, () => {
    const fx = buildFixture();
    try {
      const { result, probe } = runShipped(config, { cwd: fx.repo, rulesRoot: "", probeOut: fx.probeOut });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(probe?.marker, "repo");
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  });

  test(`${config.relPath}: DEVPRO_RULES_ROOT set → runner and gate both come from the rules root`, () => {
    const fx = buildFixture();
    try {
      const { result, probe } = runShipped(config, {
        cwd: path.join(fx.repo, "subdir", "deep"),
        rulesRoot: fx.rules,
        probeOut: fx.probeOut,
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      // Same-named gate exists in the repo too: the marker proves which copy ran.
      assert.equal(probe?.marker, "rules", "gate must come from the rules root, not the repo copy");
      assert.equal(probe.self, path.join(fx.rules, "scripts", "hooks", "probe-gate.mjs"));
      // The repo root stays the working directory so gates still see the repo.
      assert.equal(realpathSync(probe.cwd), fx.repo);
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  });

  test(`${config.relPath}: relative DEVPRO_RULES_ROOT resolves against the session cwd`, () => {
    const fx = buildFixture();
    try {
      const { result, probe } = runShipped(config, { cwd: fx.repo, rulesRoot: "../rules", probeOut: fx.probeOut });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(probe?.marker, "rules");
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  });

  test(`${config.relPath}: DEVPRO_RULES_ROOT set, repo has no .devpro → still runs from the rules root`, () => {
    const fx = buildFixture();
    try {
      const outside = path.join(fx.base, "no-devpro");
      mkdirSync(outside, { recursive: true });
      const { result, probe } = runShipped(config, { cwd: outside, rulesRoot: fx.rules, probeOut: fx.probeOut });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(probe?.marker, "rules");
      assert.equal(realpathSync(probe.cwd), outside);
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  });

  test(`${config.relPath}: DEVPRO_RULES_ROOT set but missing → named error, exit 1, no repo replacement`, () => {
    const fx = buildFixture();
    try {
      const missing = path.join(fx.base, "does-not-exist");
      const { result, probe } = runShipped(config, { cwd: fx.repo, rulesRoot: missing, probeOut: fx.probeOut });
      assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /DEVPRO_RULES_ROOT/);
      assert.ok(result.stderr.includes(missing), `stderr must name the resolved path: ${result.stderr}`);
      assert.equal(probe, null, "the repo gate must not run when the override is set but unusable");
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  });

  test(`${config.relPath}: DEVPRO_RULES_ROOT set but missing → a GitHub write is still denied`, () => {
    const fx = buildFixture();
    try {
      const missing = path.join(fx.base, "does-not-exist");
      const { result, probe } = runShipped(config, {
        cwd: fx.repo,
        rulesRoot: missing,
        probeOut: fx.probeOut,
        input: GITHUB_WRITE_INPUT,
      });
      assert.equal(result.status, 0, `the deny decision is only read on exit 0.\nstderr: ${result.stderr}`);
      const decision = JSON.parse(result.stdout);
      assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
      assert.match(decision.hookSpecificOutput.permissionDecisionReason, /GitHub write blocked: hook file missing/);
      assert.match(result.stderr, /DEVPRO_RULES_ROOT/, "the misconfiguration stays named");
      assert.equal(probe, null, "the repo gate must not run when the override is set but unusable");
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  });

  test(`${config.relPath}: rules root without run-hook but with the gate → that gate never runs, a GitHub write is still denied`, () => {
    const fx = buildFixture();
    try {
      // The root exists and carries a same-named gate; only its runner is gone.
      rmSync(path.join(fx.rules, "scripts", "hooks", "run-hook.mjs"));
      const plain = runShipped(config, { cwd: fx.repo, rulesRoot: fx.rules, probeOut: fx.probeOut });
      assert.equal(plain.result.status, 1, `stdout: ${plain.result.stdout}\nstderr: ${plain.result.stderr}`);
      assert.ok(plain.result.stderr.includes(fx.rules), `stderr must name the root: ${plain.result.stderr}`);
      assert.equal(plain.probe, null, "neither the rules-root gate nor the repo gate may run without the rules-root runner");

      const write = runShipped(config, { cwd: fx.repo, rulesRoot: fx.rules, probeOut: fx.probeOut, input: GITHUB_WRITE_INPUT });
      assert.equal(write.result.status, 0, `stderr: ${write.result.stderr}`);
      const decision = JSON.parse(write.result.stdout);
      assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
      assert.match(decision.hookSpecificOutput.permissionDecisionReason, /GitHub write blocked: hook file missing/);
      assert.equal(write.probe, null, "the rules-root gate must not run under the repo runner");
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  });

  test(`${config.relPath}: DEVPRO_RULES_ROOT set but missing and no repo root → named error, exit 1`, () => {
    const fx = buildFixture();
    try {
      const outside = path.join(fx.base, "no-devpro");
      mkdirSync(outside, { recursive: true });
      const missing = path.join(fx.base, "does-not-exist");
      const { result, probe } = runShipped(config, { cwd: outside, rulesRoot: missing, probeOut: fx.probeOut });
      assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /DEVPRO_RULES_ROOT has no scripts\/hooks\/run-hook\.mjs/);
      assert.doesNotMatch(result.stderr, /repo root not found/, "one named error, not two");
      assert.equal(probe, null);
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  });
}

// ── path resolution per platform (shipped body in a sandbox) ────────────────

const LAUNCHER_BODY = (() => {
  const settings = JSON.parse(readFileSync(path.join(REPO_ROOT, ".claude/settings.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const match = settings.hooks.PreToolUse[0].hooks[0].command.match(/^node -e "(.*)" \S+ \S+ --host=[a-z0-9-]+$/s);
  assert.ok(match, "inline launcher body not found in .claude/settings.json");
  return match[1];
})();

/**
 * Run the shipped launcher body against a stubbed host (platform, its `path`
 * flavour, session cwd, which files exist, DEVPRO_RULES_ROOT) and report what
 * it would spawn instead of spawning it.
 */
function resolveInSandbox({ platform, cwd, existing, rulesRoot }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const present = new Set(existing.map((f) => p.resolve(f)));
  const exitSignal = Symbol("exit");
  let current = cwd;
  let spawned = null;
  const stderr = [];
  const host = {
    platform,
    execPath: "node",
    argv: ["node", "PreToolUse", SHIPPED_GATE, "--host=claude-code"],
    env: rulesRoot === undefined ? {} : { DEVPRO_RULES_ROOT: rulesRoot },
    cwd: () => current,
    chdir: (dir) => { current = p.resolve(current, dir); },
    stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } },
    stdout: { write: () => true },
    exit: (code) => { throw { [exitSignal]: true, code }; },
  };
  const modules = {
    fs: { existsSync: (f) => present.has(p.resolve(current, f)) },
    path: p,
    child_process: {
      spawnSync: (_cmd, args, opts) => {
        spawned = { runner: args[0], gate: args[2], cwd: opts.cwd };
        return { status: 0, stdout: null };
      },
    },
  };
  let exitCode;
  try {
    vm.runInNewContext(LAUNCHER_BODY, { process: host, require: (name) => modules[name] });
  } catch (err) {
    if (!err || !err[exitSignal]) throw err;
    exitCode = err.code;
  }
  return { exitCode, spawned, stderr: stderr.join("") };
}

const WIN_REPO = "C:\\work\\repo";
const WIN_EXISTING = [
  "C:\\work\\repo\\.devpro\\scripts\\hooks\\run-hook.mjs",
  "C:\\rules\\scripts\\hooks\\run-hook.mjs",
  "C:\\work\\rules\\scripts\\hooks\\run-hook.mjs",
];

test("win32: drive, forward-slash, Git Bash and relative DEVPRO_RULES_ROOT all resolve to one rules root", () => {
  const cases = [
    { rulesRoot: "C:\\rules", root: "C:\\rules" },
    { rulesRoot: "C:/rules", root: "C:\\rules" },
    { rulesRoot: "/c/rules", root: "C:\\rules" },
    { rulesRoot: "../rules", root: "C:\\work\\rules" },
  ];
  for (const { rulesRoot, root } of cases) {
    const { exitCode, spawned, stderr } = resolveInSandbox({ platform: "win32", cwd: WIN_REPO, existing: WIN_EXISTING, rulesRoot });
    assert.equal(exitCode, 0, `${rulesRoot}: ${stderr}`);
    assert.equal(spawned.runner, path.win32.join(root, "scripts", "hooks", "run-hook.mjs"), rulesRoot);
    assert.equal(spawned.gate, path.win32.join(root, "scripts", "hooks", "pre-tool-gate.mjs"), rulesRoot);
    assert.equal(spawned.cwd, WIN_REPO, `${rulesRoot}: cwd stays the repo root`);
  }
});

test("win32: DEVPRO_RULES_ROOT unset keeps the repo runner and the repo-relative gate", () => {
  const { exitCode, spawned } = resolveInSandbox({ platform: "win32", cwd: WIN_REPO + "\\sub", existing: WIN_EXISTING });
  assert.equal(exitCode, 0);
  assert.equal(spawned.runner, path.win32.join(WIN_REPO, ".devpro", "scripts", "hooks", "run-hook.mjs"));
  assert.equal(spawned.gate, SHIPPED_GATE);
  assert.equal(spawned.cwd, WIN_REPO);
});

test("win32: a Git Bash path to a missing root is named in its drive form and no gate path exists", () => {
  const { exitCode, spawned, stderr } = resolveInSandbox({ platform: "win32", cwd: WIN_REPO, existing: WIN_EXISTING, rulesRoot: "/c/missing" });
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes("C:\\missing"), stderr);
  assert.equal(spawned.runner, path.win32.join(WIN_REPO, ".devpro", "scripts", "hooks", "run-hook.mjs"));
  assert.equal(spawned.gate, path.win32.join("C:\\missing", "scripts", "hooks", "run-hook.mjs", "pre-tool-gate.mjs"));
});

test("non-win32: a /c/... DEVPRO_RULES_ROOT is an ordinary absolute path", () => {
  const { exitCode, spawned } = resolveInSandbox({
    platform: "linux",
    cwd: "/work/repo",
    existing: ["/work/repo/.devpro/scripts/hooks/run-hook.mjs", "/c/rules/scripts/hooks/run-hook.mjs"],
    rulesRoot: "/c/rules",
  });
  assert.equal(exitCode, 0);
  assert.equal(spawned.runner, "/c/rules/scripts/hooks/run-hook.mjs");
  assert.equal(spawned.gate, "/c/rules/scripts/hooks/pre-tool-gate.mjs");
});
