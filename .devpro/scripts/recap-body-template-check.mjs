#!/usr/bin/env node
/**
 * recap-body-template-check.mjs
 *
 * Recap body lint script — checks that a Recap Discussion body contains the
 * canonical H2 structure defined in:
 *   .devpro/agent-rules/session-recap.md §Template（copy-paste-ready）
 *
 * Required H2 headings (absence = fail):
 *   - ## Branch
 *   - ## 完成項
 *   - ## Requirement Ledger Completion
 *   - ## 版本資訊
 *
 * Anti-pattern H2 headings (presence = fail):
 *   - ## Context
 *   - ## Lessons
 *   - ## Outcome
 *   - ## Root Cause Analysis
 *   - ## Changes
 *   - ## Decisions
 *   - ## Summary
 *   - ## TL;DR
 *
 * Usage:
 *   node recap-body-template-check.mjs --body-file <path>
 *   echo "..." | node recap-body-template-check.mjs
 *
 * Exit codes:
 *   0 — all required H2 present, no anti-pattern H2 found
 *   1 — missing required H2 or anti-pattern H2 present
 *   2 — body input is empty or unreadable
 */

import { pathToFileURL } from 'node:url';
import { readBodyFromFileArgOrStdin } from './lib/cli-io.mjs';

const REFERENCE =
  '.devpro/agent-rules/session-recap.md §Template（copy-paste-ready）';

/**
 * Required H2 headings. Each must appear as an H2 heading line (starts at
 * beginning of line, or after a newline) to avoid matching inside code blocks.
 */
const REQUIRED_H2 = [
  {
    label: '## Branch',
    test: (body) => /(?:^|\n)## Branch\b/.test(body),
  },
  {
    label: '## 完成項',
    test: (body) => /(?:^|\n)## 完成項/.test(body),
  },
  {
    label: '## Requirement Ledger Completion',
    test: (body) => /(?:^|\n)## Requirement Ledger Completion\b/.test(body),
  },
  {
    label: '## Token 回顧',
    test: (body) => /(?:^|\n)## Token 回顧/.test(body),
  },
  {
    label: '## 版本資訊',
    test: (body) => /(?:^|\n)## 版本資訊/.test(body),
  },
];

/**
 * Anti-pattern H2 headings that violate canonical Recap structure.
 * Evidence: session #417/#418/#421 used English H2 instead of canonical
 * Chinese H2 headings.
 */
const ANTI_PATTERN_H2 = [
  { label: '## Context',              test: (body) => /(?:^|\n)## Context\b/.test(body) },
  { label: '## Lessons',              test: (body) => /(?:^|\n)## Lessons\b/.test(body) },
  { label: '## Outcome',              test: (body) => /(?:^|\n)## Outcome\b/.test(body) },
  { label: '## Root Cause Analysis',  test: (body) => /(?:^|\n)## Root Cause Analysis\b/.test(body) },
  { label: '## Changes',              test: (body) => /(?:^|\n)## Changes\b/.test(body) },
  { label: '## Decisions',            test: (body) => /(?:^|\n)## Decisions\b/.test(body) },
  { label: '## Summary',              test: (body) => /(?:^|\n)## Summary\b/.test(body) },
  { label: '## TL;DR',               test: (body) => /(?:^|\n)## TL;DR\b/.test(body) },
];

function extractH2Section(body, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `\b` requires a word-char/non-word-char transition on at least one side.
  // Headings ending in a non-ASCII-word character (e.g. CJK '## Token 回顧')
  // never satisfy that transition against a following '\n', so `\b` would
  // silently never match — only append it when the heading actually ends in
  // an ASCII word character (matches existing REQUIRED_H2 test() convention,
  // e.g. '## 完成項' already omits the trailing \b for the same reason).
  const boundary = /\w$/.test(heading) ? '\\b' : '';
  const headingRe = new RegExp(`(?:^|\\n)${escapedHeading}${boundary}[^\\n]*\\n?`);
  const match = headingRe.exec(body);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = /\n## [^\n]+/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

/**
 * Extract a `<key>: <value>` field's value from a section, tolerating an
 * optional leading list marker (`- `). Returns the trimmed rest-of-line, or
 * null if the key is not present as a field (line start, optional `- `).
 */
function extractFieldValue(section, key) {
  const re = new RegExp(`(?:^|\\n)[ \\t]*-?[ \\t]*${key}:[ \\t]*([^\\n]*)`, 'i');
  const match = re.exec(section);
  return match ? match[1].trim() : null;
}

const LINEAGE_SCHEMA = 'devpro-lineage-usage-report/v1';
const LINEAGE_FIELDS = [
  'schema',
  'lookup',
  'scope',
  'coverage',
  'terminality',
  'reconciliation',
  'claims',
  'root_sessions',
  'descendant_sessions',
  'external_reviewer_sessions',
  'dispatch_rows',
  'spawn_events',
  'root_totals',
  'descendant_totals',
  'external_reviewer_totals',
  'lineage_totals',
  'efficiency_verdict',
  'baseline',
  'quota_impact',
  'quota_authority',
  'gaps',
];
const LINEAGE_ENUMS = {
  lookup: new Set(['exact', 'latest-fallback', 'unavailable']),
  scope: new Set(['current-change', 'mixed-session', 'session-wide', 'unavailable']),
  coverage: new Set(['lineage-complete', 'lineage-incomplete', 'root-only', 'unavailable']),
  terminality: new Set(['terminal', 'open', 'unknown']),
  reconciliation: new Set(['reconciled', 'gaps', 'unavailable']),
  efficiency_verdict: new Set(['improved', 'regressed', 'not-comparable']),
};
const LINEAGE_CLAIMS = new Set([
  'current-change',
  'lineage-complete',
  'final',
  'reconciled',
]);
const COUNT_FIELDS = [
  'root_sessions',
  'descendant_sessions',
  'external_reviewer_sessions',
  'dispatch_rows',
  'spawn_events',
];
const TOTAL_FIELDS = [
  'root_totals',
  'descendant_totals',
  'external_reviewer_totals',
  'lineage_totals',
];

function isNamedNotApplicable(value) {
  if (!/^n\/a\s*[:：]/i.test(value)) return false;
  return value.replace(/^n\/a\s*[:：]\s*/i, '').trim().length >= 3;
}

function parseClaims(value) {
  if (/^none$/i.test(value)) return { valid: true, values: new Set() };
  const values = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) return { valid: false, reason: 'claims: must be `none` or a comma-separated claim list' };
  const unknown = values.find((claim) => !LINEAGE_CLAIMS.has(claim));
  if (unknown) return { valid: false, reason: 'claims: contains an unsupported claim token' };
  return { valid: true, values: new Set(values) };
}

function parseCount(value, key) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    return { valid: false, reason: `${key}: must be a non-negative safe integer` };
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    return { valid: false, reason: `${key}: must be a non-negative safe integer` };
  }
  return { valid: true, value: number };
}

function parseTotals(value, key) {
  if (isNamedNotApplicable(value)) {
    return { valid: true, metrics: null };
  }
  const metrics = new Map();
  for (const part of value.split(/\s*\/\s*/)) {
    const match = /^([a-z][a-z0-9_]*)\s*(?::|=)?\s+(.+)$/i.exec(part.trim());
    if (!match) {
      return { valid: false, reason: `${key}: has an invalid metric entry` };
    }
    const metric = match[1].toLowerCase();
    const rawValue = match[2].trim();
    if (metrics.has(metric)) {
      return { valid: false, reason: `${key}: repeats metric ${metric}` };
    }
    if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(rawValue)) {
      const number = Number(rawValue);
      if (!Number.isFinite(number) || number < 0) {
        return { valid: false, reason: `${key}: metric ${metric} must be non-negative` };
      }
      metrics.set(metric, number);
    } else if (isNamedNotApplicable(rawValue)) {
      metrics.set(metric, null);
    } else {
      return {
        valid: false,
        reason: `${key}: metric ${metric} must be numeric or N/A: <reason>`,
      };
    }
  }
  if (!metrics.has('input') || !metrics.has('output')) {
    return { valid: false, reason: `${key}: must include input and output metrics` };
  }
  return { valid: true, metrics };
}

function parseGaps(value) {
  if (/^(?:none|無)$/i.test(value)) return [];
  return value.split(/\s*[,;，；]\s*/).map((gap) => gap.trim()).filter(Boolean);
}

function hasDescendantGap(gaps) {
  return gaps.some((gap) =>
    /descendant|lineage-(?:file|meta-record|byte|node|depth)-cap-hit|lineage-(?:cycle|identity-collision|unresolved)|codex-(?:spawn-observability-unverified|root-window-unresolved)/i.test(gap)
  );
}

function containsUnsafeLineageDisclosure(value) {
  return /(?:\/Users\/|\/home\/[^\s/]+\/|[A-Za-z]:\\Users\\|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|BEGIN [A-Z ]*PRIVATE KEY)/i.test(value);
}

function validateLineageSummary(section) {
  // `gaps:` predates the versioned lineage summary, so it cannot activate the
  // structured parser by itself. Any lineage-exclusive field does activate it
  // and then the full v1 shape is required.
  const presentFields = LINEAGE_FIELDS
    .filter((key) => key !== 'gaps')
    .filter((key) => extractFieldValue(section, key) !== null);
  if (presentFields.length === 0) return { valid: true };

  const fields = {};
  for (const key of LINEAGE_FIELDS) {
    const value = extractFieldValue(section, key);
    if (!value) return { valid: false, reason: `${key}: is missing or empty in the structured lineage summary` };
    if (containsUnsafeLineageDisclosure(value)) {
      return { valid: false, reason: `${key}: contains a disallowed raw path or account identifier` };
    }
    fields[key] = value;
  }
  if (fields.schema !== LINEAGE_SCHEMA) {
    return { valid: false, reason: `schema: must be ${LINEAGE_SCHEMA}` };
  }
  for (const [key, allowed] of Object.entries(LINEAGE_ENUMS)) {
    if (!allowed.has(fields[key])) {
      return { valid: false, reason: `${key}: has an unsupported value` };
    }
  }

  const parsedClaims = parseClaims(fields.claims);
  if (!parsedClaims.valid) return parsedClaims;
  const claims = parsedClaims.values;

  const counts = {};
  for (const key of COUNT_FIELDS) {
    const parsed = parseCount(fields[key], key);
    if (!parsed.valid) return parsed;
    counts[key] = parsed.value;
  }
  if (counts.root_sessions === 0 && fields.lookup !== 'unavailable') {
    return { valid: false, reason: 'root_sessions: must be positive when lookup is available' };
  }

  const totals = {};
  for (const key of TOTAL_FIELDS) {
    const parsed = parseTotals(fields[key], key);
    if (!parsed.valid) return parsed;
    totals[key] = parsed.metrics;
  }

  const gaps = parseGaps(fields.gaps);
  const evidenceStatus = extractFieldValue(section, 'evidence_status');
  if (evidenceStatus && !new Set(['reproduced', 'drift', 'partial', 'unavailable']).has(evidenceStatus)) {
    return { valid: false, reason: 'evidence_status: has an unsupported value' };
  }
  if (evidenceStatus === 'reproduced' && gaps.includes('evidence-boundary-drift')) {
    return {
      valid: false,
      reason: 'evidence_status: reproduced contradicts the evidence-boundary-drift gap',
    };
  }
  if (counts.spawn_events > 0 && counts.descendant_sessions === 0) {
    if (!hasDescendantGap(gaps)) {
      return {
        valid: false,
        reason: 'descendant_sessions: spawn_events is positive but descendant evidence and a named descendant gap are both absent',
      };
    }
    if (fields.coverage === 'lineage-complete') {
      return {
        valid: false,
        reason: 'coverage: lineage-complete contradicts missing descendant evidence',
      };
    }
  }

  const claimDimensions = [
    ['current-change', 'scope', 'current-change'],
    ['lineage-complete', 'coverage', 'lineage-complete'],
    ['final', 'terminality', 'terminal'],
    ['reconciled', 'reconciliation', 'reconciled'],
  ];
  for (const [claim, dimension, expected] of claimDimensions) {
    if (claims.has(claim) && fields[dimension] !== expected) {
      return {
        valid: false,
        reason: `${dimension}: ${fields[dimension]} contradicts the ${claim} claim (requires ${expected})`,
      };
    }
  }

  if (fields.reconciliation === 'reconciled') {
    for (const metric of ['input', 'output']) {
      const values = TOTAL_FIELDS.map((key) => totals[key]?.get(metric));
      if (values.some((value) => typeof value !== 'number')) {
        return {
          valid: false,
          reason: `reconciliation: reconciled requires numeric ${metric} totals for every contributor role`,
        };
      }
      const expected = values[0] + values[1] + values[2];
      if (expected !== values[3]) {
        return {
          valid: false,
          reason: `${metric} metric mismatch: root + descendants + external reviewers must equal lineage totals`,
        };
      }
    }
  }

  if (['improved', 'regressed'].includes(fields.efficiency_verdict)) {
    if (isNamedNotApplicable(fields.baseline)) {
      return {
        valid: false,
        reason: `baseline: ${fields.efficiency_verdict} requires an equivalent baseline measurement`,
      };
    }
    if (!claims.has('lineage-complete') || !claims.has('reconciled')) {
      return {
        valid: false,
        reason: `efficiency_verdict: ${fields.efficiency_verdict} requires lineage-complete and reconciled evidence`,
      };
    }
  }

  if (!isNamedNotApplicable(fields.quota_impact)) {
    if (!/[-+]?\d+(?:\.\d+)?(?:\s*%)?/.test(fields.quota_impact)) {
      return { valid: false, reason: 'quota_impact: must be numeric or N/A: <reason>' };
    }
    if (isNamedNotApplicable(fields.quota_authority)) {
      return {
        valid: false,
        reason: 'quota_authority: numeric quota impact requires a provider-authoritative reference',
      };
    }
  }

  return { valid: true };
}

/** Expected detail-table column count (D8 eight-column spec). */
const TOKEN_DETAIL_TABLE_COLUMNS = 8;

function tableColumnCount(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return 0;
  const inner = trimmed.slice(1, -1);
  let count = 1;
  let backslashes = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === "|") {
      // GFM: a pipe is a delimiter only when preceded by an even number of
      // backslashes (0, 2, …). Odd runs escape the pipe (e.g. `\|`); even runs
      // leave a literal backslash before an unescaped delimiter (e.g. `\\|`).
      if (backslashes % 2 === 0) count += 1;
      backslashes = 0;
      continue;
    }
    backslashes = 0;
  }
  return count;
}

/** Does a section contain a markdown table with a header, a separator row, and
 * at least one data row? Used to require live per-item detail rows, not just
 * a copy-pasted header skeleton. */
function hasTokenDetailTableRow(section) {
  const tableLines = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'));
  const separatorIndex = tableLines.findIndex((line) => /^\|[\s:-]+(?:\|[\s:-]+)*\|$/.test(line));
  if (separatorIndex === -1) return false;
  const dataRows = tableLines.slice(separatorIndex + 1);
  if (dataRows.length === 0) return false;
  // F-PR-RECAP-LINT: every data row MUST have the full eight-column shape —
  // a separator plus a placeholder row MUST NOT pass.
  return dataRows.every((line) => tableColumnCount(line) === TOKEN_DETAIL_TABLE_COLUMNS);
}

/**
 * Validate the `## Token 回顧` section (design.md D1 lint conditions):
 *   - section missing/empty → invalid
 *   - `host:` MUST be present, non-empty, and MUST NOT be `auto` (a CLI flag
 *     value, not a host identifier — design.md D10)
 *   - `source:` MUST be present and non-empty
 *   - `source: N/A: <reason>` → other fields MAY be `N/A`, table MAY be omitted
 *   - otherwise → `totals:`, `cost_usd:`, `gaps:` MUST be present and
 *     non-empty (F-I7: enforced for the same consistency reason
 *     host:/session:/source:/totals: already are), AND the section MUST have
 *     at least one detail table row
 *   - `session:` MUST be present and non-empty
 * @param {string} body
 * @returns {{ valid: boolean, reason?: string }}
 */
export function hasTokenSpendRecord(body) {
  const section = extractH2Section(body, '## Token 回顧');
  if (!section || !section.trim()) {
    return { valid: false, reason: 'section is missing or empty' };
  }

  const host = extractFieldValue(section, 'host');
  if (!host) return { valid: false, reason: 'host: is missing or empty' };
  if (/^auto$/i.test(host)) {
    return {
      valid: false,
      reason: '`host: auto` is not a host identifier — `auto` is a CLI flag value, not a host name (design.md D10)',
    };
  }

  const source = extractFieldValue(section, 'source');
  if (!source) return { valid: false, reason: 'source: is missing or empty' };

  const sessionId = extractFieldValue(section, 'session');
  if (!sessionId) return { valid: false, reason: 'session: is missing or empty' };

  const isNotApplicable = /^n\/a\s*[:：]/i.test(source);
  if (isNotApplicable) {
    const reason = source.replace(/^n\/a\s*[:：]\s*/i, "").trim();
    if (!reason || reason.length < 3) {
      return { valid: false, reason: "source: N/A: requires a non-empty reason (min 3 characters)" };
    }
    const lineage = validateLineageSummary(section);
    if (!lineage.valid) return lineage;
    return { valid: true };
  }

  const totals = extractFieldValue(section, 'totals');
  if (!totals || !/[1-9]/.test(totals)) {
    return {
      valid: false,
      reason: 'totals: must include a non-zero number when source is not N/A',
    };
  }

  const costUsd = extractFieldValue(section, 'cost_usd');
  if (!costUsd) return { valid: false, reason: 'cost_usd: is missing or empty' };

  const gaps = extractFieldValue(section, 'gaps');
  if (!gaps) return { valid: false, reason: 'gaps: is missing or empty' };

  if (!hasTokenDetailTableRow(section)) {
    return {
      valid: false,
      reason: 'must include at least one detail table row when source is not N/A',
    };
  }

  const lineageSummary = validateLineageSummary(section);
  if (!lineageSummary.valid) return lineageSummary;

  return { valid: true };
}

function hasValidRequirementLedgerCompletion(body) {
  const section = extractH2Section(body, '## Requirement Ledger Completion');
  if (!section || !section.trim()) return false;

  const hasDispositionCounts =
    /disposition counts\s*:\s*.*implemented\s+\d+\b.*partial\s+\d+\b.*deferred\s+\d+\b.*rejected\s+\d+\b.*moved-to-issue\s+\d+\b/is.test(section);
  if (hasDispositionCounts) return true;

  return /\bN\/A\s*:\s*(?!\s*(?:<[^>]+>|reason|tbd|todo|none|-)\s*$).{3,}/i.test(section);
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const body = readBodyFromFileArgOrStdin({ argv: process.argv });

  if (!body) {
    process.stderr.write('ERROR: Recap body input is empty or unreadable\n');
    process.exit(2);
  }

  const missing = REQUIRED_H2
    .filter(({ test }) => !test(body))
    .map(({ label }) => label);

  const antiPatterns = ANTI_PATTERN_H2
    .filter(({ test }) => test(body))
    .map(({ label }) => label);

  const contentErrors = [];
  if (/(?:^|\n)## Requirement Ledger Completion\b/.test(body) && !hasValidRequirementLedgerCompletion(body)) {
    contentErrors.push('Requirement Ledger Completion must include disposition counts or N/A: <reason>');
  }

  // Token 回顧: session-recap.md §Template — real host-reported token spend,
  // not the old estimate fields (design.md D1). Only content-validate when the
  // H2 is present; its absence is already reported via `missing` above.
  if (/(?:^|\n)## Token 回顧/.test(body)) {
    const tokenSpendRecord = hasTokenSpendRecord(body);
    if (!tokenSpendRecord.valid) {
      contentErrors.push(`Token 回顧 must record host token spend (${tokenSpendRecord.reason})`);
    }
  }

  if (missing.length > 0 || antiPatterns.length > 0 || contentErrors.length > 0) {
    let msg = 'ERROR: Recap body violates canonical structure\n';
    if (missing.length > 0) {
      msg += 'Missing required H2:\n';
      msg += missing.map(label => `  - ${label}`).join('\n') + '\n';
    }
    if (contentErrors.length > 0) {
      msg += 'Invalid section content:\n';
      msg += contentErrors.map(label => `  - ${label}`).join('\n') + '\n';
    }
    if (antiPatterns.length > 0) {
      msg += 'Anti-pattern H2 (禁用，請改 canonical 中文段名):\n';
      msg += antiPatterns.map(label => `  - ${label}`).join('\n') + '\n';
    }
    msg += `Reference: ${REFERENCE}\n`;
    process.stderr.write(msg);
    process.exit(1);
  }

  process.stdout.write('OK: Recap body canonical structure verified\n');
  process.exit(0);
}
