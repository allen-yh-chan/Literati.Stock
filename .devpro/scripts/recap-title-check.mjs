#!/usr/bin/env node
/**
 * recap-title-check.mjs
 *
 * Recap title lint script — checks that a Recap Discussion title matches the
 * canonical format defined in:
 *   .devpro/agent-rules/session-recap.md §寫入方式
 *
 * Required format (regex SSOT — mechanical enforcement canonical source):
 *   [<cwd-repo-name>] <change-name> <YYYY-MM-DD>
 *
 * Examples:
 *   OK:  [devpro-agent-rules] my-change 2026-06-07
 *   OK:  [some-repo] feature/x 2026-01-01
 *   BAD: Session Recap: bugfix/fix-verb-position-gate-gaps (PR #933)
 *   BAD: my-change 2026-06-07           (missing [<repo>] prefix)
 *   BAD: [repo] x 2026-6-7             (bad date: single-digit month/day)
 *
 * Usage:
 *   node recap-title-check.mjs --title "<title>"
 *   echo "..." | node recap-title-check.mjs --title-stdin
 *
 * Exit codes:
 *   0 — title non-empty and matches TITLE_RE
 *   1 — title non-empty but does not match TITLE_RE
 *   2 — title is missing, empty, or unreadable
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REFERENCE =
  '.devpro/agent-rules/session-recap.md §寫入方式';

/**
 * Title format regex (SSOT for mechanical enforcement).
 * Matches: [<repo>] <change-name> <YYYY-MM-DD>
 *   - repo:        [A-Za-z0-9._-]+ (bracketed)
 *   - change-name: [^\n\r]+ — one or more non-newline chars (allows slashes for
 *                  feature/x and inner spaces for multi-word names)
 *   - date:        4-digit year, 2-digit month, 2-digit day
 * Separators are literal single spaces (NOT \s): \s matches \n/\r/\t, which would
 * wave through a malformed multi-line `-F title=` arg (false-negative on this
 * advisory gate). Anchoring the field separators to a literal space + bounding the
 * middle to [^\n\r] keeps the whole title single-line.
 */
const TITLE_RE = /^\[[A-Za-z0-9._-]+\] [^\n\r]+ \d{4}-\d{2}-\d{2}$/;

/**
 * Read Recap title content from:
 *   1. --title <value> argument
 *   2. --title-stdin  (read from fd 0 / stdin)
 *   3. (no flag, no stdin) → return null
 *
 * Returns the title string, or null if input is missing / empty.
 */
function readTitle() {
  const args = process.argv.slice(2);
  const titleIdx = args.indexOf('--title');
  const stdinFlag = args.includes('--title-stdin');

  if (titleIdx !== -1) {
    const value = args[titleIdx + 1];
    if (value === undefined) {
      process.stderr.write('ERROR: --title requires a value argument\n');
      process.exit(2);
    }
    return value.trim() || null;
  }

  if (stdinFlag) {
    try {
      const content = readFileSync(0, 'utf8');
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  // No --title and no --title-stdin → missing
  return null;
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const title = readTitle();

  if (!title) {
    process.stderr.write('ERROR: Recap title input is empty or missing\n');
    process.exit(2);
  }

  if (!TITLE_RE.test(title)) {
    process.stderr.write(
      'ERROR: Recap title does not match canonical format\n' +
      'Expected format: `[<repo>] <change-name> <YYYY-MM-DD>`\n' +
      `Received title: ${title}\n` +
      `Reference: ${REFERENCE}\n`
    );
    process.exit(1);
  }

  process.stdout.write('OK: Recap title format verified\n');
  process.exit(0);
}
