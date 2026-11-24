/**
 * Resolve the host system temp directory for second-review neutral_cwd.
 *
 * Codex / cmux sessions often nest `TMPDIR` under a leaf named
 * `devpro-codex-tmpdir`. If render sees the nested path and run later sees the
 * parent (or the reverse), `path.dirname(neutral_cwd) !== path.resolve(tmpdir())`
 * fails closed as `projection_context_invalid` (#2711).
 *
 * Both render and run MUST use this helper so they agree on the same parent.
 */
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";

/** Known nested leaf names that are NOT the host system temp root. */
export const NESTED_TMPDIR_LEAF_NAMES = Object.freeze([
  "devpro-codex-tmpdir",
]);

/**
 * @param {{ tmpdir?: () => string } | undefined} [options]
 * @returns {string} absolute host system temp directory
 */
export function resolveHostSystemTmpdir(options = {}) {
  const resolveRaw =
    typeof options.tmpdir === "function" ? options.tmpdir : osTmpdir;
  let current = path.resolve(String(resolveRaw() ?? ""));
  if (!current || current === path.sep) {
    return current;
  }
  // Unwrap known nesting; stop at filesystem root.
  for (let i = 0; i < 8; i += 1) {
    const base = path.basename(current);
    if (!NESTED_TMPDIR_LEAF_NAMES.includes(base)) {
      break;
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

/**
 * @param {string} neutralCwdPath
 * @param {{ tmpdir?: () => string } | undefined} [options]
 * @returns {boolean}
 */
export function isDirectChildOfHostSystemTmpdir(neutralCwdPath, options = {}) {
  const resolved = path.resolve(String(neutralCwdPath ?? ""));
  return path.dirname(resolved) === resolveHostSystemTmpdir(options);
}
