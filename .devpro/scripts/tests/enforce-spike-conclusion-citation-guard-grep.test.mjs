/**
 * enforce-spike-conclusion-citation-guard-grep.test.mjs
 *
 * Locks the spike-結論-引用護欄 added to ai-autonomy.md §Ask First 前置濾網 block.
 *
 * 護欄命題：follow-up / pending note 引用 spike 結論作「直接改」依據時，必須區分
 *   「spike 只證物理可行」vs「反轉既有 ratified 設計決策的正當性」——後者即使物理可行
 *   也須 repo-owner informed 拍板，不得無聲反轉（尤其被反轉者是近期自己 ratified 的 spec）。
 *
 * 此護欄是既有「Ask First 前置濾網（anti over-ask）」的鏡像補項（anti 偽單解-無聲自決），
 * 共根「決策當下了結」。與 spike-as-test-evidence（testing-and-qa.md，另一命題）以 cross-ref 消歧。
 *
 * Style reference: enforce-decide-now-discipline-grep.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';

const autonomy = readFileSync(
  repoPath('.devpro/agent-rules/ai-autonomy.md'),
  'utf8'
);

test('ai-autonomy 含「spike-結論-引用護欄」block 標題', () => {
  assert.ok(
    autonomy.includes('spike-結論-引用護欄'),
    'ai-autonomy.md 缺少「spike-結論-引用護欄」block 標題'
  );
});

test('護欄明示「spike 只證物理可行」核心命題', () => {
  assert.ok(
    autonomy.includes('spike 只證物理可行'),
    'ai-autonomy.md 缺少「spike 只證物理可行」核心命題錨字'
  );
});

test('護欄區分對象「反轉既有 ratified 設計」', () => {
  assert.ok(
    autonomy.includes('反轉既有 ratified 設計'),
    'ai-autonomy.md 缺少「反轉既有 ratified 設計」區分對象錨字'
  );
});

test('護欄升級路徑「informed 拍板」', () => {
  assert.ok(
    autonomy.includes('informed 拍板'),
    'ai-autonomy.md 缺少「informed 拍板」升級路徑錨字'
  );
});

test('護欄複用共根「決策當下了結」（與 Ask First 前置濾網同 paradigm）', () => {
  assert.ok(
    autonomy.includes('決策當下了結'),
    'ai-autonomy.md 缺少共根「決策當下了結」'
  );
});

test('護欄與 spike-as-test-evidence 以 cross-ref 消歧（testing-and-qa.md）', () => {
  // 護欄段落須 cross-ref testing-and-qa.md，避免讀者把「spike 證設計反轉正當」
  // 與「spike 證測試證據充分」兩個獨立命題混淆。
  const guardIdx = autonomy.indexOf('spike-結論-引用護欄');
  const neverIdx = autonomy.indexOf('### Never');
  assert.ok(guardIdx >= 0 && neverIdx > guardIdx, '護欄 block 應在 ### Never 之前');
  const guardBlock = autonomy.slice(guardIdx, neverIdx);
  assert.ok(
    guardBlock.includes('testing-and-qa.md'),
    '護欄 block 內缺少對 testing-and-qa.md 的消歧 cross-ref'
  );
});
