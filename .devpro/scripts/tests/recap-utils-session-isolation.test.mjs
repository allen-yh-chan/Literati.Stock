import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './lib/tmp.mjs';
import { resolveReminderSession, reminderSessionDir } from '../hooks/lib/session-reminder.mjs';
const root = makeTempDir('recap-session-');
process.env.DEVPRO_SESSION_REMINDER_STATE_DIR = path.join(root, 'sessions');
process.env.DEVPRO_RECAP_WRITTEN_DIR = path.join(root, 'written');
const recap = await import('../hooks/lib/recap-utils.mjs');
beforeEach(() => {rmSync(path.join(root, 'sessions'), {recursive: true, force: true}); rmSync(path.join(root, 'written'), {recursive: true, force: true});});
after(() => rmSync(root, { recursive: true, force: true }));
const a = resolveReminderSession({session_id: 'a'}, {DEVPRO_HOOK_HOST: 'test'});
const b = resolveReminderSession({session_id: 'b'}, {DEVPRO_HOOK_HOST: 'test'});
test('same branch does not adopt another session obligation or consume its dedup', async () => {
  assert.equal(typeof recap.recordRecapWork, 'function');
  recap.recordRecapWork({cwd: root, branch: 'feature/owned', session: a, commit: 'abc', merged: true, prNumber: 1});
  assert.equal((await recap.evaluateMergedRecapPending({cwd: root, session: b})).skip, true);
  const own = await recap.evaluateMergedRecapPending({cwd: root, session: a});
  assert.equal(own.skip, false);
  assert.equal(own.pending[0].branch, 'feature/owned');
});

test('missing identity and unrecorded current branch stay silent', async () => {
  assert.equal((await recap.evaluateRecapState({cwd: root, session: null})).reason, 'missing-session-identity');
  assert.equal((await recap.evaluateRecapState({cwd: root, session: a})).skip, true);
  assert.equal(recap.recordRecapWork({cwd: root, session: a, branch: 'feature/inherited'}), false);
  assert.equal(recap.recordRecapWork({cwd: root, session: null, branch: 'feature/inherited', commit: 'abc'}), false);
});
test('same identity resume and explicit adoption survive a checkout change', async () => {
  recap.adoptRecapWork({cwd: root, session: a, branch: 'bugfix/old-checkout', prNumber: 9});
  assert.equal((await recap.evaluateRecapState({cwd: root, session: b})).skip, true);
  const resumed = resolveReminderSession({session_id: 'a'}, {DEVPRO_HOOK_HOST: 'test'});
  const own = await recap.evaluateRecapState({cwd: root, session: resumed});
  assert.equal(own.pending[0].branch, 'bugfix/old-checkout');
  assert.equal((await recap.evaluateRecapState({cwd: root, session: a})).skip, true);
});
test('own dedup expires; new successful work resets own dedup', async () => {
  recap.recordRecapWork({cwd: root, session: a, branch: 'feature/fresh', commit: 'abc'});
  await recap.evaluateRecapState({cwd: root, session: a});
  const file = path.join(reminderSessionDir(root, a), 'recap-work.json');
  const records = JSON.parse(readFileSync(file, 'utf8'));
  records[0].promptedAt = Date.now() - 31 * 60_000;
  writeFileSync(file, JSON.stringify(records));
  assert.equal((await recap.evaluateRecapState({cwd: root, session: a})).skip, false);
  recap.recordRecapWork({cwd: root, session: a, branch: 'feature/fresh', commit: 'def'});
  assert.equal((await recap.evaluateRecapState({cwd: root, session: a})).skip, false);
});
test('same PR successful Discussion clears own only; wrong PR remains pending', async () => {
  for (const session of [a, b]) recap.recordRecapWork({cwd: root, session, branch: 'feature/pr-scope', prNumber: 2, merged: true});
  recap.writeRecapWrittenMarkerForChange('pr-scope', 1, {cwd: root, session: a});
  assert.equal(recap.clearOwnRecapPendingForChange('pr-scope', {cwd: root, session: a, prNumber: 1}), 0);
  assert.equal((await recap.evaluateMergedRecapPending({cwd: root, session: a, consume: false})).skip, false);
  recap.writeRecapWrittenMarkerForChange('pr-scope', 2, {cwd: root, session: a});
  assert.deepEqual(JSON.parse(readFileSync(path.join(reminderSessionDir(root, a), 'recap-work.json'), 'utf8')), []);
  const other = JSON.parse(readFileSync(path.join(reminderSessionDir(root, b), 'recap-work.json'), 'utf8'));
  assert.equal(other.length, 1, 'fact-writing must not mutate another session');
  assert.equal((await recap.evaluateMergedRecapPending({cwd: root, session: b})).skip, true, 'confirmed shared Discussion fact is readable');
});
test('lease is owned and expires without clearing work', async () => {
  recap.recordRecapWork({cwd: root, session: a, branch: 'feature/lease', prNumber: 3, merged: true});
  assert.equal(recap.markRecapCreationStartedForChange('lease', {cwd: root, session: b, prNumber: 3}), 0);
  assert.equal(recap.markRecapCreationStartedForChange('lease', {cwd: root, session: a, prNumber: 3}), 1);
  assert.equal((await recap.evaluateMergedRecapPending({cwd: root, session: a})).skip, true);
  const file = path.join(reminderSessionDir(root, a), 'recap-work.json');
  const records = JSON.parse(readFileSync(file, 'utf8'));
  records[0].inProgressAt = Date.now() - 31 * 60_000;
  writeFileSync(file, JSON.stringify(records));
  assert.equal((await recap.evaluateMergedRecapPending({cwd: root, session: a})).skip, false);
});

test('same-number hub PRs keep independent work, leases and written facts', async () => {
  const branch = 'feature/shared';
  const first = {cwd: root, session: a, branch, prNumber: 42, merged: true, repo: 'fixture/one'};
  const second = {...first, repo: 'fixture/two'};
  recap.recordRecapWork(first);
  recap.recordRecapWork(second);
  recap.recordRecapWork({...first, session: b});
  recap.recordRecapWork({...second, session: b});
  const pending = async (session = a) => (await recap.evaluateMergedRecapPending({cwd: root, session, consume: false})).pending.map((item) => item.repo);
  assert.deepEqual(await pending(), ['github.com/fixture/one', 'github.com/fixture/two']);
  assert.equal(recap.markRecapCreationStartedForChange('shared', first), 1);
  assert.deepEqual(await pending(), ['github.com/fixture/two']);
  assert.equal(recap.writeRecapWrittenMarkerForChange('shared', 42, first), 1);
  assert.deepEqual(await pending(), ['github.com/fixture/two']);
  assert.deepEqual(await pending(b), ['github.com/fixture/two']);
  assert.equal(recap.checkDiscussionExists('shared', {prNumber: 42}), false);
  assert.equal(recap.checkDiscussionExists('shared', {prNumber: 42, repo: second.repo}), false);
});

test('unverified explicit repository never changes legacy recap state', async () => {
  const args = {cwd: root, session: a, branch: 'feature/shared', prNumber: 42, merged: true};
  assert.equal(recap.recordRecapWork(args), true);
  const file = path.join(reminderSessionDir(root, a), 'recap-work.json');
  const before = readFileSync(file, 'utf8');
  const invalid = {...args, repo: 'git.example.invalid/fixture/project'};
  assert.equal(recap.recordRecapWork(invalid), false);
  assert.equal(recap.markRecapCreationStartedForChange('shared', invalid), 0);
  assert.equal(recap.writeRecapWrittenMarkerForChange('shared', 42, invalid), 0);
  assert.equal(readFileSync(file, 'utf8'), before);
});
test('many obligations produce three logical lines and full diagnostic list', async () => {
  for (let n=0;n<4;n++) recap.recordRecapWork({cwd: root, session: a, branch: `feature/item-${n}`, commit: 'abc', merged: true});
  const pending = (await recap.evaluateMergedRecapPending({cwd: root, session: a})).pending;
  const text = recap.buildRecapReminder({cwd: root, session: a, pending});
  assert.equal(text.split('\n').length, 3);
  assert.match(text, /本 session 有 4 項/);
  assert.doesNotMatch(text, /feature\/item/);
  const details = readFileSync(path.resolve(root,text.split('Details: ')[1]), 'utf8');
  for (let n=0;n<4;n++) assert.match(details, new RegExp(`feature/item-${n}`));
});

test('PR creation promotes own commit work and later commits keep that PR identity', async () => {
  recap.recordRecapWork({cwd: root, session: a, branch: 'feature/promotion', commit: 'abc'});
  recap.recordRecapWork({cwd: root, session: a, branch: 'feature/promotion', prNumber: 5});
  recap.recordRecapWork({cwd: root, session: a, branch: 'feature/promotion', commit: 'def'});
  const own = await recap.evaluateRecapState({cwd: root, session: a});
  assert.equal(own.pending.length, 1);
  assert.equal(own.pending[0].prNumber, '5');
  assert.equal(own.pending[0].commit, 'def');
});

test('known commit origin allows only matching promotion and preserves commit-only Recap', async () => {
  const options = {cwd: root, session: a, branch: 'feature/origin', repo: 'fixture/one'};
  recap.recordRecapWork({...options, commit: 'abc'});
  let pending = (await recap.evaluateRecapState({cwd: root, session: a, consume: false})).pending;
  assert.equal(pending[0].prNumber, '');
  assert.equal(pending[0].repo, undefined);
  assert.equal(recap.writeRecapWrittenMarkerForChange('origin', null, {cwd: root, session: a}), 1);
  assert.equal((await recap.evaluateRecapState({cwd: root, session: a, consume: false})).skip, true);

  const newBranch = {...options, branch: 'feature/new-origin'};
  recap.recordRecapWork({...newBranch, commit: 'abc'});
  recap.recordRecapWork({...newBranch, prNumber: 42, repo: 'fixture/two'});
  recap.recordRecapWork({...newBranch, prNumber: 42});
  pending = (await recap.evaluateRecapState({cwd: root, session: a, consume: false})).pending;
  assert.deepEqual(pending.map(({repo, commit}) => [repo, commit]), [
    ['github.com/fixture/one', 'abc'], ['github.com/fixture/two', ''],
  ]);
});

test('unknown and A chore work stay silent; explicit B/B-mini and adoption establish local eligibility', async () => {
  assert.equal(recap.recordRecapWork({cwd: root, session: a, branch: 'chore/unknown', commit: 'abc'}), false);
  assert.equal(recap.recordRecapWork({cwd: root, session: a, branch: 'chore/a', commit: 'abc', classification: 'A'}), false);
  assert.equal(recap.adoptRecapWork({cwd: root, session: a, branch: 'chore/adopt-a', classification: 'A'}), false);
  assert.equal((await recap.evaluateRecapState({cwd: root, session: a})).skip, true);
  for (const classification of ['B', 'B-mini']) {
    assert.equal(recap.recordRecapWork({cwd: root, session: a, branch: `chore/local-${classification.toLowerCase()}`, commit: 'abc', classification}), true);
  }
  assert.equal(recap.adoptRecapWork({cwd: root, session: a, branch: 'chore/adopted'}), true);
  assert.equal(recap.adoptRecapWork({cwd: root, session: a, branch: 'chore/bump-v1.0.0', classification: 'B'}), false);
  const own = await recap.evaluateRecapState({cwd: root, session: a});
  assert.equal(own.pending.length, 3);
  const message = recap.buildRecapReminder({cwd: root, session: a, pending: own.pending});
  assert.match(readFileSync(path.resolve(root,message.split('Details: ')[1]), 'utf8'), /classification unconfirmed; explicit adoption/);
  recap.recordRecapWork({cwd: root, session: a, branch: 'chore/local-b', commit: 'def'});
  assert.equal((await recap.evaluateRecapState({cwd: root, session: a})).pending[0].classification, 'B');
});
