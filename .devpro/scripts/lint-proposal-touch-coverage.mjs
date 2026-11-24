#!/usr/bin/env node
// Literal per-file Touch coverage of the committed PR diff; no glob expansion.
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PROPOSAL_CARRIERS } from './lib/proposal-carriers.mjs';
import { isArchivePath } from './lib/archive-change-path.mjs';
import { runChangeFolderLinterCli } from './lib/openspec-linter-cli.mjs';

export function lintProposalTouchCoverage({ changeFolder, base }) {
  const violations = [];
  try {
    const folder = resolve(changeFolder);
    if (isArchivePath(folder)) throw new Error('ACTIVE change folder required');
    const file = PROPOSAL_CARRIERS.find(name => existsSync(join(folder, name)));
    if (!file) return { pass: true, violations, noop: 'no-proposal-carrier (lite N/A)' };
    if (!base || !/^[A-Za-z0-9][A-Za-z0-9._/@^~+-]*$/.test(base)) {
      throw new Error('--base <PR-target-base> is required and must be a safe ref');
    }
    const git = args => {
      const result = spawnSync('git', args, { cwd: folder, encoding: 'utf8' });
      if (result.error || result.status !== 0) throw new Error(`git collection failed: ${result.error?.message || result.stderr.trim()}`);
      return result.stdout;
    };
    const root = git(['rev-parse', '--show-toplevel']).trim();
    // Disabling rename folding losslessly includes both old and new names.
    const changed = git(['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`, '--'])
      .split('\0').filter(p => p && !p.startsWith('openspec/changes/') && !p.startsWith('notes/'));
    const changedPaths = new Set(changed);
    const text = readFileSync(join(folder, file), 'utf8')
      .replace(/^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[^\n]*$/gm, '');
    const sections = [...text.matchAll(/^##[ \t]+[^\n]*\bTouch\b[^\n]*\n([\s\S]*?)(?=^##[ \t]|$(?![\s\S]))/gmu)];
    if (sections.length !== 1) {
      if (changed.length === 0 && sections.length === 0) return { pass: true, violations };
      throw new Error(`exactly one Touch section required; uncovered files: ${changed.join(', ')}`);
    }
    const paths = new Set();
    const rows = sections[0][1].split('\n').filter(line => /^\s*\|/.test(line));
    for (const row of rows.slice(2)) {
      const cells = row.trim().split('|').slice(1, -1).map(cell => cell.trim());
      if (cells.length !== 4 || cells.some(cell => !cell)) throw new Error('Touch requires four non-empty table cells per row');
      const token = cells[0].match(/^`([^`]+)`(?:\s*≈?[:：]\d+)?$/)?.[1] || cells[0];
      if ((/[*?\[\]{}]/.test(token) && !changedPaths.has(token)) || token.startsWith('/') || token.includes('\\') ||
          token.split('/').some(part => !part || part === '.' || part === '..') ||
          (existsSync(join(root, token)) && lstatSync(join(root, token)).isDirectory() && !changedPaths.has(token))) {
        violations.push({ file, detail: `Touch row must expand to literal repo-relative files: ${token}` });
      } else paths.add(token);
    }
    for (const path of changed) {
      if (!paths.has(path)) violations.push({ file, detail: `changed file missing from Touch: ${path}` });
    }
    return { pass: violations.length === 0, violations };
  } catch (error) {
    return { pass: false, violations, error: error.message };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChangeFolderLinterCli({
    scriptName: 'lint-proposal-touch-coverage',
    usage: 'Usage: node lint-proposal-touch-coverage.mjs <active-change-folder> --base <PR-target-base>',
    parseExtraArgs(argv) {
      if (argv.length !== 5 || argv[3] !== '--base') return {};
      return { base: argv[4] };
    },
    lint: lintProposalTouchCoverage,
    printViolation({ violations }) {
      for (const v of violations) console.error(`[lint-proposal-touch-coverage] ${v.file}: ${v.detail}`);
    },
    onPass(result) { console.log(`[lint-proposal-touch-coverage] pass${result.noop ? ` (${result.noop})` : ''}`); },
  });
}
