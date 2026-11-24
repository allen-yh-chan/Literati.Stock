#!/usr/bin/env node
/**
 * Pre-archive lint: active proposal Touch/file-list table rows MUST NOT name
 * this change's own pre-archive path (`openspec/changes/<name>/…`). Use the
 * dated-archive shape (date may be `<YYYY-MM-DD>`) or omit with rationale.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isArchivePath } from './lib/archive-change-path.mjs';
import { PROPOSAL_CARRIERS } from './lib/proposal-carriers.mjs';
import { findOwnActivePathRows } from './lib/touch-path-hygiene.mjs';
import { runChangeFolderLinterCli } from './lib/openspec-linter-cli.mjs';

/**
 * @param {{ changeFolder: string }} opts
 * @returns {{ pass: boolean, violations: Array<{ file: string, line: number, detail: string }>, error?: string, noop?: string }}
 */
export function lintProposalTouchSelfPath({ changeFolder }) {
  if (!changeFolder || typeof changeFolder !== 'string') {
    return { pass: false, violations: [], error: 'changeFolder is required' };
  }
  const resolved = resolve(changeFolder);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return { pass: false, violations: [], error: `change folder not found: ${resolved}` };
  }
  const changeName = basename(resolved);
  if (isArchivePath(resolved)) {
    return {
      pass: false,
      violations: [],
      error: 'lint-proposal-touch-self-path runs on ACTIVE openspec/changes/<name>/ only',
    };
  }

  const present = PROPOSAL_CARRIERS.filter((name) => existsSync(join(resolved, name)));
  if (present.length === 0) {
    return { pass: true, violations: [], noop: 'no-proposal-carrier' };
  }

  /** @type {Array<{ file: string, line: number, detail: string }>} */
  const violations = [];
  for (const file of present) {
    let text;
    try {
      text = readFileSync(join(resolved, file), 'utf8');
    } catch (err) {
      return { pass: false, violations: [], error: `failed to read ${file}: ${err.message}` };
    }
    for (const line of findOwnActivePathRows(text, changeName)) {
      violations.push({
        file,
        line,
        detail:
          `Touch/file-list table row names this change's pre-archive path ` +
          `openspec/changes/${changeName}/ — rewrite to ` +
          `openspec/changes/archive/<YYYY-MM-DD>-${changeName}/… ` +
          `(date MAY be the literal placeholder <YYYY-MM-DD>), or omit the row ` +
          `with a non-table placeholder / 不動清單 rationale`,
      });
    }
  }

  return { pass: violations.length === 0, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChangeFolderLinterCli({
    scriptName: 'lint-proposal-touch-self-path',
    usage:
      'Usage: node .devpro/scripts/lint-proposal-touch-self-path.mjs <change-folder>\n' +
      '  <change-folder>  path to openspec/changes/<name> (ACTIVE only)',
    lint: ({ changeFolder }) => lintProposalTouchSelfPath({ changeFolder }),
    printViolation(result) {
      for (const v of result.violations) {
        process.stderr.write(
          `[lint-proposal-touch-self-path] ${v.file}:${v.line}: ${v.detail}\n`,
        );
      }
      process.stderr.write(
        '\nFix: self change-folder Touch rows must be archive-shaped before freeze\n' +
          '(proposal-template.md §Touch; archived-touch-path-hygiene after archive).\n',
      );
    },
    onPass(result, { changeFolder }) {
      if (result.noop) {
        console.log(`[lint-proposal-touch-self-path] ${changeFolder}: pass (no-op: ${result.noop})`);
        return;
      }
      console.log(`[lint-proposal-touch-self-path] ${changeFolder}: pass`);
    },
  });
}
