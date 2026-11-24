import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { sourcePath } from './lib/source-root.mjs';

test('spec.md Scenario: Version Bump Metadata-Only Gate Check excludes full tests', () => {
  const specPath = sourcePath('openspec/specs/openspec-flow/spec.md');
  const spec = readFileSync(specPath, 'utf8');

  // 找到 Scenario: Version Bump Metadata-Only Gate Check 段落
  const scenarioMatch = spec.match(
    /#### Scenario: Version Bump Metadata-Only Gate Check\n([\s\S]*?)(?=\n#### |\n### |$)/
  );
  assert.ok(scenarioMatch, 'Scenario: Version Bump Metadata-Only Gate Check 未在 spec.md 找到');
  assert.match(scenarioMatch[1], /metadata-only/i);
  assert.match(scenarioMatch[1], /MUST NOT require full project tests before merge/);
  assert.doesNotMatch(scenarioMatch[1], /main.*merged.*state/i);
  assert.doesNotMatch(spec, /Bump PR Test Gate Targets Main Merged State/);
  assert.doesNotMatch(spec, /dry-run merge from main into bump branch/);
});

test('spec.md Release Branch Assembled Validation Gate requires tests after assembly', () => {
  const specPath = sourcePath('openspec/specs/openspec-flow/spec.md');
  const spec = readFileSync(specPath, 'utf8');

  assert.match(
    spec,
    /### Requirement: Release Branch Assembled Validation Gate[\s\S]*release branch has been assembled[\s\S]*full project validation/i,
    'Expected release-assembled validation requirement in spec.md'
  );
});
