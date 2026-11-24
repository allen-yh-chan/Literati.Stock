#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseRequirements } from './lint-spec-shall-must.mjs';
import { runChangeFolderLinterCli } from './lib/openspec-linter-cli.mjs';

function collectDeltaRequirementModes(content) {
  const out = [];
  const blockRe = /^## (ADDED|MODIFIED) Requirements\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm;
  for (const match of content.matchAll(blockRe)) {
    const mode = match[1];
    const block = match[2].replace(/\r\n/g, '\n');
    for (const req of parseRequirements(block)) {
      out.push({ mode, name: req.name });
    }
  }
  return out;
}

function collectCanonicalNames(content) {
  return new Set(parseRequirements(content.replace(/\r\n/g, '\n')).map((req) => req.name));
}

/**
 * Requirement bodies cut the way `parseRequirementBodies` cuts them in
 * review-remediation-evidence-core.mjs, the parser behind seal-final's
 * `derivePromotion`: the body is the text after the `### Requirement:` heading up
 * to the next `##` or `###` heading (so every scenario is inside it), CRLF read as
 * LF, leading and trailing blank lines trimmed. The mode only changes on the three
 * exact delta section headings, as there. A leading BOM is dropped because core
 * decodes with a TextDecoder that drops it. This is a mirror, not shared code.
 */
function collectRequirementBodies(content) {
  const lines = content.replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n').split('\n');
  const entries = [];
  let mode = null;
  for (let index = 0; index < lines.length; index += 1) {
    const section = lines[index].match(/^## (ADDED|MODIFIED|REMOVED) Requirements$/u);
    if (section) {
      mode = section[1];
      continue;
    }
    const heading = lines[index].match(/^### Requirement: (.+)$/u);
    if (!heading) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{2,3} /u.test(lines[end])) end += 1;
    const bodyLines = lines.slice(index + 1, end);
    while (bodyLines[0] === '') bodyLines.shift();
    while (bodyLines.at(-1) === '') bodyLines.pop();
    entries.push({ title: heading[1], mode, body: bodyLines.join('\n') });
    index = end - 1;
  }
  return entries;
}

/** 1-based body line of the first difference between two bodies, or 0 when equal. */
function firstDifferingLine(deltaBody, canonicalBody) {
  const deltaLines = deltaBody.split('\n');
  const canonicalLines = canonicalBody.split('\n');
  const length = Math.max(deltaLines.length, canonicalLines.length);
  for (let index = 0; index < length; index += 1) {
    if (deltaLines[index] !== canonicalLines[index]) return index + 1;
  }
  return 0;
}

/**
 * Verify ADDED/MODIFIED requirement heading modes against canonical requirement
 * titles before `openspec archive` gets a chance to fail late. REMOVED blocks are
 * checked too: seal-final compares a REMOVED block with the canonical body exactly,
 * and fails only after archive, so the title and the verbatim body are checked here.
 *
 * @param {object} opts
 * @param {string} opts.changeFolder absolute path to openspec/changes/<name>
 * @param {string} [opts.repoRoot] absolute repo root; derived from changeFolder when omitted
 * @returns {{pass: boolean, violations: Array<{cap: string, requirement: string, mode: string, reason: string, line?: number}>, error?: string}}
 */
export function lintDeltaRequirementMode({ changeFolder, repoRoot }) {
  const effectiveRepoRoot = repoRoot
    ? resolve(repoRoot)
    : resolve(changeFolder, '..', '..', '..');

  if (!existsSync(changeFolder) || !statSync(changeFolder).isDirectory()) {
    return { pass: false, violations: [], error: `change folder not found: ${changeFolder}` };
  }

  const specsDir = join(changeFolder, 'specs');
  if (!existsSync(specsDir) || !statSync(specsDir).isDirectory()) {
    return { pass: true, violations: [] };
  }

  let caps;
  try {
    caps = readdirSync(specsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { pass: true, violations: [] };
  }

  const violations = [];

  for (const cap of caps) {
    const deltaSpecPath = join(specsDir, cap, 'spec.md');
    if (!existsSync(deltaSpecPath)) continue;

    let deltaContent;
    try {
      deltaContent = readFileSync(deltaSpecPath, 'utf8');
    } catch {
      continue;
    }

    const deltaReqs = collectDeltaRequirementModes(deltaContent);
    const removedReqs = collectRequirementBodies(deltaContent).filter((req) => req.mode === 'REMOVED');
    if (deltaReqs.length === 0 && removedReqs.length === 0) continue;

    const canonicalSpecPath = join(effectiveRepoRoot, 'openspec', 'specs', cap, 'spec.md');
    const hasCanonicalSpec = existsSync(canonicalSpecPath);
    let canonicalContent = '';
    let canonicalNames = new Set();
    if (hasCanonicalSpec) {
      try {
        canonicalContent = readFileSync(canonicalSpecPath, 'utf8');
        canonicalNames = collectCanonicalNames(canonicalContent);
      } catch {
        canonicalContent = '';
        canonicalNames = new Set();
      }
    }

    for (const req of deltaReqs) {
      const existsInCanonical = canonicalNames.has(req.name);

      if (req.mode === 'ADDED' && existsInCanonical) {
        violations.push({
          cap,
          requirement: req.name,
          mode: req.mode,
          reason: 'added-existing-requirement',
        });
      }

      if (req.mode === 'MODIFIED' && (!hasCanonicalSpec || !existsInCanonical)) {
        violations.push({
          cap,
          requirement: req.name,
          mode: req.mode,
          reason: hasCanonicalSpec ? 'modified-missing-requirement' : 'modified-missing-capability',
        });
      }
    }

    if (removedReqs.length === 0) continue;
    const canonicalBodies = new Map(
      collectRequirementBodies(canonicalContent).map((req) => [req.title, req.body])
    );
    for (const req of removedReqs) {
      const canonicalBody = canonicalBodies.get(req.title);
      if (!hasCanonicalSpec || canonicalBody === undefined) {
        violations.push({
          cap,
          requirement: req.title,
          mode: 'REMOVED',
          reason: hasCanonicalSpec ? 'removed-missing-requirement' : 'removed-missing-capability',
        });
      } else if (req.body !== canonicalBody) {
        violations.push({
          cap,
          requirement: req.title,
          mode: 'REMOVED',
          reason: 'removed-body-mismatch',
          line: firstDifferingLine(req.body, canonicalBody),
        });
      }
    }
  }

  return { pass: violations.length === 0, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChangeFolderLinterCli({
    scriptName: 'lint-delta-requirement-mode',
    usage:
      'Usage: node lint-delta-requirement-mode.mjs <change-folder>\n' +
      '  <change-folder>  path to openspec/changes/<name>',
    lint: ({ changeFolder }) => lintDeltaRequirementMode({ changeFolder }),
    printViolation(result) {
      for (const v of result.violations) {
        if (v.reason === 'added-existing-requirement') {
          process.stderr.write(
            `[lint-delta-requirement-mode] ${v.cap} :: ADDED Requirement "${v.requirement}" already exists in canonical spec; use MODIFIED Requirements and include the complete requirement block.\n`
          );
        } else if (v.reason === 'modified-missing-requirement') {
          process.stderr.write(
            `[lint-delta-requirement-mode] ${v.cap} :: MODIFIED Requirement "${v.requirement}" does not exist in canonical spec; use ADDED Requirements for a new requirement title, or correct the title.\n`
          );
        } else if (v.reason === 'removed-body-mismatch') {
          process.stderr.write(
            `[lint-delta-requirement-mode] ${v.cap} :: REMOVED Requirement "${v.requirement}" body is not verbatim equal to the canonical body (first difference at body line ${v.line}).\n`
          );
        } else if (v.reason === 'removed-missing-requirement') {
          process.stderr.write(
            `[lint-delta-requirement-mode] ${v.cap} :: REMOVED Requirement "${v.requirement}" does not exist in canonical spec; correct the title so it matches a canonical requirement exactly, or, if the title was already deleted from canonical, restore it from the immutable change base (REMOVED titles must stay in canonical until archive; see openspec-archive-principles.md).\n`
          );
        } else if (v.reason === 'removed-missing-capability') {
          process.stderr.write(
            `[lint-delta-requirement-mode] ${v.cap} :: REMOVED Requirement "${v.requirement}" has no canonical capability spec to remove it from; correct the capability folder name so it matches an existing openspec/specs/<capability>/ directory, or drop this REMOVED block.\n`
          );
        } else {
          process.stderr.write(
            `[lint-delta-requirement-mode] ${v.cap} :: MODIFIED Requirement "${v.requirement}" has no canonical capability spec; use ADDED Requirements for a new capability.\n`
          );
        }
      }
      if (result.violations.some((v) => v.mode !== 'REMOVED')) {
        process.stderr.write(
          '\nFix: before writing a spec delta, compare the delta requirement titles against\n' +
          'openspec/specs/<capability>/spec.md. Existing requirement title => MODIFIED;\n' +
          'new requirement title => ADDED. Adding a scenario to an existing requirement\n' +
          'is MODIFIED, not ADDED.\n'
        );
      }
      if (result.violations.some((v) => v.mode === 'REMOVED' && v.reason !== 'removed-missing-capability')) {
        process.stderr.write(
          '\nFix (REMOVED): seal-final compares a REMOVED block with the canonical body exactly,\n' +
          'and only after archive, where the sole repair is rewinding the archive commit.\n' +
          'Copy the complete canonical requirement block (everything after the\n' +
          '`### Requirement:` heading through its last scenario) from\n' +
          'openspec/specs/<capability>/spec.md into the REMOVED block. A Reason/Migration\n' +
          'summary or a trimmed scenario list does not match.\n'
        );
      }
    },
    onPass(_result, { changeFolder }) {
      console.log(`[lint-delta-requirement-mode] ${changeFolder}: pass`);
    },
  });
}
