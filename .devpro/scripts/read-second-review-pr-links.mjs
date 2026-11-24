#!/usr/bin/env node
import { reviewGithubSpawnSync } from './lib/second-review-github-transport.mjs';
import { isDirectCliInvocation } from './lib/cli-entry.mjs';

export function runPrLinksRead(argv,{env=process.env,spawn=reviewGithubSpawnSync}={}) {
  if(argv.length!==2||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(argv[0])||!/^[1-9][0-9]*$/.test(argv[1]))throw new Error('reviewer_pr_links_arguments_invalid');
  return spawn('gh',['pr','view',argv[1],'--repo',argv[0],'--json','closingIssuesReferences'],{env,encoding:'utf8',timeout:30_000,maxBuffer:1024*1024});
}
if(isDirectCliInvocation(import.meta.url)) {
  try {const result=runPrLinksRead(process.argv.slice(2));process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exitCode=result.status??1;}
  catch {process.stderr.write('reviewer_pr_links_failed\n');process.exitCode=1;}
}
