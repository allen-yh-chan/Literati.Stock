import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createReviewGithubSpawn } from '../lib/second-review-github-transport.mjs';
import { runPrLinksRead } from '../read-second-review-pr-links.mjs';
const head='a'.repeat(40);
const session={protocol:1,endpoint:'https://executor.example/reviewer-transport',ticket:'c'.repeat(64),
  expiresAt:new Date(Date.now()+60_000).toISOString(),repository:'org/repo',number:7,expectedHeadSha:head,dispatchId:'dispatch-test',scope:'sticky'};
const env={DEVPRO_SECOND_REVIEW_GITHUB_TRANSPORT_FILE:'/private/session.json',GH_REPO:'org/repo'};
test('PR-link discovery uses only the exact repository/PR metadata command',()=>{
  let args;
  const result=runPrLinksRead(['org/repo','7'],{env,spawn:(...value)=>{args=value;return {status:0,stdout:'{}'};}});
  assert.equal(result.status,0);assert.equal(args[0],'gh');
  assert.deepEqual(args[1],['pr','view','7','--repo','org/repo','--json','closingIssuesReferences']);
  assert.throws(()=>runPrLinksRead(['org/repo','7','--comments']),/arguments_invalid/);
});
function fixture(authentication={installed:false,authentication:'not_logged_in'}) {
  const native=[],remote=[];
  const spawn=createReviewGithubSpawn({
    nativeSpawn:(...args)=>{native.push(args);return {status:0,stdout:'native',stderr:''};},
    probe:()=>authentication,readSession:()=>session,
    invoke:(ticket,request)=>{remote.push({ticket,request});return {protocol:1,status:'completed',data:{headRefOid:head}};},
  });
  return {spawn,native,remote};
}
test('no gh uses the bound MCP transport for the actual reviewer head read',()=>{
  const f=fixture();const result=f.spawn('gh',['pr','view','7','--repo','org/repo','--json','headRefOid'],{env,encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stdout,JSON.stringify({headRefOid:head}));
  assert.equal(f.native.length,0);assert.deepEqual(f.remote[0].request,{protocol:1,operation:'metadata'});
});
test('usable gh remains first even when an MCP session is present',()=>{
  const f=fixture({installed:true,authentication:'authenticated'});
  assert.equal(f.spawn('gh',['pr','view','7'],{env}).stdout,'native');
  assert.equal(f.native.length,1);assert.equal(f.remote.length,0);
});
test('explicitly invalid native authentication does not switch to MCP',()=>{
  const f=fixture({installed:true,authentication:'invalid'});
  assert.notEqual(f.spawn('gh',['pr','view','7'],{env}).status,0);
  assert.equal(f.remote.length,0);assert.equal(f.native.length,0);
});
test('unknown preflight uses the existing independently bound reviewer ticket',()=>{
  const f=fixture({installed:true,authentication:'unknown'});
  const result=f.spawn('gh',['pr','view','7','--repo','org/repo','--json','headRefOid'],{env});
  assert.equal(result.status,0);assert.equal(f.native.length,0);
  assert.deepEqual(f.remote[0].request,{protocol:1,operation:'metadata'});
});
test('unknown preflight cannot widen the reviewer ticket repository',()=>{
  const f=fixture({installed:true,authentication:'unknown'});
  const result=f.spawn('gh',['pr','view','7','--repo','other/repo','--json','headRefOid'],{env});
  assert.notEqual(result.status,0);assert.match(result.stderr,/reviewer_repository_mismatch/);
  assert.equal(f.remote.length,0);assert.equal(f.native.length,0);
});
test('a ticket cannot query another repository, PR or arbitrary API endpoint',()=>{
  for(const args of [
    ['pr','view','8','--repo','org/repo','--json','headRefOid'],
    ['pr','view','7','--repo','other/repo','--json','headRefOid'],
    ['api','https://untrusted.example/data'],['api','repos/org/repo/releases'],
  ]) {const f=fixture();assert.notEqual(f.spawn('gh',args,{env}).status,0);assert.equal(f.remote.length,0);}
});
test('generic shell API writes cannot use a reviewer ticket without the gated writer binding',()=>{
  const f=fixture();const result=f.spawn('gh',['api','repos/org/repo/issues/7/comments','-X','POST','--input','-'],{env,input:JSON.stringify({body:'example'})});
  assert.notEqual(result.status,0);assert.equal(f.remote.length,0);
});
test('unsupported output formatting is refused before a possible write',()=>{
  const f=fixture();
  const result=f.spawn('gh',['api','repos/org/repo/issues/7/comments','-X','POST','--input','-','--jq','.unsupported'],
    {env,input:JSON.stringify({body:'example'}),reviewerWrite:{dispatchId:'dispatch-test',bodySha256:createHash('sha256').update('example').digest('hex')}});
  assert.notEqual(result.status,0);assert.equal(f.remote.length,0);
});
test('readback-only confirmation is bounded and never resends an already applied update',()=>{
  const calls=[];
  const spawn=createReviewGithubSpawn({nativeSpawn:()=>{throw new Error('native gh must not be used');},
    probe:()=>({installed:false,authentication:'not_logged_in'}),readSession:()=>session,
    invoke:(_session,request)=>{calls.push(request.operation);return {protocol:1,status:'completed',data:{id:10,body:'example'}};}});
  const args=['api','repos/org/repo/issues/comments/10','-X','PATCH','--input','-'];
  const options={env,encoding:'utf8',input:JSON.stringify({body:'example'}),reviewerWrite:{dispatchId:'dispatch-test',bodySha256:createHash('sha256').update('example').digest('hex')}};
  const confirmed=spawn('gh',args,options);assert.equal(confirmed.status,0);assert.equal(confirmed.readback_only,true);
  const bounded=spawn('gh',args,{...options,maxBuffer:1});assert.notEqual(bounded.status,0);
  assert.deepEqual(calls,['comment','comment']);
});
