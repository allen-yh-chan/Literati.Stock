import { evaluateGithubBody, evaluateGithubCommitMessage } from './github-body-policy.mjs';
import { evaluateSecondReviewEvidence } from './github-review-policy.mjs';
import { githubBranchExemptionReason, githubProductionCarrier, isChoreAClassExempt } from './github-merge-exemptions.mjs';
import { LOCAL_REVIEW_BRANCH_PREFIX, isProtectedBaseBranch, parseRulesSourceWhitelist } from './branch-naming.mjs';
import { toExemptionInput } from '../../lib/changed-file-status.mjs';
import { parseSecondReviewStickyAuthorityBody, SECOND_REVIEW_STICKY_MARKER } from './second-review-sticky-authority.mjs';
import { CROSS_MODEL_WAIVER_MARKER } from './second-review-waiver-authority.mjs';
import { sha256Hex } from '../../lib/primitives.mjs';

export const GITHUB_POLICY_PROTOCOL = 1;
const READS = new Set(['me','repository','repositories','branches','commit','commits','file','read_file','tree',
  'read_issue','issue_comments','checks','commit_status','compare','search_code','search_issues',
  'search_repositories','search_pulls','search_commits','issues','pull_requests','read_pr','pr_files',
  'pr_reviews','pr_review_comments','workflows','ci_runs','read_ci','ci_jobs','ci_log','policy_status','check_pr','preflight','authorization_status']);
const KINDS = Object.freeze({create_issue:'body',comment_issue:'body',update_issue:'issue_update',
  create_pr:'create_pr',review_pr:'review',merge_pr:'merge',run_workflow:'workflow',rerun_ci:'workflow',
  push:'contents',commit_files:'contents',bundle_upload_local:'contents',push_upload_begin:'contents',
  push_upload_chunk:'contents',push_upload_finish:'contents',
  write_review_sticky:'reviewer_sticky',reviewer_ticket:'reviewer_ticket',
  create_repository:'repository_create',delete_branch:'delete_branch'});
// The bundle continuation legs carry no repository/branch of their own: the plugin keeps chunk/finish inside
// the single begin authorization and never routes them through the model hook. A direct model call is refused
// even when it supplies repository/branch, so a continuation can never become a second write authority.
const UPLOAD_CONTINUATIONS = new Set(['github_push_upload_chunk','github_push_upload_finish']);
// Public arguments only; the backend builds the provider body. A GitHub-native name such as
// `private` would otherwise be ignored and the repository created with the opposite visibility.
const REPOSITORY_CREATE_ARGUMENTS = new Set(['repository','ownerType','description','isPrivate','autoInit']);
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const GITHUB_REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** The adapter strips a verified server prefix. Never classify unknown names as read-only. */
export function normalizeGithubOperation(name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {kind:'unsupported'};
  const short = typeof name === 'string' && name.startsWith('github_') ? name.slice(7) : '';
  let kind = READS.has(short) ? 'read' : KINDS[short] || 'unsupported';
  if (name === 'github_git_ticket' || name === 'git_proxy_ticket') {
    kind = args.operation === 'read' ? 'read' : args.operation === 'write' ? 'contents' : 'unsupported';
  }
  return {kind,name,repository:args.repository,number:args.number,head:args.head,
    dispatchId:args.dispatchId,disposition:args.disposition,commentId:args.commentId,
    expectedCommentBodySha256:args.expectedCommentBodySha256,
    baseBranch:name==='github_write_review_sticky'?args.expectedBaseBranch:args.baseBranch,expectedHeadSha:args.expectedHeadSha,decision:args.decision,
    ref:(name === 'github_git_ticket' || name === 'git_proxy_ticket') ? args.reference : kind === 'delete_branch' ? args.branch : args.branch ?? args.ref,
    message:name === 'github_commit_files' ? args.message : undefined,
    body:name === 'github_comment_issue' ? args.text : args.body,
    ...(kind === 'repository_create' ? {create:{...args}} : {})};
}

const deny = (reasonCode, reason = reasonCode, extra = {}) => ({allowed:false,reasonCode,reason,...extra});
const allow = (reasonCode = 'github_policy_pass', extra = {}) => ({allowed:true,reasonCode,...extra});
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const branch = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x20~^:?*\[\\]/.test(value) && !value.startsWith('-') && !value.startsWith('refs/') && !value.includes('..');
const productionAllowed = (head, base) => base !== 'production' || githubProductionCarrier(head);

/** Remote evidence comes only from a trusted collector immediately before the write.
 * The public MCP arguments never carry this object or a caller-supplied policy result.
 * Local checkout/receipt checks remain in the client adapter; task scope remains in Broker.
 */
export function evaluateGithubOperation(action, evidence = {}, options = {}) {
  const result = evaluateOperation(action, evidence, options);
  if (result.allowed || Array.isArray(result.blockers)) return result;
  return {...result, blockers:[blocker(result)]};
}

// Several independent checks failed (AuthBroker #1): the first keeps the top-level reasonCode/reason and extra
// fields, so a caller reading only reasonCode sees exactly what the sequential order returned before; every
// failure is listed in blockers, in that same order.
function denyAll(denials) {
  return {...denials[0], blockers:denials.map(blocker)};
}
// Some shared body/message denials carry only a reasonCode; a blocker always has a string reason.
const blocker = ({reasonCode, reason}) => ({reasonCode, reason: typeof reason === 'string' ? reason : reasonCode});

// A check that depends on an earlier precondition (repository shape, PR identity, PR evidence, files or
// comments evidence) is not run when that precondition fails; checks that do not depend on each other are
// all run and listed.
function evaluateOperation(action, evidence, {rulesSources = []}) {
  if (!action || action.kind === 'unsupported') return deny('github_operation_unsupported');
  if (UPLOAD_CONTINUATIONS.has(action.name)) return deny('upload_continuation_not_model_callable');
  if (action.kind === 'read') return allow('read_only',action.name === 'github_policy_status'
    ? {capabilities:[...Object.keys(KINDS).map(name=>'github_'+name),'github_git_ticket','git_proxy_ticket']} : {});
  if (action.kind === 'repository_create') return evaluateRepositoryCreate(action.create);
  if (typeof action.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(action.repository)) return deny('repository_required');
  if (action.kind === 'delete_branch') return evaluateDeleteBranch(action,evidence);
  if (['reviewer_ticket','reviewer_sticky'].includes(action.kind)) {
    if (!Number.isSafeInteger(action.number) || action.number < 1 || !sha(action.expectedHeadSha)) return deny('expected_pr_head_required');
    if (action.dispatchId !== undefined && action.dispatchId !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(action.dispatchId)) return deny('sticky_dispatch_invalid');
    if (action.kind === 'reviewer_ticket') return allow();
    return evaluateReviewerSticky(action,evidence);
  }
  const blockers = [];
  if (['body','create_pr','review'].includes(action.kind) || (action.kind === 'issue_update' && action.body !== undefined && action.body !== null)) {
    const body = evaluateGithubBody(action.body);
    if (!body.allowed) blockers.push(body);
  }
  if (action.kind === 'contents') {
    const ref = typeof action.ref === 'string' ? action.ref.replace(/^refs\/heads\//,'') : '';
    if (!branch(ref) || ref.startsWith('refs/') || isProtectedBaseBranch(ref) || ref.startsWith('release/')) blockers.push(deny('protected_ref'));
    if (action.name === 'github_commit_files') {
      const message=evaluateGithubCommitMessage(action.message);
      if (!message.allowed) blockers.push(message);
      if (blockers.length) return denyAll(blockers);
      return allow('github_policy_pass',message.advisory ? {advisory:message.advisory} : {});
    }
  }
  if (action.kind === 'workflow' && !branch(action.ref)) blockers.push(deny('workflow_ref_required'));
  if (action.kind === 'create_pr') {
    if (!branch(action.head) || !branch(action.baseBranch)) blockers.push(deny('pr_refs_required'));
    else {
      if (action.head.startsWith(LOCAL_REVIEW_BRANCH_PREFIX)) blockers.push(deny('local_review_branch'));
      if (!productionAllowed(action.head, action.baseBranch)) blockers.push(deny('production_release_carrier_required'));
    }
  }
  if (!['review','merge'].includes(action.kind)) return blockers.length ? denyAll(blockers) : allow();
  if (!Number.isSafeInteger(action.number) || action.number < 1 || !sha(action.expectedHeadSha) || !branch(action.baseBranch)) return denyAll([...blockers,deny('expected_pr_head_required')]);
  const pr = evidence.pr;
  if (!pr || pr.state !== 'open' || !sha(pr.head?.sha) || !branch(pr.head?.ref) || !branch(pr.base?.ref)) return denyAll([...blockers,deny('pr_evidence_unavailable')]);
  if (pr.head.sha !== action.expectedHeadSha || pr.base.ref !== action.baseBranch) blockers.push(deny('pr_head_or_base_changed'));
  if (action.kind === 'review') {
    if (!['approve','request_changes','comment'].includes(action.decision)) blockers.push(deny('review_decision_invalid'));
    return blockers.length ? denyAll(blockers) : allow();
  }
  if (pr.draft !== false) blockers.push(deny('pr_not_ready'));
  if (pr.head.ref.startsWith(LOCAL_REVIEW_BRANCH_PREFIX)) blockers.push(deny('local_review_branch'));
  if (!productionAllowed(pr.head.ref, pr.base.ref)) blockers.push(deny('production_release_carrier_required'));
  // Complete current observations, including an explicitly empty CI set, are required.
  if (['checks','statuses'].some(key => evidence.complete?.[key] !== true || !Array.isArray(evidence[key]))) blockers.push(deny('ci_evidence_incomplete'));
  else if (evidence.checks.some(c => c?.status !== 'completed' || !['success','neutral','skipped'].includes(c.conclusion)) ||
      evidence.statuses.some(s => s?.state !== 'success')) blockers.push(deny('ci_not_successful'));
  if(typeof evidence.rulesSourceText === 'string') {
    const whitelist=parseRulesSourceWhitelist(evidence.rulesSourceText);
    rulesSources=whitelist.kind === 'valid' ? [...whitelist.sources] : [];
  }
  let exemption = githubBranchExemptionReason(pr.head.ref, rulesSources);
  if (!exemption) {
    if (evidence.complete?.files !== true || !Array.isArray(evidence.files) || evidence.files.some(f => typeof f?.filename !== 'string' || typeof f.status !== 'string')) return denyAll([...blockers,deny('files_evidence_incomplete')]);
    const changed=toExemptionInput(evidence.files.map(f=>({path:f.filename,status:f.status,previousPath:f.previous_filename})));
    if (isChoreAClassExempt(pr.head.ref,changed.files,changed.statuses)) exemption='chore-A';
  }
  if (exemption) return blockers.length ? denyAll(blockers) : allow('cross_model_exempt',{exemption});
  if (evidence.complete?.comments !== true || !Array.isArray(evidence.comments)) return denyAll([...blockers,deny('review_evidence_incomplete')]);
  const review = evaluateSecondReviewEvidence({prNumber:action.number,
    prData:{headRefName:pr.head.ref,headRefOid:pr.head.sha,comments:evidence.comments},
    compare:(base,head)=>evidence.compare?.base === base && evidence.compare?.head === head
      ? {ok:true,body:evidence.compare.body} : {ok:false,reason:'compare evidence unavailable'},
  });
  if (review.block) blockers.push(deny('second_review_required',review.reason));
  return blockers.length ? denyAll(blockers) : allow('second_review_pass',{audits:review.audits,sticky:review.sticky});
}

// Absent options take the backend defaults (private, no initial commit); a present option,
// including null, must have its type. Owner/user membership is checked by the backend.
function evaluateRepositoryCreate(args = {}) {
  if (Object.keys(args).some(key => !REPOSITORY_CREATE_ARGUMENTS.has(key))) return deny('repository_create_argument_unsupported');
  const parts = typeof args.repository === 'string' ? args.repository.split('/') : [];
  if (parts.length !== 2 || !GITHUB_OWNER.test(parts[0]) || !GITHUB_REPOSITORY_NAME.test(parts[1])
      || parts[1] === '.' || parts[1] === '..') return deny('repository_create_name_invalid');
  if (!['personal','organization'].includes(args.ownerType)) return deny('repository_create_owner_type_invalid');
  if (Object.hasOwn(args,'description') && (typeof args.description !== 'string' || args.description.length > 350
      || /[\x00-\x1f\x7f-\x9f]/.test(args.description))) return deny('repository_create_description_invalid');
  if (['isPrivate','autoInit'].some(key => Object.hasOwn(args,key) && typeof args[key] !== 'boolean')) return deny('repository_create_boolean_invalid');
  return allow();
}

// A branch production already contains is deleted directly; any other branch needs the owner's one-time
// Portal confirmation bound to this repository, branch and head. Fixed protected names are argument-only,
// so the client denies them before the RPC; everything after needs the collector's evidence.
// release/* follows the ordinary rule (the contents-write release/ block does not apply).
function evaluateDeleteBranch(action,evidence) {
  const ref=action.ref;
  if (!branch(ref) || !sha(action.expectedHeadSha)) return deny('expected_branch_head_required');
  if (isProtectedBaseBranch(ref)) return deny('protected_ref');
  const {repository:repo,branch:head,production,pulls,complete}=evidence ?? {};
  const count=value => Number.isSafeInteger(value) && value >= 0;
  if (['repository','branch','production','pulls'].some(key => complete?.[key] !== true)
      || !branch(repo?.defaultBranch) || typeof head?.name !== 'string' || !sha(head.sha) || typeof head.protected !== 'boolean'
      || production?.ref !== 'production' || typeof production.exists !== 'boolean' || typeof production.containsHead !== 'boolean'
      || (production.containsHead && !production.exists)
      || !count(pulls?.asBase) || !Array.isArray(pulls.asHead) || pulls.asHead.some(number => !count(number) || number < 1)) return deny('branch_evidence_incomplete');
  if (head.name !== ref || head.sha !== action.expectedHeadSha) return deny('branch_head_changed');
  if (ref === repo.defaultBranch || head.protected) return deny('protected_ref');
  if (pulls.asBase > 0) return deny('open_pr_base');
  // Deleting an open PR's head closes that PR, so a shipped head of an open PR still needs confirmation.
  if (production.containsHead && pulls.asHead.length === 0) return allow('merged_into_production');
  const confirmation=evidence.confirmation;
  if (confirmation?.approved === true && confirmation.repository === action.repository
      && confirmation.branch === ref && confirmation.sha === action.expectedHeadSha) return allow('user_confirmed');
  return deny('user_confirmation_required','user_confirmation_required',{openPrHead:[...pulls.asHead]});
}

// Publication transport preserves the existing local dispatch/credential gate.
// This server-side check binds actual body/head/comment; it does not attest to
// model independence or replace the runner's completion/provenance evidence.
function evaluateReviewerSticky(action,evidence) {
  // A waiver is the user's decision; a reviewer sticky never carries one.
  if (typeof action.body === 'string' && action.body.includes(CROSS_MODEL_WAIVER_MARKER)) return deny('human_decision_required');
  const body=evaluateGithubBody(typeof action.body === 'string' ? action.body.replaceAll(SECOND_REVIEW_STICKY_MARKER,'') : action.body);
  if (body.reasonCode === 'human_decision_required') return body;
  const parsed=parseSecondReviewStickyAuthorityBody(action.body);
  if (parsed.status !== 'valid') return deny('sticky_body_invalid');
  if (!body.allowed) return body;
  if (parsed.dispatch_id !== action.dispatchId || parsed.last_reviewed_sha !== action.expectedHeadSha) return deny('sticky_dispatch_or_head_mismatch');
  if (evidence.pr?.state !== 'open' || evidence.pr.head?.sha !== action.expectedHeadSha
      ||(action.baseBranch!==undefined&&evidence.pr.base?.ref!==action.baseBranch)) return deny('pr_head_or_base_changed');
  if (evidence.complete?.comments !== true || !Array.isArray(evidence.comments)
      || evidence.comments.some(comment=>typeof comment?.body !== 'string' || !Number.isSafeInteger(comment.id))) return deny('sticky_evidence_incomplete');
  const candidates=evidence.comments.filter(comment=>comment.body.includes(SECOND_REVIEW_STICKY_MARKER));
  if (action.disposition === 'create' && candidates.length === 0 && action.commentId == null) return allow();
  if (action.disposition === 'update' && candidates.length === 1 && candidates[0].id === action.commentId) {
    if(!/^[a-f0-9]{64}$/.test(action.expectedCommentBodySha256??''))return deny('sticky_predecessor_required');
    return sha256Hex(candidates[0].body)===action.expectedCommentBodySha256?allow():deny('sticky_predecessor_changed');
  }
  return deny('sticky_disposition_changed');
}
