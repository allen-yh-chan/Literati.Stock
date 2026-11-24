import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { devproGithubToolName } from './lib/github-mcp-tools.mjs';

const runner=fileURLToPath(new URL('./run-hook.mjs',import.meta.url));
const gate=fileURLToPath(new URL('./github-mcp-gate.mjs',import.meta.url));

function runNode(executable,args,options) {
  return new Promise(resolve=>{
    let stdout='',stderr='',error=null;
    const child=spawn(executable,args,{cwd:options.cwd,env:options.env,stdio:['pipe','pipe','pipe'],shell:false});
    const timer=setTimeout(()=>{error=new Error('GitHub gate timed out');child.kill('SIGKILL');},35000);
    const collect=(key,chunk)=>{
      if(key==='stdout')stdout+=chunk;else stderr+=chunk;
      if(stdout.length+stderr.length>1024*1024){error=new Error('GitHub gate output limit');child.kill('SIGKILL');}
    };
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
    child.on('error',err=>{error=err;});
    child.stdin.on('error',err=>{error=err;});
    child.on('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr,error});});
    child.stdin.end(options.input);
  });
}

/** Global OpenCode adapter: only GitHub MCP; repository hooks retain their own lifecycle. */
export function createGithubOpenCodePlugin({nodeExecutable,run=runNode}={}) {
  return {
    id:'devpro.github-policy',
    async setup(ctx) {
      if(!nodeExecutable)throw new Error('Devpro GitHub: Node runtime is missing. Run the company installer.');
      const cwd=ctx.location.directory;
      const dispatch=async(event,phase)=>{
        if(!devproGithubToolName(event?.tool))return;
        const payload={tool_name:event.tool,tool_input:event.input,tool_response:event.result,cwd,session_id:event.sessionID || ''};
        const result=await run(nodeExecutable,[runner,phase,gate,'--host=opencode'],{
          cwd,encoding:'utf8',input:JSON.stringify(payload),timeout:35000,maxBuffer:1024*1024,
          env:{...process.env,DEVPRO_HOOK_TIMEOUT_MS:'30000'},
        });
        if(phase!=='PreToolUse')return;
        if(result.error || result.status!==0)throw new Error('Devpro GitHub gate failed; operation denied.');
        if(!result.stdout?.trim())return;
        let decision;
        try {decision=JSON.parse(result.stdout);}catch {throw new Error('Devpro GitHub gate returned an invalid decision.');}
        if(decision?.hookSpecificOutput?.permissionDecision==='deny' || decision?.decision==='block')throw new Error(decision?.hookSpecificOutput?.permissionDecisionReason || decision.reason || 'Devpro GitHub operation denied.');
        if(!decision || typeof decision!=='object' || Array.isArray(decision))throw new Error('Devpro GitHub gate returned an invalid decision.');
      };
      await ctx.tool.hook('execute.before',event=>dispatch(event,'PreToolUse'));
      await ctx.tool.hook('execute.after',event=>{if(event?.status==='completed')return dispatch(event,'PostToolUse');});
    },
  };
}
