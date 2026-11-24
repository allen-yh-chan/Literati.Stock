#!/usr/bin/env node
// Stop reminders are scoped to successful work owned by the stable session.
import { readStdin } from './lib/stdin.mjs';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { evaluateRecapState, evaluateMergedRecapPending, buildRecapReminder } from './lib/recap-utils.mjs';
import { resolveReminderSession, reminderSessionDir, isReminderBoundary, recordReminderDiagnostic } from './lib/session-reminder.mjs';

async function main() {
  let payload = {};
  try { payload = JSON.parse((await readStdin()) || '{}'); } catch {}
  const cwd = payload.cwd || process.cwd();
  const session = resolveReminderSession(payload);
  if (!session) {recordReminderDiagnostic({cwd,kind:'recap-stop',reason:'missing-session-identity'});return;}
  const boundary = isReminderBoundary(payload);
  const current = boundary ? await evaluateRecapState({cwd, session}) : {skip: true, reason: 'active-work-non-boundary', pending: []};
  const merged = boundary ? await evaluateMergedRecapPending({cwd, session}) : {skip: true, pending: []};
  const pending = [...(current.pending || []), ...(merged.pending || [])];
  try {
    const dir = reminderSessionDir(cwd, session);
    mkdirSync(dir, {recursive: true});
    appendFileSync(path.join(dir, 'recap.log'), JSON.stringify({ts: new Date().toISOString(), sessionKey: session.key, boundary, current_skip: current.skip, current_reason: current.reason || null, merged_skip: merged.skip, merged_pending_count: (merged.pending || []).length, merged_suppressed_reason: boundary ? null : 'active-work-non-boundary', pending, emitted: pending.length > 0, exit_code: 0}) + '\n');
  } catch {}
  if (pending.length) process.stdout.write(JSON.stringify({systemMessage: buildRecapReminder({cwd, session, pending})}));
}
main().catch((err) => {process.stderr.write(`recap-check hook error: ${err.message}\n`); process.exitCode = 0;});
