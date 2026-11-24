import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { defaultRepoStateDir } from './repo-state-identity.mjs';

function location(cwd,repository,number) {
  const key=createHash('sha256').update(JSON.stringify([repository.toLowerCase(),number])).digest('hex');
  return path.join(defaultRepoStateDir('devpro-github-checks',cwd),`${key}.json`);
}
// How long each observation stays usable. A PR check is bound to the expected head of a merge, so it stays short.
// The backend capability observation only says the policy artifact is compatible and lists the tool; Broker
// rechecks every mutation, so it lasts long enough for a normal task between policy queries (AuthBroker #2).
export const GITHUB_CHECK_TTL_MS=120000;
export const GITHUB_CAPABILITIES_TTL_MS=600000;
function readRecord(file) {
  try { const record=JSON.parse(readFileSync(file,'utf8'));return Number.isFinite(record?.savedAt)?record:null; } catch { return null; }
}
// This cache conveys a server observation to local negative fences, never a write permit.
// Broker independently recollects and checks all remote evidence on every mutation.
export function saveGithubCheck(cwd,snapshot,now=Date.now()) {
  if (snapshot?.protocol !== 1 || typeof snapshot.repository !== 'string' || !Number.isSafeInteger(snapshot.number) ||
      !/^[a-f0-9]{40}$/i.test(snapshot.pr?.head?.sha || '') || typeof snapshot.policy?.allowed !== 'boolean') return false;
  const file=location(cwd,snapshot.repository,snapshot.number);
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=`${file}.${randomUUID()}.tmp`;
  writeFileSync(temp,JSON.stringify({savedAt:now,snapshot}),{mode:0o600});renameSync(temp,file);
  return true;
}
export function readGithubCheck(cwd,repository,number,now=Date.now(),ttlMs=GITHUB_CHECK_TTL_MS) {
  const record=readRecord(location(cwd,repository,number));
  return record && record.savedAt <= now && now-record.savedAt <= ttlMs ? record.snapshot : null;
}
function fromResponse(response,select) {
  if (typeof response === 'string') {try {return fromResponse(JSON.parse(response),select);}catch{return null;}}
  if (!response || typeof response !== 'object') return null;
  if (response.isError === true) return null;
  const selected=select(response);if(selected)return selected;
  // Claude passes tool_response as content blocks; Codex/OpenCode usually wrap them.
  const values=Array.isArray(response)?response:[response.data,response.result,response.output,response.structuredContent,response.content,response.text];
  for (const value of values) {
    if (value !== undefined) {const found=fromResponse(value,select);if(found)return found;}
  }
  return null;
}
export function githubCheckFromResponse(response) {
  return fromResponse(response,value=>value.protocol === 1 && (value.policy || value.capabilities)?value:null);
}
export function githubCreatedPrFromResponse(response) {
  return fromResponse(response,value=>value.status === 'completed' && Number.isSafeInteger(value.data?.number) && value.data.number>0?value.data:null);
}
export function githubReviewerTicketFromResponse(response) {
  return fromResponse(response,value=>value.protocol===1&&typeof value.ticket==='string'&&typeof value.endpoint==='string'?value:null);
}

export function saveGithubCapabilities(cwd,value,now=Date.now()) {
  if (value?.protocol !== 1 || value.ready !== true || !/^[a-f0-9]{64}$/.test(value.artifactSha256 || '') ||
      !Array.isArray(value.capabilities) || value.capabilities.some(t=>typeof t !== 'string')) return false;
  const file=location(cwd,'devpro-work/capabilities',0);
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  writeFileSync(file,JSON.stringify({savedAt:now,snapshot:value}),{mode:0o600});return true;
}
export function readGithubCapabilities(cwd,now=Date.now()) {
  return readGithubCheck(cwd,'devpro-work/capabilities',0,now,GITHUB_CAPABILITIES_TTL_MS);
}
// Age of the stored capability observation, or null when none is stored (or it is dated in the future), so a
// denial can tell "never queried" from "expired".
export function githubCapabilitiesAgeMs(cwd,now=Date.now()) {
  const record=readRecord(location(cwd,'devpro-work/capabilities',0));
  return record && record.savedAt <= now ? now-record.savedAt : null;
}
export function clearGithubCapabilities(cwd) {
  rmSync(location(cwd,'devpro-work/capabilities',0),{force:true});
}
