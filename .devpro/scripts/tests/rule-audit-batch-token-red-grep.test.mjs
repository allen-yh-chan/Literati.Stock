/**
 * rule-audit-batch-token-red-grep.test.mjs
 *
 * Locks batch/token red-stop anchors in `rule-audit-playbook.md`.
 *
 * REQUIRED locks: batch approval + no fallback to per-item confirmation +
 * token precheck + cap/tier override + last-resort framing + stop conditions.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
const rulePath = repoPath(".devpro/agent-rules/rule-audit-playbook.md");
const ruleBody = readFileSync(rulePath, "utf8");

const REQUIRED_ANCHORS = [
  "batch approval",
  "不得退回逐步確認",
  "token-budget-precheck.md",
  "cap/tier override",
  "last resort",
  "Token-budget MUST-scan",
  "accepted-finding-only",
  "hard-trim-for-cap",
  "advisory-signal only",
];

const STOP_CONDITION_ANCHORS = [
  "high-risk normative",
  "out-of-scope",
  "merge",
  "release",
  "destructive",
  "cross-repo",
];

const batchIdx = ruleBody.indexOf("batch approval");
const exitIdx = ruleBody.indexOf("## Exit Criteria");
const batchGuidanceBody =
  batchIdx !== -1 && exitIdx !== -1 && batchIdx < exitIdx
    ? ruleBody.slice(batchIdx, exitIdx)
    : "";

for (const phrase of REQUIRED_ANCHORS) {
  test(`rule-audit-playbook.md contains batch/token red-stop anchor: ${phrase}`, () => {
    assert.ok(
      ruleBody.includes(phrase),
      `expected rule-audit-playbook.md to contain "${phrase}" (batch/token red-stop lock)`
    );
  });
}

for (const phrase of STOP_CONDITION_ANCHORS) {
  test(`rule-audit-playbook.md contains stop condition anchor in batch/token guidance: ${phrase}`, () => {
    assert.ok(
      batchGuidanceBody.includes(phrase),
      `expected rule-audit-playbook.md batch/token guidance to contain "${phrase}" (batch approval stop-condition lock)`
    );
  });
}

test("rule-audit-playbook.md stop conditions are grouped before Exit Criteria", () => {
  const lastResortIdx = ruleBody.indexOf("last resort");

  assert.ok(batchIdx !== -1, "batch approval anchor missing");
  assert.ok(lastResortIdx !== -1, "last resort anchor missing");
  assert.ok(exitIdx !== -1, "Exit Criteria heading missing");
  assert.ok(
    batchIdx < lastResortIdx && lastResortIdx < exitIdx,
    `batch approval/token stop guidance must appear before Exit Criteria (batch=${batchIdx}, lastResort=${lastResortIdx}, exit=${exitIdx})`
  );
});
