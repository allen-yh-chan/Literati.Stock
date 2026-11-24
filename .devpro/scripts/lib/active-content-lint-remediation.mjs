/**
 * Split pre-review content-lint failure remediation: OpenSpec tree defects vs
 * git/infrastructure probe unavailability (e.g. ratchet priorState unavailable).
 */

/**
 * @param {string} detail
 * @param {string} [stderr]
 * @returns {boolean}
 */
export function isActiveContentLintUnavailable(detail, stderr = '') {
  const blob = `${detail}\n${stderr}`;
  return /\] unavailable:\s/.test(blob);
}

/**
 * @param {{ unavailable: boolean }} opts
 * @returns {string}
 */
export function activeContentLintRemediationText({ unavailable }) {
  if (unavailable) {
    return (
      `\nGit/infrastructure probe unavailable — re-run; persistent failure is an environment problem, not an OpenSpec tree edit:\n` +
      `  node .devpro/scripts/pre-pr-archive-gate.mjs . --pre-review --change-base-ref <immutable-base>\n` +
      `MUST NOT dispatch a reviewer while this probe is unavailable.\n`
    );
  }
  return (
    `\nFix the active OpenSpec tree, then re-run:\n` +
    `  node .devpro/scripts/pre-pr-archive-gate.mjs . --pre-review --change-base-ref <immutable-base>\n` +
    `MUST NOT dispatch a reviewer against a lint-red active tree.\n`
  );
}
