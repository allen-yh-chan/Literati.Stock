/**
 * Dual-polarity grep: shared-host process signal ownership
 * (clarify-process-kill-ownership / session-pending #36)
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';

const read = (rel) => readFileSync(repoPath(rel), 'utf8');

const AUTONOMY = read('.devpro/agent-rules/ai-autonomy.md');
const HANDOFF = read('.devpro/agent-rules/multi-agent-handoff.md');

describe('clarify-process-kill-ownership: positive anchors', () => {
  test('SSOT section exists in ai-autonomy', () => {
    assert.match(
      AUTONOMY,
      /^### Shared-Host Process Signal Ownership$/m,
      'ai-autonomy.md missing §Shared-Host Process Signal Ownership',
    );
    assert.match(
      AUTONOMY,
      /argv[\s\S]{0,80}時間重疊|時間重疊[\s\S]{0,80}argv/,
      'SSOT must state argv / time-overlap alone are insufficient',
    );
    assert.match(
      AUTONOMY,
      /fail closed/,
      'SSOT must fail closed when ownership evidence is missing',
    );
  });

  test('Never forbids unproven-ownership kills', () => {
    const never = AUTONOMY.split('### Never')[1]?.split('### ')[0] || '';
    assert.match(
      never,
      /未證明 ownership[\s\S]{0,80}SIGTERM|共享主機程序[\s\S]{0,80}kill/,
      'Never must forbid kill without ownership proof',
    );
  });

  // Scenario title literals for lint-delta-new-scenario-assertion-coverage
  test('Scenario: Argv-only sighting is not ownership', () => {
    assert.match(AUTONOMY, /argv[\s\S]{0,120}不足|單獨[\s\S]{0,40}不足/);
    assert.match(AUTONOMY, /禁[\s\S]{0,40}猜測後殺|MUST NOT[\s\S]{0,40}guess/i);
  });

  test('Scenario: Own runaway child may be terminated', () => {
    assert.match(AUTONOMY, /runaway child|自己 spawn/);
  });

  test('Scenario: Handoff pointer cites SSOT', () => {
    assert.match(
      HANDOFF,
      /Shared-host process signal/,
      'multi-agent-handoff missing Shared-host process signal pointer',
    );
    assert.match(
      HANDOFF,
      /ai-autonomy\.md[^\n]*Shared-Host Process Signal Ownership/,
      'handoff must pointer to ai-autonomy SSOT section',
    );
  });
});

describe('clarify-process-kill-ownership: negative anchors', () => {
  test('SSOT must not treat argv-only as sufficient ownership', () => {
    assert.equal(
      /argv[\s\S]{0,40}即(?:可|足以)證明 ownership/.test(AUTONOMY),
      false,
      'must not claim argv alone proves ownership',
    );
    assert.equal(
      AUTONOMY.includes('時間重疊即可殺'),
      false,
      'must not authorize kill on time-overlap alone',
    );
  });
});
