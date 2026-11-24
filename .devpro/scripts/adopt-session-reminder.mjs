#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolveReminderSession } from './hooks/lib/session-reminder.mjs';
import { adoptPostPrCompletionMarker } from './hooks/lib/post-pr-completion-state.mjs';
import { adoptRecapWork } from './hooks/lib/recap-utils.mjs';
import { repoName } from './hooks/lib/repo-key.mjs';

export function resolveReminderCliSession({sessionId = '', host = ''} = {}, env = process.env) {
  const session = resolveReminderSession(sessionId ? {session_id: sessionId} : {}, {...env, ...(host ? {DEVPRO_HOOK_HOST: host} : {})});
  if (!session) throw Object.assign(new Error('Missing runtime session ID; pass the actual runtime ID with --session-id (never infer it from a branch/path).'), {code:'missing-session-identity'});
  if (!session.host || session.host === 'unknown' || !/^[a-z0-9-]+$/.test(session.host)) throw Object.assign(new Error('Missing trusted runtime host; pass the actual run-hook runtime with --host.'), {code:'missing-runtime-host'});
  return session;
}

export function adoptSessionReminder({ cwd = process.cwd(), session, prNumber = '', repo = '', branch = '', recapPrNumber = '' } = {}) {
  if (!session) throw new Error('Missing runtime session ID; pass the actual runtime ID with --session-id (never infer it from a branch/path).');
  if (!session.host || session.host === 'unknown') throw new Error('Missing trusted runtime host; pass the actual run-hook runtime with --host.');
  if (Boolean(prNumber) === Boolean(branch)) throw new Error('Choose exactly one target: --pr <number> or --recap <branch>.');
  if (prNumber && !/^[1-9][0-9]*$/.test(String(prNumber))) throw new Error('Invalid PR number.');
  if (branch && repo && (!/^[1-9][0-9]*$/.test(String(recapPrNumber)) || !repoName(repo))) {
    throw new Error('Recap --repo requires a valid GitHub.com repository and --pr-number.');
  }
  const adopted = prNumber ? adoptPostPrCompletionMarker({ cwd, prNumber, repo, session }) :
    adoptRecapWork({ cwd, branch, session, prNumber: recapPrNumber, repo });
  if (!adopted) throw new Error('Target was not adopted; check its existing marker or work branch.');
  return { adopted: true, kind: prNumber ? 'post-pr' : 'recap', target: String(prNumber || branch) };
}

function main() {
  const options = {};
  const names = new Map([['--pr', 'prNumber'], ['--repo', 'repo'], ['--recap', 'branch'], ['--pr-number', 'recapPrNumber'], ['--session-id', 'sessionId'], ['--host', 'host'], ['--cwd', 'cwd']]);
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Explicitly adopt into this session: --pr <number> [--repo github.com/OWNER/REPO] | --recap <branch> [--pr-number <number> [--repo github.com/OWNER/REPO]] [--session-id <runtime-ID> --host <runtime>] [--cwd <worktree>]\n');
    return;
  }
  while (args.length) {
    const name = args.shift();
    if (!names.has(name) || !args.length || args[0].startsWith('--')) throw new Error(`Invalid argument: ${name}`);
    options[names.get(name)] = args.shift();
  }
  const session = resolveReminderCliSession(options);
  process.stdout.write(`${JSON.stringify(adoptSessionReminder({ ...options, session }))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
