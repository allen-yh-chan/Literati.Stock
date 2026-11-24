import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  execGitFileSyncWithRetry,
  isTransientGitError,
  logTextLooksLikeTransientGitEintr,
} from '../lib/git-exec-retry.mjs';
import {
  activeContentLintRemediationText,
  isActiveContentLintUnavailable,
} from '../lib/active-content-lint-remediation.mjs';

test('isTransientGitError recognizes EINTR code and loose-object message', () => {
  assert.equal(isTransientGitError({ code: 'EINTR', message: 'x' }), true);
  assert.equal(
    isTransientGitError({
      message: 'fatal: unable to open loose object 12ab: Interrupted system call',
    }),
    true,
  );
  assert.equal(isTransientGitError({ code: 'ENOENT', message: 'missing' }), false);
});

test('execGitFileSyncWithRetry retries transient failures then succeeds', () => {
  let calls = 0;
  const out = execGitFileSyncWithRetry(
    ['status'],
    { encoding: 'utf8' },
    {
      retries: 2,
      delayMs: 0,
      execFileSyncImpl() {
        calls += 1;
        if (calls < 3) {
          const err = new Error('fatal: unable to open loose object ab: Interrupted system call');
          err.code = 'EINTR';
          throw err;
        }
        return 'ok\n';
      },
    },
  );
  assert.equal(out, 'ok\n');
  assert.equal(calls, 3);
});

test('execGitFileSyncWithRetry does not retry non-transient errors', () => {
  let calls = 0;
  assert.throws(
    () =>
      execGitFileSyncWithRetry(
        ['status'],
        {},
        {
          retries: 3,
          delayMs: 0,
          execFileSyncImpl() {
            calls += 1;
            const err = new Error('fatal: not a git repository');
            err.code = 'ENOENT';
            throw err;
          },
        },
      ),
    /not a git repository/,
  );
  assert.equal(calls, 1);
});

test('logTextLooksLikeTransientGitEintr scans suite logs', () => {
  assert.equal(
    logTextLooksLikeTransientGitEintr('Error: unable to open loose object xx: Interrupted system call'),
    true,
  );
  assert.equal(logTextLooksLikeTransientGitEintr('AssertionError: expected 1'), false);
});

test('logTextLooksLikeTransientGitEintr ignores bare EINTR test titles', () => {
  assert.equal(
    logTextLooksLikeTransientGitEintr(
      '✔ isTransientGitError recognizes EINTR code and loose-object message (0.5ms)',
    ),
    false,
  );
  assert.equal(
    logTextLooksLikeTransientGitEintr(
      '✔ git ops keep stderr piped so EINTR classification survives stdio suppression (44ms)',
    ),
    false,
  );
  assert.equal(
    logTextLooksLikeTransientGitEintr('AssertionError [ERR_ASSERTION]: expected EINTR retry'),
    false,
  );
  assert.equal(
    logTextLooksLikeTransientGitEintr('✔ spawnSync retries on EINTR (0.2ms)'),
    false,
  );
  // Hyphen compounds must not establish git framing (\b treats '-' as a boundary).
  assert.equal(logTextLooksLikeTransientGitEintr('transient-git-eintr'), false);
  assert.equal(
    logTextLooksLikeTransientGitEintr('✔ git-exec-retry retries on EINTR (0.2ms)'),
    false,
  );
  // TAP YAML diagnostic keys are indented `error:` — not unindented git stderr.
  assert.equal(
    logTextLooksLikeTransientGitEintr("  error: 'expected EINTR retry'"),
    false,
  );
  assert.equal(
    logTextLooksLikeTransientGitEintr('fatal: unable to open loose object ab: Interrupted system call'),
    true,
  );
  assert.equal(
    logTextLooksLikeTransientGitEintr('git fetch failed: Interrupted system call'),
    true,
  );
});

test('logTextLooksLikeTransientGitEintr keeps recognizing line-start git and fatal/error framing', () => {
  for (const line of [
    'error: cannot lock ref: Interrupted system call',
    'FATAL: read error: EINTR',
    'fatal: unable to access index: EAGAIN',
    'git: read failed: EINTR',
    '  git fetch failed: Interrupted system call',
    'GIT status failed: EINTR',
  ]) {
    assert.equal(logTextLooksLikeTransientGitEintr(line), true, line);
  }
  // Framing is per line: an earlier unrelated line must not hide a later framed one,
  // and CRLF logs split the same way.
  assert.equal(
    logTextLooksLikeTransientGitEintr('ok 1 - something\r\nfatal: index.lock: Interrupted system call\r\nok 2'),
    true,
  );
  // Framing and the interrupt marker on different lines is not a git interrupt.
  assert.equal(
    logTextLooksLikeTransientGitEintr('fatal: not a git repository\n  EINTR mentioned in a later diagnostic'),
    false,
  );
  assert.equal(
    logTextLooksLikeTransientGitEintr('spawnSync retried after git reported EINTR'),
    false,
  );
});

test('logTextLooksLikeTransientGitEintr line-start fatal/error framing works without the loose-object short-circuit', () => {
  // The loose-object phrase returns early; these exercise the per-line framing branch itself.
  assert.equal(logTextLooksLikeTransientGitEintr('fatal: cannot lock ref: Interrupted system call'), true);
  assert.equal(logTextLooksLikeTransientGitEintr('FATAL: read error: EINTR'), true);
  assert.equal(logTextLooksLikeTransientGitEintr('error: EAGAIN while reading the index'), true);
  assert.equal(
    logTextLooksLikeTransientGitEintr('ok 1 - something\nerror: could not read: EINTR\nok 2 - next'),
    true,
    'framing is decided per line, anywhere in a multi-line log',
  );
  // Indented fatal:/error: (TAP YAML diagnostics) never establish framing.
  assert.equal(logTextLooksLikeTransientGitEintr('  fatal: cannot lock ref: Interrupted system call'), false);
  assert.equal(logTextLooksLikeTransientGitEintr("  error: 'EAGAIN in a test title'"), false);
  // Framing must be on the same line as the interrupt marker.
  assert.equal(logTextLooksLikeTransientGitEintr('fatal: bad object\nsomething about EINTR elsewhere'), false);
});

test('sleepMs uses Atomics.wait rather than a busy-wait spin', () => {
  const src = readFileSync(new URL('../lib/git-exec-retry.mjs', import.meta.url), 'utf8');
  assert.match(src, /Atomics\.wait/);
  assert.doesNotMatch(src, /while \(Date\.now\(\) < end\)/);
});

test('isActiveContentLintUnavailable detects ratchet marker', () => {
  assert.equal(
    isActiveContentLintUnavailable(
      '[lint-requirement-count-ratchet] unavailable: unable to enumerate commits since abc: Interrupted system call',
    ),
    true,
  );
  assert.equal(
    isActiveContentLintUnavailable('[lint-requirement-count-ratchet] decisions.md: baseline-ledger-missing'),
    false,
  );
});

test('activeContentLintRemediationText splits unavailable vs content', () => {
  const infra = activeContentLintRemediationText({ unavailable: true });
  assert.match(infra, /Git\/infrastructure probe unavailable/);
  assert.doesNotMatch(infra, /Fix the active OpenSpec tree/);
  const content = activeContentLintRemediationText({ unavailable: false });
  assert.match(content, /Fix the active OpenSpec tree/);
  assert.doesNotMatch(content, /Git\/infrastructure probe unavailable/);
});

test('Scenario: Pre-Review Content Lint Unavailable Probe Does Not Blame The OpenSpec Tree', () => {
  const detail =
    '[lint-requirement-count-ratchet] unavailable: unable to enumerate commits since abc: Interrupted system call';
  assert.equal(isActiveContentLintUnavailable(detail), true);
  const text = activeContentLintRemediationText({ unavailable: true });
  assert.match(text, /Git\/infrastructure probe unavailable/);
  assert.doesNotMatch(text, /Fix the active OpenSpec tree/);
});

test('Scenario: Pre-Review Content Lint Content Defect Still Blames The OpenSpec Tree', () => {
  const detail = '[lint-requirement-count-ratchet] decisions.md: baseline-ledger-missing';
  assert.equal(isActiveContentLintUnavailable(detail), false);
  const text = activeContentLintRemediationText({ unavailable: false });
  assert.match(text, /Fix the active OpenSpec tree/);
});

test('Scenario: Transient Git EINTR Failures Get A Named Suite Retry Hint', () => {
  assert.equal(
    logTextLooksLikeTransientGitEintr('fatal: unable to open loose object ab: Interrupted system call'),
    true,
  );
  assert.equal(logTextLooksLikeTransientGitEintr('AssertionError: expected 1'), false);
  const suiteSrc = readFileSync(new URL('../run-test-suite.mjs', import.meta.url), 'utf8');
  assert.match(suiteSrc, /transient-git-eintr/);
  assert.match(suiteSrc, /re-run this tier before treating as a logic failure/);
});

test('Scenario: Transient Git Hint Ignores Bare Test Titles Containing EINTR', () => {
  assert.equal(
    logTextLooksLikeTransientGitEintr(
      '# Subtest: isTransientGitError recognizes EINTR code and loose-object message\nok',
    ),
    false,
  );
});
