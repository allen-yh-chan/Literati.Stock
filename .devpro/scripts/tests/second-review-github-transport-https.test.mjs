import './lib/isolated-control-evidence-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { runLinkedIssueRead } from '../read-second-review-linked-issue.mjs';
import { runPrLinksRead } from '../read-second-review-pr-links.mjs';
import { assertReviewGithubTransportContext } from '../lib/second-review-github-transport.mjs';
import { refreshSecondReviewGithubObservation } from '../lib/refresh-second-review-github-observation.mjs';
import { readGithubCheck } from '../hooks/lib/github-check-cache.mjs';
import { runGatedStickyWrite, STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA } from '../write-second-review-sticky-gated.mjs';

test('real no-gh helpers cross a TLS transport without sharing native credentials or replaying a write',async t=>{
  const root=realpathSync(mkdtempSync(path.join(tmpdir(),'review-https-')));
  let worker;
  try {
    const cert=path.join(root,'fixture.pem'),key=path.join(root,'fixture.key');
    const openssl=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1',
      '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{encoding:'utf8',timeout:15_000});
    if(openssl.error?.code==='ENOENT'){t.skip('TLS fixture requires OpenSSL.');return;}
    assert.equal(openssl.status,0,'TLS fixture must be generated before testing transport behavior');
    const head='a'.repeat(40),ticket='c'.repeat(64),messages=[];
    worker=new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const fs=require('node:fs'),https=require('node:https');
      let metadataReads=0;
      const server=https.createServer({key:fs.readFileSync(workerData.key),cert:fs.readFileSync(workerData.cert)},(req,res)=>{
        let input='';req.on('data',c=>input+=c);req.on('end',()=>{
          const request=JSON.parse(input);parentPort.postMessage({request,hasNativeToken:!!req.headers['gh-token']});
          if(req.headers['x-devpro-review-ticket']!==workerData.ticket){res.writeHead(403);res.end('{}');return;}
          res.writeHead(200,{'content-type':'application/json'});
          let value={protocol:1,status:'outcome_unknown'};
          if(request.operation==='issue')value={protocol:1,status:'completed',data:{number:9,title:'原始議題',body:'中文內容與🙂',state:'OPEN',labels:[],comments:[]}};
          if(request.operation==='metadata')value={protocol:1,status:'completed',data:++metadataReads===1?{closingIssuesReferences:[
            {number:9,repository:{nameWithOwner:'org/repo'}},{number:11,repository:{nameWithOwner:'other/repo'}}]}:{headRefOid:'a'.repeat(40)}};
          if(request.operation==='check')value={protocol:1,status:'completed',data:{protocol:1,repository:'org/repo',number:7,pr:{head:{sha:'a'.repeat(40)}},policy:{allowed:false}}};
          const bytes=Buffer.from(JSON.stringify(value));for(const byte of bytes)res.write(Buffer.from([byte]));res.end();
        });
      });server.listen(0,'127.0.0.1',()=>parentPort.postMessage({port:server.address().port}));
    `,{eval:true,workerData:{key,cert,ticket}});
    const port=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',message=>{if(message.port)resolve(message.port);else messages.push(message);});});
    const directory=path.join(root,'github-reviewer-transport'),noGh=path.join(root,'no-gh');mkdirSync(directory,{mode:0o700});mkdirSync(noGh);
    const filename=path.join(directory,'session.json');
    writeFileSync(filename,JSON.stringify({protocol:1,endpoint:`https://127.0.0.1:${port}/reviewer-transport`,ticket,
      expiresAt:new Date(Date.now()+60_000).toISOString(),repository:'org/repo',number:7,expectedHeadSha:head,dispatchId:'dispatch-https',scope:'sticky'}),{mode:0o600});
    const env={...process.env,PATH:noGh,NODE_EXTRA_CA_CERTS:cert,DEVPRO_SECOND_REVIEW_GITHUB_TRANSPORT_FILE:filename};
    const links=runPrLinksRead(['org/repo','7'],{env});assert.equal(links.status,0,links.stderr);
    assert.deepEqual(JSON.parse(links.stdout).closingIssuesReferences.map(issue=>issue.repository.nameWithOwner),['org/repo','other/repo']);
    const missing=runPrLinksRead(['org/repo','7'],{env});assert.notEqual(missing.status,0);assert.match(missing.stderr,/reviewer_metadata_incomplete/);
    const foreign=runLinkedIssueRead(['other/repo','11'],{env});assert.notEqual(foreign.status,0);assert.match(foreign.stderr,/reviewer_repository_mismatch/);
    const issue=runLinkedIssueRead(['org/repo','9'],{env});
    assert.equal(issue.status,0,issue.stderr);assert.equal(JSON.parse(issue.stdout).body,'中文內容與🙂');
    const context={github_transport:'mcp-ticket-v1',repository_slug:'org/repo',pr_number:7,head_ref_oid:head,dispatch_id:'dispatch-https'};
    assertReviewGithubTransportContext(context,{cwd:root,env});
    assert.throws(()=>assertReviewGithubTransportContext({...context,dispatch_id:'dispatch-wrong'},{cwd:root,env}),/reviewer_dispatch_ticket_required/);
    assert.deepEqual(refreshSecondReviewGithubObservation(context,{cwd:root,env}),{saved:true});
    assert.equal(readGithubCheck(root,'org/repo',7).policy.allowed,false,'a fresh server denial remains a denial in the observation cache');
    const body=`<!-- cross-model-second-opinion:sticky -->\nverdict: PASS\nlast_reviewed_sha: ${head}\ndispatch_id: dispatch-https\nreason: Reviewed the complete material.\nRules: v7.8.1 · Tool: Claude Code · Model: claude-test`;
    const bodyFile=path.join(root,'body.md');writeFileSync(bodyFile,body);
    const sidecar={schema:STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,repository_slug:'org/repo',pr_number:7,dispatch_id:'dispatch-https',
      disposition:'create',body_file:bodyFile,materialTexts:[],explicitDenyList:[]};
    const sidecarFile=path.join(root,'sidecar.json');writeFileSync(sidecarFile,JSON.stringify({...sidecar,digest:createHash('sha256').update(JSON.stringify(sidecar)).digest('hex')}));
    const result=runGatedStickyWrite({sidecarPath:sidecarFile,cwd:root,env,enforcePathAllowlist:false});
    assert.notEqual(result.status,0,'unknown provider outcome cannot produce a successful writer result');
    assert.equal(result.result.write_outcome,'unknown');
    assert.match(result.result.next_action,/original operation journal/);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(messages.filter(m=>m.request.operation==='sticky').length,1);
    assert.equal(messages.filter(m=>m.request.operation==='issue').length,1,'cross-repo discovery never becomes a foreign issue read');
    assert.equal(messages.find(m=>m.request.operation==='sticky').request.body,body);
    assert.ok(messages.every(m=>!m.hasNativeToken));
  }finally{if(worker)await worker.terminate();rmSync(root,{recursive:true,force:true});}
});
