/**
 * removed-scenarios.mjs
 *
 * SSOT for "## Removed Scenarios" escape-hatch parsing. Shared between
 * `.devpro/scripts/pre-pr-archive-gate.mjs` (gate (i) — post-archive
 * canonical guard; gate (p) — archive promotion completeness Removed
 * exemption) and `.devpro/scripts/lint-modified-scenario-preservation.mjs`
 * (pre-archive lint). Extracted to eliminate SSOT drift between the two
 * implementations that were copy-pasted in sync (PR #984 dp-reviewer Suggestion 1).
 *
 * Exports:
 *   - `parseRemovedScenariosFromBody(body)` — parse a single file body string
 *   - `collectRemovedScenarios(dir, candidates?)` — union across candidate files
 *
 * This module is now the `## Removed Scenarios` projection of the generic
 * declared-title-list shape in `./declared-title-lists.mjs`; a second hatch
 * (`## Dependency-Absorbed Requirements`) shares that shape, so the parsing
 * logic lives one level down rather than being copy-pasted a third time. The
 * public API here is unchanged — both call sites above are untouched — and the
 * heading stays owned by this module so the two hatches cannot read each
 * other's bullets.
 */

import { collectDeclaredTitles, DEFAULT_DECLARATION_FILES, parseDeclaredTitlesFromBody } from './declared-title-lists.mjs';

const REMOVED_SCENARIOS_HEADING = 'Removed Scenarios';

/**
 * Parse all declared-removed scenario titles from a single file body string.
 *
 * Looks for a `## Removed Scenarios` heading (exact, standalone) and collects
 * every bullet list entry below it until the next `## ` heading (or EOF).
 *
 * Accepted bullet formats:
 *   // Accept: `- "Title"`, `- 'Title'`, `- \`Title\``, `- Title`
 *
 * @param {string} body - full file content
 * @returns {Set<string>} - set of trimmed scenario titles (without quotes)
 */
export function parseRemovedScenariosFromBody(body) {
  return parseDeclaredTitlesFromBody(body, REMOVED_SCENARIOS_HEADING);
}

/**
 * Collect declared-removed scenario titles from a set of candidate files
 * under `dir`. Returns the union across all files that exist.
 *
 * @param {string} dir - absolute path to the directory (change folder or archive folder)
 * @param {string[]} [candidates] - filenames to probe under dir
 * @returns {Set<string>} - union of all declared-removed titles
 */
export function collectRemovedScenarios(dir, candidates = DEFAULT_DECLARATION_FILES) {
  return collectDeclaredTitles(dir, REMOVED_SCENARIOS_HEADING, candidates);
}
