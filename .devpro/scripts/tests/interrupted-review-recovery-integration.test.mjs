import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planPendingPostPrCompletionMarkerBinding } from "../render-second-review-packet.mjs";
import { runGatedStickyWrite } from "../write-second-review-sticky-gated.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, realpathSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as evidence from "../hooks/lib/second-review-control-evidence.mjs";
import { writePostPrCompletionMarker, withPostPrDispatchMarkerSnapshot, compareAndSwapPostPrCompletionExpectedDispatch } from "../hooks/lib/post-pr-completion-state.mjs";
import { attemptLockPath } from "../lib/second-review-attempt-lock.mjs";
import { checkCrossModelMergeGate } from "../hooks/pre-tool-gate.mjs";
const cliPath = new URL("../abandon-interrupted-second-review.mjs", import.meta.url);
const cli = existsSync(cliPath) ? await import(cliPath) : {};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t,{claimed=true}={}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "interrupted-recovery-")));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  const state = path.join(root,"state");
  const markerDir = path.join(root,"markers");
  const priorEnv = { ...process.env };
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = markerDir;
  process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = "operator-recovery-test";
  process.env.DEVPRO_HOOK_HOST = "test";
  process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = state;
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in priorEnv)) delete process.env[k]; Object.assign(process.env,priorEnv); });
  const attempt = "second-review-interrupted-test";
  const dir = path.join(root,"notes","cross-review",attempt); mkdirSync(dir,{recursive:true});
  const contextPath = path.join(dir,"observability-context.json");
  const full = Buffer.from('{"original":"immutable material"}\n');
  writeFileSync(path.join(dir,"paged-review-material-full.json"),full);
  const context = { repository_slug:"devpro/example", pr_number:"17", head_ref_oid:"a".repeat(40),
    attempt_id:attempt, dispatch_id:"dispatch-interrupted-integration", previous_dispatch_id:null,
    control_evidence_root:state, observability_context_path:contextPath, packet_path:path.join(dir,"packet.md"),
    activity_log_path:path.join(dir,"projection-activity.ndjson"), heartbeat_path:path.join(dir,"heartbeat.json") };
  writeFileSync(contextPath,JSON.stringify(context)); writeFileSync(context.packet_path,"mutable fifth window");
  const dispatch = { schema:evidence.DISPATCH_SCHEMA,
    ...Object.fromEntries(["repository_slug","pr_number","head_ref_oid","attempt_id","dispatch_id","previous_dispatch_id"].map(k=>[k,context[k]])),
    packet_sha256:"b".repeat(64), carrier_root_id:digest(Buffer.from(dir)), paged_full_material_sha256:digest(full),
    paged_full_material_created_at:"2026-10-29T00:00:00.000Z", paged_full_material_expires_at:"2026-10-29T02:00:00.000Z" };
  await evidence.reserveDispatchRecord({rootDir:state,record:dispatch}); if(claimed)await evidence.claimDispatchInvocation({rootDir:state,record:dispatch});
  const original=evidence.readDispatchEvidenceStrict({rootDir:state,dispatchId:dispatch.dispatch_id});
  const rows=[{event:"packet_rendered",attempt_id:attempt},{event:"projection_attempt_lock_acquired",attempt_id:attempt}];
  if(claimed){
    rows.push({event:"projection_dispatch_invocation_claimed",attempt_id:attempt,dispatch_id:dispatch.dispatch_id,invocation_claim_sha256:digest(original.invocationClaimBytes)});
    for(let i=0;i<5;i++){ rows.push({event:"projection_cli_started",attempt_id:attempt,pid:900010+i}); if(i<4)rows.push({event:"projection_cli_exited",attempt_id:attempt,process_close_observed:true}); }
  }
  writeFileSync(context.activity_log_path,rows.map(x=>JSON.stringify(x)).join("\n")+"\n");
  writeFileSync(attemptLockPath(contextPath),JSON.stringify({attempt_id:attempt,pid:900009,created_at:"2026-10-29T00:00:00.000Z",owner_token:"original-lock"}));
  const markerFile = writePostPrCompletionMarker({cwd:root,prNumber:"17",branch:"feature/test",repositorySlug:dispatch.repository_slug,headRefOid:dispatch.head_ref_oid,expectedDispatchId:dispatch.dispatch_id});
  const values={permission:true,head:dispatch.head_ref_oid,comments:[],live:false,calls:[],writes:0,ancestryStatus:1};
  const runCommand=(bin,args)=>{
    values.calls.push([bin,...args]); let result;
    if(bin==="git" && args[0]==="merge-base")return {status:values.ancestryStatus,stdout:""};
    if(bin==="git" && args[0]==="rev-parse")result=args.includes("--git-common-dir")?path.join(root,".git"):root;
    else if(bin==="git" && args[0]==="remote")result="https://github.com/devpro/example.git";
    else if(bin==="gh" && args[1]==="user")result={login:"operator"};
    else if(bin==="gh" && args[1]==="repos/devpro/example")result={full_name:"devpro/example",permissions:{push:values.permission}};
    else if(bin==="gh" && args[1]==="repos/devpro/example/pulls/17")result={number:17,state:"open",merged_at:null,head:{sha:values.head,repo:{full_name:"devpro/example"}},base:{repo:{full_name:"devpro/example"}}};
    else if(bin==="gh" && args[1]==="repos/devpro/example/issues/17/comments")result=[values.comments];
    else throw Error(`unexpected external command ${bin} ${args.join(" ")}`);
    return {status:0,stdout:typeof result==="string"?result:JSON.stringify(result)};
  };
  const probeProcess=()=>{if(values.live)return;throw Object.assign(Error("absent"),{code:"ESRCH"});};
  const input={contextPath,cwd:root,runCommand,probeProcess,confirmation:evidence.interruptedDispatchConfirmation(dispatch),reason:"Operator reports interrupted wrapper; no process close receipt was observed."};
  return {root,state,context,contextPath,dispatch,original,values,input,markerFile};
}

test("operator CLI disposes five-start/four-exit attempt while retaining original marker and lock",async(t)=>{
  assert.equal(typeof cli.runInterruptedAbandonment,"function","safe interrupted operator CLI is required");
  const f=await fixture(t); const lock=readFileSync(attemptLockPath(f.contextPath));
  const result=await cli.runInterruptedAbandonment(f.input);
  assert.equal(result.status,"created");
  const actual=evidence.readDispatchEvidenceStrict({rootDir:f.state,dispatchId:f.dispatch.dispatch_id});
  assert.equal(actual.operatorDisposition.process_close_observed,false); assert.equal(actual.completion,null); assert.equal(actual.terminal,null);
  assert.deepEqual(readFileSync(attemptLockPath(f.contextPath)),lock);
  assert.deepEqual(actual.dispatchBytes,f.original.dispatchBytes);
  assert.equal(f.values.calls.some(x=>x.includes("--method")),false,"operator performs no GitHub writes");
  assert.equal((await cli.runInterruptedAbandonment(f.input)).status,"idempotent");
});

test("dry run validates recovery but creates no disposition",async(t)=>{
  assert.equal(typeof cli.runInterruptedAbandonment,"function","safe interrupted operator CLI is required");
  const f=await fixture(t); const result=await cli.runInterruptedAbandonment({...f.input,dryRun:true});
  assert.equal(result.status,"eligible");assert.equal(evidence.readDispatchEvidence({rootDir:f.state,dispatchId:f.dispatch.dispatch_id}).operatorDisposition,null);
});

for(const fault of ["live","permission","head","sticky","activity","material","confirmation"]){
  test(`operator CLI refuses ${fault} without publishing disposition`,async(t)=>{
    assert.equal(typeof cli.runInterruptedAbandonment,"function","safe interrupted operator CLI is required");const f=await fixture(t);
    if(fault==="live")f.values.live=true;
    if(fault==="permission")f.values.permission=false;
    if(fault==="head")f.values.head="f".repeat(40);
    if(fault==="sticky")f.values.comments=[{id:1,node_id:"I_1",html_url:"https://github.com/devpro/example/issues/17#issuecomment-1",updated_at:"2026-10-29T00:00:00Z",body:"<!-- cross-model-second-opinion:sticky -->"}];
    if(fault==="activity")writeFileSync(f.context.activity_log_path,"{}\n");
    if(fault==="material")writeFileSync(path.join(path.dirname(f.contextPath),"paged-review-material-full.json"),"changed");
    if(fault==="confirmation")f.input.confirmation="ABANDON wrong";
    const patterns={live:/live or unverifiable/,permission:/push permission/,head:/no longer descends/,sticky:/zero canonical sticky/,activity:/claimed activity|incomplete invocation/,material:/full material/,confirmation:/exact confirmation/};
    await assert.rejects(cli.runInterruptedAbandonment(f.input),patterns[fault]);
    assert.equal(evidence.readDispatchEvidence({rootDir:f.state,dispatchId:f.dispatch.dispatch_id}).operatorDisposition,null);
  });
}

function stickyBody(dispatch, verdict = "PASS") {
  return `<!-- cross-model-second-opinion:sticky -->\nverdict: ${verdict}\nlast_reviewed_sha: ${dispatch.head_ref_oid}\ndispatch_id: ${dispatch.dispatch_id}\nreason: The complete requested review scope was evaluated.\nRules: v7.4.3 · Tool: OpenCode · Model: deepseek/deepseek-v4-pro`;
}
function mergeGate(f, bodies) {
  process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT=JSON.stringify({headRefOid:f.dispatch.head_ref_oid,headRefName:"feature/test",baseRefName:"main",comments:bodies.map((body,i)=>({body,id:`C_${i}`,url:`https://github.com/devpro/example/pull/17#issuecomment-${i+1}`}))});
  process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES=".devpro/scripts/run-second-reviewer-projection.mjs";
  return checkCrossModelMergeGate("gh pr merge 17 --repo devpro/example --merge", f.root);
}
test("merge refuses abandoned late PASS/WARN and duplicate sticky while preserving Critical and normal remote PASS",async(t)=>{
  const f=await fixture(t); await cli.runInterruptedAbandonment(f.input);
  for(const verdict of ["PASS","WARN"]){
    const gate=mergeGate(f,[stickyBody(f.dispatch,verdict)]);
    assert.equal(gate?.block,true,`late abandoned ${verdict} cannot authorize merge`);
    assert.match(gate.reason,/operator disposition|operator-disposed|abandoned/);
  }
  assert.match(mergeGate(f,[stickyBody(f.dispatch,"CRITICAL")]).reason,/Path E/);
  const fresh={...f.dispatch,dispatch_id:"ordinary-remote-dispatch"};
  assert.equal(mergeGate(f,[stickyBody(fresh)]),null,"ordinary remote PASS does not require a new local receipt");
  assert.match(mergeGate(f,[stickyBody(f.dispatch),stickyBody(fresh)]).reason,/2.*sticky/);
});

test("operator disposition cannot publish while another owner holds the exact marker lock",async(t)=>{
  const f=await fixture(t);
  const markerFile=f.markerFile;
  await withPostPrDispatchMarkerSnapshot({markerFile,repositorySlug:f.dispatch.repository_slug,prNumber:"17",headRefOid:f.dispatch.head_ref_oid,expectedDispatchId:f.dispatch.dispatch_id},async()=>{
    await assert.rejects(cli.runInterruptedAbandonment(f.input),/marker is locked/);
    assert.equal(evidence.readDispatchEvidence({rootDir:f.state,dispatchId:f.dispatch.dispatch_id}).operatorDisposition,null);
  });
});

test("activity appended during live verification blocks publication",async(t)=>{
  const f=await fixture(t);const originalRun=f.input.runCommand;
  f.input.runCommand=(bin,args,cwd)=>{
    const result=originalRun(bin,args,cwd);
    if(bin==="gh" && args[1]==="repos/devpro/example/issues/17/comments")
      writeFileSync(f.context.activity_log_path,readFileSync(f.context.activity_log_path).toString()+JSON.stringify({event:"late_activity"})+"\n");
    return result;
  };
  await assert.rejects(cli.runInterruptedAbandonment(f.input),/activity or owner changed/);
  assert.equal(evidence.readDispatchEvidence({rootDir:f.state,dispatchId:f.dispatch.dispatch_id}).operatorDisposition,null);
});

function gatedWriterSidecar(f){
  const dir=path.dirname(f.contextPath);const bodyFile=path.join(dir,"body.md");writeFileSync(bodyFile,stickyBody(f.dispatch));
  const sidecar={schema:"devpro-second-review-sticky-credential-gate-sidecar/v1",disposition:"create",repository_slug:f.dispatch.repository_slug,pr_number:17,dispatch_id:f.dispatch.dispatch_id,body_file:bodyFile};
  sidecar.digest=digest(Buffer.from(JSON.stringify(sidecar)));
  const sidecarPath=path.join(dir,"sticky-credential-gate-sidecar.json");writeFileSync(sidecarPath,JSON.stringify(sidecar));
  return sidecarPath;
}

test("new gated writer refuses publication after operator disposition",async(t)=>{
  const f=await fixture(t);await cli.runInterruptedAbandonment(f.input);
  const sidecarPath=gatedWriterSidecar(f);
  let writes=0;
  const result=runGatedStickyWrite({sidecarPath,repoRoot:f.root,enforcePathAllowlist:false,spawnSyncImpl:()=>{writes++;return {status:0,stdout:"{}"};}});
  assert.equal(result.result.classification,"sticky_operator_disposition_blocked");assert.equal(writes,0);
});

// Models the Codex reviewer sandbox, where the evidence root is readable but outside the writable roots.
test("gated writer publishes from a read-only evidence root and still refuses a disposed dispatch",{skip:process.platform==="win32"||process.getuid?.()===0},async(t)=>{
  const f=await fixture(t);const sidecarPath=gatedWriterSidecar(f);
  let writes=0;
  const writeSticky=()=>{
    chmodSync(f.state,0o500);
    try{return runGatedStickyWrite({sidecarPath,repoRoot:f.root,enforcePathAllowlist:false,spawnSyncImpl:()=>{writes++;return {status:0,stdout:"{}"};}});}
    finally{chmodSync(f.state,0o700);}
  };
  const published=writeSticky();
  assert.equal(published.result.classification,"sticky_write_ok");assert.equal(writes,1);
  assert.deepEqual(readdirSync(f.state).filter(name=>name.startsWith(".capacity-lock")),[]);
  await cli.runInterruptedAbandonment(f.input);
  assert.equal(writeSticky().result.classification,"sticky_operator_disposition_blocked");assert.equal(writes,1);
});

test("post-PR gate keeps the old marker blocked when a disposed PASS arrives",async(t)=>{
  const f=await fixture(t);await cli.runInterruptedAbandonment(f.input);
  const init=spawnSync("git",["init","-q",f.root],{encoding:"utf8"});assert.equal(init.status,0,init.stderr);
  const hook=fileURLToPath(new URL("../hooks/post-pr-completion-check.mjs",import.meta.url));
  const result=spawnSync(process.execPath,[hook],{cwd:f.root,input:JSON.stringify({cwd:f.root}),encoding:"utf8",env:{...process.env,
    DEVPRO_AGENT_RULES_LEVEL:"lite",DEVPRO_POST_PR_GATE_MOCK_STICKY:"17",DEVPRO_POST_PR_GATE_MOCK_HEAD_REF:"17:feature/test",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA:`17:${f.dispatch.head_ref_oid}`,DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH:`17:${f.dispatch.dispatch_id}`,
    DEVPRO_POST_PR_GATE_MOCK_BODY_B64:`17:${Buffer.from(stickyBody(f.dispatch)).toString("base64")}`}});
  assert.equal(result.status,2,result.stderr);
  assert.equal(JSON.parse(result.stdout).decision,"block");
  assert.equal(existsSync(f.markerFile),true,"late disposed PASS cannot clear marker");
  assert.match(result.stdout,/block|pending|待完成/);
});

test("marker-adopted disposed predecessor requires full PR scope even when caller omits predecessor",async(t)=>{
  const f=await fixture(t);await cli.runInterruptedAbandonment(f.input);
  const context={...f.context,mode:"pr-sticky",dispatch_id:"fresh-scope-dispatch",previous_dispatch_id:null};
  await assert.rejects(planPendingPostPrCompletionMarkerBinding(context,{review_scope:{kind:"commit-range"}}),/requires a fresh full-pr review/);
  const full={...context,previous_dispatch_id:null};
  const plan=await planPendingPostPrCompletionMarkerBinding(full,{review_scope:{kind:"full-pr"}});
  assert.equal(plan.type,"same-head");assert.equal(full.previous_dispatch_id,f.dispatch.dispatch_id);
  assert.equal(JSON.parse(readFileSync(f.markerFile)).expected_dispatch_id,f.dispatch.dispatch_id,"planning does not grant marker clearance or rebind");
});

test("a failed fresh successor cannot shed the inherited full-review obligation",async(t)=>{
  const f=await fixture(t);await cli.runInterruptedAbandonment(f.input);
  const mid={...f.dispatch,dispatch_id:"fresh-but-failed",attempt_id:"fresh-failed-attempt",previous_dispatch_id:f.dispatch.dispatch_id};
  await evidence.reserveDispatchRecord({rootDir:f.state,record:mid});
  const identity=Object.fromEntries(["repository_slug","pr_number","head_ref_oid","attempt_id","dispatch_id","previous_dispatch_id"].map(k=>[k,mid[k]]));
  await evidence.writeTerminalReceipt({rootDir:f.state,record:{...identity,schema:evidence.TERMINAL_RECEIPT_SCHEMA,
    outcome_group:"spawn_or_probe_failure",classification:"reviewer_cli_spawn_failed",responsibility:evidence.TERMINAL_RECEIPT_RESPONSIBILITY,
    process_spawned:false,lifecycle_phase:"pre_spawn_known_terminal",process_close_observed:false,transport_cleanup_confirmed:true,invocation_claim_sha256:null}});
  const markerFile=f.markerFile;
  const advanced=await compareAndSwapPostPrCompletionExpectedDispatch({markerFile,repositorySlug:mid.repository_slug,prNumber:"17",headRefOid:mid.head_ref_oid,expectedDispatchId:f.dispatch.dispatch_id,nextDispatchId:mid.dispatch_id});
  assert.equal(advanced.status,"updated");assert.equal(JSON.parse(readFileSync(markerFile)).expected_dispatch_id,mid.dispatch_id);
  const failed=evidence.readDispatchEvidenceStrict({rootDir:f.state,dispatchId:mid.dispatch_id});
  assert.equal(failed.operatorDisposition,null);assert.equal(failed.dispatch.previous_dispatch_id,f.dispatch.dispatch_id);assert.equal(failed.terminal.classification,"reviewer_cli_spawn_failed");
  const context={...f.context,mode:"pr-sticky",dispatch_id:"retry-must-be-full",previous_dispatch_id:null};
  await assert.rejects(planPendingPostPrCompletionMarkerBinding(context,{review_scope:{kind:"commit-range"}}),/requires a fresh full-pr review/);
  assert.equal(context.previous_dispatch_id,mid.dispatch_id,"test reached D1 adoption, not the older direct-disposition guard");
  const full={...context,previous_dispatch_id:null};
  assert.equal((await planPendingPostPrCompletionMarkerBinding(full,{review_scope:{kind:"full-pr"}})).type,"same-head");
});

test("canonical successor PASS discharges full scope without requiring a local completion receipt",async(t)=>{
  const f=await fixture(t);await cli.runInterruptedAbandonment(f.input);
  const mid={...f.dispatch,dispatch_id:"fresh-full-reviewed",attempt_id:"fresh-full-attempt",previous_dispatch_id:f.dispatch.dispatch_id};
  await evidence.reserveDispatchRecord({rootDir:f.state,record:mid});
  const markerFile=f.markerFile;
  assert.equal((await compareAndSwapPostPrCompletionExpectedDispatch({markerFile,repositorySlug:mid.repository_slug,prNumber:"17",headRefOid:mid.head_ref_oid,expectedDispatchId:f.dispatch.dispatch_id,nextDispatchId:mid.dispatch_id})).status,"updated");
  assert.equal(evidence.readDispatchEvidence({rootDir:f.state,dispatchId:mid.dispatch_id}).completion,null);
  const snapshot={repository_slug:mid.repository_slug,pr_number:17,query_error:null,completeness:{status:"complete",pagination_exhausted:true,pages_fetched:1},comments:[{id:1,node_id:"I_1",html_url:"https://github.com/devpro/example/pull/17#issuecomment-1",updated_at:"2026-10-29T00:00:00Z",body:stickyBody(mid)}]};
  const context={...f.context,mode:"pr-sticky",dispatch_id:"focused-after-success",previous_dispatch_id:mid.dispatch_id};
  assert.equal((await planPendingPostPrCompletionMarkerBinding(context,{review_scope:{kind:"commit-range"},sticky_authority_snapshot:snapshot})).type,"same-head");
  snapshot.comments[0].body=stickyBody(mid,"UNAVAILABLE");
  await assert.rejects(planPendingPostPrCompletionMarkerBinding({...context},{review_scope:{kind:"commit-range"},sticky_authority_snapshot:snapshot}),/requires a fresh full-pr review/);
});

test("operator recovery scope walk enforces the exported existing lineage bound",async(t)=>{
  assert.ok(Number.isInteger(evidence.MAX_DISPATCHES_PER_PR_LINEAGE));
  const f=await fixture(t);await cli.runInterruptedAbandonment(f.input);
  let previous=f.dispatch.dispatch_id;
  for(let i=0;i<=evidence.MAX_DISPATCHES_PER_PR_LINEAGE;i++){
    const dispatch={...f.dispatch,dispatch_id:`scope-chain-${i}`,attempt_id:`scope-attempt-${i}`,previous_dispatch_id:previous};
    const dir=path.join(f.state,dispatch.dispatch_id);mkdirSync(dir);writeFileSync(path.join(dir,"dispatch.json"),JSON.stringify(dispatch)+"\n");previous=dispatch.dispatch_id;
  }
  const markerFile=f.markerFile;
  assert.equal((await compareAndSwapPostPrCompletionExpectedDispatch({markerFile,repositorySlug:f.dispatch.repository_slug,prNumber:"17",headRefOid:f.dispatch.head_ref_oid,expectedDispatchId:f.dispatch.dispatch_id,nextDispatchId:previous})).status,"updated");
  const context={...f.context,mode:"pr-sticky",dispatch_id:"over-bound-scope",previous_dispatch_id:previous};
  await assert.rejects(planPendingPostPrCompletionMarkerBinding(context,{review_scope:{kind:"commit-range"}}),/scope lineage is cyclic or exceeds its bound/);
});

test("an accepted external UNAVAILABLE completion cannot discharge inherited full review",async(t)=>{
  const f=await fixture(t);await cli.runInterruptedAbandonment(f.input);
  const mid={...f.dispatch,dispatch_id:"external-unavailable",attempt_id:"external-unavailable-attempt",previous_dispatch_id:f.dispatch.dispatch_id,
    executor_kind:"external-evaluator",reviewer_family:"gemini",primary_family:"openai-codex",reviewer_tool:"Gemini CLI",sticky_write_action:"create",sticky_target_comment_id:null,sticky_snapshot_digest:"d".repeat(64),issued_at:"2026-10-29T00:00:00.000Z"};
  for(const k of ["paged_full_material_sha256","paged_full_material_created_at","paged_full_material_expires_at"])delete mid[k];
  await evidence.reserveDispatchRecord({rootDir:f.state,record:mid});
  const identity=Object.fromEntries(["repository_slug","pr_number","head_ref_oid","attempt_id","dispatch_id","previous_dispatch_id"].map(k=>[k,mid[k]]));
  const payload={schema:evidence.COMPLETION_SCHEMA,...identity,sticky_verdict:"UNAVAILABLE",sticky_last_reviewed_sha:mid.head_ref_oid,sticky_dispatch_id:mid.dispatch_id,sticky_comment_id:5150,sticky_comment_url:"https://github.com/devpro/example/pull/17#issuecomment-5150",sticky_body_sha256:"e".repeat(64)};
  await evidence.writeExternalClosureSlot({rootDir:f.state,dispatchId:mid.dispatch_id,kind:"accepted",receiptPayload:payload});
  await evidence.writeExternalCompletionReceipt({rootDir:f.state,dispatchId:mid.dispatch_id});
  assert.equal(evidence.readDispatchEvidenceStrict({rootDir:f.state,dispatchId:mid.dispatch_id}).completion.sticky_verdict,"UNAVAILABLE");
  const markerFile=f.markerFile;
  assert.equal((await compareAndSwapPostPrCompletionExpectedDispatch({markerFile,repositorySlug:mid.repository_slug,prNumber:"17",headRefOid:mid.head_ref_oid,expectedDispatchId:f.dispatch.dispatch_id,nextDispatchId:mid.dispatch_id})).status,"updated");
  const context={...f.context,mode:"pr-sticky",dispatch_id:"focused-after-unavailable",previous_dispatch_id:null};
  await assert.rejects(planPendingPostPrCompletionMarkerBinding(context,{review_scope:{kind:"commit-range"}}),/requires a fresh full-pr review/);
  assert.equal(context.previous_dispatch_id,mid.dispatch_id);
});

const NEXT_HEAD="9".repeat(40);
const withFastForwardGit=async(t,operation)=>{
  // The renderer verifies ancestry against the repository it ships in, so a fixture sha needs a stand-in git.
  const bin=realpathSync(mkdtempSync(path.join(tmpdir(),"interrupted-recovery-git-")));t.after(()=>rmSync(bin,{recursive:true,force:true}));
  writeFileSync(path.join(bin,"git"),"#!/bin/sh\n[ \"$1\" = merge-base ] && exit 0\nexit 64\n");chmodSync(path.join(bin,"git"),0o755);
  const priorPath=process.env.PATH;process.env.PATH=`${bin}${path.delimiter}${priorPath}`;
  try{return await operation();}finally{process.env.PATH=priorPath;}
};
const successor=(f)=>({...f.context,mode:"pr-sticky",head_ref_oid:NEXT_HEAD,dispatch_id:"fresh-after-push",attempt_id:"fresh-after-push-attempt",previous_dispatch_id:null});
const reviewComment=(dispatch,verdict,id=1)=>({id,node_id:`I_${id}`,html_url:`https://github.com/devpro/example/pull/17#issuecomment-${id}`,updated_at:"2026-10-29T00:00:00Z",body:stickyBody(dispatch,verdict)});
const earlierRound=(f)=>({...f.dispatch,dispatch_id:"earlier-round-dispatch",head_ref_oid:"c".repeat(40)});

test("interrupted attempt is abandoned after the PR head fast-forwarded, and the fresh render proceeds",{skip:process.platform==="win32"},async(t)=>{
  const f=await fixture(t);f.values.head=NEXT_HEAD;f.values.ancestryStatus=0;
  await withFastForwardGit(t,()=>assert.rejects(planPendingPostPrCompletionMarkerBinding(successor(f),{review_scope:{kind:"full-pr"}}),/prior-head dispatch must have/));
  assert.equal((await cli.runInterruptedAbandonment({...f.input,dryRun:true})).status,"eligible");
  assert.equal((await cli.runInterruptedAbandonment(f.input)).status,"created");
  const actual=evidence.readDispatchEvidenceStrict({rootDir:f.state,dispatchId:f.dispatch.dispatch_id}).operatorDisposition;
  assert.equal(actual.head_ref_oid,f.dispatch.head_ref_oid);assert.equal(actual.remote_pr_head,NEXT_HEAD);
  assert.ok(f.values.calls.some(call=>call[0]==="git"&&call[1]==="merge-base"&&call.includes("--is-ancestor")&&call.includes(f.dispatch.head_ref_oid)&&call.includes(NEXT_HEAD)));
  await withFastForwardGit(t,async()=>{
    const context=successor(f);
    const plan=await planPendingPostPrCompletionMarkerBinding(context,{review_scope:{kind:"full-pr"}});
    assert.equal(plan.type,"verified-fast-forward-head");assert.equal(context.previous_dispatch_id,f.dispatch.dispatch_id);
    await assert.rejects(planPendingPostPrCompletionMarkerBinding(successor(f),{review_scope:{kind:"commit-range"}}),/requires a fresh full-pr review/);
  });
});

test("an unverifiable head transition stays blocked and tells the operator how to resolve it",async(t)=>{
  const f=await fixture(t);f.values.head=NEXT_HEAD;f.values.ancestryStatus=128;
  await assert.rejects(cli.runInterruptedAbandonment(f.input),/cannot verify.*fetch/i);
  assert.equal(evidence.readDispatchEvidence({rootDir:f.state,dispatchId:f.dispatch.dispatch_id}).operatorDisposition,null);
});

test("dry run needs no challenge, prints the exact one, and execution still requires it",async(t)=>{
  const f=await fixture(t);const {confirmation,...withoutChallenge}=f.input;
  const result=await cli.runInterruptedAbandonment({...withoutChallenge,dryRun:true});
  assert.equal(result.status,"eligible");assert.equal(result.confirmation,confirmation);
  assert.match(result.next_step,/user/);assert.match(result.next_step,/--confirm/);assert.match(result.next_step,/--reason/);
  await assert.rejects(cli.runInterruptedAbandonment(withoutChallenge),/exact confirmation/);
  assert.equal(evidence.readDispatchEvidence({rootDir:f.state,dispatchId:f.dispatch.dispatch_id}).operatorDisposition,null);
});

test("a context path from the collision message resolves against the main checkout from any cwd",async(t)=>{
  const f=await fixture(t);const elsewhere=path.join(f.root,".worktree","other-change");mkdirSync(elsewhere,{recursive:true});
  const relative=path.join("notes","cross-review",f.context.attempt_id,"observability-context.json");
  assert.equal((await cli.runInterruptedAbandonment({...f.input,cwd:elsewhere,contextPath:relative,dryRun:true})).status,"eligible");
});

test("one earlier-round sticky does not block abandonment and stays untouched and in force",async(t)=>{
  const f=await fixture(t);const prior=earlierRound(f);f.values.comments=[reviewComment(prior,"CRITICAL")];
  assert.equal((await cli.runInterruptedAbandonment(f.input)).status,"created");
  assert.equal(f.values.calls.some(call=>call.includes("--method")),false,"the earlier sticky is left as it is");
  assert.match(mergeGate(f,[stickyBody(prior,"PASS")]).reason,/Path D/,"an earlier-head verdict stays stale for merge");
  assert.match(mergeGate(f,[stickyBody({...prior,head_ref_oid:f.dispatch.head_ref_oid},"CRITICAL")]).reason,/Path E/,"same-head findings keep blocking merge");
  const plan=await planPendingPostPrCompletionMarkerBinding({...f.context,mode:"pr-sticky",dispatch_id:"fresh-after-earlier-round",previous_dispatch_id:null},{review_scope:{kind:"full-pr"}});
  assert.equal(plan.type,"same-head");
});

for(const [shape,comments] of [
  ["a sticky bound to the interrupted dispatch",(f)=>[reviewComment(f.dispatch,"WARN")]],
  ["duplicate stickies",(f)=>[reviewComment(earlierRound(f),"WARN",1),reviewComment({...earlierRound(f),dispatch_id:"another-round"},"PASS",2)]],
]){
  test(`abandonment still refuses ${shape}`,async(t)=>{
    const f=await fixture(t);f.values.comments=comments(f);
    await assert.rejects(cli.runInterruptedAbandonment(f.input),/zero canonical sticky/);
    assert.equal(evidence.readDispatchEvidence({rootDir:f.state,dispatchId:f.dispatch.dispatch_id}).operatorDisposition,null);
  });
}

test("the collision names the abandon command for this attempt and rules out the dead ends",{skip:process.platform==="win32"},async(t)=>{
  const f=await fixture(t);
  await withFastForwardGit(t,()=>assert.rejects(planPendingPostPrCompletionMarkerBinding(successor(f),{review_scope:{kind:"full-pr"}}),(error)=>{
    assert.match(error.message,/prior-head dispatch must have/);
    assert.ok(error.message.includes(`abandon-interrupted-second-review.mjs notes/cross-review/${f.dispatch.attempt_id}/observability-context.json --dry-run`));
    assert.match(error.message,/user/);assert.match(error.message,/--reconcile-\* modes/);assert.match(error.message,/close-stale-second-review-reservation/);
    return true;
  }));
});

test("the collision names the abandon entry for an attempt that died before claiming",{skip:process.platform==="win32"},async(t)=>{
  const f=await fixture(t,{claimed:false});
  await withFastForwardGit(t,()=>assert.rejects(planPendingPostPrCompletionMarkerBinding(successor(f),{review_scope:{kind:"full-pr"}}),(error)=>{
    assert.match(error.message,/prior-head dispatch must have/);
    assert.ok(error.message.includes(`abandon-interrupted-second-review.mjs notes/cross-review/${f.dispatch.attempt_id}/observability-context.json --dry-run`));
    return true;
  }));
});

test("a runner that died before claiming is abandoned truthfully and the fresh render proceeds",async(t)=>{
  const f=await fixture(t,{claimed:false});const lock=readFileSync(attemptLockPath(f.contextPath));
  assert.equal((await cli.runInterruptedAbandonment({...f.input,dryRun:true})).status,"eligible");
  assert.equal((await cli.runInterruptedAbandonment(f.input)).status,"created");
  const actual=evidence.readDispatchEvidenceStrict({rootDir:f.state,dispatchId:f.dispatch.dispatch_id});
  assert.equal(actual.operatorDisposition.process_spawned,false,"no reviewer process ever started");
  assert.equal(actual.operatorDisposition.invocation_claim_sha256,null);
  assert.equal(actual.operatorDisposition.lifecycle_slot_sha256,null);
  assert.equal(actual.invocationClaim,null);assert.equal(actual.terminal,null);
  assert.deepEqual(readFileSync(attemptLockPath(f.contextPath)),lock);
  await assert.rejects(evidence.claimDispatchInvocation({rootDir:f.state,record:f.dispatch}),/operator disposition/,"a late runner cannot claim a disposed attempt");
  assert.equal((await cli.runInterruptedAbandonment(f.input)).status,"idempotent");
  const plan=await planPendingPostPrCompletionMarkerBinding({...f.context,mode:"pr-sticky",dispatch_id:"fresh-after-unclaimed",previous_dispatch_id:null},{review_scope:{kind:"full-pr"}});
  assert.equal(plan.type,"same-head");
});

test("an unclaimed attempt without a runner lock is not stuck and needs no abandonment",async(t)=>{
  const f=await fixture(t,{claimed:false});rmSync(attemptLockPath(f.contextPath));
  await assert.rejects(cli.runInterruptedAbandonment(f.input),/never held a runner lock/);
  assert.equal(evidence.readDispatchEvidence({rootDir:f.state,dispatchId:f.dispatch.dispatch_id}).operatorDisposition,null);
});

test("an unclaimed attempt with a live runner or reviewer activity is preserved",async(t)=>{
  const live=await fixture(t,{claimed:false});live.values.live=true;
  await assert.rejects(cli.runInterruptedAbandonment(live.input),/live or unverifiable/);
  const spawned=await fixture(t,{claimed:false});
  writeFileSync(spawned.context.activity_log_path,`${JSON.stringify({event:"projection_cli_started",attempt_id:spawned.dispatch.attempt_id,pid:900010})}\n`);
  await assert.rejects(cli.runInterruptedAbandonment(spawned.input),/has reviewer activity/);
  for(const f of [live,spawned])assert.equal(evidence.readDispatchEvidence({rootDir:f.state,dispatchId:f.dispatch.dispatch_id}).operatorDisposition,null);
});

test("a runner that died between page windows can be abandoned",async(t)=>{
  const f=await fixture(t);
  writeFileSync(f.context.activity_log_path,`${readFileSync(f.context.activity_log_path,"utf8")}${JSON.stringify({event:"projection_cli_exited",attempt_id:f.dispatch.attempt_id,process_close_observed:true})}\n`);
  assert.equal((await cli.runInterruptedAbandonment(f.input)).status,"created");
  const actual=evidence.readDispatchEvidenceStrict({rootDir:f.state,dispatchId:f.dispatch.dispatch_id});
  assert.equal(actual.operatorDisposition.process_spawned,true);assert.equal(actual.operatorDisposition.process_close_observed,false);
});

test("the shared recovery hint is exported beside the confirmation it leads to",()=>{
  assert.match(evidence.interruptedDispatchRecoveryHint("attempt-x"),/notes\/cross-review\/attempt-x\/observability-context\.json --dry-run/);
});
