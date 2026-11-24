/**
 * token-frugal-exploratory-rg-grep.test.mjs
 *
 * Contract-guard (grep) tests for the strengthen-token-frugal-exploratory-rg-gate change.
 *
 * Locks anchors in token-frugal-io.md to prevent silent regression of the
 * Exploratory Search Gate rule: `rg` is not a large-output exception —
 * exploratory / repo-wide / uncertain-scope searches must first use
 * `rg -l` (file discovery), `rg --count` (size), a narrowed pathspec,
 * `-m` sampling, or `--glob` exclusions before feeding raw line output to context.
 *
 * Pattern source: enforce-codex-api-latch-evidence-gate-grep.test.mjs
 *   node:test + node:fs readFileSync + path.resolve(scriptDir,"../../..") REPO_ROOT
 *   + read(rel) + assert.ok(content.includes(phrase))
 *
 * Failure means a protected anchor was trimmed or renamed —
 * walk amend before merge.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

function read(rel) {
  return readFileSync(path.resolve(REPO_ROOT, rel), "utf8");
}

const FAILURE_SUFFIX =
  "由 strengthen-token-frugal-exploratory-rg-gate change 註冊保護；trim 前走 amend";

/**
 * @type {Array<{ file: string, phrase: string, purpose: string }>}
 */
const ANCHORS = [
  {
    file: ".devpro/agent-rules/token-frugal-io.md",
    // Lock the rule-body form (backticked `rg`) so the guard protects the
    // actual gate prose at line 52, not the unbackticked grep-pattern string
    // in the Verification block (which would self-satisfy if the rule were trimmed).
    phrase: "`rg` is not a large-output exception",
    purpose: "Exploratory Search Gate 核心 anchor（rule body 措辭）— 明文 `rg` 不是 large-output 例外",
  },
  {
    file: ".devpro/agent-rules/token-frugal-io.md",
    phrase: "rg -l",
    purpose: "file discovery first-pass 選項 — 只列命中檔，非 line output",
  },
  {
    file: ".devpro/agent-rules/token-frugal-io.md",
    phrase: "--count",
    purpose: "size 結果 first-pass 選項 — `rg --count` 先量體",
  },
  {
    file: ".devpro/agent-rules/token-frugal-io.md",
    phrase: "exploratory",
    purpose: "gate scope 關鍵字 — exploratory / repo-wide / uncertain-scope 搜尋",
  },
  {
    file: ".devpro/agent-rules/token-frugal-io.md",
    phrase: "issue #860",
    purpose: "traceability anchor — 連結觸發本 change 的 evidence",
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
