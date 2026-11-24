/**
 * enforce-decide-now-discipline-grep.test.mjs
 *
 * Locks the "decide-now" discipline anchor phrases added to:
 *   1. ai-autonomy.md        — Ask First 前置濾網（decision-ready → 自決，不 over-ask）
 *   2. code-review-checklist.md — Defer 前置濾網（trivial-fixable → 禁 defer）
 *
 * Both blocks share the common root phrase「決策當下了結」and cross-reference
 * each other via rule-design-principles.md.
 *
 * Style reference: enforce-review-finding-disposition-grep.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';

const autonomy = readFileSync(
  repoPath('.devpro/agent-rules/ai-autonomy.md'),
  'utf8'
);

const checklist = readFileSync(
  repoPath('.devpro/agent-rules/code-review-checklist.md'),
  'utf8'
);

// ---------------------------------------------------------------------------
// Test 1: ai-autonomy.md — Ask First 前置濾網
// ---------------------------------------------------------------------------

test('ai-autonomy 含「Ask First 前置濾網」block 標題', () => {
  assert.ok(
    autonomy.includes('Ask First 前置濾網'),
    'ai-autonomy.md 缺少「Ask First 前置濾網」block 標題'
  );
});

test('ai-autonomy 含 decision-ready 錨字', () => {
  assert.ok(
    autonomy.includes('decision-ready'),
    'ai-autonomy.md 缺少「decision-ready」anchor'
  );
});

test('ai-autonomy 含 AskUserQuestion 錨字', () => {
  assert.ok(
    autonomy.includes('AskUserQuestion'),
    'ai-autonomy.md 缺少「AskUserQuestion」anchor'
  );
});

test('ai-autonomy 含「禁把單解問題升級」', () => {
  assert.ok(
    autonomy.includes('禁把單解問題升級'),
    'ai-autonomy.md 缺少「禁把單解問題升級」phrase'
  );
});

// ---------------------------------------------------------------------------
// Test 2: code-review-checklist.md — Defer 前置濾網
// ---------------------------------------------------------------------------

test('code-review-checklist 含「Defer 前置濾網」block 標題', () => {
  assert.ok(
    checklist.includes('Defer 前置濾網'),
    'code-review-checklist.md 缺少「Defer 前置濾網」block 標題'
  );
});

test('code-review-checklist 含 trivial-fixable 錨字', () => {
  assert.ok(
    checklist.includes('trivial-fixable'),
    'code-review-checklist.md 缺少「trivial-fixable」anchor'
  );
});

test('code-review-checklist 含 non-issue 錨字', () => {
  assert.ok(
    checklist.includes('non-issue'),
    'code-review-checklist.md 缺少「non-issue」anchor'
  );
});

test('code-review-checklist 含「附理由 ≠ 可 defer」', () => {
  assert.ok(
    checklist.includes('附理由 ≠ 可 defer'),
    'code-review-checklist.md 缺少「附理由 ≠ 可 defer」phrase'
  );
});

test('code-review-checklist 含停損 nuance「latent」', () => {
  assert.ok(
    checklist.includes('latent'),
    'code-review-checklist.md 缺少停損 nuance「latent」anchor'
  );
});

// ---------------------------------------------------------------------------
// Test 3: 共根 cross-ref — rule-design-principles.md 引用 + 共根 phrase
// ---------------------------------------------------------------------------

test('ai-autonomy 含 rule-design-principles.md cross-ref', () => {
  assert.ok(
    autonomy.includes('rule-design-principles.md'),
    'ai-autonomy.md 缺少 rule-design-principles.md cross-ref'
  );
});

test('code-review-checklist 含 rule-design-principles.md cross-ref', () => {
  assert.ok(
    checklist.includes('rule-design-principles.md'),
    'code-review-checklist.md 缺少 rule-design-principles.md cross-ref'
  );
});

test('ai-autonomy 含共根 phrase「決策當下了結」', () => {
  assert.ok(
    autonomy.includes('決策當下了結'),
    'ai-autonomy.md 缺少共根 phrase「決策當下了結」'
  );
});

test('code-review-checklist 含共根 phrase「決策當下了結」', () => {
  assert.ok(
    checklist.includes('決策當下了結'),
    'code-review-checklist.md 缺少共根 phrase「決策當下了結」'
  );
});

// ---------------------------------------------------------------------------
// Test 4: 迴歸護欄 — code-review-checklist 仍含既有三選一 disposition
// (D 是追加非改寫，原有 Finding Disposition Discipline 內容不得消失)
// ---------------------------------------------------------------------------

test('code-review-checklist 仍含既有 disposition「當場修」（迴歸護欄）', () => {
  assert.ok(
    checklist.includes('當場修'),
    'code-review-checklist.md 既有「當場修」disposition 遭移除（迴歸破壞）'
  );
});

test('code-review-checklist 仍含既有 disposition「開 issue」（迴歸護欄）', () => {
  assert.ok(
    checklist.includes('開 issue'),
    'code-review-checklist.md 既有「開 issue」disposition 遭移除（迴歸破壞）'
  );
});

test('code-review-checklist 仍含既有 disposition「deferred+理由」（迴歸護欄）', () => {
  assert.ok(
    checklist.includes('deferred+理由'),
    'code-review-checklist.md 既有「deferred+理由」disposition 遭移除（迴歸破壞）'
  );
});
