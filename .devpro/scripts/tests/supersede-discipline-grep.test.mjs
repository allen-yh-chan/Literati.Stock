/**
 * supersede-discipline-grep.test.mjs
 *
 * Locks the Supersede-Sweep discipline and Retained-API Hard-Fail Deprecation
 * rules codified into anti-patterns-behavioral.md §15 and §16 (T5 de-bundle:
 * §15/§16 detail moved from anti-patterns-examples.md to anti-patterns-behavioral.md),
 * plus the Mandatory Clause Enforcement Map row in openspec-flow.md.
 *
 * TDD: assertions are written first (red) before rule text is added (green).
 * Style reference: enforce-review-finding-disposition-grep.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';

const antiPatterns = readFileSync(
  repoPath('.devpro/agent-rules/anti-patterns-behavioral.md'),
  'utf8'
);

const opspecFlow = readFileSync(
  repoPath('.devpro/agent-rules/openspec-flow.md'),
  'utf8'
);

/**
 * Extract a single ### section bounded by the next ### / ## heading (or EOF),
 * so assertions on §15 do not leak into §16 and vice-versa (per cross-model
 * review #1160: slice(idx)-to-EOF is unbounded and a future reorder could let
 * §15 assertions pass on §16 content).
 */
function section(md, heading) {
  const start = md.indexOf(heading);
  if (start === -1) return null;
  const after = md.slice(start + heading.length);
  const nextHeading = after.search(/\n#{2,3} /);
  return nextHeading === -1 ? after : after.slice(0, nextHeading);
}

const SEC15 = '### §15 Incomplete Supersede Sweep';
const SEC16 = '### §16 Retained-API Without Hard-Fail Deprecation';

// ── (a) §15 Incomplete Supersede Sweep ──────────────────────────────────────

test('anti-patterns 含 §15 標題', () => {
  assert.ok(
    antiPatterns.includes('### §15 Incomplete Supersede Sweep'),
    'anti-patterns-behavioral.md 缺少 ### §15 Incomplete Supersede Sweep 標題'
  );
});

// 有界擷取（slice 至下一 ## / ### 標題），§15 token 不會洩漏到 §16
for (const token of ['Supersede', 'call site', 'grep', 'Drive-by', '真實依賴']) {
  test(`§15 段含 ${token}`, () => {
    const sec = section(antiPatterns, SEC15);
    assert.ok(sec, '§15 段不存在');
    assert.ok(sec.includes(token), `§15 段缺少 ${token}`);
  });
}

// ── (b) §16 Retained-API Without Hard-Fail Deprecation ──────────────────────

test('anti-patterns 含 §16 標題', () => {
  assert.ok(
    antiPatterns.includes('### §16 Retained-API Without Hard-Fail Deprecation'),
    'anti-patterns-behavioral.md 缺少 ### §16 Retained-API Without Hard-Fail Deprecation 標題'
  );
});

test('§16 段含 [Obsolete]（C# 標記）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('[Obsolete]'),
    '§16 段缺少 [Obsolete]（C# deprecate 標記）'
  );
});

test('§16 段含 @Deprecated（Java 標記）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('@Deprecated'),
    '§16 段缺少 @Deprecated（Java 標記）'
  );
});

test('§16 段含 @deprecated（TS/JS JSDoc 標記）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('@deprecated'),
    '§16 段缺少 @deprecated（TS/JS JSDoc 標記）'
  );
});

test('§16 段含 #[deprecated]（Rust 標記）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('#[deprecated]'),
    '§16 段缺少 #[deprecated]（Rust 標記）'
  );
});

test('§16 段含 build-error 升級詞 error: true', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('error: true'),
    '§16 段缺少 error: true（C# build-error 升級）'
  );
});

test('§16 段含 build-error 升級詞 TreatWarningsAsErrors', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('TreatWarningsAsErrors'),
    '§16 段缺少 TreatWarningsAsErrors（C# build-error 升級）'
  );
});

test('§16 段含 build-error 升級詞 -Werror（Java/C 等）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('-Werror'),
    '§16 段缺少 -Werror（Java/C build-error 升級）'
  );
});

test('§16 段含 BannedApiAnalyzers（規模化 token）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('BannedApiAnalyzers'),
    '§16 段缺少 BannedApiAnalyzers'
  );
});

test('§16 段含 BannedSymbols（規模化 token）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('BannedSymbols'),
    '§16 段缺少 BannedSymbols'
  );
});

test('§16 段含 allowlist（規模化 token）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('allowlist'),
    '§16 段缺少 allowlist'
  );
});

test('§16 段含移除計畫關鍵字（移除 或 removal）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('移除') || sec.includes('removal'),
    '§16 段缺少移除計畫關鍵字（移除 或 removal）'
  );
});

test('§16 段含反 footgun token 優化版本', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('優化版本'),
    '§16 段缺少反 footgun token 優化版本'
  );
});

// ── (b2) §16 7-language table completeness + TS/JS separate rows ─────────────
// Cross-model review #1160 Important: grep test did not pin the 7-language-row
// completeness nor the D-TS/JS-split decision. Without these, a Python/Go row
// deletion or a TS/JS row merge would still pass green.

test('§16 7 語言對照表每列語言名皆在（C#/Java/TypeScript/JavaScript/Python/Go/Rust）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  for (const lang of ['C#', 'Java', 'TypeScript', 'JavaScript', 'Python', 'Go', 'Rust']) {
    assert.ok(
      sec.includes(`| ${lang} |`),
      `§16 對照表缺少語言列：| ${lang} |（7 語言完整性）`
    );
  }
});

test('§16 TypeScript 與 JavaScript 為分開的列（D-TS/JS-split 強制）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  // 必須是兩列獨立 row，不得合併為 `| TypeScript/JavaScript |` 之類
  assert.ok(sec.includes('| TypeScript |'), '§16 缺少獨立 TypeScript 列');
  assert.ok(sec.includes('| JavaScript |'), '§16 缺少獨立 JavaScript 列');
  assert.ok(
    !/\|\s*TypeScript\s*\/\s*JavaScript\s*\|/.test(sec) && !/\|\s*JS\s*\/\s*TS\s*\|/.test(sec),
    '§16 不得把 TS/JS 合併為單列（footgun 程度不同，須分列）'
  );
});

test('§16 Java 硬攔列含 -Xlint:deprecation（非僅 -Werror）', () => {
  const sec = section(antiPatterns, SEC16);
  assert.ok(sec, '§16 段不存在');
  assert.ok(
    sec.includes('-Xlint:deprecation'),
    '§16 Java 列須含 -Xlint:deprecation（bare -Werror 不會升 @Deprecated 為 error）'
  );
});

// ── (c) frontmatter / Overview 更新 ─────────────────────────────────────────

test('anti-patterns frontmatter 含 16 組', () => {
  const entryLeaf = readFileSync(
    repoPath('.devpro/agent-rules/anti-patterns-examples.md'),
    'utf8'
  );
  assert.ok(
    entryLeaf.includes('16 組'),
    'anti-patterns-examples.md frontmatter 未更新為 16 組'
  );
});

test('anti-patterns Overview 含 共 16 組', () => {
  const entryLeaf = readFileSync(
    repoPath('.devpro/agent-rules/anti-patterns-examples.md'),
    'utf8'
  );
  assert.ok(
    entryLeaf.includes('共 16 組'),
    'anti-patterns-examples.md Overview 未更新為 共 16 組'
  );
});

test('anti-patterns Overview 含 §7-§16 範圍', () => {
  const entryLeaf = readFileSync(
    repoPath('.devpro/agent-rules/anti-patterns-examples.md'),
    'utf8'
  );
  assert.ok(
    entryLeaf.includes('§7-§16'),
    'anti-patterns-examples.md Overview 未更新為 §7-§16'
  );
});

// ── (d) openspec-flow Enforcement Map ───────────────────────────────────────

test('openspec-flow Enforcement Map 含 supersede-discipline-grep', () => {
  assert.ok(
    opspecFlow.includes('supersede-discipline-grep'),
    'openspec-flow.md Enforcement Map 缺少 supersede-discipline-grep 列'
  );
});
