import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { repoPath } from './lib/repo-root.mjs';
import { envWithoutHostMarkers } from './lib/host-session-env.mjs';
import { resolveReminderSession } from '../hooks/lib/session-reminder.mjs';
import { postPrMarkerFilenames } from '../hooks/lib/post-pr-completion-state.mjs';
const dir = mkdtempSync(path.join(os.tmpdir(), 'post-tool-reminder-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const repo = path.join(dir, 'repo'); mkdirSync(repo);
for (const args of [['init', '-q', '-b', 'feature/test-reminder'], ['remote', 'add', 'origin', 'https://github.com/fixture/project.git'], ['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture']]) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const hash = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
const env = { ...envWithoutHostMarkers(process.env), DEVPRO_HOOK_HOST: 'codex', DEVPRO_AGENT_RULES_LEVEL: 'lite', DEVPRO_SESSION_REMINDER_STATE_DIR: path.join(dir, 'reminders'), DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(dir, 'post-pr'), DEVPRO_RECAP_WRITTEN_DIR: path.join(dir, 'written') };
const session = resolveReminderSession({ session_id: 'owner' }, env);
const workFile = path.join(env.DEVPRO_SESSION_REMINDER_STATE_DIR, session.key, 'recap-work.json');
function run(command, response, envOverride = {}, payloadOverride = {}) {
  const result = spawnSync(process.execPath, [repoPath('.devpro/scripts/hooks/post-tool-gate.mjs')], {
    cwd: repo, env: { ...env, ...envOverride }, encoding: 'utf8', input: JSON.stringify({ session_id: 'owner', cwd: repo, tool_name: 'Bash', tool_input: { command }, tool_response: response, ...payloadOverride }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /post-commit advisory failed|post-pr marker write failed|hook error/i);
  return result;
}
test('PostToolUse uses payload identity and records only confirmed work/Discussion facts', () => {
  run('git commit -m fixture', { exit_code: 1, stdout: `[feature/test-reminder ${hash}] fixture` });
  assert.equal(existsSync(workFile), false);
  run('git commit -m fixture', { exit_code: 0, stdout: `[feature/test-reminder ${hash}] fixture` });
  assert.equal(JSON.parse(readFileSync(workFile)).length, 1);
  run('gh pr create --head feature/test-reminder', { exit_code: 0, stdout: 'https://github.com/fixture/project/pull/42' });
  const [name] = postPrMarkerFilenames({ repo: 'fixture/project', prNumber: '42' });
  const marker = JSON.parse(readFileSync(path.join(env.DEVPRO_POST_PR_COMPLETION_STATE_DIR, name)));
  assert.equal(marker.sessionId, 'owner');
  assert.equal(JSON.parse(readFileSync(workFile))[0].prNumber, '42');
  const snapshot = (state) => ({ CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({ state, headRefName: 'feature/test-reminder', baseRefName: 'main', url: 'https://github.com/fixture/project/pull/42' }) });
  run('gh pr merge 42 --merge', { exit_code: 1 }, snapshot('MERGED'));
  assert.equal(JSON.parse(readFileSync(workFile))[0].merged, false);
  run('gh pr merge 42 --auto', { exit_code: 0 }, snapshot('OPEN'));
  assert.equal(JSON.parse(readFileSync(workFile))[0].merged, false);
  run('gh pr merge 42 --merge', { exit_code: 0 }, snapshot('MERGED'));
  assert.equal(JSON.parse(readFileSync(workFile))[0].merged, true);
  const command = 'gh api graphql -F title="[fixture] test-reminder 2026-10-06"';
  run(command, { exit_code: 0, stdout: JSON.stringify({ errors: [{ message: 'failed' }] }) });
  assert.equal(existsSync(env.DEVPRO_RECAP_WRITTEN_DIR), false);
  run(command, { exit_code: 0, stdout: JSON.stringify({ data: { createDiscussion: { discussion: { id: 'D_fixture' } } } }) });
  assert.equal(existsSync(path.join(env.DEVPRO_RECAP_WRITTEN_DIR, 'test-reminder')), true);
  // An unknown-PR success fact must not clear the known PR42 obligation.
  assert.equal(JSON.parse(readFileSync(workFile)).length, 1);
  run(command, { exit_code: 0, stdout: JSON.stringify({ data: { createDiscussion: { discussion: { id: 'D_fixture_42', body: 'PR: https://github.com/fixture/project/pull/42' } } } }) });
  assert.equal(JSON.parse(readFileSync(workFile)).length, 0);
  run('gh pr create --head feature/test-reminder', { exit_code: 0, stdout: 'https://github.com/fixture/project/pull/43' });
  assert.equal(JSON.parse(readFileSync(workFile))[0].prNumber, '43');
  run(command, { exit_code: 0, stdout: JSON.stringify({ data: { createDiscussion: { discussion: {
    id: 'D_other_change',
    body: '## Branch\nfeature/another-change (PR #43, merged → main)\n\nSupplement: https://github.com/fixture/project/pull/43',
  } } } }) });
  assert.equal(JSON.parse(readFileSync(workFile)).length, 1, 'a mismatched canonical Branch must not fall back to supplemental links');
  run(command, { exit_code: 0, stdout: JSON.stringify({ data: { createDiscussion: { discussion: {
    id: 'D_fixture_43',
    body: '## Branch\nfeature/test-reminder (PR #43, merged → main)\nhttps://github.com/fixture/project/pull/43\n\n## 完成項\nSupplement: https://github.com/fixture/project/pull/42',
  } } } }) });
  assert.equal(existsSync(path.join(env.DEVPRO_RECAP_WRITTEN_DIR, 'test-reminder--pr-43')), false);
  assert.equal(JSON.parse(readFileSync(workFile)).length, 0);
});

test('successful missing-ID tool paths diagnose without creating Recap work; failures do not fabricate diagnostics', () => {
  const diagnostics=path.join(dir,'missing-id-diagnostics');
  const ownBefore=readFileSync(workFile,'utf8');
  const overrides={DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR:diagnostics};
  const missing={session_id:undefined};
  run('git commit -m fixture',{exit_code:1,stdout:`[feature/test-reminder ${hash}] fixture`},overrides,missing);
  run('gh pr merge 42 --merge',{exit_code:1},overrides,missing);
  assert.equal(existsSync(path.join(diagnostics,'reminder-events.log')),false);
  assert.equal(run('git commit -m fixture',{exit_code:0,stdout:`[feature/test-reminder ${hash}] fixture`},overrides,missing).stdout,'');
  assert.equal(run('gh pr create --head feature/test-reminder',{exit_code:0,stdout:'https://github.com/fixture/project/pull/99'},overrides,missing).stdout,'');
  assert.equal(run('gh pr merge 99 --merge',{exit_code:0},overrides,missing).stdout,'');
  const file=path.join(diagnostics,'reminder-events.log');
  assert.equal(existsSync(file),true);
  const entries=readFileSync(file,'utf8').trim().split('\n').map((line)=>JSON.parse(line));
  assert.deepEqual(entries.map((entry)=>entry.kind),['recap-post-tool-commit','recap-post-tool-pr-create','recap-post-tool-pr-merge']);
  for(const entry of entries) assert.equal(entry.reason,'missing-session-identity');
  assert.equal(readFileSync(workFile,'utf8'),ownBefore);
});

test('ambiguous same-number links cannot close either repo in the same session', () => {
  const payload = {session_id: 'hub'};
  const hub = resolveReminderSession(payload, env);
  const hubFile = path.join(env.DEVPRO_SESSION_REMINDER_STATE_DIR, hub.key, 'recap-work.json');
  for (const name of ['alpha', 'bravo']) {
    run('gh pr create --head feature/test-reminder', {exit_code: 0, stdout: `https://github.com/fixture/${name}/pull/74`}, {}, payload);
  }
  const snapshot = (name) => ({CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({state: 'MERGED', headRefName: 'feature/test-reminder', baseRefName: 'main', url: `https://github.com/fixture/${name}/pull/74`})});
  const beforeMerge = readFileSync(hubFile, 'utf8');
  const wrongMerge = run('gh pr merge 74 --repo github.com/fixture/alpha --merge', {exit_code: 0}, snapshot('bravo'), payload);
  assert.match(wrongMerge.stderr, /Recap PR identity.*does not match/i);
  assert.equal(readFileSync(hubFile, 'utf8'), beforeMerge);
  const trace = path.join(dir, 'merge-trace.jsonl');
  run('gh pr merge https://github.com/fixture/alpha/pull/74 --merge', {exit_code: 0}, {
    ...snapshot('alpha'), CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: trace,
  }, payload);
  assert.equal(JSON.parse(readFileSync(trace, 'utf8').trim()).repo, 'github.com/fixture/alpha');
  const before = readFileSync(hubFile, 'utf8');
  assert.deepEqual(JSON.parse(before).map(({repo, merged}) => [repo, merged]), [
    ['github.com/fixture/alpha', true], ['github.com/fixture/bravo', false],
  ]);
  const bodyFile = path.join(dir, 'hub-recap.md');
  const command = `gh api graphql -F title="[fixture] test-reminder 2026-10-06" -F body=@${bodyFile} -f query='mutation { createDiscussion(input: {}) { discussion { url } } }'`;
  const body = '## Branch\nfeature/test-reminder (PR #74, merged → main)\n';
  const confirmed = {exit_code: 0, stdout: JSON.stringify({data: {createDiscussion: {discussion: {id: 'D_hub'}}}})};
  function preCommand(command) {
    const result = spawnSync(process.execPath, [repoPath('.devpro/scripts/hooks/pre-tool-gate.mjs')], {
      cwd: repo, env: {...env, DEVPRO_AGENT_RULES_LEVEL: 'full'}, encoding: 'utf8',
      input: JSON.stringify({...payload, cwd: repo, tool_name: 'Bash', tool_input: {command}}),
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  function preTool(links) {
    writeFileSync(bodyFile, body + links);
    return preCommand(command);
  }
  assert.match(preTool('https://github.com/fixture/alpha/pull/74\nhttps://github.com/fixture/bravo/pull/74'), /Recap PR identity.*ambiguous/i);
  assert.equal(readFileSync(hubFile, 'utf8'), before);
  const conflict = run(command, confirmed, {}, payload);
  assert.match(conflict.stderr, /Recap PR identity.*ambiguous/i);
  assert.equal(readFileSync(hubFile, 'utf8'), before);
  assert.match(preTool('github.com/fixture/alpha/pull/74'), /Recap PR identity.*cannot verify/i);
  assert.match(run(command, confirmed, {}, payload).stderr, /Recap PR identity.*cannot verify/i);
  assert.equal(readFileSync(hubFile, 'utf8'), before);
  assert.match(preTool('https://github.com/fixture/alpha/pull/75'), /Recap PR identity.*different PR number/i);
  assert.match(run(command, confirmed, {}, payload).stderr, /Recap PR identity.*different PR number/i);
  const inline = command.replace(`-F body=@${bodyFile}`, "-F body='https://github.com/fixture/alpha/pull/74 https://github.com/fixture/bravo/pull/74'");
  assert.match(preCommand(inline), /Recap PR identity.*ambiguous/i);
  assert.match(run(inline, confirmed, {}, payload).stderr, /Recap PR identity.*ambiguous/i);
  rmSync(bodyFile);
  assert.match(preCommand(command), /Recap PR identity.*cannot read/i);
  assert.match(run(command, confirmed, {}, payload).stderr, /Recap PR identity.*cannot read/i);
  assert.equal(readFileSync(hubFile, 'utf8'), before);
  preTool('https://github.com/fixture/alpha/pull/74');
  assert.deepEqual(JSON.parse(readFileSync(hubFile, 'utf8')).map((item) => Boolean(item.inProgressAt)), [true, false]);
  const afterLease = readFileSync(hubFile, 'utf8');
  const rejected = {exit_code: 0, stdout: JSON.stringify({errors: [{message: 'not created'}]})};
  run(command, rejected, {}, payload);
  const disputed = {exit_code: 0, stdout: JSON.stringify({data: {createDiscussion: {discussion: {
    id: 'D_hub', body: body + 'https://github.com/fixture/alpha/pull/74\nhttps://github.com/fixture/bravo/pull/74',
  }}}})};
  assert.match(run(command, disputed, {}, payload).stderr, /Recap PR identity.*ambiguous/i);
  assert.equal(readFileSync(hubFile, 'utf8'), afterLease);
  run(command, confirmed, {}, payload);
  assert.deepEqual(JSON.parse(readFileSync(hubFile, 'utf8')).map((record) => record.repo), ['github.com/fixture/bravo']);
});

test('PostToolUse consumes classification CLI metadata only after successful work and only in its owner session', () => {
  function checkout(branch) {
    const result=spawnSync('git',['checkout','-b',branch],{cwd:repo,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  }
  function classify(branch,classification,id='owner') {
    const result=spawnSync(process.execPath,[repoPath('.devpro/scripts/record-session-change-classification.mjs'),'--branch',branch,'--classification',classification,'--session-id',id,'--cwd',repo],{cwd:repo,encoding:'utf8',env});
    assert.equal(result.status,0,result.stderr);
  }
  checkout('chore/local-classification');
  const before=readFileSync(workFile,'utf8');
  classify('chore/local-classification','B');
  assert.equal(readFileSync(workFile,'utf8'),before,'classification does not create or alter work');
  run('git commit -m fixture',{exit_code:1,stdout:`[chore/local-classification ${hash}] fixture`});
  assert.equal(readFileSync(workFile,'utf8'),before);
  run('git commit -m fixture',{exit_code:0,stdout:`[chore/local-classification ${hash}] fixture`});
  assert.equal(JSON.parse(readFileSync(workFile,'utf8')).find((item)=>item.branch==='chore/local-classification').classification,'B');
  checkout('chore/foreign-classification');
  classify('chore/foreign-classification','B','foreign');
  const ownBefore=readFileSync(workFile,'utf8');
  run('git commit -m fixture',{exit_code:0,stdout:`[chore/foreign-classification ${hash}] fixture`});
  assert.equal(readFileSync(workFile,'utf8'),ownBefore,'foreign classification is not inherited');
  run('git commit -m fixture',{exit_code:0,stdout:`[chore/foreign-classification ${hash}] fixture`},{},{chore_classification:'B-mini'});
  assert.equal(JSON.parse(readFileSync(workFile,'utf8')).find((item)=>item.branch==='chore/foreign-classification').classification,'B-mini');
  checkout('chore/classified-a');
  classify('chore/classified-a','A');
  const nonAWork=readFileSync(workFile,'utf8');
  run('git commit -m fixture',{exit_code:0,stdout:`[chore/classified-a ${hash}] fixture`});
  assert.equal(readFileSync(workFile,'utf8'),nonAWork,'explicit A remains excluded');
});
