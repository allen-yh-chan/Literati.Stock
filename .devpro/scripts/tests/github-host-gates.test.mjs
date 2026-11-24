import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateGithubMcpPayload } from '../hooks/github-mcp-gate.mjs';
import { probeGhAuthentication } from '../lib/github-tool-routing.mjs';
import { devproGithubToolName, isGithubWritePayload } from '../hooks/lib/github-mcp-tools.mjs';
import { createDevproPluginHooks, mapOpenCodeToolToProtocol } from '../../../.opencode/plugins/devpro-hooks.js';
import { createGithubOpenCodePlugin } from '../hooks/github-opencode-plugin.mjs';
import { githubCheckFromResponse, githubCreatedPrFromResponse, saveGithubCapabilities, readGithubCapabilities, saveGithubCheck, readGithubCheck,
  githubCapabilitiesAgeMs, GITHUB_CAPABILITIES_TTL_MS, GITHUB_CHECK_TTL_MS } from '../hooks/lib/github-check-cache.mjs';
import { evaluateGithubClientPolicy } from '../hooks/lib/github-client-policy.mjs';
import { readCanonicalAgentsMdVersion } from '../hooks/lib/git-utils.mjs';

const root=path.resolve(import.meta.dirname,'../../..');
const input={tool_name:'mcp__devpro_work__github_create_issue',cwd:root,
  tool_input:{repository:'org/repo',title:'Issue',body:`Description\nRules: v${readCanonicalAgentsMdVersion(root)?.version} · Tool: Codex · Model: GPT-6`}};
const capabilities=()=>({ready:true,protocol:1,capabilities:['github_create_issue']});
const missing=()=>({installed:false,authentication:'not_logged_in'});
test('shell failure classification covers cmd aliases and escaped newlines',()=>{
  for(const command of ['git push origin HEAD','git \\\n push origin HEAD','gh issue \\\n create --body bad']) {
    assert.equal(isGithubWritePayload({tool_input:{cmd:command}}),true);
  }
  assert.equal(isGithubWritePayload({tool_input:{command:'git status'}}),false);
});
test('owner adapter sends cmd aliases and continued commands through the real body gate',()=>{
  for(const field of ['command','cmd']) {
    const command='gh issue \\\n create --body bad';
    const result=spawnSync(process.execPath,[path.join(root,'.devpro/scripts/hooks/github-owner-gate.mjs')],{
      cwd:root,input:JSON.stringify({tool_name:'Bash',cwd:root,tool_input:{[field]:command}}),encoding:'utf8',
      env:{...process.env,DEVPRO_HOOK_EVENT:'PreToolUse'},timeout:45000});
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,'deny');
  }
});
test('refreshing backend capabilities revokes the old observation before an RPC can fail',()=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'github-capability-refresh-'));
  try {
    saveGithubCapabilities(cwd,{protocol:1,ready:true,artifactSha256:'a'.repeat(64),capabilities:['github_create_issue']});
    assert.ok(readGithubCapabilities(cwd));
    const query={tool_name:'mcp__devpro_work__github_policy_status',tool_input:{},cwd};
    assert.equal(evaluateGithubMcpPayload(query,{probe:missing}),null);
    // No successful PostToolUse arrives when the RPC fails or the backend is old.
    const write=evaluateGithubMcpPayload({...input,cwd},{probe:missing,local:()=>({allowed:true})});
    assert.equal(write?.hookSpecificOutput?.permissionDecision,'deny');
    assert.equal(readGithubCapabilities(cwd),null);
    saveGithubCapabilities(cwd,{protocol:1,ready:true,artifactSha256:'b'.repeat(64),capabilities:['github_create_issue']});
    assert.equal(evaluateGithubMcpPayload({...input,cwd},{probe:missing,local:()=>({allowed:true})}),null);
  } finally {rmSync(cwd,{recursive:true,force:true});}
});
// fix-github-capability-ttl (AuthBroker #2): the capability observation lasts 10 minutes, the PR check stays 120 s.
test('capability observation lasts 10 minutes while the PR check keeps its 120 s window',()=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'github-capability-ttl-'));
  try {
    assert.equal(GITHUB_CAPABILITIES_TTL_MS,10*60000);
    assert.equal(GITHUB_CHECK_TTL_MS,120000);
    const now=Date.now();
    saveGithubCapabilities(cwd,{protocol:1,ready:true,artifactSha256:'a'.repeat(64),capabilities:['github_create_issue']},now-9*60000);
    assert.ok(readGithubCapabilities(cwd,now),'a 9-minute-old observation is still usable');
    assert.equal(evaluateGithubMcpPayload({...input,cwd},{probe:missing,local:()=>({allowed:true})}),null);
    assert.equal(readGithubCapabilities(cwd,now+2*60000),null,'an 11-minute-old observation is expired');
    const head='c'.repeat(40);
    saveGithubCheck(cwd,{protocol:1,repository:'org/repo',number:7,pr:{head:{sha:head}},policy:{allowed:true}},now-3*60000);
    assert.equal(readGithubCheck(cwd,'org/repo',7,now),null,'a 3-minute-old PR check is expired');
    saveGithubCheck(cwd,{protocol:1,repository:'org/repo',number:7,pr:{head:{sha:head}},policy:{allowed:true}},now-60000);
    assert.ok(readGithubCheck(cwd,'org/repo',7,now));
  } finally {rmSync(cwd,{recursive:true,force:true});}
});
test('an expired capability observation is denied with its age, a missing one without',()=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'github-capability-expired-'));
  try {
    const run=()=>evaluateGithubMcpPayload({...input,cwd},{probe:missing,local:()=>({allowed:true})});
    const never=run();
    assert.equal(never.hookSpecificOutput.permissionDecision,'deny');
    assert.match(never.hookSpecificOutput.permissionDecisionReason,/Run github_policy_status first/);
    assert.doesNotMatch(never.hookSpecificOutput.permissionDecisionReason,/min old/);
    assert.equal(githubCapabilitiesAgeMs(cwd),null);
    saveGithubCapabilities(cwd,{protocol:1,ready:true,artifactSha256:'a'.repeat(64),capabilities:['github_create_issue']},Date.now()-12*60000);
    const expired=run();
    assert.equal(expired.hookSpecificOutput.permissionDecision,'deny');
    assert.match(expired.hookSpecificOutput.permissionDecisionReason,/Run github_policy_status first/);
    assert.match(expired.hookSpecificOutput.permissionDecisionReason,/The last observation is 12 min old; it is valid for 10 min\./);
    // A future-dated record is not an observation at all.
    saveGithubCapabilities(cwd,{protocol:1,ready:true,artifactSha256:'a'.repeat(64),capabilities:['github_create_issue']},Date.now()+60000);
    assert.equal(githubCapabilitiesAgeMs(cwd),null);
    assert.doesNotMatch(run().hookSpecificOutput.permissionDecisionReason,/min old/);
  } finally {rmSync(cwd,{recursive:true,force:true});}
});
// add-github-policy-blockers (AuthBroker #1): the host denial names every independent blocker.
test('the MCP host denial lists the other independent blockers after the first reason',()=>{
  const create={tool_name:'mcp__devpro_work__github_create_pr',cwd:root,tool_input:{repository:'org/repo',head:'review/pr12',baseBranch:'production',body:'no footer'}};
  const listed=()=>({ready:true,protocol:1,capabilities:['github_create_pr']});
  const denied=evaluateGithubMcpPayload(create,{probe:missing,capabilities:listed,local:()=>({allowed:true})});
  assert.equal(denied.hookSpecificOutput.permissionDecision,'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason,/Also blocked by: local_review_branch; production_release_carrier_required\./);
  // A single blocker keeps the old message.
  const single=evaluateGithubMcpPayload({...create,tool_input:{...create.tool_input,head:'feature/x',baseBranch:'main'}},{probe:missing,capabilities:listed,local:()=>({allowed:true})});
  assert.doesNotMatch(single.hookSpecificOutput.permissionDecisionReason,/Also blocked by/);
});
test('local body policy accepts the canonical version and rejects a mismatched footer',()=>{
  const version=readCanonicalAgentsMdVersion(root)?.version;
  assert.ok(version,'fixture checkout must have its canonical rules version');
  const body=`Fixture\nRules: v${version} · Tool: Codex · Model: GPT-6`;
  assert.equal(evaluateGithubClientPolicy({kind:'body',body},{cwd:root}).allowed,true);
  assert.equal(evaluateGithubClientPolicy({kind:'body',body:body.replace(`v${version}`,'v0.0.0')},{cwd:root}).allowed,false);
});
test('Claude PostToolUse text-block arrays preserve the backend capability observation',()=>{
  const status={protocol:1,ready:true,artifactSha256:'a'.repeat(64),capabilities:['github_create_issue']};
  const blocks=[{type:'text',text:JSON.stringify({status:'completed',data:status})}];
  assert.deepEqual(githubCheckFromResponse(blocks),status);
  assert.deepEqual(githubCheckFromResponse({content:blocks}),status);
});
test('PR creation observation accepts Claude blocks but never a failed write result',()=>{
  const pr={number:7,head:{sha:'a'.repeat(40)}};
  for(const wrap of [value=>value,value=>({content:value}),value=>({output:JSON.stringify(value)})]) {
    const blocks=status=>wrap([{type:'text',text:JSON.stringify({status,data:pr})}]);
    assert.deepEqual(githubCreatedPrFromResponse(blocks('completed')),pr);
    assert.equal(githubCreatedPrFromResponse(blocks('outcome_unknown')),null);
  }
});
test('all installer tool prefixes resolve the same typed operation',()=>{
  for(const name of ['mcp__devpro_work__github_merge_pr','mcp__devpro-work__github_merge_pr','devpro-work_github_merge_pr','mcp_devpro_github_merge_pr']) assert.equal(devproGithubToolName(name),'github_merge_pr');
  assert.equal(devproGithubToolName('mcp__other__github_merge_pr'),null);
  for(const file of ['.claude/settings.json','.codex/hooks.json']) {
    const config=JSON.parse(readFileSync(path.join(root,file),'utf8'));
    for(const name of ['mcp__devpro-work__github_merge_pr','mcp__devpro_work__github_merge_pr']) {
      assert.ok(config.hooks.PreToolUse.some(e=>new RegExp(e.matcher).test(name)&&e.hooks.some(h=>h.command.includes('github-mcp-gate.mjs'))));
    }
  }
});
test('authenticated gh wins for MCP reads and explicitly invalid authentication stays blocked',()=>{
  for(const authentication of ['authenticated','invalid']) {
    assert.equal(evaluateGithubMcpPayload({...input,tool_name:'mcp__devpro_work__github_read_pr'},
      {probe:()=>({installed:true,authentication})}).hookSpecificOutput.permissionDecision,'deny');
  }
  assert.equal(evaluateGithubMcpPayload(input,{probe:missing,capabilities,local:()=>({allowed:true})}),null);
  assert.equal(evaluateGithubMcpPayload({...input,tool_input:{...input.tool_input,body:'unfooted'}},{probe:missing}).hookSpecificOutput.permissionDecision,'deny');
  assert.equal(evaluateGithubMcpPayload({...input,tool_name:'mcp__devpro_work__github_unknown_write'},{probe:missing}).hookSpecificOutput.permissionDecision,'deny');
});
test('probe failures reach MCP reads while writes still require backend compatibility and local evidence',()=>{
  for(const result of [
    {status:1,stdout:'',stderr:'unknown flag: --json'},
    {error:{code:'ETIMEDOUT'}},
    {status:0,stdout:'not JSON'},
  ]) {
    const probe=()=>probeGhAuthentication({spawn:()=>result});
    assert.equal(evaluateGithubMcpPayload({...input,tool_name:'mcp_devpro_github_read_pr'},{probe}),null);
    const incompatible=evaluateGithubMcpPayload(input,{probe,capabilities:()=>null});
    assert.equal(incompatible.hookSpecificOutput.permissionDecision,'deny');
    assert.match(incompatible.hookSpecificOutput.permissionDecisionReason,/Run github_policy_status first/);
    let checked=0;
    const denied=evaluateGithubMcpPayload(input,{probe,capabilities,local:()=>{
      checked++;return {allowed:false,reason:'local evidence absent'};
    }});
    assert.equal(checked,1);
    assert.equal(denied.hookSpecificOutput.permissionDecision,'deny');
    assert.equal(denied.hookSpecificOutput.permissionDecisionReason,'local evidence absent');
    assert.equal(evaluateGithubMcpPayload(input,{probe,capabilities}),null);
    const unfooted=evaluateGithubMcpPayload({...input,tool_input:{...input.tool_input,body:'unfooted'}},{probe,capabilities});
    assert.equal(unfooted.hookSpecificOutput.permissionDecision,'deny');
  }
});
test('repository creation needs a backend that lists it and is checked before the RPC',()=>{
  const create={tool_name:'mcp__devpro_work__github_create_repository',cwd:root,tool_input:{repository:'devpro-tw/new-repo',ownerType:'organization'}};
  assert.equal(isGithubWritePayload(create),true);
  // An artifact built before the tool existed does not list it, so the write stays denied.
  const old=evaluateGithubMcpPayload(create,{probe:missing,capabilities});
  assert.match(old.hookSpecificOutput.permissionDecisionReason,/Run github_policy_status first/);
  const listed=()=>({ready:true,protocol:1,capabilities:['github_create_repository']});
  assert.equal(evaluateGithubMcpPayload(create,{probe:missing,capabilities:listed}),null);
  const native=evaluateGithubMcpPayload({...create,tool_input:{...create.tool_input,private:false}},{probe:missing,capabilities:listed});
  assert.equal(native.hookSpecificOutput.permissionDecision,'deny');
  assert.match(native.hookSpecificOutput.permissionDecisionReason,/repository_create_argument_unsupported/);
});
test('branch deletion is checked locally before the RPC and leaves branch evidence to the backend',()=>{
  const del={tool_name:'mcp__devpro_work__github_delete_branch',cwd:root,tool_input:{repository:'org/repo',branch:'chore/x',expectedHeadSha:'c'.repeat(40)}};
  assert.equal(isGithubWritePayload(del),true);
  const old=evaluateGithubMcpPayload(del,{probe:missing,capabilities});
  assert.match(old.hookSpecificOutput.permissionDecisionReason,/Run github_policy_status first/);
  const listed=()=>({ready:true,protocol:1,capabilities:['github_delete_branch']});
  // The Executor collects production/PR evidence at the write; its absence here must not stop the call.
  assert.equal(evaluateGithubMcpPayload(del,{probe:missing,capabilities:listed}),null);
  for(const [args,reason] of [[{branch:'main'},/protected_ref/],[{branch:'refs/heads/chore/x'},/expected_branch_head_required/],
    [{expectedHeadSha:'abc'},/expected_branch_head_required/],[{repository:'org'},/repository_required/]]) {
    const denied=evaluateGithubMcpPayload({...del,tool_input:{...del.tool_input,...args}},{probe:missing,capabilities:listed});
    assert.equal(denied.hookSpecificOutput.permissionDecision,'deny',JSON.stringify(args));
    assert.match(denied.hookSpecificOutput.permissionDecisionReason,reason,JSON.stringify(args));
  }
});
test('bundle upload is listed by the backend, authorized on begin, and never model-callable as a continuation',()=>{
  const bundle={tool_name:'mcp_devpro_github_bundle_upload_local',cwd:root,tool_input:{repository:'org/repo',
    branch:'chore/wire-github-bundle-upload-policy',baseCommit:'a'.repeat(40),expectedRemoteCommit:'b'.repeat(40),bundlePath:'~/changes.bundle'}};
  // The hermes owner bridge reaches the same policy through the begin leg of its upload session.
  const begin={...bundle,tool_name:'mcp_devpro_github_push_upload_begin'};
  for(const [payload,name] of [[bundle,'github_bundle_upload_local'],[begin,'github_push_upload_begin']]) {
    assert.equal(devproGithubToolName(payload.tool_name),name);
    assert.equal(isGithubWritePayload(payload),true,name);
    // An artifact built before the tool existed does not list it, so the write stays denied.
    assert.match(evaluateGithubMcpPayload(payload,{probe:missing,capabilities}).hookSpecificOutput.permissionDecisionReason,
      /Run github_policy_status first/,name);
  }
  const listed=()=>({ready:true,protocol:1,capabilities:['github_bundle_upload_local','github_push_upload_begin',
    'github_push_upload_chunk','github_push_upload_finish']});
  for(const payload of [bundle,begin]) assert.equal(evaluateGithubMcpPayload(payload,{probe:missing,capabilities:listed}),null);
  for(const [args,reason] of [[{branch:'production'},/protected_ref/],[{branch:'release/v7.13.0'},/protected_ref/],
    [{branch:undefined},/protected_ref/],[{repository:undefined},/repository_required/]]) {
    const denied=evaluateGithubMcpPayload({...bundle,tool_input:{...bundle.tool_input,...args}},{probe:missing,capabilities:listed});
    assert.equal(denied.hookSpecificOutput.permissionDecision,'deny',JSON.stringify(args));
    assert.match(denied.hookSpecificOutput.permissionDecisionReason,reason,JSON.stringify(args));
  }
  for(const name of ['github_push_upload_chunk','github_push_upload_finish']) {
    const denied=evaluateGithubMcpPayload({tool_name:`mcp_devpro_${name}`,cwd:root,
      tool_input:{repository:'org/repo',branch:'chore/wire-github-bundle-upload-policy',uploadId:'upload-1'}},{probe:missing,capabilities:listed});
    assert.equal(denied.hookSpecificOutput.permissionDecision,'deny',name);
    assert.match(denied.hookSpecificOutput.permissionDecisionReason,/upload_continuation_not_model_callable/,name);
  }
});
test('local checks cannot be supplied by model arguments or a remote pass flag',()=>{
  let called=0;
  const result=evaluateGithubMcpPayload({...input,tool_input:{...input.tool_input,policy:{allowed:true}}},
    {probe:missing,capabilities,local:()=>{called++;return {allowed:false,reason:'local evidence absent'};}});
  assert.equal(called,1);assert.equal(result.hookSpecificOutput.permissionDecision,'deny');
});
test('runner denies GitHub writes on timeout, crash, missing gate and invalid stdout on every host',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'github-hooks-'));
  try {
    const files={timeout:'setInterval(()=>{},1000)',crash:'process.exit(1)',invalid:'console.log("not json")',exit2:'process.exit(2)',badDecision:'console.log("null")'};
    for(const [kind,code] of Object.entries(files))writeFileSync(path.join(dir,`${kind}.mjs`),code);
    for(const host of ['codex','claude-code','opencode']) for(const kind of [...Object.keys(files),'missing']) {
      const result=spawnSync(process.execPath,[path.join(root,'.devpro/scripts/hooks/run-hook.mjs'),'PreToolUse',path.join(dir,`${kind}.mjs`),`--host=${host}`],
        {cwd:root,input:JSON.stringify(input),encoding:'utf8',timeout:10000,env:{...process.env,DEVPRO_HOOK_TIMEOUT_MS:'300'}});
      assert.equal(result.status,0,`${host}/${kind}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,'deny',`${host}/${kind}`);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('OpenCode V1 maps MCP and denies a failed runner even when native permission allowed',async()=>{
  assert.equal(mapOpenCodeToolToProtocol(input.tool_name).gates.length,1);
  const hooks=createDevproPluginHooks({directory:root,runHook:async()=>({status:1,stdout:'',stderr:''})});
  await assert.rejects(hooks['tool.execute.before']({tool:input.tool_name,sessionID:'test'}, {args:input.tool_input}),/GitHub gate unavailable/);
});
test('OpenCode V1 preserves each invocation input when the after event omits args',async()=>{
  const calls=[];
  const hooks=createDevproPluginHooks({directory:root,runHook:async call=>{
    calls.push(call);return {status:0,stdout:'',stderr:''};
  }});
  const first={tool:'devpro_work_github_create_pr',sessionID:'s',callID:'first'};
  const second={...first,callID:'second'};
  const args={repository:'org/repo',head:'feature/first',baseBranch:'main',body:input.tool_input.body};
  await hooks['tool.execute.before'](first,{args});
  await hooks['tool.execute.before'](second,{args:{...args,head:'feature/second'}});
  await hooks['tool.execute.after'](first,{output:'{}'});
  await hooks['tool.execute.after'](second,{output:'{}'});
  const posts=calls.filter(call=>call.event==='PostToolUse').map(call=>JSON.parse(call.payload));
  assert.equal(posts[0].tool_input.head,'feature/first');
  assert.equal(posts[1].tool_input.head,'feature/second');
});
test('global OpenCode adapter uses the installed artifact and a fixed Node executable',async()=>{
  const hooks=new Map(),calls=[];
  const plugin=createGithubOpenCodePlugin({nodeExecutable:process.execPath,run:async(exe,args,options)=>{
    calls.push({exe,args,options});return {status:0,stdout:JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'blocked'}})};
  }});
  await plugin.setup({location:{directory:root},tool:{hook:(name,fn)=>hooks.set(name,fn)}});
  await assert.rejects(hooks.get('execute.before')({tool:input.tool_name,input:input.tool_input}),/blocked/);
  assert.equal(calls[0].exe,process.execPath);
  assert.ok(path.isAbsolute(calls[0].args[0]));
  await hooks.get('execute.before')({tool:'unrelated',input:{}});
  assert.equal(calls.length,1);
  const result={content:[{type:'text',text:'completed'}]};
  await hooks.get('execute.after')({tool:input.tool_name,input:input.tool_input,result,status:'completed',sessionID:'owner'});
  assert.equal(calls.length,2);
  assert.equal(calls[1].args[1],'PostToolUse');
  assert.deepEqual(JSON.parse(calls[1].options.input).tool_response,result);
  await hooks.get('execute.after')({tool:input.tool_name,status:'failed'});
  assert.equal(calls.length,2);
});

// ---- MCP update_issue neither reads nor clears the saved github_check_pr result (#3496) ----
// The MCP backend refuses update_issue for a PR number, so the edit cannot leave a saved PR check stale.
const footerBody = `Description\nRules: v${readCanonicalAgentsMdVersion(root)?.version} · Tool: Codex · Model: GPT-6`;
const updateCapabilities = () => ({ ready: true, protocol: 1, capabilities: ['github_update_issue', 'github_merge_pr'] });
const updateIssue = (cwd, toolInput) => ({ tool_name: 'mcp__devpro_work__github_update_issue', cwd, tool_input: { repository: 'org/repo', number: 7, ...toolInput } });
const savedCheck = (number, sha = 'a'.repeat(40)) => ({ protocol: 1, repository: 'org/repo', number, pr: { head: { sha, ref: 'chore/x' } }, policy: { allowed: true } });

// [Scenario: openspec-flow :: MCP update_issue is not compared, so an issue description shaped like a PR waiver can be edited]
test('update_issue with or without a description body neither reads nor clears the saved check, and the policy receives no snapshot; merge still reads', () => {
  const order = [];
  const received = [];
  const options = {
    probe: missing,
    capabilities: updateCapabilities,
    readCheck: (cwd, repository, number) => { order.push(`read ${repository}#${number}`); return savedCheck(number); },
    local: (action, context) => { order.push('policy'); received.push(context.snapshot); return { allowed: true }; },
  };
  for (const toolInput of [{ body: footerBody }, { labels: ['x'] }]) {
    order.length = 0; received.length = 0;
    assert.equal(evaluateGithubMcpPayload(updateIssue(root, toolInput), options), null);
    assert.deepEqual(order, ['policy'], JSON.stringify(toolInput));
    assert.equal(received[0], null);
  }
  const cwd = mkdtempSync(path.join(tmpdir(), 'github-check-keep-'));
  try {
    assert.equal(saveGithubCheck(cwd, savedCheck(7)), true);
    assert.equal(evaluateGithubMcpPayload(updateIssue(cwd, { body: footerBody }), { probe: missing, capabilities: updateCapabilities, local: () => ({ allowed: true }) }), null);
    assert.ok(readGithubCheck(cwd, 'org/repo', 7), 'a body edit keeps the saved check');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
  order.length = 0;
  const merge = { tool_name: 'mcp__devpro_work__github_merge_pr', cwd: root, tool_input: { repository: 'org/repo', number: 7, expectedHeadSha: 'a'.repeat(40), baseBranch: 'main' } };
  evaluateGithubMcpPayload(merge, options);
  assert.equal(order[0], 'read org/repo#7', `merge reads the saved check: ${order}`);
});
