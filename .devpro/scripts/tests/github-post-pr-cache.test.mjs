import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {saveGithubCheck,readGithubCheck} from '../hooks/lib/github-check-cache.mjs';

test('the authoritative repository observation survives GitHub repository casing differences',()=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'github-cache-case-'));
  try {
    assert.equal(spawnSync('git',['init','-q'],{cwd}).status,0);
    const snapshot={protocol:1,repository:'fixture/project',number:7,pr:{head:{sha:'a'.repeat(40)}},policy:{allowed:false}};
    assert.equal(saveGithubCheck(cwd,snapshot),true);
    assert.equal(readGithubCheck(cwd,'Fixture/Project',7)?.pr.head.sha,'a'.repeat(40));
  }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('post-PR fallback consumes the MCP projection and preserves file completeness',()=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'github-post-pr-cache-'));
  try {
    const cache=pathToFileURL(path.resolve(import.meta.dirname,'../hooks/lib/github-check-cache.mjs')).href;
    const hook=pathToFileURL(path.resolve(import.meta.dirname,'../hooks/post-pr-completion-check.mjs')).href;
    const code=`import {saveGithubCheck} from ${JSON.stringify(cache)};
      import {__testFetchPrSnapshot as fetch} from ${JSON.stringify(hook)};
      const snapshot={protocol:1,repository:'fixture/repo',number:7,pr:{head:{sha:'a'.repeat(40)}},policy:{allowed:true},complete:{files:true},
        ghPr:{number:7,url:'https://github.com/fixture/repo/pull/7',state:'OPEN',headRefName:'feature/example',headRefOid:'a'.repeat(40),baseRefName:'main',comments:[],changedFiles:1,files:[{path:'app.mjs',changeType:'MODIFIED'}]}};
      const options={repository:'github.com/fixture/repo',branch:'feature/example',timeoutMs:0};
      saveGithubCheck(process.cwd(),snapshot);
      const complete=fetch('7',options);
      saveGithubCheck(process.cwd(),{...snapshot,complete:{files:false}});
      const incomplete=fetch('7',options);
      const wrongBranch=fetch('7',{...options,branch:'feature/other'});
      const unscoped=fetch('7',{timeoutMs:0});
      const invalidUrls=['','https://github.com/fixture/other/pull/7','https://github.com/fixture/repo/pull/8'];
      const rejected=invalidUrls.map(url=>{
        saveGithubCheck(process.cwd(),{...snapshot,ghPr:{...snapshot.ghPr,url}});
        return fetch('7',options);
      });
      saveGithubCheck(process.cwd(),snapshot,Date.now()-120001);
      const stale=fetch('7',options);
      console.log(JSON.stringify({complete,incomplete,wrongBranch,unscoped,rejected,stale}));`;
    const env={...process.env,GH_CONFIG_DIR:path.join(cwd,'empty-gh'),PATH:cwd,DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR:path.join(cwd,'control')};
    for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','DEVPRO_TEST_GH_PR_DATA','DEVPRO_TEST_GH_PR_FILE'])delete env[key];
    const run=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd,env,encoding:'utf8',timeout:20000});
    assert.equal(run.status,0,run.stderr);
    const actual=JSON.parse(run.stdout);
    assert.equal(actual.complete.headRefOid,'a'.repeat(40));
    assert.equal(actual.complete.filesAvailable,true);
    assert.deepEqual(actual.complete.files,['app.mjs']);
    assert.equal(actual.incomplete.filesAvailable,false);
    assert.equal(actual.wrongBranch,null);
    assert.equal(actual.unscoped,null);
    assert.deepEqual(actual.rejected,[null,null,null]);
    assert.equal(actual.stale,null);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
