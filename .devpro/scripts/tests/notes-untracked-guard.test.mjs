import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { REPO_ROOT } from './lib/repo-root.mjs';

test('notes/ has no tracked files (gitignored, local-only per rule-design-principles)', () => {
  const tracked = execSync('git ls-files notes/', { cwd: REPO_ROOT, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  assert.equal(
    tracked.length,
    0,
    `notes/ is gitignored (local-only AI scratch per rule-design-principles.md Workflow Persistence Layers). Found tracked file(s): ${tracked.join(', ')}. Untrack with: git rm --cached <file>`
  );
});
