import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';

test('diagnostic producer rotates one bounded backup and leaves foreign state untouched', async () => {
  const { recordReminderDiagnostic } = await import('../hooks/lib/session-reminder.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devpro-reminder-retention-'));
  const env = { DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR: dir };
  const file = path.join(dir, 'reminder-events.log');
  const backup = file + '.1';
  const limit = 1024 * 1024;
  try {
    mkdirSync(path.join(dir, 'foreign-session'));
    writeFileSync(path.join(dir, 'foreign-session', 'recap-work.json'), 'unowned');
    writeFileSync(path.join(dir, 'unrelated.log'), 'retain');
    // A complete JSONL segment fits the limit but leaves less than one event.
    const prior = JSON.stringify({ reason: 'x'.repeat(limit - 30) }) + '\n';
    writeFileSync(file, prior);
    writeFileSync(backup, 'older backup');
    assert.ok(recordReminderDiagnostic({ cwd: dir, kind: 'recap', reason: 'missing-session-identity', env }));
    assert.ok(readFileSync(backup, 'utf8') === prior, 'previous complete segment must become the only backup');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).reason, 'missing-session-identity');
    // A subsequent rollover replaces, rather than accumulating, backups.
    writeFileSync(file, prior);
    recordReminderDiagnostic({ cwd: dir, kind: 'post-pr', reason: 'missing-session-identity', env });
    assert.ok(statSync(file).size <= limit);
    assert.ok(statSync(backup).size <= limit);
    assert.deepEqual(readdirSync(dir).sort(), ['foreign-session', 'reminder-events.log', 'reminder-events.log.1', 'unrelated.log']);
    assert.equal(readFileSync(path.join(dir, 'foreign-session', 'recap-work.json'), 'utf8'), 'unowned');
    assert.equal(readFileSync(path.join(dir, 'unrelated.log'), 'utf8'), 'retain');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('diagnostic retention bounds oversized legacy files and rejects oversized events', async () => {
  const { recordReminderDiagnostic } = await import('../hooks/lib/session-reminder.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devpro-reminder-oversize-'));
  const env = { DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR: dir };
  const file = path.join(dir, 'reminder-events.log');
  try {
    writeFileSync(file, 'x'.repeat(2 * 1024 * 1024));
    writeFileSync(file + '.1', 'x'.repeat(2 * 1024 * 1024));
    recordReminderDiagnostic({ cwd: dir, kind: 'recap', reason: 'missing-session-identity', env });
    assert.ok(statSync(file).size <= 1024 * 1024);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'not-checked');
    assert.equal(existsSync(file + '.1'), false, 'oversized legacy backup must also be retired');
    const before = readFileSync(file, 'utf8');
    assert.equal(recordReminderDiagnostic({ cwd: dir, kind: 'recap', reason: 'x'.repeat(5000), env }), null);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(existsSync(file + '.2'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('diagnostic rotation failure remains best-effort and preserves the current segment', async () => {
  const { recordReminderDiagnostic } = await import('../hooks/lib/session-reminder.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devpro-reminder-rotation-failure-'));
  const file = path.join(dir, 'reminder-events.log');
  try {
    writeFileSync(file, 'x'.repeat(1024 * 1024));
    mkdirSync(file + '.1');
    assert.equal(recordReminderDiagnostic({ cwd: dir, kind: 'recap', reason: 'missing-session-identity',
      env: { DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR: dir } }), null);
    assert.equal(statSync(file).size, 1024 * 1024);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
import path from 'node:path';
import { resolveReminderSession, ownsReminder, isCloseoutMessage, compactReminder } from '../hooks/lib/session-reminder.mjs';

test('session ownership survives resume, excludes other sessions on the same branch, and never guesses missing identity', () => {
  const a = resolveReminderSession({ session_id: 'a' }, { DEVPRO_HOOK_HOST: 'codex' });
  const resumed = resolveReminderSession({ thread_id: 'a' }, { DEVPRO_HOOK_HOST: 'codex' });
  const b = resolveReminderSession({ session_id: 'b' }, { DEVPRO_HOOK_HOST: 'codex' });
  assert.equal(a.key, resumed.key);
  assert.equal(ownsReminder({ sessionKey: a.key, branch: 'feature/shared' }, resumed), true);
  assert.equal(ownsReminder({ sessionKey: a.key, branch: 'feature/shared' }, b), false);
  assert.equal(ownsReminder({ branch: 'feature/shared' }, a), false);
  assert.equal(resolveReminderSession({ transcript_path: '/tmp/transcript' }, {}), null);
  assert.equal(ownsReminder({ sessionKey: a.key }, null), false);
});

test('closeout detection ignores absent evidence, ordinary task progress, footer, and quoted examples', () => {
  for (const text of ['', 'T1 已完成，接著執行 T2。', '測試已綠，繼續修改 fixture。', '[AskFirstPending: none]', '> PR 已建立', '```\nStatus: blocked\n```']) assert.equal(isCloseoutMessage(text), false, text);
  for (const text of ['本次工作已完成。', 'PR #42 已建立，等待合併決定。', '為什麼停：需要使用者決定。', 'Status: blocked']) assert.equal(isCloseoutMessage(text), true, text);
});

test('AI reminder uses three logical lines and persists the full detail in its session', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devpro-reminder-'));
  const prior = process.env.DEVPRO_SESSION_REMINDER_STATE_DIR;
  process.env.DEVPRO_SESSION_REMINDER_STATE_DIR = dir;
  try {
    const session = resolveReminderSession({ session_id: 'a' }, {});
    const message = compactReminder({ cwd: dir, session, kind: 'recap', summary: 'Recap pending: 4', action: 'Read details and write Recap.', details: 'first\nsecond\nthird\nfourth' });
    assert.equal(message.split('\n').length, 3);
    assert.match(message, /^AI: Recap pending: 4\nNext: /);
    assert.match(message, /Next: From hook cwd, /);
    const file = message.split('Details: ')[1];
    assert.equal(path.isAbsolute(file), false);
    assert.equal(message.includes(dir), false);
    assert.equal(readFileSync(path.resolve(dir, file), 'utf8'), 'first\nsecond\nthird\nfourth\n');
    assert.ok(file.includes(session.key));
  } finally {
    if (prior === undefined) delete process.env.DEVPRO_SESSION_REMINDER_STATE_DIR;
    else process.env.DEVPRO_SESSION_REMINDER_STATE_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnostic storage failure preserves a three-line AI reminder without throwing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devpro-reminder-fault-'));
  const prior = process.env.DEVPRO_SESSION_REMINDER_STATE_DIR;
  const obstacle = path.join(dir, 'ordinary-file');
  writeFileSync(obstacle, 'not a directory');
  process.env.DEVPRO_SESSION_REMINDER_STATE_DIR = obstacle;
  try {
    const session = resolveReminderSession({ session_id: 'a' }, {});
    const message = compactReminder({ cwd: dir, session, kind: 'post-pr', summary: 'Owned PR remains blocked', action: 'Complete review', details: 'evidence' });
    assert.equal(message.split('\n').length, 3);
    assert.match(message, /^AI: Owned PR remains blocked\nNext: /);
    assert.match(message, /preserve the gate decision/);
    assert.match(message, /Details: unavailable \(ENOTDIR\)/);
    assert.equal(message.includes(dir), false);
  } finally {
    if (prior === undefined) delete process.env.DEVPRO_SESSION_REMINDER_STATE_DIR;
    else process.env.DEVPRO_SESSION_REMINDER_STATE_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing-identity diagnostics record metadata only and tolerate an unavailable sink', async () => {
  const { recordReminderDiagnostic } = await import('../hooks/lib/session-reminder.mjs');
  assert.equal(typeof recordReminderDiagnostic, 'function');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devpro-reminder-diag-'));
  try {
    const env = { DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR: path.join(dir, 'diagnostics') };
    const ref = recordReminderDiagnostic({ cwd: dir, kind: 'recap', reason: 'missing-session-identity', env });
    assert.equal(path.isAbsolute(ref), false);
    const event = JSON.parse(readFileSync(path.resolve(dir, ref), 'utf8'));
    assert.deepEqual(Object.keys(event).sort(), ['at', 'kind', 'reason', 'status']);
    assert.equal(event.status, 'not-checked');
    assert.equal(event.reason, 'missing-session-identity');
    writeFileSync(path.join(dir, 'obstacle'), 'file');
    assert.equal(recordReminderDiagnostic({ cwd: dir, kind: 'recap', reason: 'missing-session-identity', env: { DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR: path.join(dir, 'obstacle') } }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
