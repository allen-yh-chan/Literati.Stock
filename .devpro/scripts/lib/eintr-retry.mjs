/**
 * eintr-retry.mjs
 *
 * Bounded retry for transient git I/O interruptions (EINTR class). Git object
 * and ref reads can fail with `unable to open loose object …: Interrupted
 * system call` under load; retrying the same read is safe because these ops are
 * read-idempotent from the caller's perspective. Only EINTR-class failures are
 * retried — everything else propagates unchanged so real errors keep failing
 * fast. Some adopted call sites also run write-shaped commands (for example
 * `git checkout` / `update-ref` in test fixtures); for those, a transient EINTR
 * retry is still the observed recovery, and any non-EINTR failure (including a
 * partially-applied write command) propagates unchanged as-is.
 *
 * SSOT: strengthen-hook-runtime-robustness (pending item: suite flake).
 *
 * Scope note: the repo also carries `lib/git-exec-retry.mjs` (adopted by the
 * CLI-side sync/consumer lanes) whose classifier is broader (EINTR / EAGAIN /
 * loose-object text). This helper is the intentionally narrower EINTR-only
 * wrapper adopted by review-core and the two review-remediation/render test
 * suites; the surfaces are disjoint, so the two helpers coexist by design
 * until a future consolidation change merges them.
 */

const EINTR_RE = /Interrupted system call|EINTR/u;

export function isTransientGitIoError(error) {
  if (error === null || error === undefined) return false;
  if (error.code === "EINTR") return true;
  // Classification reads only the child's stderr (or the synthetic code):
  // error.message embeds the full argv and error.stdout may carry blob
  // content, both of which can contain EINTR-looking text in unrelated
  // failures (cross-model F4).
  const text = error.stderr;
  if (typeof text === "string") return EINTR_RE.test(text);
  if (Buffer.isBuffer(text)) return EINTR_RE.test(text.toString("utf8"));
  return false;
}

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/**
 * Run `fn` up to `attempts` times, retrying only transient git I/O errors.
 * @template T
 * @param {() => T} fn
 * @param {{ attempts?: number, delayMs?: number }} [options]
 * @returns {T}
 */
export function retryOnTransientGitIo(fn, { attempts = 3, delayMs = 50 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError("retryOnTransientGitIo: attempts must be a positive integer");
  }
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isTransientGitIoError(error)) throw error;
      if (attempt < attempts - 1 && delayMs > 0) sleepSync(delayMs);
    }
  }
  throw lastError;
}
