import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeGhAuthentication, selectGithubRoute } from './github-tool-routing.mjs';
import { isDirectCliInvocation } from './cli-entry.mjs';
import { SECOND_REVIEW_COMMENT_FIELDS, SECOND_REVIEW_COMMENT_QUIET_JQ } from './second-review-comment-fields.mjs';
import { assertPrivateReviewerPath } from './reviewer-private-path.mjs';

export const REVIEW_TRANSPORT_FILE='DEVPRO_SECOND_REVIEW_GITHUB_TRANSPORT_FILE';
const MAX_BYTES=5*1024*1024;
const fail=reason=>{throw new Error(reason);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const positive=value=>/^[1-9][0-9]*$/.test(String(value))&&Number.isSafeInteger(Number(value));

export function validateReviewTransportSession(session) {
  if(session?.protocol!==1||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(session.repository)
      ||!positive(session.number)||!/^[a-f0-9]{40}$/.test(session.expectedHeadSha)
      ||!/^[a-f0-9]{64}$/.test(session.ticket)||!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=Date.now())fail('reviewer_ticket_invalid_or_expired');
  const endpoint=new URL(session.endpoint);
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash
      ||!endpoint.pathname.endsWith('/reviewer-transport'))fail('reviewer_endpoint_invalid');
  if(!['read','sticky'].includes(session.scope)||(session.scope==='sticky'&&!/^[A-Za-z0-9._-]{1,128}$/.test(session.dispatchId)))fail('reviewer_ticket_scope_invalid');
  return session;
}

export function readReviewTransportSession(filename,privatePathOptions) {
  if(!path.isAbsolute(filename)||path.basename(path.dirname(filename))!=='github-reviewer-transport'
      ||realpathSync(filename)!==path.resolve(filename))fail('reviewer_ticket_path_invalid');
  const stat=lstatSync(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024
      ||(process.platform!=='win32'&&(stat.mode&0o077)!==0)
      ||(process.getuid&&stat.uid!==process.getuid()))fail('reviewer_ticket_file_not_private');
  assertPrivateReviewerPath(path.dirname(filename),privatePathOptions);
  assertPrivateReviewerPath(filename,privatePathOptions);
  return validateReviewTransportSession(JSON.parse(readFileSync(filename,'utf8')));
}

/** Renderer-owned recipe capability; no credential/path is put in Review Data. */
export function reviewGithubTransportMode({env=process.env,cwd=process.cwd(),repository,number,head}={}) {
  if(!env[REVIEW_TRANSPORT_FILE])return undefined;
  const route=selectGithubRoute({...probeGhAuthentication({cwd,env}),mcpAvailable:true});
  if(route.route==='cli')return undefined;
  if(route.route!=='mcp')fail(route.reason);
  const session=readReviewTransportSession(env[REVIEW_TRANSPORT_FILE]);
  if(session.repository.toLowerCase()!==String(repository).toLowerCase()||session.number!==Number(number)||session.expectedHeadSha!==head)fail('reviewer_ticket_target_mismatch');
  return 'mcp-ticket-v1';
}

export function assertReviewGithubTransportContext(context,{env=process.env,cwd=process.cwd()}={}) {
  if(context.github_transport==='mcp-ticket-v1'&&!env[REVIEW_TRANSPORT_FILE]
      &&selectGithubRoute({...probeGhAuthentication({cwd,env}),mcpAvailable:false}).route!=='cli')fail('reviewer_dispatch_ticket_required');
  const mode=reviewGithubTransportMode({env,cwd,repository:context.repository_slug,number:context.pr_number,head:context.head_ref_oid});
  if(mode===undefined)return;
  if(context.github_transport!==mode)fail('reviewer_transport_context_mismatch');
  const session=readReviewTransportSession(env[REVIEW_TRANSPORT_FILE]);
  if(session.scope!=='sticky'||session.dispatchId!==context.dispatch_id)fail('reviewer_dispatch_ticket_required');
}

export function readReviewGithubCheck({env=process.env,cwd=process.cwd(),repository,number,head}={}) {
  if(reviewGithubTransportMode({env,cwd,repository,number,head})===undefined)return null;
  const session=readReviewTransportSession(env[REVIEW_TRANSPORT_FILE]);
  const reply=invokeWorker(session,{protocol:1,operation:'check'},{env,timeout:30_000});
  const data=reply?.data;
  if(reply.protocol!==1||reply.status!=='completed'||data?.protocol!==1||data.repository?.toLowerCase()!==repository.toLowerCase()
      ||data.number!==Number(number)||data.pr?.head?.sha!==head)fail('reviewer_check_observation_unavailable');
  return data;
}

function parseArguments(args) {
  const positional=[],flags={};
  const booleans=new Set(['--paginate','--slurp','--include','-i']);
  const valued=new Set(['--repo','-R','--json','--jq','-q','--method','-X','--input','-f','-F']);
  for(let i=0;i<args.length;i++) {
    const value=String(args[i]);
    if(booleans.has(value)){flags[value]=true;continue;}
    if(valued.has(value)) {
      if(i+1>=args.length||flags[value]!==undefined)fail('reviewer_command_invalid');
      flags[value]=String(args[++i]);continue;
    }
    if(value.startsWith('-'))fail('reviewer_command_unsupported');
    positional.push(value);
  }
  return {positional,flags};
}

/** Translate only the commands actually used by the reviewer; no raw API proxy. */
export function reviewRequestForGh(args,options,session) {
  const {positional:p,flags:f}=parseArguments(args);
  const jq=f['--jq']??f['-q'];
  if(jq&&!['.headRefOid',SECOND_REVIEW_COMMENT_QUIET_JQ].includes(jq))fail('reviewer_jq_unsupported');
  const repository=f['--repo']??f['-R']??options.env?.GH_REPO??session.repository;
  if(repository.toLowerCase()!==session.repository.toLowerCase())fail('reviewer_repository_mismatch');
  let request={protocol:1};
  if(p[0]==='pr'&&p[1]==='view'&&p.length===3) {
    if(Number(p[2])!==session.number||!positive(p[2]))fail('reviewer_pr_mismatch');
    request.operation='metadata';
  }else if(p[0]==='repo'&&p[1]==='view'&&p.length===2)request.operation='repository';
  else if(p[0]==='issue'&&p[1]==='view'&&p.length===3&&positive(p[2]))request={...request,operation:'issue',number:Number(p[2])};
  else if(p[0]==='api'&&p.length===2) {
    let endpoint=p[1].replace(/^\//,'');
    const endpointRepository=endpoint.match(/^repos\/([^/]+\/[^/]+)(?=\/|$)/);
    if(endpointRepository&&endpointRepository[1].toLowerCase()===session.repository.toLowerCase())endpoint='repos/'+session.repository+endpoint.slice(endpointRepository[0].length);
    const query=endpoint.indexOf('?');
    if(query!==-1) {
      if(endpoint.slice(query)!=='?per_page=100')fail('reviewer_command_unsupported');
      endpoint=endpoint.slice(0,query);
    }
    const root=`repos/${session.repository}`;
    const method=(f['--method']??f['-X']??'GET').toUpperCase();
    if(method==='GET') {
      if(endpoint===root)request.operation='repository';
      else if(endpoint===`${root}/pulls/${session.number}`)request.operation='pr';
      else if(endpoint===`${root}/pulls/${session.number}/files`)request.operation='files';
      else if(endpoint===`${root}/issues/${session.number}/comments`)request.operation='comments';
      else if(endpoint.startsWith(`${root}/issues/comments/`)&&positive(endpoint.slice(`${root}/issues/comments/`.length)))request={...request,operation:'comment',commentId:Number(endpoint.split('/').at(-1))};
      else if(endpoint.startsWith(`${root}/compare/`)) {
        const match=endpoint.slice(`${root}/compare/`.length).match(/^([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/);
        if(!match||match[2]!==session.expectedHeadSha)fail('reviewer_compare_invalid');
        request={...request,operation:'compare',baseSha:match[1],headSha:match[2]};
      }else if(endpoint.startsWith(`${root}/collaborators/`)&&/^[-A-Za-z0-9]+\/permission$/.test(endpoint.slice(`${root}/collaborators/`.length)))request={...request,operation:'permission',login:endpoint.split('/').at(-2)};
      else if(endpoint==='graphql'&&f['-f']?.startsWith('query=')&&f['-F']?.startsWith('id=')&&f['-f'].includes('userContentEdits'))request={...request,operation:'comment_edits',nodeId:f['-F'].slice(3)};
      else fail('reviewer_command_unsupported');
      if(f['--input'])fail('reviewer_command_invalid');
    }else {
      const authority=options.reviewerWrite;
      let payload;try{payload=JSON.parse(String(options.input));}catch{fail('reviewer_write_body_invalid');}
      if(!authority||session.scope!=='sticky'||authority.dispatchId!==session.dispatchId
          ||typeof payload?.body!=='string'||Object.keys(payload).length!==1
          ||authority.bodySha256!==hash(payload.body)||f['--input']!=='-')fail('reviewer_gated_writer_required');
      if(method==='POST'&&endpoint===`${root}/issues/${session.number}/comments`)request={...request,operation:'sticky',disposition:'create'};
      else if(method==='PATCH'&&endpoint.startsWith(`${root}/issues/comments/`)&&positive(endpoint.split('/').at(-1)))request={...request,operation:'sticky',disposition:'update',commentId:Number(endpoint.split('/').at(-1))};
      else fail('reviewer_command_unsupported');
      request.body=payload.body;request.dispatchId=authority.dispatchId;
    }
  }else fail('reviewer_command_unsupported');
  return {request,flags:f};
}

function formattedReply(reply,flags) {
  let data=reply.data;
  if(flags['--json']) {
    const fields=flags['--json'].split(',');
    if(fields.some(field=>!Object.hasOwn(data??{},field)))fail('reviewer_metadata_incomplete');
    data=Object.fromEntries(fields.map(field=>[field,data[field]]));
  }
  if(flags['--slurp']!==true&&Array.isArray(data)&&data.every(Array.isArray))data=data.flat();
  const jq=flags['--jq']??flags['-q'];
  let output;
  if(jq==='.headRefOid')output=data.headRefOid;
  else if(jq===SECOND_REVIEW_COMMENT_QUIET_JQ)output=JSON.stringify(Object.fromEntries(SECOND_REVIEW_COMMENT_FIELDS.map(key=>[key,data[key]])));
  else if(jq)fail('reviewer_jq_unsupported');
  else output=JSON.stringify(data);
  if(flags['--include']||flags['-i'])output=`HTTP/2.0 ${reply.providerStatus??200}\r\ncontent-type: application/json\r\n\r\n${output}`;
  return output;
}

function invokeWorker(session,request,options) {
  const env={};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP','TMPDIR','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR']) {
    const value=(options.env??process.env)[key];if(value)env[key]=value;
  }
  const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--private-request'],{
    input:JSON.stringify({session,request}),encoding:'utf8',timeout:Math.min(options.timeout??30_000,60_000),maxBuffer:MAX_BYTES,
    shell:false,stdio:['pipe','pipe','pipe'],env,
  });
  if(result.error||result.status!==0)fail(request.operation==='sticky'?'write_outcome_unknown':'reviewer_transport_failed');
  try{return JSON.parse(result.stdout);}catch{fail(request.operation==='sticky'?'write_outcome_unknown':'reviewer_transport_failed');}
}

export function createReviewGithubSpawn({nativeSpawn=spawnSync,probe=probeGhAuthentication,readSession=readReviewTransportSession,invoke=invokeWorker}={}) {
  return (command,args,options={})=>{
    const filename=(options.env??process.env)[REVIEW_TRANSPORT_FILE];
    if(command!=='gh'||!filename)return nativeSpawn(command,args,options);
    let writing=false;
    try {
      const route=selectGithubRoute({...probe({cwd:options.cwd,env:options.env??process.env}),mcpAvailable:true});
      if(route.route==='cli')return nativeSpawn(command,args,options);
      if(route.route!=='mcp')fail(route.reason);
      const session=validateReviewTransportSession(readSession(filename));
      const {request,flags}=reviewRequestForGh(args,options,session);
      let readback=null;
      if(request.operation==='sticky'&&request.disposition==='update') {
        const prior=invoke(session,{protocol:1,operation:'comment',commentId:request.commentId},options);
        if(prior?.protocol!==1||prior.status!=='completed'||prior.data?.id!==request.commentId||typeof prior.data.body!=='string')fail('reviewer_predecessor_unavailable');
        if(prior.data.body===request.body)readback=prior;
        else request.expectedCommentBodySha256=hash(prior.data.body);
      }
      writing=request.operation==='sticky'&&!readback;
      const reply=readback??invoke(session,request,options);
      if(reply?.protocol!==1)fail('reviewer_transport_failed');
      if(reply.status!=='completed') {
        if(['blocked','forbidden','revoked','conflict','invalid_parameters','not_found'].includes(reply.status))writing=false;
        if(!writing&&reply.providerStatus===404&&(flags['--include']||flags['-i']))return {status:1,stdout:formattedReply({...reply,data:null},flags),stderr:'not_found',github_transport:'mcp'};
        fail(reply.status==='outcome_unknown'?'write_outcome_unknown':reply.reasonCode??'reviewer_transport_failed');
      }
      const stdout=formattedReply(reply,flags);
      if(Buffer.byteLength(stdout)>Math.min(options.maxBuffer??MAX_BYTES,MAX_BYTES))fail('reviewer_transport_output_limit');
      return {status:0,signal:null,stdout:options.encoding?stdout:Buffer.from(stdout),stderr:options.encoding?'':Buffer.alloc(0),github_transport:'mcp',...(readback?{readback_only:true}:{})};
    }catch(error) {
      // Only local typed reasons escape; endpoint responses and secrets do not.
      const reason=writing?'write_outcome_unknown':/^[a-z][a-z0-9_]{0,100}$/.test(error.message)?error.message:'reviewer_transport_failed';
      return {status:1,signal:null,stdout:'',stderr:reason,error:Object.assign(new Error(reason),{code:reason}),github_transport:'mcp'};
    }
  };
}
export const reviewGithubSpawnSync=createReviewGithubSpawn();

if(isDirectCliInvocation(import.meta.url)) {
  try {
    if(process.argv.slice(2).join(' ')!=='--private-request')fail('reviewer_transport_private_entry');
    let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>MAX_BYTES)fail('reviewer_transport_input_limit');}
    const {session,request}=JSON.parse(input);validateReviewTransportSession(session);
    const response=await fetch(session.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25_000),
      headers:{'content-type':'application/json','X-Devpro-Review-Ticket':session.ticket},body:JSON.stringify(request)});
    const decoder=new TextDecoder('utf-8',{fatal:true});
    let bytes=0,body='';for await(const chunk of response.body){bytes+=chunk.length;if(bytes>MAX_BYTES)fail('reviewer_transport_output_limit');body+=decoder.decode(chunk,{stream:true});}
    body+=decoder.decode();
    const reply=JSON.parse(body);
    if(!response.ok&&reply.status!=='outcome_unknown')reply.status='blocked';
    process.stdout.write(JSON.stringify(reply));
  }catch {process.stderr.write('reviewer_transport_failed\n');process.exitCode=1;}
}
