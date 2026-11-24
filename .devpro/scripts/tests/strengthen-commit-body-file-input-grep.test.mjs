/**
 * strengthen-commit-body-file-input-grep.test.mjs
 *
 * Grep-assertion tests for the strengthen-commit-body-file-input change.
 *
 * Asserts:
 *   (a) ai-autonomy.md contains "多個 `-m`" as preferred commit input method
 *       + "反模式" / "Write 工具預寫" warning keywords (T1 landing verification)
 *   (b) gh-footer-gate.mjs footer-missing message contains worktree relative-path
 *       guidance + repo-external /tmp boundary warning (T2 landing verification)
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readSourceFile as read } from './lib/read.mjs';



// ---------------------------------------------------------------------------
// (a) ai-autonomy.md — commit 輸入法 T1 landing
// ---------------------------------------------------------------------------

test('(a) ai-autonomy.md 含「多個 `-m`」作為 commit 首選輸入法', () => {
  const content = read('.devpro/agent-rules/ai-autonomy.md');
  assert.ok(
    content.includes('多個 `-m`'),
    'ai-autonomy.md 缺「多個 `-m`」——T1 commit 輸入法首選關鍵字未落地'
  );
});

test('(a) ai-autonomy.md 含「反模式」警告關鍵字', () => {
  const content = read('.devpro/agent-rules/ai-autonomy.md');
  assert.ok(
    content.includes('反模式'),
    'ai-autonomy.md 缺「反模式」——T1 Write 預寫分離 -F 的反模式警告未落地'
  );
});

test('(a) ai-autonomy.md 含「Write 工具預寫」警告字串', () => {
  const content = read('.devpro/agent-rules/ai-autonomy.md');
  assert.ok(
    content.includes('Write 工具預寫'),
    'ai-autonomy.md 缺「Write 工具預寫」——T1 反模式描述未落地'
  );
});

// ---------------------------------------------------------------------------
// (b) gh-footer-gate.mjs — footer-missing 訊息 T2 landing
// ---------------------------------------------------------------------------

test('(b) gh-footer-gate.mjs footer-missing 訊息含 notes/tmp main-checkout 路徑提示', () => {
  const content = read('.devpro/scripts/hooks/gh-footer-gate.mjs');
  assert.ok(
    content.includes('notes/tmp/') && content.includes('main-checkout'),
    'gh-footer-gate.mjs footer-missing 訊息缺 notes/tmp / main-checkout 提示——T2 未落地'
  );
});

test('(b) gh-footer-gate.mjs footer-missing 訊息含 repo-external /tmp 邊界', () => {
  const content = read('.devpro/scripts/hooks/gh-footer-gate.mjs');
  assert.ok(
    content.includes('repo-external /tmp body files'),
    'gh-footer-gate.mjs footer-missing 訊息缺 repo-external /tmp 邊界——T2 未落地'
  );
  // issue #1735: reviewer sticky bodies no longer stage in the main checkout, so the TL-body
  // diagnostic must not name that carrier — it must say the reviewer route is separate instead.
  assert.ok(
    !content.includes('notes/tmp/.cross-model-sticky-*.md') &&
      content.includes('reviewer sticky body 不走這條路'),
    'gh-footer-gate.mjs footer-missing 訊息仍把 reviewer sticky staging 導向 main-checkout notes/tmp'
  );
});
