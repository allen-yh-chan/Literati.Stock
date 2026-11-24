import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';

const ANTI_PATTERNS_BEHAVIORAL = repoPath('.devpro/agent-rules/anti-patterns-behavioral.md');
const PROJECT_STRUCTURE = repoPath('.devpro/agent-rules/project-structure-sln-and-folders.md');

test('anti-patterns-behavioral.md 含 §13 anti-pattern 標題（恰 1 次）', () => {
  const content = readFileSync(ANTI_PATTERNS_BEHAVIORAL, 'utf8');
  const TITLE = 'Convenience-Driven Boundary Placement';
  const matches = content.split(TITLE).length - 1;
  assert.equal(matches, 1, `期望 §13 anti-pattern 標題出現恰 1 次，實際出現 ${matches} 次`);
});

test('project-structure-sln-and-folders.md 含 anti-patterns-behavioral.md 的 §13 cross-link', () => {
  const content = readFileSync(PROJECT_STRUCTURE, 'utf8');
  const hasLink = content
    .split('\n')
    .some(line => line.includes('anti-patterns-behavioral.md') && line.includes('Convenience-Driven'));
  assert.ok(hasLink, 'project-structure-sln-and-folders.md 未含同行引用 anti-patterns-behavioral.md + §13 的 cross-link');
});
