/**
 * opencode-rules-root.test.mjs
 *
 * Rules source resolution of `.opencode/plugins/devpro-hooks.js` — the same
 * order as the inline hook launcher (hook-launcher-rules-root.test.mjs):
 *
 *   - `DEVPRO_RULES_ROOT` unset or empty → repo `.devpro` (unchanged).
 *   - set and usable → run-hook, the gates directory and `github-mcp-tools` all
 *     come from `<root>/scripts/hooks/` (one root, never mixed).
 *   - set but unusable (no runner, or its `github-mcp-tools` cannot be loaded)
 *     → the plugin still loads, no spawn runs anything from either copy, and a
 *     GitHub write stays denied.
 *
 * The plugin resolves its source once at module load, so the override cases
 * import it in a child process with the environment under test.
 */

import { mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const PLUGIN_JS = repoPath(".opencode/plugins/devpro-hooks.js");
const PLUGIN_URL = pathToFileURL(PLUGIN_JS).href;
const REPO_HOOKS_DIR = path.join(REPO_ROOT, ".devpro", "scripts", "hooks");
const GITHUB_WRITE_TOOL = "mcp__devpro-work__github_push";
// Host-absolute fixture paths: on Windows path.resolve adds the drive letter,
// so bare POSIX-rooted literals would never equal what the resolver returns.
const abs = (p) => path.resolve(p);

/** A rules root whose runner and GitHub tool table are recognisably not the repo's. */
function buildRulesRoot(base) {
  const root = path.join(base, "rules");
  const hooksDir = path.join(root, "scripts", "hooks");
  mkdirSync(path.join(hooksDir, "lib"), { recursive: true });
  writeFileSync(
    path.join(hooksDir, "run-hook.mjs"),
    'process.stdout.write(JSON.stringify({ fixtureRunner: true, argv: process.argv.slice(2) }));\n'
  );
  writeFileSync(
    path.join(hooksDir, "lib", "github-mcp-tools.mjs"),
    [
      'export function devproGithubToolName(name) { return name === "fixture_tool" ? "github_fixture" : null; }',
      "export function isGithubWritePayload() { return false; }",
      "",
    ].join("\n")
  );
  return { root, hooksDir };
}

/** Import the plugin in a child process under `rulesRoot` and report what it resolved. */
function probePlugin({ rulesRoot, cwd = REPO_ROOT }) {
  const env = { ...process.env };
  delete env.DEVPRO_RULES_ROOT;
  if (rulesRoot !== undefined) env.DEVPRO_RULES_ROOT = rulesRoot;
  const driver = `
    const m = await import(${JSON.stringify(PLUGIN_URL)});
    const bash = m.mapOpenCodeToolToProtocol("bash");
    const gate = bash.gates[0].gate;
    const call = { event: "PreToolUse", gate, host: "opencode", payload: "{}", cwd: process.cwd(), env: {} };
    const sync = m.defaultRunHook(call);
    const async_ = await m.defaultRunHookAsync(call);
    let githubWrite = "allowed";
    try {
      const hooks = m.createDevproPluginHooks({ directory: process.cwd() });
      await hooks["tool.execute.before"]({ tool: ${JSON.stringify(GITHUB_WRITE_TOOL)}, sessionID: "rules-root-test" }, { args: { repository: "o/r", branch: "b" } });
    } catch (err) {
      githubWrite = String(err && err.message);
    }
    process.stdout.write(JSON.stringify({
      rules: m.resolveRulesSource(),
      bashGates: bash.gates.map((g) => g.gate),
      fixtureTool: m.mapOpenCodeToolToProtocol("fixture_tool").classified,
      githubTool: m.mapOpenCodeToolToProtocol(${JSON.stringify(GITHUB_WRITE_TOOL)}),
      sync: { status: sync.status, stdout: sync.stdout, stderr: sync.stderr },
      async: { status: async_.status, stdout: async_.stdout, stderr: async_.stderr },
      githubWrite,
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `plugin probe must not crash.\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// ── resolveRulesSource: pure resolution ─────────────────────────────────────

test("resolveRulesSource: unset and empty DEVPRO_RULES_ROOT resolve to the repo .devpro", async () => {
  const { resolveRulesSource } = await import(PLUGIN_URL);
  for (const env of [{}, { DEVPRO_RULES_ROOT: "" }]) {
    const rules = resolveRulesSource(env, { repoRoot: abs("/r/repo"), cwd: abs("/elsewhere"), exists: () => true, realpath: (p) => p });
    assert.equal(rules.source, "repo");
    assert.equal(rules.hooksDir, path.join(abs("/r/repo"), ".devpro", "scripts", "hooks"));
    assert.equal(rules.runHook, path.join(rules.hooksDir, "run-hook.mjs"));
  }
});

test("resolveRulesSource: a set DEVPRO_RULES_ROOT puts runner and gates under that one root", async () => {
  const { resolveRulesSource } = await import(PLUGIN_URL);
  const rules = resolveRulesSource({ DEVPRO_RULES_ROOT: abs("/opt/rules/current") }, { repoRoot: abs("/r/repo"), cwd: abs("/elsewhere"), exists: () => true, realpath: (p) => p });
  assert.equal(rules.source, "env");
  assert.equal(rules.usable, true);
  assert.equal(rules.hooksDir, path.join(abs("/opt/rules/current"), "scripts", "hooks"));
  assert.equal(rules.runHook, path.join(rules.hooksDir, "run-hook.mjs"));
});

test("resolveRulesSource: a relative DEVPRO_RULES_ROOT resolves against the cwd", async () => {
  const { resolveRulesSource } = await import(PLUGIN_URL);
  const rules = resolveRulesSource({ DEVPRO_RULES_ROOT: "../rules" }, { repoRoot: abs("/r/repo"), cwd: abs("/work/repo"), exists: () => true, realpath: (p) => p });
  assert.equal(rules.hooksDir, path.join(abs("/work/rules"), "scripts", "hooks"));
});

test("resolveRulesSource: a set but missing root stays on that root and is marked unusable", async () => {
  const { resolveRulesSource } = await import(PLUGIN_URL);
  const rules = resolveRulesSource({ DEVPRO_RULES_ROOT: abs("/missing") }, {
    repoRoot: abs("/r/repo"),
    cwd: abs("/elsewhere"),
    exists: () => false,
    realpath: () => { throw new Error("ENOENT"); },
  });
  assert.equal(rules.source, "env");
  assert.equal(rules.usable, false);
  assert.equal(rules.runHook, path.join(abs("/missing"), "scripts", "hooks", "run-hook.mjs"), "must not point at the repo copy");
});

test("resolveRulesSource on win32: drive, forward-slash, Git Bash and relative values resolve alike", async () => {
  const { resolveRulesSource } = await import(PLUGIN_URL);
  const deps = { platform: "win32", path: path.win32, repoRoot: "C:\\repo", cwd: "C:\\work\\repo", exists: () => true, realpath: (p) => p };
  const cases = [
    ["C:\\rules", "C:\\rules"],
    ["C:/rules", "C:\\rules"],
    ["/c/rules", "C:\\rules"],
    ["../rules", "C:\\work\\rules"],
  ];
  for (const [value, root] of cases) {
    const rules = resolveRulesSource({ DEVPRO_RULES_ROOT: value }, deps);
    assert.equal(rules.source, "env", value);
    assert.equal(rules.root, root, value);
    assert.equal(rules.runHook, path.win32.join(root, "scripts", "hooks", "run-hook.mjs"), value);
  }
});

test("resolveRulesSource off win32: a /c/... value is an ordinary absolute path", async () => {
  const { resolveRulesSource, normalizeRulesRootValue } = await import(PLUGIN_URL);
  const rules = resolveRulesSource({ DEVPRO_RULES_ROOT: "/c/rules" }, { platform: "linux", path: path.posix, repoRoot: "/r/repo", cwd: "/work", exists: () => true, realpath: (p) => p });
  assert.equal(rules.root, "/c/rules");
  assert.equal(normalizeRulesRootValue("/c/rules", "darwin"), "/c/rules");
  assert.equal(normalizeRulesRootValue("/c/rules", "win32"), "C:/rules");
  assert.equal(normalizeRulesRootValue("/cc/rules", "win32"), "/cc/rules", "only a single drive letter is a Git Bash drive");
});

// ── module-load behaviour (child process) ───────────────────────────────────

test("plugin without DEVPRO_RULES_ROOT keeps using the repo .devpro", () => {
  const probe = probePlugin({});
  assert.equal(probe.rules.source, "repo");
  assert.deepEqual(probe.bashGates.map((g) => path.dirname(g)), [REPO_HOOKS_DIR, REPO_HOOKS_DIR]);
  assert.equal(probe.githubTool.classified, "supported");
  assert.equal(probe.fixtureTool, "unsupported");
});

test("plugin with DEVPRO_RULES_ROOT takes runner, gates and github-mcp-tools from that root", () => {
  const base = realpathSync(makeTempDir("opencode-rules-root-"));
  try {
    const fx = buildRulesRoot(base);
    const probe = probePlugin({ rulesRoot: fx.root });
    assert.equal(probe.rules.source, "env");
    assert.equal(probe.rules.usable, true);
    for (const gate of probe.bashGates) assert.equal(path.dirname(gate), fx.hooksDir);
    // github-mcp-tools comes from the rules root: its table knows the fixture
    // tool and does not know the repo's GitHub tool names.
    assert.equal(probe.fixtureTool, "supported");
    assert.equal(probe.githubTool.classified, "unsupported");
    // Both spawn paths run the rules-root runner with a rules-root gate.
    for (const run of [probe.sync, probe.async]) {
      assert.equal(run.status, 0, run.stderr);
      const out = JSON.parse(run.stdout);
      assert.equal(out.fixtureRunner, true);
      assert.equal(path.dirname(out.argv[1]), fx.hooksDir);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("plugin pins a symlinked DEVPRO_RULES_ROOT to its target at load", () => {
  const base = realpathSync(makeTempDir("opencode-rules-root-link-"));
  try {
    const fx = buildRulesRoot(base);
    const link = path.join(base, "current");
    symlinkSync(fx.root, link, "dir");
    const probe = probePlugin({ rulesRoot: link });
    assert.equal(probe.rules.root, fx.root);
    for (const gate of probe.bashGates) assert.equal(path.dirname(gate), fx.hooksDir);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("plugin with an unusable DEVPRO_RULES_ROOT still loads, never runs the repo runner, and denies a GitHub write", () => {
  const base = realpathSync(makeTempDir("opencode-rules-root-missing-"));
  try {
    const missing = path.join(base, "does-not-exist");
    const probe = probePlugin({ rulesRoot: missing });
    assert.equal(probe.rules.source, "env");
    assert.equal(probe.rules.usable, false);
    const missingHooks = path.join(missing, "scripts", "hooks");
    for (const gate of probe.bashGates) assert.equal(path.dirname(gate), missingHooks);
    for (const run of [probe.sync, probe.async]) {
      assert.notEqual(run.status, 0, "an unusable override must surface as a runner failure");
      assert.equal(run.stdout, "", "the repo runner must not run in place of the override");
      assert.match(run.stderr, /DEVPRO_RULES_ROOT has no scripts\/hooks\/run-hook\.mjs/);
    }
    // GitHub tools are still recognised, so their writes stay denied.
    assert.equal(probe.githubTool.classified, "supported");
    assert.equal(path.dirname(probe.githubTool.gates[0].gate), missingHooks);
    assert.match(probe.githubWrite, /GitHub gate unavailable/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("plugin with a rules root that has github-mcp-tools but no runner imports nothing from that root", () => {
  const base = realpathSync(makeTempDir("opencode-rules-root-norunner-"));
  try {
    const fx = buildRulesRoot(base);
    rmSync(path.join(fx.hooksDir, "run-hook.mjs"));
    const probe = probePlugin({ rulesRoot: fx.root });
    assert.equal(probe.rules.source, "env");
    assert.equal(probe.rules.usable, false);
    // The root's own tool table was not loaded: its fixture tool is unknown and
    // the repo copy keeps GitHub tools recognised, so the write stays denied.
    assert.equal(probe.fixtureTool, "unsupported");
    assert.equal(probe.githubTool.classified, "supported");
    assert.match(probe.githubWrite, /GitHub gate unavailable/);
    for (const run of [probe.sync, probe.async]) {
      assert.notEqual(run.status, 0);
      assert.equal(run.stdout, "");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

for (const [label, breakTable] of [
  ["missing", (hooksDir) => rmSync(path.join(hooksDir, "lib", "github-mcp-tools.mjs"))],
  ["throwing", (hooksDir) => writeFileSync(path.join(hooksDir, "lib", "github-mcp-tools.mjs"), 'throw new Error("broken table");\n')],
  ["export-less", (hooksDir) => writeFileSync(path.join(hooksDir, "lib", "github-mcp-tools.mjs"), "export const unrelated = 1;\n")],
]) {
  test(`plugin with a rules-root runner but a ${label} github-mcp-tools treats the whole root as unusable`, () => {
    const base = realpathSync(makeTempDir("opencode-rules-root-table-"));
    try {
      const fx = buildRulesRoot(base);
      breakTable(fx.hooksDir);
      const probe = probePlugin({ rulesRoot: fx.root });
      // Runner and gates would still point at the root; none of it may run.
      for (const gate of probe.bashGates) assert.equal(path.dirname(gate), fx.hooksDir);
      for (const run of [probe.sync, probe.async]) {
        assert.notEqual(run.status, 0);
        assert.equal(run.stdout, "", "the rules-root runner must not run with a table from another copy");
        assert.match(run.stderr, /DEVPRO_RULES_ROOT github-mcp-tools/);
      }
      assert.equal(probe.fixtureTool, "unsupported");
      assert.equal(probe.githubTool.classified, "supported");
      assert.match(probe.githubWrite, /GitHub gate unavailable/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
