/**
 * Sticky credential literal write-before gate (design D2).
 *
 * Pure extract + assert helpers. Telemetry MUST NOT include secret hash,
 * masked prefix, or full secret values — only matched_token_kind, source,
 * and len_bucket.
 */

const SHAPE_KEYS = Object.freeze([
  { literal: "user_id", kind: "user_id", role: "account" },
  { literal: "password", kind: "password", role: "secret" },
  { literal: "user id", kind: "user_id", role: "account" },
  { literal: "pwd", kind: "pwd", role: "secret" },
  { literal: "uid", kind: "uid", role: "account" },
]);

const UNQUOTED_VALUE_TERMINATORS = new Set([
  ";",
  " ",
  "\t",
  "\n",
  "\r",
  "\f",
  "\v",
  "&",
  ",",
  "}",
  "]",
  ")",
  ">",
  '"',
  "'",
  "`",
]);

const TRAILING_JUNK = new Set(['"', "'", ")", "]", "}"]);

const URL_USERINFO_RE = /:\/\/([^/?#\s:@]+):([^/?#\s@]+)@/g;

export const STICKY_CREDENTIAL_LITERAL_BLOCKED = "sticky_credential_literal_blocked";
export const STICKY_CREDENTIAL_LITERAL_DETECTED = "sticky_credential_literal_detected";

function utf8Len(value) {
  return Buffer.byteLength(String(value), "utf8");
}

export function credentialLenBucket(value) {
  const n = utf8Len(value);
  if (n <= 3) return "1-3";
  if (n <= 7) return "4-7";
  if (n <= 15) return "8-15";
  return "16+";
}

function isAsciiWord(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function isAsciiAlnum(ch) {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

function stripTrailingJunk(value) {
  let end = value.length;
  while (end > 0 && TRAILING_JUNK.has(value[end - 1])) {
    end -= 1;
  }
  return value.slice(0, end);
}

function parseAssignment(afterKey) {
  // JSON / attribute keys may be written as "password":"…" — after matching the
  // bare key, consume one optional closing quote that wrapped the key.
  let rest = afterKey;
  if (rest[0] === '"' || rest[0] === "'") {
    rest = rest.slice(1);
  }
  // (B) quoted: optional ws + (=|:) + optional ws + "…" | '…'
  const quoted = /^(?:[ \t]*)(?:=|:)(?:[ \t]*)(["'])([\s\S]*?)\1/.exec(rest);
  if (quoted) {
    return { value: quoted[2], form: "quoted" };
  }
  // (A) unquoted: optional ws + = + optional ws + value to terminator
  const eq = /^(?:[ \t]*)=(?:[ \t]*)/.exec(rest);
  if (!eq) return null;
  const start = eq[0].length;
  let end = start;
  while (end < rest.length && !UNQUOTED_VALUE_TERMINATORS.has(rest[end])) {
    end += 1;
  }
  const raw = rest.slice(start, end);
  return { value: stripTrailingJunk(raw), form: "unquoted" };
}

function pushToken(out, value, kind, source, { minLen = 4, role = "secret" } = {}) {
  if (typeof value !== "string" || value.length === 0) return;
  if (minLen > 0 && utf8Len(value) < minLen) return;
  out.push({ value, kind, source, role });
}

const REPOSITORY_SLUG_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

/**
 * Public identifiers derived from `owner/repo`: the owner, the repo name, and
 * their `-` / `.` / `_` separated segments, lowercased. A malformed slug yields
 * an empty set (no exemption).
 * @param {unknown} repositorySlug
 * @returns {Set<string>}
 */
export function publicRepositoryIdentifiers(repositorySlug) {
  const out = new Set();
  if (typeof repositorySlug !== "string") return out;
  const match = REPOSITORY_SLUG_RE.exec(repositorySlug);
  if (!match) return out;
  for (const part of [match[1], match[2]]) {
    const lower = part.toLowerCase();
    out.add(lower);
    for (const segment of lower.split(/[-._]/)) {
      if (segment.length > 0) out.add(segment);
    }
  }
  return out;
}

function extractShapeTokensFromText(text, source, out) {
  if (typeof text !== "string" || text.length === 0) return;
  const lower = text.toLowerCase();
  for (const { literal, kind, role } of SHAPE_KEYS) {
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(literal, from);
      if (idx === -1) break;
      if (idx > 0 && isAsciiWord(text[idx - 1])) {
        from = idx + 1;
        continue;
      }
      const parsed = parseAssignment(text.slice(idx + literal.length));
      if (parsed) {
        pushToken(out, parsed.value, kind, source, { minLen: 4, role });
      }
      from = idx + 1;
    }
  }

  URL_USERINFO_RE.lastIndex = 0;
  let match;
  while ((match = URL_USERINFO_RE.exec(text)) !== null) {
    pushToken(out, match[1], "url_userinfo", source, { minLen: 4, role: "account" });
    pushToken(out, match[2], "url_userinfo", source, { minLen: 4, role: "secret" });
  }
}

/**
 * @param {{ materialTexts?: unknown, explicitDenyList?: unknown }} input
 * @returns {{ value: string, kind: string, source: "shape"|"material"|"explicit", role: "account"|"secret" }[]}
 */
export function extractCredentialDenyTokens({ materialTexts, explicitDenyList } = {}) {
  const out = [];
  const texts = Array.isArray(materialTexts) ? materialTexts : [];
  for (const text of texts) {
    if (typeof text === "string") {
      extractShapeTokensFromText(text, "material", out);
    }
  }
  const explicit = Array.isArray(explicitDenyList) ? explicitDenyList : [];
  for (const item of explicit) {
    if (typeof item === "string" && item.length > 0) {
      // Explicit may be shorter than 4 (short-account protection).
      pushToken(out, item, "explicit", "explicit", { minLen: 0 });
    }
  }
  return out;
}

function edgeAwareHit(haystack, token, isWordChar) {
  if (typeof haystack !== "string" || typeof token !== "string" || token.length === 0) {
    return false;
  }
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(token, from);
    if (idx === -1) return false;
    const before = idx === 0 ? undefined : haystack[idx - 1];
    const afterIdx = idx + token.length;
    const after = afterIdx >= haystack.length ? undefined : haystack[afterIdx];
    const leftEdge = token[0];
    const rightEdge = token[token.length - 1];
    const leftOk = !isWordChar(leftEdge) || before === undefined || !isWordChar(before);
    const rightOk = !isWordChar(rightEdge) || after === undefined || !isWordChar(after);
    if (leftOk && rightOk) return true;
    from = idx + 1;
  }
  return false;
}

export function bodyContainsCredentialToken(body, token) {
  const text = typeof body === "string" ? body : String(body ?? "");
  return edgeAwareHit(text, token, isAsciiWord) || edgeAwareHit(text, token, isAsciiAlnum);
}

/**
 * @param {string|Buffer} body
 * @param {{
 *   materialTexts?: unknown,
 *   explicitDenyList?: unknown,
 *   classification?: string,
 *   repositorySlug?: unknown,
 * }} [options]
 * @returns {{ ok: true } | {
 *   ok: false,
 *   classification: string,
 *   matched_token_kind: string,
 *   source: string,
 *   len_bucket: string,
 * }}
 */
export function assertStickyBodyCredentialFree(body, options = {}) {
  const bodyText = Buffer.isBuffer(body)
    ? body.toString("utf8")
    : String(body ?? "");
  const classification = typeof options.classification === "string" && options.classification.length > 0
    ? options.classification
    : STICKY_CREDENTIAL_LITERAL_BLOCKED;

  const tokens = extractCredentialDenyTokens({
    materialTexts: options.materialTexts,
    explicitDenyList: options.explicitDenyList,
  });
  // Body itself is re-scanned for shape tokens (design D2 token sources).
  extractShapeTokensFromText(bodyText, "shape", tokens);

  // An account value equal to the repository owner, repo name, or one of their
  // segments is already public, and a sticky cannot avoid naming the repo, so
  // it is not a deny literal. Secrets and explicit deny entries never qualify.
  const publicIds = publicRepositoryIdentifiers(options.repositorySlug);
  for (const token of tokens) {
    if (token.role === "account" && publicIds.has(token.value.toLowerCase())) continue;
    if (bodyContainsCredentialToken(bodyText, token.value)) {
      return {
        ok: false,
        classification,
        matched_token_kind: token.kind,
        source: token.source,
        len_bucket: credentialLenBucket(token.value),
      };
    }
  }
  return { ok: true };
}

/**
 * Safe telemetry projection — never includes secret material.
 * @param {{ ok: false, classification: string, matched_token_kind: string, source: string, len_bucket: string }} hit
 */
export function credentialGateTelemetry(hit) {
  return {
    classification: hit.classification,
    matched_token_kind: hit.matched_token_kind,
    source: hit.source,
    len_bucket: hit.len_bucket,
  };
}
