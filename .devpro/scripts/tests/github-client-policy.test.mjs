import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,cpSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {evaluateGithubClientPolicy} from '../hooks/lib/github-client-policy.mjs';
import {writePostPrCompletionMarker} from '../hooks/lib/post-pr-completion-state.mjs';
import * as waiverCases from './lib/pr-waiver-two-path-cases.mjs';

const source=path.resolve(import.meta.dirname,'../../..');
const footer='Rules: v7.8.1 · Tool: Codex · Model: GPT-6';
// identity: 'consumer' (.gitmodules), 'unknown' (no positive evidence) or 'source' (origin + sentinels).
function fixture({local=true,identity='consumer',branch='feature/add-example',file='app.mjs'}={}) {
  const cwd=mkdtempSync(path.join(tmpdir(),'github-client-policy-'));
  const git=(...args)=>{
    const result=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(cwd,'empty-config')}});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  cpSync(path.join(source,'.devpro/scripts'),path.join(cwd,'.devpro/scripts'),{recursive:true,
    filter:file=>!path.relative(path.join(source,'.devpro/scripts'),file).split(path.sep).includes('tests')});
  writeFileSync(path.join(cwd,'AGENTS.md'),'版本：7.8.1\n');
  if(identity==='consumer')writeFileSync(path.join(cwd,'.gitmodules'),'[submodule "rules"]\n path = .devpro-agent-rules\n');
  if(identity==='source'){mkdirSync(path.join(cwd,'.devpro/agent-rules'),{recursive:true});writeFileSync(path.join(cwd,'.devpro/agent-rules/rule-audit-playbook.md'),'source');}
  const repository=identity==='source'?'fixture/devpro-agent-rules':'fixture/repo';
  if(local)writeFileSync(path.join(cwd,'.devpro/pre-pr-checks.local.md'),'Run the project tests.\n');
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  git('remote','add','origin',`https://github.com/${repository}.git`);git('add','.');git('-c','commit.gpgsign=false','commit','-m','Fixture base');
  git('update-ref','refs/remotes/origin/main','HEAD');git('checkout','-b',branch);
  writeFileSync(path.join(cwd,file),'export const value=1;\n');git('add','.');git('-c','commit.gpgsign=false','commit','-m','Fixture change');
  const head=git('rev-parse','HEAD');
  const bodyWith=evidence=>`## Change Context\n- 改什麼：fixture behavior\n- 目的：verify local checks\n\n## Manual Test\n- N/A: command only\n\n## Requirement Ledger Completion\n- N/A: fixture\n\n## Test Evidence\n- 驗收證據：project tests passed\n${evidence}\n## Scenario Walkthrough\n- Status: N/A (non-enforcement-carrier change)\n- Evidence: N/A\n\n## Cost Circuit Breaker Overrides\n- N/A\n\n## Security Review\n- SQL injection：已檢查\n- PII：已檢查\n\n${footer}`;
  const checksLine=`- Consumer pre-PR checks: HEAD ${head}; project tests passed\n`;
  const devLine=status=>`- DEV deploy-verify: HEAD ${head}; ${status}\n`;
  const body=bodyWith((local?checksLine:'')+devLine('N/A: fixture'));
  const create={kind:'create_pr',repository,head:branch,baseBranch:'main',body};
  const merge={kind:'merge',repository,number:7,expectedHeadSha:head,baseBranch:'main'};
  const snapshot={protocol:1,repository,number:7,pr:{head:{sha:head,ref:create.head},body:null},policy:{allowed:true}};
  return {cwd,git,head,create,merge,snapshot,bodyWith,checksLine,devLine,cleanup:()=>rmSync(cwd,{recursive:true,force:true})};
}
// notes/session-pending.md of the fixture, which is its own main checkout (written after the commits).
function writeNotes(cwd,notes) {
  if(notes===null||notes===undefined)return;
  mkdirSync(path.join(cwd,'notes'),{recursive:true});
  if(notes==='unreadable')mkdirSync(path.join(cwd,'notes/session-pending.md'));
  else writeFileSync(path.join(cwd,'notes/session-pending.md'),notes);
}
test('PR creation uses the real checkout, committed consumer checks and body validator',()=>{
  const f=fixture();try {
    const evaluate=action=>evaluateGithubClientPolicy(action,{cwd:f.cwd});
    const initial=evaluate(f.create);
    const lint=spawnSync(process.execPath,[path.join(f.cwd,'.devpro/scripts/pre-pr-body-template-check.mjs'),'--cwd',f.cwd,'--pr-cwd',f.cwd,'--pr-head',f.create.head,'--pr-base','main'],{cwd:f.cwd,input:f.create.body,encoding:'utf8'});
    assert.equal(initial.allowed,true,JSON.stringify(initial)+'\n'+lint.stderr);
    for(const change of [{repository:'other/repo'},{head:'feature/other'},{body:footer},
      {body:f.create.body.replace(/^- Consumer pre-PR checks:.*\n/m,'')},
      {body:f.create.body.replace('## Change Context','## Removed')}])assert.equal(evaluate({...f.create,...change}).allowed,false,JSON.stringify(change));
    const outside=mkdtempSync(path.join(tmpdir(),'github-noncheckout-'));
    try {assert.equal(evaluateGithubClientPolicy(f.create,{cwd:outside}).allowed,false);}finally{rmSync(outside,{recursive:true,force:true});}
    // An adopted checkout without the validator is an incomplete rules sync, not a repository that never adopted (#3557).
    rmSync(path.join(f.cwd,'.devpro/scripts/pre-pr-body-template-check.mjs'));
    const incomplete=evaluate(f.create);
    assert.equal(incomplete.allowed,false);
    assert.match(incomplete.reason,/rules sync is incomplete/);
    assert.match(incomplete.reason,/\.devpro\/scripts\/pre-pr-body-template-check\.mjs/);
    assert.doesNotMatch(incomplete.reason,/update the company rules/);
  }finally{f.cleanup();}
});
// #3557: a repository that never adopted devpro-agent-rules has no company PR body template to validate. MCP create_pr
// checks only the body footer there and leaves the rest to the backend, like the footer version check of #94.
// A project AGENTS.md without a `版本：X.Y.Z` line is not adoption evidence, and neither is a regular file named like a rules directory.
// fix-github-adoption-evidence (AuthBroker #3): a `.devpro/` or `.devpro-agent-rules/` DIRECTORY alone is not adoption either.
for(const [label,agents,plainFile,rulesDir] of [
  ['without AGENTS.md',null,null,null],
  ['whose AGENTS.md has no version line','# Project agent notes\n\nUse the product build.\n',null,null],
  ['with a regular file named .devpro',null,'.devpro',null],
  ['with a regular file named .devpro-agent-rules',null,'.devpro-agent-rules',null],
  ['with only a .devpro directory',null,null,'.devpro'],
  ['with only a .devpro-agent-rules directory',null,null,'.devpro-agent-rules'],
  ['with a .devpro directory and an AGENTS.md without a version line','# Project agent notes\n',null,'.devpro'],
])
test(`MCP create_pr in a repository that never adopted the rules (${label}) checks only the body footer`,()=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'github-client-policy-unadopted-'));
  try {
    const git=(...args)=>{
      const result=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(cwd,'empty-config')}});
      assert.equal(result.status,0,result.stderr);
    };
    writeFileSync(path.join(cwd,'README.md'),'Product repository without company rules.\n');
    if(agents!==null)writeFileSync(path.join(cwd,'AGENTS.md'),agents);
    if(plainFile!==null)writeFileSync(path.join(cwd,plainFile),'not a rules directory\n');
    if(rulesDir!==null){mkdirSync(path.join(cwd,rulesDir),{recursive:true});writeFileSync(path.join(cwd,rulesDir,'README.md'),'not company rules\n');}
    git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    git('remote','add','origin','https://github.com/fixture/product.git');git('add','.');git('-c','commit.gpgsign=false','commit','-qm','Fixture base');
    git('update-ref','refs/remotes/origin/main','HEAD');git('checkout','-q','-b','feature/add-example');
    const create={kind:'create_pr',repository:'fixture/product',head:'feature/add-example',baseBranch:'main',body:`Adds the example.\n\n${footer}`};
    const evaluate=(change={})=>evaluateGithubClientPolicy({...create,...change},{cwd});
    const allowed=evaluate();
    assert.equal(allowed.allowed,true,allowed.reason);
    const unsigned=evaluate({body:'Adds the example without a footer.'});
    assert.equal(unsigned.allowed,false);
    assert.match(unsigned.reason,/no trailing provenance footer/);
    assert.equal(evaluate({body:undefined}).allowed,false,'a missing body has no footer');
    assert.match(evaluate({head:'feature/other'}).reason,/exact PR head/);
    assert.match(evaluate({repository:'other/repo'}).reason,/local checkout for this repository/);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('merge requires exact head/branch/snapshot and respects existing local obligations',()=>{
  const f=fixture();try {
    const evaluate=(action=f.merge,snapshot=f.snapshot)=>evaluateGithubClientPolicy(action,{cwd:f.cwd,snapshot});
    assert.equal(evaluate().allowed,true);
    assert.equal(evaluate({...f.merge,expectedHeadSha:'b'.repeat(40)}).allowed,false);
    assert.equal(evaluate(f.merge,{...f.snapshot,repository:'other/repo'}).allowed,false);
    assert.equal(evaluate(f.merge,{...f.snapshot,pr:{head:{sha:f.head,ref:'feature/other'}}}).allowed,false);
    assert.equal(evaluate(f.merge,null).allowed,false);
    const control=path.join(f.cwd,'control');const dispatch='dispatch-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const previous=process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
    try {
      process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR=control;
      const directory=path.join(control,dispatch);mkdirSync(directory,{recursive:true});
      writeFileSync(path.join(directory,'operator-disposition.json'),'invalid');
      assert.match(evaluate(f.merge,{...f.snapshot,policy:{allowed:true,sticky:{dispatch_id:dispatch,last_reviewed_sha:f.head}}}).reason,/operator disposition/);
    }finally{
      if(previous===undefined)delete process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
      else process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR=previous;
    }
    const marker=writePostPrCompletionMarker({cwd:f.cwd,prNumber:'7',branch:f.create.head});
    writeFileSync(marker,'invalid');
    assert.match(evaluate().reason,/unreadable|不可判讀/);
    rmSync(marker);
    // A checkout without .gitmodules is no longer assumed to be the rules source: no source-only receipt is asked.
    rmSync(path.join(f.cwd,'.gitmodules'));
    assert.doesNotMatch(evaluate().reason??'',/Local-Test/);
  }finally{f.cleanup();}
  // Source-only local test receipts apply to a positive source checkout.
  const s=fixture({identity:'source'});try {
    assert.match(evaluateGithubClientPolicy(s.merge,{cwd:s.cwd,snapshot:s.snapshot}).reason,/Local-Test/);
  }finally{s.cleanup();}
});
// fix-post-pr-state-repo-keys: the MCP merge checks local obligations for the action's repository. Through the company
// git proxy the checkout's origin names no github.com repository, so only action.repository tells this repository's
// marker from another repository's marker of the same PR number.
test("MCP merge holds a PR only by its own repository's obligation, read through action.repository",()=>{
  const f=fixture();try {
    f.git('remote','set-url','origin','https://demo.devpro.com.tw:8443/fixture/repo');
    const evaluate=()=>evaluateGithubClientPolicy(f.merge,{cwd:f.cwd,snapshot:f.snapshot});
    const marker=writePostPrCompletionMarker({cwd:f.cwd,prNumber:'7',branch:f.create.head});
    const write=slug=>{
      const obligation={schema:'devpro-post-pr-clear-obligation/v1',obligation_id:'obligation-mcp-7',repository_slug:slug,pr_number:'7',
        obligation_head_ref_oid:f.head,current_dispatch_id:'dispatch-11111111-1111-4111-8111-111111111111',
        old_dispatch_id:'dispatch-22222222-2222-4222-8222-222222222222',first_dispatch_id:'dispatch-11111111-1111-4111-8111-111111111111',
        approval_receipt_ids:['1'],attempt_history:[],created_at:new Date().toISOString()};
      writeFileSync(marker,JSON.stringify({...JSON.parse(readFileSync(marker,'utf8')),url:`https://github.com/${slug}/pull/7`,
        repository_slug:slug,head_ref_oid:f.head,expected_dispatch_id:obligation.current_dispatch_id,lineage_clear_obligation:obligation}));
    };
    write('fixture/repo-b');
    assert.equal(evaluate().allowed,true,`another repository's obligation: ${JSON.stringify(evaluate())}`);
    write('fixture/repo');
    assert.match(evaluate().reason??'',/obligation-mcp-7/);
  }finally{f.cleanup();}
});
// fix-git-proxy-origin-policy: a checkout cloned through the company git proxy has an origin on another host. The local
// gate compares only owner/repo, whatever the host: it guards against an accidental write to another repository.
test('MCP create_pr and merge compare the origin owner/repo on any host, and refuse another or unreadable owner/repo',()=>{
  const f=fixture();try {
    const evaluate=action=>evaluateGithubClientPolicy(action,{cwd:f.cwd,snapshot:f.snapshot});
    const same=['https://demo.devpro.com.tw:8443/fixture/repo','https://demo.devpro.com.tw:8443/fixture/repo.git',
      'https://demo.devpro.com.tw:8443/Fixture/Repo','https://ghe.example.com/fixture/repo','ssh://git@github.com/fixture/repo.git',
      'git@github.com:fixture/repo.git','https://github.com/fixture/repo.git'];
    for(const url of same){
      f.git('remote','set-url','origin',url);
      for(const action of [f.create,f.merge])assert.equal(evaluate(action).allowed,true,`${action.kind} ${url} ${JSON.stringify(evaluate(action))}`);
    }
    for(const url of ['https://demo.devpro.com.tw:8443/fixture/other','https://demo.devpro.com.tw:8443/other/repo','/srv/git/fixture/repo.git']){
      f.git('remote','set-url','origin',url);
      for(const action of [f.create,f.merge])assert.match(evaluate(action).reason,/Use the local checkout for this repository/,`${action.kind} ${url}`);
    }
    f.git('remote','remove','origin');
    for(const action of [f.create,f.merge])assert.match(evaluate(action).reason,/Use the local checkout for this repository/,`${action.kind} no origin`);
  }finally{f.cleanup();}
});
test('commit footer version checks retain native missing-footer advisory behavior',()=>{
  const f=fixture();try {
    assert.equal(evaluateGithubClientPolicy({kind:'contents',message:'Example'},{cwd:f.cwd}).allowed,true);
    assert.equal(evaluateGithubClientPolicy({kind:'contents',message:footer},{cwd:f.cwd}).allowed,true);
    assert.equal(evaluateGithubClientPolicy({kind:'contents',message:footer.replace('v7.8.1','v0.0.0')},{cwd:f.cwd}).allowed,false);
  }finally{f.cleanup();}
});
// devpro-tw/devpro-hermes-plugins#94: the version comes from the trailing footer line only, and each refusal says why.
test('footer version is read from the trailing footer line and each refusal names its cause',()=>{
  const f=fixture();try {
    const evaluate=action=>evaluateGithubClientPolicy(action,{cwd:f.cwd});
    const quoted=`Quoted example: Rules: v0.0.1 · Tool: A · Model: B\n\n${footer}`;
    assert.equal(evaluate({kind:'contents',message:quoted}).allowed,true,'commit message quoting another footer');
    assert.equal(evaluate({kind:'body',body:quoted}).allowed,true,'body quoting another footer');
    for(const action of [{kind:'contents',message:footer.replace('v7.8.1','v7.8.0')},{kind:'body',body:footer.replace('v7.8.1','v7.8.0')}]) {
      const wrong=evaluate(action);
      assert.equal(wrong.allowed,false,JSON.stringify(action));
      assert.match(wrong.reason,/declares Rules: v7\.8\.0.*AGENTS\.md.*7\.8\.1/,JSON.stringify(action));
    }
    const unsigned=evaluate({kind:'body',body:'Description without a provenance footer'});
    assert.equal(unsigned.allowed,false);
    assert.match(unsigned.reason,/no trailing provenance footer/);
  }finally{f.cleanup();}
});
// devpro-tw/devpro-hermes-plugins#94: like the native gh footer gate, a checkout whose AGENTS.md version cannot be read
// (neither at the origin tip nor in the workspace) has no version to compare, so a footer is not a reason to refuse.
// That covers a missing AGENTS.md and a project AGENTS.md without one `版本：X.Y.Z` line.
for(const [label,agents] of [['without AGENTS.md',null],['whose AGENTS.md has no version line','# Project agent notes\n\nUse the product build.\n']])
test(`a checkout ${label} accepts any footer version but still requires the body footer`,()=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'github-client-policy-no-agents-'));
  try {
    const git=(...args)=>{
      const result=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(cwd,'empty-config')}});
      assert.equal(result.status,0,result.stderr);
    };
    writeFileSync(path.join(cwd,'README.md'),'Product repository without company rules.\n');
    if(agents!==null)writeFileSync(path.join(cwd,'AGENTS.md'),agents);
    git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    git('remote','add','origin','https://github.com/fixture/product.git');git('add','.');git('-c','commit.gpgsign=false','commit','-qm','Fixture base');
    git('update-ref','refs/remotes/origin/main','HEAD');
    const evaluate=action=>evaluateGithubClientPolicy({repository:'fixture/product',...action},{cwd});
    for(const version of ['7.8.1','0.0.1']) {
      const signed=footer.replace('v7.8.1',`v${version}`);
      for(const action of [{kind:'contents',message:`Add example\n\n${signed}`},{kind:'body',body:`Issue text\n\n${signed}`},
        {kind:'issue_update',number:7,body:`Issue text\n\n${signed}`}]) {
        const result=evaluate(action);
        assert.equal(result.allowed,true,`${JSON.stringify(action)} ${result.reason}`);
      }
    }
    assert.equal(evaluate({kind:'contents',message:'Add example'}).allowed,true,'missing commit footer stays advisory');
    const unsigned=evaluate({kind:'body',body:'Issue text without a footer'});
    assert.equal(unsigned.allowed,false);
    assert.match(unsigned.reason,/no trailing provenance footer/);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});

// [Scenario: openspec-flow :: PR create gate requires a DEV deploy-verify line for consumer PRs]
// [Scenario: openspec-flow :: Source repository and rigor off are out of scope]
// [Scenario: openspec-flow :: A documentation-only change records N/A with a reason]
const levelEnv=level=>({...process.env,DEVPRO_AGENT_RULES_LEVEL:level});
for(const {identity,local} of [{identity:'consumer',local:false},{identity:'unknown',local:false},{identity:'unknown',local:true},{identity:'consumer',local:true}]) {
  test(`MCP create_pr requires one DEV deploy-verify line (${identity}, ${local?'with':'without'} local checks file)`,()=>{
    const f=fixture({local,identity});try {
      const evaluate=body=>evaluateGithubClientPolicy({...f.create,body},{cwd:f.cwd,env:levelEnv('lite')});
      const checks=local?f.checksLine:'';
      const dev=status=>f.bodyWith(checks+f.devLine(status));
      for(const status of ['N/A: docs only','pending: x','deployed PR head to DEV; login path passed']) {
        const r=evaluate(dev(status));assert.equal(r.allowed,true,`${status}: ${JSON.stringify(r)}`);
      }
      for(const [name,body] of [['missing line',f.bodyWith(checks)],['two lines',f.bodyWith(checks+f.devLine('N/A: a')+f.devLine('N/A: b'))],
        ['empty N/A shell',dev('N/A:')],['empty pending shell',dev('pending:')],['placeholder',dev('<result summary>')],['not verified',dev('not verified')]]) {
        const r=evaluate(body);
        assert.equal(r.allowed,false,name);
        assert.match(r.reason,/^DEV deploy-verify gate: /,name);
        assert.match(r.reason,/Read pre-pr-dev-verification\.md\./,name);
      }
      assert.match(evaluate(dev('not verified')).reason,/write pending:/);
      assert.match(evaluate(f.bodyWith(checks)).reason,/DEV deploy-verify: HEAD <full-sha>/);
      assert.equal(evaluateGithubClientPolicy({...f.create,body:undefined},{cwd:f.cwd,env:levelEnv('lite')}).allowed,false);
      if(local)assert.match(evaluate(f.bodyWith(f.devLine('N/A: docs only'))).reason,/require one non-placeholder line/);
    }finally{f.cleanup();}
  });
}
// [Scenario: openspec-flow :: A matching answer-time record lets the waiver pass]
for(const {identity,local} of [{identity:'consumer',local:false},{identity:'unknown',local:false},{identity:'unknown',local:true},{identity:'consumer',local:true}]) {
  test(`MCP create_pr lets 'skipped per user decision: y' pass with a matching waived record (${identity}, ${local?'with':'without'} local checks file)`,()=>{
    const f=fixture({local,identity,branch:'feature/add-example'});try {
      writeNotes(f.cwd,waiverCases.notesOf(waiverCases.entry({claims:['add-example'],prBranch:['feature/add-example'],records:[waiverCases.devRecord('y')]})));
      const body=f.bodyWith((local?f.checksLine:'')+f.devLine('skipped per user decision: y'));
      const r=evaluateGithubClientPolicy({...f.create,body},{cwd:f.cwd,env:levelEnv('lite')});
      assert.equal(r.allowed,true,JSON.stringify(r));
    }finally{f.cleanup();}
  });
}
// [Scenario: openspec-flow :: A waiver without a matching answer-time record blocks PR creation]
for(const {identity,local} of [{identity:'consumer',local:false},{identity:'unknown',local:false},{identity:'unknown',local:true},{identity:'consumer',local:true}]) {
  test(`MCP create_pr blocks 'skipped per user decision: y' without a record (${identity}, ${local?'with':'without'} local checks file)`,()=>{
    const f=fixture({local,identity,branch:'feature/add-example'});try {
      const body=f.bodyWith((local?f.checksLine:'')+f.devLine('skipped per user decision: y'));
      const r=evaluateGithubClientPolicy({...f.create,body},{cwd:f.cwd,env:levelEnv('lite')});
      assert.equal(r.allowed,false,'no record');
      assert.match(r.reason,/^DEV deploy-verify gate: /);
      assert.match(r.reason,/add-example \(branch feature\/add-example\)/);
      assert.match(r.reason,/notes\/session-pending\.md/);
      assert.match(r.reason,/ask the user/);
    }finally{f.cleanup();}
  });
}
// ---- Per-PR waiver comparison: the shared case table through MCP create_pr ----
function waiverBodyFor(f,c) {
  const consumer=c.consumer?`- Consumer pre-PR checks: HEAD ${f.head}; ${c.consumer}\n`:(c.checksFile?f.checksLine:'');
  return f.bodyWith(consumer+f.devLine(c.dev));
}
// [Scenario: openspec-flow :: A waiver without a matching answer-time record blocks PR creation]
// [Scenario: openspec-flow :: A matching answer-time record lets the waiver pass]
// [Scenario: openspec-flow :: A record of another reason, kind, or change does not match]
// [Scenario: openspec-flow :: Records that cannot be located, read, or told apart block only waiver lines]
// [Scenario: openspec-flow :: Each Consumer release needs its own record]
// [Scenario: openspec-flow :: A record entry that also claims another change or is bound to another branch does not match]
for(const c of waiverCases.CASES) {
  test(`[Scenario: openspec-flow :: ${c.scenario}] ${c.id} (MCP create_pr)`,()=>{
    const f=fixture({local:Boolean(c.checksFile),identity:'unknown',branch:c.branch??waiverCases.BRANCH});try {
      writeNotes(f.cwd,c.notes);
      const r=evaluateGithubClientPolicy({...f.create,body:waiverBodyFor(f,c)},{cwd:f.cwd,env:levelEnv('lite')});
      if(!c.expect.block) {assert.equal(r.allowed,true,`${c.id}: ${JSON.stringify(r)}`);return;}
      assert.equal(r.allowed,false,c.id);
      assert.ok(r.reason.startsWith(`${c.expect.gate}: `),`${c.id}: ${r.reason}`);
      for(const needle of c.expect.includes)assert.ok(r.reason.includes(needle),`${c.id}: missing ${needle}\n${r.reason}`);
      for(const needle of c.expect.excludes)assert.ok(!r.reason.includes(needle),`${c.id}: must not contain ${needle}\n${r.reason}`);
    }finally{f.cleanup();}
  });
}
// [Scenario: openspec-flow :: Source repository and rigor off do not compare waiver records]
test('MCP create_pr does not compare waiver lines for a positive source repository or at rigor off, with no record',()=>{
  const waived=f=>f.bodyWith(f.devLine('skipped per user decision: y'));
  const source=fixture({local:false,identity:'source'});
  try {
    for(const level of ['lite','full'])assert.equal(evaluateGithubClientPolicy({...source.create,body:waived(source)},{cwd:source.cwd,env:levelEnv(level)}).allowed,true,`source ${level}`);
  }finally{source.cleanup();}
  for(const identity of ['consumer','unknown']) {
    const f=fixture({local:false,identity});
    try {
      assert.equal(evaluateGithubClientPolicy({...f.create,body:waived(f)},{cwd:f.cwd,env:levelEnv('off')}).allowed,true,`${identity} off`);
      assert.equal(evaluateGithubClientPolicy({...f.create,body:waived(f)},{cwd:f.cwd,env:levelEnv('full')}).allowed,false,`${identity} full without a record`);
    }finally{f.cleanup();}
  }
});
test('MCP create_pr skips the DEV line for a positive source repository and for rigor off',()=>{
  const source=fixture({local:false,identity:'source'});
  try {
    const noDev=source.bodyWith('');
    assert.equal(evaluateGithubClientPolicy({...source.create,body:noDev},{cwd:source.cwd,env:levelEnv('full')}).allowed,true);
  }finally{source.cleanup();}
  for(const identity of ['consumer','unknown']) {
    const f=fixture({local:false,identity});
    try {
      const noDev=f.bodyWith('');
      assert.equal(evaluateGithubClientPolicy({...f.create,body:noDev},{cwd:f.cwd,env:levelEnv('off')}).allowed,true,`${identity} off`);
      assert.equal(evaluateGithubClientPolicy({...f.create,body:noDev},{cwd:f.cwd,env:levelEnv('full')}).allowed,false,`${identity} full`);
      // An invalid level fails closed to full instead of silently disabling the check.
      assert.equal(evaluateGithubClientPolicy({...f.create,body:noDev},{cwd:f.cwd,env:levelEnv('bogus')}).allowed,false,`${identity} invalid level`);
    }finally{f.cleanup();}
  }
});
test('MCP create_pr keeps the existing Consumer pre-PR checks line check when the file is tracked, even at rigor off',()=>{
  const f=fixture({local:true,identity:'consumer'});
  try {
    const body=f.bodyWith(f.devLine('N/A: docs only'));
    assert.equal(evaluateGithubClientPolicy({...f.create,body},{cwd:f.cwd,env:levelEnv('off')}).allowed,false);
  }finally{f.cleanup();}
});

// ---- r2: the same decision function at MCP merge ----
// The merge client policy reads the description and the head/base repositories from the saved github_check_pr
// snapshot (`pr.body`, `pr.head.ref`, `pr.head.repo`, `pr.base.repo`); the edit policy compares the new body.
function prSnapshot(f,{ref=f.create.head,body=null,head='same'}={}) {
  const repo=f.create.repository;
  const headRepo=head==='null'?null:{full_name:head==='other'?'fork/repo':repo};
  return {...f.snapshot,pr:{head:{sha:f.head,ref,repo:headRepo},base:{repo:{full_name:repo}},body}};
}
const editAction=(f,body,number=7)=>({kind:'issue_update',repository:f.create.repository,number,body});
const mergeOf=(f,snapshot,env='lite')=>evaluateGithubClientPolicy(f.merge,{cwd:f.cwd,snapshot,env:levelEnv(env)});
const editOf=(f,body,snapshot,env='lite')=>evaluateGithubClientPolicy(editAction(f,body),{cwd:f.cwd,snapshot,env:levelEnv(env)});
const WAIVE_X='skipped per user decision: X';
const matchingNotes=()=>waiverCases.notesOf(waiverCases.entry({claims:['add-example'],prBranch:['feature/add-example'],records:[waiverCases.devRecord('X')]}));
function assertReasonFacts(c,r,label) {
  assert.equal(r.allowed,false,label);
  assert.ok(r.reason.startsWith(`${c.expect.gate}: `),`${label}: ${r.reason}`);
  for(const needle of c.expect.includes)assert.ok(r.reason.includes(needle),`${label}: missing ${needle}\n${r.reason}`);
  for(const needle of c.expect.excludes)assert.ok(!r.reason.includes(needle),`${label}: must not contain ${needle}\n${r.reason}`);
}
// [Scenario: openspec-flow :: A waiver added after the PR was opened blocks the merge without a record]
// [Scenario: openspec-flow :: A matching record lets the merge pass from a checkout on another branch]
// [Scenario: openspec-flow :: A description without a waiver part passes the merge without reading records]
// [Scenario: openspec-flow :: Records that are missing or bound elsewhere block the merge as at PR creation]
// [Scenario: openspec-flow :: A waiver on a PR whose head is in another repository blocks the merge]
for(const c of waiverCases.MERGE_CASES) {
  test(`[Scenario: openspec-flow :: ${c.scenario}] ${c.id} (MCP merge)`,()=>{
    const f=fixture({local:false,identity:'consumer',branch:c.head});try {
      writeNotes(f.cwd,c.notes);
      const r=mergeOf(f,prSnapshot(f,{ref:c.head,body:waiverBodyFor(f,c),head:c.cross?'other':'same'}));
      if(!c.expect.block) {assert.equal(r.allowed,true,`${c.id}: ${JSON.stringify(r)}`);return;}
      assertReasonFacts(c,r,c.id);
      assert.ok(r.reason.includes('Merge-time check of PR #7'),r.reason);
      assert.ok(r.reason.includes('edit the description with the GitHub web page (MCP update_issue cannot edit a PR), then run github_check_pr again'),r.reason);
    }finally{f.cleanup();}
  });
}
// [Scenario: openspec-flow :: An unreadable description or a missing head branch blocks the merge]
test('MCP merge: a snapshot without a body field or with a body of the wrong type asks for github_check_pr again; null passes',()=>{
  const f=fixture({local:false,identity:'consumer'});try {
    const snapshot=prSnapshot(f);
    const {body:_omitted,...prWithoutBody}=snapshot.pr;
    for(const [label,pr] of [['no body field',prWithoutBody],['body is a number',{...snapshot.pr,body:123}],['body is an object',{...snapshot.pr,body:{}}]]) {
      const r=mergeOf(f,{...snapshot,pr});
      assert.equal(r.allowed,false,label);
      assert.match(r.reason,/Run github_check_pr for this exact PR\/head again/,label);
      assert.match(r.reason,/description/,label);
    }
    assert.equal(mergeOf(f,{...snapshot,pr:{...snapshot.pr,body:null}}).allowed,true,'a null description passes');
    assert.equal(mergeOf(f,{...snapshot,pr:{...snapshot.pr,body:''}}).allowed,true,'an empty description passes');
  }finally{f.cleanup();}
});
// [Scenario: openspec-flow :: A waiver on a PR whose head is in another repository blocks the merge]
test('MCP merge: head repo null or another full_name blocks a waiver; a missing head or base repository asks to re-run; case differences are the same repository',()=>{
  const f=fixture({local:false,identity:'consumer'});try {
    writeNotes(f.cwd,matchingNotes());
    const body=f.bodyWith(f.devLine(WAIVE_X));
    for(const [label,head] of [['pr.head.repo null','null'],['another full_name','other']]) {
      const r=mergeOf(f,prSnapshot(f,{body,head}));
      assert.equal(r.allowed,false,label);
      assert.match(r.reason,/^DEV deploy-verify gate: /,label);
      assert.ok(r.reason.includes('the PR head branch is in another repository'),`${label}: ${r.reason}`);
      assert.ok(r.reason.includes('replace the waiver with the actual status')&&!r.reason.includes('ask the user'),label);
    }
    const base=prSnapshot(f,{body});
    const {repo:_head,...headWithoutRepo}=base.pr.head;
    const missing=[['no pr.head.repo key',{...base.pr,head:headWithoutRepo}],['head repo without full_name',{...base.pr,head:{...base.pr.head,repo:{}}}],
      ['no pr.base.repo',{...base.pr,base:{}}],['base full_name not a string',{...base.pr,base:{repo:{full_name:7}}}]];
    for(const [label,pr] of missing) {
      const r=mergeOf(f,{...base,pr});
      assert.equal(r.allowed,false,label);
      assert.match(r.reason,/Run github_check_pr for this exact PR\/head again/,label);
      assert.match(r.reason,/repository/,label);
    }
    // Missing repositories only matter when the description has a waiver part.
    const clean=prSnapshot(f,{body:f.bodyWith(f.devLine('N/A: docs only'))});
    const {repo:_r,...cleanHead}=clean.pr.head;
    assert.equal(mergeOf(f,{...clean,pr:{...clean.pr,head:cleanHead,base:{}}}).allowed,true);
    const upper={...base,pr:{...base.pr,head:{...base.pr.head,repo:{full_name:f.create.repository.toUpperCase()}}}};
    {const r=mergeOf(f,upper);assert.equal(r.allowed,true,'owner/repo differing only in case is the same repository: '+r.reason);}
  }finally{f.cleanup();}
});
// [Scenario: openspec-flow :: Source repository and rigor off do not compare at merge]
test('MCP merge does not compare for a positive source repository or at rigor off, with no record and no body field',()=>{
  const source=fixture({local:false,identity:'source',file:'README.md'});
  try {
    const {body:_b,...pr}=prSnapshot(source,{body:source.bodyWith(source.devLine(WAIVE_X))}).pr;
    for(const level of ['lite','full'])assert.equal(mergeOf(source,{...source.snapshot,pr},level).allowed,true,`source ${level}`);
  }finally{source.cleanup();}
  for(const identity of ['consumer','unknown']) {
    const f=fixture({local:false,identity,file:'README.md'});
    try {
      const snapshot=prSnapshot(f,{body:f.bodyWith(f.devLine(WAIVE_X))});
      assert.equal(mergeOf(f,snapshot,'off').allowed,true,`${identity} off`);
      assert.equal(mergeOf(f,snapshot,'lite').allowed,false,`${identity} lite without a record`);
      const {body:_b,...pr}=snapshot.pr;
      assert.equal(mergeOf(f,{...snapshot,pr},'off').allowed,true,`${identity} off without a body field`);
    }finally{f.cleanup();}
  }
});
// The source exemption covers the source's own PR only: an MCP merge of another repository from a source checkout is
// refused before any description is compared, waiver or not (PR #3703 r7 W7-F2).
test('MCP merge from a positive source checkout of another repository is refused, so the source exemption never covers it',()=>{
  const source=fixture({local:false,identity:'source',file:'README.md'});
  try {
    const snapshot=prSnapshot(source,{body:source.bodyWith(source.devLine(WAIVE_X))});
    assert.equal(mergeOf(source,snapshot,'lite').allowed,true,'own PR with a waiver and no record is exempt');
    const other='fixture/other-repo';
    const r=evaluateGithubClientPolicy({...source.merge,repository:other},{cwd:source.cwd,snapshot:{...snapshot,repository:other},env:levelEnv('lite')});
    assert.equal(r.allowed,false);
    assert.match(r.reason,/Use the local checkout for this repository/);
    // A clean PR of that repository is refused the same way: the refusal is about the repository, not the waiver
    // (PR #3703 r8 W3-F2).
    const clean=prSnapshot(source);
    assert.equal(mergeOf(source,clean,'lite').allowed,true,'own clean PR');
    const cleanElsewhere=evaluateGithubClientPolicy({...source.merge,repository:other},{cwd:source.cwd,snapshot:{...clean,repository:other},env:levelEnv('lite')});
    assert.equal(cleanElsewhere.allowed,false);
    assert.match(cleanElsewhere.reason,/Use the local checkout for this repository/);
  }finally{source.cleanup();}
});
// ---- MCP update_issue: not compared (#3496). The MCP backend refuses update_issue for a number that is a PR
// (pull_request_not_issue), so a body shaped like a PR waiver belongs to a regular issue, which has no github_check_pr. ----
// [Scenario: openspec-flow :: MCP update_issue is not compared, so an issue description shaped like a PR waiver can be edited]
test('MCP update_issue with a waiver-shaped body is allowed without a saved check or a matching record, at lite and full; the footer check still applies',()=>{
  for(const identity of ['consumer','unknown']) {
    const f=fixture({local:false,identity});try {
      writeNotes(f.cwd,waiverCases.notesOf(waiverCases.entry({records:[waiverCases.devRecord('ANOTHER-REASON-ZQ')]})));
      const waived=f.bodyWith(f.devLine(WAIVE_X));
      for(const level of ['lite','full']) {
        for(const [label,snapshot] of [['no saved check',null],['a saved check of that number',prSnapshot(f)]]) {
          assert.equal(editOf(f,waived,snapshot,level).allowed,true,`${identity} ${level} ${label}`);
        }
        const elsewhere=evaluateGithubClientPolicy({...editAction(f,waived),repository:'other/repo'},{cwd:f.cwd,env:levelEnv(level)});
        assert.equal(elsewhere.allowed,true,`${identity} ${level} another repository`);
      }
      const unsigned=editOf(f,'Description without a provenance footer',null);
      assert.equal(unsigned.allowed,false);
      assert.match(unsigned.reason,/no trailing provenance footer/);
    }finally{f.cleanup();}
  }
});
// #3529: a rules-lane sync head (rules/<whitelisted-source>-v<X.Y.Z>) needs neither the DEV line nor
// Requirement Ledger Completion; any other head still needs both.
// [Scenario: openspec-flow :: A rules-lane sync pull request needs neither the DEV line nor the Requirement Ledger section]
test('MCP create_pr: a rules-lane sync head needs neither the DEV line nor Requirement Ledger Completion',()=>{
  const withoutLedger=body=>body.replace('## Requirement Ledger Completion\n- N/A: fixture\n\n','');
  for(const [branch,dev,expected] of [
    ['rules/agent-rules-v7.11.0','',/^$/],
    ['chore/sync-rules','',/^DEV deploy-verify gate: /],
    ['rules/other-source-v7.11.0','',/^DEV deploy-verify gate: /],
    ['chore/sync-rules','N/A: rules sync',/PR body validation failed/],
  ]){
    const f=fixture({local:false,branch});try {
      mkdirSync(path.join(f.cwd,'.devpro/agent-rules'),{recursive:true});
      writeFileSync(path.join(f.cwd,'.devpro/agent-rules/preflight-checklist.md'),readFileSync(path.join(source,'.devpro/agent-rules/preflight-checklist.md'),'utf8'));
      const r=evaluateGithubClientPolicy({...f.create,body:withoutLedger(f.bodyWith(dev?f.devLine(dev):''))},{cwd:f.cwd});
      assert.equal(r.allowed,expected.source==='^$',`${branch} dev=${dev} ${JSON.stringify(r)}`);
      if(!r.allowed)assert.match(r.reason,expected,branch);
    }finally{f.cleanup();}
  }
});
