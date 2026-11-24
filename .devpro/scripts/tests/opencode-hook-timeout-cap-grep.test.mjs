import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { LAUNCHER_TIMEOUT_MS } from "../hooks/lib/stop-run-supervisor.mjs";

const plugin = readFileSync(
  path.join(REPO_ROOT, ".opencode/plugins/devpro-hooks.js"),
  "utf8"
);

test("OpenCode plugin clamps DEVPRO_HOOK_TIMEOUT_MS to the 180s run-hook cap", () => {
  assert.match(plugin, /const MAX_HOOK_TIMEOUT_MS = 180_000/);
  assert.match(plugin, /function resolvePluginHookTimeoutMs/);
  assert.match(plugin, /Math\.min\(Math\.max\(1, Math\.floor\(parsed\)\), MAX_HOOK_TIMEOUT_MS\)/);
  assert.equal(
    (plugin.match(/Number\(process\.env\.DEVPRO_HOOK_TIMEOUT_MS\) \|\| 180_000/g) || []).length,
    0,
    "unclamped env timeout defaults must not remain"
  );
  assert.equal(
    (plugin.match(/resolvePluginHookTimeoutMs\(process\.env\)/g) || []).length,
    3,
    "sync, async, and takeover sites must share the clamped helper"
  );
});

test("the launcher, the OpenCode plugin and the Stop supervisor share one 180s ceiling and never floor a timeout to 0", () => {
  const runHook = readFileSync(path.join(REPO_ROOT, ".devpro/scripts/hooks/run-hook.mjs"), "utf8");
  const launcherCeiling = runHook.match(/^const MAX_HOOK_TIMEOUT_MS = (\d[\d_]*);$/m);
  assert.ok(launcherCeiling, "run-hook.mjs must declare `const MAX_HOOK_TIMEOUT_MS = <n>;`");
  const pluginCeiling = plugin.match(/^const MAX_HOOK_TIMEOUT_MS = (\d[\d_]*);$/m);
  assert.ok(pluginCeiling, "the OpenCode plugin must declare `const MAX_HOOK_TIMEOUT_MS = <n>;`");
  const launcherMs = Number(launcherCeiling[1].replaceAll("_", ""));
  assert.equal(Number(pluginCeiling[1].replaceAll("_", "")), launcherMs, "plugin ceiling must equal the launcher ceiling");
  assert.equal(
    LAUNCHER_TIMEOUT_MS,
    launcherMs,
    "stop-run-supervisor LAUNCHER_TIMEOUT_MS anchors the hard/coop deadlines; if it is above the launcher ceiling the launcher fails open first"
  );
  // spawnSync reads `timeout: 0` as "no timeout", so a sub-millisecond DEVPRO_HOOK_TIMEOUT_MS must not floor to 0.
  assert.match(runHook, /Math\.min\(Math\.max\(1, Math\.floor\(parsed\)\), MAX_HOOK_TIMEOUT_MS\)/);
});
