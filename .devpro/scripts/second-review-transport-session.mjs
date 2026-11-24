#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultRepoStateDir } from './hooks/lib/repo-state-identity.mjs';
import { validateReviewTransportSession, readReviewTransportSession } from './lib/second-review-github-transport.mjs';
import { isDirectCliInvocation } from './lib/cli-entry.mjs';
import { assertPrivateReviewerPath } from './lib/reviewer-private-path.mjs';

function directory(cwd) {return defaultRepoStateDir('github-reviewer-transport',cwd);}
function privateDirectory(cwd) {
  const root=directory(cwd);mkdirSync(root,{recursive:true,mode:0o700});
  const stat=lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0)
      ||(process.getuid&&stat.uid!==process.getuid()))throw new Error('reviewer_ticket_directory_not_private');
  assertPrivateReviewerPath(root,{prepareDirectory:true});
  return realpathSync(root);
}

/** Called only by PostToolUse with the actual native MCP response. No OAuth store is read. */
export function stageReviewTransportSession(cwd,envelope,nativeSessionId='') {
  validateReviewTransportSession(envelope);
  const root=privateDirectory(cwd);
  const filename=path.join(root,`reviewer-${randomUUID()}.json`);
  writeFileSync(filename,JSON.stringify({...envelope,nativeSessionId}),{mode:0o600,flag:'wx'});
  assertPrivateReviewerPath(filename);
  return filename;
}

export function listReviewTransportSessions(cwd) {
  const root=directory(cwd);if(!existsSync(root))return [];
  const records=[];
  for(const basename of readdirSync(root)) {
    if(!/^reviewer-[a-f0-9-]{36}\.json$/.test(basename))continue;
    const filename=path.join(realpathSync(root),basename);
    try {
      const session=readReviewTransportSession(filename);
      records.push({file:filename,repository:session.repository,number:session.number,expectedHeadSha:session.expectedHeadSha,
        dispatchId:session.dispatchId,scope:session.scope,expiresAt:session.expiresAt,nativeSessionId:session.nativeSessionId??''});
    }catch {
      // Expired files are removed only when they are private, owned, generated envelopes.
      try {
        const stat=lstatSync(filename);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024||(process.getuid&&stat.uid!==process.getuid())
            ||(process.platform!=='win32'&&(stat.mode&0o077)!==0))continue;
        assertPrivateReviewerPath(path.dirname(filename));
        assertPrivateReviewerPath(filename);
        const value=JSON.parse(readFileSync(filename,'utf8'));
        if(value.protocol===1&&/^[a-f0-9]{64}$/.test(value.ticket)&&Number.isFinite(Date.parse(value.expiresAt))&&Date.parse(value.expiresAt)<=Date.now())rmSync(filename);
      }catch { /* Unknown files are never repaired or deleted. */ }
    }
  }
  return records;
}

if(isDirectCliInvocation(import.meta.url)) {
  try {
    if(process.argv.slice(2).join(' ')!=='--list')throw new Error('Use --list from the native MCP host checkout; output contains paths and target metadata only.');
    process.stdout.write(JSON.stringify(listReviewTransportSessions(process.cwd()))+'\n');
  }catch {process.stderr.write('reviewer_transport_session_unavailable\n');process.exitCode=1;}
}
