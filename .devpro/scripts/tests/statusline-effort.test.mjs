/**
 * statusline-effort.test.mjs
 *
 * Smoke tests for .claude/statusline.cjs effort.level display.
 *
 * Contract:
 *   - JSON `effort.level` present  → line 1 shows `⚡<level>` next to model name
 *   - JSON `effort.level` absent   → no `⚡` marker (graceful fallback)
 *   - model.display_name is echoed verbatim (incl. any `(1M context)` suffix);
 *     statusline MUST NOT strip/rewrite the model name.
 *
 * Spawns the real script (spawnSync) with a stdin JSON payload to verify true output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATUSLINE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.claude/statusline.cjs"
);

// Run statusline.cjs with the given context object as stdin JSON; return stdout.
function run(ctx) {
  const r = spawnSync("node", [STATUSLINE], {
    input: JSON.stringify(ctx),
    encoding: "utf8",
    timeout: 5000,
  });
  return r.stdout || "";
}

test("effort.level present → line 1 shows ⚡<level>", () => {
  const out = run({
    model: { display_name: "Opus 4.8" },
    effort: { level: "max" },
    workspace: { current_dir: "/tmp/x" },
  });
  assert.match(out, /⚡max/, "stdout 應含 ⚡max（effort 標籤被移除時失敗）");
  assert.match(out, /Opus 4\.8/, "stdout 應含 model 名");
});

test("effort.level absent → no ⚡ marker (graceful fallback)", () => {
  const out = run({
    model: { display_name: "Opus 4.8" },
    workspace: { current_dir: "/tmp/x" },
  });
  assert.doesNotMatch(out, /⚡/, "effort 缺失時不應出現 ⚡ 標籤（fallback 應為空字串）");
});

test("effort.level reflects different value (high)", () => {
  const out = run({
    model: { display_name: "Sonnet 4.6" },
    effort: { level: "high" },
    workspace: { current_dir: "/tmp/x" },
  });
  assert.match(out, /⚡high/, "stdout 應含 ⚡high");
});

test("model.display_name echoed verbatim — incl. (1M context) suffix", () => {
  // Guards the explicit user decision to KEEP the (1M context) suffix:
  // statusline must not strip or rewrite the model display name.
  const out = run({
    model: { display_name: "Opus 4.8 (1M context)" },
    effort: { level: "max" },
    workspace: { current_dir: "/tmp/x" },
  });
  assert.match(out, /Opus 4\.8 \(1M context\)/, "model 名應原樣保留含 (1M context) 後綴");
  assert.match(out, /⚡max/, "effort 標籤仍應在 model 名之後顯示");
});
