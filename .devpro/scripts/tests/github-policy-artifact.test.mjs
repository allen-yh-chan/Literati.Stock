import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync,symlinkSync,renameSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildGithubPolicyArtifact } from '../build-github-policy-artifact.mjs';
import { normalizeGithubOperation, evaluateGithubOperation } from '../hooks/lib/github-operation-policy.mjs';
test('artifact builder rejects source files and parent directories that are symbolic links',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'github-artifact-links-'));
  try {
    const source=path.join(directory,'source');
    buildGithubPolicyArtifact({source:path.resolve(import.meta.dirname,'../../..'),out:source,revision:'a'.repeat(40)});
    const entry=path.join(source,'.devpro/scripts/github-policy.mjs');
    const outside=path.join(directory,'outside.mjs');writeFileSync(outside,readFileSync(entry));
    rmSync(entry);symlinkSync(outside,entry);
    assert.throws(()=>buildGithubPolicyArtifact({source,out:path.join(directory,'out'),revision:'a'.repeat(40)}),/link|outside/i);
    rmSync(entry);writeFileSync(entry,readFileSync(outside));
    const linked=path.join(source,'.devpro/scripts/lib');
    const fsParent=path.join(directory,'lib');
    // Move only this disposable fixture's dependency directory.
    renameSync(linked,fsParent);symlinkSync(fsParent,linked,'dir');
    assert.throws(()=>buildGithubPolicyArtifact({source,out:path.join(directory,'parent-out'),revision:'a'.repeat(40)}),/link|outside/i);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

// devpro-hermes-plugins#170: scripts a gate loads only at run time were left out of the
// artifact, so the owner's `gh pr create` failed with "Cannot find module".
test('artifact builder follows literal runtime references and their imports',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'github-artifact-runtime-'));
  try {
    const source=path.join(directory,'source'),write=(file,text)=>{
      const target=path.join(source,file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,text);
    };
    for(const root of ['github-policy','hooks/github-mcp-gate','hooks/run-hook','hooks/github-opencode-plugin',
      'hooks/github-owner-gate','hooks/gh-footer-gate','hooks/post-tool-gate','render-second-review-packet'])
      write(`.devpro/scripts/${root}.mjs`,'export {};\n');
    write('.devpro/scripts/hooks/post-tool-gate.mjs',[
      'import path from "node:path";','import { fileURLToPath } from "node:url";',
      'const loaded = await import("./lib/dynamic.mjs");',
      'const facade = new URL("../facade.mjs", import.meta.url);',
      'const spawned = path.join(\n  path.dirname(fileURLToPath(import.meta.url)),\n  "../spawned.mjs"\n);',
      'const chosen = await import(facade.href);',
      'const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");',
      '// A comment may quote import("./never-written.mjs") without naming a real file.',''].join('\n'));
    write('.devpro/scripts/hooks/lib/dynamic.mjs','export {};\n');
    write('.devpro/scripts/facade.mjs','export {};\n');
    write('.devpro/scripts/spawned.mjs','import "./lib/spawned-dependency.mjs";\n');
    write('.devpro/scripts/lib/spawned-dependency.mjs','export {};\n');
    write('.devpro/scripts/unreferenced.mjs','export {};\n');
    const out=path.join(directory,'out');
    buildGithubPolicyArtifact({source,out,revision:'a'.repeat(40)});
    const files=JSON.parse(readFileSync(path.join(out,'manifest.json'))).files.map(file=>file.path);
    for(const file of ['hooks/lib/dynamic.mjs','facade.mjs','spawned.mjs','lib/spawned-dependency.mjs'])
      assert.ok(files.includes(`.devpro/scripts/${file}`),file);
    assert.ok(!files.some(file=>/never-written|unreferenced/.test(file)),files.join('\n'));
    // A missing static import still stops the build.
    write('.devpro/scripts/facade.mjs','import "./absent.mjs";\n');
    assert.throws(()=>buildGithubPolicyArtifact({source,out:path.join(directory,'out-2'),revision:'a'.repeat(40)}),/ENOENT/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('every relative module literal inside the artifact is packed with it',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'github-artifact-closure-'));
  try {
    const source=path.resolve(import.meta.dirname,'../../..'),out=path.join(directory,'artifact');
    buildGithubPolicyArtifact({source,out,revision:'a'.repeat(40)});
    const files=JSON.parse(readFileSync(path.join(out,'manifest.json'))).files.map(file=>file.path);
    const packed=new Set(files),missing=[];
    // Deliberately wider than the builder's patterns: any quoted ./ or ../ path ending in
    // .mjs, so a new loading style is caught here even before the builder learns it.
    for(const file of files) {
      for(const [,literal] of readFileSync(path.join(out,file),'utf8').matchAll(/["'`](\.{1,2}\/[^"'`\s]+\.mjs)["'`]/g)) {
        const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),literal));
        // A literal that names no source file cannot load in the source either.
        if(existsSync(path.join(source,target))&&!packed.has(target))missing.push(`${file} -> ${target}`);
      }
    }
    assert.deepEqual(missing,[]);
    // The scripts devpro-hermes-plugins#170 found missing load from the artifact alone.
    for(const script of ['pre-pr-body-template-check','recap-body-template-check','recap-title-check']) {
      const run=spawnSync(process.execPath,[path.join(out,`.devpro/scripts/${script}.mjs`)],{cwd:directory,input:'',encoding:'utf8'});
      assert.doesNotMatch(run.stderr,/Cannot find module|ERR_MODULE_NOT_FOUND/,`${script}: ${run.stderr}`);
    }
    // The failing host call itself: the packed gate checks a `gh pr create` body exactly as the source gate does.
    const body=path.join(directory,'body.md');writeFileSync(body,'## Summary\nx\n');
    const payload=JSON.stringify({tool_name:'Bash',tool_input:{command:`gh pr create --base main --title t --body-file ${body}`},cwd:source});
    const [packedGate,sourceGate]=[out,source].map(root=>{
      const hooks=path.join(root,'.devpro/scripts/hooks');
      return spawnSync(process.execPath,[path.join(hooks,'run-hook.mjs'),'PreToolUse',path.join(hooks,'pre-tool-gate.mjs'),'--host=hermes'],
        {cwd:directory,input:payload,encoding:'utf8'});
    });
    assert.doesNotMatch(packedGate.stdout+packedGate.stderr,/Cannot find module|ERR_MODULE_NOT_FOUND/);
    assert.deepEqual([packedGate.status,packedGate.stdout],[sourceGate.status,sourceGate.stdout]);
    for(const module of ['hooks/lib/release-back-merge-state','review-remediation-evidence']) {
      const run=spawnSync(process.execPath,['--input-type=module','-e','await import(process.argv[1]);',
        pathToFileURL(path.join(out,`.devpro/scripts/${module}.mjs`)).href],{cwd:directory,encoding:'utf8'});
      assert.equal(run.status,0,`${module}: ${run.stderr}`);
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('versioned artifact runs the same policy without reading the source checkout',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'github-policy-test-'));
  try {
    const out=path.join(directory,'artifact');
    const built=buildGithubPolicyArtifact({source:path.resolve(import.meta.dirname,'../../..'),out,revision:'a'.repeat(40)});
    const manifestBytes=readFileSync(path.join(out,'manifest.json'));
    assert.equal(createHash('sha256').update(manifestBytes).digest('hex'),built.sha256);
    const manifest=JSON.parse(manifestBytes);
    for(const file of manifest.files)assert.equal(createHash('sha256').update(readFileSync(path.join(out,file.path))).digest('hex'),file.sha256);
    const evaluate=request=>{
      const result=spawnSync(process.execPath,[path.join(out,manifest.entry)],{cwd:directory,input:JSON.stringify({protocol:1,command:'evaluate',...request}),encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
    };
    assert.equal(evaluate({tool:'github_create_issue',arguments:{repository:'org/repo',body:'missing footer'}}).allowed,false);
    assert.equal(evaluate({tool:'github_merge_pr',arguments:{repository:'org/repo',number:1,baseBranch:'main',expectedHeadSha:'b'.repeat(40)},evidence:{allowed:true}}).allowed,false);
    assert.equal(evaluate({tool:'github_read_pr',arguments:{repository:'org/repo',number:1}}).allowed,true);
    // The packed policy lists repository creation and answers it exactly as the source policy does.
    assert.ok(evaluate({tool:'github_policy_status',arguments:{}}).capabilities.includes('github_create_repository'));
    const base={repository:'org/new-repo',ownerType:'organization'};
    for(const [args,allowed,reasonCode] of [
      [base,true,'github_policy_pass'],
      [{...base,ownerType:'personal',description:'x',isPrivate:false,autoInit:true},true,'github_policy_pass'],
      [{...base,private:false},false,'repository_create_argument_unsupported'],
      [{...base,repository:'org/..'},false,'repository_create_name_invalid'],
      [{...base,isPrivate:null},false,'repository_create_boolean_invalid'],
    ]) {
      const packed=evaluate({tool:'github_create_repository',arguments:args});
      const source=evaluateGithubOperation(normalizeGithubOperation('github_create_repository',args));
      assert.deepEqual([packed.allowed,packed.reasonCode],[allowed,reasonCode],JSON.stringify(args));
      assert.deepEqual([source.allowed,source.reasonCode],[allowed,reasonCode],JSON.stringify(args));
    }
    // Branch deletion: the packed policy decides on collected evidence exactly as the source policy does.
    assert.ok(evaluate({tool:'github_policy_status',arguments:{}}).capabilities.includes('github_delete_branch'));
    const tip='c'.repeat(40),args={repository:'org/repo',branch:'chore/x',expectedHeadSha:tip};
    const evidence=over=>({repository:{defaultBranch:'main'},branch:{name:'chore/x',sha:tip,protected:false},
      production:{ref:'production',exists:true,containsHead:true},pulls:{asBase:0,asHead:[]},
      complete:{repository:true,branch:true,production:true,pulls:true},confirmation:null,...over});
    const unshipped={production:{ref:'production',exists:true,containsHead:false}};
    for(const [request,allowed,reasonCode] of [
      [{arguments:args,evidence:evidence()},true,'merged_into_production'],
      [{arguments:args,evidence:evidence(unshipped)},false,'user_confirmation_required'],
      [{arguments:args,evidence:evidence({...unshipped,confirmation:{approved:true,repository:'org/repo',branch:'chore/x',sha:tip}})},true,'user_confirmed'],
      [{arguments:args,evidence:evidence({pulls:{asBase:0,asHead:[61]}})},false,'user_confirmation_required'],
      [{arguments:args,evidence:evidence({pulls:{asBase:1,asHead:[]}})},false,'open_pr_base'],
      [{arguments:{...args,branch:'production'},evidence:evidence()},false,'protected_ref'],
      [{arguments:args},false,'branch_evidence_incomplete'],
    ]) {
      const {protocol,...packed}=evaluate({tool:'github_delete_branch',...request});
      const source=evaluateGithubOperation(normalizeGithubOperation('github_delete_branch',request.arguments),request.evidence);
      assert.equal(protocol,1);
      assert.deepEqual([packed.allowed,packed.reasonCode],[allowed,reasonCode],JSON.stringify(request));
      assert.deepEqual(packed,source,JSON.stringify(request));
    }
    // Bundle upload: the packed policy advertises all four names and decides exactly as the source policy does.
    const listed=evaluate({tool:'github_policy_status',arguments:{}}).capabilities;
    for(const name of ['github_bundle_upload_local','github_push_upload_begin','github_push_upload_chunk','github_push_upload_finish'])
      assert.ok(listed.includes(name),name);
    const workspace={repository:'org/repo',branch:'chore/wire-github-bundle-upload-policy'};
    for(const [tool,args,allowed,reasonCode] of [
      ['github_bundle_upload_local',workspace,true,'github_policy_pass'],
      ['github_push_upload_begin',{...workspace,totalBytes:3147195},true,'github_policy_pass'],
      ['github_bundle_upload_local',{...workspace,branch:'main'},false,'protected_ref'],
      ['github_push_upload_begin',{repository:'org/repo'},false,'protected_ref'],
      ['github_push_upload_chunk',{uploadId:'upload-1',offset:0},false,'upload_continuation_not_model_callable'],
      ['github_push_upload_finish',{uploadId:'upload-1'},false,'upload_continuation_not_model_callable'],
    ]) {
      const {protocol,...packed}=evaluate({tool,arguments:args});
      const source=evaluateGithubOperation(normalizeGithubOperation(tool,args));
      assert.equal(protocol,1);
      assert.deepEqual([packed.allowed,packed.reasonCode],[allowed,reasonCode],`${tool} ${JSON.stringify(args)}`);
      assert.deepEqual(packed,source,`${tool} ${JSON.stringify(args)}`);
    }
    // Imported client dependencies must travel with the artifact too. Invalid input
    // reaches the real client's denial path, not a missing-module process failure.
    const client=spawnSync(process.execPath,[path.join(out,manifest.hookRunner),'PreToolUse',path.join(out,manifest.clientEntry),'--host=codex'],{cwd:directory,input:'invalid',encoding:'utf8'});
    assert.equal(client.status,0,client.stderr);
    assert.equal(JSON.parse(client.stdout).hookSpecificOutput.permissionDecision,'deny');
    const ghConfig=path.join(directory,'gh');mkdirSync(ghConfig);
    const env={...process.env,GH_CONFIG_DIR:ghConfig,PATH:ghConfig}; // no ambient gh/keyring selection
    for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN'])delete env[key];
    const read=spawnSync(process.execPath,[path.join(out,manifest.hookRunner),'PreToolUse',path.join(out,manifest.clientEntry),'--host=codex'],
      {cwd:directory,input:JSON.stringify({tool_name:'mcp__devpro_work__github_repository',tool_input:{repository:'fixture/repo'},cwd:directory}),encoding:'utf8',env});
    assert.equal(read.status,0,read.stderr);
    assert.equal(read.stdout.trim(),'',read.stdout+read.stderr);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
