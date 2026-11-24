/**
 * Integration prove-it: ratchet CLI unavailable marker → infrastructure remediation.
 * Kept separate from git-exec-retry.test.mjs so the unit file stays free of child_process.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  activeContentLintRemediationText,
  isActiveContentLintUnavailable,
} from '../lib/active-content-lint-remediation.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('Scenario: Ratchet CLI Unavailable Marker Composes Infrastructure Remediation', () => {
  // Archived change with a proposal carrier so the CLI reaches the prior-state
  // probe; an unresolvable --base forces priorState unavailable.
  const changeFolder = 'openspec/changes/archive/2026-09-21-fix-git-transient-flake-attribution';
  const result = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, '.devpro/scripts/lint-requirement-count-ratchet.mjs'),
      changeFolder,
      '--base',
      'definitely-not-a-commit-ref-zzzz',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  const stderr = String(result.stderr || '');
  assert.match(stderr, /\] unavailable:/);
  const unavailable = isActiveContentLintUnavailable(stderr);
  assert.equal(unavailable, true);
  const text = activeContentLintRemediationText({ unavailable });
  assert.match(text, /Git\/infrastructure probe unavailable/);
  assert.doesNotMatch(text, /Fix the active OpenSpec tree/);
});
