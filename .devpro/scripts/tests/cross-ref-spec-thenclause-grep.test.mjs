/**
 * cross-ref-spec-thenclause-grep.test.mjs
 *
 * 守護 openspec/specs/<cap>/spec.md 裡 THEN/AND clause 的 backtick cross-ref。
 * 格式：`(per |見 )?`<leaf>.md` §<heading>`
 *
 * 覆蓋範圍（與既有 test 的分工）：
 *   cross-ref-heading-anchor-grep.test.mjs  — agent-rules/*.md 內「見 file.md §heading」（無 backtick，Pattern B）
 *   cross-ref-section-anchor-grep.test.mjs  — agent-rules/*.md 內 `file.md`「phrase」（Pattern A）
 *   本檔                                    — openspec/specs/<cap>/spec.md 内 THEN/AND clause 的
 *                                             `` `leaf.md` §heading `` 及 `per `leaf.md` §heading`（新 surface，W2 拆檔漏洞點）
 *
 * 共用判斷（citation pattern / heading match / fence 中和 / clause-final 規則）：
 *   一律來自 ../lib/spec-thenclause-citations.mjs（pure、無 top-level side effect），
 *   與 lint-delta-spec-citations.mjs（change delta 的 pre-archive 檢查）共用同一份，
 *   使 archive 前通過的 citation 不會在 promote 後被另一套規則擋下。本檔不再持有第二份 copy。
 *   cross-ref-heading-anchor-grep.test.mjs 仍刻意保有自己的 headingMatchesRef copy
 *   （它守護 agent-rules 內無 backtick 的「見 file.md §heading」，import 該 test 檔會有
 *   node:test top-level side effect，故不 import 也不併入此 lib）。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, repoPath } from './lib/repo-root.mjs';
import {
  headingExistsInTarget,
  headingMatchesRef,
  scanThenAndCitations,
  stripFencedCodeBlocks,
} from '../lib/spec-thenclause-citations.mjs';

const agentRulesDir = repoPath('.devpro/agent-rules');
const specsDir = repoPath('openspec/specs');

/** 遞迴找 openspec/specs/ 下所有 spec.md */
function collectSpecFiles() {
  if (!existsSync(specsDir)) return [];
  const results = [];
  for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = path.join(specsDir, entry.name, 'spec.md');
      if (existsSync(candidate)) results.push(candidate);
    }
  }
  return results;
}

// ── 收集所有 THEN/AND cross-ref 命中 ──
// Missing filenames fail closed (#2287). Citations must be clause-final (#2286)
// so LEAF_SECTION_RE cannot swallow trailing English as a heading.
const allMatches = [];
const unresolvedCitations = [];
const nonClauseFinalCitations = [];
const SANITY_MIN_HITS = 8;

for (const specPath of collectSpecFiles()) {
  const specRel = specPath.replace(REPO_ROOT + '/', '');
  const content = stripFencedCodeBlocks(readFileSync(specPath, 'utf8'));
  const scan = scanThenAndCitations({ content, agentRulesDir });
  for (const c of scan.nonClauseFinal) nonClauseFinalCitations.push({ specRel, ...c });
  for (const c of scan.unresolved) unresolvedCitations.push({ specRel, ...c });
  for (const c of scan.citations) allMatches.push({ specRel, ...c });
}

test('THEN/AND citations that name a missing leaf.md fail closed', () => {
  assert.deepEqual(
    unresolvedCitations,
    [],
    `citation names a file that does not exist under agent-rules/: ${JSON.stringify(unresolvedCitations)}`
  );
});

test('THEN/AND `leaf.md` §heading citations are clause-final', () => {
  assert.deepEqual(
    nonClauseFinalCitations,
    [],
    `citation must sit at clause end (only trailing punctuation allowed): ${JSON.stringify(nonClauseFinalCitations)}`
  );
});

test(`spec THEN/AND cross-ref count ≥ ${SANITY_MIN_HITS} (sanity: regex not empty)`, () => {
  assert.ok(
    allMatches.length >= SANITY_MIN_HITS,
    `expected ≥ ${SANITY_MIN_HITS} THEN/AND cross-refs in spec.md files but found ${allMatches.length} — regex may be broken`
  );
});

// ── 動態 subtest：逐一驗 heading 真實存在於 target ──
for (const { specRel, lineNo, filename, heading, targetPath } of allMatches) {
  test(`${specRel}:${lineNo} → ${filename} §「${heading}」 — is a heading in target`, () => {
    assert.ok(
      headingExistsInTarget(targetPath, heading),
      `"${heading}" is not a heading in ${filename} (from ${specRel}:${lineNo})`
    );
  });
}

// ── 負向 unit：鎖住 headingMatchesRef dangling ref 守衛 ──
test('headingMatchesRef: "NoSuchHeading" is rejected against "## 6 Principles"', () => {
  assert.equal(
    headingMatchesRef('## 6 Principles', 'NoSuchHeading'),
    false,
    'headingMatchesRef should return false for a non-existent heading ref'
  );
});
