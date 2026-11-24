import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

// anchor-move: §Split/Dedup Audit Output 已搬至 doc-split-and-dedup-sop.md
// (refactor-core-tier-saturation-split-doc-sop); 讀檔路徑同步更新。
const ruleDesign = readFileSync(
  repoPath(".devpro/agent-rules/doc-split-and-dedup-sop.md"),
  "utf8"
);

test("rule-design-principles defines split/dedup audit output contract", () => {
  const requiredPhrases = [
    "Split/Dedup Audit Output",
    "file-role ledger",
    "routing trigger",
    "split-gate rationale",
    "duplication classification",
    "true duplication",
    "leaf-self-contained",
    "cross-runtime fallback",
  ];

  for (const phrase of requiredPhrases) {
    assert.ok(
      ruleDesign.includes(phrase),
      `rule-design-principles.md missing required split audit phrase: ${phrase}`
    );
  }
});
