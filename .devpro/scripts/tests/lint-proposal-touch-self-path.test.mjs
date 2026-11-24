import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { lintProposalTouchSelfPath } from '../lint-proposal-touch-self-path.mjs';
import { findOwnActivePathRows } from '../lib/touch-path-hygiene.mjs';

test('findOwnActivePathRows matches only own active table rows', () => {
  assert.deepEqual(
    findOwnActivePathRows('| `openspec/changes/foo/x.md` | code | modify | R1 |', 'foo'),
    [1],
  );
  assert.deepEqual(
    findOwnActivePathRows('| `openspec/changes/archive/<YYYY-MM-DD>-foo/x.md` | code | add | R1 |', 'foo'),
    [],
  );
  assert.deepEqual(
    findOwnActivePathRows('| `openspec/changes/bar/x.md` | code | modify | R1 |', 'foo'),
    [],
  );
});

test('Scenario: Active Touch row names own pre-archive path', () => {
  const root = mkdtempSync(join(tmpdir(), 'touch-self-path-'));
  try {
    const change = join(root, 'openspec', 'changes', 'demo-change');
    mkdirSync(change, { recursive: true });
    writeFileSync(
      join(change, 'proposal-mini.md'),
      [
        '## Touch',
        '',
        '| 檔案 | 類別 | 動作 | Requirement |',
        '|---|---|---|---|',
        '| `openspec/changes/demo-change/proposal-mini.md` | openspec | modify | R1 |',
        '',
      ].join('\n'),
      'utf8',
    );
    const result = lintProposalTouchSelfPath({ changeFolder: change });
    assert.equal(result.pass, false);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0].detail, /archive\/<YYYY-MM-DD>-demo-change/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Scenario: Active Touch row uses dated-archive shape or placeholder date', () => {
  const root = mkdtempSync(join(tmpdir(), 'touch-self-path-ok-'));
  try {
    const change = join(root, 'openspec', 'changes', 'demo-change');
    mkdirSync(change, { recursive: true });
    writeFileSync(
      join(change, 'proposal-mini.md'),
      [
        '## Touch',
        '',
        '| 檔案 | 類別 | 動作 | Requirement |',
        '|---|---|---|---|',
        '| `openspec/changes/archive/<YYYY-MM-DD>-demo-change/proposal-mini.md` | openspec | add | R1 |',
        '| `.devpro/scripts/x.mjs` | code | modify | R1 |',
        '',
      ].join('\n'),
      'utf8',
    );
    const result = lintProposalTouchSelfPath({ changeFolder: change });
    assert.equal(result.pass, true, JSON.stringify(result));
    assert.deepEqual(result.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function touchTable(path) {
  return ['## Touch', '', '| 檔案 | 類別 | 動作 | Requirement |', '|---|---|---|---|', `| \`${path}\` | openspec | modify | R1 |`, ''].join('\n');
}

test('Scenario: Active change whose name merely starts with archive is linted, not refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'touch-self-path-archive-prefix-'));
  try {
    const change = join(root, 'openspec', 'changes', 'archive-tooling-cleanup');
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, 'proposal-mini.md'), touchTable('openspec/changes/archive-tooling-cleanup/proposal-mini.md'), 'utf8');
    const flagged = lintProposalTouchSelfPath({ changeFolder: change });
    assert.equal(flagged.error, undefined, JSON.stringify(flagged));
    assert.equal(flagged.pass, false);
    assert.equal(flagged.violations.length, 1);
    writeFileSync(join(change, 'proposal-mini.md'), touchTable('openspec/changes/archive/<YYYY-MM-DD>-archive-tooling-cleanup/proposal-mini.md'), 'utf8');
    const clean = lintProposalTouchSelfPath({ changeFolder: change });
    assert.equal(clean.error, undefined, JSON.stringify(clean));
    assert.equal(clean.pass, true, JSON.stringify(clean));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Scenario: A folder under openspec/changes/archive is still refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'touch-self-path-archived-'));
  try {
    const change = join(root, 'openspec', 'changes', 'archive', '2026-10-06-demo-change');
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, 'proposal-mini.md'), touchTable('openspec/changes/demo-change/proposal-mini.md'), 'utf8');
    const result = lintProposalTouchSelfPath({ changeFolder: change });
    assert.equal(result.pass, false);
    assert.match(result.error, /ACTIVE openspec\/changes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
