#!/usr/bin/env node
import { readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,realpathSync,statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ENTRY='.devpro/scripts/github-policy.mjs';
const CLIENT='.devpro/scripts/hooks/github-mcp-gate.mjs';
const RUNNER='.devpro/scripts/hooks/run-hook.mjs';
const OPENCODE='.devpro/scripts/hooks/github-opencode-plugin.mjs';
const OWNER='.devpro/scripts/hooks/github-owner-gate.mjs';
// Files loaded only at run time, which the static import scan cannot see: a literal dynamic
// import, new URL(<literal>, import.meta.url), and a literal joined onto this file's own
// directory (scripts spawned by path). Their targets travel with the artifact like imports do.
const STATIC_REFERENCE=/^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"'\n]+)["']/gm;
const RUNTIME_REFERENCE=/\bimport\(\s*["'](\.{1,2}\/[^"'\n]+)["']\s*\)|\bnew URL\(\s*["'](\.{1,2}\/[^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)|\bfileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*,\s*["'](\.{1,2}\/[^"'\n]+)["']/g;
export function buildGithubPolicyArtifact({source,out,revision}) {
  source=realpathSync(source);out=path.resolve(out);
  if (!/^[a-f0-9]{40}$/i.test(revision || '')) throw new Error('A fixed source commit is required.');
  if(existsSync(out))throw new Error('Artifact output must be a new directory.');
  const pending=[ENTRY,CLIENT,RUNNER,OPENCODE,OWNER,
    '.devpro/scripts/hooks/gh-footer-gate.mjs','.devpro/scripts/hooks/post-tool-gate.mjs',
    // The material contract binds this executable's real path at module load.
    '.devpro/scripts/render-second-review-packet.mjs'],files=new Map();
  while(pending.length) {
    const relative=pending.pop();if(files.has(relative))continue;
    const absolute=path.resolve(source,relative);
    if(!absolute.startsWith(source+path.sep))throw new Error('Import outside source tree.');
    let component=source;
    for(const part of path.relative(source,absolute).split(path.sep)) {
      component=path.join(component,part);
      if(lstatSync(component).isSymbolicLink())throw new Error('Symbolic link in policy source.');
    }
    if(!realpathSync(absolute).startsWith(source+path.sep))throw new Error('Import outside source tree.');
    const bytes=readFileSync(absolute),text=bytes.toString('utf8');
    files.set(relative,bytes);
    const specifiers=[];
    for(const match of text.matchAll(STATIC_REFERENCE)) {
      const specifier=match[1];
      if(specifier.startsWith('node:'))continue;
      if(!specifier.startsWith('.'))throw new Error(`Non-builtin dependency: ${specifier}`);
      specifiers.push(specifier);
    }
    // A runtime literal naming no source file (one quoted in a comment, or a directory) cannot load in
    // the source either, so it adds nothing; a static import still fails when its file is missing.
    for(const match of text.matchAll(RUNTIME_REFERENCE)) {
      const specifier=match[1]??match[2]??match[3];
      const target=path.resolve(path.dirname(absolute),specifier);
      if(existsSync(target)&&statSync(target).isFile())specifiers.push(specifier);
    }
    for(const specifier of specifiers)
      pending.push(path.relative(source,path.resolve(path.dirname(absolute),specifier)).split(path.sep).join('/'));
  }
  const manifest={protocol:1,sourceRevision:revision,runtimeMinimumMajor:20,entry:ENTRY,clientEntry:CLIENT,hookRunner:RUNNER,openCodeEntry:OPENCODE,ownerEntry:OWNER,files:[]};
  for(const [file,bytes] of [...files].sort(([a],[b])=>a.localeCompare(b))) {
    const target=path.join(out,file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,bytes);
    manifest.files.push({path:file,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});
  }
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');writeFileSync(path.join(out,'manifest.json'),bytes);
  return {files:manifest.files.length,sha256:createHash('sha256').update(bytes).digest('hex'),sourceRevision:revision};
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source=path.resolve(import.meta.dirname,'../..');
  const out=process.argv[2];
  if(!out)throw new Error('Usage: build-github-policy-artifact.mjs <new-output-directory>');
  const status=spawnSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:source,encoding:'utf8'});
  const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'});
  if(status.status !== 0 || status.stdout.trim() || revision.status !== 0)throw new Error('Release policy artifacts require a clean committed source checkout.');
  process.stdout.write(JSON.stringify(buildGithubPolicyArtifact({source,out,revision:revision.stdout.trim()}))+'\n');
}
