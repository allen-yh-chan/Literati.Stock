/**
 * clarify-submodule-gitlink-feature-tip-grep.test.mjs
 *
 * Locks load-bearing phrases for business submodule gitlink tip-pin
 * convention in git-branch-and-pr-flow.md (issue #1900 / FR-6).
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { sourcePath } from './lib/source-root.mjs';
const leaf = readFileSync(
  sourcePath('.devpro/agent-rules/git-branch-and-pr-flow.md'),
  'utf8'
);

test('hub pins feature-branch tip for business submodule gitlink', () => {
  assert.ok(
    leaf.includes('feature-branch tip'),
    'git-branch-and-pr-flow.md missing "feature-branch tip"'
  );
});

test('hub MUST NOT pin downstream integration/merge commit', () => {
  assert.ok(
    leaf.includes('MUST NOT pin 下游 integration／merge commit'),
    'git-branch-and-pr-flow.md missing MUST NOT downstream merge phrase'
  );
});

test('hub documents gh compare sample and empty file-tree prefer tip', () => {
  assert.ok(
    leaf.includes('gh api repos/<owner>/<repo>/compare/<a>...<b>'),
    'git-branch-and-pr-flow.md missing gh compare sample'
  );
  assert.ok(
    leaf.includes('空 file-tree') && leaf.includes('prefer tip'),
    'git-branch-and-pr-flow.md missing empty file-tree / prefer tip wording'
  );
});

test('hub excludes .devpro-agent-rules rules-sync from tip-pin convention', () => {
  assert.ok(
    leaf.includes('.devpro-agent-rules') &&
      leaf.includes('rules-sync') &&
      leaf.includes('rules-flow.md'),
    'git-branch-and-pr-flow.md missing business≠rules-sync exclusion'
  );
});

test('hub fail-closed when tip unavailable or compare non-empty', () => {
  assert.ok(
    leaf.includes('fail-closed') && leaf.includes('停下交使用者'),
    'git-branch-and-pr-flow.md missing fail-closed stop wording'
  );
});
