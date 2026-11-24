import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReviewTransportSession } from '../lib/second-review-github-transport.mjs';
import { assertPrivateReviewerPath, REVIEWER_ACL_SCRIPT } from '../lib/reviewer-private-path.mjs';
const hook=fileURLToPath(new URL('../hooks/github-mcp-gate.mjs',import.meta.url));

test('actual PostToolUse stages only the returned short-lived ticket without echoing its secret',()=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'review-ticket-post-'));
  try {
    assert.equal(spawnSync('git',['init','-q'],{cwd}).status,0);
    const ticket='c'.repeat(64);
    const envelope={protocol:1,endpoint:'https://executor.example/reviewer-transport',ticket,
      expiresAt:new Date(Date.now()+60_000).toISOString(),repository:'org/repo',number:7,expectedHeadSha:'a'.repeat(40),scope:'read',dispatchId:null};
    const result=spawnSync(process.execPath,[hook],{cwd,encoding:'utf8',env:{...process.env,DEVPRO_HOOK_EVENT:'PostToolUse'},
      input:JSON.stringify({cwd,session_id:'native-test',tool_name:'mcp__devpro_work__github_reviewer_ticket',tool_response:{content:[{type:'text',text:JSON.stringify(envelope)}]}})});
    assert.equal(result.status,0);assert.ok(!result.stdout.includes(ticket));
    const directory=path.join(cwd,'notes/tmp/state/github-reviewer-transport');
    assert.ok(existsSync(directory),'successful native MCP response must stage a private reviewer capability');
    const files=readdirSync(directory).filter(name=>name.endsWith('.json'));
    assert.equal(files.length,1);
    const filename=path.join(directory,files[0]);
    assert.equal(JSON.parse(readFileSync(filename,'utf8')).ticket,ticket);
    if(process.platform!=='win32')assert.equal(statSync(filename).mode&0o077,0);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('Windows ticket reads fail closed before reading a secret when ACL verification is unavailable',()=>{
  const cwd=realpathSync(mkdtempSync(path.join(tmpdir(),'review-ticket-acl-')));
  try {
    const directory=path.join(cwd,'github-reviewer-transport');
    // Existing POSIX fixture must still require the Windows ACL verifier when that host is selected.
    mkdirSync(directory,{mode:0o700});
    const filename=path.join(directory,'reviewer-test.json');
    writeFileSync(filename,JSON.stringify({protocol:1,endpoint:'https://executor.example/reviewer-transport',ticket:'c'.repeat(64),expiresAt:new Date(Date.now()+60_000).toISOString(),repository:'org/repo',number:7,expectedHeadSha:'a'.repeat(40),scope:'read'}),{mode:0o600});
    assert.throws(()=>readReviewTransportSession(filename,{platform:'win32',systemRoot:'C:\\Windows',spawnSyncImpl:()=>({status:1})}),/reviewer_ticket_acl_unavailable/);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('Windows ACL verifier pins the OS executable and passes Unicode paths only as stdin data',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'review-acl-中文-'));
  try {
    let captured;
    assertPrivateReviewerPath(root,{platform:'win32',systemRoot:'C:\\Windows',prepareDirectory:true,
      spawnSyncImpl:(...args)=>{captured=args;return {status:0,stdout:'private-reviewer-path-ok'};}});
    assert.equal(captured[0],'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(captured[1].at(-1),REVIEWER_ACL_SCRIPT);
    assert.ok(!captured[1].some(arg=>arg.includes(root)));
    assert.deepEqual(JSON.parse(captured[2].input),{path:root,action:'prepare-directory'});
    assert.equal(captured[2].env.NODE_OPTIONS,undefined);
    assert.equal(captured[2].timeout,10_000);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('ACL program parses as PowerShell without executing host ACL changes',t=>{
  const parse=spawnSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-Command',
    '$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors);if($errors.Count){exit 1}'],
    {input:REVIEWER_ACL_SCRIPT,encoding:'utf8',timeout:10_000});
  if(parse.error?.code==='ENOENT'){t.skip('PowerShell parser unavailable; native Windows acceptance remains required.');return;}
  assert.equal(parse.status,0,parse.stderr);
});
