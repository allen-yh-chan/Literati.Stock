/**
 * hook-handoff-cite-gate.test.mjs
 *
 * Gate A — Handoff Cite Gate unit tests.
 * Covers: lib/handoff-cite-gate.mjs `checkHandoffCite` function.
 *
 * Per P4 Gate A spec: stop-handoff-cite.mjs / lib/handoff-cite-gate.mjs
 * Design: pure logic library (no I/O, no process.exit) — testable in-process.
 *
 * Test strategy:
 *   - Import checkHandoffCite directly (no spawn needed — pure function)
 *   - Happy: keyword + cite → shouldBlock: false
 *   - Adversarial 6 cases covering: no-cite block, commit context skip,
 *     cross-ref cite pass, no-keyword pass, commit description skip,
 *     file.md-only ref (no :N) enforcement
 *
 * Avoid dogfood loop: FORBIDDEN regex patterns constructed via RegExp
 * constructor (per Bundle B+C pattern) — no literal FORBIDDEN regex strings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoFileUrl } from "./lib/repo-root.mjs";

const LIB = repoFileUrl(".devpro/scripts/hooks/lib/handoff-cite-gate.mjs");

const { checkHandoffCite } = await import(LIB);

// ─────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────

test('Gate A happy: message contains release flow keyword + file:line cite → shouldBlock: false', () => {
  const messageText =
    'The release flow should proceed per release-sit-uat-pat-prod.md:42 for the next step.';
  const result = checkHandoffCite({ messageText });
  assert.equal(result.shouldBlock, false);
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (a): keyword present but no cite → block
// ─────────────────────────────────────────────────────────────────────────

test('Gate A adversarial (a): contains "release flow" but no cite → shouldBlock: true', () => {
  const messageText =
    'Please start the release flow when you are ready. The steps are straightforward.';
  const result = checkHandoffCite({ messageText });
  assert.equal(result.shouldBlock, true);
  assert.ok(result.message.length > 0, 'block message must be non-empty');
  assert.ok(
    result.message.includes('Gate A'),
    'block message must reference Gate A'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (b): keyword inside git commit -m heredoc → skip (shouldBlock: false)
// ─────────────────────────────────────────────────────────────────────────

test('Gate A adversarial (b): "release flow" inside git commit -m heredoc context → shouldBlock: false', () => {
  const messageText = [
    'Run the following command:',
    '',
    'git commit -m "$(cat <<\'EOF\'',
    'chore: trigger release flow',
    '',
    'Rules: v6.34.3 · Tool: claude-code · Model: claude-opus-4',
    'EOF',
    ')"',
  ].join('\n');
  const result = checkHandoffCite({ messageText });
  assert.equal(result.shouldBlock, false, 'commit message context must skip gate');
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (c): release/v1.2.3 + per file.md §heading cross-ref → pass
// ─────────────────────────────────────────────────────────────────────────

test('Gate A adversarial (c): contains "release/v1.2.3" + per file §heading cross-ref → shouldBlock: false', () => {
  const messageText =
    'Merge into release/v1.2.3 per `release-sit-uat-pat-prod.md` §Source Repo Specifics.';
  const result = checkHandoffCite({ messageText });
  assert.equal(result.shouldBlock, false, 'cross-ref cite (per §) must satisfy cite check');
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (d): no keyword at all → shouldBlock: false
// ─────────────────────────────────────────────────────────────────────────

test('Gate A adversarial (d): message without any handoff keyword → shouldBlock: false', () => {
  const messageText =
    'The test suite passed. All 747 tests are green. No further action needed.';
  const result = checkHandoffCite({ messageText });
  assert.equal(result.shouldBlock, false, 'no keyword → should not block');
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (e): "hotfix" keyword but message is commit description
//   (contains Co-Authored-By: footer) → skip
// ─────────────────────────────────────────────────────────────────────────

test('Gate A adversarial (e): "hotfix" keyword in commit description containing Co-Authored-By: → shouldBlock: false', () => {
  const messageText = [
    'fix: apply hotfix to auth module',
    '',
    'Resolves the login regression introduced in v6.33.0.',
    '',
    'Rules: v6.34.3 · Tool: claude-code · Model: claude-sonnet',
    'Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>',
  ].join('\n');
  const result = checkHandoffCite({ messageText });
  assert.equal(result.shouldBlock, false, 'Co-Authored-By: footer marks commit context → skip');
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (f): "archive recovery" keyword + bare file.md ref (no :N line) → block
//   The cite regex requires file.md:N — a bare filename without ":N" must NOT satisfy cite.
// ─────────────────────────────────────────────────────────────────────────

test('Gate A adversarial (f): "archive recovery" keyword + file.md without :N line ref → shouldBlock: true', () => {
  const messageText =
    'Please follow the archive recovery procedure in openspec-step-1-to-9.md for the post-merge steps.';
  // This contains "archive recovery" keyword but the file ref has no ":N" line number.
  // The per §heading pattern also does not match (no "per `file` §" form).
  const result = checkHandoffCite({ messageText });
  assert.equal(
    result.shouldBlock,
    true,
    'bare file.md without :N does not satisfy cite check → must block'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Extra: empty message → skip (fail-open)
// ─────────────────────────────────────────────────────────────────────────

test('Gate A: empty message → shouldBlock: false (fail-open)', () => {
  const result = checkHandoffCite({ messageText: '' });
  assert.equal(result.shouldBlock, false);
});

// Extra: rule rationalization keyword + semantic anchor cite → pass
// Cadence moved from rule-design-principles.md → rule-audit-playbook.md
// (enforce-rationalization-loadpath). Use semantic anchor (§Cadence) to avoid
// stale line-number refs.
test('Gate A: "rule rationalization" keyword + semantic anchor cite → shouldBlock: false', () => {
  const messageText =
    'The rule rationalization is complete per `rule-audit-playbook.md` §Cadence.';
  const result = checkHandoffCite({ messageText });
  assert.equal(result.shouldBlock, false);
});

// ─────────────────────────────────────────────────────────────────────────
// Release pipeline vocabulary keywords (sync-rules / consumer sync /
// sync 到 consumer / submodule 鎖) — added per change
// enforce-post-merge-release-handoff-routing
// ─────────────────────────────────────────────────────────────────────────

test('shouldBlock: true when sync-rules keyword used without cite', () => {
  const messageText = 'next: consumer repo /dp:sync-rules 同步本次變更';
  const result = checkHandoffCite({ messageText });
  assert.equal(result.shouldBlock, true);
});

test('shouldBlock: true when "consumer sync" keyword used without cite', () => {
  const messageText = 'merge 後可以叫 consumer sync 一下';
  const result = checkHandoffCite({ messageText });
  assert.equal(result.shouldBlock, true);
});

test('shouldBlock: true when "sync 到 consumer" keyword used without cite', () => {
  const messageText = '下一步：sync 到 consumer';
  const result = checkHandoffCite({ messageText });
  assert.equal(result.shouldBlock, true);
});

test('shouldBlock: true when "submodule 鎖" keyword used without cite', () => {
  const messageText = 'submodule 鎖 production，未 tag 前 consumer 看不到';
  const result = checkHandoffCite({ messageText });
  assert.equal(result.shouldBlock, true);
});

test('shouldBlock: false when sync-rules + submodule 鎖 keywords present with per AGENTS.md §heading cross-ref cite', () => {
  const messageText =
    'next: consumer /dp:sync-rules per AGENTS.md §8 (submodule 鎖 production)';
  const result = checkHandoffCite({ messageText });
  assert.equal(
    result.shouldBlock,
    false,
    'per AGENTS.md §8 cross-ref cite must satisfy Gate A cite check'
  );
});

// R1 mitigation regression test: COMMIT_MSG_CONTEXT_PATTERNS must short-circuit
// the new release-pipeline keywords too — pasting old transcript / commit
// message containing `sync-rules` etc. should not trigger Gate A.
test('shouldBlock: false when sync-rules keyword appears in commit message context (R1 mitigation regression)', () => {
  const messageText = 'git commit -m "fix sync-rules keyword false-negative"';
  const result = checkHandoffCite({ messageText });
  assert.equal(
    result.shouldBlock,
    false,
    'commit message context must skip even when new release-pipeline keyword present'
  );
});

// `submodule 鎖` whitespace tolerance — Reviewer軸 1 Important #1: 中文母語者
// 常省略空格（"submodule鎖production"），pattern 用 \s* 應同樣命中
test('shouldBlock: true when submodule 鎖 keyword used without whitespace (zero-space variant)', () => {
  const messageText = '提醒：submodule鎖production，未走 release flow consumer 看不到';
  const result = checkHandoffCite({ messageText });
  assert.equal(
    result.shouldBlock,
    true,
    'submodule鎖 (no whitespace) must trigger Gate A — \\s* tolerates zero-space'
  );
});
