import {test, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {repoPath} from './lib/repo-root.mjs';
import {envWithoutHostMarkers} from './lib/host-session-env.mjs';
import {resolveReminderSession} from '../hooks/lib/session-reminder.mjs';
const root = mkdtempSync(path.join(os.tmpdir(), 'session-classification-'));
const state = path.join(root, 'sessions');
process.env.DEVPRO_SESSION_REMINDER_STATE_DIR = state;
process.env.DEVPRO_RECAP_WRITTEN_DIR = path.join(root, 'written');
const recap = await import('../hooks/lib/recap-utils.mjs');
const env = {...envWithoutHostMarkers(process.env), DEVPRO_SESSION_REMINDER_STATE_DIR: state, DEVPRO_RECAP_WRITTEN_DIR: path.join(root, 'written'), DEVPRO_AGENT_RULES_LEVEL: 'full'};
const a = resolveReminderSession({session_id:'classifier-a'}, {DEVPRO_HOOK_HOST:'claude-code'});
const b = resolveReminderSession({session_id:'classifier-b'}, {DEVPRO_HOOK_HOST:'claude-code'});
beforeEach(() => rmSync(state, {recursive:true, force:true}));
after(() => rmSync(root, {recursive:true, force:true}));
function classify(branch, classification, extraArgs=[], extraEnv={}) {
  return spawnSync(process.execPath, [repoPath('.devpro/scripts/record-session-change-classification.mjs'), '--branch', branch, '--classification', classification, '--cwd', root, ...extraArgs], {encoding:'utf8',cwd:root,env:{...env,...extraEnv}});
}
test('classification producer records only owned metadata; successful own work consumes it', async () => {
  const result = classify('chore/observed', 'B', ['--session-id',a.sessionId,'--host','claude-code']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(state,a.key,'recap-work.json')), false);
  const before = readdirSync(path.join(state,a.key));
  assert.equal((await recap.evaluateRecapState({cwd:root,session:a})).skip, true);
  assert.equal(recap.recordRecapWork({cwd:root,session:b,branch:'chore/observed',commit:'abc'}), false);
  assert.equal(recap.recordRecapWork({cwd:root,session:a,branch:'chore/unclassified',commit:'abc'}), false);
  assert.equal(recap.recordRecapWork({cwd:root,session:a,branch:'chore/observed',commit:'abc'}), true);
  assert.equal((await recap.evaluateRecapState({cwd:root,session:a})).pending[0].classification, 'B');
  assert.equal(before.length, 1);
});
test('explicit A overrides local B; local A excludes work; B-mini is eligible', () => {
  for (const [branch,classification] of [['chore/a','A'],['chore/mini','B-mini'],['chore/payload','B']]) {
    assert.equal(classify(branch,classification,['--session-id',a.sessionId,'--host','claude-code']).status,0);
  }
  assert.equal(recap.recordRecapWork({cwd:root,session:a,branch:'chore/a',commit:'abc'}),false);
  assert.equal(recap.adoptRecapWork({cwd:root,session:a,branch:'chore/a'}),false);
  assert.equal(recap.recordRecapWork({cwd:root,session:a,branch:'chore/payload',commit:'abc',classification:'A'}),false);
  assert.equal(recap.recordRecapWork({cwd:root,session:a,branch:'chore/mini',commit:'abc'}),true);
});
test('missing identity/host is diagnostic-only, exits zero, and never mutates foreign state', () => {
  assert.equal(classify('chore/foreign','B',['--session-id',b.sessionId,'--host','claude-code']).status,0);
  const dir=path.join(state,b.key);
  const files=readdirSync(dir);
  const before=files.map((name)=>readFileSync(path.join(dir,name),'utf8'));
  const diagnostics=path.join(root,'diagnostics');
  for(const [args,reason] of [[[],'missing-session-identity'],[['--session-id',a.sessionId],'missing-runtime-host']]) {
    const result=classify('chore/missing','B',args,{DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR:diagnostics});
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stderr,'');
    assert.deepEqual(JSON.parse(result.stdout),{recorded:false,status:'not-checked',reason});
  }
  assert.deepEqual(readdirSync(state),[b.key]);
  assert.deepEqual(files.map((name)=>readFileSync(path.join(dir,name),'utf8')),before);
  assert.equal(existsSync(path.join(dir,'recap-work.json')),false);
  const entries=readFileSync(path.join(diagnostics,'reminder-events.log'),'utf8').trim().split('\n').map((line)=>JSON.parse(line));
  assert.deepEqual(entries.slice(-2).map((entry)=>[entry.kind,entry.reason,entry.status]),[
    ['change-classification','missing-session-identity','not-checked'],
    ['change-classification','missing-runtime-host','not-checked'],
  ]);
});
test('a diagnostic that cannot be written never turns a missing identity into a failure', () => {
  const blocker=path.join(root,'diagnostic-blocker');
  writeFileSync(blocker,'not a directory');
  const result=classify('chore/missing','B',[],{DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR:path.join(blocker,'diagnostics')});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stderr,'');
  assert.deepEqual(JSON.parse(result.stdout),{recorded:false,status:'not-checked',reason:'missing-session-identity'});
  assert.equal(readFileSync(blocker,'utf8'),'not a directory');
  assert.equal(existsSync(state),false);
});
test('invalid branch/classification/options and storage errors remain failures, even without identity', () => {
  for(const [branch,classification,error] of [['chore/missing','C',/classification/],['feature/wrong','B',/chore/]]) {
    const result=classify(branch,classification);
    assert.equal(result.status,1);
    assert.match(result.stderr,error);
    assert.equal(result.stdout,'');
  }
  const badOption=classify('chore/valid','B',['--invalid','value']);
  assert.equal(badOption.status,1);
  assert.match(badOption.stderr,/Invalid argument/);
  const blocked=path.join(root,'blocked-state');
  writeFileSync(blocked,'not a directory');
  const storage=classify('chore/valid','B',['--session-id',a.sessionId,'--host','claude-code'],{DEVPRO_SESSION_REMINDER_STATE_DIR:blocked});
  assert.equal(storage.status,1);
  assert.match(storage.stderr,/state write access/);
  assert.equal(storage.stdout,'');
});
test('main checkout classification feeds successful worktree PostToolUse naturally; lite still suppresses automatic Recap', () => {
  const main=path.join(root,'main-checkout');
  const worktree=path.join(main,'.worktree','chore-meta');
  mkdirSync(main);
  const naturalEnv={...envWithoutHostMarkers(process.env),DEVPRO_HOOK_HOST:'codex',DEVPRO_AGENT_RULES_LEVEL:'lite'};
  for(const key of Object.keys(naturalEnv)) if (/_STATE_DIR$/.test(key)||/^DEVPRO_RECAP_.*_DIR$/.test(key)||key==='DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR') delete naturalEnv[key];
  function git(args,cwd=main) {
    const r=spawnSync('git',args,{cwd,encoding:'utf8',env:naturalEnv});
    assert.equal(r.status,0,r.stderr);
    return r;
  }
  git(['init','-q','-b','main']);
  git(['config','user.name','fixture']);
  git(['config','user.email','fixture@example.invalid']);
  git(['commit','--allow-empty','-m','init']);
  git(['worktree','add','-b','chore/shared-meta',worktree]);
  const identity=resolveReminderSession({session_id:'natural-session'},{DEVPRO_HOOK_HOST:'codex'});
  const local=path.join(main,'notes','tmp','state','devpro-session-reminders',identity.key);
  const result=spawnSync(process.execPath,[repoPath('.devpro/scripts/record-session-change-classification.mjs'),'--branch','chore/shared-meta','--classification','B','--session-id',identity.sessionId,'--cwd',main],{cwd:main,encoding:'utf8',env:naturalEnv});
  assert.equal(result.status,0,result.stderr);
  const file=path.join(local,'recap-work.json');
  assert.equal(existsSync(file),false,'classification alone creates no obligation');
  const commit=git(['commit','--allow-empty','-m','own-work'],worktree);
  const payload={session_id:identity.sessionId,cwd:worktree,tool_name:'Bash',tool_input:{command:'git commit --allow-empty -m own-work'},tool_response:{exit_code:0,stdout:commit.stdout}};
  const post=spawnSync(process.execPath,[repoPath('.devpro/scripts/hooks/run-hook.mjs'),'PostToolUse',repoPath('.devpro/scripts/hooks/post-tool-gate.mjs'),'--host=codex'],{cwd:worktree,encoding:'utf8',env:naturalEnv,input:JSON.stringify(payload)});
  assert.equal(post.status,0,post.stderr);
  const before=readFileSync(file,'utf8');
  assert.equal(JSON.parse(before)[0].classification,'B');
  assert.equal(JSON.parse(before)[0].branch,'chore/shared-meta');
  assert.equal(existsSync(path.join(worktree,'notes','tmp','state','devpro-session-reminders')),false,'state stays at the natural shared main root');
  const stop=spawnSync(process.execPath,[repoPath('.devpro/scripts/hooks/run-hook.mjs'),'Stop',repoPath('.devpro/scripts/hooks/recap-check.mjs'),'--host=codex'],{cwd:worktree,encoding:'utf8',env:naturalEnv,input:JSON.stringify({session_id:identity.sessionId,cwd:worktree,last_assistant_message:'本次工作已完成。'})});
  assert.equal(stop.status,0,stop.stderr);
  assert.equal(stop.stdout,'','lite does not automatically inject Recap');
  assert.equal(readFileSync(file,'utf8'),before,'lite no-op does not consume own dedup');
});
