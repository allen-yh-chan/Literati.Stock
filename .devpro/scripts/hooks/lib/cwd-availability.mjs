/**
 * cwd-availability.mjs
 *
 * Session cwd presence probe. process.cwd() throws ENOENT when the current
 * directory has been deleted (removed worktree / moved session), which is the
 * failure class behind the opaque stop-gate lock
 * (strengthen-hook-runtime-robustness). Kept as a tiny helper so the branch is
 * mechanically testable from a child process whose cwd is deleted at runtime.
 */
export function isCwdAvailable() {
  try {
    process.cwd();
    return true;
  } catch {
    return false;
  }
}
