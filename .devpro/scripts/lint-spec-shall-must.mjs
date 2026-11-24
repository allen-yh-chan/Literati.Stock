#!/usr/bin/env node
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, sep, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHALL_MUST_RE = /\b(SHALL|MUST)\b/;

function trimSeparatorAdjacentBlankLines(body) {
  const trailingBreaks = body.match(/(?:\r?\n)+$/)?.[0];
  if (!trailingBreaks) return body;
  const contentEnd = body.length - trailingBreaks.length;
  if (contentEnd === 0) return '';
  const contentLineEnding = trailingBreaks.startsWith('\r\n') ? '\r\n' : '\n';
  return body.slice(0, contentEnd) + contentLineEnding;
}

function appendRequirement(out, name, body) {
  const subRe = /^#### ([^\r\n]+)\r?\n([\s\S]*?)(?=^#### |$(?![\s\S]))/gm;
  const subMatches = [...body.matchAll(subRe)];
  const mainSection = subMatches.length === 0 ? body : body.slice(0, subMatches[0].index);
  const subSections = subMatches.map(m => ({ heading: m[1].trim(), text: m[2] }));
  out.push({ name: name.trim(), mainSection, subSections });
}

/**
 * Split a spec.md ADDED/MODIFIED Requirements block into per-requirement segments.
 * Each segment includes:
 *   - name: requirement name
 *   - mainSection: text between ### Requirement: and first #### sub-heading (or end)
 *   - subSections: [{ heading, text }, ...] for each #### sub-heading
 */
export function parseRequirements(content) {
  const out = [];
  const boundaryRe =
    /^### Requirement: ([^\r\n]+)\r?\n|^### |^## |^---(?:\r?\n|$(?![\s\S]))/gm;
  let current;

  for (const match of content.matchAll(boundaryRe)) {
    if (current) {
      const rawBody = content.slice(current.bodyStart, match.index);
      const body = match[0].startsWith('---')
        ? trimSeparatorAdjacentBlankLines(rawBody)
        : rawBody;
      appendRequirement(out, current.name, body);
      current = undefined;
    }
    if (match[1] !== undefined) {
      current = { name: match[1], bodyStart: match.index + match[0].length };
    }
  }

  if (current) {
    appendRequirement(out, current.name, content.slice(current.bodyStart));
  }
  return out;
}

/**
 * Lint a single spec.md content. Returns { pass, errors, requirementCount }
 * where errors is an array of human-readable strings and requirementCount is
 * how many ADDED/MODIFIED requirements were inspected.
 */
export function lintSpec({ content, file }) {
  const errors = [];
  let requirementCount = 0;
  const blockRe = /^## (ADDED|MODIFIED) Requirements[ \t]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm;
  for (const blockMatch of content.matchAll(blockRe)) {
    const blockContent = blockMatch[2];
    const reqs = parseRequirements(blockContent);
    requirementCount += reqs.length;
    // A heading that announces requirements but yields none must not pass as "0 scanned".
    if (reqs.length === 0) {
      errors.push(`[${file}] "## ${blockMatch[1]} Requirements" has no "### Requirement:" entry`);
    }
    for (const req of reqs) {
      if (!SHALL_MUST_RE.test(req.mainSection)) {
        errors.push(`[${file}] Requirement "${req.name}" main section missing SHALL/MUST`);
      }
      req.subSections.forEach((sub, i) => {
        if (!SHALL_MUST_RE.test(sub.text)) {
          errors.push(
            `[${file}] Requirement "${req.name}" sub-section #${i + 1} ("${sub.heading}") missing SHALL/MUST`
          );
        }
      });
    }
  }
  return { pass: errors.length === 0, errors, requirementCount };
}

/**
 * Format success stdout so effective scope is observable (range + count, or
 * explicit 0-object form). MUST NOT emit bare `: pass` alone.
 */
export function formatPassMessage(target, { requirementCount = 0, fileCount = 0 } = {}) {
  if (fileCount === 0) {
    return `[lint-spec-shall-must] ${target}: pass (no applicable files in ${target})`;
  }
  return `[lint-spec-shall-must] ${target}: pass (${requirementCount} requirement(s) scanned)`;
}

/**
 * Lint a path: file → single lint; directory → recursive scan for spec.md under
 * any path segment named `specs` (separator-agnostic; win32-safe)
 */
function pathHasSpecsSegment(fullPath) {
  const normalized = fullPath.split(sep).join(posix.sep);
  return normalized.split(posix.sep).includes('specs');
}

export function lintPath(target) {
  const allErrors = [];
  let requirementCount = 0;
  let fileCount = 0;
  const stat = statSync(target);
  if (stat.isFile()) {
    fileCount = 1;
    const content = readFileSync(target, 'utf8');
    const result = lintSpec({ content, file: target });
    allErrors.push(...result.errors);
    requirementCount += result.requirementCount;
  } else if (stat.isDirectory()) {
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'refs', '.cache']);
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(join(dir, entry.name));
        } else if (entry.isFile() && entry.name === 'spec.md') {
          const full = join(dir, entry.name);
          if (!pathHasSpecsSegment(full)) continue;
          fileCount += 1;
          const content = readFileSync(full, 'utf8');
          const result = lintSpec({ content, file: full });
          allErrors.push(...result.errors);
          requirementCount += result.requirementCount;
        }
      }
    }
    walk(target);
  }
  return {
    pass: allErrors.length === 0,
    errors: allErrors,
    requirementCount,
    fileCount,
  };
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node lint-spec-shall-must.mjs <path-to-spec-or-change-dir>');
    process.exit(1);
  }
  const result = lintPath(target);
  if (!result.pass) {
    for (const err of result.errors) console.error(err);
    process.exit(1);
  }
  console.log(formatPassMessage(target, result));
  process.exit(0);
}
