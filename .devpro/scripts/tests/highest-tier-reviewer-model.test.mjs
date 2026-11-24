import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {selectHighestTierCodexModel,probeHighestTierReviewerModel,readCodexReviewerModelCatalog,
  assertReviewerModelProbeEvidence,CLAUDE_REVIEWER_CAPABILITY_FAMILIES,CLAUDE_REVIEWER_HIGHEST_FAMILY} from '../highest-tier-reviewer-model.mjs';

const row=(model,effort='xhigh')=>({model,hidden:false,supportedReasoningEfforts:[{reasoningEffort:effort}]});
test('capability tier precedes newer version, picker default and list order',()=>{
  const models=[{...row('gpt-6.1-sol'),isDefault:true},row('gpt-6-astra'),row('gpt-6-luna')];
  assert.equal(selectHighestTierCodexModel(models).selected_model,'gpt-6-astra');
  assert.equal(selectHighestTierCodexModel(models.reverse()).selected_model,'gpt-6-astra');
});
test('newest numeric version within the highest capability tier',()=>{
  assert.equal(selectHighestTierCodexModel([row('gpt-6.2-astra'),row('gpt-6.10-astra'),row('gpt-7-luna')]).selected_model,'gpt-6.10-astra');
});
test('unknown model tier cannot silently lose to a known tier',()=>{
  assert.throws(()=>selectHighestTierCodexModel([row('gpt-6-astra'),row('gpt-7-nova')]),{classification:'reviewer_model_probe_unavailable'});
});
test('highest tier lacking xhigh is blocked, never downgraded',()=>{
  assert.throws(()=>selectHighestTierCodexModel([row('gpt-6-astra','high'),row('gpt-6-sol')]),/does not support/);
});
test('empty, hidden, duplicate or malformed catalogs are blocked',()=>{
  for(const models of [[],[{...row('gpt-6-astra'),hidden:true}],[row('gpt-6-astra'),row('gpt-6-astra')],[{model:'gpt-6-astra',hidden:false}]]){
    assert.throws(()=>selectHighestTierCodexModel(models),{classification:'reviewer_model_probe_unavailable'});
  }
});
function claudeEvents(model='claude-fable-98-0'){
  return [{type:'system',subtype:'init',model,tools:[]},{type:'assistant',message:{model,content:[{type:'text',text:'OK'}]}},{type:'result',subtype:'success',is_error:false,result:'OK'}];
}
const rejectedQuotaEvent=rateLimitType=>({type:'rate_limit_event',rate_limit_info:{
  status:'rejected',rateLimitType,resetsAt:1794024000,private_provider_detail:'private-quota-payload',
}});
for(const rateLimitType of ['seven_day','five_hour']) {
  for(const status of [1,0]) {
    test(`Claude rejected ${rateLimitType} quota blocks a probe with exit ${status}`,()=>{
      const events=claudeEvents();
      events.splice(1,0,rejectedQuotaEvent(rateLimitType));
      events[events.length-1]={type:'result',subtype:'error',is_error:true,result:'private-terminal-error'};
      assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:()=>({
        status,stdout:events.map(JSON.stringify).join('\n'),
      })}),error=>{
        assert.equal(error.classification,'reviewer_model_probe_unavailable');
        assert.equal(error.provider_classification,'quota-exhausted');
        assert.equal(error.surface_classification,'host-fault');
        assert.equal(error.requires_host_rerun,false);
        assert.equal(error.may_fallback,false);
        assert.match(error.message,/provider_classification=quota-exhausted/);
        assert.doesNotMatch(error.message,/private-quota-payload|private-terminal-error|resetsAt|1794024000/);
        return true;
      });
    });
  }
}
test('Claude quota classification rejects prose, nested events, malformed JSON and unrelated failures',()=>{
  const fake=rejectedQuotaEvent('seven_day');
  const allowed={...fake,rate_limit_info:{...fake.rate_limit_info,status:'allowed'}};
  const nearLimit={...fake,rate_limit_info:{...fake.rate_limit_info,status:'allowed_warning'}};
  const cases=[
    {stdout:JSON.stringify({type:'assistant',message:{content:[{type:'text',text:JSON.stringify(fake)}]}})},
    {stdout:JSON.stringify({type:'assistant',event:fake})},
    {stdout:JSON.stringify({type:'result',result:'quota exhausted'})},
    {stdout:JSON.stringify(allowed)},
    {stdout:JSON.stringify(nearLimit)},
    {stdout:JSON.stringify(fake)+'\nmalformed'},
    {stdout:'malformed'},
    {stdout:JSON.stringify({...fake,rate_limit_info:null})},
    {stdout:JSON.stringify({type:'unrelated',rate_limit_info:fake.rate_limit_info})},
    {stdout:'',stderr:JSON.stringify(fake)},
    {stdout:'',stderr:'Not logged in'},
    {stdout:'',stderr:'network unreachable'},
  ];
  for(const result of cases) {
    assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:()=>({status:1,...result})}),error=>{
      assert.equal(error.classification,'reviewer_model_probe_unavailable');
      assert.equal(error.provider_classification,undefined);
      assert.equal(error.surface_classification,'sandbox-surface-fault');
      assert.equal(error.requires_host_rerun,true);
      assert.equal(error.may_fallback,false);
      assert.doesNotMatch(error.message,/private-quota-payload/);
      return true;
    });
  }
});
test('allowed Claude rate-limit events preserve a successful model probe',()=>{
  for(const status of ['allowed','allowed_warning']) {
    const events=claudeEvents();
    events.splice(1,0,{type:'rate_limit_event',rate_limit_info:{status,rateLimitType:'seven_day'}});
    assert.equal(probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:()=>({
      status:0,stdout:events.map(JSON.stringify).join('\n'),
    })}).selected_model,'claude-fable-98-0');
  }
});
test('Claude missing executable retains real-unavailable diagnosis',()=>{
  assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:()=>({
    status:null,error:Object.assign(new Error('spawn claude ENOENT'),{code:'ENOENT'}),
  })}),error=>{
    assert.equal(error.provider_classification,undefined);
    assert.equal(error.surface_classification,'real-unavailable');
    assert.equal(error.requires_host_rerun,false);
    return true;
  });
});
test('Claude highest family alias is probed without tools then pinned to the observed model',()=>{
  const evidence=probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:(exe,args,options)=>{
    assert.equal(exe,'claude');assert.equal(args[args.indexOf('--model')+1],'fable');
    assert.equal(args[args.indexOf('--effort')+1],'xhigh');assert.equal(args[args.indexOf('--tools')+1],'');
    assert.equal(options.timeout,90000);
    return {status:0,stdout:claudeEvents().map(JSON.stringify).join('\n')};
  }});
  assert.equal(evidence.selected_model,'claude-fable-98-0');
  assert.equal(evidence.policy,'claude-highest-family-alias');
  assert.deepEqual(evidence.candidates,[{selector:'fable',model:'claude-fable-98-0',classification:'compatible'}]);
});
// The provider's `best` alias resolves to Opus, while Fable is the most capable
// family (https://code.claude.com/docs/en/model-config#model-aliases).
function aliasAwareClaude(calls,{fable='claude-fable-5-2',fableStatus=0}={}){
  return (_exe,args)=>{
    const selector=args[args.indexOf('--model')+1];
    calls.push(selector);
    if(selector==='best' || selector==='opus') return {status:0,stdout:claudeEvents('claude-opus-5-5').map(JSON.stringify).join('\n')};
    if(selector==='fable') return {status:fableStatus,stdout:fableStatus===0?claudeEvents(fable).map(JSON.stringify).join('\n'):''};
    throw new Error(`unexpected selector ${selector}`);
  };
}
test('Claude family ranking puts Fable above Opus and probes the top family alias',()=>{
  assert.deepEqual([...CLAUDE_REVIEWER_CAPABILITY_FAMILIES],['haiku','sonnet','opus','fable']);
  assert.equal(CLAUDE_REVIEWER_HIGHEST_FAMILY,'fable');
  assert.ok(Object.isFrozen(CLAUDE_REVIEWER_CAPABILITY_FAMILIES));
});
test('Claude selects an available Fable even though best resolves to Opus',()=>{
  const calls=[];
  const evidence=probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:aliasAwareClaude(calls)});
  assert.equal(evidence.selected_model,'claude-fable-5-2');
  assert.deepEqual(calls,['fable']);
});
test('Claude Fable probe failure blocks without retrying a lower family',()=>{
  const calls=[];
  assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:aliasAwareClaude(calls,{fableStatus:1})}),error=>{
    assert.equal(error.classification,'reviewer_model_probe_unavailable');
    assert.match(error.message,/Claude fable probe failed/);
    assert.match(error.message,/DEVPRO_SECOND_REVIEWER_MODEL_CLAUDE/);
    return true;
  });
  assert.deepEqual(calls,['fable']);
});
test('every Claude probe failure path names the explicit override after one fable attempt',()=>{
  const ok=claudeEvents('claude-fable-5-2').map(JSON.stringify);
  for(const stdout of ['not json',[ok[0],'null',ok[2]].join('\n'),[ok[0],JSON.stringify({subtype:'x'}),ok[2]].join('\n')]){
    const calls=[];
    assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:(_exe,args)=>{
      calls.push(args[args.indexOf('--model')+1]);return {status:0,stdout};
    }}),error=>{
      assert.equal(error.classification,'reviewer_model_probe_unavailable');
      assert.match(error.message,/DEVPRO_SECOND_REVIEWER_MODEL_CLAUDE/);
      return true;
    });
    assert.deepEqual(calls,['fable']);
  }
  assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test',ANTHROPIC_DEFAULT_FABLE_MODEL:'x'},spawnSyncImpl:()=>{throw new Error('must not spawn');}}),
    /DEVPRO_SECOND_REVIEWER_MODEL_CLAUDE/);
});
test('Claude fable alias that silently resolves to a lower family is not accepted',()=>{
  for(const fable of ['claude-opus-5-5','claude-sonnet-5-5']){
    const calls=[];
    assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:aliasAwareClaude(calls,{fable})}),
      {classification:'reviewer_model_probe_unavailable'});
    assert.deepEqual(calls,['fable']);
  }
  const events=claudeEvents('claude-fable-5-2');
  events[1].message.model='claude-opus-5-5';
  assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:()=>({status:0,stdout:events.map(JSON.stringify).join('\n')})}),
    {classification:'reviewer_model_probe_unavailable'});
});
test('Claude probe evidence rejects the best selector, the old policy and a lower family',()=>{
  const good={schema:'devpro-highest-tier-reviewer-model/v1',family:'claude',policy:'claude-highest-family-alias',
    selected_model:'claude-fable-5-2',requested_kind:'exact-id',candidates:[{selector:'fable',model:'claude-fable-5-2',classification:'compatible'}]};
  assert.equal(assertReviewerModelProbeEvidence(good,'claude','claude-fable-5-2'),good);
  const opus={...good,selected_model:'claude-opus-5-5',candidates:[{...good.candidates[0],model:'claude-opus-5-5'}]};
  for(const [evidence,model] of [[{...good,policy:'provider-best-alias'},'claude-fable-5-2'],
    [{...good,candidates:[{...good.candidates[0],selector:'best'}]},'claude-fable-5-2'],[opus,'claude-opus-5-5']]){
    assert.throws(()=>assertReviewerModelProbeEvidence(evidence,'claude',model),{classification:'reviewer_model_probe_unavailable'});
  }
});
test('Claude reasoning blocks preserve a successful no-tools model probe',()=>{
  for (const block of [{type:'thinking',thinking:'',signature:'opaque'},
    {type:'redacted_thinking',data:'opaque'}]) {
    const events=claudeEvents();
    events[1].message.content.unshift(block);
    const evidence=probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:()=>({
      status:0,stdout:events.map(JSON.stringify).join('\n'),
    })});
    assert.equal(evidence.selected_model,'claude-fable-98-0');
  }
});
test('Claude reasoning blocks do not authorize tool content',()=>{
  const events=claudeEvents();
  events[1].message.content.unshift({type:'thinking',thinking:''},
    {type:'tool_use',name:'Bash',input:{command:'true'}});
  assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:()=>({
    status:0,stdout:events.map(JSON.stringify).join('\n'),
  })}),{classification:'reviewer_model_probe_unavailable'});
});
test('failed, malformed, duplicate init, tool or silently switched Claude probes fail closed',()=>{
  const first=claudeEvents();
  for(const events of [[...first,first[0]],[{...first[0],tools:['Bash']},...first.slice(1)],
    [first[0],{type:'assistant',message:{model:'other'}},first[2]],[first[0],{type:'result',subtype:'error',is_error:true}]]){
    assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:()=>({status:0,stdout:events.map(JSON.stringify).join('\n')})}),{classification:'reviewer_model_probe_unavailable'});
  }
  for(const result of [{status:1,stdout:''},{status:0,stdout:'invalid'},{status:0,stdout:'null'},{status:0,stdout:'[]'},{error:new Error('timeout')}]){
    assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:()=>result}),{classification:'reviewer_model_probe_unavailable'});
  }
});
function fakeCatalogServer(responses){
  return ()=>{
    const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();
    p.stdin={on(){},write(line){const request=JSON.parse(line);assert.ok(['initialize','initialized','model/list'].includes(request.method));if(!request.id)return;
      queueMicrotask(()=>p.stdout.write(JSON.stringify({id:request.id,result:request.id===1?{}:responses.shift()})+'\n'));},end(){}};
    p.kill=()=>{queueMicrotask(()=>p.emit('close',0));};return p;
  };
}
test('Codex catalog reads every page before selecting the highest tier',async()=>{
  const models=await readCodexReviewerModelCatalog({env:{NODE_ENV:'test'},spawnImpl:fakeCatalogServer([
    {data:[row('gpt-6.1-sol')],nextCursor:'page2'},{data:[row('gpt-6-astra')],nextCursor:null}])});
  assert.equal(selectHighestTierCodexModel(models).selected_model,'gpt-6-astra');
});
test('repeated cursor and malformed page cannot become a partial catalog',async()=>{
  await assert.rejects(readCodexReviewerModelCatalog({env:{NODE_ENV:'test'},spawnImpl:fakeCatalogServer([
    {data:[row('gpt-6-sol')],nextCursor:'same'},{data:[row('gpt-6-astra')],nextCursor:'same'}])}),/pagination/);
  await assert.rejects(readCodexReviewerModelCatalog({env:{NODE_ENV:'test'},spawnImpl:fakeCatalogServer([{data:[]}])}),/page/);
});

test('unsafe releases and equal-ranked catalog identities block selection', () => {
  for (const models of [[row('gpt-999999999999999999-astra')], [row('gpt-6-astra'), row('gpt-6.0-astra')]]) {
    assert.throws(() => selectHighestTierCodexModel(models), {classification:'reviewer_model_probe_unavailable'});
  }
});
test('Claude lower-family or unranked observed identities cannot prove the highest family', () => {
  for (const model of ['claude-opus-9-0', 'claude-sonnet-9-0', 'claude-haiku-9-0', 'custom-model', 'claude-unknown-9-0']) {
    assert.throws(() => probeHighestTierReviewerModel('claude', {env:{NODE_ENV:'test'}, spawnSyncImpl:() => ({status:0,stdout:claudeEvents(model).map(JSON.stringify).join('\n')})}), {classification:'reviewer_model_probe_unavailable'});
  }
});
test('Claude provider remaps block automatic selection before spawn', () => {
  for (const key of ['ANTHROPIC_DEFAULT_FABLE_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL']) {
    let called = false;
    assert.throws(() => probeHighestTierReviewerModel('claude', {env:{NODE_ENV:'test',[key]:'claude-opus-5-0'},spawnSyncImpl:()=>{called=true;}}), /provider model alias is remapped/);
    assert.equal(called,false);
  }
});
test('Claude probe has a stateless prompt and does not inherit parent session markers', () => {
  probeHighestTierReviewerModel('claude', {env:{NODE_ENV:'test',CLAUDECODE:'1',CLAUDE_CODE_ENTRYPOINT:'cli',KEEP:'yes'},spawnSyncImpl:(_exe,args,options)=>{
    assert.match(args[args.indexOf('--system-prompt')+1], /stateless/);
    assert.equal(options.env.CLAUDECODE,undefined); assert.equal(options.env.CLAUDE_CODE_ENTRYPOINT,undefined); assert.equal(options.env.KEEP,'yes');
    return {status:0,stdout:claudeEvents().map(JSON.stringify).join('\n')};
  }});
});
test('model stub is rejected without explicit test authorization', () => {
  assert.throws(() => probeHighestTierReviewerModel('claude', {env:{DEVPRO_SECOND_REVIEW_MODEL_PROBE_STUB:'{}'}}), /test-only/);
});
test('Codex discovery times out and terminates a silent catalog server', async () => {
  let kills=0;
  await assert.rejects(readCodexReviewerModelCatalog({env:{NODE_ENV:'test'},timeoutMs:5,spawnImpl:()=>{
    const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();
    p.stdin={on(){},write(){},end(){}};p.kill=()=>{kills++;queueMicrotask(()=>p.emit('close',0));};return p;
  }}),/catalog timeout/);
  assert.equal(kills,1);
});

test('production model probe rejects injected process implementations before spawn', async()=>{
  let calls=0;
  assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{},spawnSyncImpl:()=>{calls++;}}),
    {classification:'reviewer_model_probe_unavailable'});
  await assert.rejects(readCodexReviewerModelCatalog({env:{},spawnImpl:()=>{calls++;}}),
    {classification:'reviewer_model_probe_unavailable'});
  assert.equal(calls,0);
});

test('model discovery preserves sanitized host-surface diagnostics for both families',()=>{
  for(const family of ['claude','codex']) {
    assert.throws(()=>probeHighestTierReviewerModel(family,{env:{NODE_ENV:'test'},spawnSyncImpl:()=>({
      status:1,stderr:'Not logged in; private-auth-output',stdout:''})}),error=>{
        assert.equal(error.classification,'reviewer_model_probe_unavailable');
        assert.equal(error.surface_classification,'sandbox-surface-fault');
        assert.equal(error.requires_host_rerun,true);
        assert.equal(error.may_fallback,false);
        assert.doesNotMatch(error.message,/private-auth-output|Not logged in/);
        return true;
      });
  }
});

test('Codex catalog helper preserves missing-executable diagnostics across its process boundary',()=>{
  assert.throws(()=>probeHighestTierReviewerModel('codex',{env:{PATH:''}}),error=>{
    assert.equal(error.classification,'reviewer_model_probe_unavailable');
    assert.equal(error.surface_classification,'real-unavailable');
    assert.equal(error.requires_host_rerun,false);
    assert.doesNotMatch(error.message,/spawn codex ENOENT/);
    return true;
  });
});

test('zero-exit Claude error result and catalog RPC auth error retain host-rerun diagnosis', async()=>{
  const events=claudeEvents();
  events[2]={type:'result',subtype:'error',is_error:true,result:'Not logged in'};
  assert.throws(()=>probeHighestTierReviewerModel('claude',{env:{NODE_ENV:'test'},spawnSyncImpl:()=>({
    status:0,stdout:events.map(JSON.stringify).join('\n')})}),error=>error.requires_host_rerun===true);
  const rpc=fakeCatalogServer([{data:[],nextCursor:null}]);
  await assert.rejects(readCodexReviewerModelCatalog({env:{NODE_ENV:'test'},spawnImpl:()=>{
    const p=rpc();
    p.stdin.write=()=>queueMicrotask(()=>p.stdout.write(JSON.stringify({id:1,error:{message:'Not logged in'}})+'\n'));
    return p;
  }}),error=>error.requires_host_rerun===true);
});
