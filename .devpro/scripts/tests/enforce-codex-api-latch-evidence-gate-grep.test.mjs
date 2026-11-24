/**
 * enforce-codex-api-latch-evidence-gate-grep.test.mjs
 *
 * Contract-guard (grep) tests for the enforce-codex-api-latch-and-evidence-gate change.
 *
 * Locks anchors in source files to prevent silent regression of:
 *   FR-A: Codex GitHubApiSurface latch (codex.md)
 *   FR-B: per (surface, host) retry budget (codex.md + ai-autonomy.md)
 *   FR-C: Evidence Ledger / exact-case mandate (troubleshooting.md)
 *   FR-D: warning-heavy io pattern (token-frugal-io.md)
 *   FR-D: root-cause warn in gh-footer-gate hook
 *
 * Failure means a protected anchor was trimmed or renamed — walk amend before merge.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
function read(rel) {
  return readFileSync(path.resolve(REPO_ROOT, rel), "utf8");
}

const FAILURE_SUFFIX = "由 enforce-codex-api-latch-and-evidence-gate change 註冊保護；trim 前走 amend";

/**
 * @type {Array<{ file: string, phrase: string, purpose: string }>}
 */
const ANCHORS = [
  {
    file: ".devpro/agent-rules/platform-adapters/codex.md",
    phrase: "GitHubApiSurface=sandbox-unreliable",
    purpose: "FR-A: Codex surface latch anchor — 標記 GitHub API 為 sandbox-unreliable",
  },
  {
    file: ".devpro/agent-rules/platform-adapters/codex.md",
    phrase: "per (surface, host)",
    purpose: "FR-B: retry budget per (surface, host) 而非 per command",
  },
  {
    file: ".devpro/agent-rules/ai-autonomy.md",
    phrase: "(surface, host)",
    purpose: "FR-B: ai-autonomy.md cross-ref to per (surface, host) retry budget",
  },
  {
    file: ".devpro/agent-rules/troubleshooting.md",
    phrase: "Evidence Ledger",
    purpose: "FR-C: Exact-Case Evidence Ledger 章節 anchor",
  },
  {
    file: ".devpro/agent-rules/troubleshooting.md",
    phrase: "exact-case",
    purpose: "FR-C: exact-case evidence requirement anchor",
  },
  {
    file: ".devpro/agent-rules/token-frugal-io.md",
    phrase: "warning-heavy",
    purpose: "FR-D: warning-heavy io pattern (sticky) 規則",
  },
  {
    file: ".devpro/scripts/hooks/gh-footer-gate.mjs",
    phrase: "Evidence Ledger",
    purpose: "FR-D: root-cause warn in hook 含 Evidence Ledger anchor（warn 訊息特徵字串）",
  },
];

for (const { file, phrase, purpose } of ANCHORS) {
  test(`${file} 含「${phrase}」（${purpose}）`, () => {
    const content = read(file);
    assert.ok(
      content.includes(phrase),
      `「${phrase}」 missing in ${file} — ${purpose} — ${FAILURE_SUFFIX}`
    );
  });
}
