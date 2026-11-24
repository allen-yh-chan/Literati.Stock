import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('concurrent diagnostic producers retain only two segments without gate failures', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reminder-retention-concurrent-'));
  const file = path.join(dir, 'reminder-events.log');
  const limit = 1024 * 1024;
  const producers = 4;
  const moduleUrl = new URL('../hooks/lib/session-reminder.mjs', import.meta.url).href;
  try {
    writeFileSync(file, JSON.stringify({ reason: 'x'.repeat(limit - 100) }) + '\n');
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { recordReminderDiagnostic } from ${JSON.stringify(moduleUrl)};
        for (let i = 0; i < 180; i++) {
          recordReminderDiagnostic({ cwd: ${JSON.stringify(dir)}, kind: 'recap',
            reason: 'missing-session-identity-' + 'x'.repeat(3500),
            env: { DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR: ${JSON.stringify(dir)} } });
        }
      `], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('diagnostic producer failed')));
    });
    await Promise.all(Array.from({ length: producers }, run));
    const { recordReminderDiagnostic } = await import('../hooks/lib/session-reminder.mjs');
    assert.ok(recordReminderDiagnostic({ cwd: dir, kind: 'post-pr', reason: 'missing-session-identity',
      env: { DEVPRO_SESSION_REMINDER_DIAGNOSTIC_DIR: dir } }));
    const segments = readdirSync(dir);
    assert.ok(segments.includes('reminder-events.log'));
    assert.ok(segments.length <= 2);
    assert.ok(segments.every((name) => ['reminder-events.log', 'reminder-events.log.1'].includes(name)),
      'competing rotations may retire a backup but cannot create extra segments');
    for (const segment of segments.map((name) => path.join(dir, name))) {
      // Concurrent appends may transiently cross the rollover threshold by
      // one bounded event per producer; the next producer retires oversize.
      assert.ok(statSync(segment).size <= limit + producers * 4096);
      // A rotation racing a truncation can leave a segment with no event at all; that is still complete JSONL.
      // Only a zero-byte segment counts as empty; whitespace-only content is still parsed and fails.
      const raw = readFileSync(segment, 'utf8');
      for (const line of raw.length === 0 ? [] : raw.trim().split('\n')) {
        assert.doesNotThrow(() => JSON.parse(line), 'atomic appends must remain complete JSONL');
      }
    }
    const last = readFileSync(file, 'utf8').trim().split('\n').at(-1);
    assert.equal(JSON.parse(last).status, 'not-checked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
