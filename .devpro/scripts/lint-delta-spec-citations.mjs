#!/usr/bin/env node
/**
 * Pre-archive lint: THEN/AND `leaf.md` §heading citations in the change's own
 * delta specs (`specs/<cap>/spec.md`, `## ADDED Requirements` and
 * `## MODIFIED Requirements` blocks only) must resolve the way
 * cross-ref-spec-thenclause-grep.test.mjs will judge them after promotion:
 * the leaf exists, the heading exists in it, and the citation is clause-final.
 * The judgment lives in lib/spec-thenclause-citations.mjs (shared, one copy).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  headingExistsInTarget,
  scanThenAndCitations,
  stripFencedCodeBlocks,
} from './lib/spec-thenclause-citations.mjs';
import { isArchivePath } from './lib/archive-change-path.mjs';
import { runChangeFolderLinterCli } from './lib/openspec-linter-cli.mjs';

const SCANNED_H2 = new Set(['ADDED Requirements', 'MODIFIED Requirements']);

/**
 * Blank every line outside the scanned H2 blocks. Line count is preserved so
 * the scan's `lineNo` maps 1:1 back to the original file. Fenced code must be
 * neutralized first so a `## ` line inside a fence never opens a section.
 */
function keepScannedBlocks(raw) {
  const lines = stripFencedCodeBlocks(raw).split('\n');
  let keep = false;
  return lines
    .map((line) => {
      const h2 = /^## (.*)$/.exec(line.replace(/\r$/, ''));
      if (h2) {
        keep = SCANNED_H2.has(h2[1].trim());
        return '';
      }
      return keep ? line : '';
    })
    .join('\n');
}

/**
 * @param {{ changeFolder: string, repoRoot?: string }} opts
 * @returns {{ pass: boolean, violations: Array<{ cap: string, specRel: string, line: number, reason: string }>, error?: string, noop?: string }}
 */
export function lintDeltaSpecCitations({ changeFolder, repoRoot }) {
  if (!changeFolder || typeof changeFolder !== 'string') {
    return { pass: false, violations: [], error: 'changeFolder is required' };
  }
  const resolved = resolve(changeFolder);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return { pass: false, violations: [], error: `change folder not found: ${resolved}` };
  }
  if (isArchivePath(resolved)) {
    return {
      pass: false,
      violations: [],
      error: 'lint-delta-spec-citations runs on ACTIVE openspec/changes/<name>/ only',
    };
  }

  const root = resolve(repoRoot ?? join(resolved, '..', '..', '..'));
  const agentRulesDir = join(root, '.devpro', 'agent-rules');
  if (!existsSync(agentRulesDir)) {
    return { pass: true, violations: [], noop: `${agentRulesDir} not found; citations not checkable` };
  }

  const specsDir = join(resolved, 'specs');
  if (!existsSync(specsDir) || !statSync(specsDir).isDirectory()) {
    return { pass: true, violations: [], noop: 'no-delta-specs' };
  }

  /** @type {Array<{ cap: string, specRel: string, line: number, reason: string }>} */
  const violations = [];
  const caps = readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const cap of caps) {
    const specPath = join(specsDir, cap, 'spec.md');
    if (!existsSync(specPath)) continue;
    let raw;
    try {
      raw = readFileSync(specPath, 'utf8');
    } catch (err) {
      return { pass: false, violations: [], error: `failed to read ${specPath}: ${err.message}` };
    }
    const specRel = relative(root, specPath).split(sep).join('/');
    const scan = scanThenAndCitations({ content: keepScannedBlocks(raw), agentRulesDir });
    const found = [];
    for (const c of scan.unresolved) found.push({ line: c.lineNo, reason: 'unresolved leaf' });
    for (const c of scan.citations) {
      if (!headingExistsInTarget(c.targetPath, c.heading)) {
        found.push({ line: c.lineNo, reason: 'heading not found' });
      }
    }
    for (const c of scan.nonClauseFinal) found.push({ line: c.lineNo, reason: 'citation not clause-final' });
    found.sort((a, b) => a.line - b.line);
    for (const f of found) violations.push({ cap, specRel, ...f });
  }

  return { pass: violations.length === 0, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChangeFolderLinterCli({
    scriptName: 'lint-delta-spec-citations',
    usage:
      'Usage: node .devpro/scripts/lint-delta-spec-citations.mjs <change-folder>\n' +
      '  <change-folder>  path to openspec/changes/<name> (ACTIVE only)',
    lint: ({ changeFolder }) => lintDeltaSpecCitations({ changeFolder }),
    printViolation(result) {
      for (const v of result.violations) {
        process.stderr.write(
          `[lint-delta-spec-citations] ${v.cap} :: ${v.specRel}:${v.line} :: ${v.reason}\n`,
        );
      }
      process.stderr.write(
        '\nFix: each THEN/AND `leaf.md` §heading citation in the delta must name an existing\n' +
          '.devpro/agent-rules leaf and heading and sit at clause end (heading text ends at the first\n' +
          '，。、| or line end; an ASCII comma/period stays inside the heading).\n',
      );
    },
    onPass(result, { changeFolder }) {
      if (result.noop) {
        console.log(`[lint-delta-spec-citations] ${changeFolder}: pass (no-op: ${result.noop})`);
        return;
      }
      console.log(`[lint-delta-spec-citations] ${changeFolder}: pass`);
    },
  });
}
