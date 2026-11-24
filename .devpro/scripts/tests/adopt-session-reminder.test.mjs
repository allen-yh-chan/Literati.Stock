import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { adoptSessionReminder } from '../adopt-session-reminder.mjs';
import { spawnSync } from 'node:child_process';
import { envWithoutHostMarkers } from './lib/host-session-env.mjs';
import { repoPath } from './lib/repo-root.mjs';
import { resolveReminderSession } from '../hooks/lib/session-reminder.mjs';
import { writePostPrCompletionMarker } from '../hooks/lib/post-pr-completion-state.mjs';

test('explicit adoption subscribes a new session without stealing or overwriting the authority', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adopt-reminder-'));
  const prior = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = dir;
  try {
    const first = resolveReminderSession({ session_id: 'first' }, {DEVPRO_HOOK_HOST:'codex'});
    const second = resolveReminderSession({ session_id: 'second' }, {DEVPRO_HOOK_HOST:'codex'});
    const file = writePostPrCompletionMarker({ cwd: dir, prNumber: '42', branch: 'feature/shared', session: first });
    const before = readFileSync(file, 'utf8');
    assert.throws(() => adoptSessionReminder({ cwd: dir, prNumber: '42' }), /Missing runtime session ID/);
    assert.deepEqual(adoptSessionReminder({ cwd: dir, prNumber: '42', session: second }), { adopted: true, kind: 'post-pr', target: '42' });
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    if (prior === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR; else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects a session ID without trusted host instead of adopting into an unknown namespace', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adopt-host-required-'));
  try {
    const result = spawnSync(process.execPath, [repoPath('.devpro/scripts/adopt-session-reminder.mjs'), '--recap', 'feature/host-required', '--session-id', 'actual-id', '--cwd', dir], {
      encoding: 'utf8', cwd: dir, env: {...envWithoutHostMarkers(process.env), DEVPRO_SESSION_REMINDER_STATE_DIR: path.join(dir, 'sessions')},
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /trusted.*host.*--host/i);
    assert.equal(result.stdout, '');
  } finally {rmSync(dir, {recursive:true, force:true});}
});

test('adopt CLI roundtrips through actual run-hook host identity and cannot consume another session', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adopt-hook-roundtrip-'));
  const base = {...envWithoutHostMarkers(process.env), DEVPRO_SESSION_REMINDER_STATE_DIR:path.join(dir,'sessions'), DEVPRO_RECAP_WRITTEN_DIR:path.join(dir,'written'), DEVPRO_AGENT_RULES_LEVEL:'full'};
  try {
    for (const [host,id,hostArgs,extraEnv] of [
      ['claude-code','payload-id',['--session-id','payload-id','--host','claude-code'],{}],
      ['codex','env-id',[],{CODEX_THREAD_ID:'env-id'}],
    ]) {
      const branch=`feature/cli-${host}`;
      const adopted=spawnSync(process.execPath,[repoPath('.devpro/scripts/adopt-session-reminder.mjs'),'--recap',branch,'--cwd',dir,...hostArgs],{cwd:dir,encoding:'utf8',env:{...base,...extraEnv}});
      assert.equal(adopted.status,0,adopted.stderr);
      const owner=resolveReminderSession({session_id:id},{DEVPRO_HOOK_HOST:host});
      const file=path.join(base.DEVPRO_SESSION_REMINDER_STATE_DIR,owner.key,'recap-work.json');
      assert.equal(existsSync(file),true);
      const before=readFileSync(file,'utf8');
      function stop(sessionId) {
        return spawnSync(process.execPath,[repoPath('.devpro/scripts/hooks/run-hook.mjs'),'Stop',repoPath('.devpro/scripts/hooks/recap-check.mjs'),`--host=${host}`],{cwd:dir,encoding:'utf8',env:base,input:JSON.stringify({cwd:dir,session_id:sessionId,last_assistant_message:'本次工作已完成。'})});
      }
      const foreign=stop('different-session');
      assert.equal(foreign.status,0,foreign.stderr);
      assert.equal(foreign.stdout,'');
      assert.equal(readFileSync(file,'utf8'),before);
      const own=stop(id);
      assert.equal(own.status,0,own.stderr);
      assert.match(JSON.parse(own.stdout).systemMessage,/本 session 有 1 項/);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('adopt CLI missing ID or explicit unknown host creates no session state', () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'adopt-cli-invalid-'));
  const env={...envWithoutHostMarkers(process.env),DEVPRO_SESSION_REMINDER_STATE_DIR:path.join(dir,'sessions')};
  try {
    for (const [args,error] of [[['--host','claude-code'],/session ID/],[['--session-id','id','--host','unknown'],/trusted.*host.*--host/i]]) {
      const result=spawnSync(process.execPath,[repoPath('.devpro/scripts/adopt-session-reminder.mjs'),'--recap','feature/invalid','--cwd',dir,...args],{cwd:dir,encoding:'utf8',env});
      assert.equal(result.status,1);
      assert.match(result.stderr,error);
      assert.equal(result.stdout,'');
      assert.equal(existsSync(env.DEVPRO_SESSION_REMINDER_STATE_DIR),false);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('explicit Recap adoption requires a PR for a repository and stores both together', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adopt-scoped-recap-'));
  try {
    const env = {...envWithoutHostMarkers(process.env), DEVPRO_SESSION_REMINDER_STATE_DIR: path.join(dir, 'sessions')};
    const args = [repoPath('.devpro/scripts/adopt-session-reminder.mjs'), '--recap', 'feature/hub', '--session-id', 'owner', '--host', 'codex', '--repo'];
    const invoke = (...target) => spawnSync(process.execPath, [...args, ...target], {cwd: dir, encoding: 'utf8', env});
    const missing = invoke('github.com/fixture/project');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--repo requires.*--pr-number/);
    const unsupported = invoke('git.example.invalid/fixture/project', '--pr-number', '42');
    assert.equal(unsupported.status, 1);
    assert.equal(existsSync(env.DEVPRO_SESSION_REMINDER_STATE_DIR), false);
    const accepted = invoke('GitHub.com/Fixture/Project', '--pr-number', '42');
    assert.equal(accepted.status, 0, accepted.stderr);
    const session = resolveReminderSession({session_id: 'owner'}, {DEVPRO_HOOK_HOST: 'codex'});
    const [record] = JSON.parse(readFileSync(path.join(env.DEVPRO_SESSION_REMINDER_STATE_DIR, session.key, 'recap-work.json'), 'utf8'));
    assert.equal(record.repo, 'github.com/fixture/project');
    assert.equal(record.prNumber, '42');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
