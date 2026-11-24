import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { checkLocalMergeObligations, checkLocalTestEvidence } from '../pre-tool-gate.mjs';
import { resolveGithubRepoIdentity, readCanonicalAgentsMdVersion, getCurrentBranch } from './git-utils.mjs';
import { hasGithubProvenanceFooter, githubProvenanceFooterVersion } from './github-body-policy.mjs';
import { consumerPrePrChecksState, consumerPrePrEvidenceError, consumerDevVerifyEvidenceError, perPrWaiverRecordError, checkoutRepoIdentity, hasPerPrWaiverPart, perPrWaiverMergeReason, isRulesLaneSyncPrHead } from '../../lib/consumer-pre-pr-gate.mjs';
import { resolveRigorLevel } from './rigor-level.mjs';
import { assertDispatchReviewAuthority, controlEvidenceRoot } from './second-review-control-evidence.mjs';

const deny = reason => ({allowed:false,reasonCode:'local_github_gate',reason});
const git = (cwd,args) => spawnSync('git',args,{cwd,encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});

// The trailing footer must carry this session checkout's rules version. As in the native gh footer gate, a checkout
// whose canonical AGENTS.md version cannot be read (origin tip, then workspace) has no version to compare
// (devpro-tw/devpro-hermes-plugins#94).
function footerVersionError(subject,text,cwd) {
  const declared=githubProvenanceFooterVersion(text);
  if (!declared) return `${subject} has no trailing provenance footer line \`Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>\` with a single Rules version.`;
  const canonical=readCanonicalAgentsMdVersion(cwd);
  if (!canonical?.version || declared === canonical.version) return null;
  return `${subject} footer declares Rules: v${declared}, but this session checkout's AGENTS.md (${canonical.anchor}) declares ${canonical.version}. Write this checkout's version, not the write target's.`;
}

// Adoption evidence for the company rules: an AGENTS.md whose canonical `版本：X.Y.Z` can be read (#3557). Rules sync
// always writes that AGENTS.md, so a `.devpro/` or `.devpro-agent-rules/` directory alone is not adoption
// (AuthBroker feedback #3): it may come from another tool or a partial copy, and such a repo has no company PR template.
function adoptedCompanyRules(root) {
  return Boolean(readCanonicalAgentsMdVersion(root)?.version);
}

/** Local-only obligations. Remote policy runs again in Broker at the write boundary. */
export function evaluateGithubClientPolicy(action,{cwd,snapshot,env=process.env}={}) {
  // A commit footer stays optional (advisory in the shared commit policy); a present one is compared.
  const messageError=hasGithubProvenanceFooter(action.message) ? footerVersionError('The commit message',action.message,cwd) : null;
  if (messageError) return deny(messageError);
  const bodyError=action.body != null ? footerVersionError('The text',action.body,cwd) : null;
  if (bodyError) return deny(bodyError);
  // MCP update_issue is not compared with answer-time records: the MCP backend refuses it for a PR number
  // (pull_request_not_issue), so its body belongs to a regular issue, which has no github_check_pr (#3496).
  if (!['create_pr','merge'].includes(action.kind)) return {allowed:true};
  // Only owner/repo is compared, on any origin host: a checkout cloned through the company git proxy
  // (https://demo.devpro.com.tw:8443/<owner>/<repo>) is the same repository. The gate guards against an accidental
  // write to another repository; the Broker checks the write again at its boundary.
  if (resolveGithubRepoIdentity(cwd)?.slug !== action.repository?.toLowerCase()) return deny('Use the local checkout for this repository before creating or merging a PR.');
  const localHead=git(cwd,['rev-parse','HEAD']);
  const branch=getCurrentBranch(cwd);
  if (localHead.status !== 0 || !branch) return deny('Local checkout/head cannot be established.');
  if (action.kind === 'create_pr') {
    if (branch !== action.head) return deny('Check out the exact PR head before creating the PR.');
    const root=git(cwd,['rev-parse','--show-toplevel']);
    if (root.status !== 0) return deny('Local checkout root cannot be established.');
    // A repository that never adopted the company rules has no PR body template to validate; only the footer is
    // checked locally and the backend policy still decides (#3557, same direction as the footer version check of #94).
    const rootPath=root.stdout.trim();
    if (!adoptedCompanyRules(rootPath)) {
      const footerError=footerVersionError('The text',action.body ?? '',cwd);
      return footerError ? deny(footerError) : {allowed:true};
    }
    const state=consumerPrePrChecksState(cwd);
    if (state.error) return deny(state.error);
    if (state.applicable) { const error=consumerPrePrEvidenceError(action.body);if(error)return deny(error); }
    if (!state.source) {
      if (resolveRigorLevel({cwd:rootPath,env}) !== 'off') {
        // A rules-lane sync head needs no DEV line (#3529).
        const dev=isRulesLaneSyncPrHead(branch,rootPath)?null:consumerDevVerifyEvidenceError(action.body);
        if (dev) return deny(`DEV deploy-verify gate: ${dev} Read pre-pr-dev-verification.md.`);
        const waiver=perPrWaiverRecordError(action.body,cwd);
        if (waiver) return deny(`${waiver.gate}: ${waiver.detail}`);
      }
    }
    const lint=path.join(cwd,'.devpro/scripts/pre-pr-body-template-check.mjs');
    if (!existsSync(lint)) return deny('This checkout adopted devpro-agent-rules but has no PR body validator (.devpro/scripts/pre-pr-body-template-check.mjs): the rules sync is incomplete. Complete the rules sync (rules-flow.md) before creating the PR.');
    // Node resolves the module URL to its real path; use the same path in argv so
    // the validator's CLI-entry guard also runs through symlinked checkout paths.
    const result=spawnSync(process.execPath,[realpathSync(lint),'--cwd',cwd,'--pr-cwd',cwd,'--pr-head',branch,'--pr-base',action.baseBranch],
      {cwd,input:action.body,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    if (result.status !== 0 || result.error) return deny('PR body validation failed; run devpro:pre-pr and fix the body evidence.');
    return {allowed:true};
  }
  if (localHead.stdout.trim() !== action.expectedHeadSha) return deny('Local HEAD must equal the expected PR head before merge.');
  const obligation=checkLocalMergeObligations(action.number,cwd,action.repository);
  if (obligation?.block) return deny(obligation.reason);
  if (!snapshot || snapshot.repository?.toLowerCase() !== action.repository?.toLowerCase() || snapshot.number !== action.number || snapshot.pr?.head?.sha !== action.expectedHeadSha || snapshot.pr?.head?.ref !== branch) return deny('Run github_check_pr for this exact PR/head before the MCP merge.');
  const diff=git(cwd,['diff','--name-only',`origin/${action.baseBranch}...${action.expectedHeadSha}`]);
  if (diff.status !== 0) return deny('Local base/head diff is unavailable; fetch the PR base before merge.');
  const receipt=checkLocalTestEvidence({prNumber:action.number,prData:{headRefOid:action.expectedHeadSha,headRefName:branch},
    changedFiles:diff.stdout.trim().split('\n').filter(Boolean),baseCwd:cwd});
  if (receipt?.block) return deny(receipt.reason);
  if (snapshot.policy?.sticky) {
    const sticky=snapshot.policy.sticky;
    try { assertDispatchReviewAuthority({rootDir:controlEvidenceRoot(process.env,cwd),dispatchId:sticky.dispatch_id,
      repositorySlug:action.repository,prNumber:action.number,headRefOid:sticky.last_reviewed_sha}); }
    catch { return deny('The reviewed dispatch has a local operator disposition; obtain a fresh independent review.'); }
  }
  // Last: the description is compared again at merge, from the saved check (the head ref already equals the local branch above).
  const checkout=checkoutRepoIdentity(cwd);
  if (checkout.error) return deny('Local checkout root cannot be established.');
  if (checkout.identity !== 'source' && resolveRigorLevel({cwd:checkout.root,env}) !== 'off') {
    const pr=snapshot.pr;
    if (!Object.hasOwn(pr,'body') || (pr.body !== null && typeof pr.body !== 'string')) return deny('Run github_check_pr for this exact PR/head again; the saved check carries no PR description to compare with the answer-time records.');
    if (hasPerPrWaiverPart(pr.body)) {
      const head=pr.head.repo, base=pr.base?.repo?.full_name;
      if (!Object.hasOwn(pr.head,'repo') || (head !== null && typeof head?.full_name !== 'string') || typeof base !== 'string') return deny('Run github_check_pr for this exact PR/head again; the saved check carries no head or base repository to tell whether the PR head is in this repository.');
      const crossRepository=head === null || head.full_name.toLowerCase() !== base.toLowerCase();
      const waiver=perPrWaiverRecordError(pr.body,cwd,{},{branch:pr.head.ref,crossRepository});
      if (waiver) return deny(perPrWaiverMergeReason(waiver,action.number,'the GitHub web page (MCP update_issue cannot edit a PR), then run github_check_pr again'));
    }
  }
  return {allowed:true};
}
