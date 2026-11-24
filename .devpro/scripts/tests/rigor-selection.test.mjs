import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { resolveRigorSelection, evaluateRigorUpgrade } from '../hooks/lib/rigor-level.mjs';

test('absence selects lite while explicit full and malformed settings remain distinguishable', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rigor-selection-'));
  try {
    assert.deepEqual(resolveRigorSelection({ cwd: dir, env: {} }), { level: 'lite', source: 'default', valid: true });
    assert.deepEqual(resolveRigorSelection({ cwd: dir, env: { DEVPRO_AGENT_RULES_LEVEL: 'full' } }), { level: 'full', source: 'environment', valid: true });
    mkdirSync(path.join(dir, '.devpro'));
    writeFileSync(path.join(dir, '.devpro/rules.config'), '# comments only\n');
    assert.equal(resolveRigorSelection({ cwd: dir, env: {} }).level, 'lite');
    writeFileSync(path.join(dir, '.devpro/rules.config'), 'agent_rules_level=ful\n');
    assert.deepEqual(resolveRigorSelection({ cwd: dir, env: {} }), { level: 'full', source: 'config', valid: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unresolved repository and unreadable present config select protective full without upgrade consent', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rigor-invalid-source-'));
  const invalid = { level: 'full', source: 'repository', valid: false };
  try {
    assert.deepEqual(resolveRigorSelection({ cwd: path.join(dir, 'missing'), env: {} }), invalid);
    writeFileSync(path.join(dir, 'file'), 'not a root');
    assert.deepEqual(resolveRigorSelection({ cwd: path.join(dir, 'file'), env: {} }), invalid);
    assert.deepEqual(resolveRigorSelection({ cwd: path.join(dir, 'missing'), env: { DEVPRO_AGENT_RULES_LEVEL: 'lite' } }), { level: 'lite', source: 'environment', valid: true });
    mkdirSync(path.join(dir, '.devpro/rules.config'), { recursive: true });
    const unreadable = resolveRigorSelection({ cwd: dir, env: {} });
    assert.deepEqual(unreadable, { level: 'full', source: 'config', valid: false });
    assert.equal(evaluateRigorUpgrade({ selection: unreadable, reason: 'B-shaped', userApproved: true }).allowed, false);
    rmSync(path.join(dir, '.devpro/rules.config'), { recursive: true });
    symlinkSync(path.join(dir, 'absent-target'), path.join(dir, '.devpro/rules.config'));
    assert.deepEqual(resolveRigorSelection({ cwd: dir, env: {} }), { level: 'full', source: 'config', valid: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unrecognized config does not imply full, while an empty recognized value is invalid', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rigor-recognized-key-'));
  try {
    mkdirSync(path.join(dir, '.devpro'));
    for (const raw of ['', '# comment\n', 'future_key=full\n', 'full\n']) {
      writeFileSync(path.join(dir, '.devpro/rules.config'), raw);
      assert.deepEqual(resolveRigorSelection({ cwd: dir, env: {} }), { level: 'lite', source: 'default', valid: true }, raw);
    }
    writeFileSync(path.join(dir, '.devpro/rules.config'), 'agent_rules_level=\n');
    assert.deepEqual(resolveRigorSelection({ cwd: dir, env: {} }), { level: 'full', source: 'config', valid: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('production lookup derives installed repository root even when execution cwd is nested', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rigor-installed-root-'));
  try {
    const lib = path.join(dir, '.devpro/scripts/hooks/lib/rigor-level.mjs');
    mkdirSync(path.dirname(lib), { recursive: true });
    mkdirSync(path.join(dir, 'nested/deeper'), { recursive: true });
    copyFileSync(new URL('../hooks/lib/rigor-level.mjs', import.meta.url), lib);
    writeFileSync(path.join(dir, '.devpro/rules.config'), 'agent_rules_level=full\n');
    const env = { ...process.env }; delete env.DEVPRO_AGENT_RULES_LEVEL;
    const script = `import { resolveRigorSelection } from ${JSON.stringify(pathToFileURL(lib).href)}; process.stdout.write(JSON.stringify(resolveRigorSelection()));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: path.join(dir, 'nested/deeper'), env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { level: 'full', source: 'config', valid: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a B-shaped change cannot authorize a rigor upgrade; reason and user consent are both required', () => {
  const selection = { level: 'lite', source: 'default', valid: true };
  assert.equal(evaluateRigorUpgrade({ selection, changeShape: 'B' }).allowed, false);
  assert.equal(evaluateRigorUpgrade({ selection, reason: 'Requires an independently reviewed design' }).allowed, false);
  assert.equal(evaluateRigorUpgrade({ selection, userApproved: true }).allowed, false);
  assert.equal(evaluateRigorUpgrade({ selection, reason: 'Requires an independently reviewed design', userApproved: true }).allowed, true);
  assert.equal(evaluateRigorUpgrade({ selection: { level: 'full', source: 'environment', valid: true } }).allowed, true);
  assert.equal(evaluateRigorUpgrade({ selection: { level: 'full', source: 'config', valid: false } }).allowed, false);
});

test('workflow action points require rigor selection and consent before full work', () => {
  const root = new URL('../../../', import.meta.url);
  for (const file of [
    '.devpro/agent-skills/devpro-workflows/change/SKILL.md',
    '.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md',
    '.devpro/agent-skills/openspec/openspec-artifact-authoring/SKILL.md',
    '.devpro/agent-rules/openspec-step-1-to-9.md',
    '.devpro/agent-rules/openspec-branch-routing.md',
  ]) {
    const lines = readFileSync(new URL(file, root), 'utf8').split('\n');
    assert.ok(lines.some((line) => /MUST 先(?:載入|依|讀).*rules-rigor-level\.md/.test(line)
      && /預設 lite/.test(line) && /級別及來源|rigor 及來源/.test(line)
      && /升 full/.test(line) && /使用者.*同意|使用者授權/.test(line)),
    `${file}: decision and consent must be co-located at the workflow entry`);
  }
  const rule = readFileSync(new URL('.devpro/agent-rules/rules-rigor-level.md', root), 'utf8');
  const consent = rule.split('\n').find((line) => /^3\. 從 lite\/off 升 full，MUST 在/.test(line));
  assert.ok(consent, 'consent must precede full workflow execution, with positive MUST polarity');
  assert.match(consent, /執行 full 流程前取得使用者明確同意/);
  assert.match(consent, /Implement the plan.*git\/PR batch approval.*沉默與超時，MUST NOT 當作 rigor 升級同意/);
});
