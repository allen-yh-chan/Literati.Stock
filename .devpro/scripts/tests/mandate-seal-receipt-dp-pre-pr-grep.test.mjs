/**
 * Locks #2389: devpro:pre-pr Step 3 must mandate seal-receipt after raw JSON persistence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const DISPATCH =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";

function step3Slice(content, heading, label) {
  const start = content.indexOf(heading);
  assert.ok(start >= 0, `${label} missing ${heading}`);
  const rest = content.slice(start + heading.length);
  const next = rest.search(/\n### |\n## /);
  return next === -1 ? content.slice(start) : content.slice(start, start + heading.length + next);
}

test("devpro:pre-pr Step 3 mandates the builder-backed seal chain after raw JSON persistence", () => {
  const slice = step3Slice(
    readFileSync(repoPath(SKILL), "utf8"),
    "### 第三步：Six-Axis Review",
    "skill Step 3",
  );
  assert.match(
    slice,
    /capture-reviewer-output` → `build-receipt-request` → `seal-receipt` → `verify-receipt`/,
  );
  assert.match(slice, /`build-receipt-request` 的 stdout 就是下一步接受的 `<seal-request\.json>`/);
  assert.match(
    slice,
    /walkReceiptAuthorityChain|mutable[^\n]*\.md[^\n]*(?:alone|無法)/,
    "must state mutable .md alone cannot satisfy receipt authority chain",
  );
  assert.match(slice, /notes\/review-<change>-receipt-r<N>-<dispatch_id>\.json/);
});

test("subagent-dispatch-blocks Step 3 mandates seal-receipt CLI", () => {
  const slice = step3Slice(
    readFileSync(repoPath(DISPATCH), "utf8"),
    "## Step 3: dp-reviewer dispatch (Six-Axis Review)",
    "dispatch Step 3",
  );
  assert.match(slice, /review-remediation-evidence\.mjs seal-receipt/);
  assert.match(slice, /walkReceiptAuthorityChain/);
});
