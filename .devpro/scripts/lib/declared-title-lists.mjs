/**
 * declared-title-lists.mjs
 *
 * SSOT for the "declared title list" escape-hatch shape used by OpenSpec change
 * artifacts: an exact standalone `## <Heading>` followed by a bullet list of
 * titles, collected as a union across the change folder's candidate files.
 *
 * Two hatches share this shape and must not drift apart:
 *   - `## Removed Scenarios` — see `./removed-scenarios.mjs`
 *   - `## Dependency-Absorbed Requirements` — see
 *     `.devpro/scripts/lint-delta-body-canonical-wrap.mjs`
 *
 * The parsing logic originated in `removed-scenarios.mjs` (itself extracted from
 * two copy-pasted call sites) and is preserved verbatim apart from the heading
 * becoming a parameter. Any future change to the escape-hatch syntax belongs
 * here and propagates to every named wrapper.
 *
 * Exports:
 *   - `parseDeclaredTitlesFromBody(body, heading)` — parse one file body string
 *   - `collectDeclaredTitles(dir, heading, candidates?)` — union across files
 *   - `DEFAULT_DECLARATION_FILES` — the shared candidate list
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Candidate artifacts a change may carry a declaration in. */
export const DEFAULT_DECLARATION_FILES = ['proposal.md', 'proposal-mini.md', 'tasks.md', 'decisions.md'];

function escapeForRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse all declared titles under `## <heading>` from a single file body string.
 *
 * The heading must match exactly and stand alone on its line; collection stops
 * at the next `## ` heading (or EOF), so two hatches can coexist in one file
 * without reading each other's bullets.
 *
 * Accepted bullet formats:
 *   // Accept: `- "Title"`, `- 'Title'`, `- \`Title\``, `- Title`
 *
 * @param {string} body - full file content
 * @param {string} heading - heading text without the leading `## `
 * @returns {Set<string>} - set of trimmed titles (without quotes)
 */
export function parseDeclaredTitlesFromBody(body, heading) {
  const declared = new Set();
  // The heading is caller-supplied, so it is escaped before interpolation:
  // an unescaped `.` or `+` would silently widen which heading opens the hatch.
  const headingRe = new RegExp(`^## ${escapeForRegExp(heading)}\\s*$`, 'm');
  if (!headingRe.test(body)) return declared;
  const afterHeading = body.split(headingRe)[1] || '';
  const declSection = afterHeading.split(/^## /m)[0];
  for (const line of declSection.split('\n')) {
    // Accept: `- "Title"`, `- 'Title'`, `- \`Title\``, `- Title`
    const m = line.match(/^\s*[-*]\s+["'`]?(.+?)["'`]?\s*$/);
    if (m) declared.add(m[1].trim());
  }
  return declared;
}

/**
 * Collect declared titles under `## <heading>` from a set of candidate files
 * under `dir`. Returns the union across all files that exist.
 *
 * @param {string} dir - absolute path to the directory (change folder or archive folder)
 * @param {string} heading - heading text without the leading `## `
 * @param {string[]} [candidates] - filenames to probe under dir
 * @returns {Set<string>} - union of all declared titles
 */
export function collectDeclaredTitles(dir, heading, candidates = DEFAULT_DECLARATION_FILES) {
  const declared = new Set();
  for (const fname of candidates) {
    const p = join(dir, fname);
    if (!existsSync(p)) continue;
    const body = readFileSync(p, 'utf8');
    for (const title of parseDeclaredTitlesFromBody(body, heading)) {
      declared.add(title);
    }
  }
  return declared;
}
