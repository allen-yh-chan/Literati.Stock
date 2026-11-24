// A PR opened with `gh pr create -R <other repo>` from this session's checkout is a PR of the
// other repository. Its marker must name that repository, and the Stop hook must look the PR up
// there — otherwise `gh pr view <n>` resolves the number against this checkout's repository and
// the obligation can never clear (or clears against an unrelated PR with the same number).
// The portable Node test double records actual gh arguments from the spawned Stop hook.
import './lib/portable-command-shims.cjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as state from '../hooks/lib/post-pr-completion-state.mjs';
import { prUrlRepo } from '../hooks/lib/repo-key.mjs';
import { resolveReminderSession } from '../hooks/lib/session-reminder.mjs';
import { envWithoutHostMarkers } from './lib/host-session-env.mjs';
import { repoPath } from './lib/repo-root.mjs';
import { makeTempDir } from './lib/tmp.mjs';

const root = makeTempDir('post-pr-marker-cross-repo-');
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

function cleanEnv(extra) {
  const env = { ...envWithoutHostMarkers(process.env), DEVPRO_HOOK_HOST: 'codex', DEVPRO_AGENT_RULES_LEVEL: 'lite', ...extra };
  for (const key of Object.keys(env)) if (key.startsWith('DEVPRO_POST_PR_GATE_MOCK_')) delete env[key];
  for (const key of ['DEVPRO_POST_PR_COMPLETION_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CONVERSATION_ID', 'DEVPRO_HOST_SESSION_ID']) delete env[key];
  return env;
}

function fixture(origin) {
  const cwd = path.join(root, String(counter++));
  mkdirSync(cwd);
  for (const args of [['init', '-q', '-b', 'feature/session-work'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  if (origin) assert.equal(spawnSync('git', ['remote', 'add', 'origin', origin], { cwd }).status, 0);
  const env = cleanEnv({
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(cwd, 'state'),
    DEVPRO_SESSION_REMINDER_STATE_DIR: path.join(cwd, 'reminders'),
    DEVPRO_RECAP_WRITTEN_DIR: path.join(cwd, 'written'),
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(cwd, 'control-evidence'),
  });
  return { cwd, env };
}

function prCreate(f, command, url) {
  const result = spawnSync(process.execPath, [repoPath('.devpro/scripts/hooks/post-tool-gate.mjs')], {
    cwd: f.cwd, env: f.env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'owner', cwd: f.cwd, tool_name: 'Bash', tool_input: { command }, tool_response: { exit_code: 0, stdout: url } }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /post-pr marker write failed/);
  return JSON.parse(readFileSync(markerFile(f.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR, prUrlRepo(url)), 'utf8'));
}

test('a PR created in another repository records that repository on its marker', () => {
  const f = fixture('https://github.com/fixture/session-repo.git');
  const marker = prCreate(f, 'gh pr create -R fixture/other-repo --head release/x', 'https://github.com/fixture/other-repo/pull/7');
  assert.equal(marker.repository_slug, 'fixture/other-repo');
});

test('a PR of the session repository keeps the unbound empty repository slug', () => {
  const f = fixture('git@github.com:fixture/session-repo.git');
  const marker = prCreate(f, 'gh pr create --head feature/session-work', 'https://github.com/Fixture/Session-Repo/pull/7');
  assert.equal(marker.repository_slug, '');
});

// #3562: `DEVPRO_PR_CHECKOUT=<abs> gh pr create` names the PR's checkout without moving the session. The marker
// records that checkout as its worktree, but stays in the session repository's state with its repository binding:
// the Stop hook runs in the session cwd and only reads that state.
function markerFile(dir, repo) {
  return path.join(dir, state.postPrMarkerFilenames({ repo, prNumber: '7' })[0]);
}

test('a declared DEVPRO_PR_CHECKOUT is the marker worktree of a PR of the session repository', () => {
  const f = fixture('https://github.com/fixture/session-repo.git');
  const declared = fixture('https://github.com/fixture/session-repo.git');
  const marker = prCreate(f, `DEVPRO_PR_CHECKOUT=${declared.cwd} gh pr create -R fixture/session-repo --head feature/x --body-file /abs/body.md`, 'https://github.com/fixture/session-repo/pull/7');
  assert.equal(marker.worktree, path.resolve(declared.cwd));
  assert.equal(marker.repository_slug, '');
});

test('a declared checkout of another repository keeps the marker in the session repository with its slug', () => {
  const f = fixture('https://github.com/fixture/session-repo.git');
  const declared = fixture('https://github.com/fixture/other-repo.git');
  // The default state dir, so a marker written from the declared checkout would land in that repository instead.
  const env = { ...f.env };
  delete env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  const result = spawnSync(process.execPath, [repoPath('.devpro/scripts/hooks/post-tool-gate.mjs')], {
    cwd: f.cwd, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'owner', cwd: f.cwd, tool_name: 'Bash', tool_input: { command: `DEVPRO_PR_CHECKOUT=${declared.cwd} gh pr create -R fixture/other-repo --head feature/x --body-file /abs/body.md` }, tool_response: { exit_code: 0, stdout: 'https://github.com/fixture/other-repo/pull/7' } }),
  });
  assert.equal(result.status, 0, result.stderr);
  const stateDir = (cwd) => path.join(cwd, 'notes', 'tmp', 'state', 'devpro-post-pr-completion');
  assert.equal(existsSync(markerFile(stateDir(declared.cwd), 'fixture/other-repo')), false, 'no marker in the declared repository');
  const marker = JSON.parse(readFileSync(markerFile(stateDir(f.cwd), 'fixture/other-repo'), 'utf8'));
  assert.equal(marker.repository_slug, 'fixture/other-repo');
  assert.equal(marker.worktree, path.resolve(declared.cwd));
});

test('a create after cd reuses the legacy target authority in the session state', () => {
  const hub = fixture('https://github.com/fixture/session-repo.git');
  const target = fixture('https://github.com/fixture/other-repo.git');
  const url = 'https://github.com/fixture/other-repo/pull/7';
  const env = { ...hub.env };
  delete env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  const targetDir = state.defaultPostPrCompletionDir(target.cwd);
  mkdirSync(targetDir, { recursive: true });
  const legacy = path.join(targetDir, 'pending-post-pr-completion-7.json');
  writeFileSync(legacy, JSON.stringify({
    prNumber: '7', authorityId: 'old-authority', createdAt: new Date().toISOString(), url,
    branch: 'feature/session-work', worktree: target.cwd,
  }));
  const result = spawnSync(process.execPath, [repoPath('.devpro/scripts/hooks/post-tool-gate.mjs')], {
    cwd: hub.cwd, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'owner', cwd: hub.cwd, tool_name: 'Bash',
      tool_input: { command: `cd "${target.cwd}" && gh pr create --head feature/session-work` },
      tool_response: { exit_code: 0, stdout: url } }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /post-pr marker write failed/);
  assert.equal(existsSync(legacy), false);
  const file = markerFile(state.defaultPostPrCompletionDir(hub.cwd), prUrlRepo(url));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).authorityId, 'old-authority');
});

test('a DEVPRO_PR_CHECKOUT that is not a literal absolute git checkout, a cd form and a bare create keep today\'s worktree', () => {
  const f = fixture('https://github.com/fixture/session-repo.git');
  const other = fixture('https://github.com/fixture/session-repo.git');
  const notGit = path.join(root, `not-git-${counter++}`);
  mkdirSync(notGit);
  const create = '-R fixture/session-repo --head feature/x --body-file /abs/body.md';
  const url = 'https://github.com/fixture/session-repo/pull/7';
  for (const [label, command, expected] of [
    ['relative', `DEVPRO_PR_CHECKOUT=relative/dir gh pr create ${create}`, f.cwd],
    ['variable', `DEVPRO_PR_CHECKOUT=$TARGET gh pr create ${create}`, f.cwd],
    ['not a git checkout', `DEVPRO_PR_CHECKOUT=${notGit} gh pr create ${create}`, f.cwd],
    ['cd form', `cd ${other.cwd} && gh pr create ${create}`, other.cwd],
    ['bare', `gh pr create ${create}`, f.cwd],
  ]) {
    rmSync(markerFile(f.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR, prUrlRepo(url)), { force: true });
    assert.equal(prCreate(f, command, url).worktree, path.resolve(expected), label);
  }
});

function seedMarker(f, options) {
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = f.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  try {
    return state.writePostPrCompletionMarker({ cwd: f.cwd, branch: 'feature/x', ...options,
      session: resolveReminderSession({ session_id: 'owner' }, { DEVPRO_HOOK_HOST: 'codex' }),
    });
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous;
  }
}

function stopWithGh(f, script, extra = {}) {
  const bin = path.join(f.cwd, 'bin');
  mkdirSync(bin);
  const calls = path.join(f.cwd, 'gh-calls');
  writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_GH_CALLS, JSON.stringify(args) + '\\n');
const repoArg = args.includes('-R') ? args[args.indexOf('-R') + 1] : '';
const snapshot = (slug, state = 'MERGED', number = 7) => ({
  number, url: 'https://github.com/' + slug + '/pull/' + number,
  state, comments: [], headRefName: 'feature/x', headRefOid: 'a'.repeat(40),
  baseRefName: 'main', changedFiles: 0, files: [],
});
${script}
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [repoPath('.devpro/scripts/hooks/post-pr-completion-check.mjs')], {
    cwd: f.cwd, input: JSON.stringify({ session_id: 'owner' }), encoding: 'utf8',
    env: { ...f.env, PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      GH_HOST: 'enterprise.fixture.invalid', GH_REPO: 'enterprise.fixture.invalid/fixture/ambient',
      TEST_GH_CALLS: calls, ...extra },
  });
  const argv = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { ...result, argv };
}

function details(f, result) {
  assert.equal(result.status, 2, result.stderr + result.stdout);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  const detail = decision.reason.split('\n').find(line => line.startsWith('Details: '));
  assert.ok(detail, decision.reason);
  return readFileSync(path.resolve(f.cwd, detail.slice('Details: '.length)), 'utf8');
}

test('Stop queries equal PR numbers with their own GitHub.com repository even under GH_HOST and GH_REPO', () => {
  const f = fixture('https://github.com/fixture/session-repo.git');
  const own = seedMarker(f, { prNumber: '7', repositorySlug: 'fixture/session-repo' });
  const other = seedMarker(f, { prNumber: '7', repositorySlug: 'fixture/other-repo' });
  const result = stopWithGh(f, `
const slug = repoArg.slice('github.com/'.length);
if (args[1] !== 'view' || !['github.com/fixture/session-repo', 'github.com/fixture/other-repo'].includes(repoArg)) process.exit(1);
process.stdout.write(JSON.stringify(snapshot(slug, slug.endsWith('/other-repo') ? 'MERGED' : 'OPEN')));
`);
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.deepEqual(new Set(result.argv.map(args => args.slice(0, 5).join(' '))), new Set([
    'pr view 7 -R github.com/fixture/session-repo', 'pr view 7 -R github.com/fixture/other-repo',
  ]));
  assert.equal(existsSync(own), true);
  assert.equal(existsSync(other), false);
});

test('Stop uses the saved repository for a branch lookup and its follow-up PR view', () => {
  const f = fixture('https://github.com/fixture/session-repo.git');
  const own = seedMarker(f, { repositorySlug: 'fixture/session-repo' });
  const other = seedMarker(f, { repositorySlug: 'fixture/other-repo' });
  const result = stopWithGh(f, `
if (!['github.com/fixture/session-repo', 'github.com/fixture/other-repo'].includes(repoArg)) process.exit(1);
const slug = repoArg.slice('github.com/'.length);
const number = slug.endsWith('/other-repo') ? 8 : 7;
const body = snapshot(slug, args[1] === 'view' && number === 8 ? 'MERGED' : 'OPEN', number);
process.stdout.write(JSON.stringify(args[1] === 'list' ? [body] : body));
`);
  assert.equal(result.status, 2, result.stderr + result.stdout);
  for (const [repo, number] of [['github.com/fixture/session-repo', '7'], ['github.com/fixture/other-repo', '8']]) {
    const scoped = result.argv.filter(args => args[args.indexOf('-R') + 1] === repo);
    assert.deepEqual(scoped.map(args => args[1]), ['list', 'view', ...(number === '7' ? ['view'] : [])]);
    assert.deepEqual(scoped[0].slice(0, 4), ['pr', 'list', '--head', 'feature/x']);
    assert.ok(scoped.slice(1).every(args => args[2] === number));
  }
  assert.equal(existsSync(own), true);
  assert.equal(existsSync(other), false);
});

test('Stop lists both owning repos when same-number lookups cannot be verified', () => {
  const f = fixture('https://github.com/fixture/session-repo.git');
  const own = seedMarker(f, { prNumber: '7', repositorySlug: 'fixture/session-repo' });
  const other = seedMarker(f, { prNumber: '7', repositorySlug: 'fixture/other-repo' });
  const result = stopWithGh(f, `process.stdout.write(JSON.stringify(snapshot('fixture/ambient')));`);
  const diagnostic = details(f, result);
  for (const repo of ['github.com/fixture/session-repo', 'github.com/fixture/other-repo']) {
    assert.ok(diagnostic.split('\n').some(line => line.startsWith('- PR #7') && line.includes(repo)), diagnostic);
    assert.ok(result.argv.some(args => args.slice(0, 5).join(' ') === `pr view 7 -R ${repo}`));
  }
  assert.match(diagnostic, /執行前先核對上方每筆的 repo 與 PR 號.*再到該 repo 執行/);
  assert.doesNotMatch(diagnostic, /github\.com\/fixture\/ambient/);
  assert.equal(existsSync(own), true);
  assert.equal(existsSync(other), true);
});

test('Stop uses a verified branch snapshot after transport failure but rejects a conflicting follow-up', () => {
  for (const followup of ['process.exit(1);', "process.stdout.write(JSON.stringify(snapshot('fixture/ambient', 'CLOSED')));"]) {
    const f = fixture('https://github.com/fixture/session-repo.git');
    const file = seedMarker(f, { repositorySlug: 'fixture/other-repo' });
    const result = stopWithGh(f, `
if (args[1] === 'list') {
  process.stdout.write(JSON.stringify([snapshot('fixture/other-repo', 'CLOSED')]));
} else {
  ${followup}
}
`);
    const conflict = followup.includes('ambient');
    assert.equal(result.status, conflict ? 2 : 0, result.stderr + result.stdout);
    assert.deepEqual(result.argv.map(args => [args[1], args[args.indexOf('-R') + 1]]), [
      ['list', 'github.com/fixture/other-repo'], ['view', 'github.com/fixture/other-repo'],
    ]);
    assert.equal(existsSync(file), conflict);
  }
});

test('Stop names and retains a conflicting legacy marker before a branch-pattern exemption', () => {
  const f = fixture('https://github.com/fixture/session-repo.git');
  const keyed = seedMarker(f, { prNumber: '7', branch: 'release/x', repositorySlug: 'fixture/session-repo' });
  const legacy = path.join(path.dirname(keyed), 'pending-post-pr-completion-7.json');
  const data = JSON.parse(readFileSync(keyed, 'utf8'));
  data.repository_slug = 'fixture/other-repo';
  writeFileSync(legacy, JSON.stringify(data));
  rmSync(keyed);
  const result = stopWithGh(f, `process.exit(1);`);
  const diagnostic = details(f, result);
  assert.match(diagnostic, /pending-post-pr-completion-7\.json.*conflict/i);
  assert.deepEqual(result.argv, []);
  assert.deepEqual(JSON.parse(readFileSync(legacy, 'utf8')), data);
});

test('Stop names and retains an owned keyed marker with a different repository in its body', () => {
  const f = fixture('https://github.com/fixture/session-repo.git');
  const file = seedMarker(f, { prNumber: '7', branch: 'release/x', repositorySlug: 'fixture/other-repo' });
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.repo = 'github.com/fixture/session-repo';
  data.repository_slug = 'fixture/session-repo';
  writeFileSync(file, JSON.stringify(data));
  const result = stopWithGh(f, `process.exit(1);`);
  const diagnostic = details(f, result);
  assert.ok(diagnostic.includes(`${path.basename(file)} cannot be read or verified`), diagnostic);
  assert.deepEqual(result.argv, []);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), data);
});

test('Stop keeps an unscoped legacy marker from using ambient GitHub routing', () => {
  const f = fixture();
  const file = seedMarker(f, { prNumber: '7' });
  const result = stopWithGh(f, `process.stdout.write(JSON.stringify(snapshot('fixture/ambient')));`);
  assert.match(details(f, result), /pending-post-pr-completion-7\.json has no verified GitHub\.com repository/);
  assert.deepEqual(result.argv, []);
  assert.equal(existsSync(file), true);
});

test('Stop checks the returned number, URL and branch even for unscoped legacy markers', () => {
  const cases = [
    { request: { prNumber: '7' }, response: "snapshot('fixture/legacy', 'MERGED', 8)", keep: true },
    { request: { prNumber: '7' }, response: "{ ...snapshot('fixture/legacy'), url: 'https://github.com/fixture/legacy/pull/8' }", keep: true },
    { request: { branch: 'feature/x' }, response: "{ ...snapshot('fixture/legacy'), headRefName: 'feature/other' }", keep: true },
    { request: { prNumber: '7' }, response: "snapshot('fixture/legacy')", keep: false },
  ];
  for (const { request, response, keep } of cases) {
    const f = fixture();
    const file = seedMarker(f, request);
    const result = stopWithGh(f, `
const body = ${response};
process.stdout.write(JSON.stringify(args[1] === 'list' ? [body] : body));
`, { GH_HOST: '', GH_REPO: '' });
    assert.equal(result.status, keep ? 2 : 0, result.stderr + result.stdout);
    assert.deepEqual(result.argv.map(args => args.slice(0, 3)), [
      request.prNumber ? ['pr', 'view', '7'] : ['pr', 'list', '--head'],
    ]);
    assert.equal(existsSync(file), keep);
  }
});

test('Stop pins an unscoped follow-up to the first verified GitHub.com response', () => {
  for (const request of [{ prNumber: '7' }, { branch: 'feature/x' }]) {
    const f = fixture();
    const file = seedMarker(f, request);
    const result = stopWithGh(f, `
const body = repoArg ? snapshot('fixture/other-repo') : snapshot('fixture/legacy', 'OPEN');
process.stdout.write(JSON.stringify(args[1] === 'list' ? [body] : body));
`, { GH_HOST: '', GH_REPO: '' });
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.equal(result.argv.length, 2);
    assert.equal(result.argv[0].includes('-R'), false);
    assert.deepEqual(result.argv[1].slice(0, 5), ['pr', 'view', '7', '-R', 'github.com/fixture/legacy']);
    assert.equal(existsSync(file), true);
  }
});

test('Stop keeps a marker when the explicitly targeted gh lookup returns another PR identity', () => {
  for (const [slug, number] of [['fixture/session-repo', 7], ['fixture/other-repo', 8]]) {
    const f = fixture('https://github.com/fixture/session-repo.git');
    const file = seedMarker(f, { prNumber: '7', repositorySlug: 'fixture/other-repo' });
    const result = stopWithGh(f, `process.stdout.write(JSON.stringify(snapshot(${JSON.stringify(slug)}, 'MERGED', ${number})));`);
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.deepEqual(result.argv.map(args => args.slice(0, 5)), [['pr', 'view', '7', '-R', 'github.com/fixture/other-repo']]);
    assert.equal(existsSync(file), true);
  }
});

test('Stop keeps a PR marker that gains a review binding during its lookup', () => {
  const f = fixture('https://github.com/fixture/session-repo.git');
  const file = seedMarker(f, { prNumber: '7', repositorySlug: 'fixture/other-repo' });
  const dispatch = 'dispatch-11111111-1111-4111-8111-111111111111';
  const stateUrl = pathToFileURL(repoPath('.devpro/scripts/hooks/lib/post-pr-completion-state.mjs')).href;
  const result = stopWithGh(f, `
import(${JSON.stringify(stateUrl)}).then(async ({ compareAndSwapPostPrCompletionExpectedDispatch }) => {
  const result = await compareAndSwapPostPrCompletionExpectedDispatch({
    markerFile: process.env.TEST_BIND_MARKER,
    repositorySlug: 'fixture/other-repo',
    prNumber: '7',
    headRefOid: 'a'.repeat(40),
    expectedDispatchId: '',
    nextDispatchId: ${JSON.stringify(dispatch)},
  });
  if (result.status !== 'updated') process.exit(1);
  process.stdout.write(JSON.stringify(snapshot('fixture/other-repo')));
});
`, { TEST_BIND_MARKER: file });
  assert.match(details(f, result), /Could not retire/);
  assert.deepEqual(result.argv.map(args => args.slice(0, 5)), [['pr', 'view', '7', '-R', 'github.com/fixture/other-repo']]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).expected_dispatch_id, dispatch);
});
