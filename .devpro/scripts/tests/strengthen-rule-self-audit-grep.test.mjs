import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoPath } from './lib/repo-root.mjs';

const RULES = repoPath('.devpro/agent-rules');

function readRule(name) {
  return readFileSync(resolve(RULES, name), 'utf8');
}

test('Group 1 REQUIRED: A — code-review-checklist.md SSOT-drift sub-check anchors', () => {
  const content = readRule('code-review-checklist.md');
  assert.ok(content.includes('SSOT-drift sub-check'), 'must contain "SSOT-drift sub-check"');
  assert.ok(content.includes('對新增 rule body'), 'must contain "對新增 rule body"');
  assert.ok(content.includes('跨 repo grep'), 'must contain "跨 repo grep"');
  assert.ok(content.includes('hit ≥ 2 檔'), 'must contain "hit ≥ 2 檔"');
  assert.ok(content.includes('豁免 `*-fallback.md`'), 'must contain exemption phrase');
});

test('Group 1 REQUIRED: B — proposal-template.md Pre-architect Checklist anchors', () => {
  const content = readRule('proposal-template.md');
  assert.ok(content.includes('## Pre-architect Checklist'), 'must contain heading');
  assert.ok(content.includes('AGENTS.md 觸發式載入索引 entry'), 'must contain bullet 1');
  assert.ok(content.includes('mechanical gate 整合點'), 'must contain bullet 2 (phrase)');
  assert.ok(content.includes('Section 1 grep-anchor literal'), 'must contain bullet 3');
});

test('Group 1 REQUIRED: B — proposal-template.md heading-order', () => {
  const lines = readRule('proposal-template.md').split('\n');
  const lineNo = (heading) => lines.findIndex((l) => l.trim() === heading) + 1;
  const required = lineNo('## Required Sections');
  const preArch = lineNo('## Pre-architect Checklist');
  const exit = lineNo('## Exit Criteria');
  assert.ok(required > 0, '## Required Sections must exist');
  assert.ok(preArch > 0, '## Pre-architect Checklist must exist');
  assert.ok(exit > 0, '## Exit Criteria must exist');
  assert.ok(required < preArch, '## Required Sections must come before ## Pre-architect Checklist');
  assert.ok(preArch < exit, '## Pre-architect Checklist must come before ## Exit Criteria');
});

test('Group 1 REQUIRED: C — git-workflow-tracking.md new rationalization row anchors', () => {
  const content = readRule('git-workflow-tracking.md');
  assert.ok(content.includes('PR 已建立，待使用者 merge'), 'must contain new row left column');
  assert.ok(content.includes('ai-autonomy.md'), 'must reference ai-autonomy.md');
  assert.ok(content.includes('Post-PR created handoff'), 'must contain Post-PR created handoff');
  assert.ok(content.includes('cross-model review before merge'), 'must contain cross-model review before merge');
  assert.ok(content.includes('gh pr merge'), 'must contain gh pr merge');
});

test('Group 1 REQUIRED: Sanity — fallback.md files still exist', () => {
  const entries = readdirSync(RULES);
  const fallbacks = entries.filter((f) => f.endsWith('-fallback.md'));
  assert.ok(fallbacks.length >= 1, '*-fallback.md must exist (exemption target must not be dead)');
});

test('Group 2 FORBIDDEN dogfood: axis-2 block must not contain canonical FORBIDDEN regex literals', () => {
  const content = readRule('code-review-checklist.md');
  const axis2Start = content.indexOf('### 2. 可讀性與架構');
  assert.ok(axis2Start >= 0, '### 2. 可讀性與架構 section must exist');
  const nextAxis = content.indexOf('\n### ', axis2Start + 1);
  const axis2Block = nextAxis >= 0 ? content.slice(axis2Start, nextAxis) : content.slice(axis2Start);

  // Construct FORBIDDEN patterns using RegExp constructor to avoid SSOT-drift on this test file itself.
  const forbidden = [
    new RegExp(String.raw`[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}`),
    new RegExp(String.raw`/Users/[a-z]`),
    new RegExp(String.raw`/home/[a-z]`),
    new RegExp(String.raw`C:\\\\Users\\\\`),
    new RegExp(String.raw`\b\d{17,19}\b`),
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(axis2Block), `axis-2 block must not match FORBIDDEN pattern: ${pattern}`);
  }
});

test('Group 3 Existence: all 4 touched files exist', () => {
  const files = [
    resolve(RULES, 'code-review-checklist.md'),
    resolve(RULES, 'proposal-template.md'),
    resolve(RULES, 'git-workflow-tracking.md'),
    repoPath('.devpro/scripts/tests/strengthen-rule-self-audit-grep.test.mjs'),
  ];
  for (const f of files) {
    assert.ok(existsSync(f), `file must exist: ${f}`);
  }
});
