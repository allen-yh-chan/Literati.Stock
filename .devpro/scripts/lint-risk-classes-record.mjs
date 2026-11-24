#!/usr/bin/env node
/**
 * Artifact-level lint: require a leading YAML front-matter `risk_classes`
 * record on in-scope OpenSpec changes (chore A / no proposal authoring path → pass).
 *
 * Mechanical presence only — not semantic honesty of the classification.
 * Dialect / prose / fence / <pre> body scans are intentionally not used.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChangeFolderLinterCli } from './lib/openspec-linter-cli.mjs';

const CARRIERS = Object.freeze([
  'meeting-notes.md',
  'proposal.md',
  'proposal-mini.md',
  'brd.md',
]);

/** Owner priority high → low (design D2). */
const OWNER_PRIORITY = Object.freeze([
  'proposal.md',
  'proposal-mini.md',
  'brd.md',
  'meeting-notes.md',
]);

/** Closed-set token shapes (hyphen/underscore/space/slash flexible); instructional placeholders rejected. */
const VALID_CLASS_TOKEN_RE =
  /^(auth|authorization|permission|state\/invariant|state|invariant|state[_ -]?machine|write|durable[_ -]?write|atomicity|external[_ -]?disclosure|disclosure)$/i;

/**
 * Decode one YAML 1.2 double-quoted escape at `src[i]` (`\`).
 * Unsupported / truncated / lone-surrogate escapes fail closed.
 * @param {string} src
 * @param {number} i index of backslash
 * @returns {{ ok: true, value: string, next: number } | { ok: false }}
 */
function decodeDoubleQuotedEscape(src, i) {
  if (i + 1 >= src.length) return { ok: false };
  const n = src[i + 1];
  /** @type {Record<string, string>} */
  const simple = {
    '0': '\0',
    a: '\x07',
    b: '\b',
    t: '\t',
    n: '\n',
    v: '\v',
    f: '\f',
    r: '\r',
    e: '\x1b',
    ' ': ' ',
    '"': '"',
    '/': '/',
    '\\': '\\',
    N: '\u0085',
    _: '\u00a0',
    L: '\u2028',
    P: '\u2029',
  };
  if (Object.prototype.hasOwnProperty.call(simple, n)) {
    return { ok: true, value: simple[n], next: i + 2 };
  }
  if (n === 'x') {
    const hex = src.slice(i + 2, i + 4);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return { ok: false };
    return { ok: true, value: String.fromCharCode(parseInt(hex, 16)), next: i + 4 };
  }
  if (n === 'u') {
    const hex = src.slice(i + 2, i + 6);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return { ok: false };
    const cp = parseInt(hex, 16);
    // Lone UTF-16 surrogates are not valid Unicode scalar values.
    if (cp >= 0xd800 && cp <= 0xdfff) return { ok: false };
    return { ok: true, value: String.fromCharCode(cp), next: i + 6 };
  }
  if (n === 'U') {
    const hex = src.slice(i + 2, i + 10);
    if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return { ok: false };
    const cp = parseInt(hex, 16);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return { ok: false };
    if (cp >= 0xd800 && cp <= 0xdfff) return { ok: false };
    return { ok: true, value: String.fromCodePoint(cp), next: i + 10 };
  }
  return { ok: false };
}

/**
 * Minimal YAML scalar decode for single-line FM values (design D1/D5).
 * Quote-aware: strip trailing comments only outside quotes.
 * Double-quoted escapes: decode the YAML 1.2 subset above or fail closed.
 * Returns { kind:'empty'|'null'|'string'|'malformed', text:string }.
 * @param {string} raw
 */
function parseYamlScalar(raw) {
  let t = String(raw ?? '').trim();
  if (!t || t.startsWith('#')) {
    return { kind: 'empty', text: '' };
  }

  if (t[0] === '"' || t[0] === "'") {
    const q = t[0];
    let i = 1;
    let inner = '';
    let closed = false;
    while (i < t.length) {
      const ch = t[i];
      if (ch === '\\' && q === '"') {
        const esc = decodeDoubleQuotedEscape(t, i);
        if (!esc.ok) {
          return { kind: 'malformed', text: '' };
        }
        inner += esc.value;
        i = esc.next;
        continue;
      }
      if (ch === q) {
        // Single-quoted YAML: '' → literal '
        if (q === "'" && i + 1 < t.length && t[i + 1] === "'") {
          inner += "'";
          i += 2;
          continue;
        }
        closed = true;
        i += 1;
        break;
      }
      inner += ch;
      i += 1;
    }
    if (!closed) {
      return { kind: 'malformed', text: '' };
    }
    const rest = t.slice(i).trim();
    if (rest && !rest.startsWith('#')) {
      return { kind: 'malformed', text: '' };
    }
    return inner === '' ? { kind: 'empty', text: '' } : { kind: 'string', text: inner };
  }

  // Unquoted: strip trailing YAML inline comment (` # …`).
  const hash = t.search(/(^|\s)#/);
  if (hash !== -1) {
    t = t.slice(0, hash).trimEnd();
  }
  if (!t) return { kind: 'empty', text: '' };
  if (/^(null|~)$/i.test(t)) return { kind: 'null', text: '' };
  return { kind: 'string', text: t };
}

/**
 * @param {string} text decoded scalar text (not raw source spelling)
 * @returns {boolean}
 */
function isSubstantiveRationale(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  // Canonicalize once: drop controls (Cc/Cf/…) and Default_Ignorable fillers so
  // NUL/ZWJ/Hangul-filler cannot dilute L/N or placeholder checks.
  const t = Array.from(raw)
    .filter(
      (ch) =>
        !/\p{C}/u.test(ch) && !/\p{Default_Ignorable_Code_Point}/u.test(ch),
    )
    .join('')
    .trim();
  if (!t) return false;
  if (!/\p{L}|\p{N}/u.test(t)) return false;
  if (t === '...' || t === '…') return false;
  if (/^(todo|tbd|fixme|xxx)$/i.test(t)) return false;
  if (/^rationale:?$/i.test(t)) return false;
  if (/[<>]/.test(t)) return false;
  if (/\ba-d\b/i.test(t) && /subset/i.test(t)) return false;
  return true;
}

/**
 * @param {string | undefined} rationaleRaw raw FM value after `rationale:`
 * @returns {boolean}
 */
function isSubstantiveRationaleRaw(rationaleRaw) {
  if (rationaleRaw === undefined) return false;
  const decoded = parseYamlScalar(rationaleRaw);
  if (decoded.kind !== 'string') return false;
  return isSubstantiveRationale(decoded.text);
}

/**
 * @param {string} token
 * @returns {string}
 */
function normalizeToken(token) {
  const t = String(token).trim();
  if (/^(auth|authorization|permission)$/i.test(t)) return 'auth';
  if (/^(state\/invariant|state|invariant|state[_ -]?machine)$/i.test(t)) return 'state/invariant';
  if (/^(write|durable[_ -]?write|atomicity)$/i.test(t)) return 'write';
  if (/^(external[_ -]?disclosure|disclosure)$/i.test(t)) return 'external-disclosure';
  return t.toLowerCase();
}

/**
 * @param {{ kind: 'none' } | { kind: 'list', tokens: string[] }} value
 * @returns {string}
 */
function normalizeRiskValue(value) {
  if (value.kind === 'none') return 'none';
  return [...new Set(value.tokens.map(normalizeToken))].sort().join(',');
}

/**
 * @param {string} inner
 * @returns {'valid-list'|'empty-list'|'placeholder-list'|'invalid-token'}
 */
function classifyListInner(inner) {
  const trimmed = inner.trim();
  if (!trimmed) return 'empty-list';
  const parts = trimmed.split(',');
  // Empty flow entries (`,auth`, `auth,`, `auth,,write`) fail closed — do not filter.
  if (parts.some((p) => p.trim() === '')) {
    return 'malformed-list';
  }
  const tokens = parts.map((t) => t.trim());
  if (tokens.length === 0) return 'empty-list';
  if (tokens.some((t) => /[<>]/.test(t) || /\ba-d\b/i.test(t) || /subset/i.test(t))) {
    return 'placeholder-list';
  }
  if (!tokens.every((t) => VALID_CLASS_TOKEN_RE.test(t))) {
    return 'invalid-token';
  }
  return 'valid-list';
}

/**
 * Detect nested / flow-map / sequence-of-maps / block-scalar shapes we reject.
 * @param {string} raw
 * @param {{ allowFlowList?: boolean }} [opts]
 * @returns {boolean}
 */
function looksNestedOrUnsupported(raw, opts = {}) {
  const allowFlowList = opts.allowFlowList === true;
  const t = raw.trim();
  if (!t) return false;
  if (t.startsWith('{') || t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) {
    return true;
  }
  if (t.startsWith('|') || t.startsWith('>')) return true;
  if (/^\[\s*\{/.test(t)) return true;
  if (t.startsWith('[')) {
    // risk_classes may use a scalar flow list; rationale must stay a scalar.
    return !allowFlowList;
  }
  return false;
}

/**
 * Decode risk_classes raw FM value with quote-aware trailing-comment handling.
 * @param {string} raw
 * @returns {{ kind: 'empty'|'null'|'string'|'list-source'|'malformed', text: string }}
 */
function decodeRiskClassesSource(raw) {
  let t = String(raw ?? '').trim();
  if (!t || t.startsWith('#')) {
    return { kind: 'empty', text: '' };
  }
  if (t[0] === '[') {
    const close = t.indexOf(']');
    if (close === -1) return { kind: 'malformed', text: t };
    const list = t.slice(0, close + 1);
    const rest = t.slice(close + 1).trim();
    if (rest && !rest.startsWith('#')) return { kind: 'malformed', text: t };
    return { kind: 'list-source', text: list };
  }
  const decoded = parseYamlScalar(t);
  if (decoded.kind === 'malformed') {
    return { kind: 'malformed', text: t };
  }
  return decoded;
}

/**
 * Parse a single leading FM line `key: value` (minimal subset).
 * @param {string} line
 * @returns {{ ok: true, key: string, rawValue: string } | { ok: false, reason: string, detail?: string } | null}
 *   null = blank / comment-only (ignore)
 */
function parseFmLine(line) {
  const trimmedRight = line.replace(/\s+$/, '');
  if (!trimmedRight.trim() || trimmedRight.trimStart().startsWith('#')) {
    return null;
  }
  const m = trimmedRight.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
  if (!m) {
    return {
      ok: false,
      reason: 'malformed-front-matter',
      detail: `unsupported front-matter line: ${trimmedRight}`,
    };
  }
  return { ok: true, key: m[1], rawValue: m[2] ?? '' };
}

/**
 * Parse leading YAML front matter for risk_classes (design D1 / D5).
 *
 * @param {string} content
 * @returns {{
 *   status: 'undeclared' | 'malformed' | 'no-declaration' | 'declared',
 *   reason?: string,
 *   detail?: string,
 *   value?: { kind: 'none' } | { kind: 'list', tokens: string[] },
 *   valueKind?: string,
 *   normalized?: string,
 * }}
 */
export function parseRiskClassesFrontMatter(content) {
  let text = String(content ?? '');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  text = text.replace(/\r\n/g, '\n');
  text = text.split('\n').map((line) => line.replace(/[\t ]+$/u, '')).join('\n');

  if (!text.startsWith('---\n') && text !== '---') {
    // Exact opener line required; otherwise undeclared (not malformed).
    return { status: 'undeclared' };
  }

  const afterOpener = text.startsWith('---\n') ? text.slice(4) : '';
  const lines = afterOpener.split('\n');
  let closerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      closerIndex = i;
      break;
    }
  }
  if (closerIndex === -1) {
    return {
      status: 'malformed',
      reason: 'malformed-front-matter',
      detail: 'leading YAML front matter opener has no exact --- closer',
    };
  }

  /** @type {Map<string, string>} */
  const keys = new Map();
  for (let i = 0; i < closerIndex; i += 1) {
    const parsed = parseFmLine(lines[i]);
    if (parsed === null) continue;
    if (!parsed.ok) {
      return { status: 'malformed', reason: parsed.reason, detail: parsed.detail };
    }
    const { key, rawValue } = parsed;
    if (keys.has(key)) {
      return {
        status: 'malformed',
        reason: 'duplicate-key',
        detail: `duplicate front-matter key: ${key}`,
      };
    }

    if (key === 'risk_classes' || key === 'rationale') {
      if (looksNestedOrUnsupported(rawValue, { allowFlowList: key === 'risk_classes' })) {
        return {
          status: 'malformed',
          reason: 'illegal-nested',
          detail: `${key} must be a single-line scalar or flow list; nested/alias/tag/block scalar rejected`,
        };
      }
      // Multi-line block continuation: next non-blank FM line without key: is unsupported
      keys.set(key, rawValue);
    } else {
      // Unrecognized key: scalar OK (ignore); nested / malformed scalar → fail closed
      if (looksNestedOrUnsupported(rawValue) || /^\[/.test(rawValue.trim())) {
        return {
          status: 'malformed',
          reason: 'illegal-nested',
          detail: `unrecognized key ${key} has nested/flow collection value`,
        };
      }
      const ignoredDecoded = parseYamlScalar(rawValue);
      if (ignoredDecoded.kind === 'malformed') {
        return {
          status: 'malformed',
          reason: 'malformed-front-matter',
          detail: `unrecognized key ${key} has malformed YAML scalar`,
        };
      }
      keys.set(key, rawValue);
    }
  }

  if (!keys.has('risk_classes')) {
    return { status: 'no-declaration' };
  }

  const rawRisk = keys.get('risk_classes') ?? '';
  const riskDecoded = decodeRiskClassesSource(rawRisk);
  const rationaleRaw = keys.has('rationale') ? keys.get('rationale') : undefined;

  if (riskDecoded.kind === 'malformed') {
    return {
      status: 'malformed',
      reason: 'malformed-front-matter',
      detail:
        'risk_classes scalar/flow value is malformed YAML (unsupported escape, unclosed quote, or trailing junk)',
    };
  }

  if (rationaleRaw !== undefined) {
    const rationaleDecoded = parseYamlScalar(rationaleRaw);
    if (rationaleDecoded.kind === 'malformed') {
      return {
        status: 'malformed',
        reason: 'malformed-front-matter',
        detail:
          'rationale scalar is malformed YAML (unsupported escape, unclosed quote, or trailing junk)',
      };
    }
  }

  if (riskDecoded.kind === 'string' && /^none$/i.test(riskDecoded.text)) {
    if (!isSubstantiveRationaleRaw(rationaleRaw)) {
      return {
        status: 'malformed',
        reason: 'none-without-rationale',
        detail:
          'risk_classes: none requires substantive rationale: in the same leading front matter',
      };
    }
    return {
      status: 'declared',
      value: { kind: 'none' },
      valueKind: 'none-ok',
      normalized: 'none',
    };
  }

  if (riskDecoded.kind !== 'list-source') {
    return {
      status: 'malformed',
      reason: 'malformed-front-matter',
      detail:
        'risk_classes must be `none` or a single-line flow list `[…]` in leading front matter',
    };
  }

  const riskTrim = riskDecoded.text.trim();
  const listMatch = riskTrim.match(/^\[([^\]]*)\]$/);
  if (!listMatch) {
    return {
      status: 'malformed',
      reason: 'malformed-front-matter',
      detail:
        'risk_classes must be `none` or a single-line flow list `[…]` in leading front matter',
    };
  }

  const listKind = classifyListInner(listMatch[1] ?? '');
  if (listKind !== 'valid-list') {
    return {
      status: 'malformed',
      reason: listKind === 'malformed-list' ? 'malformed-front-matter' : listKind,
      detail:
        listKind === 'empty-list'
          ? 'risk_classes: [] is treated as missing; list at least one class'
          : listKind === 'placeholder-list'
            ? 'instructional placeholders such as [<a-d subset>] are not a valid risk_classes record'
            : listKind === 'malformed-list'
              ? 'risk_classes flow list must not contain empty entries (e.g. [,auth] or [auth,,write])'
              : 'risk_classes list tokens must be from the closed taxonomy (auth|state/invariant|write|external-disclosure aliases); unknown tokens are invalid',
    };
  }

  if (rationaleRaw !== undefined && !isSubstantiveRationaleRaw(rationaleRaw)) {
    return {
      status: 'malformed',
      reason: 'malformed-front-matter',
      detail: 'optional rationale in front matter must be substantive when present',
    };
  }

  const tokens = listMatch[1].split(',').map((t) => t.trim());

  return {
    status: 'declared',
    value: { kind: 'list', tokens },
    valueKind: 'valid-list',
    normalized: normalizeRiskValue({ kind: 'list', tokens }),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.changeFolder absolute/relative path to change folder
 * @returns {{ pass: boolean, violations: Array<{reason: string, file?: string, line?: number, detail?: string}>, error?: string }}
 */
export function lintRiskClassesRecord({ changeFolder }) {
  if (!changeFolder || typeof changeFolder !== 'string') {
    return {
      pass: false,
      violations: [],
      error: 'changeFolder is required',
    };
  }

  const resolved = resolve(changeFolder);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return {
      pass: false,
      violations: [],
      error: `change folder not found: ${resolved}`,
    };
  }

  const hasProposal = existsSync(join(resolved, 'proposal.md'));
  const hasProposalMini = existsSync(join(resolved, 'proposal-mini.md'));

  // Chore A / no OpenSpec authoring ledger → graceful pass (do not read brd/notes)
  if (!hasProposal && !hasProposalMini) {
    return { pass: true, violations: [] };
  }

  /** @type {Array<{file: string, normalized: string}>} */
  const declarations = [];
  /** @type {Array<{reason: string, file?: string, detail?: string}>} */
  const violations = [];

  for (const carrier of CARRIERS) {
    const path = join(resolved, carrier);
    if (!existsSync(path) || !statSync(path).isFile()) continue;

    let content;
    try {
      content = readFileSync(path, 'utf8');
    } catch (err) {
      return {
        pass: false,
        violations: [],
        error: `failed to read ${carrier}: ${err.message}`,
      };
    }

    const parsed = parseRiskClassesFrontMatter(content);
    if (parsed.status === 'undeclared' || parsed.status === 'no-declaration') {
      continue;
    }
    if (parsed.status === 'malformed') {
      violations.push({
        reason: parsed.reason ?? 'malformed-front-matter',
        file: carrier,
        detail: parsed.detail,
      });
      // Fail closed immediately on malformed carrier (design D2 step 2)
      return { pass: false, violations };
    }
    // declared
    declarations.push({
      file: carrier,
      normalized: parsed.normalized ?? '',
    });
  }

  if (violations.length > 0) {
    return { pass: false, violations };
  }

  if (declarations.length === 0) {
    return {
      pass: false,
      violations: [
        {
          reason: 'missing-risk-classes',
          detail:
            'record leading YAML front matter with `risk_classes: [auth]` (non-empty closed-set class) or `risk_classes: none` + rationale in meeting-notes.md / proposal.md / proposal-mini.md / brd.md (prose/fence/<pre> body examples do not count)',
        },
      ],
    };
  }

  let owner = null;
  for (const name of OWNER_PRIORITY) {
    const hit = declarations.find((d) => d.file === name);
    if (hit) {
      owner = hit;
      break;
    }
  }

  for (const d of declarations) {
    if (!owner || d.file === owner.file) continue;
    if (d.normalized !== owner.normalized) {
      return {
        pass: false,
        violations: [
          {
            reason: 'multi-owner-conflict',
            file: d.file,
            detail: `normalized risk_classes in ${d.file} (${d.normalized}) conflicts with canonical owner ${owner.file} (${owner.normalized})`,
          },
        ],
      };
    }
  }

  return { pass: true, violations: [] };
}

function printViolations(result) {
  if (result.error) {
    process.stderr.write(`[lint-risk-classes-record] ${result.error}\n`);
    return;
  }
  for (const v of result.violations) {
    const loc = v.file ? v.file : 'change folder';
    process.stderr.write(
      `[lint-risk-classes-record] ${loc}: ${v.reason}${v.detail ? ` — ${v.detail}` : ''}\n`,
    );
  }
  process.stderr.write(
    '\nFix: add leading YAML front matter:\n' +
      '---\n' +
      'risk_classes: [auth]\n' +
      '# or risk_classes: none\n' +
      '# rationale: <substantive text>   # required when none\n' +
      '---\n' +
      'in proposal.md / proposal-mini.md / meeting-notes.md / brd.md.\n' +
      'Prose / fence / <pre> body examples do not satisfy the gate.\n' +
      'Chore A (no proposal.md and no proposal-mini.md) is exempt.\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChangeFolderLinterCli({
    scriptName: 'lint-risk-classes-record',
    usage:
      'Usage: node .devpro/scripts/lint-risk-classes-record.mjs <change-folder>\n' +
        '  <change-folder>  path to openspec/changes/<name> (or archive/…)',
    requireExists: false,
    lint: ({ changeFolder }) => lintRiskClassesRecord({ changeFolder }),
    onError(result) {
      printViolations(result);
    },
    printViolation(result) {
      printViolations(result);
    },
    onPass(_result, { changeFolder }) {
      console.log(`[lint-risk-classes-record] ${changeFolder}: pass`);
    },
  });
}
