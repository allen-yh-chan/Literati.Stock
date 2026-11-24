#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {resolveReminderCliSession} from './adopt-session-reminder.mjs';
import {recordReminderDiagnostic} from './hooks/lib/session-reminder.mjs';
import {recordSessionChangeClassification} from './hooks/lib/recap-utils.mjs';

export function recordClassification(options = {}, env = process.env) {
  if (!/^chore\/[^\s]+$/.test(options.branch || '')) throw new Error('Pass a named chore branch with --branch chore/<name>.');
  if (!['A', 'B-mini', 'B'].includes(options.classification)) throw new Error('Invalid classification; use --classification A|B-mini|B.');
  let session;
  try {session = resolveReminderCliSession(options, env);} catch(error) {
    if (!['missing-session-identity','missing-runtime-host'].includes(error.code)) throw error;
    recordReminderDiagnostic({cwd:options.cwd || process.cwd(),kind:'change-classification',reason:error.code,env});
    return {recorded:false,status:'not-checked',reason:error.code};
  }
  if (!recordSessionChangeClassification({...options, session})) throw new Error('Classification was not recorded; check local state write access.');
  return {recorded: true, branch: options.branch, classification: options.classification};
}

function main() {
  const options = {};
  const names = new Map([['--branch','branch'],['--classification','classification'],['--session-id','sessionId'],['--host','host'],['--cwd','cwd']]);
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Record local classification only: --branch chore/<name> --classification A|B-mini|B [--session-id <runtime-ID> --host <run-hook-runtime>] [--cwd <worktree>]\n');
    return;
  }
  while (args.length) {
    const name = args.shift();
    if (!names.has(name) || !args.length || args[0].startsWith('--')) throw new Error(`Invalid argument: ${name}`);
    options[names.get(name)] = args.shift();
  }
  process.stdout.write(`${JSON.stringify(recordClassification(options))}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {main();} catch(error) {process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
