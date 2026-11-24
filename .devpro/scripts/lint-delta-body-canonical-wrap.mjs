#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseRequirements } from './lint-spec-shall-must.mjs';
import { collectDeclaredTitles } from './lib/declared-title-lists.mjs';
import { runChangeFolderLinterCli } from './lib/openspec-linter-cli.mjs';

const ACTIVE_PATH_API = process.platform === 'win32' ? win32 : posix;

/**
 * Escape-hatch heading for canonical Requirements a named dependency merged into
 * this change, rather than the change author, wrote.
 *
 * The canonical-touch check below is provenance-blind by construction: a merged
 * dependency's canonical edits are indistinguishable from the author's own, and
 * Git cannot settle the difference (a merge commit touches the path under
 * `--first-parent` too, and `blame` returns the dependency's SHA whether or not
 * that commit belongs to this change). Without a hatch the author must copy
 * someone else's Requirement verbatim into their own delta, which makes
 * `openspec archive` record a modification this change never made. So the
 * declaration is an explicit, auditable author assertion instead of an inference.
 *
 * It is deliberately self-limiting: see `dependency-absorbed-declared-but-mirrored`
 * and `dependency-absorbed-declaration-unused` below. Declaring a title the delta
 * also authors, or a title that exempted nothing, is itself a violation — so the
 * hatch cannot be widened into a blanket bypass by adding more bullets.
 */
const DEPENDENCY_ABSORBED_HEADING = 'Dependency-Absorbed Requirements';

/**
 * Convert a native repo-relative path to Git's slash-separated path format.
 * POSIX permits literal backslashes in filenames, so only Windows-native
 * separators are converted.
 */
export function normalizeGitRelativePath(repoRelativePath, pathApi = ACTIVE_PATH_API) {
  return pathApi.sep === '\\' ? repoRelativePath.replaceAll('\\', '/') : repoRelativePath;
}

/**
 * Normalize a raw block of text for line-structure comparison.
 *
 * Steps:
 *   1. Split into lines; trim trailing whitespace from each line.
 *   2. Drop leading and trailing blank lines.
 *   3. Collapse consecutive blank lines into a single blank line (2a normalize).
 *
 * The same normalization is applied to both the delta MODIFIED body and the
 * canonical body, so requirements that are genuinely multi-line in canonical
 * are compared fairly (no false positives when both are multi-line in the same
 * structure).
 *
 * @param {string} rawText
 * @returns {string[]} normalized lines
 */
function normalizeBlock(rawText) {
  const lines = rawText.split('\n').map(l => l.replace(/\s+$/, ''));

  // Drop leading blank lines
  let start = 0;
  while (start < lines.length && lines[start] === '') start++;

  // Drop trailing blank lines
  let end = lines.length - 1;
  while (end >= start && lines[end] === '') end--;

  if (start > end) return [];

  const trimmed = lines.slice(start, end + 1);

  // Collapse consecutive blank lines → single blank line
  const out = [];
  let prevBlank = false;
  for (const line of trimmed) {
    const isBlank = line === '';
    if (isBlank && prevBlank) continue;
    out.push(line);
    prevBlank = isBlank;
  }
  return out;
}

/**
 * Compute the normalized line array for a parsed requirement.
 * Includes main section lines, then for each sub-section: heading line + body lines.
 *
 * @param {{ mainSection: string, subSections: Array<{heading: string, text: string}> }} req
 * @returns {string[]}
 */
function blockLinesOf(req) {
  const out = normalizeBlock(req.mainSection);
  for (const sub of req.subSections) {
    out.push('#### ' + sub.heading);
    out.push(...normalizeBlock(sub.text));
  }
  return out;
}

/**
 * Split a requirement's normalized block lines into contiguous segments,
 * anchored at `#### ` sub-section heading boundaries.
 *
 * Segment 0 is the main-section lines (everything before the first `#### `
 * heading). Every subsequent segment starts at a `#### <heading>` line and
 * runs until (but not including) the next `#### ` heading or the end of the
 * array. `blockLinesOf` already emits `#### <heading>` as a literal line
 * immediately followed by that sub-section's normalized body lines, so this
 * split is a pure boundary scan — no re-parsing needed.
 *
 * @param {string[]} lines - output of blockLinesOf()
 * @returns {string[][]} array of segments, each a contiguous slice of lines
 */
function segmentsOf(lines) {
  const segments = [];
  let current = [];
  for (const line of lines) {
    if (line.startsWith('#### ') && current.length > 0) {
      segments.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Find a contiguous, in-order, line-for-line-equal run of `segment` inside
 * `haystack`, starting the search at or after `fromIndex` (monotonic cursor —
 * never searches backward). Returns the index in `haystack` just past the end
 * of the matched run, or `null` if no such run exists at/after `fromIndex`.
 *
 * The monotonic cursor is what makes this "contiguous-block-anchored" rather
 * than a plain substring search repeated per segment: once a segment matches,
 * later segments may not match earlier (already-consumed) delta lines, so a
 * duplicate line elsewhere in the delta cannot mask a real drift in a segment
 * that has no subsequent `#### ` heading to re-anchor it (i.e. the last
 * segment).
 *
 * @param {string[]} haystack
 * @param {string[]} segment
 * @param {number} fromIndex
 * @returns {number|null}
 */
function findContiguousRun(haystack, segment, fromIndex) {
  if (segment.length === 0) return fromIndex;
  const lastStart = haystack.length - segment.length;
  for (let start = fromIndex; start <= lastStart; start++) {
    let matched = true;
    for (let j = 0; j < segment.length; j++) {
      if (haystack[start + j] !== segment[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return start + segment.length;
  }
  return null;
}

// DESIGN INVARIANT: Requirement attribution is intentionally closed-world:
// a span starts only at its own `### Requirement:` heading. The document
// preamble, `## Purpose`, and separating blank lines remain outside every Requirement span.
// `touchedRequirementNames()` MUST NOT attribute their diffs to the nearest Requirement;
// only a zero-context diff hunk intersecting an owned span may name that Requirement.
function requirementLineSpans(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const starts = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^### Requirement: (.+)$/);
    if (match) starts.push({ name: match[1].trim(), start: index + 1 });
  }
  return starts.map((entry, index) => {
    let end = index + 1 < starts.length ? starts[index + 1].start - 1 : lines.length;
    // A zero-context insertion immediately before the next Requirement starts
    // on the separating blank line. That separator is not part of the previous
    // Requirement's operative body and MUST NOT make an appended Requirement
    // look like a modification to its predecessor.
    while (end > entry.start && lines[end - 1]?.trim() === '') end--;
    return { ...entry, end };
  });
}

function addIntersectingRequirementNames(target, spans, start, count) {
  if (count <= 0) return;
  const end = start + count - 1;
  for (const span of spans) {
    if (span.start <= end && span.end >= start) target.add(span.name);
  }
}

/**
 * Parse `## RENAMED Requirements` FROM/TO pairs from a single delta file's raw
 * content. Pairing is strict and file-scoped: only a FROM bullet immediately
 * followed by its TO bullet (both in the canonical backticked
 * `` `### Requirement: <title>` `` form) forms a pair. Any other line —
 * including a blank line, another FROM, or EOF — resets the pending FROM, so
 * a malformed or split pair yields no pair at all rather than a guess.
 *
 * @param {string} deltaContent
 * @returns {Array<{from: string, to: string}>}
 */
function parseRenamedPairs(deltaContent) {
  const renamedBlockRe = /^## RENAMED Requirements\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm;
  const fromRe = /^- FROM: `### Requirement: (.+)`$/;
  const toRe = /^- TO: `### Requirement: (.+)`$/;
  const pairs = [];
  for (const m of deltaContent.matchAll(renamedBlockRe)) {
    const block = m[1].replace(/\r\n/g, '\n');
    let pendingFrom = null;
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\s+$/, '');
      const fromMatch = line.match(fromRe);
      const toMatch = line.match(toRe);
      if (fromMatch) {
        pendingFrom = fromMatch[1];
        continue;
      }
      if (toMatch && pendingFrom !== null) {
        pairs.push({ from: pendingFrom, to: toMatch[1] });
      }
      pendingFrom = null;
    }
  }
  return pairs;
}

function touchedRequirementNames({ diff, currentContent, baseContent }) {
  const names = new Set();
  const currentSpans = requirementLineSpans(currentContent);
  const baseSpans = requirementLineSpans(baseContent);
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of diff.split('\n')) {
    const match = line.match(hunkRe);
    if (!match) continue;
    addIntersectingRequirementNames(names, baseSpans, Number(match[1]), Number(match[2] ?? 1));
    addIntersectingRequirementNames(names, currentSpans, Number(match[3]), Number(match[4] ?? 1));
  }
  return names;
}

/**
 * Core lint function. Checks that each MODIFIED Requirement in each delta spec
 * preserves the canonical Requirement's line structure as a set of contiguous,
 * in-order, line-for-line-equal segments (main section + each existing
 * scenario). The delta MAY insert complete new scenario segments (the legal
 * "MODIFIED adds scenario" authoring pattern); it MUST NOT hard-wrap, reorder,
 * or drop any line within an existing canonical segment.
 *
 * The check catches "hard-wrap drift": a requirement body written as a single
 * long line in canonical that gets re-wrapped across multiple physical lines in
 * the delta MODIFIED block. After archive/promote, grep-asserted phrases become
 * split across lines, causing spec test failures.
 *
 * @param {object} opts
 * @param {string} opts.changeFolder - absolute path to the active change folder
 *   (e.g. openspec/changes/<name>)
 * @param {string} [opts.repoRoot] - absolute path to repo root (openspec/ parent).
 *   If omitted, derived from changeFolder by going up three levels (four when
 *   the change folder sits under openspec/changes/archive/).
 * @param {string} [opts.baseRef] - immutable change-base Git ref. When provided,
 *   every canonical Requirement touched since that ref must appear in the delta.
 * @returns {{ pass: boolean, violations: Array<{kind, cap, requirement, firstDiff: {index, delta, canon}|null}> }}
 */
export function lintDeltaBodyCanonicalWrap({
  changeFolder,
  repoRoot,
  baseRef,
  pathApi = ACTIVE_PATH_API,
}) {
  // Derive repoRoot if not provided: changeFolder is openspec/changes/<name>
  // so repoRoot = <name> → changes → openspec → root (3 levels up); an archived
  // change lives one level deeper (openspec/changes/archive/<date>-<name>).
  const isArchivedChangeFolder = basename(dirname(resolve(changeFolder))) === 'archive';
  const effectiveRepoRoot = repoRoot
    ? resolve(repoRoot)
    : resolve(changeFolder, ...(isArchivedChangeFolder ? ['..', '..', '..', '..'] : ['..', '..', '..']));

  // Verify changeFolder exists
  if (!existsSync(changeFolder) || !statSync(changeFolder).isDirectory()) {
    return { pass: false, violations: [], error: `change folder not found: ${changeFolder}` };
  }

  // null / undefined = no base supplied (legacy comparison). Anything else must be a
  // resolvable ref: an empty or non-string value is a supplied-but-unusable anchor and
  // fails closed. Past this block a supplied base is a non-empty string, so the later
  // `if (baseRef)` checks mean "base supplied".
  if (baseRef !== undefined && baseRef !== null) {
    if (typeof baseRef !== 'string' || baseRef === '') {
      return { pass: false, violations: [], error: `invalid change base ref: ${JSON.stringify(baseRef)}` };
    }
    try {
      execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], {
        cwd: effectiveRepoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return { pass: false, violations: [], error: `invalid change base ref: ${baseRef}` };
    }
  }

  // Find specs/ directory in change folder. In base-aware mode, the active
  // delta may omit an entire capability folder, so delta folders are only one
  // input to the capability set; touched canonical paths are the other.
  const specsDir = join(changeFolder, 'specs');
  const violations = [];

  let deltaCaps = [];
  try {
    if (existsSync(specsDir)) {
      if (!statSync(specsDir).isDirectory()) {
        return { pass: false, violations, error: `change specs path is not a directory: ${specsDir}` };
      }
      deltaCaps = readdirSync(specsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } else if (!baseRef) {
      return { pass: true, violations };
    }
  } catch (error) {
    return { pass: false, violations, error: `unable to inspect change specs directory: ${error.message}` };
  }

  const touchedCanonicalCaps = new Set();
  if (baseRef) {
    let touchedPaths;
    try {
      touchedPaths = execFileSync(
        'git',
        ['diff', '--name-only', '--no-renames', '--no-ext-diff', baseRef, '--', 'openspec/specs'],
        { cwd: effectiveRepoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (error) {
      return {
        pass: false,
        violations,
        error: `unable to enumerate canonical specs touched since ${baseRef}: ${error.message}`,
      };
    }
    for (const touchedPath of touchedPaths.split(/\r?\n/u)) {
      const match = touchedPath.match(/^openspec\/specs\/([^/]+)\/spec\.md$/u);
      if (match) touchedCanonicalCaps.add(match[1]);
    }
  }

  const caps = [...new Set([...deltaCaps, ...touchedCanonicalCaps])].sort();

  // Declarations are read, honoured, and audited only in base-aware mode: the
  // canonical-touch check they exempt does not run without a base ref, so
  // reading them outside `baseRef` would report every declaration as unused.
  const declaredAbsorbed = baseRef
    ? collectDeclaredTitles(changeFolder, DEPENDENCY_ABSORBED_HEADING)
    : new Set();
  const usedAbsorbed = new Set();
  // Mirroring is judged against every capability delta, not just the touched
  // one, so a declared title the author did write somewhere reports the
  // actionable contradiction rather than the misleading "exempted nothing".
  const allDeltaRequirementNames = new Set();

  for (const cap of caps) {
    const deltaSpecPath = join(specsDir, cap, 'spec.md');
    // Canonical spec path: repoRoot/openspec/specs/<cap>/spec.md
    const canonicalSpecPath = join(effectiveRepoRoot, 'openspec', 'specs', cap, 'spec.md');

    let deltaContent = '';
    let canonicalContent = '';
    try {
      if (existsSync(deltaSpecPath)) deltaContent = readFileSync(deltaSpecPath, 'utf8');
      if (existsSync(canonicalSpecPath)) canonicalContent = readFileSync(canonicalSpecPath, 'utf8');
    } catch (error) {
      return { pass: false, violations, error: `unable to read spec for capability ${cap}: ${error.message}` };
    }

    // --- Delta: extract ONLY "## MODIFIED Requirements" blocks ---
    const modifiedBlockRe = /^## MODIFIED Requirements\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm;
    const modifiedBlocks = [];
    for (const m of deltaContent.matchAll(modifiedBlockRe)) {
      modifiedBlocks.push(m[1].replace(/\r\n/g, '\n'));
    }

    if (baseRef) {
      const canonicalRelativePath = normalizeGitRelativePath(
        pathApi.relative(effectiveRepoRoot, canonicalSpecPath),
        pathApi,
      );
      let diff;
      let baseContent = '';
      try {
        diff = execFileSync(
          'git',
          ['diff', '--unified=0', '--no-ext-diff', baseRef, '--', canonicalRelativePath],
          { cwd: effectiveRepoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        );
      } catch (error) {
        return {
          pass: false,
          violations,
          error: `unable to diff canonical spec from ${baseRef}: ${canonicalRelativePath}: ${error.message}`,
        };
      }
      let basePathExists;
      try {
        const basePaths = execFileSync(
          'git',
          ['ls-tree', '-z', '--name-only', baseRef, '--', canonicalRelativePath],
          {
            cwd: effectiveRepoRoot,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ).split('\0').filter(Boolean);
        basePathExists = basePaths.includes(canonicalRelativePath);
      } catch (error) {
        return {
          pass: false,
          violations,
          error: `unable to inspect canonical spec at ${baseRef}: ${canonicalRelativePath}: ${error.message}`,
        };
      }
      if (basePathExists) {
        try {
          baseContent = execFileSync('git', ['show', `${baseRef}:${canonicalRelativePath}`], {
            cwd: effectiveRepoRoot,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          return {
            pass: false,
            violations,
            error: `unable to read canonical spec at ${baseRef}: ${canonicalRelativePath}: ${error.message}`,
          };
        }
      }

      const deltaRequirementNames = new Set(
        [...deltaContent.matchAll(/^### Requirement: (.+)$/gm)].map(match => match[1].trim()),
      );
      for (const name of deltaRequirementNames) allDeltaRequirementNames.add(name);
      const renamedPairs = parseRenamedPairs(deltaContent);
      const touchedNames = touchedRequirementNames({ diff, currentContent: canonicalContent, baseContent });
      for (const requirement of touchedNames) {
        if (deltaRequirementNames.has(requirement)) continue;
        const renamedPair = renamedPairs.find(pair => pair.from === requirement);
        if (renamedPair && deltaRequirementNames.has(renamedPair.to)) continue;
        if (declaredAbsorbed.has(requirement)) {
          usedAbsorbed.add(requirement);
          continue;
        }
        violations.push({
          kind: 'canonical-touch-missing-delta',
          cap,
          requirement,
          firstDiff: null,
        });
      }
    }

    if (modifiedBlocks.length === 0 || !canonicalContent) continue;

    // Parse all MODIFIED Requirements from the delta
    const allDeltaReqs = [];
    for (const block of modifiedBlocks) {
      allDeltaReqs.push(...parseRequirements(block));
    }

    // --- Canonical: parse full spec ---
    const canonicalReqs = parseRequirements(canonicalContent);
    const canonByName = new Map(canonicalReqs.map(r => [r.name, r]));

    // --- Compare normalized line structure ---
    for (const dReq of allDeltaReqs) {
      const cReq = canonByName.get(dReq.name);
      if (!cReq) continue; // no canonical match → skip (new requirement in MODIFIED, not this lint's concern)

      const dLines = blockLinesOf(dReq);
      const cLines = blockLinesOf(cReq);

      // Contiguous-block-anchored comparison: each canonical segment (main
      // section + each existing scenario) must appear as a contiguous,
      // in-order, line-for-line-equal run in the delta. The cursor advances
      // monotonically across segments so the delta may insert complete new
      // scenario segments without disturbing earlier segments' matches, while
      // still strictly anchoring the last segment (no trailing `#### ` to
      // re-anchor it) against duplicate-line false negatives.
      let firstDiff = null;
      const canonicalSegments = segmentsOf(cLines);
      let cursor = 0;
      for (const segment of canonicalSegments) {
        const next = findContiguousRun(dLines, segment, cursor);
        if (next === null) {
          const index = cursor < dLines.length ? cursor : dLines.length;
          firstDiff = {
            index,
            delta: dLines[index],
            canon: segment[0],
          };
          break;
        }
        cursor = next;
      }

      if (firstDiff !== null) {
        violations.push({ kind: 'body-line-structure-drift', cap, requirement: dReq.name, firstDiff });
      }
    }
  }

  // Audit the declarations themselves. Precedence is used -> mirrored -> unused,
  // so a declaration that genuinely exempted a touch stays valid even when the
  // same title is authored under another capability: declaration granularity is
  // the title alone (`decisions.md` D3), and refusing here would leave the
  // exempted capability with no legal fix. `cap` is null because a declaration
  // is change-scoped, not capability-scoped.
  for (const requirement of declaredAbsorbed) {
    if (usedAbsorbed.has(requirement)) continue;
    violations.push({
      kind: allDeltaRequirementNames.has(requirement)
        ? 'dependency-absorbed-declared-but-mirrored'
        : 'dependency-absorbed-declaration-unused',
      cap: null,
      requirement,
      firstDiff: null,
    });
  }

  return { pass: violations.length === 0, violations };
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChangeFolderLinterCli({
    scriptName: 'lint-delta-body-canonical-wrap',
    usage:
      'Usage: node lint-delta-body-canonical-wrap.mjs <change-folder> [--base <change-base-ref>]\n' +
      '  <change-folder>  path to openspec/changes/<name>\n' +
      '  --base           immutable Git ref captured when the change branch was created',
    parseExtraArgs(argv) {
      let baseRef;
      for (let index = 3; index < argv.length; index++) {
        if (argv[index] === '--base' && index + 1 < argv.length) {
          baseRef = argv[++index];
          continue;
        }
        console.error(`[lint-delta-body-canonical-wrap] unknown or incomplete argument: ${argv[index]}`);
        process.exit(1);
      }
      return { baseRef };
    },
    lint: ({ changeFolder, baseRef }) => lintDeltaBodyCanonicalWrap({ changeFolder, baseRef }),
    printViolation(result, { extra }) {
      const baseRef = extra.baseRef;
      for (const v of result.violations) {
        if (v.kind === 'canonical-touch-missing-delta') {
          process.stderr.write(
            `[lint-delta-body-canonical-wrap] ${v.cap} :: Requirement "${v.requirement}" :: canonical touched since ${baseRef} but absent from active delta\n`
          );
          continue;
        }
        if (v.kind === 'dependency-absorbed-declared-but-mirrored') {
          process.stderr.write(
            `[lint-delta-body-canonical-wrap] Requirement "${v.requirement}" :: declared dependency-absorbed but also authored in this change's delta\n`
          );
          continue;
        }
        if (v.kind === 'dependency-absorbed-declaration-unused') {
          process.stderr.write(
            `[lint-delta-body-canonical-wrap] Requirement "${v.requirement}" :: declared dependency-absorbed but exempted nothing\n`
          );
          continue;
        }
        const lineNum = v.firstDiff ? v.firstDiff.index + 1 : '?';
        process.stderr.write(
          `[lint-delta-body-canonical-wrap] ${v.cap} :: Requirement "${v.requirement}" :: body line-structure drift @ line ${lineNum}` +
          ` (delta MODIFIED body differs from canonical line structure)\n`
        );
        if (v.firstDiff) {
          process.stderr.write(
            `  delta  line ${lineNum}: ${JSON.stringify(v.firstDiff.delta ?? '<missing>')}\n` +
            `  canon  line ${lineNum}: ${JSON.stringify(v.firstDiff.canon ?? '<missing>')}\n`
          );
        }
      }
      process.stderr.write(
        '\nFix: in the delta MODIFIED block, the requirement body MUST match the canonical\n' +
        'body line-for-line (after trailing-whitespace + blank-line normalization), because\n' +
        "`openspec archive` promotes the delta body OVER canonical. The common cause is a\n" +
        'hard-wrapped line that canonical keeps single-line — unwrap it. If you INTEND to\n' +
        'change the wording, edit the canonical line too so both sides match; a divergence\n' +
        'here means promote will silently rewrite canonical (and can break grep-asserted\n' +
        'phrases that span the changed boundary, causing spec test failures).\n'
      );
      if (result.violations.some(v => v.kind === 'canonical-touch-missing-delta')) {
        process.stderr.write(
          'Canonical-touch fix: copy each named Requirement as a complete final-state block\n' +
          'into the matching active delta operation before validation/archive. If a named\n' +
          'dependency merged into this change wrote it — not you — declare the title under\n' +
          `a "## ${DEPENDENCY_ABSORBED_HEADING}" heading in proposal.md,\n` +
          'proposal-mini.md, tasks.md, or decisions.md instead of copying it.\n'
        );
      }
      if (result.violations.some(v => v.kind.startsWith('dependency-absorbed-'))) {
        process.stderr.write(
          `Dependency-absorption fix: every "## ${DEPENDENCY_ABSORBED_HEADING}"\n` +
          'bullet must exempt exactly one canonical touch this change did not author.\n' +
          '  - "also authored in this change\'s delta": you wrote it, so drop the bullet\n' +
          '    and keep the delta block.\n' +
          '  - "exempted nothing": nothing was touched under that title, so the bullet is\n' +
          '    stale or misspelled — drop it or fix the spelling.\n'
        );
      }
    },
    onPass(_result, { changeFolder }) {
      console.log(`[lint-delta-body-canonical-wrap] ${changeFolder}: pass`);
    },
  });
}
