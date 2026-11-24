// #3529: a consumer rules-lane sync PR (head rules/<whitelisted-source>-v<X.Y.Z>, the shape the
// cross-model branch-pattern exemption accepts) ships no deployable change and has no proposal
// ledger, so the PR create gates treat the DEV deploy-verify line and ## Requirement Ledger
// Completion as N/A. Every other head, a non-whitelisted or malformed rules head, an unreadable
// whitelist and an unresolved PR target still need both.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(SCRIPTS, 'hooks/pre-tool-gate.mjs');
const LINT = path.join(SCRIPTS, 'pre-pr-body-template-check.mjs');
// The real preflight checklist: its rules source whitelist names `agent-rules`, and the other gates read it too.
const WHITELIST = readFileSync(path.resolve(SCRIPTS, '../agent-rules/preflight-checklist.md'), 'utf8');
const RULES_HEAD = 'rules/agent-rules-v7.11.0';
const OTHER_HEADS = ['chore/sync-rules', 'rules/other-source-v7.11.0', 'rules/agent-rules-v7.11'];
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const tempDir = (prefix) => { const dir = makeTempDir(prefix); roots.push(dir); return dir; };
const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A consumer checkout (installed rules plus an origin) with the rules source whitelist committed,
// checked out on `branch`; origin/main and origin/<branch> are local refs so nothing asks the network.
function consumerRepo(branch, { whitelist = WHITELIST } = {}) {
  const repo = tempDir('rules-lane-pr-body-');
  git(repo, ['init', '-q', '-b', 'main']);
  const installed = path.join(repo, '.devpro-agent-rules');
  mkdirSync(path.join(installed, '.devpro/scripts'), { recursive: true });
  writeFileSync(path.join(installed, 'AGENTS.md'), 'consumer rules');
  writeFileSync(path.join(installed, '.devpro/scripts/sync-agent-rules.mjs'), 'consumer rules');
  if (whitelist !== null) {
    mkdirSync(path.join(repo, '.devpro/agent-rules'), { recursive: true });
    writeFileSync(path.join(repo, '.devpro/agent-rules/preflight-checklist.md'), whitelist);
  }
  git(repo, ['remote', 'add', 'origin', 'https://example.invalid/consumer.git']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--no-verify', '-m', 'base']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', branch]);
  writeFileSync(path.join(repo, 'AGENTS.md'), 'synced rules\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--no-verify', '-m', 'sync rules']);
  git(repo, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD']);
  return repo;
}

// A rules sync PR body as a TL writes it: no DEV deploy-verify line and no Requirement Ledger section.
function syncBody({ dev = null, ledger = false } = {}) {
  return [
    '## OpenSpec', '- N/A: rules sync', '',
    '## Change Context', '- 改什麼：sync devpro-agent-rules', '- 目的：adopt the released rules', '',
    '## Manual Test', '- N/A: rules sync, no user interface', '',
    ...(ledger ? ['## Requirement Ledger Completion', '- N/A: rules sync', ''] : []),
    '## Test Evidence', '- 驗收證據：sync check and smoke passed', ...(dev ? [dev] : []), '',
    '## Scenario Walkthrough', '- Status: N/A (non-enforcement-carrier change)', '',
    '## Cost Circuit Breaker Overrides', '- N/A', '',
  ].join('\n');
}

function bodyFile(text) {
  const file = path.join(tempDir('rules-lane-body-'), 'body.md');
  writeFileSync(file, text);
  return file;
}

function lint(repo, text, args = []) {
  return spawnSync('node', [LINT, '--body-file', bodyFile(text), '--cwd', repo, ...args], { encoding: 'utf8', cwd: repo });
}

function hook(repo, text, { level = 'lite', flags = '' } = {}) {
  const command = `gh pr create --base main --title "chore: sync rules" ${flags} --body-file ${bodyFile(text)}`;
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { cwd: repo, command } }),
    encoding: 'utf8',
    env: { ...process.env, CODEX_CI: '', CODEX_THREAD_ID: '', DEVPRO_SENTINEL_STATE_DIR: tempDir('rules-lane-sentinel-'), DEVPRO_AGENT_RULES_LEVEL: level },
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* no decision printed */ }
  return { ...result, json };
}

const assertLedgerRequired = (r, label) => {
  assert.equal(r.status, 1, `${label}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /## Requirement Ledger Completion/, label);
};

// [Scenario: openspec-flow :: A rules-lane sync pull request needs neither the DEV line nor the Requirement Ledger section]
test('PR body lint: a rules-lane sync head does not need ## Requirement Ledger Completion and says why', () => {
  const repo = consumerRepo(RULES_HEAD);
  for (const args of [[], ['--branch', RULES_HEAD], ['--pr-head', RULES_HEAD], ['--pr-cwd', repo, '--pr-head', RULES_HEAD, '--pr-base', 'main']]) {
    const r = lint(repo, syncBody(), args);
    assert.equal(r.status, 0, `${args.join(' ')}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /Requirement Ledger Completion: N\/A \(rules lane sync PR rules\/agent-rules-v7\.11\.0\)/, args.join(' '));
  }
  // A body that still carries the section keeps passing.
  assert.equal(lint(repo, syncBody({ ledger: true })).status, 0);
});

test('PR body lint: every other head, an unreadable whitelist and an unresolved PR target still need the section', () => {
  for (const head of OTHER_HEADS) assertLedgerRequired(lint(consumerRepo(head), syncBody()), head);
  // The PR head decides, not the branch the lint happens to run on.
  assertLedgerRequired(lint(consumerRepo(RULES_HEAD), syncBody(), ['--pr-head', 'chore/sync-rules']), 'rules checkout, other --pr-head');
  assertLedgerRequired(lint(consumerRepo(RULES_HEAD, { whitelist: null }), syncBody()), 'whitelist file missing');
  assertLedgerRequired(lint(consumerRepo(RULES_HEAD, { whitelist: WHITELIST.replace('<!-- rules-source-whitelist:start -->', '') }), syncBody()), 'whitelist markers missing');
  assertLedgerRequired(lint(consumerRepo(RULES_HEAD), syncBody(), ['--pr-head', RULES_HEAD, '--pr-target-unresolved']), 'unresolved PR target');
});

// [Scenario: openspec-flow :: A rules-lane sync pull request needs neither the DEV line nor the Requirement Ledger section]
test('PR create hook: a rules-lane sync head needs neither the DEV line nor the Requirement Ledger section', () => {
  const repo = consumerRepo(RULES_HEAD);
  for (const level of ['lite', 'full']) {
    for (const flags of ['', `--head ${RULES_HEAD}`]) {
      const r = hook(repo, syncBody(), { level, flags });
      assert.notEqual(r.json?.decision, 'block', `${level} ${flags}\n${r.stdout}`);
    }
  }
});

test('PR create hook: every other head and an unreadable whitelist still need the DEV line', () => {
  const sha = 'c'.repeat(40);
  for (const [label, repo] of [
    ...OTHER_HEADS.map((head) => [head, consumerRepo(head)]),
    ['whitelist file missing', consumerRepo(RULES_HEAD, { whitelist: null })],
  ]) {
    const r = hook(repo, syncBody({ ledger: true }));
    assert.equal(r.json?.decision, 'block', `${label}\n${r.stdout}`);
    assert.match(r.json.reason, /^DEV deploy-verify gate: /, label);
    // With the line the same body passes, so the block above is the DEV line alone.
    const ok = hook(repo, syncBody({ ledger: true, dev: `- DEV deploy-verify: HEAD ${sha}; N/A: rules sync` }));
    assert.notEqual(ok.json?.decision, 'block', `${label} with DEV line\n${ok.stdout}`);
  }
});
