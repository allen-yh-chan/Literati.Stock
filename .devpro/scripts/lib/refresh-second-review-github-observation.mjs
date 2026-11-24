import { readReviewGithubCheck } from './second-review-github-transport.mjs';
import { saveGithubCheck } from '../hooks/lib/github-check-cache.mjs';

// This is a fresh server observation, never a replacement for canonical sticky,
// model evidence or the post-PR gate. A failed refresh leaves completion pending.
export function refreshSecondReviewGithubObservation(context,{cwd,env=process.env}={}) {
  if(context.github_transport!=='mcp-ticket-v1')return {skipped:true};
  try {
    const snapshot=readReviewGithubCheck({cwd,env,repository:context.repository_slug,number:context.pr_number,head:context.head_ref_oid});
    if(snapshot===null)return {skipped:true};
    return {saved:saveGithubCheck(cwd,snapshot)};
  }catch{return {saved:false,reason:'Refresh github_check_pr through the same owner MCP connection; do not replay the review or publication.'};}
}
