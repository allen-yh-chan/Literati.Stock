import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';
const FILES = [
  '.devpro/agent-rules/preflight-checklist.md',
  '.devpro/agent-rules/openspec-flow.md',
  '.claude/agents/dp-analyst.md',
  '.devpro/agent-skills/devpro-workflows/change/SKILL.md',
];

const PATTERN = /(simplification.*feature|混 commit|混入)/;

for (const file of FILES) {
  test(`${file} 含「禁混 simplification + feature」相關字樣`, () => {
    const filePath = repoPath(file);
    const content = readFileSync(filePath, 'utf8');
    assert.match(
      content,
      PATTERN,
      `${file} 未含 simplification.*feature / 混 commit / 混入 任一`
    );
  });
}
