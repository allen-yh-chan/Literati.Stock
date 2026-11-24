import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-archive-gate.mjs'
);
const CARRIER = '.devpro/agent-rules/fixture.md';
const tmpRoot = makeTempDir('objective-readability-test-');

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const LEGACY_MANUAL_EVIDENCE =
  '## Token Budget Check\n\n' +
  '| 檔案 | 估算後 token | 占用率 | 決策 |\n' +
  '|---|---:|---:|---|\n' +
  '| fixture.md | 1 | 1% | below threshold |\n\n' +
  '> **Readability Precheck — `fixture.md` `1%`**\n' +
  '> - **(1) 執行順序**：manual claim\n' +
  '> - **(2) 失敗處理 / stop-condition**：manual claim\n' +
  '> - **(3) 分岔選項與各自條件**：manual claim\n' +
  '> - **判定**：manual semantic verdict\n';

const BASE_PROPOSAL =
  '# Proposal: fixture\n\n' +
  '## Why\n\nobjective carrier fixture\n\n' +
  '## What Changes\n\nmeasure the actual carrier\n';

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function setupFixture({ carrierBytes, proposalBody = BASE_PROPOSAL, isBmini = false }) {
  const dir = mkdtempSync(path.join(tmpRoot, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'remote', 'add', 'origin', 'https://example.invalid/devpro-agent-rules.git');

  mkdirSync(path.join(dir, '.devpro/scripts'), { recursive: true });
  mkdirSync(path.join(dir, '.devpro/agent-rules'), { recursive: true });
  writeFileSync(path.join(dir, '.devpro/scripts/pre-pr-archive-gate.mjs'), '// source sentinel\n');
  writeFileSync(path.join(dir, '.devpro/agent-rules/rule-audit-playbook.md'), '# source sentinel\n');
  writeFileSync(path.join(dir, 'README.md'), 'fixture baseline\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture baseline');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  const archiveDir = path.join(dir, 'openspec/changes/archive/2026-07-18-objective-readability');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(path.join(archiveDir, isBmini ? 'proposal-mini.md' : 'proposal.md'), proposalBody);
  writeFileSync(path.join(dir, CARRIER), `# fixture\n${'x'.repeat(carrierBytes)}`);
  return dir;
}

function run(fixtureDir) {
  return spawnSync('node', [GATE, fixtureDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVPRO_DIFF_ACTIVE_CHANGES: '',
      DEVPRO_RELEVANT_ARCHIVES: '',
      DEVPRO_PR_TOUCHED_RULE_FILES: CARRIER,
    },
  });
}

function objectiveRecord(stdout) {
  return stdout.split('\n').find((line) => line.startsWith(`rule-token-budget path=${CARRIER};`)) || '';
}

test('legacy proposal token/readability prose is inert; a missing manual block does not fail', () => {
  const dir = setupFixture({ carrierBytes: 4_400, proposalBody: BASE_PROPOSAL + LEGACY_MANUAL_EVIDENCE });
  const result = run(dir);
  assert.equal(result.status, 0, `objective measurement should pass: ${result.stderr}`);
  assert.match(objectiveRecord(result.stdout), /utilization=8\d(?:\.\d{1,2})?;/);
  assert.match(objectiveRecord(result.stdout), /semanticReview=required/);
  assert.doesNotMatch(result.stderr, /Readability Precheck|\(r\)/);
});

test('proposal/manual claims cannot create a machine semantic-review signal', () => {
  const misleadingProposal = (BASE_PROPOSAL + LEGACY_MANUAL_EVIDENCE)
    .replaceAll('1%', '99%')
    .replace('below threshold', 'over cap');
  const dir = setupFixture({ carrierBytes: 900, proposalBody: misleadingProposal });
  const result = run(dir);
  assert.equal(result.status, 0, `low-utilization carrier should pass: ${result.stderr}`);
  assert.match(objectiveRecord(result.stdout), /semanticReview=not-triggered/);
  assert.doesNotMatch(objectiveRecord(result.stdout), /semanticReview=required/);
});

test('artifact type and B-mini classification do not change objective actual-carrier evidence', () => {
  const full = run(setupFixture({ carrierBytes: 4_400, proposalBody: BASE_PROPOSAL }));
  const mini = run(setupFixture({ carrierBytes: 4_400, proposalBody: '# Proposal Mini\n', isBmini: true }));
  assert.equal(full.status, 0, `full proposal fixture should pass: ${full.stderr}`);
  assert.equal(mini.status, 0, `B-mini fixture should pass: ${mini.stderr}`);
  assert.equal(objectiveRecord(full.stdout), objectiveRecord(mini.stdout));
  assert.match(objectiveRecord(full.stdout), /semanticReview=required/);
  assert.doesNotMatch(objectiveRecord(full.stdout), /semanticVerdict=/);
});
