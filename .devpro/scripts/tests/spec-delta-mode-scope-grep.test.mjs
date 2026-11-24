import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { sourcePath } from './lib/source-root.mjs';
import { readSourceFile as read } from './lib/read.mjs';



function readIfExists(rel) {
  const file = sourcePath(rel);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function readSpecDeltaModeScope() {
  const active = readIfExists('openspec/changes/strengthen-spec-delta-mode-scope/specs/openspec-flow/spec.md');
  if (active) return active;
  const archiveDir = sourcePath('openspec/changes/archive');
  if (!existsSync(archiveDir)) return '';
  const match = readdirSync(archiveDir).filter((d) => d.endsWith('-strengthen-spec-delta-mode-scope')).sort().pop();
  if (!match) return '';
  return readIfExists(`openspec/changes/archive/${match}/specs/openspec-flow/spec.md`);
}

const qualityFormats = read('.devpro/agent-rules/openspec-quality-and-formats.md');
const deltaPitfalls = read('.devpro/agent-rules/openspec-spec-delta-pitfalls.md');
const canonicalSpec = read('openspec/specs/openspec-flow/spec.md');
const delta = readSpecDeltaModeScope();

// Group 1: the on-demand pitfalls leaf carries the bullet anchors; the entry keeps the mandatory pointer
test('spec delta pitfalls leaf contains Scope-shift scenario check anchors', () => {
  for (const phrase of [
    'Scope-shift scenario 語意 check',
    '不驗「保留的 scenario 在新 mode 下語意是否 over-broad」',
    '總括 mode-scope 聲明',
    '免逐句 qualify',
    'grep guard 對 promoted delta 的 no-op 陷阱',
    'delta-only anchor',
    '確保 guard 真 exercise delta path',
  ]) {
    assert.ok(deltaPitfalls.includes(phrase), `openspec-spec-delta-pitfalls.md missing: ${phrase}`);
  }
  for (const phrase of [
    'single-mode／single-scope requirement 抽象成 multi-mode',
    'static grep guard 斷言已 promoted 的 delta',
    'MUST 先讀 `openspec-spec-delta-pitfalls.md`',
  ]) {
    assert.ok(qualityFormats.includes(phrase), `openspec-quality-and-formats.md missing pointer: ${phrase}`);
  }
});

// Group 2: spec delta contains ADDED requirement + scenarios
test('spec delta contains ADDED Requirement and all three scenarios', () => {
  for (const phrase of [
    'Requirement: Spec Delta Mode-Scope Authoring',
    'Scenario: Preserved scenarios are checked for mode-scope over-broadness',
    'Scenario: Requirement-level mode-scope declaration covers all scenarios',
    'Scenario: Grep guard exercises the delta path, not just the promoted canonical',
  ]) {
    assert.ok(delta.includes(phrase), `spec delta missing: ${phrase}`);
  }
});

// Group 3: dogfood delta-only anchor guard
test('delta is non-empty and contains delta-only anchor absent from canonical', () => {
  assert.ok(delta.length > 0, 'delta must be non-empty (active or archived path should resolve)');

  const deltaAnchor = '# openspec-flow Delta: Spec Delta Mode-Scope Authoring';
  assert.ok(delta.includes(deltaAnchor), `delta missing delta-only anchor: ${deltaAnchor}`);
  assert.ok(
    !canonicalSpec.includes(deltaAnchor),
    'anchor must be delta-only: found in canonical spec, which means guard is a no-op',
  );
});
