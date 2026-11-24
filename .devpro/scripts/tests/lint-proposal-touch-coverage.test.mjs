import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, renameSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './lib/tmp.mjs';
import { lintProposalTouchCoverage } from '../lint-proposal-touch-coverage.mjs';

function fixture(run) {
  const root = makeTempDir('touch-coverage-');
  const folder = join(root, 'openspec/changes/fixture');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  const write = (path, body = 'fixture\n') => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const touch = (paths, carrier = 'proposal.md', prefix = '') => write(`openspec/changes/fixture/${carrier}`,
    prefix + '## Section 2: Touch\n\n| Path | Category | Action | Requirement |\n|---|---|---|---|\n' +
    paths.map(p => `| \`${p}\` | code | edit | R1 |`).join('\n') + '\n\n## Next\n');
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    write('old name.mjs'); mkdirSync(folder, { recursive: true }); touch([]); commit();
    const base = git('rev-parse', 'HEAD');
    run({ root, folder, git, write, touch, commit, lint: () => lintProposalTouchCoverage({ changeFolder: folder, base }) });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('missing test and manifest paths fail with their names; complete table passes', () => fixture(f => {
  f.write('new test.test.mjs'); f.write('manifest.mjs'); f.commit();
  let r = f.lint(); assert.equal(r.pass, false);
  assert.deepEqual(r.violations.map(v => v.detail), [
    'changed file missing from Touch: manifest.mjs', 'changed file missing from Touch: new test.test.mjs']);
  f.touch(['new test.test.mjs', 'manifest.mjs']); assert.equal(f.lint().pass, true);
}));
test('rename requires both old and new paths, preserving spaces', () => fixture(f => {
  renameSync(join(f.root, 'old name.mjs'), join(f.root, 'new name.mjs')); f.commit();
  f.touch(['new name.mjs']); assert.equal(f.lint().pass, false);
  assert.match(f.lint().violations[0].detail, /old name/);
  f.touch(['old name.mjs', 'new name.mjs']); assert.equal(f.lint().pass, true);
}));
test('deletion requires the absent file in Touch', () => fixture(f => {
  rmSync(join(f.root, 'old name.mjs')); f.commit(); assert.equal(f.lint().pass, false);
  f.touch(['old name.mjs']); assert.equal(f.lint().pass, true);
}));
for (const row of ['src/', 'src', 'src/**', '../outside', '/absolute', './src/file.mjs']) {
  test(`ambiguous or non-relative Touch row blocks: ${row}`, () => fixture(f => {
    f.write('src/file.mjs'); f.commit(); f.touch([row]);
    const r = f.lint(); assert.equal(r.pass, false);
    assert.match(r.violations[0].detail, /expand to literal repo-relative files/);
  }));
}
test('only notes and change artifacts are exempt, including rename into notes', () => fixture(f => {
  f.write('notes/evidence.md'); f.write('openspec/changes/fixture/tasks.md'); f.commit();
  assert.equal(f.lint().pass, true);
  f.write('docs/guide.md'); f.commit(); assert.equal(f.lint().pass, false);
  f.touch(['docs/guide.md']); assert.equal(f.lint().pass, true);
  mkdirSync(join(f.root, 'notes/archive'), { recursive: true });
  renameSync(join(f.root, 'old name.mjs'), join(f.root, 'notes/archive/old name.mjs')); f.commit();
  assert.equal(f.lint().pass, false); f.touch(['docs/guide.md', 'old name.mjs']); assert.equal(f.lint().pass, true);
}));
test('B-mini uses the same gate; a no-proposal lite change is explicitly N/A', () => fixture(f => {
  rmSync(join(f.folder, 'proposal.md')); f.write('new.mjs'); f.commit();
  assert.match(f.lint().noop, /lite N\/A/);
  f.touch([], 'proposal-mini.md'); assert.equal(f.lint().pass, false);
  f.touch(['new.mjs'], 'proposal-mini.md'); assert.equal(f.lint().pass, true);
}));
test('paths in other sections cannot satisfy Touch; proposal priority matches SSOT', () => fixture(f => {
  f.write('new.mjs'); f.commit(); f.touch([], 'proposal.md', '## Other\n| `new.mjs` | code | edit | R1 |\n');
  f.touch(['new.mjs'], 'proposal-mini.md'); assert.equal(f.lint().pass, false);
  f.touch(['new.mjs']); assert.equal(f.lint().pass, true);
}));
test('missing and duplicate Touch sections fail by section-specific error', () => fixture(f => {
  f.write('new.mjs'); f.commit();
  f.write('openspec/changes/fixture/proposal.md', '# Proposal\n');
  assert.match(f.lint().error, /^exactly one Touch section required/);
  f.touch(['new.mjs']);
  const body = readFileSync(join(f.folder, 'proposal.md'), 'utf8');
  f.write('openspec/changes/fixture/proposal.md', body + '## Touch\n');
  assert.match(f.lint().error, /^exactly one Touch section required/);
}));
for (const row of ['| `new.mjs` | code | edit |', '| `new.mjs` | code | edit | |']) {
  test(`malformed Touch row names the four-cell failure: ${row}`, () => fixture(f => {
    f.write('new.mjs'); f.commit(); f.touch(['new.mjs']);
    const body = readFileSync(join(f.folder, 'proposal.md'), 'utf8');
    f.write('openspec/changes/fixture/proposal.md', body.replace('| `new.mjs` | code | edit | R1 |', row));
    assert.match(f.lint().error, /^Touch requires four non-empty table cells/);
  }));
}
for (const base of [undefined, '-invalid', 'does-not-exist']) {
  test(`invalid baseline is the only failing input: ${base}`, () => fixture(f => {
    f.write('new.mjs'); f.commit(); f.touch(['new.mjs']);
    assert.equal(f.lint().pass, true, 'control: complete valid table with resolvable base');
    const r = lintProposalTouchCoverage({ changeFolder: f.folder, base });
    assert.equal(r.pass, false);
    assert.match(r.error, base === 'does-not-exist' ? /^git collection failed:/ : /^--base .*required/);
  }));
}
test('explicit non-main target baseline excludes inherited paths', () => fixture(f => {
  f.write('inherited.mjs'); f.commit(); const base = f.git('rev-parse', 'HEAD');
  f.write('unit.mjs'); f.commit(); f.touch(['unit.mjs']);
  assert.equal(f.lint().pass, false);
  assert.equal(lintProposalTouchCoverage({ changeFolder: f.folder, base }).pass, true);
}));

test('fenced example Touch cannot claim coverage', () => fixture(f => {
  f.write('new.mjs'); f.commit();
  f.write('openspec/changes/fixture/proposal.md', '```markdown\n## Touch\n| Path | Category | Action | Requirement |\n|---|---|---|---|\n| `new.mjs` | code | edit | R1 |\n```\n');
  assert.equal(f.lint().pass, false);
}));

test('real archived full proposal keeps its literal four-column Touch syntax', t => {
  const sourceArchive = new URL('../../../openspec/changes/archive/2026-09-20-fix-cross-model-review-residues/proposal.md', import.meta.url);
  if (!existsSync(sourceArchive)) { t.skip('source-only archived proposal is not distributed to consumer checkouts'); return; }
  fixture(f => {
  const proposal = readFileSync(sourceArchive, 'utf8');
  f.write('openspec/specs/code-review-checklist/spec.md'); f.commit();
  f.write('openspec/changes/fixture/proposal.md', proposal);
  assert.equal(f.lint().pass, true);
  });
});
test('a deleted Git file replaced by a directory keeps its old identity', () => fixture(f => {
  rmSync(join(f.root, 'old name.mjs')); f.write('old name.mjs/child.mjs'); f.commit();
  f.touch(['old name.mjs', 'old name.mjs/child.mjs']); assert.equal(f.lint().pass, true);
}));
test('tracked directory symlink is an atomic Git path, not an aggregate row', t => fixture(f => {
  f.write('src/file.mjs');
  try { symlinkSync('src', join(f.root, 'dir-link'), 'dir'); }
  catch (error) { if (['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) { t.skip('native symlink unavailable'); return; } throw error; }
  f.commit(); f.touch(['src/file.mjs', 'dir-link']); assert.equal(f.lint().pass, true);
}));
test('a changed gitlink is an atomic Git path even when its checkout is a directory', () => fixture(f => {
  const commit = f.git('rev-parse', 'HEAD');
  mkdirSync(join(f.root, 'submodule-dir'));
  f.git('update-index', '--add', '--cacheinfo', `160000,${commit},submodule-dir`);
  f.git('commit', '-qm', 'gitlink fixture'); f.touch(['submodule-dir']);
  assert.equal(f.lint().pass, true);
}));

test('literal Next.js route brackets match exact Git paths without glob expansion', () => fixture(f => {
  f.write('app/[slug]/page.tsx'); f.commit();
  f.touch(['app/[slug]/page.tsx']); assert.equal(f.lint().pass, true);
  f.touch(['app/*/page.tsx']); assert.equal(f.lint().pass, false);
}));
