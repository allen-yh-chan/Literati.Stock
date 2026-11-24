/**
 * Bounded retry for transient git exec failures (EINTR / Interrupted system call /
 * unable to open loose object under load). Fail-closed after retries; does not
 * swallow non-transient errors.
 */
import { execFileSync } from 'node:child_process';

export const TRANSIENT_GIT_ERROR_RE =
  /Interrupted system call|\bEINTR\b|\bEAGAIN\b|unable to open loose object/i;

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientGitError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = /** @type {{ code?: string }} */ (err).code;
  if (code === 'EINTR' || code === 'EAGAIN') return true;
  const message = String(/** @type {{ message?: string }} */ (err).message || '');
  const stderr = String(/** @type {{ stderr?: string }} */ (err).stderr || '');
  return TRANSIENT_GIT_ERROR_RE.test(`${message}\n${stderr}`);
}

/**
 * Suite/log scanner: require git/fatal framing so AssertionError / spawn titles
 * that mention EINTR do not false-trigger the transient-git-eintr hint.
 * @param {string} text
 * @returns {boolean}
 */
export function logTextLooksLikeTransientGitEintr(text) {
  const s = String(text || '');
  if (/unable to open loose object/i.test(s)) return true;
  // Same-line Interrupted/EINTR/EAGAIN with git/fatal framing.
  // - `fatal:` / `error:` must start the line (no leading whitespace) so TAP YAML
  //   diagnostics like `  error: '…EINTR…'` do not establish framing.
  // - A `git` diagnostic must start the line; test titles or prose that happen
  //   to contain both `git` and `EINTR` are not command failures.
  // - `git` must be followed by whitespace or `:`, not a hyphen compound
  //   (`transient-git-eintr`, `git-exec-retry…EINTR`).
  // Do NOT treat ERR_/spawn*/execFile alone as framing.
  const interrupt = /Interrupted system call|\bEINTR\b|\bEAGAIN\b/i;
  for (const line of s.split(/\r?\n/)) {
    if (!interrupt.test(line)) continue;
    if (/^(?:fatal|error):/i.test(line)) return true;
    if (/^\s*git(?=[\s:]|$)/i.test(line)) return true;
  }
  return false;
}

function sleepMs(ms) {
  const n = Math.max(0, Math.trunc(Number(ms) || 0));
  if (n === 0) return;
  // Block the calling thread without a CPU busy-wait spin (Atomics.wait).
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, n);
}

/**
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} [options]
 * @param {{ retries?: number, delayMs?: number, execFileSyncImpl?: typeof execFileSync }} [retry]
 * @returns {string}
 */
export function execGitFileSyncWithRetry(
  args,
  options = {},
  { retries = 2, delayMs = 25, execFileSyncImpl = execFileSync } = {},
) {
  const maxAttempts = Math.max(0, retries) + 1;
  /** @type {unknown} */
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return execFileSyncImpl('git', args, options);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isTransientGitError(err)) throw err;
      sleepMs(delayMs);
    }
  }
  throw lastErr;
}
