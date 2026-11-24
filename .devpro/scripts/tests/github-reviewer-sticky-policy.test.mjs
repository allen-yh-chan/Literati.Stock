import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeGithubOperation, evaluateGithubOperation } from '../hooks/lib/github-operation-policy.mjs';

const head='a'.repeat(40);
const body=`<!-- cross-model-second-opinion:sticky -->\nverdict: PASS\nlast_reviewed_sha: ${head}\ndispatch_id: dispatch-example\nreason: Reviewed the complete requested change.\nRules: v7.8.1 · Tool: Claude Code · Model: claude-test`;
const priorHash=createHash('sha256').update(body).digest('hex');
const args=()=>({repository:'org/repo',number:7,expectedHeadSha:head,dispatchId:'dispatch-example',disposition:'create',body});
const evidence=()=>({pr:{state:'open',head:{sha:head},base:{ref:'main'}},comments:[],complete:{comments:true}});
const run=(input=args(),facts=evidence())=>evaluateGithubOperation(normalizeGithubOperation('github_write_review_sticky',input),facts);

test('dedicated reviewer publication accepts the current dispatch while ordinary comments remain closed',()=>{
  assert.equal(run().allowed,true);
  assert.equal(evaluateGithubOperation(normalizeGithubOperation('github_comment_issue',{repository:'org/repo',number:7,text:body})).reasonCode,'reviewer_writer_required');
});
test('dedicated publication refuses head movement, incomplete comments and a different dispatch',()=>{
  const moved=evidence();moved.pr.head.sha='b'.repeat(40);
  assert.equal(run(args(),moved).reasonCode,'pr_head_or_base_changed');
  const rebased=evidence();rebased.pr.base.ref='production';
  assert.equal(run({...args(),expectedBaseBranch:'main'},rebased).reasonCode,'pr_head_or_base_changed');
  const incomplete=evidence();incomplete.complete.comments=false;
  assert.equal(run(args(),incomplete).reasonCode,'sticky_evidence_incomplete');
  assert.equal(run({...args(),dispatchId:'dispatch-other'}).reasonCode,'sticky_dispatch_or_head_mismatch');
});
test('create cannot add a second authority and update must bind the exact remote comment',()=>{
  const facts=evidence();facts.comments=[{id:10,body}];
  assert.equal(run(args(),facts).reasonCode,'sticky_disposition_changed');
  assert.equal(run({...args(),disposition:'update',commentId:10,expectedCommentBodySha256:priorHash},facts).allowed,true);
  assert.equal(run({...args(),disposition:'update',commentId:11},facts).reasonCode,'sticky_disposition_changed');
  facts.comments.push({id:12,body});
  assert.equal(run({...args(),disposition:'update',commentId:10},facts).reasonCode,'sticky_disposition_changed');
});
test('update binds the exact remotely observed predecessor rather than blindly overwriting it',()=>{
  const facts=evidence();facts.comments=[{id:10,body}];
  const update={...args(),disposition:'update',commentId:10};
  assert.equal(run(update,facts).reasonCode,'sticky_predecessor_required');
  assert.equal(run({...update,expectedCommentBodySha256:'b'.repeat(64)},facts).reasonCode,'sticky_predecessor_changed');
});
test('the dedicated operation retains body and human-decision boundaries',()=>{
  assert.equal(run({...args(),body:'Normal comment'}).reasonCode,'sticky_body_invalid');
  assert.equal(run({...args(),body:body+'\n<!-- devpro-cross-model-waiver -->'}).reasonCode,'human_decision_required');
});
