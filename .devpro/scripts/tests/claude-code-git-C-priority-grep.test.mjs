/**
 * claude-code-git-C-priority-grep.test.mjs
 *
 * Prove-it / alignment guard for #1992:
 * Claude Code adapter §風險 D prefers `git -C <abs-worktree>` for worktree git;
 * demotes `cd&&` to non-git secondary; documents classifier friction ≠ hook cwd
 * visibility; Common Rationalizations + Verification stay aligned.
 *
 * Style reference: clarify-submodule-gitlink-feature-tip-grep.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { sourcePath } from './lib/source-root.mjs';
const adapterPath = '.devpro/agent-rules/platform-adapters/claude-code.md';
const adapter = readFileSync(sourcePath(adapterPath), 'utf8');

/** §風險 D through the next `### ` heading (exclusive). */
function extractRiskD(md) {
  const block = md.match(/### 風險 D[\s\S]*?(?=\n### )/);
  assert.ok(block, `${adapterPath}: ### 風險 D 段不存在`);
  return block[0];
}

/** Common Rationalizations row rebutting worktree hook awareness. */
function extractWorktreeMisconceptionRow(md) {
  const table = md.match(/## Common Rationalizations[\s\S]*?(?=\n## )/);
  assert.ok(table, `${adapterPath}: ## Common Rationalizations 段不存在`);
  const row = table[0]
    .split('\n')
    .find((line) => line.includes('Claude Code hook 會知道我在哪個 worktree'));
  assert.ok(
    row,
    `${adapterPath}: Common Rationalizations 缺「Claude Code hook 會知道我在哪個 worktree」列`
  );
  return row;
}

function extractVerification(md) {
  const block = md.match(/## Verification[\s\S]*$/);
  assert.ok(block, `${adapterPath}: ## Verification 段不存在`);
  return block[0];
}

const riskD = extractRiskD(adapter);
const misconceptionRow = extractWorktreeMisconceptionRow(adapter);
const verification = extractVerification(adapter);

const RISK_D_UNPRIORITIZED =
  '`git -C <abs-worktree> ...` 或 explicit `cd <abs-worktree> && ...`';
const MISCONCEPTION_UNPRIORITIZED = '`git -C` 或 explicit `cd`';

test('§風險 D：worktree git 預設／優先 git -C <abs-worktree>', () => {
  assert.ok(
    riskD.includes('預設／優先'),
    `${adapterPath} §風險 D 缺「預設／優先」——worktree git 須標預設／優先形狀`
  );
  assert.ok(
    riskD.includes('git -C <abs-worktree>'),
    `${adapterPath} §風險 D 缺「git -C <abs-worktree>」——預設／優先補救形狀`
  );
});

test('§風險 D：cd&& 降為非 git 次要', () => {
  assert.ok(
    riskD.includes('非 git'),
    `${adapterPath} §風險 D 缺「非 git」——cd&& 須標為非 git 用途`
  );
  assert.ok(
    riskD.includes('次要'),
    `${adapterPath} §風險 D 缺「次要」——cd&& 須標為次要形狀`
  );
});

test('§風險 D：分類器摩擦 ≠ hook cwd visibility', () => {
  assert.ok(
    riskD.includes('分類器摩擦'),
    `${adapterPath} §風險 D 缺「分類器摩擦」——須與 hook cwd visibility 機制區分`
  );
  assert.ok(
    /分類器摩擦[\s\S]{0,120}(?:≠|不等於|無關|不是|distinct|not the same)/.test(riskD) ||
      /(?:≠|不等於|無關|不是|distinct|not the same)[\s\S]{0,120}(?:hook cwd visibility|hook 邏輯)/.test(
        riskD
      ),
    `${adapterPath} §風險 D 須能讀出分類器摩擦與 hook cwd visibility／hook 邏輯無關／≠`
  );
  assert.ok(
    riskD.includes('pwd') &&
      riskD.includes('git rev-parse --abbrev-ref HEAD') &&
      riskD.includes('git status --short --branch'),
    `${adapterPath} §風險 D 須保留 pwd／branch／status hook-visible evidence 義務`
  );
});

test('§風險 D：不得保留 git 無優先並列字面', () => {
  assert.equal(
    riskD.includes(RISK_D_UNPRIORITIZED),
    false,
    `${adapterPath} §風險 D 仍含無優先並列「${RISK_D_UNPRIORITIZED}」——須改為預設／優先 git -C`
  );
});

test('Common Rationalizations：與 §風險 D 同方向優先序', () => {
  assert.ok(
    misconceptionRow.includes('預設／優先'),
    `${adapterPath} 誤解表 worktree 列缺「預設／優先」`
  );
  assert.ok(
    misconceptionRow.includes('git -C'),
    `${adapterPath} 誤解表 worktree 列缺「git -C」`
  );
  assert.ok(
    misconceptionRow.includes('分類器摩擦') || misconceptionRow.includes('非 git'),
    `${adapterPath} 誤解表 worktree 列宜點「分類器摩擦」或「非 git」`
  );
  assert.equal(
    misconceptionRow.includes(MISCONCEPTION_UNPRIORITIZED),
    false,
    `${adapterPath} 誤解表仍含無優先「${MISCONCEPTION_UNPRIORITIZED}」`
  );
});

test('Verification：rg 擴充預設／優先|分類器摩擦|非 git（不削弱既有錨）', () => {
  assert.ok(
    verification.includes('預設／優先') || verification.includes('預設／優先|'),
    `${adapterPath} Verification 缺「預設／優先」錨`
  );
  assert.ok(
    verification.includes('分類器摩擦'),
    `${adapterPath} Verification 缺「分類器摩擦」錨`
  );
  assert.ok(
    verification.includes('非 git'),
    `${adapterPath} Verification 缺「非 git」錨`
  );
  for (const kept of ['風險 D', 'git -C', 'hook-visible cwd evidence']) {
    assert.ok(
      verification.includes(kept),
      `${adapterPath} Verification 不得削弱既有錨「${kept}」`
    );
  }
});
