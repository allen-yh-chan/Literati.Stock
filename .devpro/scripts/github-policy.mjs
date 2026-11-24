#!/usr/bin/env node
import { normalizeGithubOperation, evaluateGithubOperation, GITHUB_POLICY_PROTOCOL } from './hooks/lib/github-operation-policy.mjs';
import { probeGhAuthentication, selectGithubRoute } from './lib/github-tool-routing.mjs';

// Private process protocol. Deploy only a verified artifact; never invoke a script
// from a model-selected checkout. No credential or provider token is accepted.
try {
  if(Number(process.versions.node.split('.')[0])<20)throw new Error('runtime_unsupported');
  let input='';
  for await (const chunk of process.stdin) { input+=chunk;if(Buffer.byteLength(input)>4*1024*1024)throw new Error('input_limit'); }
  const request=JSON.parse(input);
  if (request.protocol !== GITHUB_POLICY_PROTOCOL) throw new Error('protocol_mismatch');
  let result;
  if (request.command === 'route') result=selectGithubRoute({...probeGhAuthentication(),mcpAvailable:true});
  else if (request.command === 'evaluate') result=evaluateGithubOperation(normalizeGithubOperation(request.tool,request.arguments),request.evidence,{rulesSources:request.rulesSources});
  else throw new Error('command_unsupported');
  process.stdout.write(JSON.stringify({protocol:GITHUB_POLICY_PROTOCOL,...result}));
} catch {
  process.stdout.write(JSON.stringify({protocol:GITHUB_POLICY_PROTOCOL,allowed:false,reasonCode:'policy_input_or_execution_failure'}));
  process.exitCode=1;
}
