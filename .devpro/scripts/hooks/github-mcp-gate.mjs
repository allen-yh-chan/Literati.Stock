#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readStdin } from './lib/stdin.mjs';
import { devproGithubToolName, githubHookDeny } from './lib/github-mcp-tools.mjs';
import { normalizeGithubOperation, evaluateGithubOperation } from './lib/github-operation-policy.mjs';
import { probeGhAuthentication, selectGithubRoute } from '../lib/github-tool-routing.mjs';
import { evaluateGithubClientPolicy } from './lib/github-client-policy.mjs';
import { readGithubCheck, saveGithubCheck, githubCheckFromResponse, githubCreatedPrFromResponse, readGithubCapabilities, saveGithubCapabilities, clearGithubCapabilities, githubCapabilitiesAgeMs, GITHUB_CAPABILITIES_TTL_MS } from './lib/github-check-cache.mjs';
import { writePostPrCompletionMarker } from './lib/post-pr-completion-state.mjs';
import { githubReviewerTicketFromResponse } from './lib/github-check-cache.mjs';
import { stageReviewTransportSession } from '../second-review-transport-session.mjs';

export function evaluateGithubMcpPayload(payload,{probe=probeGhAuthentication,local=evaluateGithubClientPolicy,readCheck=readGithubCheck,capabilities=readGithubCapabilities,capabilitiesAge=githubCapabilitiesAgeMs}={}) {
  const name=devproGithubToolName(payload?.tool_name);
  if (!name) return null;
  const cwd=payload.cwd || process.cwd();
  const action=normalizeGithubOperation(name,payload.tool_input);
  const route=selectGithubRoute({...probe({cwd}),mcpAvailable:true});
  if (route.route !== 'mcp') return githubHookDeny(route.route === 'cli' ? 'Authenticated local gh is available; use gh for this GitHub operation.' : `GitHub route blocked: ${route.reason}. Do not change credentials or replay a write.`);
  // Revoke before the RPC: a failed tool may never produce PostToolUse.
  if (name === 'github_policy_status') clearGithubCapabilities(cwd);
  if (action.kind === 'read') return null;
  const server=capabilities(cwd);
  if (server?.ready !== true || server.protocol !== 1 || !server.capabilities?.includes(name)) {
    const age=server ? null : capabilitiesAge(cwd);
    const expired=Number.isFinite(age) && age > GITHUB_CAPABILITIES_TTL_MS
      ? ` The last observation is ${Math.floor(age/60000)} min old; it is valid for ${GITHUB_CAPABILITIES_TTL_MS/60000} min.` : '';
    return githubHookDeny(`Run github_policy_status first. This MCP write requires a verified compatible backend policy artifact.${expired}`);
  }
  // For merge/review and branch deletion the server owns remote evidence; all other predicates run here too.
  const basic=evaluateGithubOperation(action);
  if (!basic.allowed && !['pr_evidence_unavailable','branch_evidence_incomplete'].includes(basic.reasonCode)) {
    // Name every independent blocker so one round of fixes can clear them all (AuthBroker #1).
    const others=(basic.blockers || []).slice(1).map(b=>b.reason === b.reasonCode ? b.reasonCode : `${b.reasonCode} (${b.reason})`);
    return githubHookDeny(`${basic.reason || basic.reasonCode}${others.length ? ` Also blocked by: ${others.join('; ')}.` : ''}`);
  }
  const snapshot=action.kind === 'merge' ? readCheck(cwd,action.repository,action.number) : null;
  const result=local(action,{cwd,snapshot});
  return result.allowed ? null : githubHookDeny(result.reason || result.reasonCode);
}

async function main() {
  try {
    const payload=JSON.parse(await readStdin());
    if (process.env.DEVPRO_HOOK_EVENT === 'PostToolUse') {
      const name=devproGithubToolName(payload.tool_name);
      if(name === 'github_reviewer_ticket') {
        const envelope=githubReviewerTicketFromResponse(payload.tool_response ?? payload.tool_result);
        if(envelope)stageReviewTransportSession(payload.cwd || process.cwd(),envelope,payload.session_id || '');
      }
      if (name === 'github_check_pr' || name === 'github_policy_status') {
        const snapshot=githubCheckFromResponse(payload.tool_response ?? payload.tool_result);
        if(snapshot) {
          const cwd=payload.cwd || process.cwd();
          if(name === 'github_check_pr')saveGithubCheck(cwd,snapshot);else saveGithubCapabilities(cwd,snapshot);
        }
      }
      if (name === 'github_create_pr') {
        const pr=githubCreatedPrFromResponse(payload.tool_response ?? payload.tool_result);
        if(pr) {
          // V2 after events may omit invocation input. GitHub's creation response
          // carries the target repository and source ref, independently of host args.
          const branch=pr.head?.ref || payload.tool_input?.head;
          const repository=pr.base?.repo?.full_name || payload.tool_input?.repository;
          if(typeof branch!=='string' || !branch || typeof repository!=='string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)
            || !/^[a-f0-9]{40}$/i.test(pr.head?.sha || ''))throw new Error('Completed PR identity unavailable; inspect the original result without replaying.');
          writePostPrCompletionMarker({cwd:payload.cwd || process.cwd(),prNumber:String(pr.number),
            branch,url:pr.html_url || '',repositorySlug:repository,
            headRefOid:pr.head.sha,sessionId:payload.session_id || ''});
        }
      }
      return;
    }
    const decision=evaluateGithubMcpPayload(payload);
    if(decision)process.stdout.write(JSON.stringify(decision));
  } catch {
    if (process.env.DEVPRO_HOOK_EVENT !== 'PostToolUse') process.stdout.write(JSON.stringify(githubHookDeny('GitHub gate failed; retry only after repairing the gate.')));
    else process.exitCode=1;
  }
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)await main();
