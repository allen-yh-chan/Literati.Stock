import {test, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeTempDir} from './lib/tmp.mjs';
import {resolveReminderSession, reminderSessionDir} from '../hooks/lib/session-reminder.mjs';
const root = makeTempDir('recap-stop-scoped-');
process.env.DEVPRO_SESSION_REMINDER_STATE_DIR = path.join(root, 'sessions');
process.env.DEVPRO_RECAP_WRITTEN_DIR = path.join(root, 'written');
const {recordRecapWork} = await import('../hooks/lib/recap-utils.mjs');
const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../hooks');
const a = resolveReminderSession({session_id: 'stop-a'}, {DEVPRO_HOOK_HOST: 'test'});
const b = resolveReminderSession({session_id: 'stop-b'}, {DEVPRO_HOOK_HOST: 'test'});
const bin = path.join(root, 'bin');
mkdirSync(bin);
writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\n' "$*" >> '${path.join(root, 'gh.log')}'\nexit 1\n`);
chmodSync(path.join(bin, 'gh'), 0o755);
beforeEach(() => {rmSync(path.join(root, 'sessions'), {recursive: true, force: true});rmSync(path.join(root,'diagnostics'),{recursive:true,force:true});});
after(() => rmSync(root, {recursive: true, force: true}));
function own(branch='feature/own', merged=false) {
  recordRecapWork({cwd: root, session: a, branch, commit: 'abc', prNumber: merged ? 4 : '', merged});
}
function run(hook, payload, session=a) {
  const result = spawnSync(process.execPath, [path.join(hooks, hook)], {
    input: JSON.stringify({...payload, ...(session ? {session_id: session.sessionId} : {}), cwd: root}), encoding: 'utf8', cwd: root,
    env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DEVPRO_HOOK_HOST: 'test', CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '', CLAUDE_CONVERSATION_ID: '', DEVPRO_POST_PR_COMPLETION_SESSION_ID: '', DEVPRO_HOST_SESSION_ID: '', DEVPRO_RULE_LOAD_LEDGER_STATE_DIR: path.join(root, 'ledger'), DEVPRO_AGENT_RULES_LEVEL: 'full', DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR:path.join(root,'diagnostics')},
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
function workFile(session=a) {return path.join(reminderSessionDir(root, session), 'recap-work.json');}
test('midwork, generic completion, empty transcript and AskFirstPending:none stay silent without dedup consumption', () => {
  own(); own('bugfix/merged-own', true);
  const before = readFileSync(workFile(), 'utf8');
  for (const text of ['', 'T1 done; tests all green', 'AskFirstPending: none', '> PR #4 已合併', '```\nPR #4 已合併\n```']) {
    assert.equal(run('recap-check.mjs', {last_assistant_message: text}), null, text);
    assert.equal(readFileSync(workFile(), 'utf8'), before);
  }
  const diag = JSON.parse(readFileSync(path.join(reminderSessionDir(root,a), 'recap.log'), 'utf8').trim().split('\n').at(-1));
  assert.equal(diag.boundary, false);
  assert.equal(diag.current_skip, true);
  assert.equal(diag.merged_pending_count, 0);
  assert.equal(diag.emitted, false);
  assert.equal(diag.exit_code, 0);
  assert.equal(diag.sessionKey, a.key);
});
test('real closeout emits three lines with all own details and no gh probe', () => {
  own(); own('bugfix/merged-own', true);
  const out = run('recap-check.mjs', {last_assistant_message: '本次工作已完成。'});
  assert.equal(out.systemMessage.split('\n').length, 3);
  assert.match(out.systemMessage, /^AI:/);
  assert.match(out.systemMessage, /本 session 有 2 項/);
  const details = readFileSync(path.resolve(root,out.systemMessage.split('Details: ')[1]), 'utf8');
  assert.match(details, /feature\/own/);
  assert.match(details, /bugfix\/merged-own/);
  assert.equal(existsSync(path.join(root, 'gh.log')), false);
  assert.equal(run('recap-check.mjs', {last_assistant_message: '本次工作已完成。'}), null);
});
test('other session on same or different branch and missing ID cannot consume own closeout', () => {
  own(); own('bugfix/merged-own', true);
  const before = readFileSync(workFile(), 'utf8');
  assert.equal(run('recap-check.mjs', {last_assistant_message: '本次工作已完成。'}, b), null);
  assert.equal(run('recap-check.mjs', {last_assistant_message: '本次工作已完成。'}, null), null);
  assert.equal(readFileSync(workFile(), 'utf8'), before);
  assert.ok(run('recap-check.mjs', {last_assistant_message: '本次工作已完成。'}));
});
test('SessionStart resume restores silently and does not consume same-session pending', () => {
  own(); own('bugfix/merged-own', true);
  const before = readFileSync(workFile(), 'utf8');
  const output = run('session-start.mjs', {source: 'resume'});
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /feature\/own|bugfix\/merged-own|跨 session Recap/);
  assert.equal(readFileSync(workFile(), 'utf8'), before);
  assert.ok(run('recap-check.mjs', {last_assistant_message: '本次工作已完成。'}));
});
test('UserPromptSubmit actual end shares scoped compact format; intermediate prompts remain silent', () => {
  own(); own('bugfix/merged-own', true);
  const before = readFileSync(workFile(), 'utf8');
  assert.equal(run('user-prompt-gate.mjs', {prompt: '繼續下一個步驟'}), null);
  assert.equal(run('user-prompt-gate.mjs', {prompt: 'bye'}, b), null);
  assert.equal(readFileSync(workFile(), 'utf8'), before);
  const context = run('user-prompt-gate.mjs', {prompt: 'bye'}).hookSpecificOutput.additionalContext;
  assert.equal(context.split('\n').length, 3);
  assert.match(context, /^AI:/);
});

test('missing ID has repo-local non-injected diagnostics and leaves foreign pending untouched', () => {
  own();
  const before=readFileSync(workFile(),'utf8');
  assert.equal(run('recap-check.mjs',{last_assistant_message:'本次工作已完成。'},null),null);
  assert.equal(run('user-prompt-gate.mjs',{prompt:'bye'},null),null);
  const file=path.join(root,'diagnostics','reminder-events.log');
  assert.equal(existsSync(file),true);
  const entries=readFileSync(file,'utf8').trim().split('\n').map((line)=>JSON.parse(line));
  assert.equal(entries.length,2);
  assert.deepEqual(entries.map((entry)=>entry.kind),['recap-stop','recap-user-end']);
  for(const entry of entries) {
    assert.equal(entry.reason,'missing-session-identity');
    assert.equal(entry.status,'not-checked');
    assert.equal('sessionKey' in entry,false);
  }
  assert.equal(readFileSync(workFile(),'utf8'),before);
  assert.equal(existsSync(path.join(root,'gh.log')),false);
});
