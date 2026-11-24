/**
 * cursor-tl-renderer-shell-grep.test.mjs
 *
 * Prove-it / wording lock for #2234:
 * Cursor TL renderer Shell for all-family model/effort probes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";

const adapterPath = ".devpro/agent-rules/platform-adapters/cursor.md";
const adapter = readFileSync(sourcePath(adapterPath), "utf8");

const POINTER_FILES = [
  ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md",
  // devpro:second-review loads the Cursor route from references/ (SKILL.md keeps a routing table)
  ".devpro/agent-skills/devpro-reviews/second-review/references/cursor-and-other-hosts.md",
  ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md",
  ".devpro/agent-skills/devpro-reviews/cross-review/references/cli-invocation.md",
];

const SHARED_POINTER = ".devpro/agent-rules/code-review-cross-model.md";

function extractRendererShell(md) {
  const block = md.match(
    /### TL renderer Shell（all families）[\s\S]*?(?=\n### )/,
  );
  assert.ok(block, `${adapterPath}: ### TL renderer Shell（all families） 不存在`);
  return block[0];
}

test("cursor.md has TL renderer Shell section with required tokens", () => {
  const section = extractRendererShell(adapter);
  assert.match(section, /render-second-review-packet/);
  assert.match(section, /block_until_ms/);
  assert.match(section, /sandbox-surface-fault/);
  assert.match(section, /effort selection blocked \(timeout\)/);
  assert.match(section, /MUST NOT[^\n]*預設 30s/);
  assert.match(section, /MUST NOT[^\n]*background/);
  assert.match(section, /request_smart_mode_approval/);
  assert.match(section, /host-surface proof|host-surface 證據|本次 host-surface/);
});

test("load-point pointers name TL renderer Shell without copying 120000", () => {
  for (const rel of POINTER_FILES) {
    const text = readFileSync(sourcePath(rel), "utf8");
    assert.match(text, /TL renderer Shell/, `${rel} missing TL renderer Shell`);
    assert.match(text, /cursor\.md/, `${rel} missing cursor.md pointer`);
    assert.doesNotMatch(text, /120000/, `${rel} MUST NOT copy timeout number 120000`);
  }
  const secondReviewSkill = ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md";
  assert.doesNotMatch(readFileSync(sourcePath(secondReviewSkill), "utf8"), /120000/, `${secondReviewSkill} MUST NOT copy timeout number 120000`);
});

test("shared cross-model rule points at host TL renderer Shell without brand tokens", () => {
  const text = readFileSync(sourcePath(SHARED_POINTER), "utf8");
  assert.match(text, /TL renderer Shell/);
  assert.match(text, /platform-adapters\/<host>\.md/);
  assert.doesNotMatch(text, /120000/);
  assert.doesNotMatch(text, /\bCursor\b/);
  assert.doesNotMatch(text, /cursor\.md/);
  assert.doesNotMatch(text, /\bClaude\b/);
  assert.doesNotMatch(text, /claude -p/);
  const DUP =
    /\*\*TL renderer Shell\*\*。\n   - \*\*Dispatch 與寫入責任\*\*：\n   - \*\*Dispatch 與寫入責任\*\*：/;
  const dupFixture =
    "跑 renderer 前 MUST 讀 active host adapter **TL renderer Shell**。\n   - **Dispatch 與寫入責任**：\n   - **Dispatch 與寫入責任**：\n";
  assert.match(dupFixture, DUP);
  assert.doesNotMatch(text, DUP);
});
