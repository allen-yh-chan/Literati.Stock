import { classifyAuthSurfaceFault } from './hooks/lib/host-auth-surface.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;
const SCHEMA = 'devpro-highest-tier-reviewer-model/v1';
export const MODEL_PROBE_TIMEOUT_CEILING_MS = 90000;
export const CODEX_MODEL_PROBE_TIMEOUT_MS = 35000;
const MAX_BYTES = 1024 * 1024;
// Capability tier precedes release number. The provider's picker default and
// service/latency tier are not measures of reasoning capability.
export const CODEX_REVIEWER_CAPABILITY_TIERS = Object.freeze(['luna', 'terra', 'sol', 'astra']);
// Claude capability families, lowest to highest. The provider's `best` alias
// tracks Opus, not the most capable family, so automatic selection probes the
// top family's own alias and accepts only that family's execution identity:
// https://code.claude.com/docs/en/model-config#model-aliases
export const CLAUDE_REVIEWER_CAPABILITY_FAMILIES = Object.freeze(['haiku', 'sonnet', 'opus', 'fable']);
export const CLAUDE_REVIEWER_HIGHEST_FAMILY = CLAUDE_REVIEWER_CAPABILITY_FAMILIES.at(-1);
const CLAUDE_HIGHEST_ID = new RegExp(`^claude-${CLAUDE_REVIEWER_HIGHEST_FAMILY}-[0-9]+(?:-[0-9]+)*$`);
const CLAUDE_HIGHEST_POLICY = 'claude-highest-family-alias';
// Named here rather than imported: the recipe contract imports this module.
const CLAUDE_OVERRIDE_HINT = 'set DEVPRO_SECOND_REVIEWER_MODEL_CLAUDE to an explicit model and rerender';

function blocked(message, diagnostics) {
  const provider = diagnostics?.provider_classification ? `; provider_classification=${diagnostics.provider_classification}` : '';
  const suffix = diagnostics ? `${provider}; surface_classification=${diagnostics.surface_classification}; requires_host_rerun=${diagnostics.requires_host_rerun}; may_fallback=${diagnostics.may_fallback}` : '';
  const e = new Error(`reviewer_model_probe_unavailable: ${message}${suffix}`);
  if (diagnostics) Object.assign(e, diagnostics);
  e.classification = 'reviewer_model_probe_unavailable';
  throw e;
}

// Every automatic Claude selection failure points at the one sanctioned way to
// use a different model, so no failure path reads as permission to downgrade.
function claudeBlocked(message, diagnostics) {
  blocked(`${message}; no lower family is tried; ${CLAUDE_OVERRIDE_HINT}`, diagnostics);
}

function hasRejectedClaudeQuotaEvent(stdout) {
  if (typeof stdout !== 'string' || stdout.length > MAX_BYTES) return false;
  let events;
  try { events=stdout.trim().split('\n').map(line=>JSON.parse(line)); } catch { return false; }
  // Only native top-level control events count; assistant text and nested/quoted
  // payloads cannot establish provider quota exhaustion.
  return events.every(x=>x && typeof x==='object' && !Array.isArray(x) && typeof x.type==='string')
    && events.some(x=>x.type==='rate_limit_event' && x.rate_limit_info?.status==='rejected');
}

function surfaceDiagnostics(result, tool) {
  const code = result.error?.code ?? '';
  if (tool==='claude' && code!=='ENOENT' && hasRejectedClaudeQuotaEvent(result.stdout)) {
    return {provider_classification:'quota-exhausted',surface_classification:'host-fault',
      requires_host_rerun:false,may_fallback:false};
  }
  const output = [code === 'ENOENT' ? `spawn ${tool} ENOENT` : code,
    result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, MAX_BYTES);
  const verdict = classifyAuthSurfaceFault(result.status ?? 1, output, {surface:'unknown'});
  return {surface_classification:verdict.classification,
    requires_host_rerun:verdict.requiresHostRerun, may_fallback:verdict.mayFallback};
}

function codexHelperDiagnostics(result) {
  try {
    const value=JSON.parse(result.stderr);
    if (['ok','sandbox-surface-fault','real-unavailable','host-fault'].includes(value.surface_classification)
      && typeof value.requires_host_rerun === 'boolean' && typeof value.may_fallback === 'boolean') {
      return {surface_classification:value.surface_classification,
        requires_host_rerun:value.requires_host_rerun,may_fallback:value.may_fallback};
    }
  } catch {}
  return surfaceDiagnostics(result,'codex');
}

/** 測試程序替身須有明示測試授權，且必須在任何探測前驗證。 */
export function assertModelProbeTestInjection(implementation, nativeImplementation, env) {
  if (implementation === nativeImplementation) return;
  if (typeof implementation === 'function' && (env?.NODE_ENV === 'test' || env?.DEVPRO_ALLOW_MODEL_PROBE_STUB === '1')) return;
  blocked('model probe injection is test-only');
}

/** 依能力 tier、同 tier 數字版本排序；無法證明最高模型時停止。 */
export function selectHighestTierCodexModel(models) {
  if (!Array.isArray(models) || models.length === 0 || models.length > 1000) blocked('empty or oversized catalog');
  const ids = new Set();
  const candidates = models.map(row => {
    if (!row || typeof row.model !== 'string' || !MODEL_ID.test(row.model)
      || row.hidden !== false || ids.has(row.model)) blocked('invalid catalog row');
    ids.add(row.model);
    const m = /^gpt-(\d+)(?:\.(\d+))?-(astra|sol|terra|luna)$/.exec(row.model);
    if (!m) blocked('catalog contains an unranked capability tier; update tier policy');
    if (![m[1],m[2] ?? '0'].every(n=>Number.isSafeInteger(Number(n)))) blocked('unsafe numeric model release');
    if (!Array.isArray(row.supportedReasoningEfforts) || row.supportedReasoningEfforts.some(e=>!e || typeof e.reasoningEffort!=='string')) blocked('missing effort capabilities');
    return {model:row.model, tier:m[3], generation:[Number(m[1]),Number(m[2] ?? 0)],
      xhigh:row.supportedReasoningEfforts.some(e => e.reasoningEffort === 'xhigh')};
  });
  candidates.sort((a,b) => CODEX_REVIEWER_CAPABILITY_TIERS.indexOf(b.tier) - CODEX_REVIEWER_CAPABILITY_TIERS.indexOf(a.tier)
    || b.generation[0]-a.generation[0] || b.generation[1]-a.generation[1]);
  if (candidates[1] && candidates[0].tier === candidates[1].tier
    && candidates[0].generation.every((n,i)=>n===candidates[1].generation[i])) blocked('ambiguous equal-ranked models');
  if (!candidates[0].xhigh) blocked('highest capability model does not support recipe xhigh');
  return {schema:SCHEMA, family:'codex', policy:'codex-capability-tier',
    selected_model:candidates[0].model, requested_kind:'exact-id', candidates};
}

/** 有界讀完整帳戶模型目錄，不建立 task thread。 */
export async function readCodexReviewerModelCatalog({spawnImpl=spawn, timeoutMs=30000, env=process.env}={}) {
  assertModelProbeTestInjection(spawnImpl, spawn, env);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) blocked('invalid catalog timeout');
  return new Promise((resolve,reject) => {
    const p = spawnImpl('codex',['app-server','--listen','stdio://'],{env,stdio:['pipe','pipe','pipe']});
    let buffer='', diagnosticOutput='', bytes=0, settled=false, id=1, pages=0;
    const models=[], cursors=new Set();
    const timer=setTimeout(() => finish(Object.assign(new Error('model catalog timeout'),{code:'ETIMEDOUT'})),timeoutMs);
    function finish(error) {
      if(settled) return; settled=true; clearTimeout(timer);
      p.stdin.end(); p.kill('SIGTERM');
      const force=setTimeout(() => p.kill('SIGKILL'),1000); force.unref();
      p.once('close',() => clearTimeout(force));
      if (error) Object.assign(error,surfaceDiagnostics({status:1,error,stderr:diagnosticOutput},'codex'));
      error ? reject(error) : resolve(models);
    }
    const send=x => p.stdin.write(JSON.stringify(x)+'\n');
    p.on('error',error => finish(Object.assign(new Error('model catalog spawn failed'),{code:error.code})));
    p.stdin.on('error',() => finish(new Error('model catalog stdin failed')));
    p.on('close',() => {if(!settled) finish(new Error('model catalog closed before completion'));});
    p.stderr.on('data',chunk => {diagnosticOutput=(diagnosticOutput+chunk.toString('utf8')).slice(0,MAX_BYTES);bytes+=chunk.length;if(bytes>MAX_BYTES) finish(new Error('model catalog output exceeded bound'));});
    p.stdout.on('data',chunk => {
      if(settled) return;
      bytes+=chunk.length;
      if(bytes>MAX_BYTES) return finish(new Error('model catalog output exceeded bound'));
      buffer+=chunk.toString('utf8');
      let i;
      while(!settled && (i=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
        let x;try{x=JSON.parse(line);}catch{return finish(new Error('invalid catalog JSON'));}
        if(!x || typeof x!=='object' || Array.isArray(x)) return finish(new Error('invalid catalog message'));
        if(x.id!==id) continue;
        if(x.error || !x.result || typeof x.result!=='object') {
          if(x.error) diagnosticOutput=(diagnosticOutput+JSON.stringify(x.error)).slice(0,MAX_BYTES);
          return finish(new Error('catalog request failed'));
        }
        if(id===1) {
          send({method:'initialized',params:{}});id++;
          send({id,method:'model/list',params:{limit:100,includeHidden:false}});
          continue;
        }
        if(!Array.isArray(x.result.data) || !Object.hasOwn(x.result,'nextCursor')) return finish(new Error('invalid catalog page'));
        if (x.result.data.length > 100 || models.length + x.result.data.length > 1000) return finish(new Error('oversized catalog page'));
        models.push(...x.result.data);pages++;
        const cursor=x.result.nextCursor;
        if(cursor===null) return finish();
        if(typeof cursor!=='string' || !cursor || cursors.has(cursor) || pages>=10) return finish(new Error('invalid catalog pagination'));
        cursors.add(cursor);id++;
        send({id,method:'model/list',params:{limit:100,includeHidden:false,cursor}});
      }
    });
    send({id,method:'initialize',params:{clientInfo:{name:'devpro-reviewer-model-probe',version:'1.0.0'}}});
  });
}

/** 探測最高 tier 並僅回傳消毒後模型證據，不保存 provider 原始輸出。 */
export function probeHighestTierReviewerModel(family,{spawnSyncImpl=spawnSync,env=process.env}={}) {
  assertModelProbeTestInjection(spawnSyncImpl, spawnSync, env);
  const stub = env.DEVPRO_SECOND_REVIEW_MODEL_PROBE_STUB;
  if (stub !== undefined) {
    if (env.DEVPRO_ALLOW_MODEL_PROBE_STUB !== '1' && env.NODE_ENV !== 'test') blocked('model probe stub is test-only');
    let evidence; try { evidence = JSON.parse(stub)[family]; } catch { blocked('invalid model probe stub'); }
    assertReviewerModelProbeEvidence(evidence, family, evidence?.selected_model);
    return evidence;
  }
  const cwd=mkdtempSync(path.join(tmpdir(),'devpro-model-probe-'));
  try {
    if(family==='codex') {
      const result=spawnSyncImpl(process.execPath,[fileURLToPath(import.meta.url),'--codex-catalog'],
        {env,cwd,encoding:'utf8',timeout:CODEX_MODEL_PROBE_TIMEOUT_MS,maxBuffer:MAX_BYTES});
      if(result.error || result.status!==0) blocked('Codex catalog could not be read',codexHelperDiagnostics(result));
      let catalog;try{catalog=JSON.parse(result.stdout);}catch{blocked('invalid Codex catalog response');}
      return selectHighestTierCodexModel(catalog);
    }
    if(family!=='claude') blocked('unsupported family');
    if (['ANTHROPIC_DEFAULT_FABLE_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL'].some(key=>env[key] !== undefined)) {
      claudeBlocked('provider model alias is remapped by ANTHROPIC_DEFAULT_FABLE_MODEL or ANTHROPIC_DEFAULT_OPUS_MODEL');
    }
    // These host markers identify the parent session, not the stateless probe.
    const childEnv = {...env};
    delete childEnv.CLAUDECODE;
    delete childEnv.CLAUDE_CODE_ENTRYPOINT;
    const result=spawnSyncImpl('claude',['-p','Reply exactly OK. Do not use tools.',
      '--system-prompt','You are a stateless compatibility probe. Reply exactly OK. Do not use tools.',
      '--safe-mode','--model',CLAUDE_REVIEWER_HIGHEST_FAMILY,'--effort','xhigh','--verbose','--output-format','stream-json','--tools',''],
      {env:childEnv,cwd,encoding:'utf8',timeout:MODEL_PROBE_TIMEOUT_CEILING_MS,maxBuffer:MAX_BYTES});
    const diagnostics=surfaceDiagnostics(result,'claude');
    if(result.error || result.status!==0 || diagnostics.provider_classification==='quota-exhausted') claudeBlocked(`Claude ${CLAUDE_REVIEWER_HIGHEST_FAMILY} probe failed`,diagnostics);
    let events;try{events=result.stdout.trim().split('\n').map(line=>JSON.parse(line));}catch{claudeBlocked('invalid Claude probe response');}
    if(events.some(x=>!x || typeof x!=='object' || Array.isArray(x) || typeof x.type!=='string')) claudeBlocked('invalid Claude probe events');
    const inits=events.filter(x=>x.type==='system'&&x.subtype==='init');
    const finals=events.filter(x=>x.type==='result');
    if(inits.length!==1 || finals.length!==1 || finals[0].is_error!==false || finals[0].subtype!=='success'
      || typeof inits[0].model !== 'string' || !MODEL_ID.test(inits[0].model) || !CLAUDE_HIGHEST_ID.test(inits[0].model)
      || !Array.isArray(inits[0].tools) || inits[0].tools.length!==0
      || typeof finals[0].result !== 'string' || finals[0].result.trim() !== 'OK'
      || !events.some(x=>x.type==='assistant')
      || events.some(x=>x.type==='assistant' && (x.message?.model!==inits[0].model
        || !Array.isArray(x.message?.content)
        // Thinking blocks are valid reasoning output, not tool activity:
        // https://platform.claude.com/docs/en/build-with-claude/thinking
        || x.message.content.some(c=>!['text','thinking','redacted_thinking'].includes(c?.type))))
      || events.some(x=>x.type==='tool_result' || x.type==='tool_use' || x.event?.content_block?.type==='tool_use')) claudeBlocked(`Claude ${CLAUDE_REVIEWER_HIGHEST_FAMILY} model not proven`,surfaceDiagnostics({...result,status:1},'claude'));
    return {schema:SCHEMA,family:'claude',policy:CLAUDE_HIGHEST_POLICY,selected_model:inits[0].model,
      requested_kind:'exact-id',candidates:[{selector:CLAUDE_REVIEWER_HIGHEST_FAMILY,model:inits[0].model,classification:'compatible'}]};
  } finally {rmSync(cwd,{recursive:true,force:true});}
}

/** 在 runner 邊界重新驗證精簡模型證據與 requested identity。 */
export function assertReviewerModelProbeEvidence(evidence, family, model) {
  if (!evidence || evidence.schema !== SCHEMA || evidence.family !== family
    || evidence.selected_model !== model || evidence.requested_kind !== 'exact-id'
    || typeof model !== 'string' || !MODEL_ID.test(model)) blocked('missing or inconsistent automatic model probe evidence; rerender');
  if (family === 'codex') {
    if (evidence.policy !== 'codex-capability-tier' || !Array.isArray(evidence.candidates)) blocked('invalid Codex probe policy');
    const selected = selectHighestTierCodexModel(evidence.candidates.map(c => ({model:c.model, hidden:false,
      supportedReasoningEfforts:[{reasoningEffort:c.xhigh === true ? 'xhigh' : 'high'}]})));
    if (selected.selected_model !== model) blocked('inconsistent Codex probe selection');
  } else if (family === 'claude') {
    if (evidence.policy !== CLAUDE_HIGHEST_POLICY || !CLAUDE_HIGHEST_ID.test(model)
      || evidence.candidates?.length !== 1 || evidence.candidates[0].selector !== CLAUDE_REVIEWER_HIGHEST_FAMILY
      || evidence.candidates[0].model !== model || evidence.candidates[0].classification !== 'compatible') blocked('invalid Claude probe policy');
  } else blocked('unsupported probe family');
  return evidence;
}

if(process.argv[1]===fileURLToPath(import.meta.url) && process.argv[2]==='--codex-catalog') {
  try{console.log(JSON.stringify(await readCodexReviewerModelCatalog()));}
  catch(error){process.stderr.write(JSON.stringify({surface_classification:error.surface_classification ?? 'host-fault',requires_host_rerun:error.requires_host_rerun ?? false,may_fallback:error.may_fallback ?? false})+'\n');process.exitCode=1;}
}
