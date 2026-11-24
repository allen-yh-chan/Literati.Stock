// A hub session can merge or review the same PR number in two repositories.
// Current markers identify the repository and selector in the filename. Legacy markers
// with unkeyed names still require a repository check against their stored contents.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as state from '../hooks/lib/post-pr-completion-state.mjs';
import { resolveReminderSession } from '../hooks/lib/session-reminder.mjs';
import { makeTempDir } from './lib/tmp.mjs';

const root = makeTempDir('post-pr-marker-repo-keys-');
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const PREFIX = 'pending-post-pr-completion-';
const HEAD = 'a'.repeat(40);
const EXPECTED_DISPATCH = 'dispatch-11111111-1111-4111-8111-111111111111';
const REPO_A = 'github.com/fixture/repo-a';
const REPO_B = 'github.com/fixture/repo-b';
const ORIGIN_A = 'https://github.com/fixture/repo-a.git';

function fixture(origin = ORIGIN_A) {
  const cwd = path.join(root, String(counter++));
  mkdirSync(cwd);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
  if (origin) assert.equal(spawnSync('git', ['remote', 'add', 'origin', origin], { cwd }).status, 0);
  const dir = path.join(cwd, 'state');
  mkdirSync(dir, { recursive: true });
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = dir;
  return { cwd, dir };
}

function obligation(slug, pr) {
  return {
    schema: 'devpro-post-pr-clear-obligation/v1',
    repository_slug: slug,
    pr_number: pr,
    obligation_head_ref_oid: HEAD,
    current_dispatch_id: EXPECTED_DISPATCH,
    old_dispatch_id: 'dispatch-22222222-2222-4222-8222-222222222222',
    first_dispatch_id: 'dispatch-22222222-2222-4222-8222-222222222222',
    approval_receipt_ids: ['1'],
    attempt_history: [],
    obligation_id: 'obligation-1',
    created_at: new Date().toISOString(),
  };
}

// A legacy marker named by the PR number or the branch before the PR was known.
function writeMarker(dir, token, body, { withObligation = false } = {}) {
  const file = path.join(dir, `${PREFIX}${token}.json`);
  if (typeof body === 'string') { writeFileSync(file, body); return file; }
  const data = { authorityId: `authority-${token}`, createdAt: new Date().toISOString(), prNumber: '7', branch: 'feature/x', repository_slug: '', ...body };
  if (withObligation) Object.assign(data, { head_ref_oid: HEAD, lineage_clear_obligation: obligation(data.repository_slug, data.prNumber) });
  writeFileSync(file, JSON.stringify(data));
  return file;
}

async function renderPlan(cwd, slug, pr = '7') {
  const renderer = await import('../render-second-review-packet.mjs');
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await renderer.planPendingPostPrCompletionMarkerBinding(
      { mode: 'pr-sticky', pr_number: pr, repository_slug: slug, head_ref_oid: HEAD, previous_dispatch_id: null }, {});
  } finally { process.chdir(previous); }
}

const CALLERS = {
  ownA: { origin: ORIGIN_A, repo: '' },
  namesB: { origin: ORIGIN_A, repo: REPO_B },
  noOriginNamesB: { origin: '', repo: REPO_B },
  nothing: { origin: '', repo: '' },
};
const MARKERS = {
  noRepo: [['7', { repository_slug: '' }]],
  slugA: [['7', { repository_slug: 'fixture/repo-a' }]],
  urlA: [['7', { url: 'https://github.com/fixture/repo-a/pull/7' }]],
  slugB: [['7', { repository_slug: 'fixture/repo-b' }]],
  conflict: [['7', { repository_slug: 'fixture/repo-a', url: 'https://github.com/fixture/repo-z/pull/7' }]],
  // One old marker and one keyed marker for the same proven repository and PR.
  twoOfA: [['7', { repository_slug: 'fixture/repo-a' }], [
    state.postPrMarkerFilenames({ repo: REPO_A, prNumber: '7' })[0].slice(PREFIX.length, -5),
    { repository_slug: 'fixture/repo-a' },
  ]],
  unreadable: [['7', '{broken']],
  // A file named for another PR that cannot be read: it still stops a merge, as before, but not this PR's render.
  unreadableOtherPr: [['8', '{broken']],
};
// act: the reader uses the marker; skip: it is another repository's; stop: the reader stops and names the file.
//                    ownA     namesB   noOriginNamesB  nothing
const EXPECTED = {
  noRepo:            ['act',  'skip',  'stop',         'act'],
  slugA:             ['act',  'skip',  'skip',         'act'],
  urlA:              ['act',  'skip',  'skip',         'act'],
  slugB:             ['skip', 'act',   'act',          'act'],
  conflict:          ['stop', 'stop',  'stop',         'stop'],
  twoOfA:            ['stop', 'skip',  'skip',         'stop'],
  unreadable:        ['stop', 'stop',  'stop',         'stop'],
  unreadableOtherPr: { merge: ['stop', 'stop', 'stop', 'stop'], render: ['skip', 'skip', 'skip', 'skip'] },
};

function seed(callerName, markerName, options) {
  const caller = CALLERS[callerName];
  const { cwd, dir } = fixture(caller.origin);
  const files = MARKERS[markerName].map(([token, body]) => writeMarker(dir, token, body, options));
  const before = files.map((file) => readFileSync(file, 'utf8'));
  const unchanged = () => files.forEach((file, i) => assert.equal(readFileSync(file, 'utf8'), before[i], `${path.basename(file)} is unchanged`));
  return { cwd, files, repo: caller.repo, unchanged };
}

const OPERATIONS = {
  merge({ cwd, files, repo, unchanged }, outcome) {
    const blocked = state.postPrMergeObligation({ cwd, prNumber: '7', repo });
    unchanged();
    if (outcome === 'skip') { assert.equal(blocked, null); return; }
    assert.ok(blocked, 'the merge is blocked');
    if (outcome === 'act') assert.match(blocked.reason, /obligation-1/);
    else assert.ok(files.some((file) => blocked.reason.includes(path.basename(file))), `the reason names the file: ${blocked.reason}`);
  },
  async render({ cwd, files, repo, unchanged }, outcome) {
    const plan = () => renderPlan(cwd, repo.slice('github.com/'.length));
    if (outcome === 'stop') {
      await assert.rejects(plan, (error) => /reviewer_dispatch_identity_collision/.test(error.message)
        && files.some((file) => error.message.includes(path.basename(file))));
      unchanged();
      return;
    }
    const result = await plan();
    if (outcome === 'skip') assert.deepEqual(result, { type: 'none' });
    else assert.equal(result.marker?.file, files[0], 'the render binds this marker');
  },
};

for (const [markerName, expected] of Object.entries(EXPECTED)) {
  Object.keys(CALLERS).forEach((callerName, column) => {
    for (const [operation, check] of Object.entries(OPERATIONS)) {
      // The renderer always names the PR's repository.
      if (operation === 'render' && !CALLERS[callerName].repo) continue;
      const outcome = (Array.isArray(expected) ? expected : expected[operation])[column];
      test(`reader table: ${operation} of ${markerName} by ${callerName} → ${outcome}`, async () => {
        await check(seed(callerName, markerName, { withObligation: operation === 'merge' }), outcome);
      });
    }
  });
}

test('a merge stops on two markers of the PR or on a disputed one even when none carries an obligation', () => {
  for (const markerName of ['twoOfA', 'conflict']) {
    const { cwd, dir } = fixture();
    const files = MARKERS[markerName].map(([token, body]) => writeMarker(dir, token, body));
    const blocked = state.postPrMergeObligation({ cwd, prNumber: '7', repo: REPO_A });
    assert.ok(blocked, `${markerName}: the merge is blocked`);
    assert.ok(files.some((file) => blocked.reason.includes(path.basename(file))), blocked.reason);
  }
});

// Round 4 F1: the merge reads one listing for both checks, so a marker that becomes unreadable after the unreadable
// check never drops out of the selection.
test('a merge reads one listing: a branch-named marker of the PR blocks whether it is read or unreadable', () => {
  const { cwd, dir } = fixture();
  const file = writeMarker(dir, 'feature-x', { repository_slug: 'fixture/repo-a' }, { withObligation: true });
  assert.match(state.postPrMergeObligation({ cwd, prNumber: '7' })?.reason || '', /obligation-1/);
  let calls = 0;
  const listMarkers = (at) => {
    calls += 1;
    const markers = state.listPostPrCompletionMarkers(at);
    // A second listing would see the file fail to read.
    return calls === 1 ? markers : markers.map((marker) => (marker.file === file ? { file, marker_unreadable: true } : marker));
  };
  assert.match(state.postPrMergeObligation({ cwd, prNumber: '7', listMarkers })?.reason || '', /obligation-1/);
  assert.equal(calls, 1, 'one listing per merge check');
  writeFileSync(file, '{broken');
  assert.match(state.postPrMergeObligation({ cwd, prNumber: '7' })?.reason || '', /unreadable marker.*pending-post-pr-completion-feature-x\.json/);
});

// Round 4 F2: an obligation's slug always equals its marker's, or the listing reads the marker as unreadable, so a
// reader never takes a repository from the obligation alone.
test("an obligation whose slug is not its marker's makes the marker unreadable, and a merge names it", async () => {
  for (const outer of ['', 'fixture/repo-a']) {
    const { cwd, dir } = fixture();
    const data = JSON.parse(readFileSync(writeMarker(dir, '7', { repository_slug: outer }, { withObligation: true }), 'utf8'));
    data.lineage_clear_obligation.repository_slug = 'fixture/repo-b';
    writeFileSync(path.join(dir, `${PREFIX}7.json`), JSON.stringify(data));
    for (const repo of ['', REPO_B]) {
      assert.match(state.postPrMergeObligation({ cwd, prNumber: '7', repo })?.reason || '', /unreadable marker.*pending-post-pr-completion-7\.json/, `outer ${outer || 'empty'}, repo ${repo || 'none'}`);
    }
    await assert.rejects(renderPlan(cwd, 'fixture/repo-b'), /pending-post-pr-completion-7\.json cannot be read/);
  }
});

test('a merge that names no repository reads the checkout; a named repository that names none stops it', () => {
  const { cwd, dir } = fixture();
  writeMarker(dir, '7', { repository_slug: 'fixture/repo-b' }, { withObligation: true });
  assert.equal(state.postPrMergeObligation({ cwd, prNumber: '7' }), null, "another repository's obligation does not hold this checkout's PR");
  assert.match(state.postPrMergeObligation({ cwd, prNumber: '7', repo: REPO_B })?.reason || '', /obligation-1/);
  for (const invalid of ['fixture', 'fixture/', 'a/b/c/d', 'github.com/../repo', 'user@ghe.example.com/fixture/repo-a']) {
    assert.match(state.postPrMergeObligation({ cwd, prNumber: '7', repo: invalid })?.reason || '', /names no github\.com repository/, invalid);
  }
});

test("the checkout's repository is read again after its origin changes", () => {
  const { cwd, dir } = fixture();
  writeMarker(dir, '7', { repository_slug: 'fixture/repo-b' }, { withObligation: true });
  assert.equal(state.postPrMergeObligation({ cwd, prNumber: '7' }), null);
  assert.equal(spawnSync('git', ['remote', 'set-url', 'origin', 'https://github.com/fixture/repo-b.git'], { cwd }).status, 0);
  assert.match(state.postPrMergeObligation({ cwd, prNumber: '7' })?.reason || '', /obligation-1/);
});

test('a URL that carries credentials is never a repository name and is never repeated', () => {
  const secret = 'SENTINEL-not-a-real-token';
  const { cwd, dir } = fixture();
  // A requested repository that is such a URL stops the merge without echoing it.
  const asked = state.postPrMergeObligation({ cwd, prNumber: '7', repo: `https://user:${secret}@github.com/fixture/repo-a/pull/7` });
  assert.match(asked?.reason || '', /names no github\.com repository/);
  assert.ok(!asked.reason.includes(secret));
  // In a marker it is not evidence: the marker names no repository and is the checkout's.
  writeMarker(dir, '7', { url: `https://user:${secret}@github.com/fixture/repo-b/pull/7` }, { withObligation: true });
  const blocked = state.postPrMergeObligation({ cwd, prNumber: '7' });
  assert.match(blocked?.reason || '', /obligation-1/);
  assert.ok(!blocked.reason.includes(secret));
  assert.equal(state.postPrMergeObligation({ cwd, prNumber: '7', repo: REPO_B }), null);
});

test('a value on another host, or with a port, names no repository: the marker is read from its other fields', () => {
  const { cwd, dir } = fixture();
  writeMarker(dir, '7', { repository_slug: 'fixture/repo-b', url: 'https://ghe.example.com/fixture/repo-z/pull/7' }, { withObligation: true });
  const file = path.join(dir, `${PREFIX}7.json`);
  assert.deepEqual(state.postPrMarkerRepoName(JSON.parse(readFileSync(file, 'utf8'))), { name: REPO_B });
  assert.deepEqual(state.postPrMarkerRepoName({ url: 'https://github.com:443/fixture/repo-z/pull/7' }), { name: '' });
  assert.equal(state.postPrMergeObligation({ cwd, prNumber: '7' }), null);
  assert.match(state.postPrMergeObligation({ cwd, prNumber: '7', repo: 'fixture/repo-b' })?.reason || '', /obligation-1/);
  // A merge that names an enterprise repository stops instead of matching a github.com one.
  assert.match(state.postPrMergeObligation({ cwd, prNumber: '7', repo: 'ghe.example.com/fixture/repo-b' })?.reason || '', /names no github\.com repository/);
});

const markerSession = (id) => resolveReminderSession({ session_id: id }, { DEVPRO_HOOK_HOST: 'codex' });

test('writers, adopters and removers distinguish equal PR numbers in two repos and a numeric branch', () => {
  const { cwd } = fixture();
  const owner = markerSession('owner');
  const adopter = markerSession('adopter');
  const a = state.writePostPrCompletionMarker({ cwd, prNumber: '7', repositorySlug: REPO_A, session: owner });
  const b = state.writePostPrCompletionMarker({ cwd, prNumber: '7', repositorySlug: REPO_B, session: owner });
  const branch = state.writePostPrCompletionMarker({ cwd, branch: '7', repositorySlug: REPO_A, session: owner });
  assert.equal(new Set([a, b, branch]).size, 3);
  assert.equal(state.adoptPostPrCompletionMarker({ cwd, prNumber: '7', repo: REPO_B, session: adopter }), true);
  const markersA = state.postPrMarkersOfPr({ cwd, prNumber: '7', repo: REPO_A });
  const markersB = state.postPrMarkersOfPr({ cwd, prNumber: '7', repo: REPO_B });
  assert.deepEqual(markersA.map(marker => marker.file), [a]);
  assert.deepEqual(markersB.map(marker => marker.file), [b]);
  assert.equal(state.ownsPostPrCompletionMarker(markersA[0], adopter), false);
  assert.equal(state.ownsPostPrCompletionMarker(markersB[0], adopter), true);
  assert.equal(state.clearPostPrCompletionMarker({ cwd, prNumber: '7', repositorySlug: REPO_B }), true);
  assert.equal(existsSync(b), false);
  assert.ok(existsSync(a));
  assert.ok(existsSync(branch));
});

test('a writer refuses malformed numbers and an explicitly unsupported host before creating state', () => {
  const { cwd, dir } = fixture();
  assert.throws(() => state.writePostPrCompletionMarker({ cwd, prNumber: '07', branch: 'feature/x' }), /invalid PR number/i);
  assert.throws(() => state.writePostPrCompletionMarker({ cwd, prNumber: '7', url: 'https://ghe.example.org/fixture/repo-a/pull/7' }), /github\.com repository/i);
  assert.equal(state.listPostPrCompletionMarkers(cwd).length, 0);
  assert.equal(existsSync(path.join(dir, `${PREFIX}07.json`)), false);
});

test('a mismatched keyed payload blocks its named PR and does not block another repository', () => {
  const { cwd, dir } = fixture();
  const name = state.postPrMarkerFilenames({ repo: REPO_B, prNumber: '8' })[0];
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify({ prNumber: '7', repo: REPO_B, branch: 'feature/x' }));
  assert.throws(() => state.postPrMarkersOfPr({ cwd, prNumber: '8', repo: REPO_B }), /filename does not match/);
  assert.throws(() => state.adoptPostPrCompletionMarker({ cwd, prNumber: '8', repo: REPO_B, session: markerSession('reviewer') }), /filename does not match/);
  assert.equal(state.clearPostPrCompletionMarker({ cwd, prNumber: '8', repositorySlug: REPO_B }), false);
  assert.ok(existsSync(file));
  assert.equal(state.postPrMergeObligation({ cwd, prNumber: '8', repo: REPO_A }), null);
  assert.match(state.postPrMergeObligation({ cwd, prNumber: '8', repo: REPO_B })?.reason || '', /unreadable marker/);
  assert.deepEqual(state.postPrMarkersOfPr({ cwd, prNumber: '8', repo: REPO_A }), []);
});

test('a proven legacy marker moves with its authority, dispatch, obligation and prior subscriptions', () => {
  const { cwd, dir } = fixture();
  const first = markerSession('first');
  const second = markerSession('second');
  const legacy = writeMarker(dir, '7', {
    repository_slug: 'fixture/repo-a', expected_dispatch_id: EXPECTED_DISPATCH,
  }, { withObligation: true });
  assert.equal(state.adoptPostPrCompletionMarker({ cwd, prNumber: '7', session: first }), true);
  const original = JSON.parse(readFileSync(legacy, 'utf8'));
  const moved = state.writePostPrCompletionMarker({ cwd, prNumber: '7', repositorySlug: REPO_A, session: second });
  assert.notEqual(moved, legacy);
  assert.equal(existsSync(legacy), false);
  assert.equal(JSON.parse(readFileSync(moved, 'utf8')).expected_dispatch_id, EXPECTED_DISPATCH);
  const [marker] = state.postPrMarkersOfPr({ cwd, prNumber: '7', repo: REPO_A });
  assert.equal(marker.file, moved);
  assert.equal(marker.authorityId, original.authorityId);
  assert.deepEqual(marker.lineage_clear_obligation, original.lineage_clear_obligation);
  assert.equal(state.ownsPostPrCompletionMarker(marker, first), true);
  assert.equal(state.ownsPostPrCompletionMarker(marker, second), true);
  assert.equal(state.clearPostPrCompletionMarker({ cwd, prNumber: '7', repositorySlug: REPO_A }), false, 'key-only clear needs verified dispatch evidence to retire an obligation');
});

test('a subscription publication failure keeps the legacy obligation and dispatch available for retry', () => {
  const spare = fixture();
  const canonical = state.writePostPrCompletionMarker({ cwd: spare.cwd, prNumber: '7', repositorySlug: REPO_A, session: null });
  const { cwd, dir } = fixture();
  const legacy = writeMarker(dir, '7', {
    repository_slug: 'fixture/repo-a', expected_dispatch_id: EXPECTED_DISPATCH,
  }, { withObligation: true });
  const prior = readFileSync(legacy);
  const destination = path.join(dir, path.basename(canonical));
  const subscriber = markerSession('subscriber');
  writeFileSync(`${destination}.sessions`, 'occupied');
  assert.throws(() => state.writePostPrCompletionMarker({ cwd, prNumber: '7', repositorySlug: REPO_A, session: subscriber }), /EEXIST|ENOTDIR/);
  assert.deepEqual(readFileSync(legacy), prior);
  assert.equal(existsSync(destination), false);
  assert.match(state.postPrMergeObligation({ cwd, prNumber: '7', repo: REPO_A })?.reason || '', /obligation-1/);
  rmSync(`${destination}.sessions`);
  const moved = state.writePostPrCompletionMarker({ cwd, prNumber: '7', repositorySlug: REPO_A, session: subscriber });
  assert.equal(moved, destination);
  assert.equal(existsSync(legacy), false);
  assert.equal(JSON.parse(readFileSync(moved, 'utf8')).expected_dispatch_id, EXPECTED_DISPATCH);
});

test('a repeated hub write migrates a proven marker from the PR checkout state directory', () => {
  const hub = fixture();
  const target = fixture('https://github.com/fixture/repo-b.git');
  delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  const targetDir = state.defaultPostPrCompletionDir(target.cwd);
  mkdirSync(targetDir, { recursive: true });
  const legacy = writeMarker(targetDir, '7', {
    repository_slug: 'fixture/repo-b', worktree: target.cwd, expected_dispatch_id: EXPECTED_DISPATCH,
  }, { withObligation: true });
  const original = JSON.parse(readFileSync(legacy, 'utf8'));
  const moved = state.writePostPrCompletionMarker({ cwd: hub.cwd, worktree: target.cwd, prNumber: '7', repositorySlug: REPO_B, session: markerSession('hub') });
  assert.equal(path.dirname(moved), state.defaultPostPrCompletionDir(hub.cwd));
  assert.equal(existsSync(legacy), false);
  assert.equal(JSON.parse(readFileSync(moved, 'utf8')).expected_dispatch_id, EXPECTED_DISPATCH);
  const [marker] = state.postPrMarkersOfPr({ cwd: hub.cwd, prNumber: '7', repo: REPO_B });
  assert.equal(marker.authorityId, original.authorityId);
  assert.deepEqual(marker.lineage_clear_obligation, original.lineage_clear_obligation);
});

test('a scoped lookup preserves another repository’s expired legacy marker', () => {
  const { cwd, dir } = fixture();
  const legacy = writeMarker(dir, '7', { repository_slug: 'fixture/repo-b' });
  const expired = new Date(Date.now() - 3 * 60 * 60_000);
  const before = readFileSync(legacy);
  utimesSync(legacy, expired, expired);
  assert.equal(state.postPrMergeObligation({ cwd, prNumber: '7', repo: REPO_A }), null);
  assert.deepEqual(state.postPrMarkersOfPr({ cwd, prNumber: '7', repo: REPO_A }), []);
  assert.deepEqual(readFileSync(legacy), before);
});

// The readers depend on the fields main's writer records: a PR's URL always, its repository slug only for a PR of
// another repository (or an MCP create), and the PR's slug once a render binds a dispatch.
test("markers the writer publishes read back as their PR's repository", async () => {
  const { cwd } = fixture();
  const own = state.writePostPrCompletionMarker({ cwd, prNumber: '7', branch: 'feature/x', url: 'https://github.com/fixture/repo-a/pull/7' });
  assert.equal(JSON.parse(readFileSync(own, 'utf8')).repository_slug, '');
  assert.deepEqual(state.postPrMarkersOfPr({ cwd, prNumber: '7' }).map((marker) => marker.file), [own]);
  assert.deepEqual(state.postPrMarkersOfPr({ cwd, prNumber: '7', repo: REPO_B }), []);
  assert.equal((await renderPlan(cwd, 'fixture/repo-a')).marker?.file, own);
  assert.deepEqual(await renderPlan(cwd, 'fixture/repo-b'), { type: 'none' });

  const other = fixture();
  const cross = state.writePostPrCompletionMarker({ cwd: other.cwd, prNumber: '7', branch: 'feature/y',
    url: 'https://github.com/fixture/repo-b/pull/7', repositorySlug: 'fixture/repo-b' });
  assert.deepEqual(state.postPrMarkersOfPr({ cwd: other.cwd, prNumber: '7' }), []);
  assert.deepEqual(state.postPrMarkersOfPr({ cwd: other.cwd, prNumber: '7', repo: REPO_B }).map((marker) => marker.file), [cross]);
  assert.deepEqual(await renderPlan(other.cwd, 'fixture/repo-a'), { type: 'none' });
  assert.equal((await renderPlan(other.cwd, 'fixture/repo-b')).marker?.file, cross);
});

test('without any repository identity the PR number alone decides, as before', () => {
  const { cwd, dir } = fixture('');
  writeMarker(dir, '7', { repository_slug: '' }, { withObligation: true });
  assert.match(state.postPrMergeObligation({ cwd, prNumber: '7' })?.reason || '', /obligation-1/);
  assert.equal(state.postPrMergeObligation({ cwd, prNumber: '8' }), null);
});

test('docs: the spec carrier names the repository a post-PR marker reader acts for', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const spec = readFileSync(path.join(repoRoot, 'openspec/specs/repo-state-identity/spec.md'), 'utf8');
  assert.ok(spec.includes('### Requirement: Post-PR Marker Readers Act For One Repository'));
});
