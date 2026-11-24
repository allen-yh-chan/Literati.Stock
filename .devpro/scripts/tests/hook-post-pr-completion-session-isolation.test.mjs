import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as state from '../hooks/lib/post-pr-completion-state.mjs';
import { resolveReminderSession } from '../hooks/lib/session-reminder.mjs';
import { repoPath } from './lib/repo-root.mjs';
import { makeTempDir } from './lib/tmp.mjs';
import { git } from './lib/git.mjs';

const root = makeTempDir('post-pr-session-isolation-');
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const session = (id) => resolveReminderSession({ session_id: id }, { DEVPRO_HOOK_HOST: 'codex' });
function fixture() {
  const cwd = path.join(root, String(counter++));
  mkdirSync(cwd);
  const dir = path.join(cwd, 'state');
  return { cwd, dir, diagnostic: path.join(cwd, 'diagnostic') };
}
function write(f, input = {}) {
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = f.dir;
  try { return state.writePostPrCompletionMarker({ cwd: f.cwd, prNumber: '42', branch: 'feature/owner', session: session('owner'), ...input }); }
  finally { if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous; }
}
function writeLegacy(f, { prNumber, url, repositorySlug = '' }) {
  const owner = session('owner');
  const file = path.join(f.dir, `pending-post-pr-completion-${prNumber}.json`);
  mkdirSync(f.dir, { recursive: true });
  writeFileSync(file, JSON.stringify({
    prNumber, url, branch: 'feature/owner', worktree: f.cwd, repository_slug: repositorySlug,
    authorityId: `legacy-${prNumber}`, createdAt: new Date().toISOString(),
    sessionId: owner.sessionId, sessionKey: owner.key, host: owner.host,
  }));
  return file;
}

test('Stop reports a duplicate instead of retiring only one authority on a merged PR', () => {
  const f = fixture();
  const input = { prNumber: '42', url: 'https://github.com/example-org/target/pull/42' };
  const keyed = write(f, input);
  const legacy = writeLegacy(f, input);
  const result = stop(f, 'owner', { DEVPRO_POST_PR_GATE_MOCK_STATE: '42:MERGED' });
  assert.equal(result.status, 2, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  const detailsPath = decision.reason.split('\n').find((line) => line.startsWith('Details: ')).slice('Details: '.length);
  assert.match(readFileSync(path.resolve(f.cwd, detailsPath), 'utf8'), /Inspect the keyed and legacy authorities/);
  assert.equal(existsSync(keyed), true);
  assert.equal(existsSync(legacy), true);
});
function stop(f, id, extra = {}) {
  const env = { ...process.env, DEVPRO_HOOK_HOST: 'codex', DEVPRO_POST_PR_COMPLETION_STATE_DIR: f.dir,
    DEVPRO_SESSION_REMINDER_STATE_DIR: f.diagnostic, DEVPRO_POST_PR_GATE_MOCK_STICKY: '',
    // The suite runner requires an isolated control-evidence root; without one the
    // hook reports an error and exits 0 instead of deciding (red under the runner only).
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(f.cwd, 'control-evidence'), ...extra };
  for (const key of ['DEVPRO_POST_PR_COMPLETION_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CONVERSATION_ID', 'DEVPRO_HOST_SESSION_ID']) delete env[key];
  const hook = repoPath('.devpro/scripts/hooks/post-pr-completion-check.mjs');
  const args = f.viaWrapper ? [repoPath('.devpro/scripts/hooks/run-hook.mjs'), 'Stop', hook, '--host=codex'] : [hook];
  if (f.viaWrapper) delete env.DEVPRO_AGENT_RULES_LEVEL;
  return spawnSync(process.execPath, args, {
    cwd: f.cwd, env, input: JSON.stringify(id ? { session_id: id } : {}), encoding: 'utf8',
  });
}

function offHub() {
  const f = { ...fixture(), viaWrapper: true };
  git(f.cwd, 'init', '-q', '-b', 'main');
  git(f.cwd, 'remote', 'add', 'origin', 'https://github.com/example-org/hub.git');
  mkdirSync(path.join(f.cwd, '.devpro'));
  writeFileSync(path.join(f.cwd, '.devpro', 'rules.config'), 'agent_rules_level=off\n');
  return f;
}

function recordWithOffHub(f, number, branch = 'feature/owner') {
  const url = `https://github.com/example-org/target/pull/${number}`;
  const result = spawnSync(process.execPath, [
    repoPath('.devpro/scripts/hooks/run-hook.mjs'), 'PostToolUse',
    repoPath('.devpro/scripts/hooks/post-tool-gate.mjs'), '--host=codex',
  ], {
    cwd: f.cwd,
    input: JSON.stringify({
      cwd: f.cwd, session_id: 'owner', tool_name: 'Bash',
      tool_input: { command: `gh pr create --repo example-org/target --head ${branch}` },
      tool_response: url,
    }),
    env: { ...process.env, DEVPRO_AGENT_RULES_LEVEL: 'off', DEVPRO_POST_PR_COMPLETION_STATE_DIR: f.dir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const [filename] = state.postPrMarkerFilenames({ repo: 'example-org/target', prNumber: number });
  const marker = path.join(f.dir, filename);
  assert.equal(readFileSync(marker, 'utf8').includes(url), true);
  return marker;
}

test('hub off launches Stop only for an owned marker in another GitHub repository', () => {
  const f = offHub();

  const local = write(f, { prNumber: '51', url: 'https://github.com/example-org/hub/pull/51' });
  const foreignOwner = write(f, { prNumber: '52', repositorySlug: 'example-org/target', session: session('other') });
  const ambiguous = writeLegacy(f, { prNumber: '53', repositorySlug: 'example-org/target', url: 'https://github.com/example-org/hub/pull/53' });
  const enterprise = writeLegacy(f, { prNumber: '54', url: 'https://ghe.example.org/example-org/target/pull/54' });
  const localOnly = stop(f, 'owner', { DEVPRO_POST_PR_GATE_MOCK_STICKY: '51,52,53,54' });
  assert.equal(localOnly.status, 0, localOnly.stderr);
  assert.equal(localOnly.stdout, '');
  assert.equal(localOnly.stderr, '');
  for (const file of [local, foreignOwner, ambiguous, enterprise]) assert.equal(existsSync(file), true);

  const target = recordWithOffHub(f, '55');
  const pending = stop(f, 'owner');
  assert.equal(pending.status, 0, pending.stderr);
  const decision = JSON.parse(pending.stdout);
  assert.equal(decision.decision, 'block');
  const details = readFileSync(path.resolve(f.cwd, decision.reason.split('\n')[2].slice('Details: '.length)), 'utf8');
  assert.match(details, /example-org\/target\/pull\/55/);
  assert.doesNotMatch(details, /PR #(?:51|52|53|54)\b/);

  const otherTarget = write(f, { prNumber: '56', url: 'https://github.com/example-org/second/pull/56' });
  const completed = stop(f, 'owner', { DEVPRO_POST_PR_GATE_MOCK_STICKY: '51,53,54,55' });
  assert.equal(completed.status, 0, completed.stderr);
  const stillPending = JSON.parse(completed.stdout);
  assert.equal(stillPending.decision, 'block');
  const remainingDetails = readFileSync(path.resolve(f.cwd, stillPending.reason.split('\n')[2].slice('Details: '.length)), 'utf8');
  assert.match(remainingDetails, /example-org\/second\/pull\/56/);
  assert.doesNotMatch(remainingDetails, /PR #55\b/);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(otherTarget), true);
  for (const file of [local, foreignOwner, ambiguous, enterprise]) assert.equal(existsSync(file), true);
  assert.equal(stop(f, 'owner', { DEVPRO_POST_PR_GATE_MOCK_STICKY: '56' }).stdout, '');
  assert.equal(existsSync(otherTarget), false);
  assert.equal(stop(f, 'owner', { DEVPRO_POST_PR_GATE_MOCK_STICKY: '51,53,54' }).stdout, '');
});

test('hub off honors cross-repository branch and diff exemptions that need no checkout', () => {
  const f = offHub();
  const bump = recordWithOffHub(f, '58', 'chore/bump-v7.17.4');
  assert.equal(stop(f, 'owner', { DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: '58' }).stdout, '');
  assert.equal(existsSync(bump), false);

  const chore = recordWithOffHub(f, '59', 'chore/update-docs');
  const result = stop(f, 'owner', {
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: '59:chore/update-docs',
    DEVPRO_POST_PR_GATE_MOCK_FILES: '59:README.md',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(chore), false);
});

test('checkout-based exemptions bind to the recorded repo and the live Git location', () => {
  const hub = offHub();
  const target = fixture();
  git(target.cwd, 'init', '-q', '-b', 'main');
  git(target.cwd, 'remote', 'add', 'origin', 'https://github.com/example-org/target.git');
  const marker = { repository_slug: 'example-org/target', worktree: target.cwd };
  assert.equal(state.postPrMarkerCheckout(marker), target.cwd);
  assert.equal(state.postPrMarkerCheckout({ ...marker, worktree: hub.cwd }), '');

  const previous = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = path.join(hub.cwd, '.git');
    assert.equal(state.postPrMarkerCheckout(marker), '');
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

function ghFixture(f, script) {
  const bin = path.join(f.cwd, 'bin');
  const calls = path.join(f.cwd, 'gh-calls');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DEVPRO_TEST_GH_CALLS, JSON.stringify(args) + '\\n');
${script}
`, { mode: 0o755 });
  const options = {
    PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    GH_HOST: 'ghe.example.org',
    DEVPRO_TEST_GH_CALLS: calls,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: undefined,
  };
  if (process.platform === 'win32') {
    const shim = repoPath('.devpro/scripts/tests/lib/portable-command-shims.cjs');
    options.DEVPRO_TEST_PORTABLE_COMMAND_SHIMS = '1';
    options.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(shim)}`;
  }
  return { calls, options };
}

test('hub off queries a URL-only numbered marker on its explicit GitHub host', () => {
  const f = offHub();
  const { calls, options } = ghFixture(f, `
if (args[0] !== 'pr' || args[1] !== 'view' || args[2] !== '57' ||
    args[args.indexOf('-R') + 1] !== 'github.com/example-org/target') process.exit(1);
console.log(JSON.stringify({
  number: 57, state: 'MERGED', url: 'https://github.com/example-org/target/pull/57',
  headRefName: 'feature/owner', comments: []
}));`);
  const marker = write(f, { prNumber: '57', url: 'https://github.com/example-org/target/pull/57' });
  const result = stop(f, 'owner', options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const argv = JSON.parse(readFileSync(calls, 'utf8').trim());
  assert.deepEqual(argv.slice(0, 5), ['pr', 'view', '57', '-R', 'github.com/example-org/target']);
  assert.equal(existsSync(marker), false);
});

test('Stop compares a stale sticky on the verified PR host even if GH_HOST differs', () => {
  const markerUrl = 'https://github.com/example-org/target/pull/60';
  const reviewed = 'a'.repeat(40);
  const current = 'b'.repeat(40);
  const comment = [
    '<!-- cross-model-second-opinion:sticky -->',
    'verdict: PASS', `last_reviewed_sha: ${reviewed}`, 'dispatch_id: fixture-dispatch',
    'reason: fixture', 'Rules: v7.17.3 · Tool: Codex · Model: fixture',
  ].join('\n');
  const target = { recordedUrl: markerUrl, expectedSlug: 'example-org/target' };
  const hub = { recordedUrl: '', expectedSlug: 'example-org/hub' };
  const wrongHostUrl = 'https://ghe.example.org/example-org/target/pull/60';
  const wrongRepoUrl = 'https://github.com/example-org/another/pull/60';
  for (const { level = 'lite', returnedUrl, repositorySlug = '', shouldCompare = false, markerIdentity = target } of [
    { level: 'off', returnedUrl: markerUrl, repositorySlug: 'example-org/target', shouldCompare: true },
    { returnedUrl: markerUrl, shouldCompare: true },
    { level: 'off', returnedUrl: wrongHostUrl, repositorySlug: 'example-org/target' },
    { returnedUrl: wrongRepoUrl, repositorySlug: 'example-org/target' },
    { returnedUrl: wrongRepoUrl },
    { returnedUrl: '' },
    { returnedUrl: markerUrl, markerIdentity: hub },
    { returnedUrl: 'https://github.com/example-org/hub/pull/60', markerIdentity: hub, shouldCompare: true },
    { returnedUrl: wrongHostUrl, markerIdentity: hub },
  ]) {
    const f = offHub();
    writeFileSync(path.join(f.cwd, '.devpro', 'rules.config'), `agent_rules_level=${level}\n`);
    const { recordedUrl, expectedSlug } = markerIdentity;
    const input = { prNumber: '60', url: recordedUrl, repositorySlug };
    const marker = recordedUrl ? write(f, input) : writeLegacy(f, input);
    const expectedCompare = ['api', '--hostname', 'github.com', `repos/${expectedSlug}/compare/${reviewed}...${current}`];
    const { calls, options } = ghFixture(f, `
if (args[0] === 'pr' && args[1] === 'view' && args[2] === '60') {
  console.log(JSON.stringify({
    number: 60, url: ${JSON.stringify(returnedUrl)}, state: 'OPEN',
    headRefName: 'feature/owner', headRefOid: ${JSON.stringify(current)}, comments: [{ body: ${JSON.stringify(comment)} }],
  }));
} else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(expectedCompare))}) {
  console.log(JSON.stringify({ status: 'ahead', files: [{ filename: 'notes/example.md' }] }));
} else {
  process.exit(1);
}`);
    const result = stop(f, 'owner', options);
    assert.equal(result.status, 0, result.stderr);
    const invocations = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(invocations[0].slice(0, 5), ['pr', 'view', '60', '-R', `github.com/${expectedSlug}`]);
    assert.deepEqual(invocations.filter(([verb]) => verb === 'api'), shouldCompare ? [expectedCompare] : []);
    assert.equal(existsSync(marker), !shouldCompare, result.stdout);
  }
});
function supervisorFailure(f, id) {
  const wrapper = path.join(f.cwd, 'supervisor-failure.mjs');
  if (!existsSync(wrapper)) writeFileSync(wrapper, `import { superviseStopRun } from ${JSON.stringify(pathToFileURL(repoPath('.devpro/scripts/hooks/lib/stop-run-supervisor.mjs')).href)};
    superviseStopRun({ spawnSyncImpl: () => ({ error: { code: 'EAGAIN' }, status: null }) });`);
  const env = { ...process.env, DEVPRO_HOOK_HOST: 'codex', DEVPRO_POST_PR_COMPLETION_STATE_DIR: f.dir,
    DEVPRO_SESSION_REMINDER_STATE_DIR: f.diagnostic, DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR: path.join(f.cwd, 'clock') };
  for (const key of ['DEVPRO_POST_PR_COMPLETION_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CONVERSATION_ID', 'DEVPRO_HOST_SESSION_ID']) delete env[key];
  return spawnSync(process.execPath, [wrapper], { cwd: f.cwd, env,
    input: JSON.stringify(id ? { session_id: id } : {}), encoding: 'utf8' });
}
test('foreign session on the same work line is silent and preserves authority bytes and mtime', () => {
  const f = fixture(); const file = write(f); const bytes = readFileSync(file, 'utf8');
  const old = new Date(Date.now() - 3 * 60 * 60_000); utimesSync(file, old, old);
  const mtime = statSync(file).mtimeMs;
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'feature/owner'], { cwd: f.cwd }).status, 0);
  const result = stop(f, 'foreign');
  assert.equal(result.status, 0); assert.equal(result.stdout, '');
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(statSync(file).mtimeMs, mtime);
});
test('missing identity stays silent and does not adopt a marker', () => {
  const f = fixture(); const file = write(f); const bytes = readFileSync(file, 'utf8');
  const result = stop(f, '');
  assert.equal(result.status, 0); assert.equal(result.stdout, '');
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.match(result.stderr, /session identity/i);
});
test('owner hard-blocks with three-line details, resumes softly and never mutates shared authority', () => {
  const f = fixture(); const file = write(f); const bytes = readFileSync(file, 'utf8');
  const first = stop(f, 'owner'); assert.equal(first.status, 2);
  const reason = JSON.parse(first.stdout).reason;
  assert.equal(reason.split('\n').length, 3);
  assert.match(readFileSync(path.resolve(f.cwd, reason.split('\n')[2].slice('Details: '.length)), 'utf8'), /Post-PR completion gate hard-block/);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  const second = stop(f, 'owner'); assert.equal(second.status, 0);
  assert.equal(JSON.parse(second.stdout).systemMessage.split('\n').length, 3);
});
test('repeated writer subscribes independently without stealing creator or binding', () => {
  const f = fixture(); const file = write(f, { expectedDispatchId: 'dispatch-original' });
  const bytes = readFileSync(file, 'utf8');
  assert.equal(stop(f, 'owner').status, 2);
  write(f, { session: session('adopter'), expectedDispatchId: 'dispatch-other' });
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(stop(f, 'adopter').status, 2);
  assert.equal(stop(f, 'owner').status, 0);
});
test('explicit adoption registers legacy authority without rewriting it', () => {
  const f = fixture(); const file = write(f, { session: null, sessionId: '' });
  const bytes = readFileSync(file, 'utf8');
  assert.equal(stop(f, 'owner').stdout, '');
  assert.equal(typeof state.adoptPostPrCompletionMarker, 'function');
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = f.dir;
  try { state.adoptPostPrCompletionMarker({ cwd: f.cwd, prNumber: '42', session: session('owner') }); }
  finally { if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous; }
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(stop(f, 'owner').status, 2);
});
test('verified owner evidence clears shared authority while foreign Stop cannot', () => {
  const f = fixture(); const file = write(f);
  assert.equal(stop(f, 'foreign', { DEVPRO_POST_PR_GATE_MOCK_STICKY: '42' }).stdout, '');
  assert.equal(existsSync(file), true);
  assert.equal(stop(f, 'owner', { DEVPRO_POST_PR_GATE_MOCK_STICKY: '42' }).status, 0);
  assert.equal(existsSync(file), false);
});
test('foreign Stop never invokes gh even for merged cleanup', () => {
  const f = fixture(); const bin = path.join(f.cwd, 'bin'); mkdirSync(bin);
  const calls = path.join(f.cwd, 'calls');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf probe >> '${calls}'\nexit 1\n`, { mode: 0o755 });
  const file = write(f); const bytes = readFileSync(file, 'utf8');
  const result = stop(f, 'foreign', { PATH: `${bin}${path.delimiter}${process.env.PATH}`, DEVPRO_POST_PR_GATE_MOCK_STICKY: undefined });
  assert.equal(result.stdout, ''); assert.equal(existsSync(calls), false);
  assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('owner remains pending after changing branches and details name the creator worktree', () => {
  const f = fixture(); write(f);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'feature/another'], { cwd: f.cwd }).status, 0);
  const result = stop(f, 'owner'); assert.equal(result.status, 2);
  const details = JSON.parse(result.stdout).reason.split('\n')[2].slice('Details: '.length);
  assert.ok(readFileSync(path.resolve(f.cwd, details), 'utf8').includes(f.cwd));
});
test('a prior subscription cannot adopt a recreated PR authority', () => {
  const f = fixture(); const file = write(f); assert.equal(stop(f, 'owner').status, 2);
  const original = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(file);
  write(f, { session: session('another-owner') });
  // Timestamp collisions must not transfer an old subscription to new work.
  const recreated = JSON.parse(readFileSync(file, 'utf8'));
  assert.notEqual(recreated.authorityId, original.authorityId);
  recreated.createdAt = original.createdAt;
  writeFileSync(file, JSON.stringify(recreated));
  assert.equal(stop(f, 'owner').stdout, '');
});

test('unreadable subscribed authority blocks its owner while remaining silent for a foreign session', () => {
  const f = fixture(); const file = write(f);
  writeFileSync(file, '{truncated-authority');
  assert.equal(stop(f, 'foreign').stdout, '');
  assert.equal(stop(f, 'owner').status, 2);
  assert.equal(readFileSync(file, 'utf8'), '{truncated-authority');
});

test('supervisor failures are compact for subscribed owners and silent outside known ownership', () => {
  const f = fixture(); const file = write(f); const bytes = readFileSync(file, 'utf8');
  const run = (id) => supervisorFailure(f, id);
  assert.equal(run('foreign').stdout, '');
  assert.equal(existsSync(f.diagnostic), false);
  assert.equal(existsSync(path.join(f.cwd, 'clock')), false);
  const owner = run('owner'); assert.equal(owner.status, 2);
  assert.equal(JSON.parse(owner.stdout).reason.split('\n').length, 3);
  assert.equal(run('owner').status, 0);
  assert.equal(readFileSync(file, 'utf8'), bytes);
});


test('diagnostic ENOTDIR cannot erase an owned worker block or emit foreign reminders', () => {
  const f = fixture(); const file = write(f); const bytes = readFileSync(file, 'utf8');
  writeFileSync(f.diagnostic, 'not-a-directory');
  assert.equal(stop(f, 'foreign').stdout, '');
  assert.equal(stop(f, '').stdout, '');
  const own = stop(f, 'owner');
  assert.equal(own.status, 2, own.stderr);
  const payload = JSON.parse(own.stdout);
  assert.equal(payload.decision, 'block');
  assert.equal(payload.reason.split('\n').length, 3);
  assert.match(payload.reason, /unavailable|ENOTDIR/i);
  assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('diagnostic ENOTDIR cannot erase a proven-owner supervisor failure block', () => {
  const f = fixture(); const file = write(f); const bytes = readFileSync(file, 'utf8');
  writeFileSync(f.diagnostic, 'not-a-directory');
  const run = (id) => supervisorFailure(f, id);
  assert.equal(run('foreign').stdout, ''); assert.equal(run('').stdout, '');
  assert.equal(existsSync(path.join(f.cwd, 'clock')), false);
  const own = run('owner'); assert.equal(own.status, 2, own.stderr);
  assert.equal(JSON.parse(own.stdout).decision, 'block');
  assert.equal(JSON.parse(own.stdout).reason.split('\n').length, 3);
  assert.match(JSON.parse(own.stdout).reason, /unavailable|ENOTDIR/i);
  assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('an adopter uses the observed authority generation without rereading its file', () => {
  const f = fixture(); const file = write(f);
  write(f, { session: session('adopter') });
  const snapshot = { ...JSON.parse(readFileSync(file, 'utf8')), file };
  rmSync(file); // A second authority read would fail after this observed snapshot.
  assert.equal(state.ownsPostPrCompletionMarker(snapshot, session('adopter')), true);
  assert.equal(state.ownsPostPrCompletionMarker(snapshot, session('foreign')), false);
});

for (const terminal of ['CLOSED', 'MERGED']) {
  test(`${terminal} retires only an owned PR authority and its matching subscriptions`, () => {
    const f = fixture(); const file = write(f);
    write(f, { session: session('adopter') });
    const foreign = stop(f, 'foreign', { DEVPRO_POST_PR_GATE_MOCK_STATE: `42:${terminal}` });
    assert.equal(foreign.stdout, ''); assert.equal(existsSync(file), true);
    const own = stop(f, 'owner', { DEVPRO_POST_PR_GATE_MOCK_STATE: `42:${terminal}` });
    assert.equal(own.status, 0, own.stderr); assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.sessions`), false);
    if (terminal === 'CLOSED') assert.match(own.stderr, /cancel.*obligation|obligation.*cancel/i);
  });
}

test('CLOSED cancels an owned dispatch obligation without declaring merge completion', () => {
  const f = fixture(); const file = write(f, { expectedDispatchId: 'unfinished-dispatch', executorKind: 'external-evaluator' });
  const bin = path.join(f.cwd, 'bin'); mkdirSync(bin);
  const calls = path.join(f.cwd, 'calls');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf probe >> '${calls}'\nexit 1\n`, { mode: 0o755 });
  const foreign = stop(f, 'foreign', { PATH: `${bin}${path.delimiter}${process.env.PATH}`, DEVPRO_POST_PR_GATE_MOCK_STICKY: undefined });
  assert.equal(foreign.stdout, ''); assert.equal(existsSync(calls), false); assert.equal(existsSync(file), true);
  const own = stop(f, 'owner', { DEVPRO_POST_PR_GATE_MOCK_STATE: '42:CLOSED' });
  assert.equal(own.status, 0, own.stderr); assert.equal(existsSync(file), false);
  assert.match(own.stderr, /cancel.*obligation|obligation.*cancel/i);
  assert.doesNotMatch(own.stderr, /merge completed|merged successfully/i);
});

test('a reopened PR cannot rebuild an obligation that CLOSED already canceled', () => {
  const f = fixture(); const file = write(f, { expectedDispatchId: 'unfinished-dispatch', executorKind: 'external-evaluator' });
  const closed = stop(f, 'owner', { DEVPRO_POST_PR_GATE_MOCK_STATE: '42:CLOSED' });
  assert.equal(closed.status, 0, closed.stderr); assert.equal(existsSync(file), false);
  assert.match(closed.stderr, /cancel.*obligation|obligation.*cancel/i);
  for (const id of ['owner', 'foreign']) {
    const reopened = stop(f, id, { DEVPRO_POST_PR_GATE_MOCK_STATE: '42:OPEN' });
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.equal(reopened.stdout, ''); assert.doesNotMatch(reopened.stderr, /obligation/i);
    assert.equal(existsSync(file), false); assert.equal(existsSync(`${file}.sessions`), false);
  }
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = f.dir;
  try { assert.deepEqual(state.listPostPrCompletionMarkers(f.cwd), []); }
  finally { if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous; }
});

for (const retirement of ['clear', 'expiry']) {
  test(`${retirement} removes only subscriptions of the exact retired authority generation`, () => {
    const f = fixture(); const file = write(f);
    const other = write(f, { prNumber: '43' });
    const ownSidecar = path.join(`${file}.sessions`, `${session('owner').key}.json`);
    const different = path.join(`${file}.sessions`, 'different-generation.json');
    const record = JSON.parse(readFileSync(ownSidecar, 'utf8'));
    writeFileSync(different, JSON.stringify({ ...record, authorityId: 'another-generation' }));
    const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = f.dir;
    try {
      if (retirement === 'clear') assert.equal(state.clearPostPrCompletionMarker({ cwd: f.cwd, prNumber: '42' }), true);
      else {
        const old = new Date(Date.now() - 3 * 60 * 60_000); utimesSync(file, old, old);
        state.listPostPrCompletionMarkers(f.cwd);
      }
    } finally { if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous; }
    assert.equal(existsSync(file), false); assert.equal(existsSync(ownSidecar), false);
    assert.equal(existsSync(different), true); assert.equal(existsSync(other), true);
    assert.equal(existsSync(`${other}.sessions`), true);
  });
}


test('a delayed retirement cannot clear a recreated authority generation', () => {
  const f = fixture(); const file = write(f);
  const original = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(file); write(f, { session: session('another-owner') });
  assert.equal(state.clearPostPrCompletionMarker({ cwd: f.cwd, markerFile: file, prNumber: '42',
    expectedAuthorityId: original.authorityId }), false);
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = f.dir;
  try { assert.equal(state.clearPostPrCompletionMarker({ cwd: f.cwd, prNumber: '42', expectedAuthorityId: original.authorityId }), false); }
  finally { if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous; }
  assert.equal(existsSync(file), true);
});

test('legacy generation expiry retires matching subscriptions and preserves dispatch-bound authority', () => {
  const f = fixture(); const file = write(f);
  const record = JSON.parse(readFileSync(file, 'utf8')); delete record.authorityId;
  writeFileSync(file, JSON.stringify(record));
  const sidecar = path.join(`${file}.sessions`, `${session('owner').key}.json`);
  const subscription = JSON.parse(readFileSync(sidecar, 'utf8')); delete subscription.authorityId;
  writeFileSync(sidecar, JSON.stringify(subscription));
  const bound = write(f, { prNumber: '43', expectedDispatchId: 'must-remain' });
  const old = new Date(Date.now() - 3 * 60 * 60_000); utimesSync(file, old, old); utimesSync(bound, old, old);
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = f.dir;
  try { state.listPostPrCompletionMarkers(f.cwd); }
  finally { if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous; }
  assert.equal(existsSync(file), false); assert.equal(existsSync(`${file}.sessions`), false);
  assert.equal(existsSync(bound), true); assert.equal(existsSync(`${bound}.sessions`), true);
});


test('retirement and subscription writers respect an in-flight authority CAS', async () => {
  const f = fixture(); const file = write(f);
  const ownSidecar = path.join(`${file}.sessions`, `${session('owner').key}.json`);
  const bytes = readFileSync(ownSidecar, 'utf8');
  const old = new Date(Date.now() - 3 * 60 * 60_000); utimesSync(file, old, old);
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = f.dir;
  try {
    const result = await state.compareAndSwapPostPrCompletionExpectedDispatch({ markerFile: file,
      repositorySlug: 'org/repo', prNumber: '42', headRefOid: 'head', expectedDispatchId: '',
      nextDispatchId: 'new-dispatch', beforeCommit: () => {
        assert.equal(state.adoptPostPrCompletionMarker({ cwd: f.cwd, prNumber: '42', session: session('adopter') }), false);
        assert.equal(state.markPostPrCompletionReminded(file, session('owner')), false);
        assert.equal(state.clearPostPrCompletionMarker({ cwd: f.cwd, prNumber: '42' }), false);
        assert.equal(state.listPostPrCompletionMarkers(f.cwd).length, 1);
        assert.equal(readFileSync(ownSidecar, 'utf8'), bytes);
      } });
    assert.equal(result.status, 'updated');
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(path.join(`${file}.sessions`, `${session('adopter').key}.json`)), false);
  } finally { if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous; }
});


test('CLOSED branch-only owned authority retires using its stored identity', () => {
  const f = fixture(); const file = write(f, { prNumber: '' });
  const own = stop(f, 'owner', { DEVPRO_POST_PR_GATE_MOCK_STATE: '42:CLOSED',
    DEVPRO_POST_PR_GATE_MOCK_BRANCH_PR: 'feature/owner:42' });
  assert.equal(own.status, 0, own.stderr); assert.equal(existsSync(file), false);
  assert.equal(existsSync(`${file}.sessions`), false);
  assert.match(own.stderr, /PR #42 CLOSED.*obligation canceled/);
});


for (const generation of ['authorityId', 'legacy-createdAt']) {
  test(`key-loop retirement skips an unrelated PR generation before matching its branch authority (${generation})`, () => {
    const f = fixture();
    // A branch-only obligation can remain after the PR-number authority is
    // created; an explicit retirement of A must not retire the new B.
    const branchFile = write(f, { prNumber: '' });
    const authority = JSON.parse(readFileSync(branchFile, 'utf8'));
    if (generation === 'legacy-createdAt') {
      delete authority.authorityId; authority.createdAt = '2001-01-01T00:00:00.000Z';
      writeFileSync(branchFile, JSON.stringify(authority));
      const subscriptionFile = path.join(`${branchFile}.sessions`, `${session('owner').key}.json`);
      const subscription = JSON.parse(readFileSync(subscriptionFile, 'utf8'));
      delete subscription.authorityId; subscription.authorityCreatedAt = authority.createdAt;
      writeFileSync(subscriptionFile, JSON.stringify(subscription));
    }
    const prFile = write(f, { session: session('another-owner') });
    const prBytes = readFileSync(prFile, 'utf8');
    const subscriptionFile = path.join(`${prFile}.sessions`, `${session('another-owner').key}.json`);
    const subscriptionBytes = readFileSync(subscriptionFile, 'utf8');
    const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = f.dir;
    try {
      assert.equal(state.clearPostPrCompletionMarker({ cwd: f.cwd, prNumber: '42', branch: 'feature/owner',
        expectedAuthorityId: authority.authorityId || '', expectedAuthorityCreatedAt: authority.createdAt }), true);
    } finally { if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous; }
    assert.equal(existsSync(branchFile), false); assert.equal(existsSync(`${branchFile}.sessions`), false);
    assert.equal(readFileSync(prFile, 'utf8'), prBytes);
    assert.equal(readFileSync(subscriptionFile, 'utf8'), subscriptionBytes);
  });
}

test('retirement leaves the authority intact when its subscription directory cannot be read', () => {
  const f = fixture(); const branchFile = write(f, { prNumber: '' });
  const authority = JSON.parse(readFileSync(branchFile, 'utf8'));
  const prFile = write(f, { session: session('another-owner') });
  const prBytes = readFileSync(prFile, 'utf8');
  rmSync(`${branchFile}.sessions`, { recursive: true });
  writeFileSync(`${branchFile}.sessions`, 'unreadable-subscription-directory');
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = f.dir;
  try {
    assert.equal(state.clearPostPrCompletionMarker({ cwd: f.cwd, prNumber: '42', branch: 'feature/owner',
      expectedAuthorityId: authority.authorityId }), false);
  } finally { if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous; }
  assert.equal(existsSync(branchFile), true);
  assert.equal(readFileSync(`${branchFile}.sessions`, 'utf8'), 'unreadable-subscription-directory');
  assert.equal(readFileSync(prFile, 'utf8'), prBytes);
});


for (const unproved of ['missing-generation', 'corrupt-authority']) {
  test(`key-loop retirement stays conservative when the first key is ${unproved}`, () => {
    const f = fixture(); const branchFile = write(f, { prNumber: '' });
    const authority = JSON.parse(readFileSync(branchFile, 'utf8'));
    const prFile = write(f, { session: session('another-owner') });
    if (unproved === 'corrupt-authority') writeFileSync(prFile, '{truncated');
    else {
      const unknown = JSON.parse(readFileSync(prFile, 'utf8'));
      delete unknown.authorityId; delete unknown.createdAt;
      writeFileSync(prFile, JSON.stringify(unknown));
    }
    const prBytes = readFileSync(prFile, 'utf8');
    const branchBytes = readFileSync(branchFile, 'utf8');
    const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = f.dir;
    try {
      assert.equal(state.clearPostPrCompletionMarker({ cwd: f.cwd, prNumber: '42', branch: 'feature/owner',
        expectedAuthorityId: authority.authorityId }), false);
    } finally { if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous; }
    assert.equal(readFileSync(prFile, 'utf8'), prBytes);
    assert.equal(readFileSync(branchFile, 'utf8'), branchBytes);
  });
}
