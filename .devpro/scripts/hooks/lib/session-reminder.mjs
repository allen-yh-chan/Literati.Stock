import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sessionRuleLoadIdentity } from './rule-load-session-ledger.mjs';
import { defaultRepoStateDir } from './repo-state-identity.mjs';
import { lastAssistantMessageText } from './transcript-message.mjs';

// Paths and branch names are never conversation identity. Stable host IDs keep
// the same scope across compaction/resume and exclude a new conversation.
export function resolveReminderSession(payload = {}, env = process.env) {
  const sessionId = sessionRuleLoadIdentity(payload) || String(
    env.DEVPRO_POST_PR_COMPLETION_SESSION_ID || env.CODEX_THREAD_ID ||
    env.CLAUDE_SESSION_ID || env.CLAUDE_CONVERSATION_ID || env.DEVPRO_HOST_SESSION_ID || ''
  ).trim();
  if (!sessionId) return null;
  const host = String(env.DEVPRO_HOOK_HOST || (env.CODEX_THREAD_ID ? 'codex' :
    (env.CLAUDE_SESSION_ID || env.CLAUDE_CONVERSATION_ID) ? 'claude-code' : 'unknown')).trim();
  const key = createHash('sha256').update(JSON.stringify([host, sessionId])).digest('hex');
  return { sessionId, host, key };
}

export function ownsReminder(record, session) {
  if (!session) return false;
  return record?.sessionKey ? record.sessionKey === session.key :
    Boolean(record?.sessionId && record.sessionId === session.sessionId &&
      (!record.host || record.host === session.host));
}

export function reminderSessionDir(cwd, session) {
  if (!session) return null;
  return path.join(process.env.DEVPRO_SESSION_REMINDER_STATE_DIR ||
    defaultRepoStateDir('devpro-session-reminders', cwd), session.key);
}

export function isCloseoutMessage(text) {
  const message = String(text || '').replace(/```[\s\S]*?```/g, '')
    .split('\n').filter((line) => !/^\s*>/.test(line) && !/^\s*\[(?:Gate:|AskFirstPending:|RuntimeCaps:)/.test(line)).join('\n');
  if (!message.trim()) return false;
  return /(?:^|\n)\s*(?:\*\*)?(?:為什麼停|要你做什麼|回了會怎樣)(?:[（(][^）)]*[）)])?(?:\*\*)?\s*[:：]/.test(message) ||
    /(?:本次|本輪|這次|session|全部工作|整個 change)\s*(?:工作|任務)?\s*(?:已完成|完成了|結束|收尾)|(?:PR\s*(?:#\d+\s*)?(?:已建立|已開|已合併|已 merge)|PR\s*#\d+\s*(?:created|merged))|Status:\s*blocked|Owner:\s*user|AskFirstPending:\s*(?!none\b|無)[^\s\]]+/i.test(message);
}

export function isReminderBoundary(payload = {}) {
  const supplied = payload.last_assistant_message || payload.lastAssistantMessage;
  return isCloseoutMessage(typeof supplied === 'string' ? supplied :
    lastAssistantMessageText(payload.transcript_path || payload.transcriptPath || ''));
}

// A short AI instruction points to the complete evidence, without losing gate
// semantics or turning hook context into a user-facing choice list.
export function compactReminder({ cwd = process.cwd(), session, kind, summary, action, details }) {
  if (!session) return '';
  const line = (value) => String(value).replace(/[\r\n]+/g, ' ').trim();
  try {
    const dir = reminderSessionDir(cwd, session);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(kind).replace(/[^a-z0-9-]/gi, '_')}-details.log`);
    writeFileSync(file, `${String(details || '').trimEnd()}\n`, 'utf8');
    return `AI: ${line(summary)}\nNext: From hook cwd, ${line(action)}\nDetails: ${path.relative(cwd, file)}`;
  } catch (error) {
    const code = /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'storage-error';
    return `AI: ${line(summary)}\nNext: Resolve diagnostic storage, then retry this session's scoped reminder; preserve the gate decision.\nDetails: unavailable (${code})`;
  }
}

// Missing identity is observable without inventing an owner, injecting a
// reminder, or inspecting other sessions. Diagnostic failures never set gates.
// Producer-only retention: 1 MiB rollover threshold, one previous segment.
// Concurrent producers are best-effort (no waiting/locking on the hook path).
const DIAGNOSTIC_ROLLOVER_BYTES = 1024 * 1024;
const DIAGNOSTIC_EVENT_BYTES = 4096;

export function recordReminderDiagnostic({ cwd = process.cwd(), kind, reason, env = process.env }) {
  try {
    const event = `${JSON.stringify({ at: new Date().toISOString(), kind, reason, status: 'not-checked' })}\n`;
    if (Buffer.byteLength(event, 'utf8') > DIAGNOSTIC_EVENT_BYTES) return null;
    const dir = env.DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR || defaultRepoStateDir('devpro-session-reminders', cwd);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'reminder-events.log');
    const backup = file + '.1';
    // Retire an oversized legacy segment without reading its contents.
    for (const segment of [file, backup]) {
      let size;
      try { size = statSync(segment).size; }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (size > DIAGNOSTIC_ROLLOVER_BYTES) {
        if (segment === file) truncateSync(file, 0);
        else unlinkSync(backup);
      } else if (segment === file && size + Buffer.byteLength(event, 'utf8') > DIAGNOSTIC_ROLLOVER_BYTES) {
        // rename replaces the single backup; a concurrent rename may win.
        try { renameSync(file, backup); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    appendFileSync(file, event, 'utf8');
    return path.relative(cwd, file);
  } catch { return null; }
}
