/**
 * spec-eof-newline-grep.test.mjs
 *
 * Structural guard: every live capability spec (openspec/specs/<cap>/spec.md)
 * MUST end with exactly one trailing newline — a final `\n` present, and NO
 * blank line at EOF (no `\n\n` tail).
 *
 * Root cause this guards: the external `openspec archive` CLI promotes a change's
 * spec delta into the live spec via `specs-apply.ts` whose rebuilt-string write
 * does not normalize the trailing newline, so a promoted spec can pick up a
 * blank-line-at-EOF. That drift went undetected because the only whitespace
 * check (`check-committed-diff-whitespace.mjs` → `git diff --check`) runs at
 * release assembly, NOT pre-merge — so 12 of 23 live specs accumulated a
 * blank-at-EOF and blocked the v6.76.0 release.
 *
 * Carrier choice (per design-core.md §7 Accident-Prevention Backstop Carrier):
 * the OpenSpec CLI is an EXTERNAL dependency we cannot patch, so the durable
 * backstop is a STRUCTURAL signal check — read each spec's bytes and assert the
 * EOF shape — run inside the source-repo test suite (the canonical enforcement
 * carrier). This catches any future archive-introduced regression on every
 * `node --test` and at the pre-PR gate, long before release assembly.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, SOURCE_ROOT } from "./lib/repo-root.mjs";
const specsDir = path.join(SOURCE_ROOT, "openspec", "specs");

/** Collect every openspec/specs/<cap>/spec.md path. */
function collectSpecFiles() {
  const out = [];
  for (const cap of readdirSync(specsDir)) {
    const specPath = path.join(specsDir, cap, "spec.md");
    try {
      if (statSync(specPath).isFile()) out.push(specPath);
    } catch {
      // capability dir without spec.md — skip
    }
  }
  return out;
}

const specFiles = collectSpecFiles();

test("at least one live spec is discovered (scaffold sanity)", () => {
  assert.ok(
    specFiles.length > 0,
    "找不到任何 openspec/specs/<cap>/spec.md — specs 目錄結構已變",
  );
});

for (const specPath of specFiles) {
  const rel = path.relative(REPO_ROOT, specPath);

  test(`${rel} ends with exactly one trailing newline`, () => {
    const content = readFileSync(specPath, "utf8");

    // Must be non-empty and end with a final newline.
    assert.ok(content.length > 0, `${rel} 為空檔`);
    assert.ok(
      content.endsWith("\n"),
      `${rel} 缺結尾 newline（POSIX text file MUST 以單一 \\n 結尾）`,
    );

    // Must NOT have a blank line at EOF. Mirror `git diff --check` semantics
    // (the release whitespace gate): the final newline-terminated line MUST NOT
    // be empty-or-whitespace-only. This covers the LF archive regression
    // (`...\n\n`) AND the CRLF (`...\r\n\r\n`) / whitespace-only (`...\n \n`,
    // `...\n\t\n`) forms a narrow `!endsWith("\n\n")` check would miss
    // (cross-model review, PR #1278). Strip the single trailing `\n`, then the
    // remaining tail (after the previous `\n`/`\r\n`) is the final content line.
    const withoutFinalNewline = content.replace(/\r?\n$/, "");
    const lastLine = withoutFinalNewline.slice(
      withoutFinalNewline.lastIndexOf("\n") + 1,
    );
    assert.ok(
      lastLine.trim() !== "" || withoutFinalNewline === "",
      `${rel} blank-line-at-EOF — promoted spec 帶尾行空行（LF/CRLF/whitespace-only 任一形式）。` +
        `根因：openspec archive promote 未 normalize 結尾 newline。修法：strip 尾行空行至單一 \\n。` +
        `此 guard 防 archive 回歸（per design-core.md §7：external CLI 不可改，結構化 byte 檢查為 durable backstop）。`,
    );
  });
}
