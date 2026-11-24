#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStdin } from './lib/stdin.mjs';
import { githubHookDeny,isGithubWritePayload,githubShellCommand } from './lib/github-mcp-tools.mjs';
import { probeGhAuthentication,selectGithubRoute } from '../lib/github-tool-routing.mjs';

// Fixed host adapter. These are the same shell gates as the repo adapters.
try {
  const payload=JSON.parse(await readStdin());
  const command=githubShellCommand(payload);
  payload.tool_input={...payload.tool_input,command};
  const input=JSON.stringify(payload);
  const ghWrite=/\bgh\b/.test(command)&&isGithubWritePayload(payload);
  const gitWrite=/\bgit\b[^\n]*\bpush\b/.test(command);
  const phase=process.env.DEVPRO_HOOK_EVENT || 'PreToolUse';
  if(ghWrite||gitWrite) {
    if(phase==='PreToolUse'&&ghWrite) {
      const route=selectGithubRoute({...probeGhAuthentication({cwd:payload.cwd}),mcpAvailable:true});
      if(route.route!=='cli')throw new Error('Local gh is not authenticated; follow the GitHub routing skill before writing.');
    }
    const gates=phase==='PreToolUse'?['pre-tool-gate.mjs','gh-footer-gate.mjs']:['post-tool-gate.mjs'];
    for(const name of gates) {
      const result=spawnSync(process.execPath,[fileURLToPath(new URL('./run-hook.mjs',import.meta.url)),phase,fileURLToPath(new URL(name,import.meta.url)),'--host=hermes'],
        {input,encoding:'utf8',cwd:payload.cwd,timeout:35000,maxBuffer:1024*1024,env:{...process.env,DEVPRO_HOOK_TIMEOUT_MS:'30000'}});
      if(result.error || result.status!==0)throw new Error('Local GitHub gate failed.');
      if(result.stdout.trim()) {
        const decision=JSON.parse(result.stdout);
        if(decision?.decision==='block'||decision?.hookSpecificOutput?.permissionDecision==='deny') {
          process.stdout.write(JSON.stringify(githubHookDeny(decision.reason || decision.hookSpecificOutput?.permissionDecisionReason)));break;
        }
        if(!decision || typeof decision!=='object')throw new Error('Local GitHub gate returned an invalid decision.');
      }
    }
  }
}catch(error) {
  if(process.env.DEVPRO_HOOK_EVENT!=='PostToolUse')process.stdout.write(JSON.stringify(githubHookDeny(error.message || 'Owner GitHub gate unavailable.')));
  else process.exitCode=1;
}
