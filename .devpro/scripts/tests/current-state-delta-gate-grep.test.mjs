/**
 * current-state-delta-gate-grep.test.mjs
 *
 * Locks the Current-State Delta Gate anchors in ai-autonomy.md and the compact
 * AGENTS.md §0 startup summary. Assertions are scoped to the named gate section
 * and the single §0 self-check line so unrelated matches cannot false-pass.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readSourceFile as read } from './lib/read.mjs';



function extractCurrentStateDeltaGate(md) {
  const section = md.match(
    /#### Current-State Delta Gate \/ 現況差異驗證\n\n([\s\S]*?)(?=\n### |\n#### |$)/
  );
  assert.ok(
    section,
    'ai-autonomy.md 缺 Current-State Delta Gate / 現況差異驗證 section'
  );
  return section[1];
}

function extractAgentsSelfCheck1(md) {
  const block = md.match(/### 動手前十句自檢[^\n]*\n\n([\s\S]*?)\n\n十題任一/);
  assert.ok(block, 'AGENTS.md: 動手前十句自檢 block 不存在');
  const line1 = block[1].split('\n').find((line) => /^1\.\s+\*\*追溯性\*\*/.test(line));
  assert.ok(line1, 'AGENTS.md: §0 缺 numbered item 1 追溯性 self-check');
  return line1;
}

function extractAgentsSelfCheck8(md) {
  const block = md.match(/### 動手前十句自檢[^\n]*\n\n([\s\S]*?)\n\n十題任一/);
  assert.ok(block, 'AGENTS.md: 動手前十句自檢 block 不存在');
  const line8 = block[1].split('\n').find((line) => /^8\.\s+\*\*Think Before Coding\*\*/.test(line));
  assert.ok(line8, 'AGENTS.md: §0 缺 numbered item 8 Think Before Coding self-check');
  return line8;
}

const aiAutonomyMd = read('.devpro/agent-rules/ai-autonomy.md');
const agentsMd = read('AGENTS.md');
const gate = extractCurrentStateDeltaGate(aiAutonomyMd);
const agentsSelfCheck1 = extractAgentsSelfCheck1(agentsMd);
const agentsSelfCheck8 = extractAgentsSelfCheck8(agentsMd);

test('ai-autonomy.md contains the named Current-State Delta Gate heading', () => {
  assert.ok(
    aiAutonomyMd.includes('Current-State Delta Gate / 現況差異驗證'),
    'ai-autonomy.md must contain the exact Current-State Delta Gate / 現況差異驗證 heading'
  );
});

test('gate applies to code change and rule change surfaces', () => {
  assert.ok(
    /\bcode change\b/.test(gate) && /\brule change\b/.test(gate),
    'Current-State Delta Gate must explicitly cover both code change and rule change'
  );
});

test('gate covers script/hook/CLI, workflow/docs/prompt, and test/CI surfaces', () => {
  for (const pattern of [
    /script\s*\/\s*hook\s*\/\s*CLI behavior/,
    /workflow\s*\/\s*README\s*\/\s*prompt/,
    /test\s*\/\s*CI gate/,
  ]) {
    assert.match(gate, pattern, `Current-State Delta Gate missing surface anchor: ${pattern}`);
  }
});

test('gate contains the four evidence question anchors', () => {
  for (const pattern of [
    /current behavior\s*\/\s*現況實際怎麼做/,
    /proposed delta\s*\/\s*新方案跟現況差在哪/,
    /behavior impact\s*\/\s*為什麼差異會改變行為/,
    /verification\s*\/\s*怎麼驗證/,
  ]) {
    assert.match(gate, pattern, `Current-State Delta Gate missing four-question anchor: ${pattern}`);
  }
});

test('gate rejects restating the existing flow as no-op', () => {
  assert.ok(
    /重講.*重述.*既有流程.*no-op/.test(gate) ||
      /重述.*既有流程.*no-op/.test(gate),
    'Current-State Delta Gate must state that restating the existing flow is a no-op'
  );
});

test('gate requires user-visible current state, change, impact, and proof confirmation before edits', () => {
  for (const pattern of [
    /user-visible/,
    /現狀是如何/,
    /打算改成怎樣/,
    /為什麼會有效/,
    /怎麼證明有效/,
    /等使用者確認|wait for user approval|user confirmation/,
    /exact scoped change/,
  ]) {
    assert.match(gate, pattern, `Current-State Delta Gate missing user-visible confirmation anchor: ${pattern}`);
  }
});

test('AGENTS.md §0 self-check summary carries current-delta and code/rule anchors', () => {
  assert.ok(
    /現況差異/.test(agentsSelfCheck1) &&
      /code\s*\/\s*rule/.test(agentsSelfCheck1) &&
      /no-op/.test(agentsSelfCheck1),
    'AGENTS.md §0 item 1 must summarize 現況差異 and code/rule coverage without adding an eleventh item'
  );
});

test('AGENTS.md §0 Think Before Coding summary carries visible confirmation anchors', () => {
  assert.ok(
    /現況\/改法\/效證/.test(agentsSelfCheck8) &&
      /確認/.test(agentsSelfCheck8),
    'AGENTS.md §0 item 8 must require current state / change / proof confirmation before edits'
  );
});
