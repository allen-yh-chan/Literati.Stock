import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGithubOperation, evaluateGithubOperation } from '../hooks/lib/github-operation-policy.mjs';

const sha = 'a'.repeat(40);
const footer = 'Rules: v7.8.1 · Tool: Codex · Model: GPT-6';
const merge = () => normalizeGithubOperation('github_merge_pr', {repository:'org/repo',number:7,baseBranch:'main',expectedHeadSha:sha});
const evidence = () => ({
  pr: {state:'open',head:{ref:'feature/add-example',sha},base:{ref:'main'},draft:false},
  comments: [{id:1,body:`<!-- cross-model-second-opinion:sticky -->\nverdict: PASS\nlast_reviewed_sha: ${sha}\ndispatch_id: test-github-policy\nreason: Independently reviewed the requested change.\nRules: v7.8.1 · Tool: Claude Code · Model: claude-test`}],
  files: [{filename:'src/app.cs',status:'modified'}], checks:[], statuses:[],
  complete:{comments:true,files:true,checks:true,statuses:true},
});
test('closed catalog: recognized operations are typed; unknown names never become reads',()=>{
  assert.equal(normalizeGithubOperation('github_read_pr',{repository:'org/repo',number:7}).kind,'read');
  assert.equal(merge().kind,'merge');
  assert.equal(normalizeGithubOperation('github_future_write',{}).kind,'unsupported');
  assert.equal(normalizeGithubOperation('github_git_ticket',{operation:'write',repository:'org/repo',ref:'refs/heads/main'}).kind,'contents');
  // preflight／authorization_status 只回約束與授權狀態，屬讀取；先前缺這兩個短名會被歸成 unsupported 而永遠被擋。
  for(const name of ['github_preflight','github_authorization_status']) {
    const op=normalizeGithubOperation(name,{repository:'org/repo',branch:'chore/x'});
    assert.deepEqual([op.kind,evaluateGithubOperation(op).allowed,name],['read',true,name]);
  }
  const status=evaluateGithubOperation(normalizeGithubOperation('github_policy_status',{}));
  assert.ok(status.capabilities.includes('github_commit_files'));
  assert.ok(status.capabilities.includes('git_proxy_ticket'));
  for(const name of ['github_bundle_upload_local','github_push_upload_begin','github_push_upload_chunk','github_push_upload_finish'])
    assert.ok(status.capabilities.includes(name),name);
});
test('bundle upload needs repository and branch on begin and is never a model-called continuation',()=>{
  for(const name of ['github_bundle_upload_local','github_push_upload_begin']) {
    const decide=args=>evaluateGithubOperation(normalizeGithubOperation(name,args));
    assert.deepEqual([decide({repository:'org/repo',branch:'chore/wire-github-bundle-upload-policy'}).allowed,name],[true,name]);
    // Missing branch reuses the shared contents-write denial; the protected names and release/* stay closed.
    for(const args of [{repository:'org/repo'},{repository:'org/repo',branch:''},
      ...['main','master','production','integration','release/v7.13.0'].map(branch=>({repository:'org/repo',branch}))])
      assert.deepEqual([decide(args).allowed,decide(args).reasonCode,name,JSON.stringify(args)],[false,'protected_ref',name,JSON.stringify(args)]);
    assert.deepEqual([decide({branch:'chore/x'}).allowed,decide({branch:'chore/x'}).reasonCode,name],[false,'repository_required',name]);
  }
  // chunk/finish are the plugin's own second and third legs of the begin authorization, so a direct call
  // is refused even when it supplies repository and branch.
  for(const name of ['github_push_upload_chunk','github_push_upload_finish'])
    for(const args of [{},{repository:'org/repo',branch:'chore/x'},{uploadId:'upload-1',offset:0,chunkBase64:'AA=='}])
      assert.deepEqual([evaluateGithubOperation(normalizeGithubOperation(name,args)).reasonCode,name],[
        'upload_continuation_not_model_callable',name],JSON.stringify(args));
});
test('body, provenance and protected ref checks also apply to MCP',()=>{
  const create=(args)=>evaluateGithubOperation(normalizeGithubOperation('github_create_pr',{repository:'org/repo',head:'feature/add-example',baseBranch:'main',...args}));
  assert.equal(create({body:'missing footer'}).allowed,false);
  assert.equal(create({body:`Description\n${footer}`}).allowed,true);
  assert.equal(create({body:`Description\n${footer}`,baseBranch:'production'}).allowed,false);
  assert.equal(create({body:`Description\n${footer}`,baseBranch:'refs/heads/production'}).allowed,false);
  // A Path W waiver is posted by the AI after the user says so in the conversation; lineage approval stays human-only.
  assert.equal(create({body:`<!-- devpro-cross-model-waiver -->\n${footer}`}).allowed,true);
  assert.equal(create({body:`<!-- devpro-post-pr-lineage-approval -->\n${footer}`}).reasonCode,"human_decision_required");
  assert.equal(evaluateGithubOperation(normalizeGithubOperation('github_commit_files',{repository:'org/repo',branch:'main'})).allowed,false);
});
test('backend-created commits inspect the actual message and preserve native attribution severity',()=>{
  const commit=message=>evaluateGithubOperation(normalizeGithubOperation('github_commit_files',{
    repository:'org/repo',branch:'feature/add-example',message}));
  assert.equal(commit(undefined).allowed,false);
  assert.equal(commit(`Example\nCo-Authored-By: Codex <agent@example.invalid>\n${footer}`).reasonCode,'forbidden_attribution');
  assert.equal(commit(`Example\nCo-Authored-By: Jane Doe <jane@example.invalid>\n${footer}`).allowed,true);
  assert.equal(commit(`Example\n${footer}`).allowed,true);
  const legacy=commit('Example');
  assert.equal(legacy.allowed,true);
  assert.equal(legacy.advisory,'commit_provenance_footer_required');
});
test('merge needs collected current-head review and complete terminal CI evidence',()=>{
  assert.equal(evaluateGithubOperation(merge(),evidence()).allowed,true);
  assert.equal(evaluateGithubOperation(merge(),{pass:true}).allowed,false);
  for(const modify of [
    e=>e.pr.head.sha='b'.repeat(40), e=>e.comments=[], e=>e.complete.comments=false,
    e=>e.checks=[{status:'in_progress',conclusion:null}],
    e=>e.checks=[{status:'completed',conclusion:'failure'}],
    e=>e.statuses=[{state:'pending'}], e=>e.pr.draft=true,
  ]) { const e=evidence();modify(e);assert.equal(evaluateGithubOperation(merge(),e).allowed,false); }
});
// add-github-policy-blockers (AuthBroker #1): a denial lists every independent failed check in blockers;
// reasonCode/reason stay the first one, i.e. what the sequential order returned before.
const codes = r => r.blockers.map(b => b.reasonCode);
test('a denial lists every independent failed check and keeps the first as reasonCode',()=>{
  const e=evidence();
  e.pr.head.sha='b'.repeat(40);e.pr.draft=true;e.checks=[{status:'completed',conclusion:'failure'}];e.comments=[];
  const merged=evaluateGithubOperation(merge(),e);
  assert.equal(merged.allowed,false);
  assert.deepEqual(codes(merged),['pr_head_or_base_changed','pr_not_ready','ci_not_successful','second_review_required']);
  assert.equal(merged.reasonCode,'pr_head_or_base_changed');
  assert.equal(merged.reason,merged.blockers[0].reason);
  assert.ok(merged.blockers.every(b=>typeof b.reason==='string' && b.reason.length>0));
  // Incomplete CI is one blocker, not followed by a "not successful" judgement on missing data.
  const ci=evidence();ci.complete.checks=false;ci.checks=[{status:'completed',conclusion:'failure'}];
  assert.deepEqual(codes(evaluateGithubOperation(merge(),ci)),['ci_evidence_incomplete']);
  // Files evidence decides whether review is needed at all, so nothing after it runs.
  const files=evidence();files.pr.draft=true;files.complete.files=false;files.comments=[];
  assert.deepEqual(codes(evaluateGithubOperation(merge(),files)),['pr_not_ready','files_evidence_incomplete']);
  // A PR creation with a bad body and a local review head reports both.
  const pr=evaluateGithubOperation(normalizeGithubOperation('github_create_pr',{repository:'org/repo',head:'review/pr12',baseBranch:'production',body:'no footer'}));
  assert.deepEqual(codes(pr),['provenance_footer_required','local_review_branch','production_release_carrier_required']);
  assert.equal(pr.reasonCode,'provenance_footer_required');
  // A shared body denial without its own reason still gives the blocker a string reason.
  assert.equal(pr.blockers[0].reason,'provenance_footer_required');
  // A protected ref and an unsigned commit message are independent.
  const commit=evaluateGithubOperation(normalizeGithubOperation('github_commit_files',{repository:'org/repo',branch:'main',message:''}));
  assert.deepEqual(codes(commit),['protected_ref','commit_message_required']);
});
test('preconditions stop dependent checks and a single denial still carries blockers',()=>{
  const bad=evaluateGithubOperation(normalizeGithubOperation('github_merge_pr',{repository:'bad',number:7,baseBranch:'main',expectedHeadSha:sha}),evidence());
  assert.deepEqual(codes(bad),['repository_required']);
  const noPr=evaluateGithubOperation(merge(),{});
  assert.deepEqual(codes(noPr),['pr_evidence_unavailable']);
  assert.deepEqual(codes(evaluateGithubOperation(normalizeGithubOperation('github_future_write',{}))),['github_operation_unsupported']);
  // Allowed results carry no blockers.
  assert.equal(evaluateGithubOperation(merge(),evidence()).blockers,undefined);
  // Every previously denied case keeps its decision and its first reason.
  for(const modify of [e=>e.pr.head.sha='b'.repeat(40), e=>e.comments=[], e=>e.complete.comments=false, e=>e.pr.draft=true]) {
    const e=evidence();modify(e);const r=evaluateGithubOperation(merge(),e);
    assert.equal(r.allowed,false);assert.equal(r.blockers[0].reasonCode,r.reasonCode);
  }
});
test('exemptions do not exempt production routing, CI or immutable head checks',()=>{
  const e=evidence();e.pr.head.ref='chore/update-docs';e.comments=[];
  assert.equal(evaluateGithubOperation(merge(),e).allowed,true);
  e.pr.base.ref='production';
  assert.equal(evaluateGithubOperation({...merge(),baseBranch:'production'},e).allowed,false);
  e.pr.head.ref='release/v1.2.3';
  assert.equal(evaluateGithubOperation({...merge(),baseBranch:'production'},e).allowed,true);
  e.statuses=[{state:'failure'}];
  assert.equal(evaluateGithubOperation({...merge(),baseBranch:'production'},e).allowed,false);
});
test('renaming a proposal away cannot turn a behavior change into a chore-A exemption',()=>{
  const e=evidence();e.pr.head.ref='chore/update-docs';e.comments=[];
  e.files=[{filename:'notes/copied.md',previous_filename:'openspec/changes/add-example/proposal.md',status:'renamed'}];
  assert.equal(evaluateGithubOperation(merge(),e).allowed,false);
});
test('MCP git writes retain integration and release branch protection',()=>{
  for(const ref of ['integration','release/v1.2.3','refs/heads/production']) {
    assert.equal(evaluateGithubOperation(normalizeGithubOperation('github_git_ticket',{repository:'org/repo',operation:'write',reference:ref})).reasonCode,'protected_ref');
  }
});
test('ordinary MCP comments cannot bypass the independent reviewer publication contract',()=>{
  const comment=text=>evaluateGithubOperation(normalizeGithubOperation('github_comment_issue',{repository:'org/repo',number:7,text}));
  assert.equal(comment(`Normal progress update\n${footer}`).allowed,true);
  const result=comment(evidence().comments[0].body);
  assert.equal(result.allowed,false);
  assert.equal(result.reasonCode,'reviewer_writer_required');
});
test('git transport uses its public reference argument without borrowing unrelated aliases',()=>{
  const ticket=reference=>normalizeGithubOperation('github_git_ticket',{repository:'org/repo',operation:'write',reference});
  assert.equal(evaluateGithubOperation(ticket('refs/heads/feature/add-example')).allowed,true);
  assert.equal(evaluateGithubOperation(ticket('refs/heads/main')).allowed,false);
  assert.equal(evaluateGithubOperation(normalizeGithubOperation('github_git_ticket',{repository:'org/repo',operation:'write',reference:'refs/heads/main',branch:'feature/fake'})).allowed,false);
});
test('review pins head; approve still needs provenance and human waiver cannot be forged',()=>{
  const review=normalizeGithubOperation('github_review_pr',{repository:'org/repo',number:7,baseBranch:'main',expectedHeadSha:sha,decision:'approve'});
  assert.equal(evaluateGithubOperation(review,evidence()).allowed,false);
  review.body=footer;
  assert.equal(evaluateGithubOperation(review,evidence()).allowed,true);
  review.expectedHeadSha='b'.repeat(40);
  assert.equal(evaluateGithubOperation(review,evidence()).allowed,false);
});
test('repository creation is a typed write with closed arguments, GitHub naming rules and typed options',()=>{
  const create=args=>evaluateGithubOperation(normalizeGithubOperation('github_create_repository',args));
  const ok={repository:'devpro-tw/new-repo',ownerType:'organization'};
  assert.equal(normalizeGithubOperation('github_create_repository',ok).kind,'repository_create');
  assert.equal(normalizeGithubOperation('github_create_repo',ok).kind,'unsupported');
  assert.ok(evaluateGithubOperation(normalizeGithubOperation('github_policy_status',{})).capabilities.includes('github_create_repository'));
  // Absent options take the backend defaults; a description is not a PR body, so it needs no footer.
  assert.equal(create(ok).allowed,true);
  assert.equal(create({...ok,ownerType:'personal',description:'',isPrivate:false,autoInit:true}).allowed,true);
  assert.equal(create({...ok,description:'d'.repeat(350)}).allowed,true);
  for(const repository of ['a'.repeat(39)+'/'+'r'.repeat(100),'a-b-c/x','Org9/.github','org/re.po_x-1','o/r'])
    assert.equal(create({...ok,repository}).allowed,true,repository);
  for(const repository of ['-org/repo','org-/repo','o--rg/repo','org_x/repo','a'.repeat(40)+'/repo','/repo','org/','org/.','org/..',
    'org/a/b','../repo','org/re po','org/repo$','org/'+'r'.repeat(101),'org',' org/repo','org/repo\n',undefined,null,7])
    assert.equal(create({...ok,repository}).reasonCode,'repository_create_name_invalid',String(repository));
  for(const ownerType of [undefined,null,'','user','Organization','org'])
    assert.equal(create({...ok,ownerType}).reasonCode,'repository_create_owner_type_invalid',String(ownerType));
  const {ownerType:_,...withoutOwnerType}=ok;
  assert.equal(create(withoutOwnerType).reasonCode,'repository_create_owner_type_invalid');
  for(const description of ['d'.repeat(351),'line\nbreak','tab\there','nul\u0000','del\u007f','c1\u0085',null,5])
    assert.equal(create({...ok,description}).reasonCode,'repository_create_description_invalid',JSON.stringify(description));
  for(const [key,value] of [['isPrivate','false'],['isPrivate',null],['isPrivate',0],['autoInit','true'],['autoInit',null],['autoInit',1]])
    assert.equal(create({...ok,[key]:value}).reasonCode,'repository_create_boolean_invalid',`${key}=${JSON.stringify(value)}`);
  // GitHub-native names would otherwise be ignored silently (private:false would still create a private repository).
  for(const [key,value] of [['private',false],['visibility','public'],['name','new-repo'],['owner','devpro-tw'],['auto_init',true],
    ['body','x'],['branch','main'],['ref','refs/heads/main'],['token','x'],['account','x']])
    assert.equal(create({...ok,[key]:value}).reasonCode,'repository_create_argument_unsupported',key);
});
// github_delete_branch: the Executor collects branch evidence with the requester's token right before
// the delete; the model never supplies it. Contract agreed with the AuthBroker session (2026-11-11).
const tip = 'c'.repeat(40);
const del = (args = {}) => normalizeGithubOperation('github_delete_branch',{repository:'org/repo',branch:'chore/x',expectedHeadSha:tip,...args});
const branchEvidence = () => ({
  repository:{defaultBranch:'main'},
  branch:{name:'chore/x',sha:tip,protected:false},
  production:{ref:'production',exists:true,containsHead:true},
  pulls:{asBase:0,asHead:[]},
  complete:{repository:true,branch:true,production:true,pulls:true},
  confirmation:null,
});
const unshipped = () => { const e=branchEvidence();e.production.containsHead=false;return e; };
const confirmed = e => { e.confirmation={approved:true,repository:'org/repo',branch:e.branch.name,sha:e.branch.sha};return e; };
const decide = (action,evidence) => { const r=evaluateGithubOperation(action,evidence);return [r.allowed,r.reasonCode]; };
test('branch deletion is a typed write that policy status lists',()=>{
  const action=del();
  assert.equal(action.kind,'delete_branch');
  assert.equal(action.ref,'chore/x');
  assert.equal(action.expectedHeadSha,tip);
  assert.equal(normalizeGithubOperation('github_delete_ref',{repository:'org/repo',branch:'chore/x'}).kind,'unsupported');
  assert.ok(evaluateGithubOperation(normalizeGithubOperation('github_policy_status',{})).capabilities.includes('github_delete_branch'));
});
test('a branch whose head production already contains is deleted without confirmation, release branches included',()=>{
  assert.deepEqual(decide(del(),branchEvidence()),[true,'merged_into_production']);
  // USER decision: release/* follows the ordinary rule; the contents-write release/ block does not apply.
  const release='release/20261111-31f96f9-5',e=branchEvidence();e.branch.name=release;
  assert.deepEqual(decide(del({branch:release}),e),[true,'merged_into_production']);
});
test('a branch production does not contain needs the owner\'s one-time confirmation for that exact head',()=>{
  // Merged into main but not shipped (AuthBroker chore/clarify-ssh-stop-latency), squash-merged, or no production branch.
  const required=unshipped();
  const result=evaluateGithubOperation(del(),required);
  assert.deepEqual([result.allowed,result.reasonCode,result.openPrHead],[false,'user_confirmation_required',[]]);
  const noProduction=branchEvidence();noProduction.production={ref:'production',exists:false,containsHead:false};
  assert.deepEqual(decide(del(),noProduction),[false,'user_confirmation_required']);
  assert.deepEqual(decide(del(),confirmed(unshipped())),[true,'user_confirmed']);
  assert.deepEqual(decide(del(),confirmed(noProduction)),[true,'user_confirmed']);
  for(const [key,value] of [['sha','d'.repeat(40)],['branch','chore/y'],['repository','org/other'],['approved',false],['approved','true']]) {
    const e=confirmed(unshipped());e.confirmation[key]=value;
    assert.deepEqual(decide(del(),e),[false,'user_confirmation_required'],key);
  }
  for(const confirmation of ['yes',true,[],{approved:true}]) {
    const e=unshipped();e.confirmation=confirmation;
    assert.deepEqual(decide(del(),e),[false,'user_confirmation_required'],JSON.stringify(confirmation));
  }
});
test('protected, default and GitHub-protected branches are never deleted, even with confirmation',()=>{
  // Fixed names are argument-only, so they are denied without any evidence.
  for(const name of ['main','master','production','integration']) {
    assert.deepEqual(decide(del({branch:name})),[false,'protected_ref'],name);
    const e=confirmed(branchEvidence());e.branch.name=name;
    assert.deepEqual(decide(del({branch:name}),e),[false,'protected_ref'],name);
  }
  const defaultBranch=confirmed(branchEvidence());defaultBranch.repository.defaultBranch='chore/x';
  assert.deepEqual(decide(del(),defaultBranch),[false,'protected_ref']);
  const githubProtected=confirmed(branchEvidence());githubProtected.branch.protected=true;
  assert.deepEqual(decide(del(),githubProtected),[false,'protected_ref']);
});
test('an open PR base is never deleted; an open PR head needs confirmation even when shipped',()=>{
  const base=confirmed(branchEvidence());base.pulls.asBase=1;
  assert.deepEqual(decide(del(),base),[false,'open_pr_base']);
  // Deleting a PR head closes the PR, e.g. a shipped release branch whose back-merge PR to main is still open.
  const head=branchEvidence();head.pulls.asHead=[61];
  const result=evaluateGithubOperation(del(),head);
  assert.deepEqual([result.allowed,result.reasonCode,result.openPrHead],[false,'user_confirmation_required',[61]]);
  assert.deepEqual(decide(del(),confirmed(head)),[true,'user_confirmed']);
});
test('branch deletion arguments are checked before any evidence',()=>{
  for(const repository of [undefined,'org','org/repo/x',' org/repo'])
    assert.deepEqual(decide(del({repository}),branchEvidence()),[false,'repository_required'],String(repository));
  for(const args of [{branch:'refs/heads/chore/x'},{branch:''},{branch:'-x'},{branch:'a..b'},{branch:'a b'},{branch:undefined},
    {expectedHeadSha:'abc'},{expectedHeadSha:undefined},{expectedHeadSha:'g'.repeat(40)}])
    assert.deepEqual(decide(del(args),branchEvidence()),[false,'expected_branch_head_required'],JSON.stringify(args));
  // The backend deletes `branch`; another alias must not choose the branch the policy evaluates.
  assert.deepEqual(decide(del({branch:undefined,ref:'chore/x'}),branchEvidence()),[false,'expected_branch_head_required']);
  assert.deepEqual(decide(del({branch:'main',ref:'chore/x'}),branchEvidence()),[false,'protected_ref']);
});
test('branch evidence must be complete, well typed and describe the requested head',()=>{
  assert.deepEqual(decide(del()),[false,'branch_evidence_incomplete']);
  assert.deepEqual(decide(del(),{}),[false,'branch_evidence_incomplete']);
  for(const key of ['repository','branch','production','pulls']) {
    const e=branchEvidence();e.complete[key]='true';
    assert.deepEqual(decide(del(),e),[false,'branch_evidence_incomplete'],key);
  }
  for(const modify of [
    e=>e.repository=null, e=>e.branch=null, e=>e.production=null, e=>e.pulls=null, e=>e.complete=null,
    e=>e.repository.defaultBranch=undefined, e=>e.repository.defaultBranch='refs/heads/main',
    e=>e.branch.name=5, e=>e.branch.sha='x', e=>e.branch.protected=undefined, e=>e.branch.protected='false',
    e=>e.production.ref='main', e=>e.production.exists='true', e=>e.production.containsHead=undefined,
    e=>{e.production.exists=false;e.production.containsHead=true;},
    e=>e.pulls.asBase=undefined, e=>e.pulls.asBase=-1, e=>e.pulls.asBase=1.5, e=>e.pulls.asBase='0',
    e=>e.pulls.asHead=undefined, e=>e.pulls.asHead=null, e=>e.pulls.asHead=[0], e=>e.pulls.asHead=['61'],
  ]) { const e=branchEvidence();modify(e);assert.deepEqual(decide(del(),e),[false,'branch_evidence_incomplete'],modify.toString()); }
  for(const modify of [e=>e.branch.sha='d'.repeat(40), e=>e.branch.name='chore/y']) {
    const e=confirmed(branchEvidence());modify(e);
    assert.deepEqual(decide(del(),e),[false,'branch_head_changed'],modify.toString());
  }
});
